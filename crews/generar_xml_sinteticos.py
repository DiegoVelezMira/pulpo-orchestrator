#!/usr/bin/env python3
"""Genera facturas electronicas SINTETICAS (formato DIAN UBL 2.1) para probar el lector XML.
Uso: python3 crews/generar_xml_sinteticos.py CARPETA_DESTINO
Todo es inventado: NIT y nombres no corresponden a nadie.
"""
import os
import sys

NS = ('xmlns="urn:oasis:names:specification:ubl:schema:xsd:{raiz}-2" '
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" '
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"')


def parte(rol, nombre, nit, tipo, niveles):
    return (f'<cac:Accounting{rol}Party><cbc:AdditionalAccountID>{tipo}</cbc:AdditionalAccountID><cac:Party>'
            f'<cac:PartyTaxScheme><cbc:RegistrationName>{nombre}</cbc:RegistrationName>'
            f'<cbc:CompanyID schemeID="3">{nit}</cbc:CompanyID><cbc:TaxLevelCode>{niveles}</cbc:TaxLevelCode>'
            f'<cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party>'
            f'</cac:Accounting{rol}Party>')


def construir(num, lineas, iva_pct, prov, cli, nota_credito=False, sobre=False, fecha="2026-10-08"):
    raiz = "CreditNote" if nota_credito else "Invoice"
    ln, cq = ("CreditNoteLine", "CreditedQuantity") if nota_credito else ("InvoiceLine", "InvoicedQuantity")
    sub = sum(c * u for _, c, u in lineas)
    iva = round(sub * iva_pct / 100)
    cuerpo_lineas = ""
    for i, (d, c, u) in enumerate(lineas, 1):
        cuerpo_lineas += (f'<cac:{ln}><cbc:ID>{i}</cbc:ID><cbc:{cq}>{c}</cbc:{cq}>'
                          f'<cbc:LineExtensionAmount>{c*u:.2f}</cbc:LineExtensionAmount>'
                          f'<cac:Item><cbc:Description>{d}</cbc:Description></cac:Item>'
                          f'<cac:Price><cbc:PriceAmount>{u:.2f}</cbc:PriceAmount></cac:Price></cac:{ln}>')
    xml = (f'<?xml version="1.0" encoding="UTF-8"?>\n<{raiz} {NS.format(raiz=raiz)}>'
           f'<cbc:ID>{num}</cbc:ID><cbc:IssueDate>{fecha}</cbc:IssueDate>'
           f'<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>'
           f'{parte("Supplier", *prov)}{parte("Customer", *cli)}'
           f'<cac:TaxTotal><cbc:TaxAmount>{iva:.2f}</cbc:TaxAmount><cac:TaxSubtotal>'
           f'<cbc:TaxAmount>{iva:.2f}</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>{iva_pct:.2f}</cbc:Percent>'
           f'<cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>'
           f'<cac:LegalMonetaryTotal><cbc:LineExtensionAmount>{sub:.2f}</cbc:LineExtensionAmount>'
           f'<cbc:TaxExclusiveAmount>{sub:.2f}</cbc:TaxExclusiveAmount>'
           f'<cbc:TaxInclusiveAmount>{sub+iva:.2f}</cbc:TaxInclusiveAmount>'
           f'<cbc:PayableAmount>{sub+iva:.2f}</cbc:PayableAmount></cac:LegalMonetaryTotal>'
           f'{cuerpo_lineas}</{raiz}>')
    if sobre:
        interior = xml.split("?>", 1)[1].strip()
        xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<AttachedDocument '
               'xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2" '
               'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" '
               'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">'
               '<cac:Attachment><cac:ExternalReference><cbc:Description><![CDATA['
               f'{interior}]]></cbc:Description></cac:ExternalReference></cac:Attachment></AttachedDocument>')
    return xml


COMPRADOR = ("Oficina Sintetica SAS", "901000111", "1", "R-99-PN")
COMPRADOR_GC = ("Oficina Sintetica SAS", "901000111", "1", "O-13")
JUR = ("Papeleria Sintetica SAS", "900111222", "1", "R-99-PN")
JUR2 = ("Muebles Sinteticos Ltda", "800333444", "1", "R-99-PN")
SIMPLE = ("Ferreteria Simple SAS", "901555666", "1", "O-47")
NAT = ("Carlos Sintetico", "70123456", "2", "R-99-PN")

CASOS = [
    ("compra_normal", dict(num="SINT-001", lineas=[("Resmas de papel carta", 10, 18000), ("Toner impresora", 2, 210000)],
                           iva_pct=19, prov=JUR, cli=COMPRADOR)),
    ("bajo_base_minima", dict(num="SINT-002", lineas=[("Cuadernos", 20, 15000)], iva_pct=19, prov=JUR, cli=COMPRADOR)),
    ("gran_contribuyente_sobre", dict(num="SINT-003", lineas=[("Escritorios", 4, 250000)], iva_pct=19,
                                      prov=JUR2, cli=COMPRADOR_GC, sobre=True)),
    ("iva_5", dict(num="SINT-004", lineas=[("Cafe tostado 500g", 100, 10000)], iva_pct=5, prov=JUR2, cli=COMPRADOR)),
    ("nota_credito", dict(num="SINT-005", lineas=[("Devolucion toner", 2, 210000)], iva_pct=19, prov=JUR,
                          cli=COMPRADOR, nota_credito=True)),
    ("proveedor_simple", dict(num="SINT-006", lineas=[("Tornilleria surtida", 50, 30000)], iva_pct=0,
                              prov=SIMPLE, cli=COMPRADOR)),
    ("persona_natural", dict(num="SINT-007", lineas=[("Sillas usadas", 4, 200000)], iva_pct=0, prov=NAT, cli=COMPRADOR)),
]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    os.makedirs(sys.argv[1], exist_ok=True)
    for nombre, kw in CASOS:
        ruta = os.path.join(sys.argv[1], f"{kw['num']}_{nombre}.xml")
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(construir(**kw))
        print("creado", ruta)


if __name__ == "__main__":
    main()
