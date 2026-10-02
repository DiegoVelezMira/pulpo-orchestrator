import Database from "better-sqlite3";

// --- Legal: integración DIAN vía Siigo (segundo incremento) ---
// A diferencia de los 3 chequeos mecánicos del primer incremento (que solo
// comparan fechas/montos que la oficina ya registró), este bloque sí habla
// con un sistema externo: la API de Siigo, que es quien realmente timbra
// las facturas ante la DIAN. Seguimos sin llamar a Claude para la detección
// en sí — es una clasificación de estado (rechazada / sin enviar / aceptada),
// no algo que requiera juicio — pero ahora depende de la forma exacta de la
// respuesta de un tercero, que no pudimos verificar en vivo contra una cuenta
// real al momento de escribir esto. Ver nota de verificación pendiente abajo.
//
// Endpoints de Siigo usados (confirmados contra la documentación pública del
// SDK oficial, SiigoDev/siigo_sdk_javascript):
//   POST /auth                        -> autenticación (username + access_key)
//   GET  /v1/invoices                 -> listado de facturas
//   GET  /v1/invoices/:id/stamp/errors -> detalle de errores de una factura
//                                          rechazada por la DIAN
//
// [No Verificado] El nombre exacto del campo de estado de timbrado dentro de
// cada factura (ej. invoice.stamp.status vs invoice.status) y los valores
// textuales que usa Siigo para "rechazada" no están confirmados contra una
// respuesta real — la documentación pública no los detalla. Por eso
// `rejected_status_values` es configurable por oficina (no hardcodeado): si
// al probar contra la cuenta real de Diego el valor viene distinto (ej.
// "Rechazada" en vez de "Rejected"), se ajusta desde /siigo/config sin tocar
// código ni redeploy.

const SIIGO_AUTH_URL = "https://api.siigo.com/auth";
const SIIGO_API_BASE = "https://api.siigo.com/v1";
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_REJECTED_VALUES = ["Rejected", "rejected", "Rechazada", "rechazada"];

// Tarifas de IVA vigentes en Colombia (general 19%, reducida 5%, exenta/excluida
// 0%) — esto sí está confirmado por ley, no depende de la respuesta de Siigo.
const DEFAULT_IVA_RATES = [0, 5, 19];

// La retención en la fuente, en cambio, varía por concepto (compras, servicios,
// honorarios, arrendamientos...) y no hay un set fijo único — por eso es
// configurable por oficina desde el día 1, a diferencia del IVA. Esta lista
// es un punto de partida razonable, no una tabla oficial memorizada; cada
// oficina debe ajustarla a los conceptos que realmente maneja.
const DEFAULT_RETENCION_RATES = [1, 2.5, 3.5, 4, 6, 10, 11, 15, 20, 25];

// Tolerancia de redondeo al comparar "base × tarifa" contra el monto que
// Siigo reporta como IVA/retención ya calculado. $10 COP cubre redondeos de
// centavos sin dejar pasar un error real de cálculo.
const TAX_AMOUNT_TOLERANCE_PESOS = 10;

export type SiigoConfig = {
  office_id: number;
  username: string | null;
  access_key: string | null;
  partner_id: string | null;
  invoice_lookback_days: number;
  rejected_status_values: string[];
  iva_allowed_rates: number[];
  retencion_allowed_rates: number[];
};

type SiigoConfigRow = {
  office_id: number;
  username: string | null;
  access_key: string | null;
  partner_id: string | null;
  invoice_lookback_days: number;
  rejected_status_values: string;
  iva_allowed_rates: string;
  retencion_allowed_rates: string;
};

export function getSiigoConfig(db: Database.Database, officeId: number): SiigoConfig {
  const row = db.prepare("SELECT * FROM siigo_config WHERE office_id = ?").get(officeId) as
    | SiigoConfigRow
    | undefined;
  if (!row) {
    return {
      office_id: officeId,
      username: null,
      access_key: null,
      partner_id: null,
      invoice_lookback_days: DEFAULT_LOOKBACK_DAYS,
      rejected_status_values: DEFAULT_REJECTED_VALUES,
      iva_allowed_rates: DEFAULT_IVA_RATES,
      retencion_allowed_rates: DEFAULT_RETENCION_RATES,
    };
  }
  return {
    office_id: row.office_id,
    username: row.username,
    access_key: row.access_key,
    partner_id: row.partner_id,
    invoice_lookback_days: row.invoice_lookback_days,
    rejected_status_values: JSON.parse(row.rejected_status_values),
    // Filas creadas antes de este incremento no tienen estas 2 columnas
    // pobladas (existen con DEFAULT a nivel de columna, pero por si acaso
    // alguna fila vieja quedó con NULL): caemos a los defaults en memoria.
    iva_allowed_rates: row.iva_allowed_rates ? JSON.parse(row.iva_allowed_rates) : DEFAULT_IVA_RATES,
    retencion_allowed_rates: row.retencion_allowed_rates
      ? JSON.parse(row.retencion_allowed_rates)
      : DEFAULT_RETENCION_RATES,
  };
}

export function setSiigoConfig(
  db: Database.Database,
  officeId: number,
  partial: Partial<Omit<SiigoConfig, "office_id">>
): SiigoConfig {
  const current = getSiigoConfig(db, officeId);
  const merged: SiigoConfig = { ...current, ...partial, office_id: officeId };
  db.prepare(
    `INSERT INTO siigo_config
       (office_id, username, access_key, partner_id, invoice_lookback_days, rejected_status_values, iva_allowed_rates, retencion_allowed_rates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(office_id) DO UPDATE SET
       username = excluded.username,
       access_key = excluded.access_key,
       partner_id = excluded.partner_id,
       invoice_lookback_days = excluded.invoice_lookback_days,
       rejected_status_values = excluded.rejected_status_values,
       iva_allowed_rates = excluded.iva_allowed_rates,
       retencion_allowed_rates = excluded.retencion_allowed_rates`
  ).run(
    merged.office_id,
    merged.username,
    merged.access_key,
    merged.partner_id,
    merged.invoice_lookback_days,
    JSON.stringify(merged.rejected_status_values),
    JSON.stringify(merged.iva_allowed_rates),
    JSON.stringify(merged.retencion_allowed_rates)
  );
  return merged;
}

// El token de Siigo típicamente vive ~24h (patrón observado en múltiples
// SDKs no oficiales, no confirmado contra documentación primaria). Lo
// cacheamos en memoria por oficina en vez de persistirlo en la base de
// datos — si el proceso se reinicia, simplemente se vuelve a autenticar en
// la siguiente llamada, sin costo real.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

async function getSiigoToken(db: Database.Database, officeId: number): Promise<string> {
  const cached = tokenCache.get(officeId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const config = getSiigoConfig(db, officeId);
  if (!config.username || !config.access_key) {
    throw new Error(
      "Esta oficina no tiene credenciales de Siigo configuradas. Usa PUT /offices/:officeId/siigo/config primero."
    );
  }

  const res = await fetch(SIIGO_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: config.username, access_key: config.access_key }),
  });
  if (!res.ok) {
    throw new Error(`Autenticación con Siigo falló (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresInMs = (data.expires_in ?? 60 * 60 * 23) * 1000; // default conservador: 23h
  tokenCache.set(officeId, { token: data.access_token, expiresAt: Date.now() + expiresInMs - 60_000 });
  return data.access_token;
}

async function siigoFetch(db: Database.Database, officeId: number, path: string): Promise<any> {
  const config = getSiigoConfig(db, officeId);
  const token = await getSiigoToken(db, officeId);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (config.partner_id) headers["Partner-Id"] = config.partner_id;

  const res = await fetch(`${SIIGO_API_BASE}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`Siigo API error (${res.status}) en ${path}: ${await res.text()}`);
  }
  return res.json();
}

// Extrae el estado de timbrado de una factura de forma defensiva: la
// documentación pública no confirma si el campo vive en invoice.stamp.status
// o invoice.status, así que probamos ambos. Si no encontramos nada
// reconocible, devolvemos null — preferimos no reportar nada antes que
// adivinar y generar una alerta falsa (coherente con "cero asunciones").
function extractStampStatus(invoice: any): string | null {
  return invoice?.stamp?.status ?? invoice?.status ?? null;
}

type TaxLine = {
  kind: "iva" | "retencion";
  base: number;
  rate: number;
  declaredAmount: number | null;
};

// Extrae las líneas de IVA/retención de una factura de forma defensiva, con
// el mismo criterio que extractStampStatus: la documentación pública del SDK
// no confirma el nombre exacto de estos campos en una respuesta real, así
// que probamos las formas más comunes y, si no reconocemos nada, no
// devolvemos esa línea — preferimos omitir un chequeo antes que adivinar un
// número y generar una alerta falsa. [No Verificado] hasta probar contra una
// cuenta real de Siigo.
//
// Formas que probamos por cada item de invoice.items[]:
//   item.taxes[] = [{ name, type, percentage, value? }]
// Clasificamos por `type`/`name` conteniendo "iva" o "rete"/"retenc" — Siigo
// usa nombres como "IVA", "Reteiva", "Retefuente", "ReteICA" en su catálogo
// de impuestos público; cualquier otro impuesto (ICA, INC, etc.) queda fuera
// de este chequeo a propósito, no es su alcance.
function extractTaxLines(invoice: any): TaxLine[] {
  const items: any[] = Array.isArray(invoice?.items) ? invoice.items : [];
  const lines: TaxLine[] = [];

  for (const item of items) {
    const base = Number(item?.total ?? (Number(item?.price ?? 0) * Number(item?.quantity ?? 1)));
    if (!Number.isFinite(base) || base <= 0) continue;

    const taxes: any[] = Array.isArray(item?.taxes) ? item.taxes : [];
    for (const tax of taxes) {
      const label = String(tax?.type ?? tax?.name ?? "").toLowerCase();
      const rate = Number(tax?.percentage);
      if (!Number.isFinite(rate)) continue;

      const declaredAmount = tax?.value !== undefined && tax?.value !== null ? Number(tax.value) : null;

      if (label.includes("iva")) {
        lines.push({ kind: "iva", base, rate, declaredAmount });
      } else if (label.includes("rete") || label.includes("retenc")) {
        lines.push({ kind: "retencion", base, rate, declaredAmount });
      }
    }
  }

  return lines;
}

export type DianInvoiceFlag = {
  id: number;
  office_id: number;
  siigo_invoice_id: string;
  invoice_number: string | null;
  customer_name: string | null;
  check_type:
    | "factura_dian_rechazada"
    | "factura_dian_sin_timbrar"
    | "iva_tarifa_invalida"
    | "iva_monto_inconsistente"
    | "retencion_tarifa_invalida"
    | "retencion_monto_inconsistente";
  severity: "warning" | "critical";
  message: string;
  error_detail: string | null;
  detected_at: string;
};

// Trae las facturas emitidas en la ventana configurada (invoice_lookback_days)
// y clasifica cada una. Reemplaza las flags anteriores de la oficina — mismo
// principio de "estado actual, no historial" que los otros chequeos de Legal.
export async function runDianComplianceChecks(
  db: Database.Database,
  officeId: number
): Promise<DianInvoiceFlag[]> {
  const config = getSiigoConfig(db, officeId);
  const since = new Date(Date.now() - config.invoice_lookback_days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const data = await siigoFetch(db, officeId, `/invoices?created_start=${since}`);
  const invoices: any[] = Array.isArray(data) ? data : data.results ?? [];

  db.prepare("DELETE FROM dian_invoice_flags WHERE office_id = ?").run(officeId);

  const insert = db.prepare(
    `INSERT INTO dian_invoice_flags
       (office_id, siigo_invoice_id, invoice_number, customer_name, check_type, severity, message, error_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const flagged: DianInvoiceFlag[] = [];

  for (const invoice of invoices) {
    const status = extractStampStatus(invoice);
    const customerName: string | null =
      invoice?.customer?.name ?? invoice?.customer?.commercial_name ?? null;
    const invoiceNumber: string | null = invoice?.number ?? invoice?.name ?? null;

    if (status && config.rejected_status_values.includes(status)) {
      let errorDetail: string | null = null;
      try {
        const errors = await siigoFetch(db, officeId, `/invoices/${invoice.id}/stamp/errors`);
        errorDetail = Array.isArray(errors)
          ? errors.map((e: any) => e?.message ?? JSON.stringify(e)).join(" | ")
          : JSON.stringify(errors);
      } catch (e) {
        errorDetail = `No se pudo obtener el detalle del error: ${String(e)}`;
      }

      const message = `Factura ${invoiceNumber ?? invoice.id} rechazada por la DIAN.${
        customerName ? ` Cliente: ${customerName}.` : ""
      }`;
      insert.run(
        officeId,
        String(invoice.id),
        invoiceNumber,
        customerName,
        "factura_dian_rechazada",
        "critical",
        message,
        errorDetail
      );
    } else if (status === null) {
      // Sin campo de estado reconocible: no flagueamos (ver nota arriba),
      // pero lo dejamos pasar en silencio — no es evidencia de un problema,
      // es evidencia de que no pudimos leer el campo.
    }

    // --- IVA y retención: tarifa inválida + inconsistencia aritmética ---
    // Chequeo independiente del rechazo DIAN de arriba: una factura puede
    // estar correctamente timbrada y aun así tener un IVA o una retención
    // mal calculados o con una tarifa que no corresponde a nada vigente.
    for (const line of extractTaxLines(invoice)) {
      const allowedRates = line.kind === "iva" ? config.iva_allowed_rates : config.retencion_allowed_rates;
      const rateLabel = line.kind === "iva" ? "IVA" : "retención";

      if (!allowedRates.includes(line.rate)) {
        const message = `Factura ${invoiceNumber ?? invoice.id}: tarifa de ${rateLabel} de ${line.rate}% no está en la lista de tarifas permitidas (${allowedRates.join(", ")}%).${
          customerName ? ` Cliente: ${customerName}.` : ""
        }`;
        insert.run(
          officeId,
          String(invoice.id),
          invoiceNumber,
          customerName,
          line.kind === "iva" ? "iva_tarifa_invalida" : "retencion_tarifa_invalida",
          "warning",
          message,
          null
        );
      }

      if (line.declaredAmount !== null) {
        const expectedAmount = (line.base * line.rate) / 100;
        const diff = Math.abs(expectedAmount - line.declaredAmount);
        if (diff > TAX_AMOUNT_TOLERANCE_PESOS) {
          const message = `Factura ${invoiceNumber ?? invoice.id}: ${rateLabel} declarado ($${line.declaredAmount.toLocaleString(
            "es-CO"
          )}) no coincide con base × tarifa ($${expectedAmount.toLocaleString("es-CO")} esperado sobre una base de $${line.base.toLocaleString(
            "es-CO"
          )} al ${line.rate}%).${customerName ? ` Cliente: ${customerName}.` : ""}`;
          insert.run(
            officeId,
            String(invoice.id),
            invoiceNumber,
            customerName,
            line.kind === "iva" ? "iva_monto_inconsistente" : "retencion_monto_inconsistente",
            "critical",
            message,
            null
          );
        }
      }
      // Si declaredAmount es null, no pudimos leer un monto ya calculado por
      // Siigo para comparar — solo corre el chequeo de tarifa de arriba.
    }
  }

  return db
    .prepare("SELECT * FROM dian_invoice_flags WHERE office_id = ? ORDER BY detected_at DESC")
    .all(officeId) as DianInvoiceFlag[];
}

export function listDianInvoiceFlags(db: Database.Database, officeId: number): DianInvoiceFlag[] {
  return db
    .prepare("SELECT * FROM dian_invoice_flags WHERE office_id = ? ORDER BY detected_at DESC")
    .all(officeId) as DianInvoiceFlag[];
}
