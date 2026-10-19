import Database from 'better-sqlite3';

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
  for (const [nombre, tipo] of [['revision_nota', 'TEXT'], ['revisado_por', 'TEXT'], ['revisado_at', 'TEXT']]) {
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
  if (decision !== 'aprobado' && decision !== 'corregido') {
    return { ok: false, codigo: 400, error: "La decision debe ser 'aprobado' o 'corregido'" };
  }
  const texto = (nota ?? '').trim();
  if (decision === 'corregido' && !texto) {
    return { ok: false, codigo: 400, error: 'Para marcar como corregido hay que explicar que se corrigio (nota)' };
  }
  const f = db
    .prepare('SELECT revision_humana FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
    .get(officeId, documentoId) as { revision_humana: string } | undefined;
  if (!f) return { ok: false, codigo: 404, error: 'Documento no encontrado' };
  if (f.revision_humana !== 'pendiente') {
    return { ok: false, codigo: 409, error: `El documento no esta pendiente de revision (estado: ${f.revision_humana})` };
  }
  db.prepare(
    `UPDATE documentos_procesados
        SET revision_humana = ?, revision_nota = ?, revisado_por = ?, revisado_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE office_id = ? AND documento_id = ?`
  ).run(decision, texto || null, (revisor ?? '').trim() || null, new Date().toISOString(), officeId, documentoId);
  return { ok: true };
}

const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function guardarDocumento(
  db: Database.Database,
  officeId: string | number | undefined,
  documento: Record<string, any>,
  resultado: Record<string, any>
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
         revision_humana, procesado_at)
       VALUES (@office_id, @documento_id, @tipo_documento, @fecha_documento, @proveedor, @nit_proveedor,
         @estado, @base, @iva, @total, @rf, @ri, @neto,
         @asiento, @motivos, @documento, @resultado, @version,
         @revision, @procesado_at)
       ON CONFLICT(office_id, documento_id) DO UPDATE SET
         tipo_documento=excluded.tipo_documento, fecha_documento=excluded.fecha_documento,
         proveedor=excluded.proveedor, nit_proveedor=excluded.nit_proveedor,
         estado=excluded.estado, base_gravable=excluded.base_gravable, iva=excluded.iva,
         total_factura=excluded.total_factura, retefuente=excluded.retefuente,
         reteiva=excluded.reteiva, neto_a_pagar=excluded.neto_a_pagar,
         asiento_json=excluded.asiento_json, motivos_json=excluded.motivos_json,
         documento_json=excluded.documento_json, resultado_json=excluded.resultado_json,
         version_reglas=excluded.version_reglas, revision_humana=excluded.revision_humana, revision_nota=NULL, revisado_por=NULL, revisado_at=NULL,
         procesado_at=excluded.procesado_at, updated_at=CURRENT_TIMESTAMP
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
    }) as { id: number };
  return fila.id;
}

const COLUMNAS_LISTA = `id, office_id, documento_id, tipo_documento, fecha_documento, proveedor,
  nit_proveedor, estado, base_gravable, iva, total_factura, retefuente, reteiva, neto_a_pagar,
  version_reglas, revision_humana, revision_nota, revisado_por, revisado_at, procesado_at`;

export function listarDocumentos(
  db: Database.Database,
  officeId: string,
  filtros: { estado?: string; revision?: string } = {}
) {
  const where = ['office_id = ?'];
  const args: any[] = [officeId];
  if (filtros.estado) { where.push('estado = ?'); args.push(filtros.estado); }
  if (filtros.revision) { where.push('revision_humana = ?'); args.push(filtros.revision); }
  return db
    .prepare(
      `SELECT ${COLUMNAS_LISTA} FROM documentos_procesados
       WHERE ${where.join(' AND ')} ORDER BY procesado_at DESC LIMIT 500`
    )
    .all(...args);
}

export function obtenerDocumento(db: Database.Database, officeId: string, documentoId: string) {
  const f = db
    .prepare('SELECT * FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
    .get(officeId, documentoId) as Record<string, any> | undefined;
  if (!f) return null;
  const j = (s: any) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const { asiento_json, motivos_json, documento_json, resultado_json, ...resto } = f;
  return { ...resto, asiento: j(asiento_json), motivos: j(motivos_json) ?? [],
           documento: j(documento_json), resultado: j(resultado_json) };
}
