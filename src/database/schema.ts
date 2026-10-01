import Database from "better-sqlite3";

export function initializeDatabase(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS offices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      agent_type TEXT NOT NULL,
      content TEXT NOT NULL,
      response TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      agent_type TEXT NOT NULL,
      messages TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );

    CREATE TABLE IF NOT EXISTS directives (
      agent_type TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_type TEXT NOT NULL,
      office_id INTEGER,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );

    -- Bloque 1 (Gmail): cada oficina conecta su propia cuenta. Guardamos el
    -- refresh_token (vive indefinidamente) y cacheamos el access_token
    -- (vive ~1h) junto a su expiración, para no pedir uno nuevo en cada poll.
    CREATE TABLE IF NOT EXISTS gmail_connections (
      office_id INTEGER PRIMARY KEY,
      email_address TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      token_expiry INTEGER,
      last_polled_at DATETIME,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );

    -- Evita reprocesar el mismo correo en cada ciclo de polling: cada
    -- gmail_message_id se marca apenas se convierte en tarea (o se descarta).
    CREATE TABLE IF NOT EXISTS processed_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      gmail_message_id TEXT NOT NULL,
      task_id INTEGER,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      UNIQUE (office_id, gmail_message_id)
    );
  `);

  // Bloque 2 (Drive): columnas nuevas sobre tablas que ya existen en
  // producción. ALTER TABLE no soporta "IF NOT EXISTS" en SQLite, así que
  // se envuelve en try/catch para tolerar reejecutar esto contra una DB
  // que ya las tiene (falla con "duplicate column name", se ignora).
  try {
    db.exec(`ALTER TABLE gmail_connections ADD COLUMN drive_folder_id TEXT`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN drive_context TEXT`);
  } catch {
    // ya existe, no pasa nada
  }

  // Guarda la decisión del clasificador (¿amerita Drive?) para que
  // /tasks/:id/execute la use más tarde, sin tener que reclasificar.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN needs_drive_context INTEGER DEFAULT 0`);
  } catch {
    // ya existe, no pasa nada
  }

  // --- Bloque 3 (Reportería): clientes por oficina + libro de movimientos ---
  // Diseñado para ser genérico entre oficinas desde el día 1: el reporte
  // nunca lee "los clientes de Diana", lee `clients` filtrado por
  // office_id, y nunca agrupa por texto libre, agrupa por account_code del
  // PUC (Plan Único de Cuentas colombiano) — así la misma plantilla sirve
  // para cualquier oficina sin tocar código, solo cambia qué datos entran.
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      UNIQUE (office_id, name)
    );

    -- Una fila = un movimiento contable (ingreso, gasto, costo...) de un
    -- cliente de una oficina, ya mapeado a un account_code del PUC. Esta
    -- tabla es la única fuente que lee cualquier plantilla de reporte —
    -- de dónde salió el dato (Drive, CSV subido, DIAN...) es un problema
    -- de ingesta, resuelto antes de llegar aquí, no un problema del reporte.
    CREATE TABLE IF NOT EXISTS financial_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      account_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      amount REAL NOT NULL,
      transaction_date TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_financial_records_lookup
      ON financial_records (office_id, client_id, transaction_date);
  `);

  // --- Bloque 4 (Aprobaciones): mismo patrón que needs_drive_context —
  // el propio clasificador decide, al vuelo, si el resultado de esta tarea
  // amerita que un humano lo revise antes de darlo por bueno (ej. algo que
  // sale de la oficina hacia un tercero, compromete plata o tiene
  // implicación legal/tributaria) o si se puede dar por auto-resuelto
  // (ej. una consulta interna, un resumen, algo puramente informativo).
  // La decisión se guarda en needs_approval al clasificar; al ejecutar,
  // si needs_approval=1 la tarea completada queda con approval_status
  // ='pending' en vez de darse por cerrada silenciosamente.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN needs_approval INTEGER DEFAULT 0`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN approval_status TEXT`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN approval_note TEXT`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN approved_at DATETIME`);
  } catch {
    // ya existe, no pasa nada
  }

  // Notificación activa de aprobaciones pendientes: marca cuándo se avisó
  // por correo, para no reenviar la misma tarea en cada ciclo de polling
  // (cada 5 min) mientras siga sin resolver.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN approval_notified_at DATETIME`);
  } catch {
    // ya existe, no pasa nada
  }

  // --- Administrativo extendido: auto-triage de tickets ---
  // Mismo patrón que needs_drive_context / needs_approval: el propio
  // clasificador decide, en la misma llamada, el tipo de ticket (factura,
  // rut, datos, consulta, reclamo, otro) y su urgencia (1-5, 5 = más
  // urgente). Solo tiene sentido para tareas ruteadas a "administrativo",
  // pero se guarda igual para cualquier tarea por simplicidad del esquema.
  // client_id vincula el ticket a un registro de `clients` (tabla ya
  // existente desde Reportería) cuando se puede identificar al remitente —
  // nullable porque hoy no hay match automático por correo, es manual.
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN ticket_type TEXT`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN urgency INTEGER`);
  } catch {
    // ya existe, no pasa nada
  }

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN client_id INTEGER REFERENCES clients(id)`);
  } catch {
    // ya existe, no pasa nada
  }

  // --- Legal: compliance checks mecánicos (primer incremento, ver legal.ts) ---
  // Determinísticos, no pasan por Claude. Deliberadamente sin nada que
  // dependa de una consulta en vivo a la DIAN todavía — eso queda para
  // una fase posterior, una vez se defina el acceso a esas APIs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS legal_config (
      office_id INTEGER PRIMARY KEY,
      smlv REAL NOT NULL DEFAULT 1750905,
      rut_update_threshold_days INTEGER NOT NULL DEFAULT 365,
      aportes_grace_days INTEGER NOT NULL DEFAULT 45,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );

    -- Hechos que la oficina ya conoce o registra manualmente sobre un
    -- cliente, base para correr los 3 chequeos mecánicos. Un cliente =
    -- una fila (se actualiza por campo, no se acumula historial aquí).
    CREATE TABLE IF NOT EXISTS compliance_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      rut_fecha_actualizacion TEXT,
      aportes_fecha_ultimo_pago TEXT,
      salario_minimo_empleado REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      FOREIGN KEY (client_id) REFERENCES clients(id),
      UNIQUE (office_id, client_id)
    );

    -- Resultado de la última corrida de chequeos. Se reemplaza en cada
    -- corrida (ver runComplianceChecks) — refleja el estado actual, no
    -- un historial de alertas pasadas.
    CREATE TABLE IF NOT EXISTS compliance_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      check_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );
  `);
}
