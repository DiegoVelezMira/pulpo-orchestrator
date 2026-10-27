#!/bin/bash
# Actualiza Pulpo con una versión nueva en .zip, sin tocar .env ni la base de datos.
# Uso:  ./instalar/actualizar.sh ~/Downloads/pulpo.zip
set -euo pipefail
source "$(dirname "$0")/comun.sh"
ZIP="${1:-}"; [ -f "$ZIP" ] || falla "indica el .zip de la nueva versión. Ejemplo: ./instalar/actualizar.sh ~/Downloads/pulpo.zip"
rutas_brew || falla "no encuentro Homebrew (¿se instaló Pulpo con instalar.sh?)"
export PATH="$PATH_PULPO"
cd "$CARPETA"
di "Haciendo una copia de seguridad antes de actualizar"
bash "$CARPETA/instalar/copia.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP"
ORIGEN="$TMP"; [ "$(ls -1 "$TMP" | wc -l | tr -d ' ')" = "1" ] && [ -d "$TMP/$(ls -1 "$TMP")" ] && ORIGEN="$TMP/$(ls -1 "$TMP")"
[ -f "$ORIGEN/package.json" ] || falla "el .zip no parece una versión de Pulpo."
di "Copiando archivos nuevos"
rsync -a --exclude '.env' --exclude 'pulpo.db*' --exclude 'node_modules' --exclude 'dist' --exclude '.git' "$ORIGEN/" "$CARPETA/"
di "Dependencias y compilación"
npm install --no-audit --no-fund
npm run build
di "Reiniciando Pulpo"
launchctl kickstart -k "gui/$(id -u)/$ETIQUETA"
for i in $(seq 1 20); do curl -fs http://localhost:3000/health >/dev/null 2>&1 && { echo "Listo: Pulpo actualizado y funcionando."; exit 0; }; sleep 1; done
falla "Pulpo no respondió tras actualizar. Revisa $LOGS/pulpo.log"
