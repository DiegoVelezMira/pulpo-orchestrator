import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { nitBase } from './clientes';

// Lectura de facturas en PDF. El texto se saca en el servidor (pdftotext) y las reglas locales leen lo que
// se puede leer sin IA (CUFE). A la IA solo viaja el texto, nunca el PDF. Todo lo que la IA devuelve se
// contrasta contra el texto del PDF antes de aceptarlo.

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MIN_CARACTERES = 80; // por debajo se considera PDF escaneado (sin texto seleccionable)

export const huellaPdf = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function extraerTexto(pdf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('pdftotext', ['-layout', '-q', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const limite = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('pdftotext superó los 30 s')); }, 30_000);
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.on('error', (e) => { clearTimeout(limite); reject(new Error(`No se pudo ejecutar pdftotext: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(limite);
      // Un PDF dañado no es un error del servidor: se trata como "sin texto" y queda para una persona.
      resolve(code === 0 ? out : '');
    });
    p.stdin.on('error', () => {});
    p.stdin.end(pdf);
  });
}

export const tieneTexto = (t: string) => t.replace(/\s+/g, '').length >= MIN_CARACTERES;

// El CUFE (96 hex) suele partirse en varias líneas: se busca sobre el texto sin espacios.
export function cufeLocal(texto: string): string | null {
  const m = texto.replace(/\s+/g, '').toLowerCase().match(/[0-9a-f]{96}/);
  return m ? m[0] : null;
}

// Cifras como aparecen en el texto: 1.234.567,89 / 1,234,567.89 / 1234567.
export function cifrasDelTexto(texto: string): number[] {
  const out: number[] = [];
  for (const m of texto.matchAll(/\d[\d.,]*\d|\d/g)) {
    let s = m[0];
    const ult = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (ult >= 0 && s.length - ult - 1 <= 2 && s.length - ult - 1 >= 1) {
      const ent = s.slice(0, ult).replace(/[.,]/g, '');
      out.push(Number(`${ent}.${s.slice(ult + 1)}`));
      out.push(Number(s.replace(/[.,]/g, ''))); // por si el último grupo era de miles
    } else {
      out.push(Number(s.replace(/[.,]/g, '')));
    }
  }
  return out.filter((n) => Number.isFinite(n));
}

export const TOLERANCIA_PESOS = 5;
const cerca = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA_PESOS;

export function nitsDelTexto(texto: string): Set<string> {
  const s = new Set<string>();
  for (const m of texto.matchAll(/\b(\d{1,3}(?:[.\s]?\d{3}){2,3})\s?-?\s?(\d)?\b/g)) {
    const base = nitBase(m[1].replace(/[.\s]/g, ''));
    if (base.length >= 6) s.add(base);
  }
  for (const m of texto.matchAll(/\b\d{6,10}\b/g)) s.add(nitBase(m[0]));
  return s;
}

export type Hallazgo = { campo: string; mensaje: string };

// Contrasta lo que devolvió la IA con el texto del PDF y con las reglas locales.
export function contrastar(texto: string, ia: Record<string, any>, cufe: string | null): Hallazgo[] {
  const h: Hallazgo[] = [];
  const cifras = cifrasDelTexto(texto);
  const esta = (v: unknown) => typeof v === 'number' && cifras.some((c) => cerca(c, v));

  if (cufe && ia.cufe && String(ia.cufe).replace(/\s+/g, '').toLowerCase() !== cufe) {
    h.push({ campo: 'cufe', mensaje: 'El CUFE que devolvió la IA no coincide con el del texto del PDF' });
  }
  const nits = nitsDelTexto(texto);
  for (const [campo, etiqueta] of [['comprador_nit', 'del comprador'], ['emisor_nit', 'del emisor']] as const) {
    const v = ia[campo] ? nitBase(String(ia[campo])) : '';
    if (!v) h.push({ campo, mensaje: `No se leyó el NIT ${etiqueta}` });
    else if (!nits.has(v)) h.push({ campo, mensaje: `El NIT ${etiqueta} (${ia[campo]}) no aparece en el texto del PDF` });
  }
  for (const campo of ['subtotal', 'iva', 'total'] as const) {
    const v = ia[campo];
    if (typeof v !== 'number') { if (campo !== 'iva') h.push({ campo, mensaje: `No se leyó el ${campo}` }); continue; }
    if (v !== 0 && !esta(v)) {
      // Muchas facturas solo imprimen el "total a pagar" (ya con retenciones): el total es entonces subtotal + IVA
      // y se acepta si total - retenciones = total a pagar impreso.
      const ret = typeof ia.retenciones === 'number' ? ia.retenciones : 0;
      const viaNeto = campo === 'total' && typeof ia.total_a_pagar === 'number' && esta(ia.total_a_pagar) && cerca(v - ret, ia.total_a_pagar);
      if (!viaNeto) h.push({ campo, mensaje: `El ${campo} (${v}) no aparece en el texto del PDF` });
    }
  }
  if (typeof ia.subtotal === 'number' && typeof ia.total === 'number') {
    const iva = typeof ia.iva === 'number' ? ia.iva : 0;
    const otros = typeof ia.otros_cargos === 'number' ? ia.otros_cargos : 0;
    const desc = ia.subtotal + iva + otros;
    // El total puede incluir cargos que no son IVA (impoconsumo, propina, donación); solo se avisa.
    if (!cerca(desc, ia.total)) {
      h.push({ campo: 'total', mensaje: `Subtotal + IVA (${desc}) no cuadra con el total (${ia.total}); revisa cargos adicionales` });
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ia.fecha_emision ?? ''))) {
    h.push({ campo: 'fecha_emision', mensaje: 'No se leyó la fecha de emisión' });
  }
  if (!ia.numero) h.push({ campo: 'numero', mensaje: 'No se leyó el número de la factura' });
  return h;
}

// Alertas que la regla (no la IA) detecta sobre fechas. Se comparan fechas ISO como texto.
export function alertasDeFechas(ia: Record<string, any>, hoyIso: string): string[] {
  const a: string[] = [];
  const e = String(ia.fecha_emision ?? '');
  const ap = String(ia.fecha_aprobacion ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(e) && e > hoyIso) a.push(`La fecha de emisión (${e}) es futura`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ap) && /^\d{4}-\d{2}-\d{2}$/.test(e) && ap < e) {
    a.push(`La fecha de aprobación (${ap}) es anterior a la de emisión (${e})`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(ap) && ap > hoyIso) a.push(`La fecha de aprobación (${ap}) es futura`);
  return a;
}

// Respuesta de la IA -> documento del crew (misma forma que produce el lector de XML).
export function aDocumento(ia: Record<string, any>): Record<string, any> {
  const nitEmisor = String(ia.emisor_nit ?? '').replace(/[^A-Za-z0-9-]/g, '');
  const numero = String(ia.numero ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  const base = nitBase(nitEmisor);
  const nota = String(ia.tipo ?? '') === 'nota_credito';
  const id = nota ? `NC-${numero}_${base}` : `${numero}_${base}`;
  const items = (Array.isArray(ia.lineas) ? ia.lineas : []).map((l: any) => ({
    descripcion: String(l?.descripcion ?? '').slice(0, 300),
    cantidad: typeof l?.cantidad === 'number' ? l.cantidad : 1,
    valor_unitario: typeof l?.precio_unitario === 'number' ? l.precio_unitario : (typeof l?.valor === 'number' ? l.valor : 0),
  }));
  return {
    id,
    tipo: nota ? 'nota_credito' : 'factura_compra',
    fecha: ia.fecha_emision,
    moneda: ia.moneda || 'COP',
    comprador: { razon_social: ia.comprador_nombre ?? null, nit: ia.comprador_nit ?? null, regimen: 'ordinario' },
    proveedor: ia.emisor_nombre ?? null,
    nit_proveedor: nitEmisor,
    items,
    subtotal: ia.subtotal,
    iva: typeof ia.iva === 'number' ? ia.iva : 0,
    total: ia.total,
    cufe: ia.cufe ?? null,
    origen_lectura: 'pdf_ia',
  };
}
