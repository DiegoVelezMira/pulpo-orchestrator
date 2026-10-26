#!/usr/bin/env python3
"""
Convierte UN XML de factura electronica DIAN en el 'documento' del Crew Contable,
SIN anonimizar (datos reales de la oficina). Lo invoca el servidor para la carga por lote.

Uso: python3 crews/xml_a_documento.py RUTA_XML --retenedor si|no --gran si|no
Salida (stdout, JSON): {"ok": true, "documento": {...}, "avisos": [...]}  o  {"ok": false, "error": "..."}

El id del documento es NUMERO_NITPROVEEDOR (NC-NUMERO_NIT para notas credito; estable: subir el mismo XML da el mismo id).
"""
import argparse
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xml_dian import leer_factura, a_documento  # noqa: E402

MAX_BYTES = 5 * 1024 * 1024


def salir(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ruta")
    ap.add_argument("--retenedor", required=True, choices=["si", "no"])
    ap.add_argument("--gran", required=True, choices=["si", "no"])
    a = ap.parse_args()
    try:
        if os.path.getsize(a.ruta) > MAX_BYTES:
            raise ValueError("El XML supera 5 MB")
        with open(a.ruta, "rb") as f:
            crudo_bytes = f.read()
        # ElementTree expande entidades: se rechaza todo XML con DOCTYPE/ENTITY (tambien escapado dentro del sobre).
        if b"\x00" in crudo_bytes:
            raise ValueError("XML en UTF-16 u otra codificacion no soportada (guardalo como UTF-8)")
        if re.search(rb"(<|&lt;|&#0*60;|&#x0*3c;)!(DOCTYPE|ENTITY)", crudo_bytes, re.I):
            raise ValueError("XML con DOCTYPE/ENTITY rechazado por seguridad")
        crudo, adv = leer_factura(a.ruta)
        numero = re.sub(r"[^A-Za-z0-9._-]", "", crudo.get("numero") or "")
        nit = re.sub(r"[^A-Za-z0-9]", "", (crudo.get("proveedor") or {}).get("nit") or "")
        if not numero:
            raise ValueError("El XML no trae numero de factura (cbc:ID)")
        if not nit:
            raise ValueError("El XML no trae NIT del proveedor")
        id_doc = f"{numero}_{nit}" if crudo.get("tipo") != "nota_credito" else f"NC-{numero}_{nit}"
        doc = a_documento(crudo, a.retenedor == "si", id_doc, anonimizar=False,
                          gran_contribuyente=(a.gran == "si"))
        # CUFE del XML (cbc:UUID de 96 hex; tambien dentro del sobre escapado): sirve para unir el PDF con su XML.
        m = re.search(r"<cbc:UUID[^>]*>\s*([0-9a-fA-F]{96})\s*</cbc:UUID>",
                      html.unescape(crudo_bytes.decode("utf-8", "ignore")))
        doc["cufe"] = m.group(1).lower() if m else None
        salir({"ok": True, "documento": doc, "avisos": adv})
    except Exception as e:  # noqa: BLE001 - cualquier XML danado se reporta, no tumba el lote
        salir({"ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
