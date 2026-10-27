#!/bin/bash
# Instala Pulpo en este Mac: herramientas, dependencias, claves, arranque automático y copia de seguridad diaria.
# Uso: abrir Terminal en la carpeta de Pulpo y ejecutar:  ./instalar/instalar.sh
set -euo pipefail
source "$(dirname "$0")/comun.sh"
[ "$(uname)" = "Darwin" ] || falla "este instalador es para Mac."
cd "$CARPETA"

di "1/6 Herramientas (Homebrew, Node 20, pdftotext)"
if ! rutas_brew; then
  echo "Homebrew no está instalado. Se instalará ahora; pedirá la clave de este Mac."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  rutas_brew || falla "no quedó Homebrew instalado."
fi
"$BREW" list node@20 >/dev/null 2>&1 || "$BREW" install node@20
"$BREW" list poppler >/dev/null 2>&1 || "$BREW" install poppler
rutas_brew
export PATH="$PATH_PULPO"
command -v python3 >/dev/null || falla "falta python3 (instala las herramientas de línea de comandos de Apple: xcode-select --install)."
echo "Node $(node -v) · $(pdftotext -v 2>&1 | head -1) · $(python3 --version)"

di "2/6 Dependencias y compilación"
npm install --no-audit --no-fund
npm run build

di "3/6 Configuración (.env)"
if [ -f .env ]; then
  echo "Ya existe .env: se conserva tal cual."
else
  printf 'Pega la clave de la API de Anthropic (no se muestra al escribir; Enter para dejarla vacía por ahora): '
  read -rs LLAVE; echo
  CLAVE_ADMIN="$(generar 24)"
  umask 077
  cat > .env <<ENV
CLAUDE_API_KEY=$LLAVE
ANTHROPIC_API_KEY=$LLAVE
DATABASE_PATH=$CARPETA/pulpo.db
PORT=3000
PULPO_HOST=127.0.0.1
PULPO_SESSION_SECRET=$(generar 48)
PULPO_ADMIN_KEY=$CLAVE_ADMIN
ENV
  chmod 600 .env
  echo "Se creó .env. La clave de administrador quedó guardada ahí (archivo .env, línea PULPO_ADMIN_KEY)."
fi

di "4/6 Arranque automático"
mkdir -p "$AGENTES" "$LOGS" "$COPIAS"
cat > "$AGENTES/$ETIQUETA.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ETIQUETA</string>
  <key>ProgramArguments</key><array><string>$RUTA_NODE/node</string><string>$CARPETA/dist/index.js</string></array>
  <key>WorkingDirectory</key><string>$CARPETA</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH_PULPO</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/pulpo.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pulpo.log</string>
</dict></plist>
PLIST

di "5/6 Copia de seguridad diaria (carpeta Pulpo-copias, se guardan las últimas 30)"
cat > "$AGENTES/$ETIQUETA_COPIA.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ETIQUETA_COPIA</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$CARPETA/instalar/copia.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/copia.log</string>
  <key>StandardErrorPath</key><string>$LOGS/copia.log</string>
</dict></plist>
PLIST

di "6/6 Encendiendo Pulpo"
UID_N="$(id -u)"
for e in "$ETIQUETA" "$ETIQUETA_COPIA"; do
  launchctl bootout "gui/$UID_N/$e" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$AGENTES/$e.plist"
done
for i in $(seq 1 20); do curl -fs http://localhost:3000/health >/dev/null 2>&1 && break; sleep 1; done
curl -fs http://localhost:3000/health >/dev/null 2>&1 || falla "Pulpo no respondió. Revisa $LOGS/pulpo.log"
echo; echo "Listo. Pulpo está funcionando en http://localhost:3000 y arranca solo al encender el Mac."
open http://localhost:3000 || true
