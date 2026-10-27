# Utilidades compartidas por los scripts de instalar/. No se ejecuta solo.
CARPETA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETIQUETA="co.rentavalor.pulpo"
ETIQUETA_COPIA="co.rentavalor.pulpo.copia"
AGENTES="$HOME/Library/LaunchAgents"
COPIAS="$HOME/Pulpo-copias"
LOGS="$HOME/Library/Logs/Pulpo"

di() { printf '\n==> %s\n' "$1"; }
falla() { printf '\nNo se pudo continuar: %s\n' "$1" >&2; exit 1; }

# Ruta de node 20 y de las herramientas de Homebrew (Apple Silicon o Intel)
rutas_brew() {
  local b=""
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$p" ] && b="$p" && break; done
  [ -n "$b" ] || return 1
  BREW="$b"; PREFIJO="$("$b" --prefix)"
  RUTA_NODE="$("$b" --prefix node@20 2>/dev/null)/bin"
  PATH_PULPO="$RUTA_NODE:$PREFIJO/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

generar() { # $1 = largo en caracteres hexadecimales
  openssl rand -hex "$(( ($1 + 1) / 2 ))" | cut -c1-"$1"
}
