#!/usr/bin/env python3
"""
Reglas tributarias deterministas del Crew Contable (Colombia, vigencia 2026).

Aqui viven TODOS los numeros tributarios. Los agentes (modelos) no calculan
IVA, retenciones ni neto a pagar: reciben estos calculos ya hechos y el
verificador compara el asiento que propongan contra ellos.

Cuando cambie una regla, se cambia en los parametros de abajo y en ningun otro
lugar. Cada parametro lleva su fuente.

Alcance de esta version (v1): compras de BIENES (factura de compra y nota
credito). Servicios, honorarios, arrendamientos, ReteICA, importaciones, etc.
NO estan cubiertos: el calculador responde "no determinable" y el documento
queda en revision humana.
"""

import re
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

VERSION_REGLAS = "2026-10-16"

# --- Parametros vigentes (actualizar aqui y solo aqui) -----------------------
# UVT 2026: Resolucion DIAN 000238 de 2025, art. 1 ($52.374).
UVT_POR_ANIO = {2026: 52374}
# Base minima de retencion en compras: 10 UVT (Decreto 572 de 2025, desde
# junio de 2025; antes 27 UVT). Fuentes secundarias: RSM Colombia y Gerencie.
BASE_MINIMA_COMPRAS_UVT = 10
# Tarifas de retencion en la fuente por compras generales (Gerencie, 2026):
# personas juridicas y naturales declarantes 2.5%; naturales no declarantes 3.5%.
TARIFA_RETEFUENTE_COMPRAS = {"declarante": Decimal("0.025"),
                             "no_declarante": Decimal("0.035")}
# ReteIVA: tarifa general 15% del IVA; solo la practican los agentes de la lista
# cerrada del art. 437-2 E.T. (en v1: gran contribuyente o marca explicita).
TARIFA_RETEIVA = Decimal("0.15")
TASAS_IVA = (Decimal("0"), Decimal("0.05"), Decimal("0.19"))
TOLERANCIA = Decimal("1")  # pesos de diferencia aceptados por redondeo
# -----------------------------------------------------------------------------


def a_numero(valor):
    """Convierte a Decimal. Acepta 714000, 714000.0, '714.000', '$714,000'.
    Devuelve None si no se puede interpretar con certeza."""
    if valor is None or isinstance(valor, bool):
        return None
    if isinstance(valor, (int, float)):
        return Decimal(str(valor))
    s = re.sub(r"[\s$]", "", str(valor))
    if re.fullmatch(r"-?\d{1,3}([.,]\d{3})+", s):
        return Decimal(re.sub(r"[.,]", "", s))
    if re.fullmatch(r"-?\d+([.,]\d+)?", s):
        return Decimal(s.replace(",", "."))
    return None


def redondear(d):
    """Pesos enteros, redondeo half-up."""
    return int(Decimal(d).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def normalizar_tipo(texto):
    """Devuelve 'factura_compra', 'nota_credito' o None (lista cerrada)."""
    if not texto:
        return None
    t = str(texto).lower().replace("_", " ")
    if "nota" in t and "cr" in t:
        return "nota_credito"
    if "factura" in t and "compra" in t:
        return "factura_compra"
    return None


def _fecha(doc):
    f = doc.get("fecha")
    if not f:
        return None
    try:
        return datetime.strptime(str(f)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _iva_declarado(doc):
    for k in ("iva", "iva_19", "iva_5"):
        if k in doc:
            return a_numero(doc[k])
    return Decimal(0)


def prevalidar(doc, hoy=None):
    """Revisiones deterministas que no necesitan modelo.

    Devuelve un dict con:
      rechazos   -> el documento es invalido (fecha futura, sin NIT, no cuadra)
      revisiones -> hay que mirarlo a mano (fecha ilegible, datos no numericos)
      subtotal, iva, total, fecha -> valores ya leidos (Decimal / date) o None
    """
    hoy = hoy or date.today()
    rechazos, revisiones = [], []

    fecha = _fecha(doc)
    if fecha is None:
        revisiones.append("Fecha ausente o ilegible (se espera AAAA-MM-DD)")
    elif fecha > hoy:
        rechazos.append(f"Fecha futura: {fecha.isoformat()} es posterior a hoy ({hoy.isoformat()})")

    if not str(doc.get("nit_proveedor") or "").strip():
        rechazos.append("Falta el NIT del proveedor")

    # Aritmetica del documento
    suma = None
    items = doc.get("items") or []
    if items:
        suma = Decimal(0)
        for i, it in enumerate(items, 1):
            c = a_numero((it or {}).get("cantidad"))
            u = a_numero((it or {}).get("valor_unitario"))
            if c is None or u is None:
                revisiones.append(f"Item {i}: cantidad o valor unitario no numerico")
                suma = None
                break
            suma += c * u

    subtotal = a_numero(doc.get("subtotal")) if "subtotal" in doc else suma
    if "subtotal" in doc and subtotal is None:
        revisiones.append("Subtotal no numerico")
    if suma is not None and subtotal is not None and abs(suma - subtotal) > TOLERANCIA:
        rechazos.append(f"Los items suman {redondear(suma)} pero el subtotal declarado es {redondear(subtotal)}")

    iva = _iva_declarado(doc)
    if iva is None:
        revisiones.append("IVA no numerico")
    elif subtotal is not None and iva != 0:
        if not any(abs((subtotal * t).quantize(Decimal(1), rounding=ROUND_HALF_UP) - iva) <= TOLERANCIA
                   for t in TASAS_IVA):
            rechazos.append(f"El IVA declarado ({redondear(iva)}) no corresponde a 0%, 5% ni 19% del subtotal ({redondear(subtotal)})")

    total = a_numero(doc.get("total")) if "total" in doc else None
    if "total" in doc and total is None:
        revisiones.append("Total no numerico")
    if subtotal is not None and iva is not None and total is not None:
        esperado = subtotal + iva
        if abs(total - esperado) > TOLERANCIA:
            rechazos.append(f"El total declarado es {redondear(total)} pero subtotal + IVA = {redondear(esperado)}")
    if total is None and subtotal is not None and iva is not None and "total" not in doc:
        total = subtotal + iva

    return {"rechazos": rechazos, "revisiones": revisiones,
            "subtotal": subtotal, "iva": iva, "total": total, "fecha": fecha}


def _tipo_proveedor_por_nit(nit):
    """Heuristica de respaldo: NIT de 9 digitos que empieza por 8 o 9 = persona
    juridica. Si el documento trae proveedor_perfil.tipo, ese valor manda."""
    digitos = re.sub(r"\D", "", str(nit or "").split("-")[0])
    if len(digitos) == 9 and digitos[0] in "89":
        return "persona_juridica"
    return None


def calcular(doc, tipo, concepto, hoy=None):
    """Calculo oficial de IVA, retenciones y neto a pagar (compras de bienes).

    Devuelve un dict serializable. Si falta informacion para decidir con
    certeza, 'determinable' es False y 'advertencias' dice que falta; en ese
    caso NO se calculan retenciones (el documento queda en revision)."""
    pre = prevalidar(doc, hoy)
    adv = []
    r = {"version_reglas": VERSION_REGLAS, "tipo_documento": tipo,
         "concepto": concepto, "determinable": True, "advertencias": adv}

    base, iva, total, fecha = pre["subtotal"], pre["iva"], pre["total"], pre["fecha"]
    if base is None or iva is None or total is None:
        adv.append("No se pudieron leer subtotal, IVA y total del documento")
    else:
        r.update(base_gravable=redondear(base), iva=redondear(iva), total_factura=redondear(total))
    if fecha is None:
        adv.append("Sin fecha valida no se puede fijar la UVT del anio")
    elif fecha.year not in UVT_POR_ANIO:
        adv.append(f"No hay UVT cargada para {fecha.year}")
    if tipo not in ("factura_compra", "nota_credito"):
        adv.append(f"Tipo de documento '{tipo}' no cubierto por el calculador (solo factura de compra y nota credito)")
    if concepto != "bienes":
        adv.append(f"Concepto '{concepto}' no cubierto: v1 solo calcula compras de bienes")

    comp = doc.get("comprador") if isinstance(doc.get("comprador"), dict) else {}
    retenedor = comp.get("agente_retenedor_renta")
    gran = comp.get("gran_contribuyente")
    if not isinstance(retenedor, bool) or not isinstance(gran, bool):
        adv.append("Falta el perfil tributario del comprador (comprador.agente_retenedor_renta y comprador.gran_contribuyente, ambos verdadero/falso)")

    if adv:
        r["determinable"] = False
        return r

    uvt = UVT_POR_ANIO[fecha.year]
    minimo = Decimal(BASE_MINIMA_COMPRAS_UVT * uvt)
    r["uvt"] = uvt
    r["base_minima_pesos"] = int(minimo)
    agente_iva = gran or bool(comp.get("agente_reteiva"))
    supera_base = base >= minimo

    if tipo == "nota_credito" and supera_base and (retenedor or agente_iva):
        adv.append("Nota credito sobre una base que supera el minimo: la retencion solo se reversa si se practico en la factura original; hay que verificarla")
        r["determinable"] = False
        return r

    # ReteFuente
    rf = {"aplica": False, "tasa": None, "valor": 0, "razon": ""}
    if not retenedor:
        rf["razon"] = "El comprador no es agente retenedor de renta"
    elif not supera_base:
        rf["razon"] = f"Base {redondear(base)} menor a la base minima {int(minimo)} ({BASE_MINIMA_COMPRAS_UVT} UVT)"
    else:
        perfil = doc.get("proveedor_perfil") if isinstance(doc.get("proveedor_perfil"), dict) else {}
        tipo_prov = perfil.get("tipo") or _tipo_proveedor_por_nit(doc.get("nit_proveedor"))
        clave = None
        if tipo_prov == "persona_juridica":
            clave = "declarante"
        elif tipo_prov == "persona_natural":
            declarante = perfil.get("declarante_renta")
            if isinstance(declarante, bool):
                clave = "declarante" if declarante else "no_declarante"
            else:
                adv.append("No se sabe si el proveedor persona natural es declarante de renta (proveedor_perfil.declarante_renta)")
        else:
            adv.append("No se pudo determinar si el proveedor es persona juridica o natural (proveedor_perfil.tipo)")
        if clave:
            tasa = TARIFA_RETEFUENTE_COMPRAS[clave]
            rf = {"aplica": True, "tasa": float(tasa), "valor": redondear(base * tasa),
                  "razon": f"Compra de bienes, proveedor {tipo_prov} ({'declarante' if clave == 'declarante' else 'no declarante'}), {float(tasa) * 100:g}% sobre la base sin IVA"}

    # ReteIVA
    ri = {"aplica": False, "tasa": None, "valor": 0, "razon": ""}
    if not agente_iva:
        ri["razon"] = "El comprador no es agente de retencion de IVA"
    elif iva == 0:
        ri["razon"] = "La operacion no causa IVA"
    elif not supera_base:
        ri["razon"] = f"Base {redondear(base)} menor a la base minima {int(minimo)}"
    else:
        ri = {"aplica": True, "tasa": float(TARIFA_RETEIVA), "valor": redondear(iva * TARIFA_RETEIVA),
              "razon": "Comprador agente de retencion de IVA: 15% del IVA"}

    if adv:
        r["determinable"] = False
        return r

    r["retefuente"], r["reteiva"] = rf, ri
    r["neto_a_pagar"] = redondear(total) - rf["valor"] - ri["valor"]
    r["naturaleza"] = "inversa (nota credito)" if tipo == "nota_credito" else "normal"
    return r


def _quitar(lista, valor):
    """Quita de la lista la primera linea que coincida con valor (tolerancia)."""
    for i, v in enumerate(lista):
        if abs(v - valor) <= TOLERANCIA:
            del lista[i]
            return True
    return False


def verificar_asiento(calculos, detalles):
    """Compara el asiento propuesto por el modelo con el calculo oficial.

    Se espera detalles['asiento'] = [{'cuenta': str, 'debito': n, 'credito': n}, ...]
    Devuelve la lista de discrepancias (vacia = coincide)."""
    lineas = detalles.get("asiento") if isinstance(detalles, dict) else None
    if not isinstance(lineas, list) or not lineas:
        return ["El asiento no viene como lista 'asiento' con lineas {cuenta, debito, credito}"]

    disc, deb, cre = [], [], []
    for i, l in enumerate(lineas, 1):
        if not isinstance(l, dict):
            disc.append(f"La linea {i} del asiento no es un objeto")
            continue
        d, c = l.get("debito"), l.get("credito")
        dn = Decimal(0) if d in (None, "", 0) else a_numero(d)
        cn = Decimal(0) if c in (None, "", 0) else a_numero(c)
        if dn is None or cn is None:
            disc.append(f"La linea {i} tiene un valor no numerico")
            continue
        if dn > 0 and cn > 0:
            disc.append(f"La linea {i} tiene debito y credito a la vez")
        if dn > 0:
            deb.append(dn)
        if cn > 0:
            cre.append(cn)
    if disc:
        return disc

    suma_d, suma_c = sum(deb, Decimal(0)), sum(cre, Decimal(0))
    if abs(suma_d - suma_c) > TOLERANCIA:
        disc.append(f"El asiento no balancea: debitos {redondear(suma_d)} y creditos {redondear(suma_c)}")

    base, iva = Decimal(calculos["base_gravable"]), Decimal(calculos["iva"])
    rf, ri = Decimal(calculos["retefuente"]["valor"]), Decimal(calculos["reteiva"]["valor"])
    neto = Decimal(calculos["neto_a_pagar"])
    inversa = calculos.get("tipo_documento") == "nota_credito"
    lado_base, lado_pago = (cre, deb) if inversa else (deb, cre)
    nombre_base, nombre_pago = ("creditos", "debitos") if inversa else ("debitos", "creditos")

    lado_base = list(lado_base)
    if iva > 0 and not _quitar(lado_base, iva):
        disc.append(f"No hay una linea de IVA por {redondear(iva)} en los {nombre_base}")
    suma_resto = sum(lado_base, Decimal(0))
    if abs(suma_resto - base) > TOLERANCIA:
        disc.append(f"Sin el IVA, los {nombre_base} suman {redondear(suma_resto)} y la base oficial es {redondear(base)}")

    lado_pago = list(lado_pago)
    if calculos["retefuente"]["aplica"] and not _quitar(lado_pago, rf):
        disc.append(f"No hay una linea de ReteFuente por {redondear(rf)} en los {nombre_pago}")
    if calculos["reteiva"]["aplica"] and not _quitar(lado_pago, ri):
        disc.append(f"No hay una linea de ReteIVA por {redondear(ri)} en los {nombre_pago}")
    # Lo que queda en este lado debe ser UNA sola linea por el neto a pagar.
    # Asi se detecta una retencion inventada que el modelo resta de proveedores.
    if len(lado_pago) != 1:
        disc.append(f"Descontadas las lineas oficiales de retencion, los {nombre_pago} deberian quedar en una sola linea por el neto a pagar ({redondear(neto)}), pero quedan {len(lado_pago)}: {[redondear(v) for v in lado_pago]}")
    elif abs(lado_pago[0] - neto) > TOLERANCIA:
        disc.append(f"El neto a pagar del asiento es {redondear(lado_pago[0])} y el oficial es {redondear(neto)}")
    return disc
