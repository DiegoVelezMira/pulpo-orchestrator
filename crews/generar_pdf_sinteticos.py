#!/usr/bin/env python3
"""Genera facturas PDF SINTETICAS (texto seleccionable) para probar el lector de PDF.
Uso: python3 crews/generar_pdf_sinteticos.py CARPETA_DESTINO
Todo es inventado. Crea: buena_1.pdf, buena_2.pdf (cufe distinto), buena_1_copia.pdf (mismo CUFE, otro archivo),
total_mal.pdf (total que no aparece), escaneado.pdf (sin texto).
"""
import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

CUFE1 = "a1" * 48
CUFE2 = "b2" * 48


def factura(ruta, numero, cufe, subtotal, iva, total_impreso, nota="", comprador="901.979.163-2"):
    c = canvas.Canvas(ruta, pagesize=letter)
    y = 740
    for linea in [
        f"FACTURA ELECTRONICA DE VENTA No. {numero}",
        "Emisor: SUMINISTROS DEMO S.A.S.   NIT 900.555.444-3",
        f"Adquiriente: CLIENTE DEMO S.A.S.   NIT {comprador}",
        "Fecha de emision: 2026-10-08   Fecha de aprobacion: 2026-10-08",
        "Descripcion: Papeleria y suministros de oficina   Cant 10   Vr unitario 100.000",
        f"SUBTOTAL {subtotal:,.2f}".replace(",", "_").replace(".", ",").replace("_", "."),
        f"IVA 19% {iva:,.2f}".replace(",", "_").replace(".", ",").replace("_", "."),
        f"TOTAL A PAGAR {total_impreso:,.2f}".replace(",", "_").replace(".", ",").replace("_", "."),
        nota,
        "CUFE:", cufe[:48], cufe[48:],
        "Documento generado con datos de prueba.",
    ]:
        c.drawString(50, y, linea)
        y -= 22
    c.save()


def escaneado(ruta):
    c = canvas.Canvas(ruta, pagesize=letter)
    c.rect(50, 500, 300, 200)  # solo dibujo: sin texto seleccionable
    c.save()


if __name__ == "__main__":
    d = sys.argv[1]
    os.makedirs(d, exist_ok=True)
    factura(os.path.join(d, "buena_1.pdf"), "FE-1001", CUFE1, 1000000, 190000, 1190000)
    factura(os.path.join(d, "buena_1_copia.pdf"), "FE-1001", CUFE1, 1000000, 190000, 1190000, nota="Copia")
    factura(os.path.join(d, "buena_2.pdf"), "FE-1002", CUFE2, 500000, 95000, 595000)
    factura(os.path.join(d, "total_mal.pdf"), "FE-1003", "c3" * 48, 200000, 38000, 238000, comprador="800.123.456-1")
    escaneado(os.path.join(d, "escaneado.pdf"))
