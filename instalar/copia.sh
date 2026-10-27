#!/bin/bash
# Copia diaria de la base de datos (consistente aunque Pulpo esté en uso). Guarda las últimas 30.
set -euo pipefail
source "$(dirname "$0")/comun.sh"
DB="${DATABASE_PATH:-}"
[ -z "$DB" ] && [ -f "$CARPETA/.env" ] && DB="$(grep -E '^DATABASE_PATH=' "$CARPETA/.env" | head -1 | cut -d= -f2-)"
DB="${DB:-$CARPETA/pulpo.db}"
[ -f "$DB" ] || { echo "No hay base de datos en $DB"; exit 0; }
mkdir -p "$COPIAS"
DESTINO="$COPIAS/pulpo-$(date +%Y-%m-%d_%H%M).db"
sqlite3 "$DB" ".backup '$DESTINO'"
ls -1t "$COPIAS"/pulpo-*.db 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$f"; done
echo "Copia guardada: $DESTINO"
