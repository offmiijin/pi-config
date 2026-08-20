/**
 * Tipos e interfaces para extensão dev-sandbox.
 */

export interface SandboxFilesystemConfig {
  /** Paths extras montados read-write (além do $PWD que sempre é rw). */
  extraWritable: string[];
  /** Paths extras montados read-only (ex: /mnt/dados-compartilhados). */
  extraReadonly: string[];
  /** Paths explicitamente negados — sobrescreve /usr se necessário. */
  denyPaths: string[];
  /**
   * Padrões de nomes de arquivo para negar automaticamente.
   * Escaneia $cwd recursivamente, e todo arquivo cujo basename
   * corresponda a um padrão é substituído por `/dev/null`
   * (read-only, vazio), tornando o conteúdo original inacessível
   * dentro do sandbox.
   *
   * Suporta `*` como wildcard (ex: `*.pem`, `.env.*`).
   * Sem `*` = correspondência exata.
   * Ignora .git, node_modules durante scan.
   */
  denyFilePatterns: string[];
  /**
   * Diretórios de cache persistentes dentro do sandbox.
   * Valor vazio "" = padrão: <workspace>/.sandbox-cache/<nome>.
   * Caminho relativo é resolvido contra o workspace.
   * Caminho absoluto fora do workspace: bind-montado read-write se
   * existir no host; caso contrário usa --dir (efêmero no comando).
   */
  cacheDirs: SandboxCacheDirsConfig;
  /**
   * Diretórios de quarentena (fetch/runs) — criados com 0o700.
   * Valor vazio "" = padrão: <workspace>/.sandbox-cache/<nome>.
   * Caminho relativo é resolvido contra o workspace.
   */
  quarantineDirs: SandboxQuarantineDirsConfig;
}

/** Diretórios de cache de ferramentas (npm, pip e clones de repositórios). */
export interface SandboxCacheDirsConfig {
  /** Cache do npm (env NPM_CONFIG_CACHE). Vazio = .sandbox-cache/npm. */
  npm: string;
  /** Cache do pip (env PIP_CACHE_DIR). Vazio = .sandbox-cache/pip. */
  pip: string;
  /**
   * Diretório para clonar repositórios remotos (env SANDBOX_CLONE_DIR).
   * Persiste entre comandos na sessão — /tmp NÃO persiste. Vazio = .sandbox-cache/clones.
   */
  clones: string;
}

export interface SandboxInternetConfig {
  /** true → --share-net (rede do host), false → --unshare-net (sem rede). */
  enabled: boolean;
}

/** Modo de acesso SSH dentro do sandbox. */
export type SshMode = "agent" | "mount" | "none";

export interface SandboxSshConfig {
  /**
   * Modo de acesso SSH:
   *   - "agent": usa SSH agent socket ($SSH_AUTH_SOCK) — as chaves
   *     privadas nunca entram no sandbox; apenas o socket do agente
   *     é montado para solicitar assinaturas. known_hosts e config
   *     do host são montados read-only para manter a verificação.
   *   - "mount": monta ~/.ssh inteiro read-only (comportamento legado).
   *     As chaves privadas ficam acessíveis ao sandbox.
   *   - "none": nenhum acesso SSH.
   */
  mode: SshMode;
}

// ── Perfis de isolamento ──────────────────────────────────────

/** Nome de um perfil de isolamento do sandbox. */
export type SandboxProfileName = "normal" | "fetch" | "quarantine";

/** Modo de acesso do perfil ao workspace do projeto. */
export type SandboxWorkspaceMode = "rw" | "ro" | "none";

/** Perfis reconhecidos — ordem fixa (usada na sanitização). */
export const PROFILE_NAMES: SandboxProfileName[] = ["normal", "fetch", "quarantine"];

/**
 * Configuração de um perfil de isolamento.
 *
 * - "normal": comportamento atual — workspace rw, rede do host,
 *   SSH conforme config.ssh. `workspace` é declarativo (sempre rw).
 * - "fetch": baixa dados com rede, SEM acesso ao workspace
 *   (escrita só em .sandbox-cache/fetch). `workspace` é SEMPRE "none"
 *   (invariante de quarentena — sanitização força o valor).
 * - "quarantine": executa código externo SEM rede e SEM acesso ao
 *   workspace (escrita em .sandbox-cache/runs e nos caches configurados).
 */
export interface SandboxProfileConfig {
  /** Habilita/desabilita o perfil — tools recusam uso se desabilitado. */
  enabled: boolean;
  /** Acesso ao workspace: "rw" | "ro" | "none". */
  workspace: SandboxWorkspaceMode;
  /** true → compartilha rede do host; false → sem rede. */
  network: boolean;
  /** Modo SSH dentro do perfil. */
  ssh: SshMode;
}

/** Mapa de perfis configurados. */
export type SandboxProfilesConfig = Record<SandboxProfileName, SandboxProfileConfig>;

/** Diretórios de quarentena (fetch/runs). */
export interface SandboxQuarantineDirsConfig {
  /** Downloads do perfil fetch. Vazio = <workspace>/.sandbox-cache/fetch. */
  fetch: string;
  /** Execução do perfil quarantine. Vazio = <workspace>/.sandbox-cache/runs. */
  runs: string;
}

export interface SandboxCapabilitiesConfig {
  /**
   * Linux capabilities removidas do sandbox.
   *
   * O agente só precisa de CAP_SYS_NICE (nice/renice) e
   * CAP_SYS_RESOURCE (setrlimit/ulimit). Todas as demais
   * capabilities são removidas por padrão para reduzir a
   * superfície de ataque contra exploits de kernel.
   *
   * Para reabilitar uma capability, remova-a desta lista
   * no .pi/sandbox.json do projeto.
   */
  drop: string[];
}

export interface SandboxSeccompConfig {
  /** Habilita/desabilita o filtro seccomp. */
  enabled: boolean;
  /** Caminho para o arquivo BPF compilado. */
  bpfPath: string;
}

export interface SandboxLandlockConfig {
  /** Habilita/desabilita o Landlock (filesystem only). */
  enabled: boolean;
  /**
   * Se true, falha na ativação do Landlock bloqueia a execução.
   * Se false, opera em modo degradado com warning.
   */
  required: boolean;
  /**
   * ABI mínima exigida (1-5).
   * ABI 3 (Linux 6.2) recomendada — inclui suporte a TRUNCATE.
   */
  minAbi: number;
}

export interface SandboxWorktreeConfig {
  /** Habilita worktree temporário para projetos Git. */
  enabled: boolean;
  /** Raiz dos worktrees temporários. */
  root: string;
  /** Política de remoção ao encerrar a sessão. */
  cleanup: "always" | "never";
}

export interface SandboxConfig {
  /** Configuração do worktree temporário. */
  worktree: SandboxWorktreeConfig;
  /** Habilita/desabilita todo o sandbox. */
  enabled: boolean;
  /** Configuração de rede. */
  internet: SandboxInternetConfig;
  /** Configuração de filesystem. */
  filesystem: SandboxFilesystemConfig;
  /** Configuração de acesso SSH. */
  ssh: SandboxSshConfig;
  /** Configuração de capabilities Linux. */
  capabilities: SandboxCapabilitiesConfig;
  /** Configuração do filtro seccomp. */
  seccomp: SandboxSeccompConfig;
  /** Configuração do Landlock (filesystem allowlist). */
  landlock: SandboxLandlockConfig;
  /** Perfis de isolamento (normal, fetch, quarantine). */
  profiles: SandboxProfilesConfig;
}

/** Opções para uma chamada bwrap. */
export interface BwrapCall {
  /** Comando e argumentos (ex: ["bash", "-c", "npm test"]). */
  command: string[];
  /** Diretório de trabalho dentro do sandbox. */
  cwd: string;
  /** Raiz completa do workspace montada no perfil normal. */
  workspaceRoot?: string;
  /** Diretório base (workspace) para resolução de mounts/quarantena.
   *  Necessário quando cwd é um dir de quarentena (fetch/runs) — os
   *  mounts devem ser resolvidos a partir do workspace, não do próprio
   *  dir de quarentena (senão vira path aninhado). Padrão: cwd. */
  baseCwd?: string;
  /** Conteúdo opcional para stdin. */
  stdin?: string;
  /** Sinal de aborto. */
  signal?: AbortSignal;
  /** Timeout em segundos. */
  timeout?: number;
}

/** Resultado de uma execução bwrap. */
export interface BwrapResult {
  /** Stdout como bytes brutos (preserva binário — ex: imagens). */
  stdout: Buffer;
  /** Stderr como texto (diagnóstico). */
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** Config padrão — valores de fábrica. */
export const DEFAULT_CONFIG: SandboxConfig = {
  worktree: {
    enabled: true,
    root: "/tmp/pi-worktrees",
    cleanup: "always",
  },
  enabled: true,
  internet: {
    enabled: true,
  },
  filesystem: {
    extraWritable: [],
    extraReadonly: [],
    denyPaths: ["/sbin", "/usr/sbin", "/root"],
    denyFilePatterns: [".env", "*.pem", "*.key"],
    cacheDirs: { npm: "", pip: "", clones: "" },
    quarantineDirs: { fetch: "", runs: "" },
  },
  ssh: {
    mode: "agent",
  },
  capabilities: {
    drop: [
      // ── Administração do sistema ──────────
      "CAP_SYS_ADMIN",       // mount, umount, swapon, ioctl admin
      "CAP_SYS_MODULE",      // init_module, delete_module
      "CAP_SYS_RAWIO",       // ioperm, iopl — acesso direto a hardware
      "CAP_SYS_BOOT",        // reboot, kexec_load
      "CAP_SYSLOG",          // leitura do kernel ring buffer (dmesg)
      // ── eBPF / tracing ───────────────────
      "CAP_BPF",             // bpf() — carregar programas no kernel
      "CAP_PERFMON",         // perf_event_open — amostragem de performance
      // ── Rede ─────────────────────────────
      "CAP_NET_ADMIN",       // configurar interfaces, rotas, firewall
      "CAP_NET_RAW",         // sockets raw (injeção de pacotes)
      "CAP_NET_BIND_SERVICE",// bind em portas <1024
      // ── Processos / debugging ────────────
      "CAP_SYS_PTRACE",      // ptrace — debugar qualquer processo
      "CAP_MKNOD",           // mknod — criar device nodes
      "CAP_SYS_CHROOT",      // chroot (bwrap já provê isolamento)
      // ── Permissões de arquivo ───────────
      "CAP_DAC_OVERRIDE",    // ignorar permissões de leitura/escrita
      "CAP_FOWNER",          // chmod/chown em arquivos de outros
      "CAP_FSETID",          // manter bits SUID/SGID
      "CAP_SETUID",          // setuid
      "CAP_SETGID",          // setgid
    ],
  },
  seccomp: {
    enabled: true,
    // Resolvido em runtime para <extension-dir>/seccomp.bpf
    bpfPath: "",
  },
  landlock: {
    enabled: true,
    required: true,
    minAbi: 3,
  },
  profiles: {
    normal: { enabled: true, workspace: "rw", network: true, ssh: "agent" },
    fetch: { enabled: true, workspace: "none", network: true, ssh: "none" },
    quarantine: { enabled: true, workspace: "none", network: false, ssh: "none" },
  },
};
