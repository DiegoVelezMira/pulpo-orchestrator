import Database from "better-sqlite3";
import { Readable } from "stream";
import { google } from "googleapis";
import { getAuthedClientForOffice, getConnection, GmailConnectionRow } from "./gmail";

// --- Bloque 2: Drive ---
// Misma cuenta OAuth que Gmail (decisión de Diego), así que reutilizamos el
// mismo cliente autenticado. Pulpo busca automáticamente, por nombre de
// oficina, la carpeta de Drive correspondiente — no hace falta que la
// oficina comparta un link o folder ID a mano.

// Cachea el folder_id encontrado en `gmail_connections.drive_folder_id` para
// no repetir la búsqueda por nombre en cada correo que la amerite.
export async function findOfficeFolderId(
  db: Database.Database,
  conn: GmailConnectionRow,
  officeName: string
): Promise<string | null> {
  const cached = db
    .prepare("SELECT drive_folder_id FROM gmail_connections WHERE office_id = ?")
    .get(conn.office_id) as { drive_folder_id: string | null } | undefined;

  if (cached?.drive_folder_id) {
    return cached.drive_folder_id;
  }

  const auth = getAuthedClientForOffice(db, conn);
  const drive = google.drive({ version: "v3", auth });

  // Búsqueda por nombre (no exacta: 'contains' tolera variaciones menores
  // como mayúsculas/espacios) filtrando solo carpetas, no archivos sueltos.
  const escapedName = officeName.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name contains '${escapedName}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 5,
  });

  const match = res.data.files?.[0];
  if (!match?.id) {
    return null;
  }

  db.prepare("UPDATE gmail_connections SET drive_folder_id = ? WHERE office_id = ?").run(
    match.id,
    conn.office_id
  );

  return match.id;
}

// Exporta texto plano desde formatos nativos de Google (Docs → texto, Sheets
// → CSV). Los binarios (PDF, imágenes, etc.) se anotan pero no se
// descargan/parsean todavía — no vale la pena montar un parser de PDF para
// la primera versión de esto.
async function extractFileText(drive: any, file: { id: string; name: string; mimeType: string }): Promise<string> {
  try {
    if (file.mimeType === "application/vnd.google-apps.document") {
      const res = await drive.files.export({ fileId: file.id, mimeType: "text/plain" });
      return `--- ${file.name} ---\n${res.data}`;
    }
    if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
      const res = await drive.files.export({ fileId: file.id, mimeType: "text/csv" });
      return `--- ${file.name} (CSV) ---\n${res.data}`;
    }
    // Binarios u otros formatos no soportados aún: se menciona el nombre
    // para que el agente sepa que existe, aunque no se lea el contenido.
    return `--- ${file.name} --- (archivo de tipo ${file.mimeType}, no se pudo leer el contenido automáticamente)`;
  } catch (error) {
    console.error(`✗ Drive: fallo extrayendo "${file.name}":`, String(error));
    return "";
  }
}

const MAX_FILES = 5;
const MAX_CONTEXT_CHARS = 8000; // margen razonable para no inflar el prompt

// Punto de entrada usado por index.ts (/classify) y poller.ts. Devuelve
// texto listo para anexar al system prompt del agente, o null si no
// encontró carpeta / conexión / contenido útil.
export async function getDriveContextForOffice(
  db: Database.Database,
  officeId: number,
  officeName: string
): Promise<string | null> {
  const conn = getConnection(db, officeId);
  if (!conn) return null;

  try {
    const folderId = await findOfficeFolderId(db, conn, officeName);
    if (!folderId) {
      console.log(`⚠ Drive: no se encontró carpeta para oficina "${officeName}"`);
      return null;
    }

    const auth = getAuthedClientForOffice(db, conn);
    const drive = google.drive({ version: "v3", auth });

    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: MAX_FILES,
      orderBy: "modifiedTime desc",
    });

    const files = listRes.data.files || [];
    if (files.length === 0) return null;

    const chunks: string[] = [];
    for (const file of files) {
      if (!file.id || !file.name || !file.mimeType) continue;
      const text = await extractFileText(drive, { id: file.id, name: file.name, mimeType: file.mimeType });
      if (text) chunks.push(text);
    }

    if (chunks.length === 0) return null;

    let combined = chunks.join("\n\n");
    if (combined.length > MAX_CONTEXT_CHARS) {
      combined = combined.slice(0, MAX_CONTEXT_CHARS) + "\n[...contenido truncado...]";
    }

    return combined;
  } catch (error) {
    console.error(`✗ Drive: fallo obteniendo contexto para oficina ${officeId}:`, String(error));
    return null;
  }
}

// Sube un adjunto de correo (ya descargado como base64url por gmail.ts) a la
// carpeta de Drive de la oficina. Solo se llama para correos clasificados
// como contable/legal (ver poller.ts) — así no se llena la carpeta con
// adjuntos de ruido (newsletters, publicidad, etc.).
export async function uploadAttachmentToOfficeFolder(
  db: Database.Database,
  conn: GmailConnectionRow,
  officeName: string,
  filename: string,
  mimeType: string,
  base64urlData: string
): Promise<boolean> {
  try {
    const folderId = await findOfficeFolderId(db, conn, officeName);
    if (!folderId) {
      console.log(`⚠ Drive: no se pudo subir "${filename}", no hay carpeta para oficina "${officeName}"`);
      return false;
    }

    const auth = getAuthedClientForOffice(db, conn);
    const drive = google.drive({ version: "v3", auth });

    // Gmail entrega los adjuntos en base64url (- y _ en vez de + y /).
    const buffer = Buffer.from(base64urlData.replace(/-/g, "+").replace(/_/g, "/"), "base64");

    await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: "id",
    });

    console.log(`📁 Drive: adjunto "${filename}" subido a carpeta de "${officeName}"`);
    return true;
  } catch (error) {
    console.error(`✗ Drive: fallo subiendo adjunto "${filename}":`, String(error));
    return false;
  }
}
