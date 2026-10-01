import Database from "better-sqlite3";

// --- Legal: compliance checks mecánicos (primer incremento) ---
// Mismo principio que las anomalías de Reportería: todo lo que necesita
// vive en estas tablas, nunca conoce el nombre de un cliente de antemano.
// A diferencia de los otros bloques, estos chequeos son determinísticos
// (comparaciones de fecha/monto) — no pasan por Claude, no hay
// ambigüedad que resolver, solo reglas verificables. Deliberadamente sin
// nada que dependa de una consulta en vivo a la DIAN (RUT activo/inactivo
// real, etc.) — eso es una fase posterior, una vez se defina el acceso a
// esas APIs.

export type LegalConfig = {
  office_id: number;
  smlv: number;
  rut_update_threshold_days: number;
  aportes_grace_days: number;
};

// SMLV 2026 Colombia: $1.750.905 (Decretos 1469/1470 de diciembre de
// 2025; monto bajo revisión del Consejo de Estado al momento de escribir
// esto, pero vigente). Queda como default editable por oficina vía
// /legal/config, no hardcodeado en el resto del código, para no tener
// que tocar la lógica de chequeo cada vez que cambie.
const DEFAULT_SMLV = 1_750_905;
const DEFAULT_RUT_THRESHOLD_DAYS = 365;
const DEFAULT_APORTES_GRACE_DAYS = 45;

export function getLegalConfig(db: Database.Database, officeId: number): LegalConfig {
  const row = db.prepare("SELECT * FROM legal_config WHERE office_id = ?").get(officeId) as
    | LegalConfig
    | undefined;
  if (row) return row;
  return {
    office_id: officeId,
    smlv: DEFAULT_SMLV,
    rut_update_threshold_days: DEFAULT_RUT_THRESHOLD_DAYS,
    aportes_grace_days: DEFAULT_APORTES_GRACE_DAYS,
  };
}

export function setLegalConfig(
  db: Database.Database,
  officeId: number,
  partial: Partial<Omit<LegalConfig, "office_id">>
): LegalConfig {
  const current = getLegalConfig(db, officeId);
  const merged: LegalConfig = { ...current, ...partial, office_id: officeId };
  db.prepare(
    `INSERT INTO legal_config (office_id, smlv, rut_update_threshold_days, aportes_grace_days)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(office_id) DO UPDATE SET
       smlv = excluded.smlv,
       rut_update_threshold_days = excluded.rut_update_threshold_days,
       aportes_grace_days = excluded.aportes_grace_days`
  ).run(merged.office_id, merged.smlv, merged.rut_update_threshold_days, merged.aportes_grace_days);
  return merged;
}

export type ComplianceFacts = {
  id: number;
  office_id: number;
  client_id: number;
  rut_fecha_actualizacion: string | null;
  aportes_fecha_ultimo_pago: string | null;
  salario_minimo_empleado: number | null;
  updated_at: string;
};

// Upsert parcial: cada llamada solo trae los campos que cambian, el resto
// se conserva (mismo patrón que PUT /directives, pero a nivel de fila).
export function upsertComplianceFacts(
  db: Database.Database,
  officeId: number,
  clientId: number,
  facts: Partial<Pick<ComplianceFacts, "rut_fecha_actualizacion" | "aportes_fecha_ultimo_pago" | "salario_minimo_empleado">>
): ComplianceFacts {
  const existing = getComplianceFacts(db, officeId, clientId);

  const merged = {
    rut_fecha_actualizacion:
      facts.rut_fecha_actualizacion !== undefined ? facts.rut_fecha_actualizacion : existing?.rut_fecha_actualizacion ?? null,
    aportes_fecha_ultimo_pago:
      facts.aportes_fecha_ultimo_pago !== undefined ? facts.aportes_fecha_ultimo_pago : existing?.aportes_fecha_ultimo_pago ?? null,
    salario_minimo_empleado:
      facts.salario_minimo_empleado !== undefined ? facts.salario_minimo_empleado : existing?.salario_minimo_empleado ?? null,
  };

  db.prepare(
    `INSERT INTO compliance_facts (office_id, client_id, rut_fecha_actualizacion, aportes_fecha_ultimo_pago, salario_minimo_empleado, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(office_id, client_id) DO UPDATE SET
       rut_fecha_actualizacion = excluded.rut_fecha_actualizacion,
       aportes_fecha_ultimo_pago = excluded.aportes_fecha_ultimo_pago,
       salario_minimo_empleado = excluded.salario_minimo_empleado,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    officeId,
    clientId,
    merged.rut_fecha_actualizacion,
    merged.aportes_fecha_ultimo_pago,
    merged.salario_minimo_empleado
  );

  return getComplianceFacts(db, officeId, clientId)!;
}

export function getComplianceFacts(
  db: Database.Database,
  officeId: number,
  clientId: number
): ComplianceFacts | undefined {
  return db
    .prepare("SELECT * FROM compliance_facts WHERE office_id = ? AND client_id = ?")
    .get(officeId, clientId) as ComplianceFacts | undefined;
}

export type ComplianceCheckType = "rut_vencido" | "aportes_vencidos" | "salario_bajo_minimo";

export type ComplianceFlag = {
  id: number;
  office_id: number;
  client_id: number;
  check_type: ComplianceCheckType;
  severity: "warning" | "critical";
  message: string;
  detected_at: string;
};

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}

// Corre los 3 chequeos mecánicos contra los hechos registrados de un
// cliente. Determinístico, sin llamadas a Claude. Reemplaza las flags
// anteriores de este cliente en vez de acumularlas: cada corrida refleja
// el estado actual, no un historial de alertas pasadas (igual que las
// anomalías de Reportería no se acumulan, se recalculan).
export function runComplianceChecks(db: Database.Database, officeId: number, clientId: number): ComplianceFlag[] {
  const facts = getComplianceFacts(db, officeId, clientId);
  const config = getLegalConfig(db, officeId);

  db.prepare("DELETE FROM compliance_flags WHERE office_id = ? AND client_id = ?").run(officeId, clientId);

  if (!facts) return [];

  const newFlags: { check_type: ComplianceCheckType; severity: "warning" | "critical"; message: string }[] = [];

  if (facts.rut_fecha_actualizacion) {
    const days = daysSince(facts.rut_fecha_actualizacion);
    if (days > config.rut_update_threshold_days) {
      newFlags.push({
        check_type: "rut_vencido",
        severity: "warning",
        message: `RUT sin actualizar hace ${days} días (umbral configurado: ${config.rut_update_threshold_days}). Revisar si hubo cambios no reportados.`,
      });
    }
  }

  if (facts.aportes_fecha_ultimo_pago) {
    const days = daysSince(facts.aportes_fecha_ultimo_pago);
    if (days > config.aportes_grace_days) {
      newFlags.push({
        check_type: "aportes_vencidos",
        severity: "critical",
        message: `Último pago de aportes parafiscales/seguridad social hace ${days} días (margen configurado: ${config.aportes_grace_days}). Posible mora.`,
      });
    }
  }

  if (facts.salario_minimo_empleado !== null && facts.salario_minimo_empleado < config.smlv) {
    newFlags.push({
      check_type: "salario_bajo_minimo",
      severity: "critical",
      message: `Salario reportado ($${facts.salario_minimo_empleado.toLocaleString("es-CO")}) por debajo del SMLV vigente ($${config.smlv.toLocaleString("es-CO")}). Riesgo de incumplimiento laboral.`,
    });
  }

  const insert = db.prepare(
    `INSERT INTO compliance_flags (office_id, client_id, check_type, severity, message) VALUES (?, ?, ?, ?, ?)`
  );
  for (const f of newFlags) {
    insert.run(officeId, clientId, f.check_type, f.severity, f.message);
  }

  return db
    .prepare("SELECT * FROM compliance_flags WHERE office_id = ? AND client_id = ?")
    .all(officeId, clientId) as ComplianceFlag[];
}

export function runComplianceChecksForOffice(db: Database.Database, officeId: number): ComplianceFlag[] {
  const clients = db.prepare("SELECT id FROM clients WHERE office_id = ?").all(officeId) as { id: number }[];
  const all: ComplianceFlag[] = [];
  for (const c of clients) {
    all.push(...runComplianceChecks(db, officeId, c.id));
  }
  return all;
}

export function listComplianceFlags(
  db: Database.Database,
  officeId: number
): (ComplianceFlag & { client_name: string })[] {
  return db
    .prepare(
      `SELECT cf.*, c.name as client_name FROM compliance_flags cf
       JOIN clients c ON c.id = cf.client_id
       WHERE cf.office_id = ?
       ORDER BY CASE cf.severity WHEN 'critical' THEN 0 ELSE 1 END, cf.id DESC`
    )
    .all(officeId) as (ComplianceFlag & { client_name: string })[];
}
