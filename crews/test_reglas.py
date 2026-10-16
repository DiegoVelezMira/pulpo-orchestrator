#!/usr/bin/env python3
"""
Pruebas SIN costo del calculador tributario y del flujo del crew.
No llaman a la API: el cliente de Anthropic se reemplaza por uno simulado.

Correr desde la carpeta del proyecto:
    python3 -m unittest crews/test_reglas.py -v     (o)     python3 crews/test_reglas.py
"""
import json
import os
import sys
import unittest
from datetime import date
from types import SimpleNamespace

os.environ.setdefault("ANTHROPIC_API_KEY", "clave-de-prueba")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import reglas_tributarias as rt
import contable_crew as cc

HOY = date(2026, 10, 16)
COMPRADOR = {"razon_social": "Oficina Demo S.A.S.", "nit": "901000111-2",
             "agente_retenedor_renta": True, "gran_contribuyente": False, "regimen": "ordinario"}
COMPRADOR_GC = dict(COMPRADOR, gran_contribuyente=True)
ITEMS_PAPEL = [{"descripcion": "Resmas de papel carta", "cantidad": 10, "valor_unitario": 18000},
               {"descripcion": "Tóner impresora", "cantidad": 2, "valor_unitario": 210000}]


def doc(id_, **kw):
    d = {"id": id_, "tipo": "factura_compra", "fecha": "2026-10-16", "moneda": "COP",
         "comprador": COMPRADOR, "proveedor": "Papelería El Estudiante S.A.S.",
         "nit_proveedor": "900123456-7"}
    d.update(kw)
    return d


D1 = doc("PRUEBA-101", items=ITEMS_PAPEL, subtotal=600000, iva_19=114000, total=714000)
D2 = doc("PRUEBA-102", items=[{"descripcion": "Cuadernos", "cantidad": 20, "valor_unitario": 15000}],
         subtotal=300000, iva_19=57000, total=357000)
D3 = doc("PRUEBA-103", comprador=COMPRADOR_GC,
         items=[{"descripcion": "Muebles", "cantidad": 4, "valor_unitario": 250000}],
         subtotal=1000000, iva_19=190000, total=1190000)
D4 = doc("PRUEBA-104", items=[{"descripcion": "Silla", "cantidad": 5, "valor_unitario": 100000}],
         subtotal=500000, iva_19=95000, total=605000)
D5 = doc("PRUEBA-105", fecha="2027-03-15", items=ITEMS_PAPEL, subtotal=600000, iva_19=114000, total=714000)
D6 = doc("PRUEBA-106", nit_proveedor="", items=[{"descripcion": "Papel", "cantidad": 10, "valor_unitario": 18000}],
         subtotal=180000, iva_19=34200, total=214200)
D7 = doc("PRUEBA-107", tipo="nota_credito", referencia="FV-2045",
         items=[{"descripcion": "Devolución tóner", "cantidad": 2, "valor_unitario": 210000}],
         subtotal=420000, iva_19=79800, total=499800)
D8 = doc("PRUEBA-108", proveedor="Carlos Mejía", nit_proveedor="70123456-1",
         proveedor_perfil={"tipo": "persona_natural", "declarante_renta": False, "responsable_iva": False},
         items=[{"descripcion": "Sillas usadas", "cantidad": 4, "valor_unitario": 200000}],
         subtotal=800000, iva_19=0, total=800000)


def calc(d, concepto="bienes"):
    return rt.calcular(d, rt.normalizar_tipo(d.get("tipo")), concepto, HOY)


def asiento_correcto(c):
    """Asiento que un modelo disciplinado armaria con calculos_oficiales."""
    lineas = [{"cuenta": "1435 — Mercancías", "debito": c["base_gravable"], "credito": 0}]
    if c["iva"]:
        lineas.append({"cuenta": "2408 — IVA descontable", "debito": c["iva"], "credito": 0})
    if c["retefuente"]["aplica"]:
        lineas.append({"cuenta": "2365 — ReteFuente", "debito": 0, "credito": c["retefuente"]["valor"]})
    if c["reteiva"]["aplica"]:
        lineas.append({"cuenta": "2367 — ReteIVA", "debito": 0, "credito": c["reteiva"]["valor"]})
    lineas.append({"cuenta": "2205 — Proveedores", "debito": 0, "credito": c["neto_a_pagar"]})
    if c.get("tipo_documento") == "nota_credito":
        lineas = [{"cuenta": l["cuenta"], "debito": l["credito"], "credito": l["debito"]} for l in lineas]
    return lineas


class TestCalculos(unittest.TestCase):
    def test_uvt_y_base(self):
        c = calc(D1)
        self.assertEqual(c["uvt"], 52374)
        self.assertEqual(c["base_minima_pesos"], 523740)

    def test_caso1_compra_normal(self):
        c = calc(D1)
        self.assertTrue(c["determinable"])
        self.assertEqual((c["base_gravable"], c["iva"], c["total_factura"]), (600000, 114000, 714000))
        self.assertEqual(c["retefuente"]["valor"], 15000)       # 2.5% de 600.000
        self.assertEqual(c["retefuente"]["tasa"], 0.025)
        self.assertFalse(c["reteiva"]["aplica"])
        self.assertEqual(c["reteiva"]["valor"], 0)
        self.assertEqual(c["neto_a_pagar"], 699000)

    def test_caso2_bajo_la_base_minima(self):
        c = calc(D2)
        self.assertFalse(c["retefuente"]["aplica"])
        self.assertEqual(c["retefuente"]["valor"], 0)
        self.assertEqual(c["neto_a_pagar"], 357000)

    def test_caso3_gran_contribuyente(self):
        c = calc(D3)
        self.assertEqual(c["retefuente"]["valor"], 25000)       # 2.5% de 1.000.000 (no 4%)
        self.assertTrue(c["reteiva"]["aplica"])
        self.assertEqual(c["reteiva"]["valor"], 28500)          # 15% de 190.000
        self.assertEqual(c["neto_a_pagar"], 1190000 - 25000 - 28500)

    def test_caso4_error_aritmetico_se_rechaza(self):
        pre = rt.prevalidar(D4, HOY)
        self.assertTrue(any("595000" in r for r in pre["rechazos"]), pre["rechazos"])

    def test_caso5_fecha_futura_se_rechaza(self):
        pre = rt.prevalidar(D5, HOY)
        self.assertTrue(any("Fecha futura" in r for r in pre["rechazos"]), pre["rechazos"])

    def test_caso6_sin_nit_se_rechaza(self):
        pre = rt.prevalidar(D6, HOY)
        self.assertTrue(any("NIT" in r for r in pre["rechazos"]), pre["rechazos"])

    def test_caso7_nota_credito_bajo_base(self):
        c = calc(D7)
        self.assertTrue(c["determinable"])
        self.assertEqual(c["retefuente"]["valor"], 0)
        self.assertEqual(c["tipo_documento"], "nota_credito")

    def test_caso8_persona_natural_no_declarante(self):
        c = calc(D8)
        self.assertEqual(c["retefuente"]["tasa"], 0.035)
        self.assertEqual(c["retefuente"]["valor"], 28000)
        self.assertEqual(c["reteiva"]["valor"], 0)
        self.assertEqual(c["neto_a_pagar"], 772000)

    def test_exactamente_en_la_base_minima_retiene(self):
        d = doc("X", items=[{"descripcion": "a", "cantidad": 1, "valor_unitario": 523740}],
                subtotal=523740, iva_19=0, total=523740)
        self.assertEqual(calc(d)["retefuente"]["valor"], 13094)  # 2.5% de 523.740 = 13.093,5 -> half-up
        d2 = dict(d, subtotal=523739, items=[{"descripcion": "a", "cantidad": 1, "valor_unitario": 523739}],
                  total=523739)
        self.assertFalse(calc(d2)["retefuente"]["aplica"])

    def test_servicios_no_se_calculan(self):
        c = calc(D1, concepto="servicios")
        self.assertFalse(c["determinable"])
        self.assertNotIn("retefuente", c)

    def test_sin_perfil_de_comprador_no_es_determinable(self):
        d = dict(D1)
        d.pop("comprador")
        c = calc(d)
        self.assertFalse(c["determinable"])
        self.assertTrue(any("comprador" in a for a in c["advertencias"]))

    def test_persona_natural_sin_dato_de_declarante(self):
        d = dict(D8, proveedor_perfil={"tipo": "persona_natural"})
        c = calc(d)
        self.assertFalse(c["determinable"])

    def test_nit_cedula_no_se_asume_juridica(self):
        d = dict(D8)
        d.pop("proveedor_perfil")
        c = calc(d)                       # NIT de cedula (8 digitos), sin perfil
        self.assertFalse(c["determinable"])

    def test_nota_credito_sobre_base_alta_pide_revision(self):
        d = dict(D1, tipo="nota_credito")
        c = calc(d)
        self.assertFalse(c["determinable"])

    def test_numeros_con_formato(self):
        self.assertEqual(rt.a_numero("714.000"), 714000)
        self.assertEqual(rt.a_numero("$1,190,000"), 1190000)
        self.assertEqual(rt.a_numero("12.5"), rt.Decimal("12.5"))
        self.assertIsNone(rt.a_numero("abc"))
        self.assertIsNone(rt.a_numero(True))


class TestVerificador(unittest.TestCase):
    def test_asiento_correcto_pasa(self):
        for d in (D1, D2, D3, D7, D8):
            c = calc(d)
            self.assertEqual(rt.verificar_asiento(c, {"asiento": asiento_correcto(c)}), [], d["id"])

    def test_asiento_con_tarifa_equivocada_se_detecta(self):
        c = calc(D1)
        malo = asiento_correcto(c)
        malo[2]["credito"] = 21000          # 3.5% en vez de 2.5%
        malo[-1]["credito"] = 693000
        disc = rt.verificar_asiento(c, {"asiento": malo})
        self.assertTrue(any("ReteFuente" in x for x in disc), disc)

    def test_retencion_inexistente_se_detecta(self):
        c = calc(D2)                          # sin retencion oficial
        malo = asiento_correcto(c)
        malo.insert(2, {"cuenta": "2365", "debito": 0, "credito": 7500})
        malo[-1]["credito"] = 349500
        disc = rt.verificar_asiento(c, {"asiento": malo})
        self.assertTrue(disc, disc)

    def test_asiento_que_no_balancea(self):
        c = calc(D1)
        malo = asiento_correcto(c)
        malo[-1]["credito"] += 5000
        self.assertTrue(rt.verificar_asiento(c, {"asiento": malo}))

    def test_asiento_ausente_o_sin_formato(self):
        c = calc(D1)
        self.assertTrue(rt.verificar_asiento(c, {}))
        self.assertTrue(rt.verificar_asiento(c, {"asiento": "texto libre"}))
        self.assertTrue(rt.verificar_asiento(c, {"asiento": [{"cuenta": "x", "debito": "abc", "credito": 0}]}))

    def test_gasto_dividido_en_varias_lineas_es_valido(self):
        c = calc(D1)
        lineas = [{"cuenta": "1435", "debito": 180000, "credito": 0},
                  {"cuenta": "1524", "debito": 420000, "credito": 0},
                  {"cuenta": "2408", "debito": 114000, "credito": 0},
                  {"cuenta": "2365", "debito": 0, "credito": 15000},
                  {"cuenta": "2205", "debito": 0, "credito": 699000}]
        self.assertEqual(rt.verificar_asiento(c, {"asiento": lineas}), [])


class ClienteFalso:
    """Reemplaza al cliente de Anthropic. Responde segun el agente que llama."""

    def __init__(self, doc_original, asiento_fn=None, validador_status="éxito", concepto="bienes"):
        self.llamadas = []
        self.doc = doc_original
        self.asiento_fn = asiento_fn
        self.validador_status = validador_status
        self.concepto = concepto
        self.messages = self

    def create(self, *, model, max_tokens, system, messages):
        # Firma estricta como la libreria instalada: un parametro extra da TypeError
        kw = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
        self.llamadas.append(kw)
        sistema = kw["system"]
        if "Clasificador Contable" in sistema:
            out = {"status": "éxito", "resultado": "Factura de compra de bienes",
                   "detalles": {"tipo_documento": "factura_compra", "concepto": self.concepto},
                   "siguiente_paso": "Validador", "notas_audit": "ok"}
        elif "Validador Normativo" in sistema:
            out = {"status": self.validador_status, "resultado": "Validada", "detalles": {},
                   "siguiente_paso": "Registrador", "notas_audit": "ok"}
        elif "Registrador de Asientos" in sistema:
            calculos = rt.calcular(self.doc, rt.normalizar_tipo(self.doc.get("tipo")), "bienes", HOY)
            if not calculos["determinable"]:
                # Como indica el prompt: sin calculos determinables, el modelo responde "pendiente"
                out = {"status": "pendiente", "resultado": "Faltan datos para el asiento", "detalles": {},
                       "siguiente_paso": "revision humana", "notas_audit": "calculos no determinables"}
            else:
                lineas = self.asiento_fn(calculos) if self.asiento_fn else []
                out = {"status": "éxito", "resultado": "Asiento generado", "detalles": {"asiento": lineas},
                       "siguiente_paso": "Reportero", "notas_audit": "ok"}
        else:
            out = {"status": "éxito", "resultado": "Reporte", "detalles": {}, "siguiente_paso": "fin",
                   "notas_audit": "ok"}
        return SimpleNamespace(content=[SimpleNamespace(text="```json\n" + json.dumps(out) + "\n```")],
                               stop_reason="end_turn")


def correr(doc_, **kw):
    falso = ClienteFalso(doc_, **kw)
    cc.client = falso
    resultado = cc.ContableCrew().process_document(doc_, hoy=HOY)
    return resultado, falso


class TestFlujo(unittest.TestCase):
    def test_caso1_correcto_queda_procesado(self):
        r, f = correr(D1, asiento_fn=asiento_correcto)
        self.assertEqual(r["status"], "procesado", r.get("motivos_revision"))
        self.assertEqual(r["tipo"], "factura_compra")
        self.assertTrue(r["verificacion"]["ok"])
        # Solo los parametros que acepta la libreria instalada (temperature NO: la rechaza)
        self.assertTrue(all(set(l) == {"model", "max_tokens", "system", "messages"} for l in f.llamadas))
        self.assertEqual(len(f.llamadas), 4)

    def test_caso1_con_tarifa_equivocada_requiere_revision(self):
        def malo(c):
            l = asiento_correcto(c)
            l[2]["credito"] = 21000
            l[-1]["credito"] = 693000
            return l
        r, _ = correr(D1, asiento_fn=malo)
        self.assertEqual(r["status"], "requiere_revision")
        self.assertFalse(r["verificacion"]["ok"])
        self.assertTrue(any("ReteFuente" in m for m in r["motivos_revision"]))

    def test_caso3_gran_contribuyente_procesado(self):
        r, _ = correr(D3, asiento_fn=asiento_correcto)
        self.assertEqual(r["status"], "procesado", r.get("motivos_revision"))

    def test_caso4_se_rechaza_sin_llamar_al_modelo(self):
        r, f = correr(D4, asiento_fn=asiento_correcto)
        self.assertEqual(r["status"], "rechazado")
        self.assertEqual(len(f.llamadas), 0)

    def test_caso5_y_6_rechazados_sin_costo(self):
        for d in (D5, D6):
            r, f = correr(d, asiento_fn=asiento_correcto)
            self.assertEqual(r["status"], "rechazado", d["id"])
            self.assertEqual(len(f.llamadas), 0)

    def test_validador_pendiente_requiere_revision(self):
        r, _ = correr(D1, asiento_fn=asiento_correcto, validador_status="pendiente")
        self.assertEqual(r["status"], "requiere_revision")

    def test_concepto_servicios_requiere_revision(self):
        r, _ = correr(D1, asiento_fn=asiento_correcto, concepto="servicios")
        self.assertEqual(r["status"], "requiere_revision")
        self.assertFalse(r["calculos_oficiales"]["determinable"])

    def test_sin_perfil_de_comprador_requiere_revision(self):
        d = dict(D1)
        d.pop("comprador")
        r, _ = correr(d, asiento_fn=asiento_correcto)
        self.assertEqual(r["status"], "requiere_revision")

    def test_asiento_sin_formato_requiere_revision(self):
        r, _ = correr(D1, asiento_fn=lambda c: "texto libre")
        self.assertEqual(r["status"], "requiere_revision")

    def test_clasificacion_no_pisa_datos_originales(self):
        _, f = correr(D1, asiento_fn=asiento_correcto)
        mensaje_validador = [l for l in f.llamadas if "Validador Normativo" in l["system"]][0]["messages"][0]["content"]
        self.assertIn('"comprador": {', mensaje_validador)
        self.assertIn("calculos_oficiales", mensaje_validador)

    def test_prompt_ya_no_trae_tarifas_viejas(self):
        sistema = cc.ContableAgent("X", "y", "z")._build_system_prompt()
        for viejo in ("4% (personas jurídicas)", "8% (personas naturales)", "75% (importaciones)"):
            self.assertNotIn(viejo, sistema)
        self.assertIn("calculos_oficiales", sistema)


if __name__ == "__main__":
    unittest.main(verbosity=2)
