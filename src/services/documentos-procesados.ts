import Database from 'better-sqlite3';
import { estadoPulpo, ESTADOS_PULPO } from './clientes';

// Registro de todo lo que procesa el Crew Contable. Es la base de la reportería:
// cada documento queda con su estado, cifras oficiales, asiento propuesto y motivos
// de revision. Los datos del proveedor se guardan completos (base local de la oficina).
// 'revision_humana' lo usa la vista de revision (pieza 2); aqui solo nace en 'pendiente'
// cuando el documento requiere revision.

export type EstadoRevision = 'no_aplica' | 'pendiente' | 'aprobado' | 'corregido';

export function crearTablaDocumentos(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documentos_procesados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id TEXT NOT NULL,
      documento_id TEXT NOT NULL,
      tipo_documento TEXT,
      fecha_documento TEXT,
      proveedor TEXT,
      nit_proveedor TEXT,
      estado TEXT NOT NULL,
      base_gravable REAL,
      iva REAL,
      total_factura REAL,
      retefuente REAL,
      reteiva REAL,
      neto_a_pagar REAL,
      asiento_json TEXT,
      motivos_json TEXT,
      documento_json TEXT,
      resultado_json TEXT,
      version_reglas TEXT,
      revision_humana TEXT NOT NULL DEFAULT 'no_aplica',
      procesado_at TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (office_id, documento_id)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_proc_oficina_estado
      ON documentos_procesados (office_id, estado, fecha_documento);
  `);
  // Migracion: columnas de la revision humana (la tabla puede existir de antes).
  const cols = (db.prepare('PRAGMA table_info(documentos_procesados)').all() as any[]).map((c) => c.name);
  for (const [nombre, tipo] of [['revision_nota', 'TEXT'], ['revisado_por', 'TEXT'], ['revisado_at', 'TEXT'], ['cliente_id', 'INTEGER'], ['rol_cliente', 'TEXT'], ['exportado_at', 'TEXT'], ['en_espera', 'INTEGER NOT NULL DEFAULT 0'], ['origen', 'TEXT'], ['cufe', 'TEXT'], ['huella', 'TEXT'], ['nombre_archivo', 'TEXT'], ['texto_pdf', 'TEXT']]) {
    if (!cols.includes(nombre)) db.exec(`ALTER TABLE documentos_procesados ADD COLUMN ${nombre} ${tipo}`);
  }
}

export type ResultadoRevision =
  | { ok: true }
  | { ok: false; codigo: 400 | 404 | 409; error: string };

// Registra la decision de una persona sobre un documento que quedo pendiente.
// No recalcula nada: 'corregido' deja constancia de lo que se corrigio a mano.
export function registrarRevision(
  db: Database.Database,
  officeId: string,
  documentoId: string,
  decision: string,
  nota: string | undefined,
  revisor: string | undefined
): ResultadoRevision {
  // 'aprobado' y 'corregido' marcan Revisado; 'devolver' lo manda de vuelta a Necesita ayuda.
  if (decision !== 'aprobado' && decision !== 'corregido' && decision !== 'devolver') {
    return { ok: false, codigo: 400, error: "La decision debe ser 'aprobado', 'corregido' o 'devolver'" };
  }
  const texto = (nota ?? '').trim();
  if (decision === 'corregido' && !texto) {
    return { ok: false, codigo: 400, error: 'Para marcar como corregido hay que explicar que se corrigio (nota)' };
  }
  const f = db
    .prepare('SELECT estado, revision_humana, exportado_at, cliente_id FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
    .get(officeId, documentoId) as { estado: string; revision_humana: string; exportado_at: string | null; cliente_id: number | null } | undefined;
  if (!f) return { ok: false, codigo: 404, error: 'Documento no encontrado' };
  if (f.exportado_at) return { ok: false, codigo: 409, error: 'El documento ya se exportó; no se puede cambiar su revisión' };
  if (f.estado === 'sin_cliente' || !f.cliente_id) {
    return { ok: false, codigo: 409, error: 'Primero elige a qué cliente pertenece el documento' };
  }
  const quien = (revisor ?? '').trim() || null;
  if (decision === 'devolver') {
    if (f.revision_humana === 'pendiente') return { ok: false, codigo: 409, error: 'El documento ya necesita ayuda' };
    db.prepare(
      `UPDATE documentos_procesados SET revision_humana = 'pendiente', revision_nota = ?, revisado_por = ?, revisado_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE office_id = ? AND documento_id = ?`
    ).run(texto || null, quien, new Date().toISOString(), officeId, documentoId);
    return { ok: true };
  }
  if (f.estado === 'rechazado' && decision === 'aprobado') {
    return { ok: false, codigo: 409, error: 'Un documento rechazado solo puede cerrarse como corregido, explicando qué se hizo' };
  }
  if (f.revision_humana === 'aprobado' || f.revision_humana === 'corregido') {
    return { ok: false, codigo: 409, error: `El documento ya está revisado (estado: ${f.revision_humana})` };
  }
  db.prepare(
    `UPDATE documentos_procesados
        SET revision_humana = ?, revision_nota = ?, revisado_por = ?, revisado_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE office_id = ? AND documento_id = ?`
  ).run(decision, texto || null, quien, new Date().toISOString(), officeId, documentoId);
  return { ok: true };
}

const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function guardarDocumento(
  db: Database.Database,
  officeId: string | number | undefined,
  documento: Record<string, any>,
  resultado: Record<string, any>,
  cliente?: { clienteId: number; rol: 'comprador' | 'vendedor' }
): number | null {
  const estado = String(resultado?.status ?? '');
  // Los errores de infraestructura no son documentos: no se registran.
  if (!['procesado', 'requiere_revision', 'rechazado'].includes(estado)) return null;

  const calc = resultado.calculos_oficiales || {};
  const det = calc.determinable === true;
  const asiento = resultado.asientos?.detalles?.asiento ?? null;
  const motivos: string[] =
    resultado.motivos_revision ??
    (resultado.razon ? [String(resultado.razon)] : resultado.detalles?.motivos ?? []);
  const docId = String(resultado.documento_id ?? documento.id ?? 'sin_id');
  const revision: EstadoRevision = estado === 'procesado' ? 'no_aplica' : 'pendiente';

  const fila = db
    .prepare(
      `INSERT INTO documentos_procesados
        (office_id, documento_id, tipo_documento, fecha_documento, proveedor, nit_proveedor,
         estado, base_gravable, iva, total_factura, retefuente, reteiva, neto_a_pagar,
         asiento_json, motivos_json, documento_json, resultado_json, version_reglas,
         revision_humana, procesado_at, cliente_id, rol_cliente, exportado_at)
       VALUES (@office_id, @documento_id, @tipo_documento, @fecha_documento, @proveedor, @nit_proveedor,
         @estado, @base, @iva, @total, @rf, @ri, @neto,
         @asiento, @motivos, @documento, @resultado, @version,
         @revision, @procesado_at, @cliente_id, @rol_cliente, NULL)
       ON CONFLICT(office_id, documento_id) DO UPDATE SET
         tipo_documento=excluded.tipo_documento, fecha_documento=excluded.fecha_documento,
         proveedor=excluded.proveedor, nit_proveedor=excluded.nit_proveedor,
         estado=excluded.estado, base_gravable=excluded.base_gravable, iva=excluded.iva,
         total_factura=excluded.total_factura, retefuente=excluded.retefuente,
         reteiva=excluded.reteiva, neto_a_pagar=excluded.neto_a_pagar,
         asiento_json=excluded.asiento_json, motivos_json=excluded.motivos_json,
         documento_json=excluded.documento_json, resultado_json=excluded.resultado_json,
         version_reglas=excluded.version_reglas, revision_humana=excluded.revision_humana, revision_nota=NULL, revisado_por=NULL, revisado_at=NULL,
         procesado_at=excluded.procesado_at, cliente_id=excluded.cliente_id, rol_cliente=excluded.rol_cliente, exportado_at=NULL, en_espera=0, updated_at=CURRENT_TIMESTAMP
       RETURNING id`
    )
    .get({
      office_id: String(officeId ?? 'sin_id'),
      documento_id: docId,
      tipo_documento: resultado.tipo ?? calc.tipo_documento ?? documento.tipo ?? null,
      fecha_documento: documento.fecha ?? null,
      proveedor: documento.proveedor ?? null,
      nit_proveedor: documento.nit_proveedor ?? null,
      estado,
      base: num(calc.base_gravable),
      iva: num(calc.iva),
      total: num(calc.total_factura),
      rf: det ? num(calc.retefuente?.valor) : null,
      ri: det ? num(calc.reteiva?.valor) : null,
      neto: det ? num(calc.neto_a_pagar) : null,
      asiento: asiento ? JSON.stringify(asiento) : null,
      motivos: JSON.stringify(motivos),
      documento: JSON.stringify(documento),
      resultado: JSON.stringify(resultado),
      version: calc.version_reglas ?? null,
      revision,
      procesado_at: String(resultado.timestamp ?? new Date().toISOString()),
      cliente_id: cliente?.clienteId ?? null,
      rol_cliente: cliente?.rol ?? null,
    }) as { id: number };
  return fila.id;
}

// Un documento leído cuyo cliente aún no se conoce: se guarda sin pasar por el crew y queda en Necesita ayuda.
export function guardarDocumentoSinCliente(db: Database.Database, officeId: string | number, documento: Record<string, any>): number {
  const docId = String(documento.id ?? 'sin_id');
  const f = db
    .prepare(
      `INSERT INTO documentos_procesados
        (office_id, documento_id, tipo_documento, fecha_documento, proveedor, nit_proveedor, estado,
         motivos_json, documento_json, revision_humana, procesado_at, cliente_id, rol_cliente, exportado_at)
       VALUES (@o, @d, @tipo, @fecha, @prov, @nit, 'sin_cliente', @motivos, @doc, 'pendiente', @ahora, NULL, NULL, NULL)
       ON CONFLICT(office_id, documento_id) DO UPDATE SET
         tipo_documento=excluded.tipo_documento, fecha_documento=excluded.fecha_documento, proveedor=excluded.proveedor,
         nit_proveedor=excluded.nit_proveedor, estado='sin_cliente', motivos_json=excluded.motivos_json,
         documento_json=excluded.documento_json, revision_humana='pendiente', cliente_id=NULL, rol_cliente=NULL,
         exportado_at=NULL, procesado_at=excluded.procesado_at, updated_at=CURRENT_TIMESTAMP
       RETURNING id`
    )
    .get({
      o: String(officeId), d: docId, tipo: documento.tipo ?? null, fecha: documento.fecha ?? null,
      prov: documento.proveedor ?? null, nit: documento.nit_proveedor ?? null,
      motivos: JSON.stringify(['Elige a qué cliente pertenece este documento']),
      doc: JSON.stringify(documento), ahora: new Date().toISOString(),
    }) as { id: number };
  return f.id;
}

const COLUMNAS_LISTA = `d.id, d.office_id, d.documento_id, d.tipo_documento, d.fecha_documento, d.proveedor,
  d.nit_proveedor, d.estado, d.base_gravable, d.iva, d.total_factura, d.retefuente, d.reteiva, d.neto_a_pagar,
  d.version_reglas, d.revision_humana, d.revision_nota, d.revisado_por, d.revisado_at, d.procesado_at,
  d.cliente_id, d.rol_cliente, d.exportado_at, d.en_espera, d.origen, d.nombre_archivo, c.nombre AS cliente_nombre`;

export function listarDocumentos(
  db: Database.Database,
  officeId: string,
  filtros: { estado?: string; revision?: string; cliente?: number; estadoPulpo?: string } = {}
) {
  const where = ['d.office_id = ?'];
  const args: any[] = [officeId];
  if (filtros.estado) { where.push('d.estado = ?'); args.push(filtros.estado); }
  if (filtros.revision) { where.push('d.revision_humana = ?'); args.push(filtros.revision); }
  if (filtros.cliente) { where.push('d.cliente_id = ?'); args.push(filtros.cliente); }
  const filas = db
    .prepare(
      `SELECT ${COLUMNAS_LISTA} FROM documentos_procesados d LEFT JOIN clientes c ON c.id = d.cliente_id
       WHERE ${where.join(' AND ')} ORDER BY d.procesado_at DESC LIMIT 2000`
    )
    .all(...args)
    .map((f: any) => ({ ...f, estado_pulpo: estadoPulpo(f) }));
  const ok = filtros.estadoPulpo && (ESTADOS_PULPO as readonly string[]).includes(filtros.estadoPulpo);
  return (ok ? filas.filter((f: any) => f.estado_pulpo === filtros.estadoPulpo) : filas).slice(0, 500);
}

export function obtenerDocumento(db: Database.Database, officeId: string, documentoId: string) {
  const f = db
    .prepare('SELECT d.*, c.nombre AS cliente_nombre FROM documentos_procesados d LEFT JOIN clientes c ON c.id = d.cliente_id WHERE d.office_id = ? AND d.documento_id = ?')
    .get(officeId, documentoId) as Record<string, any> | undefined;
  if (!f) return null;
  const j = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const { asiento_json, motivos_json, documento_json, resultado_json, texto_pdf, ...resto } = f; // texto_pdf (texto de la factura) no sale por la API
  return { ...resto, estado_pulpo: estadoPulpo(f as any), asiento: j(asiento_json), motivos: j(motivos_json) ?? [],
           documento: j(documento_json), resultado: j(resultado_json) };
}

// ---- PDF: filas que aún no tienen documento completo ----

// Marca el origen de un documento ya guardado (PDF leído con IA).
export function marcarOrigenPdf(db: Database.Database, officeId: string | number, documentoId: string, m: { cufe: string | null; huella: string; nombre: string }) {
  db.prepare("UPDATE documentos_procesados SET origen = 'pdf', cufe = ?, huella = ?, nombre_archivo = ? WHERE office_id = ? AND documento_id = ?")
    .run(m.cufe, m.huella, m.nombre, String(officeId), documentoId);
}

// ¿Este PDF (mismo archivo o mismo CUFE) ya está registrado en la oficina?
export function pdfYaRegistrado(db: Database.Database, officeId: string | number, huella: string, cufe: string | null, excluir?: string) {
  return db
    .prepare('SELECT documento_id, estado, en_espera FROM documentos_procesados WHERE office_id = ? AND (huella = ? OR (? IS NOT NULL AND cufe = ?)) AND documento_id <> ? LIMIT 1')
    .get(String(officeId), huella, cufe, cufe, excluir ?? '') as { documento_id: string; estado: string; en_espera: number } | undefined;
}

// PDF recibido que no se pudo (o no se pudo todavía) leer: sin texto (escaneado) o esperando cupo del tope.
export function guardarPdfPendiente(
  db: Database.Database,
  officeId: string | number,
  p: { huella: string; cufe: string | null; nombre: string; estado: 'recibido' | 'ilegible'; enEspera: boolean; motivo: string; texto?: string }
): string {
  const documentoId = `pdf-${p.huella.slice(0, 16)}`;
  db.prepare(
    `INSERT INTO documentos_procesados
      (office_id, documento_id, tipo_documento, estado, motivos_json, revision_humana, procesado_at, en_espera, origen, cufe, huella, nombre_archivo, texto_pdf)
     VALUES (@o, @d, 'pdf', @estado, @motivos, 'pendiente', @ahora, @espera, 'pdf', @cufe, @huella, @nombre, @texto)
     ON CONFLICT(office_id, documento_id) DO UPDATE SET estado=excluded.estado, motivos_json=excluded.motivos_json,
       en_espera=excluded.en_espera, texto_pdf=excluded.texto_pdf, updated_at=CURRENT_TIMESTAMP`
  ).run({
    o: String(officeId), d: documentoId, estado: p.estado, motivos: JSON.stringify([p.motivo]), ahora: new Date().toISOString(),
    espera: p.enEspera ? 1 : 0, cufe: p.cufe, huella: p.huella, nombre: p.nombre.slice(0, 200), texto: p.texto ?? null,
  });
  return documentoId;
}

export function pdfsEnEspera(db: Database.Database, officeId: string | number) {
  return db
    .prepare("SELECT documento_id, huella, cufe, nombre_archivo, texto_pdf FROM documentos_procesados WHERE office_id = ? AND en_espera = 1 AND estado = 'recibido' AND texto_pdf IS NOT NULL ORDER BY id")
    .all(String(officeId)) as { documento_id: string; huella: string; cufe: string | null; nombre_archivo: string; texto_pdf: string }[];
}

export function borrarMarcador(db: Database.Database, officeId: string | number, documentoId: string) {
  db.prepare("DELETE FROM documentos_procesados WHERE office_id = ? AND documento_id = ? AND estado IN ('recibido','ilegible')").run(String(officeId), documentoId);
}
