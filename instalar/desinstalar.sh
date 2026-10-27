#!/bin/bash
# Apaga Pulpo y quita el arranque automático. No borra datos, ni la carpeta, ni las copias.
set -euo pipefail
source "$(dirname "$0")/comun.sh"
for e in "$ETIQUETA" "$ETIQUETA_COPIA"; do
  launchctl bootout "gui/$(id -u)/$e" 2>/dev/null || true
  rm -f "$AGENTES/$e.plist"
done
echo "Pulpo apagado y sin arranque automático. Sus datos (pulpo.db) y las copias en $COPIAS siguen ahí."
