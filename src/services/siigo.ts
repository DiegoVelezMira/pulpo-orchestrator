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

export type SiigoConfig = {
  office_id: number;
  username: string | null;
  access_key: string | null;
  partner_id: string | null;
  invoice_lookback_days: number;
  rejected_status_values: string[];
};

type SiigoConfigRow = {
  office_id: number;
  username: string | null;
  access_key: string | null;
  partner_id: string | null;
  invoice_lookback_days: number;
  rejected_status_values: string;
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
    };
  }
  return {
    office_id: row.office_id,
    username: row.username,
    access_key: row.access_key,
    partner_id: row.partner_id,
    invoice_lookback_days: row.invoice_lookback_days,
    rejected_status_values: JSON.parse(row.rejected_status_values),
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
    `INSERT INTO siigo_config (office_id, username, access_key, partner_id, invoice_lookback_days, rejected_status_values)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(office_id) DO UPDATE SET
       username = excluded.username,
       access_key = excluded.access_key,
       partner_id = excluded.partner_id,
       invoice_lookback_days = excluded.invoice_lookback_days,
       rejected_status_values = excluded.rejected_status_values`
  ).run(
    merged.office_id,
    merged.username,
    merged.access_key,
    merged.partner_id,
    merged.invoice_lookback_days,
    JSON.stringify(merged.rejected_status_values)
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

export type DianInvoiceFlag = {
  id: number;
  office_id: number;
  siigo_invoice_id: string;
  invoice_number: string | null;
  customer_name: string | null;
  check_type: "factura_dian_rechazada" | "factura_dian_sin_timbrar";
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
      continue;
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
