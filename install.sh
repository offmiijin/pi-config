#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# install.sh — instalação da configuração do pi
#
# Copia a configuração deste repositório para o diretório do agente e
# instala as dependências. Fluxo:
#   1. Node.js >= 22.19 + npm (via gerenciador de pacotes do sistema)
#   2. Pacotes de sistema: bubblewrap, ripgrep, git (+ gh e docker opcionais)
#   3. Copia extensions/, skills/, themes/, package*.json para o agente
#      (cria settings.json a partir de settings.example.json se ausente)
#   4. Dependências npm das extensões (npm ci em <agent>/node_modules)
#   5. landlock-exec (compila com Rust se disponível)
#   6. Verificações: user namespaces, inotify, seccomp, landlock, binário do pi
#   7. Opcional: Docker + SearXNG para busca local
#
# Se já existir configuração em <destino>, ela é renomeada para backup
# (~/.pi/agent-bak-<timestamp>) — dados pessoais NÃO são migrados, o
# usuário re-autentica ao abrir o pi. Instalação é única; atualizações
# futuras virão do git (git pull + rodar de novo).
#
# Uso:
#   git clone <repo> && cd pi-config && ./install.sh
#   ./install.sh --yes           # não-interativo (instala só o obrigatório)
#   ./install.sh --searxng       # também sobe Docker + SearXNG
#   ./install.sh --force         # reinstala deps npm mesmo já presentes
#   PI_AGENT_DIR=/path ./install.sh   # diretório do agente (destino)
#
# DRY_RUN=1 ./install.sh --yes   # só imprime os comandos (CI/teste)
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Flags ────────────────────────────────────────────────────────────────
ASSUME_YES=0
DRY_RUN="${DRY_RUN:-0}"
DO_FORCE=0
DO_SEARXNG=0
AGENT_DIR="${PI_AGENT_DIR:-}"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo
  echo "Flags: --yes | --force | --searxng | --dir PATH | --dry-run | --help"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --force|-f) DO_FORCE=1 ;;
    --searxng) DO_SEARXNG=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --dir|-d) AGENT_DIR="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "install.sh: flag desconhecida '$1' (--help)" >&2; exit 2 ;;
  esac
  shift
done

# ── Helpers ──────────────────────────────────────────────────────────────
GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'; NC=$'\033[0m'
if [ ! -t 1 ]; then GREEN=""; YELLOW=""; RED=""; BOLD=""; NC=""; fi

log()   { printf '%s%s%s\n' "$GREEN" "$*" "$NC"; }
warn()  { printf '%s%s%s\n' "$YELLOW" "$*" "$NC"; }
err()   { printf '%s%s%s\n' "$RED" "$*" "$NC"; }
die()   { err "$*"; exit 1; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

confirm_req() { # obrigatório: --yes OU não-interativo (curl|bash) → sim
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ ! -t 0 ] && return 0
  local ans
  printf '%s [s/N] ' "$1"
  read -r ans
  case "$ans" in s|S|sim|Sim|y|Y|yes) return 0 ;; *) return 1 ;; esac
}

confirm_opt() { # opcional: SÓ com resposta interativa (--yes não instala opcional)
  [ ! -t 0 ] && return 1
  local ans
  printf '%s [s/N] ' "$1"
  read -r ans
  case "$ans" in s|S|sim|Sim|y|Y|yes) return 0 ;; *) return 1 ;; esac
}

run() { # executa com suporte a DRY_RUN
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; return 0; fi
  "$@"
}

sudo_run() { # com sudo quando não é root
  if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] (sudo) $*"; return 0; fi
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

# ── Detecção de SO e gerenciador de pacotes ─────────────────────────────
OS_ID=""; OS_LIKE=""; OS_NAME=""
if [ -r /etc/os-release ]; then
  OS_ID="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -1)"
  OS_LIKE="$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"' | head -1)"
  OS_NAME="$(sed -n 's/^NAME=//p' /etc/os-release | tr -d '"' | head -1)"
fi

detect_pkg_mgr() {
  local ids="$OS_ID $OS_LIKE"
  case "$ids" in
    *debian*|*ubuntu*|*pop*|*zorin*|*mint*) echo apt ;;
    *arch*|*manjaro*|*endeavouros*|*cachyos*) echo pacman ;;
    *fedora*|*rhel*|*centos*|*rocky*|*almalinux*) echo dnf ;;
    *opensuse*|*suse*) echo zypper ;;
    *alpine*) echo apk ;;
    *) echo none ;;
  esac
}
PKG_MGR="$(detect_pkg_mgr)"

# Fallback: sem /etc/os-release (ex: rodando dentro do sandbox do pi ou
# imagem mínima) → detecta pelo comando instalado.
if [ "$PKG_MGR" = "none" ] || [ -z "$OS_ID" ]; then
  for pm in apt-get dnf pacman zypper apk; do
    if has_cmd "$pm"; then PKG_MGR="$pm"; break; fi
  done
  [ "$PKG_MGR" = "apt-get" ] && PKG_MGR=apt
fi

# Nome do pacote por ferramenta, no gerenciador detectado.
pkg_name() {
  local tool="$1"
  case "$PKG_MGR" in
    apt)
      case "$tool" in
        bubblewrap) echo bubblewrap;; ripgrep) echo ripgrep;; git) echo git;;
        gh) echo gh;; node) echo nodejs;; npm) echo npm;;
        docker) echo docker.io;; docker-compose) echo docker-compose-v2;; rust) echo cargo;;
      esac ;;
    dnf)
      case "$tool" in
        bubblewrap) echo bubblewrap;; ripgrep) echo ripgrep;; git) echo git;;
        gh) echo gh;; node) echo nodejs;; npm) echo npm;;
        docker) echo docker;; docker-compose) echo docker-compose-plugin;; rust) echo cargo;;
      esac ;;
    pacman)
      case "$tool" in
        bubblewrap) echo bubblewrap;; ripgrep) echo ripgrep;; git) echo git;;
        gh) echo github-cli;; node) echo nodejs;; npm) echo npm;;
        docker) echo docker;; docker-compose) echo docker-compose;; rust) echo rust;;
      esac ;;
    zypper)
      case "$tool" in
        bubblewrap) echo bubblewrap;; ripgrep) echo ripgrep;; git) echo git;;
        gh) echo gh;; node) echo nodejs20;; npm) echo npm;;
        docker) echo docker;; docker-compose) echo docker-compose-plugin;; rust) echo rust;;
      esac ;;
    apk)
      case "$tool" in
        bubblewrap) echo bubblewrap;; ripgrep) echo ripgrep;; git) echo git;;
        gh) echo github-cli;; node) echo nodejs;; npm) echo npm;;
        docker) echo docker;; docker-compose) echo docker-cli-compose;; rust) echo cargo;;
      esac ;;
    *) echo "$tool" ;;
  esac
}

install_cmd() { # install_cmd pkg1 pkg2...
  local pkgs="$*"
  case "$PKG_MGR" in
    apt) echo "apt-get install -y $pkgs" ;;
    dnf) echo "dnf install -y $pkgs" ;;
    pacman) echo "pacman -S --noconfirm $pkgs" ;;
    zypper) echo "zypper --non-interactive install $pkgs" ;;
    apk) echo "apk add $pkgs" ;;
    none) echo "" ;;
  esac
}

install_system_pkgs() { # install_system_pkgs 0|1 tool1 tool2... (0=obrigatório, 1=opcional)
  local ask="$1"; shift
  local missing=()
  local t
  for t in "$@"; do
    has_cmd "$t" || missing+=("$(pkg_name "$t")")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0
  if [ "$PKG_MGR" = "none" ]; then
    warn "Gerenciador de pacotes não detectado. Instale manualmente: ${missing[*]}"
    return 0
  fi
  local cmd
  cmd="$(install_cmd "${missing[@]}")"
  local ok=0
  if [ "$ask" -eq 0 ]; then confirm_req "Instalar via $PKG_MGR: ${missing[*]}?" && ok=1
  else confirm_opt "Instalar via $PKG_MGR: ${missing[*]}?" && ok=1; fi
  if [ "$ok" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] (sudo) $cmd"
    else
      log "▶ sudo $cmd"
      sudo_run bash -c "$cmd"
    fi
  else
    warn "Pulou instalação: ${missing[*]}"
  fi
}

# ── Diretórios: fonte (clone) e destino (~/.pi/agent) ────────────────────
SRC_DIR=""
resolve_dirs() {
  local src="${BASH_SOURCE[0]}"
  if [[ "$src" == bash* || "$src" == -* || ! -e "$src" ]]; then
    die "Rode o install.sh a partir do clone do repositório: git clone <repo> && cd pi-config && ./install.sh"
  fi
  SRC_DIR="$(cd "$(dirname "$src")" && pwd)"
  [ -d "$SRC_DIR/extensions" ] || die "SRC sem extensions/: $SRC_DIR — clone do repositório incompleto"

  if [ -z "$AGENT_DIR" ]; then
    AGENT_DIR="$HOME/.pi/agent"
  fi
}

# ── Instalação da configuração no diretório do agente ───────────────────
BACKUP_DIR=""
install_config() {
  local bak_root bak_name ts
  if [ -d "$AGENT_DIR" ]; then
    ts="$(date +%Y%m%d-%H%M%S)"
    bak_root="$(dirname "$AGENT_DIR")"
    bak_name="$(basename "$AGENT_DIR")-bak-$ts"
    BACKUP_DIR="$bak_root/$bak_name"
    warn "Configuração existente em $AGENT_DIR — renomeando para $BACKUP_DIR"
    run mv "$AGENT_DIR" "$BACKUP_DIR"
  fi

  run mkdir -p "$AGENT_DIR"
  run cp -r "$SRC_DIR/extensions" "$AGENT_DIR/"
  run cp -r "$SRC_DIR/skills" "$AGENT_DIR/"
  run cp -r "$SRC_DIR/themes" "$AGENT_DIR/"
  run cp "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$AGENT_DIR/"
  if [ -f "$SRC_DIR/settings.example.json" ]; then
    run cp "$SRC_DIR/settings.example.json" "$AGENT_DIR/settings.json"
    log "✓ settings.json criado a partir de settings.example.json"
  fi
  log "✓ Configuração instalada em $AGENT_DIR"
}

# ── Aviso final: backup criado ──────────────────────────────────────────
print_backup_notice() {
  [ -n "$BACKUP_DIR" ] || return 0
  echo
  warn "══════════════════════════════════════════════════════════"
  warn " Configuração anterior renomeada para backup:"
  warn "   $BACKUP_DIR"
  warn ""
  warn " Dados pessoais (auth.json, sessions/, memories/, settings.json)"
  warn " ficaram no backup — NÃO foram migrados."
  warn " Re-autentique seus providers ao abrir o pi."
  warn " Para restaurar a config antiga: mv $BACKUP_DIR $AGENT_DIR"
  warn "══════════════════════════════════════════════════════════"
}

# ── Node.js / npm ────────────────────────────────────────────────────────
# Node >= 22.19.0 (mesmo requisito do doctor/pi-coding-agent).
MIN_NODE_MAJ=22; MIN_NODE_MIN=19

node_sufficient() {
  local full maj min
  full="$(node -v 2>/dev/null || true)"
  [ -n "$full" ] || return 1
  full="${full#v}"
  maj="${full%%.*}"; min="${full#*.}"; min="${min%%.*}"
  [ "$maj" -gt "$MIN_NODE_MAJ" ] && return 0
  [ "$maj" -lt "$MIN_NODE_MAJ" ] && return 1
  [ "$min" -ge "$MIN_NODE_MIN" ]
}

# Instruções de instalação de Node >= 22.19 por distro (sem gerenciador de versão).
node_install_guide() {
  local ids="$OS_ID $OS_LIKE"
  case "$ids" in
    *debian*|*ubuntu*|*pop*|*zorin*|*mint*)
      echo "Ubuntu/Debian: NodeSource fornece Node 22.x (https://github.com/nodesource/distributions)"
      echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
      echo "  sudo apt-get install -y nodejs" ;;
    *) echo "Instale Node.js >= ${MIN_NODE_MAJ}.${MIN_NODE_MIN} manualmente (https://nodejs.org/en/download) ou via gerenciador de pacotes da distro." ;;
  esac
}

ensure_node() {
  if has_cmd node && has_cmd npm && node_sufficient; then
    log "✓ Node $(node -v) + npm $(npm -v)"
    return
  fi

  # Node ausente ou antigo → tenta instalar/atualizar via gerenciador do sistema
  if ! has_cmd node || ! has_cmd npm || ! node_sufficient; then
    # openSUSE: nodejs20 é antigo demais (precisa >= 22.19); instrui manual
    if [ "$PKG_MGR" = "zypper" ]; then
      warn "openSUSE: pacote nodejs20 é < 22.19."
      node_install_guide
      die "Node >= ${MIN_NODE_MAJ}.${MIN_NODE_MIN} obrigatório. Instale manualmente e rode de novo."
    fi
    install_system_pkgs 0 node npm
  fi

  if has_cmd node && has_cmd npm && node_sufficient; then
    log "✓ Node $(node -v) + npm $(npm -v)"
  else
    warn "Node/npm ausentes ou < ${MIN_NODE_MAJ}.${MIN_NODE_MIN} (detectado: $(node -v 2>/dev/null || echo 'ausente'))."
    node_install_guide
    die "Node >= ${MIN_NODE_MAJ}.${MIN_NODE_MIN} obrigatório. Instale manualmente e rode de novo."
  fi
}

# ── Dependências npm das extensões ───────────────────────────────────────
ensure_npm_deps() {
  local nm="$AGENT_DIR/node_modules"
  local key_pkg="$nm/@earendil-works/pi-coding-agent"

  if [ "$DO_FORCE" -eq 0 ] && [ -d "$key_pkg" ] && [ -d "$nm/.bin" ]; then
    log "✓ Dependências npm já instaladas (--force para reinstalar)"
    return
  fi

  [ -f "$AGENT_DIR/package.json" ] || die "package.json não encontrado em $AGENT_DIR (config incompleta?)"

  if confirm_req "Instalar dependências npm das extensões (npm ci em $AGENT_DIR)?"; then
    if [ -f "$AGENT_DIR/package-lock.json" ]; then
      run bash -c "cd '$AGENT_DIR' && npm ci --no-audit --no-fund"
    else
      run bash -c "cd '$AGENT_DIR' && npm install --no-audit --no-fund"
    fi
  else
    warn "Deps npm não instaladas — extensões vão falhar ao carregar."
  fi
}

# ── landlock-exec (Rust opcional) ────────────────────────────────────────
ensure_landlock() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;; aarch64) arch=aarch64 ;; riscv64) arch=riscv64 ;;
    *) arch="$(uname -m)" ;;
  esac
  local bin="$AGENT_DIR/extensions/dev-sandbox/landlock-exec-$arch"
  [ -x "$bin" ] && log "✓ landlock-exec-$arch presente" && return

  if has_cmd cargo; then
    if confirm_opt "Compilar landlock-exec-$arch (Rust encontrado)?"; then
      run bash -c "cd '$AGENT_DIR/extensions/dev-sandbox/gen-seccomp' && ./build.sh"
      [ -x "$bin" ] && log "✓ landlock-exec-$arch compilado" || warn "build.sh não gerou $bin"
      return
    fi
  fi
  warn "landlock-exec-$arch ausente — Landlock fica degradado (opcional). Instale Rust + rode gen-seccomp/build.sh, ou ignore."
}

# ── Verificações de kernel / ambiente ────────────────────────────────────
check_kernel() {
  local uc apparmor watches
  uc="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || true)"
  apparmor="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
  watches="$(sysctl -n fs.inotify.max_user_watches 2>/dev/null || true)"

  if [ -n "$uc" ] && [ "$uc" != "1" ]; then
    warn "⚠ kernel.unprivileged_userns_clone=$uc — bwrap vai falhar (sandbox fail-closed)."
    warn "  Fix (root): sysctl kernel.unprivileged_userns_clone=1 (persistir em /etc/sysctl.d/)"
  fi
  if [ -n "$apparmor" ] && [ "$apparmor" != "0" ]; then
    warn "⚠ kernel.apparmor_restrict_unprivileged_userns=1 pode bloquear bwrap no Ubuntu 24.04+."
    warn "  Se o pi falhar, use 'pi --no-sandbox' ou ajuste o AppArmor."
  fi
  if [ -n "$watches" ] && [ "$watches" -lt 100000 ]; then
    warn "⚠ fs.inotify.max_user_watches=$watches é baixo (watchers de arquivo)."
    warn "  Sugestão (root): sysctl fs.inotify.max_user_watches=524288"
  fi

  if ! has_cmd unshare || ! unshare --user true 2>/dev/null; then
    warn "⚠ user namespaces não funcionam neste ambiente — bwrap pode falhar."
  fi
}

# ── Seccomp / Landlock (kernel) ──────────────────────────────────────────
kernel_version_ge() { # kernel_version_ge 5 13 → kernel >= 5.13
  local kver major minor
  kver="$(uname -r)"
  major="${kver%%.*}"; minor="${kver#*.}"; minor="${minor%%.*}"
  [ "${major:-0}" -gt "$1" ] && return 0
  [ "${major:-0}" -lt "$1" ] && return 1
  [ "${minor:-0}" -ge "$2" ]
}

kernel_config() { # conteúdo do config do kernel (vazio se indisponível)
  local f
  if [ -r /proc/config.gz ]; then
    zcat /proc/config.gz 2>/dev/null || true
  else
    for f in "/boot/config-$(uname -r)" /boot/config; do
      [ -r "$f" ] && cat "$f" 2>/dev/null && return
    done
  fi
}

check_seccomp() {
  local cfg
  cfg="$(kernel_config)"
  if [ -n "$cfg" ]; then
    if echo "$cfg" | grep '^CONFIG_SECCOMP_FILTER=y' >/dev/null; then
      log "✓ Seccomp (BPF filter) habilitado no kernel"
    elif echo "$cfg" | grep '^CONFIG_SECCOMP=y' >/dev/null; then
      warn "⚠ CONFIG_SECCOMP_FILTER não habilitado — filtro seccomp (seccomp.bpf) falha no sandbox."
    else
      warn "⚠ Seccomp desabilitado no kernel — sandbox sem isolamento seccomp."
    fi
  else
    log "✓ Seccomp: config do kernel indisponível — validado em runtime pelo sandbox"
  fi
}

check_landlock() {
  local lsm cfg
  lsm="$(cat /sys/kernel/security/lsm 2>/dev/null || true)"
  if [ -n "$lsm" ] && echo "$lsm" | grep landlock >/dev/null; then
    log "✓ Landlock LSM ativo"
    return
  fi
  cfg="$(kernel_config)"
  if [ -n "$cfg" ] && echo "$cfg" | grep '^CONFIG_SECURITY_LANDLOCK=y' >/dev/null; then
    log "✓ Landlock compilado no kernel (CONFIG_SECURITY_LANDLOCK=y)"
    return
  fi
  if kernel_version_ge 5 13; then
    warn "⚠ Landlock não detectado (sem CONFIG_SECURITY_LANDLOCK/LSM) — sandbox degradado."
  else
    warn "⚠ Kernel $(uname -r) < 5.13 — Landlock não suportado; sandbox degradado."
  fi
  warn "  Isolamento Landlock desativado; bwrap/seccomp continuam ativos."
}

# ── Docker + SearXNG (opcional) ──────────────────────────────────────────
# O container SearXNG roda no HOST (não no sandbox do pi).
# O pi acessa via HTTP em localhost:4000 (--share-net compartilha rede do host).
# Falhas aqui NUNCA abortam o instalador: SearXNG é um extra opcional.
setup_searxng() {
  local ws="$AGENT_DIR/extensions/pi-web-search"
  [ -d "$ws" ] || { warn "pi-web-search não encontrado — pulando SearXNG."; return; }

  if [ "$DO_SEARXNG" -eq 0 ]; then
    confirm_opt "Configurar Docker + SearXNG para busca local (opcional)?" || return 0
  fi

  # ── Instala Docker (binário + daemon) ──────────────────────
  if ! has_cmd docker; then
    install_system_pkgs "$([ "$DO_SEARXNG" -eq 1 ] && echo 0 || echo 1)" docker
  fi
  if ! has_cmd docker; then
    warn "Docker indisponível — use APIs externas: /web_search config <tavily|exa|serper> <key>"
    return
  fi

  # ── Verifica daemon rodando ────────────────────────────────
  if ! docker info >/dev/null 2>&1; then
    warn "Docker instalado mas daemon não está rodando."
    warn "  Inicie o daemon (systemctl start docker) e rode o SearXNG manualmente:"
    warn "    cd $ws && docker compose up -d"
    return
  fi

  # ── Plugin docker compose ──────────────────────────────────
  if ! docker compose version >/dev/null 2>&1; then
    warn "Plugin 'docker compose' não encontrado — instalando..."
    install_system_pkgs 1 docker-compose
    if ! docker compose version >/dev/null 2>&1; then
      warn "Plugin compose indisponível. Instale docker-compose-plugin manualmente."
      return
    fi
  fi

  # ── .env com chave aleatória para o SEARXNG_SECRET ────────
  local envfile="$ws/.env"
  if [ ! -f "$envfile" ]; then
    local key
    key="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40 || true)"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "[dry-run] cria $envfile com SEARXNG_KEY aleatória"
    else
      printf 'SEARXNG_KEY=%s\n' "${key:-change-me}" > "$envfile"
      log "✓ .env gerado em $ws/.env"
    fi
  fi

  # ── Sobe container (falha não derruba instalador) ─────────
  if [ "$DO_SEARXNG" -eq 1 ] || confirm_opt "Subir container SearXNG (docker compose up -d)?"; then
    if run bash -c "cd '$ws' && docker compose up -d" 2>/dev/null; then
      log "✓ SearXNG iniciado em http://localhost:4000"
      warn "Após o 1º start, habilite JSON no SearXNG:"
      warn "  docker exec pi-searxng sed -i 's/  formats:\\n    - html/  formats:\\n    - html\\n    - json/' /etc/searxng/settings.yml && docker restart pi-searxng"
    else
      warn "Falha ao subir SearXNG (porta 4000 ocupada? container já existe?)."
      warn "  Verifique manualmente: cd $ws && docker compose up -d"
    fi
  fi
}

# ── pi binary ────────────────────────────────────────────────────────────
check_pi() {
  if has_cmd pi; then
    log "✓ pi $(pi --version 2>/dev/null || echo encontrado)"
  else
    warn "⚠ binário 'pi' não encontrado no PATH."
    if has_cmd mise; then
      warn "  Instale: mise install pi && mise use -g pi"
    else
      warn "  Instale seguindo https://github.com/earendil-works/pi (npm i -g ou mise)."
    fi
  fi
}

# ── Execução ─────────────────────────────────────────────────────────────
main() {
  echo "──────────────────────────────────────────────"
  echo "🧑⚕️  Pi config — install.sh"
  echo "──────────────────────────────────────────────"
  [ "$DRY_RUN" -eq 1 ] && warn "(DRY-RUN — nada será executado)"

  resolve_dirs
  log "Fonte: $SRC_DIR"
  log "Destino do agente: $AGENT_DIR"
  [ -n "$OS_NAME" ] && log "Sistema: $OS_NAME ($PKG_MGR)"

  ensure_node
  install_system_pkgs 0 bubblewrap ripgrep git
  has_cmd gh || install_system_pkgs 1 gh
  install_config
  ensure_npm_deps
  ensure_landlock
  check_kernel
  check_seccomp
  check_landlock
  setup_searxng
  check_pi

  echo
  log "✔ Concluído! Inicie o pi — a extensão doctor (00-doctor) valida o ambiente:"
  log "    pi   (ou /reload se já estiver aberto)"
  print_backup_notice
  if [ "$ASSUME_YES" -eq 0 ]; then
    echo "Dica: rode /doctor dentro do pi para ver o relatório completo."
  fi
  return 0
}

main
