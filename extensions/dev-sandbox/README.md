# Dev Sandbox

Sandbox de desenvolvimento via bubblewrap para pi.

## Instalação

```bash
# Requer bubblewrap (Linux)
sudo apt install bubblewrap

# A extensão já está em ~/.pi/agent/extensions/dev-sandbox/
# Carregue normalmente ao iniciar o pi.

# Rust NÃO é necessário para uso — o seccomp.bpf já está compilado.
# Só instale Rust se quiser customizar a lista de syscalls bloqueadas.
```

> ⚠️ **Fail-closed**: se o sandbox não puder ser ativado (bubblewrap
> ausente ou erro de inicialização), as tools são **bloqueadas** — nunca
> executam no host. Para rodar sem isolamento, use `pi --no-sandbox`
> explicitamente (ou `enabled: false` na configuração global).

## Arquitetura de Proteção (3 camadas)

```
┌─────────────────────────────────┐
│ security-guard.ts (mínimo)      │ ← Soft boundary
│  Fork bomb / curl\|bash / eval  │   Só o que o sandbox NÃO isola
├─────────────────────────────────┤
│ dev-sandbox                     │ ← Hard boundary (kernel)
│  Namespaces (bwrap)             │   Filesystem isolado
│  Capabilities (--cap-drop ×18)  │   Poderes de root removidos
│  Seccomp (BPF ×33 syscalls)     │   Syscalls perigosas bloqueadas
│  Perfis fetch/quarantine        │   Download/execução sem workspace
└─────────────────────────────────┘
```

## O que é isolado

| Ferramenta | Dentro do sandbox? |
|---|---|
| `read` | ✅ cat via bwrap |
| `write` | ✅ mkdir + cat via bwrap |
| `edit` | ✅ edit composto via bwrap |
| `bash` | ✅ bash -lc via bwrap |
| `grep` | ✅ rg via bwrap |
| `find` | ✅ find via bwrap |
| `ls` | ✅ stat + ls via bwrap |
| `!comando` | ✅ user bash via bwrap |

## Filesystem

```
Montado read-only:
  /usr, /bin, /lib, /lib64       → sistema de desenvolvimento
  /etc/resolv.conf, hosts, …      → rede e usuários
  ~/.ssh/known_hosts              → verificação de host key (modo agent)
  ~/.ssh/config                   → configuração SSH (modo agent)
  ~/.pi/agent/skills              → skills do agente (sempre)
  ~/.local/share/mise/installs/pi → documentação do pi (sempre, se existir)

Montado read-write:
  $PWD                            → diretório do projeto
  .sandbox-cache/npm, pip, clones → caches persistentes + clones de repositórios
  $SSH_AUTH_SOCK (socket)         → ssh-agent socket (modo agent)

Montado como `/dev/null`:
  .env, *.pem, *.key              → arquivos sensíveis (conteúdo oculto)

Montado vazio (tmpfs):
  /sbin, /usr/sbin, /root         → ferramentas de sistema bloqueadas

> ⚠️ **denyPaths e symlinks**: se um path negado for um symlink (ex:
> `/usr/sbin -> bin` no Arch), `bwrap --tmpfs` segue o symlink e mascara o
> diretório DESTINO — `/usr/bin` inteiro viraria tmpfs vazio, quebrando
> shebangs `#!/usr/bin/env` (npm, npx). O sandbox detecta symlinks e pula
> esses paths com um warning.

NÃO montado:
  ~ (home real)                   → sem .aws, .gnupg, .bash_history
  ~/.ssh (chaves privadas)        → nunca expostas no modo agent
  /etc (completo)                 → sem shadow, sudoers, pam.d
  Dispositivos de bloco           → sem /dev/sda
```

## Configuração

### Modos SSH

| Modo | Descrição | Segurança |
|---|---|---|
| `"agent"` | Usa `ssh-agent` socket (`$SSH_AUTH_SOCK`). Chaves privadas nunca entram no sandbox. | 🔒 Alta |
| `"mount"` | Monta `~/.ssh` inteiro read-only (legado). | ⚠️ Baixa |
| `"none"` | Sem acesso SSH. | 🔒 Máxima |

> **Pré-requisito para modo `agent`**: o `ssh-agent` deve estar rodando no host
> com as chaves carregadas (`ssh-add -l` para verificar).

### Global (`~/.pi/agent/extensions/dev-sandbox.json`)

```json
{
  "enabled": true,
  "internet": { "enabled": true },
  "filesystem": {
    "extraWritable": [],
    "extraReadonly": [],
    "denyPaths": ["/sbin", "/usr/sbin", "/root"],
    "denyFilePatterns": [".env", "*.pem", "*.key"],
    "cacheDirs": { "npm": "", "pip": "", "clones": "" }
  },
  "ssh": { "mode": "agent" }
}
```

### Projeto (`.pi/sandbox.json`)

Mesmo formato — sobrescreve campos do global.

Exemplo: `/meu-projeto/.pi/sandbox.json`

```json
{
  "internet": { "enabled": false },
  "filesystem": {
    "extraWritable": ["/var/run/docker.sock"],
    "denyFilePatterns": [".env", ".env.*", "*.pem", "*.key", "secrets/*"]
  },
  "ssh": { "mode": "none" }
}
```

> **`denyFilePatterns`**: lista de padrões de arquivos a mascarar.
> O sandbox escaneia $PWD recursivamente e substitui cada arquivo
> correspondente por `/dev/null` (vazio, read-only). Ignora `.git/` e
> `node_modules/` (performance).
> - Padrão **sem `/`** casa o **nome** do arquivo (basename) em
>   qualquer profundidade (ex: `.env`, `*.pem`).
> - Padrão **com `/`** casa o **path relativo ao workspace** (ex:
>   `secrets/*`, `secrets/*.pem`). `*` não atravessa `/`.
> - Se o scan falhar (ex: diretório sem permissão de leitura), a operação
>   é **bloqueada** (fail-closed) — o sandbox nunca executa sem mascarar.

### `cacheDirs` — caches persistentes

| Chave | Padrão | Efeito |
|---|---|---|
| `npm` | `.sandbox-cache/npm` | `NPM_CONFIG_CACHE` — cache de pacotes npm |
| `pip` | `.sandbox-cache/pip` | `PIP_CACHE_DIR` — cache de pacotes pip |
| `clones` | `.sandbox-cache/clones` | `SANDBOX_CLONE_DIR` — diretório p/ clonar repositórios |

Valor vazio (`""`) = padrão dentro do workspace. Caminho relativo é resolvido
contra o workspace. Caminho absoluto fora do workspace é bind-montado
read-write se existir no host (use `extraWritable` para garantir persistência).

### Clonando repositórios

`/tmp` é efêmero (namespace novo a cada comando) — clone **NUNCA** em `/tmp`,
os dados somem. Clone em `.sandbox-cache/clones/` (ou `cacheDirs.clones`):

```bash
git clone https://github.com/foo/bar .sandbox-cache/clones/bar
```

Funciona porque:
- Rede compartilhada (`--share-net`) — HTTPS e SSH funcionam
- `~/.gitconfig` montado read-only — `user.name`/`user.email` OK
- SSH agent socket montado (modo `agent`) — repos privados OK, chaves nunca entram

O diretório de clones é informado ao modelo no system prompt e via `/sandbox`,
e exposto como `$SANDBOX_CLONE_DIR` dentro do sandbox.

## Comandos

| Comando | Descrição |
|---|---|
| Iniciar pi normalmente | Sandbox ativo por padrão |
| `pi --no-sandbox` | Desabilita sandbox para esta sessão |
| `/sandbox` | Mostra status, perfis e configuração atual |

## Perfis de isolamento (quarentena)

Instalar ou executar código externo no bash normal é **bloqueado**
(`npm install`, `pip install`, `curl | bash`, ...). Código baixado roda em
perfis de isolamento dedicados:

| Perfil | Rede | Workspace | Escrita em |
|---|---|---|---|
| `normal` | host | rw | projeto |
| `fetch` | ✅ | ❌ | `.sandbox-cache/fetch` |
| `quarantine` | ❌ | ❌ | `.sandbox-cache/runs/<work>` |

Fluxo:

1. `sandbox_fetch` — baixa arquivo (http/https) para `.sandbox-cache/fetch`,
   SEM acesso ao projeto.
2. `sandbox_quarantine_exec` — executa comando (bash) em
   `.sandbox-cache/runs/<work>`: SEM rede e SEM acesso ao projeto. Copia
   artefatos do fetch para o workdir antes de executar, se indicado.
3. `sandbox_promote` — copia artefato produzido na quarentena de volta ao
   workspace (ação explícita; único caminho de saída).

Configuração de perfis (global ou `.pi/sandbox.json`):

```json
{
  "profiles": {
    "fetch":      { "enabled": true, "network": true,  "ssh": "none" },
    "quarantine": { "enabled": true, "network": false, "ssh": "none" }
  },
  "filesystem": {
    "quarantineDirs": { "fetch": "", "runs": "" }
  }
}
```

- `workspace` de fetch/quarantine é SEMPRE `"none"` — invariante de
  quarentena: não há como liberar acesso ao projeto nesses perfis.
- `network` do fetch respeita o kill-switch global `internet.enabled`.
- Diretórios vazios (`""`) = `.sandbox-cache/fetch` e `.sandbox-cache/runs`
  (criados com `0o700`).

## Cache de pacotes

Caches npm (`NPM_CONFIG_CACHE`), pip (`PIP_CACHE_DIR`) e clones de
repositórios (`SANDBOX_CLONE_DIR`) são persistidos em `.sandbox-cache/`
dentro do projeto.
Adicione ao `.gitignore`:

```gitignore
.sandbox-cache/
```

## Testes

Suíte vitest na extensão (unit + integração):

```bash
cd extensions/dev-sandbox
npx vitest run
```

- **Unit** (~107): `buildBwrapArgs` (mounts, whitelist de env, deny scan),
  merge de config, caches, tools grep/ops — sem bwrap, rápidos.
- **Integração** (7): bwrap real (echo, stdin, /usr read-only, `.env` mascarado,
  `/tmp` efêmero, env custom, timeout). Pulados automaticamente se o ambiente
  já estiver dentro de um sandbox com seccomp (SIGSYS = exit 159) ou sem
  bubblewrap — rodam no host/CI.

## Dependências

- **bubblewrap** (`apt install bubblewrap`) — obrigatório
- **ripgrep** (`apt install ripgrep`) — para tool grep
- Linux com `kernel.unprivileged_userns_clone=1`

## Portabilidade (Linux)

O sandbox funciona em qualquer distro Linux (Debian/Ubuntu, Fedora/RHEL,
Arch, openSUSE, Alpine/musl) sem configuração extra:

- **Paths de sistema detectados por distro** (`portability.ts`): bases
  `/usr`, `/bin`, `/lib` + condicionais: `/lib64` (Fedora/RHEL),
  `/lib32`/`/libx32` (multilib), `/nix` + `/etc/static` (nix),
  `/etc/ssl`/`/etc/ca-certificates` (TLS). Nenhum path fixo de distro.
- **`/etc` seletivo**: inclui `ld.so.cache`/`ld.so.conf` quando presentes
  (Debian/Ubuntu/Fedora usam cache do linker — sem ele, libs podem não
  resolver), além de `gitconfig`, `localtime`, `hostname`.
- **landlock-exec multi-arquitetura**: o runtime procura
  `landlock-exec-<arch>` (ex: `landlock-exec-x86_64`, `landlock-exec-aarch64`,
  `landlock-exec-riscv64`) e cai para `landlock-exec` (legado) e
  `gen-seccomp/target/release/` (dev).
  **Nota de portabilidade**: o binário pré-compilado é glibc-dinâmico
  (requer GLIBC >= 2.34). Em distros musl (Alpine) ou com glibc antiga ele
  não executa — o doctor detecta via `--probe-abi` e reporta aviso.
  Recompile no próprio alvo (`./build.sh`) ou cross-compile estático
  (`TARGET=x86_64-unknown-linux-musl ./build.sh`, requer toolchain musl).
- **seccomp.bpf universal**: um ÚNICO filtro cobre x86_64 + aarch64 +
  riscv64 (libseccomp resolve os números de syscall de cada arquitetura;
  syscalls inexistentes viram no-op). Se `seccomp-<arch>.bpf` existir,
  é preferido.
- **User namespaces**: probe em `session_start` (`unshare --user true`)
  — aviso não-bloqueante se indisponíveis (bwrap falha → fail-closed).
- **Build dos artefatos**: `gen-seccomp/build.sh` gera
  `landlock-exec-<arch>` (nativo ou `TARGET=...` cross) e regenera o
  `seccomp.bpf` universal. Cross-compile requer rustup target + cross
  gcc + libseccomp do alvo.

## Limitações

- Linux apenas (bwrap depende de namespaces do kernel)
- Cada tool call cria/destrói um namespace (~30ms overhead)
- `/tmp` é efêmero entre comandos (use `.sandbox-cache/` para persistência)
- `npm install` com scripts de lifecycle executa dentro do sandbox
  (seguro porque home real inacessível)
- Perfis de quarentena usam PATH mínimo (`/usr/local/bin:/usr/bin:/bin`) e
  HOME efêmero (`/tmp`): toolchains via mise NÃO são montados. Para usar
  node/python/pip dentro de fetch/quarantine, instale no sistema
  (ex: `/usr/bin/node`, `/bin/python3`).

## Capabilities

Por padrão, 18 Linux capabilities são removidas do sandbox. As únicas
mantidas são `CAP_SYS_NICE` (nice/renice) e `CAP_SYS_RESOURCE` (setrlimit).

### Por que?

Capabilities são a **segunda camada de defesa** contra kernel exploits.
Se um bug no kernel permitir escapar do namespace bwrap, o atacante
ainda precisaria de capabilities que o sandbox removeu.

```
Namespaces → "o que o processo vê"
Capabilities → "o que o processo pode fazer"
```

### Capabilities removidas

| Capability | Motivo |
|---|---|
| `CAP_SYS_ADMIN` | mount, ioctl — o bwrap já montou tudo |
| `CAP_SYS_MODULE` | carregar módulos de kernel — nunca necessário |
| `CAP_SYS_RAWIO` | acesso direto a hardware |
| `CAP_SYS_BOOT` | reboot, kexec |
| `CAP_SYSLOG` | ler kernel ring buffer (dmesg) |
| `CAP_BPF` | carregar eBPF — vetor frequente de 0-days |
| `CAP_PERFMON` | perf_event_open — amostragem de performance |
| `CAP_SYS_PTRACE` | ptrace — debugar qualquer processo |
| `CAP_NET_ADMIN` | configurar rede, firewall |
| `CAP_NET_RAW` | sockets raw |
| `CAP_NET_BIND_SERVICE` | bind em portas <1024 |
| `CAP_MKNOD` | criar device nodes |
| `CAP_SYS_CHROOT` | chroot (bwrap já provê) |
| `CAP_DAC_OVERRIDE` | ignorar permissões de arquivo |
| `CAP_FOWNER` | chmod/chown em arquivos de outros |
| `CAP_FSETID` | manter bits SUID/SGID |
| `CAP_SETUID` / `CAP_SETGID` | trocar de usuário |

### Como reabilitar uma capability

No `.pi/sandbox.json` do projeto, remova a capability da lista `drop`:

```json
{
  "capabilities": {
    "drop": [
      "CAP_SYS_ADMIN",
      "CAP_SYS_MODULE",
      ...
      // remova CAP_SYS_PTRACE para usar gdb/strace
      // remova CAP_NET_BIND_SERVICE para bind em porta 80
    ]
  }
}
```

> ⚠️ **Cenários que precisam de capabilities extras:**
> - `gdb`, `strace`, `rr` dentro do sandbox → remova `CAP_SYS_PTRACE`
> - Dev server na porta 80 ou 443 → remova `CAP_NET_BIND_SERVICE`
> - `docker` com `--privileged` → não funciona no sandbox por design

## Seccomp

Por padrão, 33 syscalls perigosas são bloqueadas via filtro seccomp BPF.

### Por que?

Seccomp é a **terceira camada de defesa**: ele filtra syscalls diretamente
no kernel, antes mesmo de serem executadas. Se um bug no kernel permitir
escapar dos namespaces **e** das capabilities, o atacante ainda enfrenta
o filtro seccomp.

```
Namespaces   → "o que o processo vê"
Capabilities → "o que o processo pode fazer"
Seccomp      → "quais syscalls o kernel processa"
```

### Syscalls bloqueadas

O filtro é **default-allow**: tudo é permitido exceto as 33 syscalls
listadas. Nenhuma delas é necessária para operações normais do agente.

| Categoria | Syscalls |
|---|---|
| eBPF / tracing | `bpf`, `perf_event_open` |
| Debug / escape | `ptrace`, `process_vm_readv`, `process_vm_writev` |
| Kernel modules | `init_module`, `finit_module`, `delete_module` |
| Boot / kexec | `kexec_load`, `kexec_file_load`, `reboot` |
| Filesystem | `mount`, `umount2`, `pivot_root`, `swapon`, `swapoff` |
| Hardware | `iopl`, `ioperm` |
| Clock / hostname | `settimeofday`, `clock_settime`, `adjtimex`, `setdomainname`, `sethostname` |
| Kernel keyring | `add_key`, `keyctl` |
| Outros | `userfaultfd`, `kcmp`, `lookup_dcookie`, `_sysctl`, `vhangup`, `uselib`, `acct`, `modify_ldt` |

### Como reabilitar uma syscall

Edite o fonte Rust em `gen-seccomp/src/main.rs`, remova a syscall do
array `DEFAULT_BLOCKED`, recompile e regere o BPF:

```bash
cd extensions/dev-sandbox/gen-seccomp
./build.sh   # regera landlock-exec-<arch> + seccomp.bpf universal
```

### Desabilitar completamente

No `.pi/sandbox.json` do projeto:

```json
{
  "seccomp": { "enabled": false }
}
```

> ⚠️ Se o arquivo `seccomp.bpf` não for encontrado, o sandbox opera
> normalmente em modo degradado (sem seccomp). Nenhuma funcionalidade
> do agente é afetada.
