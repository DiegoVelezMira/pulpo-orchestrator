import Database from 'better-sqlite3';

// Clientes de una oficina: las empresas o personas a las que la oficina les lleva la contabilidad.
// El perfil tributario (agente retenedor, gran contribuyente) vive en cada cliente, no en la oficina.
// Cada cliente puede tener varios NIT conocidos (el principal y los que Pulpo aprende cuando una persona
// le asigna un documento). Los NIT se comparan sin dígito de verificación.

export const ESTADOS_PULPO = ['recibido', 'leido', 'necesita_ayuda', 'en_espera', 'revisado', 'exportado'] as const;
export type EstadoPulpo = (typeof ESTADOS_PULPO)[number];

// "901979163-2", "901979163 - 2", "901.979.163-2" y "901979163" son el mismo NIT.
// Sin guion, un número de 10 dígitos se toma como NIT + dígito de verificación.
export function nitBase(valor: unknown): string {
  const t = String(valor ?? '').trim();
  if (!t) return '';
  const i = t.indexOf('-');
  const base = (i >= 0 ? t.slice(0, i) : t).replace(/\D/g, '');
  return i < 0 && base.length === 10 ? base.slice(0, 9) : base;
}

export function crearTablasClientes(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      nit TEXT NOT NULL,
      nombre TEXT NOT NULL,
      agente_retenedor_renta INTEGER NOT NULL DEFAULT 0,
      gran_contribuyente INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      UNIQUE (office_id, nit)
    );
    CREATE TABLE IF NOT EXISTS clientes_nits (
      office_id INTEGER NOT NULL,
      nit TEXT NOT NULL,
      cliente_id INTEGER NOT NULL,
      PRIMARY KEY (office_id, nit),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
    );
  `);
}

// Migra el perfil tributario único por oficina (modelo anterior) a un cliente, y le asigna lo ya procesado.
export function migrarPerfilesDeOficina(db: Database.Database) {
  const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='office_tax_profiles'").get();
  if (!existe) return;
  const perfiles = db.prepare('SELECT * FROM office_tax_profiles').all() as any[];
  for (const p of perfiles) {
    const nit = nitBase(p.nit);
    if (!nit) continue;
    let c = db.prepare('SELECT id FROM clientes WHERE office_id = ? AND nit = ?').get(p.office_id, nit) as any;
    if (!c) {
      c = { id: Number(crearCliente(db, p.office_id, { nit, nombre: p.razon_social || `NIT ${nit}`, agente_retenedor_renta: p.agente_retenedor_renta === 1, gran_contribuyente: p.gran_contribuyente === 1 }).id) };
    }
    db.prepare(
      "UPDATE documentos_procesados SET cliente_id = ?, rol_cliente = COALESCE(rol_cliente, 'comprador') WHERE office_id = ? AND cliente_id IS NULL"
    ).run(c.id, String(p.office_id));
  }
}

export type DatosCliente = { nit: string; nombre: string; agente_retenedor_renta?: boolean; gran_contribuyente?: boolean };

export function crearCliente(db: Database.Database, officeId: number, d: DatosCliente) {
  const nit = nitBase(d.nit);
  const info = db
    .prepare('INSERT INTO clientes (office_id, nit, nombre, agente_retenedor_renta, gran_contribuyente) VALUES (?, ?, ?, ?, ?)')
    .run(officeId, nit, d.nombre.trim(), d.agente_retenedor_renta ? 1 : 0, d.gran_contribuyente ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO clientes_nits (office_id, nit, cliente_id) VALUES (?, ?, ?)').run(officeId, nit, id);
  return obtenerCliente(db, officeId, id)!;
}

export function obtenerCliente(db: Database.Database, officeId: number, id: number) {
  return db.prepare('SELECT * FROM clientes WHERE office_id = ? AND id = ?').get(officeId, id) as any | undefined;
}

export function perfilDeCliente(c: any) {
  return { agente_retenedor_renta: c.agente_retenedor_renta === 1, gran_contribuyente: c.gran_contribuyente === 1 };
}

// Busca el cliente de un documento por sus NIT, en orden de prioridad (primero el comprador, luego el vendedor).
export function buscarClientePorNits(db: Database.Database, officeId: number, nits: { nit: unknown; rol: 'comprador' | 'vendedor' }[]) {
  for (const { nit, rol } of nits) {
    const n = nitBase(nit);
    if (!n) continue;
    const f = db
      .prepare('SELECT c.* FROM clientes_nits k JOIN clientes c ON c.id = k.cliente_id WHERE k.office_id = ? AND k.nit = ?')
      .get(officeId, n) as any;
    if (f) return { cliente: f, rol };
  }
  return null;
}

// Pulpo aprende: este NIT, visto en un documento, pertenece a este cliente.
export function aprenderNit(db: Database.Database, officeId: number, nit: unknown, clienteId: number) {
  const n = nitBase(nit);
  if (n) db.prepare('INSERT OR REPLACE INTO clientes_nits (office_id, nit, cliente_id) VALUES (?, ?, ?)').run(officeId, n, clienteId);
}

// Los seis estados que ve la persona, derivados de lo que se guarda de cada documento.
export function estadoPulpo(f: {
  estado: string; revision_humana: string; exportado_at?: string | null; en_espera?: number | null; cliente_id?: number | null;
}): EstadoPulpo {
  if (f.exportado_at) return 'exportado';
  if (f.en_espera === 1) return 'en_espera';
  if (f.estado === 'recibido') return 'recibido';
  if (f.estado === 'sin_cliente' || f.estado === 'rechazado' || !f.cliente_id) return 'necesita_ayuda';
  if (f.revision_humana === 'pendiente') return 'necesita_ayuda';
  if (f.revision_humana === 'aprobado' || f.revision_humana === 'corregido') return 'revisado';
  return 'leido';
}

export function conteosPorEstado(filas: { estado_pulpo: EstadoPulpo }[]) {
  const c: Record<EstadoPulpo | 'total', number> = { recibido: 0, leido: 0, necesita_ayuda: 0, en_espera: 0, revisado: 0, exportado: 0, total: 0 };
  for (const f of filas) { c[f.estado_pulpo]++; c.total++; }
  return c;
}
