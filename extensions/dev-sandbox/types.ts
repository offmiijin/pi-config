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
}

/** Diretórios de cache persistentes (npm, pip, clones de repositórios). */
export interface SandboxCacheDirsConfig {
  /** Cache do npm (env NPM_CONFIG_CACHE). Vazio = .sandbox-cache/npm. */
  npm: string;
  /** Cache do pip (env PIP_CACHE_DIR). Vazio = .sandbox-cache/pip. */
  pip: string;
  /**
   * Diretório para clonar repositórios remotos (env SANDBOX_CLONE_DIR).
   * Persiste entre comandos — /tmp NÃO persiste. Vazio = .sandbox-cache/clones.
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

export interface SandboxConfig {
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
}

/** Opções para uma chamada bwrap. */
export interface BwrapCall {
  /** Comando e argumentos (ex: ["bash", "-c", "npm test"]). */
  command: string[];
  /** Diretório de trabalho dentro do sandbox. */
  cwd: string;
  /** Conteúdo opcional para stdin. */
  stdin?: string;
  /** Sinal de aborto. */
  signal?: AbortSignal;
  /** Timeout em segundos. */
  timeout?: number;
}

/** Resultado de uma execução bwrap. */
export interface BwrapResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** Config padrão — valores de fábrica. */
export const DEFAULT_CONFIG: SandboxConfig = {
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
};
