/**
 * Core do sandbox — constrói argumentos bwrap e spawna o processo.
 *
 * Responsável por:
 *   - Montar a linha de comando bwrap baseada na SandboxConfig
 *   - Gerenciar ciclo de vida (timeout, abort, kill de grupo)
 *   - Coletar stdout/stderr com backpressure
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, readdirSync, realpathSync, mkdirSync, lstatSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxConfig, BwrapCall, BwrapResult, SandboxProfileName } from "./types";
import { resolveSystemPaths } from "./portability";

// ─── Env vars seguras (whitelist) ──────────────────────────

/**
 * Variáveis de ambiente repassadas ao sandbox após --clearenv.
 * Apenas vars de desenvolvimento e runtime — nunca secrets.
 *
 * Excluídas por padrão: *_KEY, *_TOKEN, *_SECRET, *_PASSWORD,
 *   AWS_*, GCP_*, AZURE_*, DOCKER_*, GITHUB_TOKEN, NPM_TOKEN,
 *   OPENAI_*, ANTHROPIC_*, GOOGLE_API_KEY, DATABASE_URL, etc.
 */
const SAFE_ENV_VARS = new Set([
  "COLORTERM", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY",
  "EDITOR", "FORCE_COLOR", "INFOPATH", "LANG", "LC_ALL",
  "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY",
  "LC_NUMERIC", "LC_TIME", "LD_LIBRARY_PATH", "LIBRARY_PATH",
  "MANPATH", "NO_COLOR", "NODE_OPTIONS", "NVM_BIN", "NVM_DIR",
  "PAGER", "PATH", "PKG_CONFIG_PATH", "SHELL", "SSH_AGENT_PID",
  "TERM", "VISUAL", "WAYLAND_DISPLAY",
  "XDG_CURRENT_DESKTOP", "XDG_RUNTIME_DIR", "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP", "XDG_SESSION_TYPE",
  // Python
  "CONDA_DEFAULT_ENV", "CONDA_PREFIX", "JAVA_HOME",
  "PIP_REQUIRE_VIRTUALENV", "PYTHONPATH", "VIRTUAL_ENV",
  // Go / Rust / C++
  "CARGO_HOME", "C_INCLUDE_PATH", "CPATH", "CPLUS_INCLUDE_PATH",
  "GOPATH", "GOROOT", "RUSTUP_HOME",
]);

// ─── Detection de arquivos sensíveis ───────────────────────────

/**
 * Casamento com glob simples.
 * - `*` = qualquer sequência de caracteres (não atravessa `/`).
 * - Sem `*` = igualdade exata.
 *
 * Exportado para testes (security scan).
 */
export function matchSimpleGlob(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  // Escapa regex chars, depois transforma `*` em wildcard por segmento
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${re}$`).test(name);
}

/**
 * Casa um glob com `/` contra um path relativo ao workspace.
 * Cada segmento é casado independentemente — `*` não atravessa `/`.
 * Ex: `secrets/*` casa `secrets/api.key`, mas não `api.key` nem `secrets/x/api.key`.
 *
 * Exportado para testes (security scan).
 */
export function matchPathPattern(relPath: string, pattern: string): boolean {
  const pathSegs = relPath.split("/");
  const patSegs = pattern.split("/");
  if (pathSegs.length !== patSegs.length) return false;
  return patSegs.every((seg, i) => matchSimpleGlob(pathSegs[i], seg));
}

/**
 * Escaneia $cwd recursivamente por arquivos cujo basename
 * corresponda a qualquer padrão em `patterns`.
 *
 * Ignora .git, node_modules para performance.
 *
 * Fail-closed: se um diretório não puder ser lido (ex: permissão), LANÇA
 * erro — arquivos dentro dele podem não ser mascarados e a operação deve
 * ser bloqueada em vez de seguir sem negar.
 *
 * Exportado para testes (security scan).
 */
// Paths já alertados — evita spam no TUI a cada tool call.
const symlinkWarned = new Set<string>();

export function findDangerousFiles(cwd: string, patterns: string[], denyPaths: string[]): string[] {
  if (patterns.length === 0) return [];

  // Padrões sem "/" casam basename (compat); com "/" casam path relativo
  const namePatterns = patterns.filter((p) => !p.includes("/"));
  const pathPatterns = patterns.filter((p) => p.includes("/"));
  const results: string[] = [];

  function walk(current: string) {
    // Pula diretórios que serão mascarados integralmente por --tmpfs
    // (denyPaths). Se o bwrap já monta um tmpfs vazio no diretório,
    // qualquer arquivo sensível dentro dele é naturalmente inacessível —
    // não precisa de bind /dev/null extra. Isso também evita bloqueios
    // por EACCES em dados de runtime (ex: volumes Docker com dono diferente).
    if (denyPaths.some(dp => current === dp || current.startsWith(dp + "/"))) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      // Diretório removido durante o scan (ENOENT/ENOTDIR) → nada a mascarar
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      // Fail-closed (EACCES incluído): diretório ilegível pode conter
      // arquivos que deveriam ser mascarados — bloqueia em vez de seguir
      // sem negar. Sem permissão de listagem (r), um path ainda é
      // acessível por nome dentro do sandbox (precisa só de x no pai),
      // então o mascaramento por bind /dev/null não é garantido.
      throw new Error(
        `[dev-sandbox] Falha ao escanear '${current}' para denyFilePatterns: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const entry of entries) {
      const name = entry.name;

      // Pula diretórios grandes/conhecidos
      if (entry.isDirectory()) {
        if (name === ".git" || name === "node_modules") continue;
        walk(join(current, name));
        continue;
      }

      // Só arquivos regulares
      if (!entry.isFile()) continue;

      const fullPath = join(current, name);
      let matched = false;

      // Basename: testa o nome do arquivo
      for (const pattern of namePatterns) {
        if (matchSimpleGlob(name, pattern)) {
          matched = true;
          break;
        }
      }

      // Path: testa o caminho relativo ao workspace (ex: "secrets/*")
      if (!matched && pathPatterns.length > 0) {
        const rel = relative(cwd, fullPath);
        for (const pattern of pathPatterns) {
          if (matchPathPattern(rel, pattern)) {
            matched = true;
            break;
          }
        }
      }

      if (matched) results.push(fullPath);
    }
  }

  // Proteção contra cwd inexistente
  try {
    if (!existsSync(cwd)) return results;
    walk(cwd);
  } catch (err) {
    console.warn(
      "[dev-sandbox] Falha ao escanear denyFilePatterns — operação bloqueada:",
      err,
    );
    throw err;
  }

  return results;
}

// ─── Localização da documentação do pi ───────────────────────

/**
 * Tenta localizar o diretório de instalação do pi para montar
 * sua documentação (README.md, docs/, examples/) no sandbox.
 *
 * Ordem de busca:
 *   1. mise: ~/.local/share/mise/installs/pi/<version>/
 *   2. fallback: ~/.local/share/pi/
 *   3. any dir sob ~/.local/share/ com prefixo pi*
 */
function findPiDocsDir(home: string): string | null {
  // 1. mise — procura versão instalada (ex: ~/.local/share/mise/installs/pi/0.82.1/)
  const miseBase = join(home, ".local", "share", "mise", "installs", "pi");
  if (existsSync(miseBase)) {
    try {
      const entries = readdirSync(miseBase, { withFileTypes: true });
      // Ordena versões decrescente (ex: 0.82.1 > 0.81.0) e pega a maior
      const versions = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const va = pa[i] || 0;
            const vb = pb[i] || 0;
            if (va !== vb) return vb - va;
          }
          return 0;
        });
      if (versions.length > 0) {
        const candidate = join(miseBase, versions[0]);
        if (existsSync(join(candidate, "README.md"))) {
          return candidate;
        }
      }
    } catch {
      // Degradação segura
    }
  }

  // 2. fallback: ~/.local/share/pi/
  const localPi = join(home, ".local", "share", "pi");
  if (existsSync(localPi) && existsSync(join(localPi, "README.md"))) {
    return localPi;
  }

  // 3. varre ~/.local/share/ por diretórios pi*/
  const localShare = join(home, ".local", "share");
  if (existsSync(localShare)) {
    try {
      const entries = readdirSync(localShare, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith("pi") && e.name !== "pi") {
          const candidate = join(localShare, e.name);
          if (existsSync(join(candidate, "README.md"))) {
            return candidate;
          }
        }
      }
    } catch {
      // Degradação segura
    }
  }

  return null;
}

// ─── Diretórios de cache persistentes ──────────────────────────

/** Defaults relativos ao workspace para cada cache (valor vazio na config). */
const CACHE_DIR_DEFAULTS: Record<string, string> = {
  npm: ".sandbox-cache/npm",
  pip: ".sandbox-cache/pip",
  clones: ".sandbox-cache/clones",
};

/** Variável de ambiente exposta dentro do sandbox para cada cache. */
const CACHE_ENV_VARS: Record<string, string> = {
  npm: "NPM_CONFIG_CACHE",
  pip: "PIP_CACHE_DIR",
  clones: "SANDBOX_CLONE_DIR",
};

function isPathInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Verifica caminho configurado localmente sem seguir para fora do workspace.
 * Caminhos absolutos fora do workspace continuam permitidos explicitamente.
 */
function validateConfiguredDir(value: string, cwd: string, label: string): string {
  const target = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const local = !isAbsolute(value) || isPathInside(cwd, target);
  if (!local) return target;

  if (!isPathInside(cwd, target)) {
    throw new Error(`[dev-sandbox] ${label} escapa do workspace: ${value}`);
  }

  // Confere ancestral existente para detectar symlink em caminho criado depois.
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const realCwd = realpathSync(cwd);
    const realExisting = realpathSync(existing);
    if (!isPathInside(realCwd, realExisting)) {
      throw new Error(`[dev-sandbox] ${label} usa symlink fora do workspace: ${value}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("[dev-sandbox]")) throw err;
    // Caminho ainda não criado: será validado no bind após mkdir.
  }

  return target;
}

/**
 * Resolve os caminhos reais dos diretórios de cache.
 * - Vazio "" → <cwd>/.sandbox-cache/<nome>
 * - Relativo  → resolvido contra cwd; escape do workspace é rejeitado
 * - Absoluto  → mantido (deve ser montado — ver buildBwrapArgs)
 * - Symlink local apontando para fora do workspace é rejeitado
 */
export function resolveCacheDirs(config: SandboxConfig, cwd: string): Record<string, string> {
  const cfg = (config.filesystem.cacheDirs ?? {}) as unknown as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [name, defaultRel] of Object.entries(CACHE_DIR_DEFAULTS)) {
    const v = cfg[name];
    out[name] = validateConfiguredDir(v || defaultRel, cwd, `cache ${name}`);
  }
  return out;
}

// ─── Diretórios de quarentena (fetch/runs) ──────────────────────

/** Defaults relativos ao workspace para cada dir de quarentena. */
const QUARANTINE_DIR_DEFAULTS: Record<"fetch" | "runs", string> = {
  fetch: ".sandbox-cache/fetch",
  runs: ".sandbox-cache/runs",
};

/**
 * Resolve os caminhos reais dos diretórios de quarentena.
 * - Vazio "" → <cwd>/.sandbox-cache/<nome>
 * - Relativo → resolvido contra cwd; escape do workspace é rejeitado
 * - Absoluto → mantido (deve ser montado — ver buildIsolationArgs)
 * - Symlink local apontando para fora do workspace é rejeitado
 */
export function resolveQuarantineDirs(config: SandboxConfig, cwd: string): { fetch: string; runs: string } {
  const cfg = (config.filesystem.quarantineDirs ?? {}) as unknown as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [name, defaultRel] of Object.entries(QUARANTINE_DIR_DEFAULTS)) {
    const v = cfg[name];
    out[name] = validateConfiguredDir(v || defaultRel, cwd, `quarentena ${name}`);
  }
  return out as { fetch: string; runs: string };
}

/**
 * Cria (se necessário) um diretório de quarentena com permissão 0o700.
 * Erros são silenciosos — se o diretório não puder ser criado/acessado,
 * o bwrap falha no bind e a execução é bloqueada (fail-closed).
 */
export function ensureQuarantineDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    // Degradação segura — bind do bwrap falha se o dir não existir.
  }
}

// ─── Cache de argumentos bwrap ──────────────────────────────
//
// O cache guarda apenas a parte ESTÁTICA dos args (mounts de
// sistema, SSH, caches, capabilities, env). A varredura de
// arquivos sensíveis (denyFilePatterns) é feita a cada chamada:
// um .env criado após a primeira tool call não pode escapar.

const bwrapArgsCache = new Map<string, string[]>();
const BWRAP_ARGS_CACHE_MAX = 50;

/**
 * Impressão digital das env vars que influenciam os args.
 * Mudanças de HOME, PATH, SSH_AUTH_SOCK, USER ou de qualquer
 * var da whitelist invalidam o cache.
 */
function envFingerprint(): string {
  const keys = new Set<string>(SAFE_ENV_VARS);
  keys.add("HOME");
  keys.add("SSH_AUTH_SOCK");
  keys.add("USER");
  const parts: string[] = [];
  for (const key of keys) {
    const v = process.env[key];
    if (v !== undefined) parts.push(`${key}=${v}`);
  }
  return parts.join("|");
}

function getBwrapCacheKey(config: SandboxConfig, cwd: string, profile: SandboxProfileName): string {
  const parts = [
    cwd,
    profile,
    envFingerprint(),
    String(config.internet.enabled),
    config.ssh.mode,
    config.filesystem.denyPaths.join(","),
    config.filesystem.extraWritable.join(","),
    config.filesystem.extraReadonly.join(","),
    config.filesystem.cacheDirs ? Object.values(config.filesystem.cacheDirs).join(",") : "",
    config.filesystem.quarantineDirs ? Object.values(config.filesystem.quarantineDirs).join(",") : "",
    config.capabilities.drop.join(","),
    String(config.landlock.enabled),
    String(config.landlock.minAbi),
    landlockExecHostPath ?? "",
    ...(["normal", "fetch", "quarantine"] as const).flatMap((name) => {
      const profile = config.profiles?.[name];
      return profile ? [name, String(profile.enabled), profile.workspace, String(profile.network), profile.ssh] : [name];
    }),
  ];
  return parts.join("|");
}

// ─── Construção de argumentos bwrap ───────────────────────────

/**
 * Constrói o array de argumentos base do bwrap.
 * Estes argumentos são comuns a todas as tools.
 * Cache por config+cwd+env+perfil para evitar reconstrução a cada tool call.
 *
 * O parâmetro `profile` seleciona o perfil de isolamento:
 *   - "normal"      → comportamento atual (workspace rw, rede, SSH, caches)
 *   - "fetch"       → rede + escrita só em .sandbox-cache/fetch, sem workspace
 *   - "quarantine"  → sem rede, escrita em runs e caches configurados, sem workspace
 *
 * A parte cacheada é estática (mounts, capabilities, env). A varredura de
 * denyFilePatterns roda a cada chamada (apenas no perfil normal) e os binds
 * de /dev/null são anexados ao final — assim um arquivo sensível criado
 * depois da primeira execução não escapa do sandbox.
 */
export function buildBwrapArgs(
  config: SandboxConfig,
  cwd: string,
  profile: SandboxProfileName = "normal",
): string[] {
  const key = getBwrapCacheKey(config, cwd, profile);
  let cached = bwrapArgsCache.get(key);
  if (!cached) {
    cached = buildProfileArgs(config, cwd, profile);
    if (bwrapArgsCache.size >= BWRAP_ARGS_CACHE_MAX) {
      const oldest = bwrapArgsCache.keys().next().value;
      if (oldest !== undefined) bwrapArgsCache.delete(oldest);
    }
    bwrapArgsCache.set(key, cached);
  }
  const args = [...cached];

  // Arquivos sensíveis no projeto — substituídos por /dev/null.
  // Apenas no perfil normal (workspace montado). Anexados ao final
  // (após binds de extraWritable/cache) para que a negação SEMPRE
  // vença sobre binds de diretórios read-write.
  if (profile === "normal") {
    appendSensitiveMounts(args, config, cwd);
  }

  return args;
}

/** Dispatcher de perfil → construtor de args. */
function buildProfileArgs(config: SandboxConfig, cwd: string, profile: SandboxProfileName): string[] {
  switch (profile) {
    case "fetch":
      return buildFetchArgs(config, cwd);
    case "quarantine":
      return buildQuarantineArgs(config, cwd);
    default:
      return buildNormalArgs(config, cwd);
  }
}

/**
 * Args do perfil NORMAL (comportamento atual): workspace rw, rede do
 * host, SSH, caches, whitelist de env. A parte estática independe do
 * estado atual dos arquivos no workspace — o resultado é cacheado.
 */
function buildNormalArgs(config: SandboxConfig, cwd: string): string[] {
  const home = process.env.HOME || "/root";
  const args: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    // Limpa todas as env vars do host antes de montar o sandbox.
    // --setenv abaixo (SSH, safe vars, HOME, USER) são aplicados depois.
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    // Sistema read-only — paths detectados por distro (portability.ts)
    // Base: /usr, /bin, /lib. Condicionais: /lib64, /lib32, /nix (NixOS),
    // /etc/ssl, /etc/ca-certificates etc.
    ...resolveSystemPaths().roDirs.map((dir) => ["--ro-bind", dir, dir]).flat(),

    // /etc seletivo — apenas arquivos necessários pra runtime.
    // Inclui ld.so.cache/conf (Debian/Ubuntu/Fedora) e outros condicionais.
    ...resolveSystemPaths().etcFiles.map((f) => ["--ro-bind", f, f]).flat(),
  ];

  // ── Isolamento do HOME ──────────────────────────────────
  // Cria HOME vazio ANTES de qualquer montagem de subdiretório.
  // Montagens dentro do HOME (PATH entries, skills, .ssh, .gitconfig)
  // devem vir DEPOIS para não serem sombreadas pelo tmpfs do HOME.
  args.push("--dir", home);

  // Skills do agente — acessíveis independente do diretório do projeto
  const skillsDir = join(home, ".pi", "agent", "skills");
  if (existsSync(skillsDir)) {
    args.push("--ro-bind", skillsDir, skillsDir);
  }

  // Documentação do pi — monta o diretório de instalação para acesso
  // a README.md, docs/ e examples/. Suporta instalação via:
  //   - mise: ~/.local/share/mise/installs/pi/<version>/
  //   - npm global: ~/.local/share/pi/
  //   - outro: qualquer path com README.md em ~/.local/share/pi*/
  const piDocsDir = findPiDocsDir(home);
  if (piDocsDir) {
    args.push("--ro-bind", piDocsDir, piDocsDir);
  }

  // ── Landlock executor ─────────────────────
  // Monta o helper landlock-exec como /pi-landlock-exec dentro do sandbox.
  if (landlockExecHostPath && config.landlock.enabled) {
    args.push("--ro-bind", landlockExecHostPath, LANDLOCK_EXEC_SANDBOX_PATH);
  }

  // ── PATH sob HOME ──────────────────────────────────────
  // PATH é repassado via SAFE_ENV_VARS, mas HOME é vazio no sandbox.
  // Monta read-only os diretórios no PATH que estão sob HOME para que
  // binários gerenciados por mise, cargo, pipx, nix, etc. sejam acessíveis.
  // Deve vir DEPOIS de --dir home para não ser sombreado.
  const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
  const mountedPathDirs = new Set<string>();
  const miseInstalls = `${home}/.local/share/mise/installs/`;
  for (const dir of pathDirs) {
    if (!dir.startsWith(home + "/") || !existsSync(dir)) continue;

    // Toolchains mise precisam do diretório da versão (bin + lib), mas
    // nunca da árvore inteira ~/.local/share/mise/installs.
    let mountPath = dir;
    if (dir.startsWith(miseInstalls)) {
      const parts = dir.slice(miseInstalls.length).split("/");
      if (parts.length >= 3 && parts[2] === "bin") {
        mountPath = join(miseInstalls, parts[0], parts[1]);
      }
    }

    if (mountedPathDirs.has(mountPath)) continue;
    mountedPathDirs.add(mountPath);
    args.push("--ro-bind", mountPath, mountPath);
  }

  // Projeto read-write (ponto central do sandbox)
  args.push("--bind", cwd, cwd);

  // Rede do host
  if (config.internet.enabled) {
    args.push("--share-net");
  }

  // SSH — modo agent / mount / none
  if (config.ssh.mode === "agent") {
    // ── SSH Agent Socket ──────────────────────────
    // As chaves privadas NUNCA entram no sandbox.
    // Apenas o socket do ssh-agent é montado para solicitar assinaturas.
    const sshAuthSock = process.env.SSH_AUTH_SOCK;

    if (sshAuthSock) {
      // O socket pode ser um path real ou um symlink (ex: /tmp/ssh-XXXX/agent.XXX)
      // Resolvemos o path real para garantir que o bind funcione corretamente
      let sockPath = sshAuthSock;
      try {
        sockPath = realpathSync(sshAuthSock);
      } catch {
        // Se não conseguir resolver, usa o valor original
      }

      if (existsSync(sockPath)) {
        const sockDir = dirname(sockPath);
        // Cria o diretório pai do socket dentro do sandbox
        args.push("--dir", sockDir);
        // Monta o socket read-write (necessário para comunicação bidirecional)
        args.push("--bind", sockPath, sockPath);

        // Se o path original difere do resolvido (ex: é um symlink),
        // recria o symlink no sandbox para que o ssh-client encontre
        // o socket no caminho que espera
        if (sockPath !== sshAuthSock) {
          const origDir = dirname(sshAuthSock);
          args.push("--dir", origDir);
          args.push("--symlink", sockPath, sshAuthSock);
        }

        // Define SSH_AUTH_SOCK para o path original (o que o ssh-client espera)
        args.push("--setenv", "SSH_AUTH_SOCK", sshAuthSock);
      }
    }

    // ── known_hosts (verificação de host key) ────
    const knownHosts = join(home, ".ssh", "known_hosts");
    if (existsSync(knownHosts)) {
      args.push("--dir", join(home, ".ssh"));
      args.push("--ro-bind", knownHosts, knownHosts);
    }

    // ── .ssh/config (opcional, ex: ProxyCommand) ──
    const sshConfig = join(home, ".ssh", "config");
    if (existsSync(sshConfig)) {
      // Garante que ~/.ssh existe (pode já ter sido criado acima)
      const sshDir = join(home, ".ssh");
      if (!existsSync(knownHosts)) {
        args.push("--dir", sshDir);
      }
      args.push("--ro-bind", sshConfig, sshConfig);
    }
  } else if (config.ssh.mode === "mount") {
    // Comportamento legado: monta ~/.ssh inteiro read-only
    const sshDir = join(home, ".ssh");
    if (existsSync(sshDir)) {
      args.push("--ro-bind", sshDir, sshDir);
    }
  }
  // mode === "none": nada é montado

  // Git config (necessário pra user.name/user.email em commits)
  const gitconfig = join(home, ".gitconfig");
  if (existsSync(gitconfig)) {
    args.push("--ro-bind", gitconfig, gitconfig);
  }

  // Paths negados — sobrescritos com tmpfs vazio
  for (const deny of config.filesystem.denyPaths) {
    // Se o path for symlink (ex: /usr/sbin -> bin no Arch), bwrap --tmpfs
    // segue o symlink (mount(2) resolve o alvo) e mascara o DIRETÓRIO
    // DESTINO — ex: /usr/bin inteiro vira tmpfs vazio, quebrando shebangs
    // como #!/usr/bin/env (npm, npx, etc). Pula com aviso.
    let isSymlink = false;
    try {
      isSymlink = lstatSync(deny).isSymbolicLink();
    } catch {
      // Não existe → --tmpfs cria o diretório normalmente
    }
    if (isSymlink) {
      if (!symlinkWarned.has(deny)) {
        symlinkWarned.add(deny);
        console.warn(`[dev-sandbox] denyPath '${deny}' é symlink — ignorado (mascararia o destino).`);
      }
      continue;
    }
    args.push("--tmpfs", deny);
  }

  // Writable extras
  for (const p of config.filesystem.extraWritable) {
    if (existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // Readonly extras
  for (const p of config.filesystem.extraReadonly) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }

  // ── Caches persistentes (npm, pip, clones) ────────────
  // Cria os diretórios no host (visíveis no sandbox via bind do $PWD)
  // e expõe as variáveis de ambiente para as ferramentas (npm, pip, git).
  const cacheDirs = resolveCacheDirs(config, cwd);
  for (const [name, dir] of Object.entries(cacheDirs)) {
    validateConfiguredDir(dir, cwd, `cache ${name}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Degradação segura: segue sem criar
    }

    validateConfiguredDir(dir, cwd, `cache ${name}`);
    const envVar = CACHE_ENV_VARS[name];
    if (envVar) {
      args.push("--setenv", envVar, dir);
    }

    // Caminho fora do workspace → garante montagem read-write própria.
    // Se já coberto por extraWritable/extraReadonly, não duplica o bind.
    if (!dir.startsWith(cwd + "/")) {
      const alreadyBound = [...config.filesystem.extraWritable, ...config.filesystem.extraReadonly]
        .some((p) => dir === p || dir.startsWith(p + "/"));
      if (!alreadyBound) {
        args.push("--dir", dir);
        if (existsSync(dir)) {
          args.push("--bind", dir, dir);
        }
      }
    }
  }

  // ── Capabilities ──────────────────────────────
  // Remove capabilities perigosas. São mantidas apenas:
  //   CAP_SYS_NICE  — nice/renice (ex: nice make)
  //   CAP_SYS_RESOURCE — setrlimit (ex: ulimit -n)
  // O agente não precisa de nenhuma outra.
  for (const cap of config.capabilities.drop) {
    args.push("--cap-drop", cap);
  }

  // ── Isolamento de ambiente ────────────────────
  // --clearenv já foi adicionado no início dos args.
  // Agora repassa apenas vars seguras (desenvolvimento/runtime).
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_VARS.has(key) && value !== undefined && key !== "PATH") {
      args.push("--setenv", key, value);
    }
  }

  // PATH: garante que /usr/bin e /bin SEMPRE estejam inclusos,
  // independente de process.env.PATH. Necessário porque em instalações
  // npm global, process.env.PATH pode não incluir diretórios padrão.
  const hostPath = process.env.PATH || "";
  const requiredPaths = ["/usr/local/bin", "/usr/bin", "/bin"];
  const pathParts = hostPath.split(":").filter(Boolean);
  for (const rp of requiredPaths) {
    if (!pathParts.includes(rp)) {
      pathParts.push(rp);
    }
  }
  args.push("--setenv", "PATH", pathParts.join(":"));

  // HOME e USER — configurados via --setenv (diretório já criado acima)
  args.push("--setenv", "HOME", home);
  args.push("--setenv", "USER", process.env.USER || "root");

  return args;
}

/**
 * Base comum dos perfis de quarentena (fetch/quarantine).
 *
 * NUNCA monta o workspace do projeto: apenas o sistema read-only
 * (--ro-bind), os diretórios de quarentena RW passados em `rwDirs` e
 * caches explicitamente passados em `cacheDirs`.
 * Sem HOME real, sem SSH, sem .gitconfig, sem skills, sem PATH sob HOME.
 * Env é mínima (--clearenv + PATH/HOME/USER fixos + caches configurados).
 *
 * `shareNet`: true → --share-net (fetch); false → sem rede (quarantine),
 * já isolada pelo --unshare-all.
 */
function buildIsolationArgs(
  config: SandboxConfig,
  cwd: string,
  rwDirs: string[],
  shareNet: boolean,
  cacheDirs: Record<string, string> = {},
): string[] {
  const args: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    ...resolveSystemPaths().roDirs.map((dir) => ["--ro-bind", dir, dir]).flat(),
    ...resolveSystemPaths().etcFiles.map((f) => ["--ro-bind", f, f]).flat(),
  ];

  // ── Landlock executor ─────────────────────
  // Mesmo helper do perfil normal — usado pelo wrapWithLandlock.
  if (landlockExecHostPath && config.landlock.enabled) {
    args.push("--ro-bind", landlockExecHostPath, LANDLOCK_EXEC_SANDBOX_PATH);
  }

  // ── Paths negados — tmpfs vazio ──────────
  // Mesmo tratamento de symlink do perfil normal (não mascara o destino).
  for (const deny of config.filesystem.denyPaths) {
    let isSymlink = false;
    try {
      isSymlink = lstatSync(deny).isSymbolicLink();
    } catch {
      // Não existe → --tmpfs cria o diretório normalmente
    }
    if (isSymlink) {
      if (!symlinkWarned.has(deny)) {
        symlinkWarned.add(deny);
        console.warn(`[dev-sandbox] denyPath '${deny}' é symlink — ignorado (mascararia o destino).`);
      }
      continue;
    }
    args.push("--tmpfs", deny);
  }

  // ── Diretórios de quarentena e caches — RW explícitos ──
  for (const dir of rwDirs) {
    validateConfiguredDir(dir, cwd, "diretório de quarentena");
    ensureQuarantineDir(dir);
    validateConfiguredDir(dir, cwd, "diretório de quarentena");
  }
  for (const [name, dir] of Object.entries(cacheDirs)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Degradação segura — o bind falha e bloqueia a execução.
    }
    validateConfiguredDir(dir, cwd, `cache ${name}`);
  }
  for (const dir of [...new Set([...rwDirs, ...Object.values(cacheDirs)])]) {
    args.push("--bind", dir, dir);
  }
  for (const [name, dir] of Object.entries(cacheDirs)) {
    const envVar = CACHE_ENV_VARS[name];
    if (envVar) args.push("--setenv", envVar, dir);
  }

  // ── Rede ──────────────────────────────────
  if (shareNet) {
    args.push("--share-net");
  }

  // ── Capabilities ──────────────────────────
  // Mesma lista do perfil normal — defesa em profundidade.
  for (const cap of config.capabilities.drop) {
    args.push("--cap-drop", cap);
  }

  // ── Env mínima — nada do host ─────────────
  args.push("--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin");
  args.push("--setenv", "HOME", "/tmp");
  args.push("--setenv", "USER", "nobody");

  return args;
}

/** Perfil fetch: rede ligada, escrita só em .sandbox-cache/fetch. */
function buildFetchArgs(config: SandboxConfig, cwd: string): string[] {
  const dirs = resolveQuarantineDirs(config, cwd);
  // Respeita o kill-switch global de rede (internet.enabled).
  const shareNet = config.internet.enabled && (config.profiles?.fetch?.network ?? true);
  return buildIsolationArgs(config, cwd, [dirs.fetch], shareNet);
}

/** Perfil quarantine: sem rede, escrita em runs/ e caches persistentes. */
function buildQuarantineArgs(config: SandboxConfig, cwd: string): string[] {
  const dirs = resolveQuarantineDirs(config, cwd);
  const caches = resolveCacheDirs(config, cwd);
  // Quarentena é sempre offline, mesmo se configuração inválida tentar
  // habilitar rede no perfil.
  return buildIsolationArgs(config, cwd, [dirs.runs], false, caches);
}

/**
 * Anexa binds /dev/null para arquivos que correspondem a
 * denyFilePatterns. Re-escaneado a cada chamada para cobrir
 * arquivos criados após o cache ter sido construído.
 */
function appendSensitiveMounts(args: string[], config: SandboxConfig, cwd: string): void {
  const sensitivePatterns = config.filesystem.denyFilePatterns;
  if (sensitivePatterns.length === 0) return;
  // Falha no scan (findDangerousFiles) propaga → execução é bloqueada
  // (fail-closed): nenhuma tool roda sem garantir o mascaramento.
  const sensitiveFiles = findDangerousFiles(cwd, sensitivePatterns, config.filesystem.denyPaths);
  for (const f of sensitiveFiles) {
    // /dev/null já existe porque --dev /dev é adicionado no início
    args.push("--ro-bind", "/dev/null", f);
  }
}

// ─── Landlock ──────────────────────────────────────────────────
//
// Landlock é aplicado DENTRO do namespace bwrap via helper nativo.
// O probe de ABI é cacheado e feito uma única vez por sessão.

/** Caminho do helper landlock-exec dentro do sandbox. */
const LANDLOCK_EXEC_SANDBOX_PATH = "/pi-landlock-exec";

/** Caminho do helper no host — definido por setLandlockExecPath(). */
let landlockExecHostPath: string | undefined;

/**
 * Define o caminho do binário landlock-exec no host.
 * Deve ser chamado durante session_start, antes da primeira tool call.
 * O binário será montado como /pi-landlock-exec dentro do sandbox.
 */
export function setLandlockExecPath(hostPath: string) {
  landlockExecHostPath = hostPath;
  bwrapArgsCache.clear();
}

/** Cache do probe de ABI: undefined = não probado, null = indisponível, number = ABI. */
let landlockAbiCache: number | null | undefined = undefined;

/**
 * Consulta a ABI Landlock suportada pelo kernel chamando o helper
 * landlock-exec fora do sandbox. O resultado é cacheado — chamadas
 * subsequentes retornam o mesmo valor.
 *
 * @param helperPath Caminho absoluto do binário landlock-exec no host.
 * @returns ABI version (1-9) ou null se Landlock indisponível.
 */
export function probeLandlockAbi(helperPath: string): number | null {
  if (landlockAbiCache !== undefined) return landlockAbiCache;
  try {
    const out = execFileSync(helperPath, ["--probe-abi"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abi = parseInt(out.toString().trim(), 10);
    landlockAbiCache = Number.isFinite(abi) && abi >= 1 ? abi : null;
  } catch {
    landlockAbiCache = null;
  }
  return landlockAbiCache;
}

/** Reseta o cache de ABI (uso interno — testes). */
export function resetLandlockAbiCache() {
  landlockAbiCache = undefined;
}

/**
 * Constrói os argumentos do landlock-exec com allowlist de paths.
 *
 * RO paths: /usr, /bin, /lib, /lib64, /etc, /dev, /proc,
 *           documentação pi, skills, HOME, extraReadonly.
 * RW paths: cwd, /tmp, /run, caches, extraWritable, SSH agent socket dir.
 */
function buildLandlockArgs(
  config: SandboxConfig,
  cwd: string,
  profile: SandboxProfileName = "normal",
): string[] {
  // ── Perfis de quarentena (fetch/quarantine) ─────────────
  // Sistema RO + diretórios explícitos RW. NUNCA o workspace.
  if (profile !== "normal") {
    const args: string[] = [
      LANDLOCK_EXEC_SANDBOX_PATH,
      "--min-abi", String(config.landlock.minAbi),
    ];
    const roPaths = ["/usr", "/bin", "/lib"];
    if (existsSync("/lib64")) roPaths.push("/lib64");
    roPaths.push("/etc", "/proc");
    for (const p of roPaths) args.push("--allow-ro", p);

    const rwPaths = ["/tmp", "/run", "/dev"];
    const dirs = resolveQuarantineDirs(config, cwd);
    rwPaths.push(profile === "fetch" ? dirs.fetch : dirs.runs);
    if (profile === "quarantine") {
      rwPaths.push(...Object.values(resolveCacheDirs(config, cwd)));
    }
    for (const p of rwPaths) args.push("--allow-rw", p);

    args.push("--");
    return args;
  }

  const home = process.env.HOME || "/root";
  const args: string[] = [
    LANDLOCK_EXEC_SANDBOX_PATH,
    "--min-abi", String(config.landlock.minAbi),
  ];

  // ── Read-only paths ──────────────────────
  const roPaths = ["/usr", "/bin", "/lib"];
  if (existsSync("/lib64")) roPaths.push("/lib64");
  roPaths.push("/etc");
  roPaths.push("/proc");

  // Documentação do pi
  const piDocs = findPiDocsDir(home);
  if (piDocs) roPaths.push(piDocs);

  // Skills do agente
  const skillsDir = join(home, ".pi", "agent", "skills");
  if (existsSync(skillsDir)) roPaths.push(skillsDir);

  // HOME — tmpfs vazio com mounts seletivos (known_hosts, config, .gitconfig)
  roPaths.push(home);

  // Extra readonly
  for (const p of config.filesystem.extraReadonly) {
    if (existsSync(p)) roPaths.push(p);
  }

  for (const p of roPaths) args.push("--allow-ro", p);

  // ── Read-write paths ─────────────────────
  const rwPaths = ["/tmp", "/run", cwd];

  // /dev — read-write, NÃO read-only.
  // Regras Landlock são interseção (todas devem conceder o acesso): com
  // /dev RO, abrir /dev/null O_RDWR é negado e ferramentas que usam
  // /dev/null como sink (git init, git remote get-url, make, gcc, …)
  // quebram. O devtmpfs do namespace bwrap (--dev /dev) já expõe apenas
  // os devices padrão do kernel (null, zero, full, random, urandom, tty,
  // ptmx, pts, fd, shm) — NUNCA dispositivos de bloco do host (sda etc.).
  // E com ABI 5+, LANDLOCK_ACCESS_FS_IOCTL_DEV fica "handled" (negado por
  // padrão), então ioctl em devices continua bloqueado mesmo com /dev rw.
  rwPaths.push("/dev");

  // Caches persistentes
  const cacheDirs = resolveCacheDirs(config, cwd);
  for (const dir of Object.values(cacheDirs)) {
    if (existsSync(dir)) rwPaths.push(dir);
  }

  // Extra writable
  for (const p of config.filesystem.extraWritable) {
    if (existsSync(p)) rwPaths.push(p);
  }

  // SSH agent socket dir (precisa de rw para comunicação bidirecional)
  if (config.ssh.mode === "agent") {
    const sock = process.env.SSH_AUTH_SOCK;
    if (sock) {
      try {
        const real = realpathSync(sock);
        rwPaths.push(dirname(real));
      } catch {
        // Socket não resolvível → ignora
      }
    }
  }

  for (const p of rwPaths) args.push("--allow-rw", p);

  args.push("--");
  return args;
}

/**
 * Envolve o comando com o helper landlock-exec se o Landlock
 * estiver habilitado na configuração. Caso contrário, apenas
 * anexa o comando diretamente aos argumentos do bwrap.
 *
 * @returns Array completo de argumentos para o bwrap.
 */
export function wrapWithLandlock(
  bwrapArgs: string[],
  command: string[],
  config: SandboxConfig,
  cwd: string,
  profile: SandboxProfileName = "normal",
): string[] {
  if (!config.landlock.enabled) {
    return [...bwrapArgs, ...command];
  }
  const landlockArgs = buildLandlockArgs(config, cwd, profile);
  return [...bwrapArgs, ...landlockArgs, ...command];
}

// ─── Execução ─────────────────────────────────────────────────

/**
 * Executa um comando dentro do sandbox bwrap.
 *
 * Cria um novo namespace bwrap, executa o comando, coleta
 * stdout/stderr, e retorna o resultado. O namespace é
 * destruído automaticamente quando o processo termina.
 *
 * Se config.seccomp estiver habilitado e o arquivo BPF
 * existir, o filtro é carregado via --seccomp FD.
 */
export function execInSandbox(
  config: SandboxConfig,
  opts: BwrapCall,
  profile: SandboxProfileName = "normal",
): Promise<BwrapResult> {
  return new Promise((resolve, reject) => {
    // Sinal já abortado antes do spawn → nem cria o processo
    if (opts.signal?.aborted) {
      resolve({ stdout: Buffer.alloc(0), stderr: "", exitCode: null, timedOut: false, aborted: true });
      return;
    }

    // Base para resolução de mounts — difere de opts.cwd nos perfis de
    // quarentena, onde o processo roda dentro do próprio dir de quarentena
    // e os mounts precisam ser resolvidos a partir do workspace.
    const baseCwd = opts.baseCwd ?? opts.cwd;
    const baseArgs = buildBwrapArgs(config, baseCwd, profile);
    let args = [...baseArgs];

    // ── Seccomp BPF ──────────────────────────
    let bpfFd: number | undefined;
    const seccompCfg = config.seccomp;
    if (seccompCfg?.enabled && seccompCfg.bpfPath && existsSync(seccompCfg.bpfPath)) {
      try {
        bpfFd = openSync(seccompCfg.bpfPath, "r");
        // FD 3 no child = arquivo BPF
        args.push("--seccomp", "3");
      } catch (err) {
        // Degradação de segurança → aviso explícito
        console.warn("[dev-sandbox] Falha ao abrir seccomp.bpf — seccomp desabilitado:", err);
        bpfFd = undefined;
      }
    }

    // ── Landlock + comando ───────────────────
    // Landlock é aplicado dentro do bwrap, após mounts e seccomp.
    args = wrapWithLandlock(args, opts.command, config, baseCwd, profile);

    // stdio: stdin, stdout, stderr, + opcionalmente FD 3 (BPF)
    const stdio: any[] = ["pipe", "pipe", "pipe"];
    if (bpfFd !== undefined) {
      stdio.push(bpfFd);
    }

    const child = spawn("bwrap", args, {
      cwd: opts.cwd,
      stdio,
      detached: true,
      // Env mínimo para o binário bwrap — as vars do sandbox são
      // controladas por --clearenv + --setenv nos args acima
      env: { PATH: process.env.PATH || "" },
    });

    // Fecha cópia do pai após fork — o child tem sua própria
    if (bpfFd !== undefined) {
      closeSync(bpfFd);
    }

    // Pipe stdin
    if (opts.stdin !== undefined) {
      child.stdin!.write(opts.stdin);
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }

    // stdout em buffers para preservar bytes binários (ex: imagens)
    const stdoutChunks: Buffer[] = [];
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, opts.timeout * 1000);
    }

    // Abort signal
    const onAbort = () => killGroup(child);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);

      if (opts.signal?.aborted) {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code, timedOut: false, aborted: true });
      } else if (timedOut) {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code, timedOut: true, aborted: false });
      } else {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: code, timedOut: false, aborted: false });
      }
    });
  });
}

/**
 * Executa um comando num perfil de isolamento (fetch/quarantine).
 *
 * Validações:
 *   - perfil existe e está habilitado na configuração;
 *   - perfil NÃO expõe o workspace ("rw") — exclusivo para quarentena.
 * Os diretórios de quarentena são criados (0o700) e os caches configurados
 * são criados automaticamente durante a construção dos args
 * (buildIsolationArgs).
 */
export function execInProfile(
  config: SandboxConfig,
  opts: BwrapCall,
  profile: SandboxProfileName,
): Promise<BwrapResult> {
  const prof = config.profiles?.[profile];
  if (!prof) {
    return Promise.reject(new Error(`[dev-sandbox] Perfil '${profile}' não configurado.`));
  }
  if (!prof.enabled) {
    return Promise.reject(new Error(`[dev-sandbox] Perfil '${profile}' desabilitado na configuração.`));
  }
  if (prof.workspace === "rw") {
    return Promise.reject(
      new Error(`[dev-sandbox] Perfil '${profile}' monta o workspace — não é perfil de quarentena.`),
    );
  }
  return execInSandbox(config, opts, profile);
}

/**
 * Mata um child process e todo seu grupo de processos.
 */
export function killGroup(child: ChildProcess): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}


