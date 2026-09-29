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
}
