// Procesamiento por reglas fijas (Spec v1): sin IA, sin calcular impuestos ni retenciones.
// Toma el documento ya leído (XML o PDF), revisa lo básico y sugiere el asiento con cuentas del PUC por defecto.
// El resultado tiene la misma forma que el del Crew, para que se guarde igual. El Crew queda para la fase 2
// y se activa solo con PULPO_USAR_CREW=1.

export const VERSION_REGLAS = 'reglas-fijas-v1';
const TOLERANCIA = 1; // pesos por redondeo

// Cuentas por defecto: son una sugerencia que la persona corrige al revisar (la tabla real llega con el PUC de la oficina).
const CUENTAS = {
  gasto: '5195 — Gastos diversos (cuenta por defecto)',
  ivaDescontable: '240810 — IVA descontable',
  proveedores: '220505 — Proveedores nacionales',
  clientes: '130505 — Clientes nacionales',
  ingresos: '413595 — Ingresos por ventas (cuenta por defecto)',
  ivaGenerado: '240805 — IVA generado',
};

const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LineaAsiento { cuenta: string; debito: number; credito: number }

export function procesarPorReglas(doc: Record<string, any>, rol: 'comprador' | 'vendedor', hoyIso: string): Record<string, any> {
  const motivos: string[] = [];
  const esNota = doc.tipo === 'nota_credito';

  if (!String(doc.nit_proveedor ?? '').trim()) motivos.push('Falta el NIT del proveedor');
  const fecha = String(doc.fecha ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) motivos.push('Falta la fecha o no se pudo leer (se espera AAAA-MM-DD)');
  else if (fecha > hoyIso) motivos.push(`La fecha del documento parece incorrecta: ${fecha} es posterior a hoy`);

  const subtotal = numero(doc.subtotal);
  const total = numero(doc.total);
  const iva = doc.iva === undefined || doc.iva === null ? 0 : numero(doc.iva);
  if (subtotal === null) motivos.push('Falta el subtotal');
  if (total === null) motivos.push('Falta el total');
  if (iva === null) motivos.push('El IVA no es un número');

  let cuadra = false;
  if (subtotal !== null && total !== null && iva !== null) {
    if (Math.abs(subtotal + iva - total) > TOLERANCIA) motivos.push('Subtotal más impuestos no coincide con el total');
    else cuadra = true;
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  if (subtotal !== null && items.length) {
    let suma = 0, ok = true;
    for (const it of items) {
      const c = numero(it?.cantidad), u = numero(it?.valor_unitario);
      if (c === null || u === null) { ok = false; break; }
      suma += c * u;
    }
    // Los precios unitarios pueden venir sin IVA (suman el subtotal) o con IVA incluido (suman el total), como en el comercio minorista.
    const cuadraSub = Math.abs(suma - subtotal) <= TOLERANCIA;
    const cuadraTotal = total !== null && Math.abs(suma - total) <= TOLERANCIA;
    if (ok && !cuadraSub && !cuadraTotal) motivos.push(`Los ítems suman ${Math.round(suma)} pero el subtotal es ${Math.round(subtotal)}`);
  }

  // Asiento: solo si las cifras cuadran, y siempre balanceado. En una nota crédito se invierten débitos y créditos.
  let asiento: LineaAsiento[] | null = null;
  if (cuadra && subtotal !== null && iva !== null) {
    const base = subtotal, impuesto = iva, contra = subtotal + iva;
    const l = (cuenta: string, debito: number, credito: number): LineaAsiento => (esNota ? { cuenta, debito: credito, credito: debito } : { cuenta, debito, credito });
    asiento = rol === 'vendedor'
      ? [l(CUENTAS.clientes, contra, 0), l(CUENTAS.ingresos, 0, base), ...(impuesto > 0 ? [l(CUENTAS.ivaGenerado, 0, impuesto)] : [])]
      : [l(CUENTAS.gasto, base, 0), ...(impuesto > 0 ? [l(CUENTAS.ivaDescontable, impuesto, 0)] : []), l(CUENTAS.proveedores, 0, contra)];
  }

  return {
    status: motivos.length ? 'requiere_revision' : 'procesado',
    documento_id: doc.id,
    tipo: doc.tipo ?? 'factura_compra',
    motivos_revision: motivos,
    calculos_oficiales: { determinable: false, tipo_documento: doc.tipo ?? null, base_gravable: subtotal, iva, total_factura: total, version_reglas: VERSION_REGLAS },
    asientos: { status: 'éxito', detalles: { asiento, origen: 'regla fija (cuentas por defecto, para revisión)' } },
    timestamp: new Date().toISOString(),
  };
}
