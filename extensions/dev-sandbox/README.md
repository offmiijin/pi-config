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

## Arquitetura de Proteção (3 camadas)

```
┌─────────────────────────────────┐
│ security-guard.ts (EXISTENTE)   │ ← Soft boundary
│  Pattern matching de comandos   │   Bloqueia padrões perigosos
│  Verificação de paths sensíveis │   Pede confirmação ao usuário
├─────────────────────────────────┤
│ dev-sandbox                     │ ← Hard boundary (kernel)
│  Namespaces (bwrap)             │   Filesystem isolado
│  Capabilities (--cap-drop ×18)  │   Poderes de root removidos
│  Seccomp (BPF ×33 syscalls)     │   Syscalls perigosas bloqueadas
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

> **`denyFilePatterns`**: lista de padrões de nomes de arquivo.
> O sandbox escaneia $PWD recursivamente e substitui cada arquivo
> correspondente por `/dev/null` (vazio, read-only). Suporta `*` como
> wildcard. Ignora `.git/` e `node_modules/` (performance).

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
| `/sandbox` | Mostra status e configuração atual |

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

## Limitações

- Linux apenas (bwrap depende de namespaces do kernel)
- Cada tool call cria/destrói um namespace (~30ms overhead)
- `/tmp` é efêmero entre comandos (use `.sandbox-cache/` para persistência)
- `npm install` com scripts de lifecycle executa dentro do sandbox
  (seguro porque home real inacessível)

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
cargo build --release
./target/release/gen-seccomp > ../seccomp.bpf
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
