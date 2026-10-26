// Llamada a la IA que lee el TEXTO de una factura (nunca el PDF). Se puede reemplazar en las pruebas.

export interface LecturaIa {
  json: Record<string, any>;
  tokens_in: number;
  tokens_out: number;
  modelo: string;
}
export type LectorIa = (texto: string) => Promise<LecturaIa>;

export const PROMPT_LECTOR = `Eres lector de facturas electrónicas colombianas. Del texto, devuelve SOLO un JSON con:
tipo (factura|nota_credito|tiquete_pos|cuenta_cobro|otro), numero, fecha_emision (YYYY-MM-DD), fecha_aprobacion (YYYY-MM-DD o null),
emisor_nit, emisor_nombre, comprador_nit, comprador_nombre, cufe, subtotal, iva, otros_cargos (impoconsumo, propina, donación u otros que no sean IVA ni retenciones; 0 si no hay), retenciones, total, total_a_pagar,
moneda, lineas (lista de {descripcion,cantidad,precio_unitario,valor}), alertas (lista de textos breves).
Números sin separadores de miles, punto decimal. Si un dato no está, null. No inventes. Sin explicaciones fuera del JSON.

TEXTO:
`;

export function limpiarJson(t: string): Record<string, any> {
  const s = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const ini = s.indexOf('{');
  const fin = s.lastIndexOf('}');
  if (ini < 0 || fin < ini) throw new Error('La IA no devolvió un JSON');
  return JSON.parse(s.slice(ini, fin + 1));
}

export const MODELO_LECTOR = () => process.env.PULPO_MODELO_LECTOR || 'claude-haiku-5-5';

export const lectorIaReal: LectorIa = async (texto) => {
  const llave = process.env.ANTHROPIC_API_KEY;
  if (!llave) throw new Error('Falta ANTHROPIC_API_KEY en el servidor');
  const modelo = MODELO_LECTOR();
  const r = await fetch(`${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': llave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelo, max_tokens: 6000, messages: [{ role: 'user', content: PROMPT_LECTOR + texto.slice(0, 60_000) }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`La IA respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const salida = (j.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
  return { json: limpiarJson(salida), tokens_in: j.usage?.input_tokens ?? 0, tokens_out: j.usage?.output_tokens ?? 0, modelo };
};

let lector: LectorIa = lectorIaReal;
export const usarLectorIa = (l: LectorIa | null) => { lector = l ?? lectorIaReal; };
export const leerConIa: LectorIa = (t) => lector(t);
