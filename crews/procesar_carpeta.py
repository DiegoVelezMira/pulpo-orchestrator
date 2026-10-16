#!/usr/bin/env python3
"""Envia cada JSON de una carpeta al endpoint del Crew Contable y resume los resultados.

Uso: python3 procesar_carpeta.py CARPETA_JSON [CARPETA_SALIDA]
Env: PULPO_URL (por defecto http://localhost:3001/api/crews/contable/procesar)
Costo aproximado: USD 0.2 por factura.
"""
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("PULPO_URL", "http://localhost:3001/api/crews/contable/procesar")


def buscar(d, clave):
    """Busca una clave en cualquier nivel del JSON de respuesta."""
    if isinstance(d, dict):
        if clave in d:
            return d[clave]
        for v in d.values():
            r = buscar(v, clave)
            if r is not None:
                return r
    elif isinstance(d, list):
        for v in d:
            r = buscar(v, clave)
            if r is not None:
                return r
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    carpeta = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else os.path.join(carpeta, "resultados")
    os.makedirs(salida, exist_ok=True)
    archivos = sorted(f for f in os.listdir(carpeta) if f.startswith("REAL-") and f.endswith(".json"))
    print(f"{len(archivos)} facturas -> {URL}\n")
    print(f"{'ID':<10}{'ESTADO':<18}{'BASE':>12}{'IVA':>11}{'RETEFTE':>10}{'RETEIVA':>10}{'NETO':>12}  MOTIVOS")
    for nombre in archivos:
        with open(os.path.join(carpeta, nombre), encoding="utf-8") as f:
            doc = json.load(f)
        cuerpo = json.dumps({"documento": doc, "officeId": "prueba-real"}).encode("utf-8")
        req = urllib.request.Request(URL, data=cuerpo, headers={"Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                resp = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"{doc['id']:<10}{'ERROR HTTP':<18}{str(e)[:80]}")
            continue
        with open(os.path.join(salida, doc["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(resp, f, ensure_ascii=False, indent=2)
        c = buscar(resp, "calculos_oficiales") or {}
        estado = buscar(resp, "status") or "?"
        rf = (c.get("retefuente") or {}).get("valor", "-")
        ri = (c.get("reteiva") or {}).get("valor", "-")
        motivos = buscar(resp, "motivos_revision") or []
        print(f"{doc['id']:<10}{str(estado):<18}{c.get('base_gravable', '-'):>12}{c.get('iva', '-'):>11}"
              f"{rf:>10}{ri:>10}{c.get('neto_a_pagar', '-'):>12}  {'; '.join(motivos)[:90]}  ({time.time()-t0:.0f}s)")
    print(f"\nRespuestas completas en {salida}")


if __name__ == "__main__":
    main()
