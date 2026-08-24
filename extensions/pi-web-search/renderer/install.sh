#!/usr/bin/env bash
# Instala o renderer local opcional do pi-web-search.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PI_WEB_RENDERER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-web-search/renderer}"
VENV_DIR="$INSTALL_DIR/venv"
LAUNCHER="$INSTALL_DIR/pi-web-renderer"

log() { printf '[pi-web-search] %s\n' "$*"; }
die() { printf '[pi-web-search] erro: %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 não encontrado"
python3 -m venv --help >/dev/null 2>&1 || die "o módulo venv do Python não está disponível"

mkdir -p "$INSTALL_DIR"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  log "Criando ambiente virtual em $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

log "Instalando dependências Python"
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-warn-script-location -r "$SCRIPT_DIR/requirements.txt"

log "Instalando Chromium do Playwright"
"$VENV_DIR/bin/python" -m playwright install chromium

cp "$SCRIPT_DIR/renderer.py" "$INSTALL_DIR/renderer.py"
chmod 0755 "$INSTALL_DIR/renderer.py"

cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$VENV_DIR/bin/python" "$INSTALL_DIR/renderer.py" "\$@"
EOF
chmod 0755 "$LAUNCHER"

if ! "$LAUNCHER" </dev/null >/dev/null 2>&1; then
  die "o renderer não conseguiu iniciar; verifique as bibliotecas do Chromium"
fi

log "Renderer instalado em $LAUNCHER"
