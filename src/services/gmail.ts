import Database from "better-sqlite3";
import { google } from "googleapis";

// --- Bloque 1: Gmail ---
// Cada oficina conecta su propia cuenta de Gmail vía OAuth2. Guardamos el
// refresh_token en `gmail_connections` y lo usamos para pedir access_tokens
// nuevos cuando el cacheado expira. El polling (ver poller.ts) usa esto
// para leer TODOS los correos que lleguen a esa bandeja, cada 5 minutos.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI; // ej: https://tu-dominio/gmail/oauth/callback

function buildOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error(
      "Faltan variables de entorno de Google OAuth (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)"
    );
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  // Bloque 2: Drive. Misma cuenta que autoriza Gmail autoriza Drive (decisión
  // de Diego), así que van en el mismo consentimiento en vez de un flujo aparte.
  // Nota: se amplió de drive.readonly a drive (lectura + escritura) para
  // poder subir adjuntos de correos contables/legales a la carpeta de la
  // oficina automáticamente. Esto requiere reconexión de cuentas ya
  // conectadas con el scope anterior (Google exige nuevo consentimiento).
  "https://www.googleapis.com/auth/drive",
  // Bloque 4 (Aprobaciones): notificación activa — Pulpo se manda un correo
  // a sí mismo (la misma bandeja que ya lee) avisando que hay tareas
  // pendientes de aprobación. Igual que con Drive, ampliar el scope exige
  // reconectar las cuentas ya conectadas (Google pide consentimiento nuevo).
  "https://www.googleapis.com/auth/gmail.send",
];

// officeId viaja en `state` para saber, cuando Google redirige de vuelta,
// a qué oficina pertenece este código de autorización.
export function getAuthUrl(officeId: number): string {
  const oauth2Client = buildOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline", // imprescindible: es lo único que nos da refresh_token
    prompt: "consent", // fuerza a que siempre entregue refresh_token, incluso en reconexiones
    scope: GMAIL_SCOPES,
    state: String(officeId),
  });
}

export async function handleOAuthCallback(
  db: Database.Database,
  code: string,
  officeId: number
): Promise<{ email: string }> {
  const oauth2Client = buildOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google no devolvió refresh_token. Si esta oficina ya se conectó antes, revoca el acceso en myaccount.google.com/permissions y vuelve a intentar."
    );
  }

  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();
  const email = userInfo.email || "desconocido";

  db.prepare(
    `INSERT INTO gmail_connections (office_id, email_address, refresh_token, access_token, token_expiry)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(office_id) DO UPDATE SET
       email_address = excluded.email_address,
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token,
       token_expiry = excluded.token_expiry`
  ).run(officeId, email, tokens.refresh_token, tokens.access_token || null, tokens.expiry_date || null);

  return { email };
}

export type GmailConnectionRow = {
  office_id: number;
  email_address: string;
  refresh_token: string;
  access_token: string | null;
  token_expiry: number | null;
};

export function getConnection(db: Database.Database, officeId: number): GmailConnectionRow | undefined {
  return db.prepare("SELECT * FROM gmail_connections WHERE office_id = ?").get(officeId) as
    | GmailConnectionRow
    | undefined;
}

export function listConnectedOffices(db: Database.Database): GmailConnectionRow[] {
  return db.prepare("SELECT * FROM gmail_connections").all() as GmailConnectionRow[];
}

// Devuelve un cliente OAuth2 autenticado para esta oficina, renovando el
// access_token si hace falta (la librería lo hace sola con el refresh_token
// y nos avisa vía el evento 'tokens' para que lo cacheemos en DB).
// Exportado: drive.ts reutiliza este mismo cliente (misma cuenta, mismo
// refresh_token) en vez de duplicar la lógica de refresh.
export function getAuthedClientForOffice(db: Database.Database, conn: GmailConnectionRow) {
  const oauth2Client = buildOAuthClient();
  oauth2Client.setCredentials({
    refresh_token: conn.refresh_token,
    access_token: conn.access_token || undefined,
    expiry_date: conn.token_expiry || undefined,
  });

  oauth2Client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      db.prepare("UPDATE gmail_connections SET access_token = ?, token_expiry = ? WHERE office_id = ?").run(
        tokens.access_token,
        tokens.expiry_date || null,
        conn.office_id
      );
    }
  });

  return oauth2Client;
}

export type EmailAttachment = {
  attachmentId: string;
  filename: string;
  mimeType: string;
};

export type FetchedEmail = {
  gmailMessageId: string;
  from: string;
  subject: string;
  body: string;
  attachments: EmailAttachment[];
};

// Decodifica el body de un mensaje de Gmail (base64url), prefiriendo
// text/plain; si solo hay HTML, lo entrega tal cual (el clasificador igual
// puede leerlo, no vale la pena montar un parser de HTML solo para esto).
function extractBody(payload: any): string {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === "text/plain");
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, "base64").toString("utf-8");
    }
    const html = payload.parts.find((p: any) => p.mimeType === "text/html");
    if (html?.body?.data) {
      return Buffer.from(html.body.data, "base64").toString("utf-8");
    }
    // multipart anidado (ej. multipart/alternative dentro de multipart/mixed)
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

// Recorre el árbol de `parts` (incluyendo multipart anidado) juntando toda
// parte que tenga `filename` y `attachmentId` — así es como Gmail marca un
// adjunto real (vs. un part de texto/html del cuerpo del mensaje).
function extractAttachments(payload: any): EmailAttachment[] {
  if (!payload) return [];
  const found: EmailAttachment[] = [];

  function walk(part: any) {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      found.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
      });
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return found;
}

// Todos los correos que lleguen a la bandeja (sin filtrar por remitente ni
// asunto, como pidió Diego), acotado a los últimos 2 días para no traer el
// historial completo en cada poll. `processed_emails` filtra los repetidos.
export async function fetchNewMessages(
  db: Database.Database,
  conn: GmailConnectionRow
): Promise<FetchedEmail[]> {
  const auth = getAuthedClientForOffice(db, conn);
  const gmail = google.gmail({ version: "v1", auth });

  const alreadyProcessed = new Set(
    (
      db
        .prepare("SELECT gmail_message_id FROM processed_emails WHERE office_id = ?")
        .all(conn.office_id) as { gmail_message_id: string }[]
    ).map((r) => r.gmail_message_id)
  );

  const list = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox newer_than:2d",
    maxResults: 25,
  });

  const messages = list.data.messages || [];
  const fresh: FetchedEmail[] = [];

  for (const m of messages) {
    if (!m.id || alreadyProcessed.has(m.id)) continue;

    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const headers = full.data.payload?.headers || [];
    const from = headers.find((h) => h.name === "From")?.value || "desconocido";
    const subject = headers.find((h) => h.name === "Subject")?.value || "(sin asunto)";
    const body = extractBody(full.data.payload) || full.data.snippet || "";
    const attachments = extractAttachments(full.data.payload);

    fresh.push({ gmailMessageId: m.id, from, subject, body, attachments });
  }

  return fresh;
}

// Descarga el contenido binario (base64url, tal como lo entrega Gmail) de un
// adjunto puntual. Se pide bajo demanda (no en fetchNewMessages) para no
// gastar la llamada en correos que ni siquiera se van a clasificar como
// contable/legal.
export async function downloadAttachment(
  db: Database.Database,
  conn: GmailConnectionRow,
  messageId: string,
  attachmentId: string
): Promise<string | null> {
  const auth = getAuthedClientForOffice(db, conn);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  return res.data.data || null;
}

export function markProcessed(db: Database.Database, officeId: number, gmailMessageId: string, taskId?: number) {
  db.prepare(
    "INSERT OR IGNORE INTO processed_emails (office_id, gmail_message_id, task_id) VALUES (?, ?, ?)"
  ).run(officeId, gmailMessageId, taskId || null);
}

export function touchLastPolled(db: Database.Database, officeId: number) {
  db.prepare("UPDATE gmail_connections SET last_polled_at = CURRENT_TIMESTAMP WHERE office_id = ?").run(officeId);
}

// Bloque 4 (Aprobaciones): notificación activa. Se manda a la misma
// dirección conectada de la oficina (conn.email_address) — es la bandeja
// que la persona de la oficina ya revisa, así que sirve como canal de
// aviso sin necesitar un destinatario configurado aparte. Requiere el
// scope gmail.send (ver GMAIL_SCOPES arriba); si la conexión es previa a
// ese scope, Gmail devuelve un error de permisos y quien llama debe
// pedirle a la oficina que reconecte desde /offices/:officeId/gmail/connect.
export async function sendNotificationEmail(
  db: Database.Database,
  conn: GmailConnectionRow,
  subject: string,
  bodyText: string
): Promise<void> {
  const auth = getAuthedClientForOffice(db, conn);
  const gmail = google.gmail({ version: "v1", auth });

  const messageLines = [
    `To: ${conn.email_address}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    bodyText,
  ];
  const raw = Buffer.from(messageLines.join("\r\n"), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
}
