#!/usr/bin/env python3
"""
Lector determinista de facturas electronicas DIAN (UBL 2.1) para el Crew Contable.

Convierte el XML de una factura (Invoice), nota credito (CreditNote) o el sobre
AttachedDocument que las contiene, en el 'documento' (JSON) que recibe el crew.
No usa modelos: lee campos, no interpreta. Todo corre local.

Uso:
    python3 crews/xml_dian.py CARPETA_XML CARPETA_SALIDA --comprador-retenedor si
        [--comprador-gran-contribuyente si|no] [--sin-anonimizar]

Por defecto ANONIMIZA: reemplaza nombres, NIT y numero de factura por valores
falsos estables (el mismo NIT original da siempre el mismo NIT falso). La
equivalencia queda solo en CARPETA_SALIDA/indice_local.csv, en tu equipo.
Las descripciones de los items se conservan (el crew las necesita para clasificar):
revisa los JSON antes de procesarlos.
"""

import argparse
import csv
import hashlib
import json
import os
import sys
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation


# ---------- utilidades de navegacion (ignoran los prefijos de espacio de nombres) ----------

def _ln(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _hijos(el, nombre):
    return [c for c in el if _ln(c.tag) == nombre] if el is not None else []


def _hijo(el, *ruta):
    """Baja por hijos directos siguiendo los nombres de la ruta. None si no existe."""
    for nombre in ruta:
        hs = _hijos(el, nombre)
        if not hs:
            return None
        el = hs[0]
    return el


def _texto(el):
    return (el.text or "").strip() if el is not None else ""


def _dec(txt):
    try:
        return Decimal(str(txt).strip())
    except (InvalidOperation, ValueError):
        return None


def _num(d):
    """Decimal -> int si es entero, si no float con 2 decimales."""
    if d is None:
        return None
    return int(d) if d == d.to_integral_value() else float(round(d, 2))


# ---------- carga ----------

def cargar_xml(ruta):
    """Devuelve la raiz Invoice/CreditNote/DebitNote, abriendo el sobre AttachedDocument si hace falta."""
    raiz = ET.parse(ruta).getroot()
    if _ln(raiz.tag) != "AttachedDocument":
        return raiz
    for e in raiz.iter():
        if _ln(e.tag) == "Description" and e.text and ("<Invoice" in e.text or "<CreditNote" in e.text
                                                       or "<DebitNote" in e.text):
            return ET.fromstring(e.text.strip().encode("utf-8"))
    raise ValueError("El sobre AttachedDocument no trae una factura embebida")


# ---------- partes ----------

def _parte(wrapper):
    party = _hijo(wrapper, "Party")
    pts = _hijo(party, "PartyTaxScheme")
    ple = _hijo(party, "PartyLegalEntity")
    nombre = (_texto(_hijo(pts, "RegistrationName")) or _texto(_hijo(ple, "RegistrationName"))
              or _texto(_hijo(party, "PartyName", "Name")))
    company = _hijo(pts, "CompanyID") if _hijo(pts, "CompanyID") is not None else _hijo(ple, "CompanyID")
    nit = _texto(company)
    dv = company.get("schemeID", "") if company is not None else ""
    niveles = [x.strip().upper() for x in _texto(_hijo(pts, "TaxLevelCode")).replace(",", ";").split(";")
               if x.strip()]
    tipo_cod = _texto(_hijo(wrapper, "AdditionalAccountID"))
    tipo = {"1": "persona_juridica", "2": "persona_natural"}.get(tipo_cod)
    return {"nombre": nombre, "nit": nit, "dv": dv, "niveles": niveles, "tipo": tipo}


# ---------- lectura de una factura ----------

def leer_factura(ruta):
    """Lee un XML y devuelve (datos_crudos, advertencias)."""
    raiz = cargar_xml(ruta)
    tipo_raiz = _ln(raiz.tag)
    adv = []
    if tipo_raiz == "DebitNote":
        raise ValueError("Las notas debito no estan soportadas en v1")
    if tipo_raiz not in ("Invoice", "CreditNote"):
        raise ValueError(f"Documento XML no reconocido: {tipo_raiz}")

    proveedor = _parte(_hijo(raiz, "AccountingSupplierParty"))
    cliente = _parte(_hijo(raiz, "AccountingCustomerParty"))

    # Impuestos del documento
    iva, iva_tarifa, otros = Decimal(0), None, {}
    for tt in _hijos(raiz, "TaxTotal"):
        for st in _hijos(tt, "TaxSubtotal"):
            esquema = _texto(_hijo(st, "TaxCategory", "TaxScheme", "ID"))
            monto = _dec(_texto(_hijo(st, "TaxAmount"))) or Decimal(0)
            if esquema == "01":
                iva += monto
                p = _dec(_texto(_hijo(st, "TaxCategory", "Percent")))
                iva_tarifa = p if p is not None else iva_tarifa
            elif monto != 0:
                otros[esquema or "?"] = otros.get(esquema or "?", Decimal(0)) + monto
    if otros:
        adv.append(f"Tiene otros impuestos distintos del IVA (esquemas {sorted(otros)}): v1 no los soporta")
    if _hijos(raiz, "WithholdingTaxTotal"):
        adv.append("El XML trae retenciones (WithholdingTaxTotal): v1 no las usa, se calculan con las reglas")

    lmt = _hijo(raiz, "LegalMonetaryTotal")
    # TaxExclusiveAmount es la BASE GRAVABLE (puede ser 0 en facturas sin impuestos), no el subtotal.
    # Subtotal = suma de lineas - descuentos globales + cargos globales.
    suma_lineas = _dec(_texto(_hijo(lmt, "LineExtensionAmount")))
    base_gravable = _dec(_texto(_hijo(lmt, "TaxExclusiveAmount")))
    descuento = _dec(_texto(_hijo(lmt, "AllowanceTotalAmount"))) or Decimal(0)
    cargo = _dec(_texto(_hijo(lmt, "ChargeTotalAmount"))) or Decimal(0)
    total = _dec(_texto(_hijo(lmt, "TaxInclusiveAmount")))
    pagable = _dec(_texto(_hijo(lmt, "PayableAmount")))
    if total is None:
        total = pagable
    subtotal = (suma_lineas - descuento + cargo) if suma_lineas is not None else base_gravable
    if descuento != 0 or cargo != 0:
        adv.append("Hay descuentos o cargos globales (AllowanceTotalAmount/ChargeTotalAmount): revisar")
    if subtotal is not None and total is not None and abs(subtotal + iva + sum(otros.values(), Decimal(0)) - total) > Decimal(1):
        adv.append("Subtotal + impuestos no coincide con el total del XML: revisar")

    # Lineas
    nombre_linea = "InvoiceLine" if tipo_raiz == "Invoice" else "CreditNoteLine"
    cant_tag = "InvoicedQuantity" if tipo_raiz == "Invoice" else "CreditedQuantity"
    items = []
    for ln in _hijos(raiz, nombre_linea):
        cant = _dec(_texto(_hijo(ln, cant_tag))) or Decimal(1)
        ext = _dec(_texto(_hijo(ln, "LineExtensionAmount"))) or Decimal(0)
        precio = _dec(_texto(_hijo(ln, "Price", "PriceAmount")))
        base_q = _dec(_texto(_hijo(ln, "Price", "BaseQuantity"))) or Decimal(1)
        unit = precio / base_q if precio is not None else None
        if unit is None or abs(cant * unit - ext) > Decimal(1):
            unit = (ext / cant) if cant != 0 else ext   # neto de descuentos de linea
        desc = (_texto(_hijo(ln, "Item", "Description")) or _texto(_hijo(ln, "Item", "Name")))
        items.append({"descripcion": desc, "cantidad": _num(cant), "valor_unitario": _num(unit.quantize(Decimal("0.01")))})

    fecha = _texto(_hijo(raiz, "IssueDate"))
    moneda = _texto(_hijo(raiz, "DocumentCurrencyCode")) or "COP"
    if moneda != "COP":
        adv.append(f"Moneda {moneda}: v1 solo calcula en COP")

    return {
        "tipo": "nota_credito" if tipo_raiz == "CreditNote" else "factura_compra",
        "numero": _texto(_hijo(raiz, "ID")),
        "fecha": fecha, "moneda": moneda,
        "proveedor": proveedor, "cliente": cliente,
        "items": items, "subtotal": subtotal, "iva": iva, "iva_tarifa": iva_tarifa,
        "total": total,
    }, adv


# ---------- anonimizacion ----------

def _h(texto):
    return int(hashlib.sha256(texto.encode("utf-8")).hexdigest(), 16)


def _nit_falso(nit, tipo):
    n = _h("nit:" + nit)
    if tipo == "persona_natural":
        return "1" + str(n % 10**9).zfill(9)                 # parece cedula de 10 digitos
    return "9" + str(n % 10**8).zfill(8) + "-0"             # parece NIT de 9 digitos


def _nombre_falso(nit, tipo):
    n = _h("nombre:" + nit) % 10000
    return f"Persona Natural {n:04d}" if tipo == "persona_natural" else f"Proveedor {n:04d} S.A.S."


# ---------- conversion ----------

def a_documento(crudo, comprador_retenedor, id_doc, anonimizar=True, gran_contribuyente=None):
    prov, cli = crudo["proveedor"], crudo["cliente"]
    gran = ("O-13" in cli["niveles"]) if gran_contribuyente is None else gran_contribuyente
    comprador = {"agente_retenedor_renta": comprador_retenedor, "gran_contribuyente": gran,
                 "regimen": "ordinario"}
    if "O-23" in cli["niveles"]:
        comprador["agente_reteiva"] = True
    if anonimizar:
        comprador.update(razon_social="Oficina Demo S.A.S.", nit="901000111-2")
        nombre_prov = _nombre_falso(prov["nit"], prov["tipo"])
        nit_prov = _nit_falso(prov["nit"], prov["tipo"])
    else:
        comprador.update(razon_social=cli["nombre"], nit=(cli["nit"] + ("-" + cli["dv"] if cli["dv"] else "")))
        nombre_prov = prov["nombre"]
        nit_prov = prov["nit"] + ("-" + prov["dv"] if prov["dv"] else "")

    perfil = {"tipo": prov["tipo"]} if prov["tipo"] else {}
    if "O-15" in prov["niveles"]:
        perfil["autorretenedor"] = True
    if "O-47" in prov["niveles"]:
        perfil["regimen_simple"] = True

    doc = {"id": id_doc, "tipo": crudo["tipo"], "fecha": crudo["fecha"], "moneda": crudo["moneda"],
           "comprador": comprador, "proveedor": nombre_prov, "nit_proveedor": nit_prov,
           "items": crudo["items"], "subtotal": _num(crudo["subtotal"]),
           "iva": _num(crudo["iva"]), "total": _num(crudo["total"])}
    if perfil:
        doc["proveedor_perfil"] = perfil
    if crudo["tipo"] == "nota_credito":
        doc["referencia"] = "factura-original-anonimizada" if anonimizar else crudo["numero"]
    return doc


def convertir_carpeta(carpeta_xml, carpeta_salida, comprador_retenedor, anonimizar=True,
                      gran_contribuyente=None):
    os.makedirs(carpeta_salida, exist_ok=True)
    archivos = sorted(f for f in os.listdir(carpeta_xml) if f.lower().endswith(".xml"))
    filas, ok = [], 0
    for i, nombre in enumerate(archivos, 1):
        id_doc = f"REAL-{i:03d}"
        try:
            crudo, adv = leer_factura(os.path.join(carpeta_xml, nombre))
            doc = a_documento(crudo, comprador_retenedor, id_doc, anonimizar, gran_contribuyente)
        except Exception as e:  # un XML danado no detiene el resto
            print(f"[{id_doc}] {nombre}: NO SE PUDO LEER ({e})")
            filas.append([id_doc, nombre, "error", str(e)])
            continue
        with open(os.path.join(carpeta_salida, id_doc + ".json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        ok += 1
        extra = ("  | AVISOS: " + "; ".join(adv)) if adv else ""
        print(f"[{id_doc}] {doc['tipo']} | {doc['fecha']} | subtotal {doc['subtotal']} | IVA {doc['iva']} "
              f"| total {doc['total']} | {len(doc['items'])} items{extra}")
        filas.append([id_doc, nombre, "ok", "; ".join(adv)])
    with open(os.path.join(carpeta_salida, "indice_local.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "archivo_original", "resultado", "avisos"])
        w.writerows(filas)
    print(f"\n{ok} de {len(archivos)} XML convertidos. Indice (solo local): {os.path.join(carpeta_salida, 'indice_local.csv')}")
    return ok


def main():
    ap = argparse.ArgumentParser(description="XML de factura electronica DIAN -> documento del Crew Contable")
    ap.add_argument("carpeta_xml")
    ap.add_argument("carpeta_salida")
    ap.add_argument("--comprador-retenedor", choices=["si", "no"], required=True,
                    help="La oficina compradora es agente retenedor de renta? (no sale del XML)")
    ap.add_argument("--comprador-gran-contribuyente", choices=["si", "no"],
                    help="Por defecto se deduce del XML (codigo O-13 del comprador)")
    ap.add_argument("--sin-anonimizar", action="store_true")
    a = ap.parse_args()
    gran = None if a.comprador_gran_contribuyente is None else a.comprador_gran_contribuyente == "si"
    convertir_carpeta(a.carpeta_xml, a.carpeta_salida, a.comprador_retenedor == "si",
                      not a.sin_anonimizar, gran)


if __name__ == "__main__":
    main()
