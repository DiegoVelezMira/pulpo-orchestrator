"""Pruebas del lector XML DIAN con facturas sinteticas (sin datos reales).
Ejecutar: python3 -m unittest crews/test_xml_dian.py
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xml_dian as xd
import reglas_tributarias as rt

NS = ('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" '
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" '
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"')


def parte(rol, nombre, nit, tipo="1", niveles="R-99-PN"):
    return f"""<cac:Accounting{rol}Party><cbc:AdditionalAccountID>{tipo}</cbc:AdditionalAccountID>
<cac:Party><cac:PartyTaxScheme><cbc:RegistrationName>{nombre}</cbc:RegistrationName>
<cbc:CompanyID schemeID="7">{nit}</cbc:CompanyID><cbc:TaxLevelCode>{niveles}</cbc:TaxLevelCode>
<cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:Accounting{rol}Party>"""


def factura(raiz="Invoice", linea="InvoiceLine", cant="InvoicedQuantity", prov_niveles="R-99-PN",
            prov_tipo="1", extra_impuesto="", descuento_global=False):
    lme = "600000.00"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<{raiz} {NS}><cbc:ID>FE-12345</cbc:ID><cbc:IssueDate>2026-10-10</cbc:IssueDate>
<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
{parte("Supplier", "Papeleria Real SAS", "900123456", prov_tipo, prov_niveles)}
{parte("Customer", "Oficina Real SAS", "800999888", "1", "O-13")}
<cac:TaxTotal><cbc:TaxAmount>114000.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount>114000.00</cbc:TaxAmount>
<cac:TaxCategory><cbc:Percent>19.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>{extra_impuesto}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount>{lme}</cbc:LineExtensionAmount>
{'<cbc:AllowanceTotalAmount>10000.00</cbc:AllowanceTotalAmount>' if descuento_global else ''}<cbc:TaxExclusiveAmount>{'590000.00' if descuento_global else lme}</cbc:TaxExclusiveAmount>
<cbc:TaxInclusiveAmount>714000.00</cbc:TaxInclusiveAmount><cbc:PayableAmount>714000.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:{linea}><cbc:ID>1</cbc:ID><cbc:{cant}>10</cbc:{cant}><cbc:LineExtensionAmount>180000.00</cbc:LineExtensionAmount>
<cac:Item><cbc:Description>Resmas de papel carta</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount>18000.00</cbc:PriceAmount></cac:Price></cac:{linea}>
<cac:{linea}><cbc:ID>2</cbc:ID><cbc:{cant}>2</cbc:{cant}><cbc:LineExtensionAmount>420000.00</cbc:LineExtensionAmount>
<cac:Item><cbc:Description>Toner impresora</cbc:Description></cac:Item><cac:Price><cbc:PriceAmount>210000.00</cbc:PriceAmount></cac:Price></cac:{linea}>
</{raiz}>"""


def sobre(interior):
    interior = interior.split("?>", 1)[1]
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2"
 xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
 xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cac:Attachment><cac:ExternalReference><cbc:Description><![CDATA[{interior}]]></cbc:Description></cac:ExternalReference></cac:Attachment>
</AttachedDocument>"""


class TestXml(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def escribir(self, nombre, contenido):
        p = os.path.join(self.d, nombre)
        with open(p, "w", encoding="utf-8") as f:
            f.write(contenido)
        return p

    def test_factura_simple(self):
        crudo, adv = xd.leer_factura(self.escribir("a.xml", factura()))
        self.assertEqual(crudo["tipo"], "factura_compra")
        self.assertEqual(int(crudo["subtotal"]), 600000)
        self.assertEqual(int(crudo["iva"]), 114000)
        self.assertEqual(int(crudo["total"]), 714000)
        self.assertEqual(len(crudo["items"]), 2)
        self.assertEqual(crudo["items"][1]["valor_unitario"], 210000)
        self.assertEqual(adv, [])

    def test_sobre_attached_document(self):
        crudo, _ = xd.leer_factura(self.escribir("b.xml", sobre(factura())))
        self.assertEqual(int(crudo["total"]), 714000)

    def test_nota_credito(self):
        x = factura("CreditNote", "CreditNoteLine", "CreditedQuantity")
        crudo, _ = xd.leer_factura(self.escribir("c.xml", x))
        self.assertEqual(crudo["tipo"], "nota_credito")
        self.assertEqual(len(crudo["items"]), 2)

    def test_otros_impuestos_y_descuento_global_dan_aviso(self):
        extra = ('<cac:TaxSubtotal><cbc:TaxAmount>5000</cbc:TaxAmount><cac:TaxCategory>'
                 '<cac:TaxScheme><cbc:ID>04</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>')
        _, adv = xd.leer_factura(self.escribir("d.xml", factura(extra_impuesto=extra, descuento_global=True)))
        self.assertTrue(any("otros impuestos" in a for a in adv))
        self.assertTrue(any("descuentos" in a for a in adv))

    def test_base_gravable_cero_no_es_el_subtotal(self):
        x = factura().replace("<cbc:TaxExclusiveAmount>600000.00</cbc:TaxExclusiveAmount>",
                              "<cbc:TaxExclusiveAmount>0.00</cbc:TaxExclusiveAmount>")
        crudo, adv = xd.leer_factura(self.escribir("h.xml", x))
        self.assertEqual(int(crudo["subtotal"]), 600000)
        self.assertEqual(adv, [])

    def test_total_inconsistente_da_aviso(self):
        x = factura().replace("<cbc:TaxInclusiveAmount>714000.00</cbc:TaxInclusiveAmount>",
                              "<cbc:TaxInclusiveAmount>999999.00</cbc:TaxInclusiveAmount>")
        _, adv = xd.leer_factura(self.escribir("i.xml", x))
        self.assertTrue(any("no coincide" in a for a in adv))

    def test_nota_debito_no_soportada(self):
        with self.assertRaises(ValueError):
            xd.leer_factura(self.escribir("e.xml", factura("DebitNote", "DebitNoteLine", "DebitedQuantity")))

    def test_documento_anonimizado_y_calculable(self):
        crudo, _ = xd.leer_factura(self.escribir("f.xml", factura()))
        doc = xd.a_documento(crudo, True, "REAL-001")
        txt = json.dumps(doc)
        for secreto in ("Papeleria Real", "900123456", "Oficina Real", "800999888", "FE-12345"):
            self.assertNotIn(secreto, txt)
        self.assertEqual(doc["comprador"]["gran_contribuyente"], True)   # O-13 en el XML
        pre = rt.prevalidar(doc, date(2026, 10, 16))
        self.assertEqual(pre["rechazos"], [])
        c = rt.calcular(doc, "factura_compra", "bienes", date(2026, 10, 16))
        self.assertTrue(c["determinable"], c["advertencias"])
        self.assertEqual(c["retefuente"]["valor"], 15000)
        self.assertEqual(c["reteiva"]["valor"], 17100)                   # 15% de 114.000

    def test_anonimizacion_estable(self):
        self.assertEqual(xd._nit_falso("900123456", "persona_juridica"), xd._nit_falso("900123456", "persona_juridica"))
        self.assertNotEqual(xd._nit_falso("900123456", "persona_juridica"), xd._nit_falso("900123457", "persona_juridica"))

    def test_perfil_autorretenedor_y_simple(self):
        crudo, _ = xd.leer_factura(self.escribir("g.xml", factura(prov_niveles="O-15;O-47")))
        doc = xd.a_documento(crudo, True, "REAL-002")
        self.assertTrue(doc["proveedor_perfil"]["autorretenedor"])
        self.assertTrue(doc["proveedor_perfil"]["regimen_simple"])
        c = rt.calcular(doc, "factura_compra", "bienes", date(2026, 10, 16))
        self.assertFalse(c["determinable"])

    def test_carpeta_con_xml_danado(self):
        self.escribir("ok.xml", factura())
        self.escribir("malo.xml", "<Invoice>no cierra")
        out = os.path.join(self.d, "salida")
        n = xd.convertir_carpeta(self.d, out, True)
        self.assertEqual(n, 1)
        self.assertTrue(os.path.exists(os.path.join(out, "indice_local.csv")))


if __name__ == "__main__":
    unittest.main()
