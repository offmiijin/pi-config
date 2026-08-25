# Dev Sandbox

Sandbox de desenvolvimento via bubblewrap para pi.

## Instalação

```bash
# Requer bubblewrap (Linux)
sudo apt install bubblewrap

# A extensão já está em ~/.pi/agent/extensions/pi-sandbox/
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
│ pi-sandbox                     │ ← Hard boundary (kernel)
│  Namespaces (bwrap)             │   Filesystem isolado
│  Capabilities (--cap-drop ×18)  │   Poderes de root removidos
│  Seccomp (BPF ×33 syscalls)     │   Syscalls perigosas bloqueadas
│  Perfis fetch/quarantine        │   Download/execução sem workspace
└─────────────────────────────────┘
```

## Política de saída das tools

A compactação pertence à tool que conhece a semântica do resultado. O sandbox
mantém o conteúdo exato de arquivos e patches e aplica somente limites e filtros
seguros na origem:

| Tool | Política | Limite/garantia |
|---|---|---|
| `read` | conteúdo íntegro; paginação por `offset`/`limit` | truncamento nativo do Pi |
| `write`/`edit` | confirmação curta; conteúdo e patches intactos | sem poda semântica |
| `grep` | matches e contexto preservados; contexto sobreposto deduplicado | 100 matches e 50 KiB |
| `find`/glob | caminhos preservados; `.git` e `node_modules` ignorados pelo backend sandbox | limite solicitado pela tool e 50 KiB do Pi |
| `ls` | entradas preservadas e ordenadas pela tool built-in | 500 entradas e 50 KiB do Pi |
| `bash` | JSON válido minificado; testes e logs filtrados somente por comando inequívoco | saída desconhecida permanece intacta, além do limite nativo |

Toda saída limitada recebe um aviso no resultado. Código, diffs, configurações e
texto desconhecido não são compactados semanticamente.

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
  .sandbox-cache/npm, pip          → caches persistentes
  .sandbox-cache/clones             → clones isolados da sessão
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

## Workspace Git

Por padrão, para projetos Git limpos, o sandbox cria branch temporária e worktree em
`/tmp/pi-worktrees/<session-id>`. Somente esse worktree é montado no bubblewrap; o diretório
original não é exposto. Projetos com alterações locais são recusados nesse modo para evitar
misturar estado; faça commit ou stash antes. Sessões iniciadas dentro de `/tmp/pi-worktrees`
também são recusadas para impedir worktrees aninhados.

Quando `worktree.mode` é `"in-place"`, o sandbox mantém as mesmas camadas de isolamento
(bubblewrap, capabilities, Seccomp, Landlock e filtros de arquivos), mas monta a raiz Git
original como workspace. Assim, alterações e commits avançam diretamente a branch de
referência atualmente checkoutada. Alterações locais existentes são preservadas nesse modo.
Como a raiz original já é o workspace, preview/promoção para o projeto original não se aplica.

Ao encerrar sessão no modo `worktree`, o último preview é restaurado antes da remoção do
worktree. A branch criada automaticamente pelo sandbox é removida, mas branches de trabalho
nomeadas criadas pelo usuário ou pelo modelo (por exemplo, `feat/new-feature`) permanecem no
repositório. O branch de trabalho ativo é persistido na sessão do pi; ao usar `resume`, um
novo worktree aleatório é anexado diretamente a esse branch, quando ele ainda existe e está
livre.

Se a branch persistida estiver ocupada em outro worktree, a inicialização é bloqueada sem
forçar o checkout. Se ela tiver sido apagada, o sandbox cria um novo `sandbox/<session-id>`
a partir da branch original atual e exibe um aviso; esse aviso continua até uma nova branch
de trabalho ser definida. Worktrees órfãos usam lease renovado a cada 10 segundos e só são
removidos após 60 segundos sem renovação; PID isolado não é usado como única prova de que
sessão morreu. Promoções validam caminhos reais e recusam symlinks que apontem para fora do
projeto.

### Caches da sessão

`fetch/` e `runs/` são criados no `.sandbox-cache/` do worktree temporário.
Assim, `web_fetch` produz arquivos acessíveis por `read`/`ls` no mesmo workspace,
enquanto `runs/` é mascarado no perfil normal e só fica disponível ao perfil
`quarantine`. Ao encerrar a sessão, esses diretórios são descartados junto com
o worktree.

Os caches de npm e pip permanecem no projeto original para sobreviver à remoção
do worktree. Clones são criados no cache da sessão dentro do worktree. O projeto
original não é exposto como um todo.

## Configuração

### Modos SSH

| Modo | Descrição | Segurança |
|---|---|---|
| `"agent"` | Usa `ssh-agent` socket (`$SSH_AUTH_SOCK`). Chaves privadas nunca entram no sandbox. | 🔒 Alta |
| `"mount"` | Monta `~/.ssh` inteiro read-only (legado). | ⚠️ Baixa |
| `"none"` | Sem acesso SSH. | 🔒 Máxima |

> **Pré-requisito para modo `agent`**: o `ssh-agent` deve estar rodando no host
> com as chaves carregadas (`ssh-add -l` para verificar).

### Global (`~/.pi/agent/extensions/pi-sandbox.json`)

```json
{
  "enabled": true,
  "worktree": {
    "enabled": true,
    "mode": "worktree",
    "root": "/tmp/pi-worktrees",
    "cleanup": "always"
  },
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

Mesmo formato — sobrescreve campos do global. Para fazer commits diretamente na branch
checkoutada do projeto, use `"worktree": { "mode": "in-place" }`. O campo `enabled` continua
controlando o modo `worktree`; com `mode: "in-place"`, a raiz original é usada diretamente.

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
> `node_modules/` (performance). Diretórios sem permissão de leitura
> (`EACCES`) são ignorados porque também não podem ser lidos dentro do
> sandbox; outros erros de scan bloqueiam a operação.
> - Padrão **sem `/`** casa o **nome** do arquivo (basename) em
>   qualquer profundidade (ex: `.env`, `*.pem`).
> - Padrão **com `/`** casa o **path relativo ao workspace** (ex:
>   `secrets/*`, `secrets/*.pem`). `*` não atravessa `/`.
> - Se o scan falhar (ex: diretório sem permissão de leitura), a operação
>   é **bloqueada** (fail-closed) — o sandbox nunca executa sem mascarar.

### `cacheDirs` — caches de ferramentas

| Chave | Padrão | Efeito |
|---|---|---|
| `npm` | `.sandbox-cache/npm` | `NPM_CONFIG_CACHE` — cache de pacotes npm |
| `pip` | `.sandbox-cache/pip` | `PIP_CACHE_DIR` — cache de pacotes pip |
| `clones` | `.sandbox-cache/clones` | `SANDBOX_CLONE_DIR` — diretório p/ clonar repositórios |

Valor vazio (`""`) = padrão dentro do workspace. Durante uma sessão com worktree,
npm/pip usam o cache persistente do projeto original e `clones` usa o worktree
da sessão. Caminho relativo é resolvido contra o workspace correspondente;
escapes (`../`) são rejeitados. Symlinks locais que apontam para fora do
workspace também são rejeitados. Caminho absoluto fora do workspace é permitido
explicitamente e bind-montado read-write se existir no host (use `extraWritable`
para garantir persistência).

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

O diretório de clones é informado ao modelo no system prompt e via `/sandbox info`,
e exposto como `$SANDBOX_CLONE_DIR` dentro do sandbox.

### Configurações interativas

`/sandbox` usa o mesmo padrão de `/settings`: cada opção exibe seu valor atual
(`true` ou `false`). Pressione `Enter` sobre uma opção para abrir seus valores e
selecione o novo valor; a lista permanece aberta para alterar outras opções.
As alterações são persistidas no escopo global ou no projeto confiável escolhido
na abertura do menu.

## Comandos

| Comando | Descrição |
|---|---|
| Iniciar pi normalmente | Sandbox ativo por padrão |
| `pi --no-sandbox` | Desabilita sandbox para esta sessão |
| `/sandbox` | Abre as configurações interativas do sandbox |
| `/sandbox info` | Mostra informações da sessão do sandbox |
| `/promote-preview` | Aplica alterações do worktree no projeto original para live preview (modo `worktree`) |
| `/promote-restore` | Restaura estado original após o último preview |

As tools `sandbox_promote_preview` e `sandbox_promote_restore` oferecem as mesmas ações
ao modelo. Preview salva snapshot dos arquivos afetados, aceita `files` para promoção
seletiva e recusa restore se o projeto original tiver sido alterado externamente.

## Perfis de isolamento (quarentena)

Instalar ou executar código externo no bash normal é **bloqueado**
(`npm install`, `pip install`, `curl | bash`, ...). Código baixado roda em
perfis de isolamento dedicados:

| Perfil | Rede | Workspace | Escrita em |
|---|---|---|---|
| `normal` | host | rw | projeto |
| `fetch` | ✅ | ❌ | `.sandbox-cache/fetch` |
| `quarantine` | ❌ | ❌ | `.sandbox-cache/runs/<work>` + caches configurados |

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
- `fetch` pode usar rede conforme seu perfil e o kill-switch global `internet.enabled`.
- `quarantine` é sempre offline e sem SSH, mesmo que configuração tente habilitar esses recursos.
- Diretórios vazios (`""`) = `.sandbox-cache/fetch` e `.sandbox-cache/runs`
  (criados com `0o700`).

## Cache de pacotes

Caches npm (`NPM_CONFIG_CACHE`) e pip (`PIP_CACHE_DIR`) são persistidos no
`.sandbox-cache/` do projeto original. Clones (`SANDBOX_CLONE_DIR`) ficam no
`.sandbox-cache/` do worktree da sessão e são descartados com ele. O perfil
`quarantine` monta individualmente os caches configurados; o workspace inteiro
continua inacessível.
Adicione ao `.gitignore`:

```gitignore
.sandbox-cache/
```

### Python em quarentena

Use `workDir` para manter o ambiente virtual entre chamadas. O venv fica no
workdir persistente e nunca no diretório de cache pip:

```text
.sandbox-cache/runs/python-env/.venv  # ambiente virtual
.sandbox-cache/pip/                   # cache de pacotes
```

Exemplo de comando dentro de `sandbox_quarantine_exec`:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install <pacote>
```

O Python do sistema precisa fornecer `venv`/`ensurepip`. Como a quarentena
não possui rede, baixe wheels ou fontes com `sandbox_fetch` e passe-os como
artefatos para `sandbox_quarantine_exec`.

### Bootstrap de dependências do projeto

Para projeto confiável, use `sandbox_install_dependencies`. A tool executa
`npm ci --ignore-scripts` (ou `npm install --ignore-scripts` sem lockfile) no
worktree atual, usando o cache npm persistente. Como worktrees são temporários,
repita a instalação após reiniciar a sessão; o cache evita baixar tudo de novo.

O bash bloqueia instalações e execução implícita de pacotes externos (`npm install`,
`npx`, `pnpm dlx`, `pip install`, `cargo install`, entre outros). Testes Vitest locais
continuam permitidos com `vitest run` ou `npx --no-install vitest run`.

### Bootstrap offline de dependências

Cache vazio não é preenchido automaticamente pela quarentena. Fluxo seguro:

1. `sandbox_fetch` baixa wheel, `.tgz` ou fonte para a área de fetch.
2. `sandbox_quarantine_exec` recebe o arquivo em `artifacts`.
3. O comando instala o arquivo localmente, sem habilitar rede:

```bash
# npm
npm install ./pacote.tgz

# pip
python -m pip install ./pacote.whl
```

Quando `npm` ou `pip` falhar por cache ausente (`ENOTCACHED`, `no matching
distribution`, etc.), `sandbox_quarantine_exec` retorna orientação desse fluxo
no resultado. Dependências transitivas também precisam estar disponíveis como
artefatos ou no cache persistente.

## Testes

Suíte vitest na extensão (unit + integração):

```bash
cd extensions/pi-sandbox
vitest run
# ou, sem download implícito:
npx --no-install vitest run
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
- `sandbox_install_dependencies` usa `--ignore-scripts`; instalações arbitrárias no bash são bloqueadas
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
cd extensions/pi-sandbox/gen-seccomp
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
