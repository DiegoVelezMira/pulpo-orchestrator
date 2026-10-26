import Database from 'better-sqlite3';

// Tope mensual por oficina: se mide SOLO en PDF leídos con IA (no cuentan los XML, los PDF sin texto ni los repetidos).
// Sin tope fijado (NULL) no hay límite. Al llegar al tope los PDF nuevos quedan "En espera por tope".

export type NivelTope = 'normal' | 'aviso' | 'alto' | 'agotado' | 'sin_tope';
export const UMBRAL_AVISO = 0.6;
export const UMBRAL_ALTO = 0.85;

export function iniciarTope(db: Database.Database) {
  const cols = (db.prepare('PRAGMA table_info(offices)').all() as any[]).map((c) => c.name);
  if (!cols.includes('tope_pdf_mes')) db.exec('ALTER TABLE offices ADD COLUMN tope_pdf_mes INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lecturas_ia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id TEXT NOT NULL,
      mes TEXT NOT NULL,
      huella TEXT,
      modelo TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      creado_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lecturas_ia_mes ON lecturas_ia (office_id, mes);
  `);
}

// El mes corre en hora de Colombia (UTC-5, sin horario de verano).
export const mesDe = (ms: number = Date.now()) => new Date(ms - 5 * 3600_000).toISOString().slice(0, 7);

export function estadoTope(db: Database.Database, officeId: string | number, mes = mesDe()) {
  const o = db.prepare('SELECT tope_pdf_mes FROM offices WHERE id = ?').get(Number(officeId)) as { tope_pdf_mes: number | null } | undefined;
  const tope = o?.tope_pdf_mes ?? null;
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS to_ FROM lecturas_ia WHERE office_id = ? AND mes = ?')
    .get(String(officeId), mes) as { n: number; ti: number; to_: number };
  const porcentaje = tope ? r.n / tope : null;
  let nivel: NivelTope = 'sin_tope';
  if (tope !== null) nivel = r.n >= tope ? 'agotado' : porcentaje! >= UMBRAL_ALTO ? 'alto' : porcentaje! >= UMBRAL_AVISO ? 'aviso' : 'normal';
  return { mes, tope, usados: r.n, restantes: tope === null ? null : Math.max(0, tope - r.n), porcentaje, nivel, tokens_in: r.ti, tokens_out: r.to_ };
}

export const hayCupo = (db: Database.Database, officeId: string | number) => {
  const e = estadoTope(db, officeId);
  return e.tope === null || e.usados < e.tope;
};

export function registrarLectura(db: Database.Database, officeId: string | number, huella: string | null, modelo: string, tin: number, tout: number) {
  db.prepare('INSERT INTO lecturas_ia (office_id, mes, huella, modelo, tokens_in, tokens_out, creado_at) VALUES (?,?,?,?,?,?,?)')
    .run(String(officeId), mesDe(), huella, modelo, tin, tout, new Date().toISOString());
}

export function fijarTope(db: Database.Database, officeId: number, tope: number | null): boolean {
  return db.prepare('UPDATE offices SET tope_pdf_mes = ? WHERE id = ?').run(tope, officeId).changes > 0;
}
