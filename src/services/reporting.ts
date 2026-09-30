import Database from "better-sqlite3";

// --- Bloque 3: Reportería ---
// Primera plantilla: Ingresos/Gastos. Diseñada para ser la misma para
// Diana y para cualquier oficina futura — nunca conoce nombres de cliente
// de antemano, siempre agrupa por código de cuenta del PUC (Plan Único de
// Cuentas colombiano), que es el estándar que usa cualquier oficina
// contable del país. Eso es lo que la hace escalable sin reescritura.

// Clase 4xxx = Ingresos, 5xxx = Gastos, 6xxx/7xxx = Costos (venta/producción).
// No se necesita más granularidad que el primer dígito para esta plantilla;
// las siguientes plantillas (márgenes, balance) sí bajarán a subcuentas.
export type PucCategory = "ingreso" | "gasto" | "costo" | "otro";

export function classifyPucAccount(accountCode: string): PucCategory {
  const firstDigit = accountCode.trim().charAt(0);
  if (firstDigit === "4") return "ingreso";
  if (firstDigit === "5") return "gasto";
  if (firstDigit === "6" || firstDigit === "7") return "costo";
  return "otro";
}

export type Client = {
  id: number;
  office_id: number;
  name: string;
};

export function getOrCreateClient(db: Database.Database, officeId: number, name: string): Client {
  const existing = db
    .prepare("SELECT * FROM clients WHERE office_id = ? AND name = ?")
    .get(officeId, name) as Client | undefined;
  if (existing) return existing;

  const info = db
    .prepare("INSERT INTO clients (office_id, name) VALUES (?, ?)")
    .run(officeId, name);
  return { id: Number(info.lastInsertRowid), office_id: officeId, name };
}

export function listClients(db: Database.Database, officeId: number): Client[] {
  return db.prepare("SELECT * FROM clients WHERE office_id = ? ORDER BY name").all(officeId) as Client[];
}

type FinancialRecordInput = {
  accountCode: string;
  accountName: string;
  amount: number;
  transactionDate: string; // YYYY-MM-DD
  source?: string;
};

export function insertFinancialRecords(
  db: Database.Database,
  officeId: number,
  clientId: number,
  records: FinancialRecordInput[]
): number {
  const insert = db.prepare(
    `INSERT INTO financial_records (office_id, client_id, account_code, account_name, amount, transaction_date, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction((rows: FinancialRecordInput[]) => {
    for (const r of rows) {
      insert.run(officeId, clientId, r.accountCode, r.accountName, r.amount, r.transactionDate, r.source || "manual");
    }
  });
  insertMany(records);
  return records.length;
}

type AccountBreakdownLine = {
  accountCode: string;
  accountName: string;
  total: number;
};

export type IncomeExpenseReport = {
  clientId: number;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  totalIngresos: number;
  totalGastos: number;
  totalCostos: number;
  utilidad: number; // ingresos - gastos - costos
  ingresosBreakdown: AccountBreakdownLine[];
  gastosBreakdown: AccountBreakdownLine[];
  costosBreakdown: AccountBreakdownLine[];
  comparativo: {
    // Variación % contra el mismo largo de período inmediatamente anterior
    // (ej. si el rango pedido es un mes, compara contra el mes previo).
    periodoAnteriorUtilidad: number | null;
    variacionUtilidadPct: number | null;
    // Promedio móvil de utilidad de los últimos 6 meses (excluyendo el
    // período actual), para dar una referencia más estable que solo "el
    // mes pasado" — es la misma base que alimentará la detección de
    // anomalías más adelante.
    promedioMovil6mUtilidad: number | null;
    desviacionVsPromedioPct: number | null;
  };
};

function sumByAccount(
  rows: { account_code: string; account_name: string; amount: number }[],
  category: PucCategory
): { total: number; breakdown: AccountBreakdownLine[] } {
  const filtered = rows.filter((r) => classifyPucAccount(r.account_code) === category);
  const byAccount = new Map<string, AccountBreakdownLine>();

  for (const r of filtered) {
    const key = r.account_code;
    const existing = byAccount.get(key);
    if (existing) {
      existing.total += r.amount;
    } else {
      byAccount.set(key, { accountCode: r.account_code, accountName: r.account_name, total: r.amount });
    }
  }

  const breakdown = Array.from(byAccount.values()).sort((a, b) => b.total - a.total);
  const total = breakdown.reduce((sum, b) => sum + b.total, 0);
  return { total, breakdown };
}

function shiftDateRangeBack(start: string, end: string): { start: string; end: string } {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const spanMs = endDate.getTime() - startDate.getTime();

  const prevEnd = new Date(startDate.getTime() - 86400000); // día anterior al inicio actual
  const prevStart = new Date(prevEnd.getTime() - spanMs);

  return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

function utilidadForRange(db: Database.Database, officeId: number, clientId: number, start: string, end: string): number | null {
  const rows = db
    .prepare(
      `SELECT account_code, account_name, amount FROM financial_records
       WHERE office_id = ? AND client_id = ? AND transaction_date BETWEEN ? AND ?`
    )
    .all(officeId, clientId, start, end) as { account_code: string; account_name: string; amount: number }[];

  if (rows.length === 0) return null;

  const ingresos = sumByAccount(rows, "ingreso").total;
  const gastos = sumByAccount(rows, "gasto").total;
  const costos = sumByAccount(rows, "costo").total;
  return ingresos - gastos - costos;
}

// Punto de entrada: genera el reporte Ingresos/Gastos para un cliente en
// un rango de fechas. No sabe nada de Diana ni de ninguna oficina en
// particular — todo lo que necesita lo recibe por parámetro.
export function generateIncomeExpenseReport(
  db: Database.Database,
  officeId: number,
  clientId: number,
  periodStart: string,
  periodEnd: string
): IncomeExpenseReport | null {
  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND office_id = ?").get(clientId, officeId) as
    | Client
    | undefined;
  if (!client) return null;

  const rows = db
    .prepare(
      `SELECT account_code, account_name, amount FROM financial_records
       WHERE office_id = ? AND client_id = ? AND transaction_date BETWEEN ? AND ?`
    )
    .all(officeId, clientId, periodStart, periodEnd) as { account_code: string; account_name: string; amount: number }[];

  const ingresos = sumByAccount(rows, "ingreso");
  const gastos = sumByAccount(rows, "gasto");
  const costos = sumByAccount(rows, "costo");
  const utilidad = ingresos.total - gastos.total - costos.total;

  // Comparativo contra el período inmediatamente anterior (mismo largo).
  const prevRange = shiftDateRangeBack(periodStart, periodEnd);
  const utilidadAnterior = utilidadForRange(db, officeId, clientId, prevRange.start, prevRange.end);
  const variacionUtilidadPct =
    utilidadAnterior !== null && utilidadAnterior !== 0
      ? ((utilidad - utilidadAnterior) / Math.abs(utilidadAnterior)) * 100
      : null;

  // Promedio móvil de los últimos 6 meses anteriores al inicio del período
  // pedido (no incluye el período actual, para no comparar el dato consigo
  // mismo).
  const sixMonthsBack = new Date(periodStart);
  sixMonthsBack.setMonth(sixMonthsBack.getMonth() - 6);
  const dayBeforeStart = new Date(new Date(periodStart).getTime() - 86400000);
  const movingAvgStart = sixMonthsBack.toISOString().slice(0, 10);
  const movingAvgEnd = dayBeforeStart.toISOString().slice(0, 10);

  const histRows = db
    .prepare(
      `SELECT account_code, account_name, amount, transaction_date FROM financial_records
       WHERE office_id = ? AND client_id = ? AND transaction_date BETWEEN ? AND ?`
    )
    .all(officeId, clientId, movingAvgStart, movingAvgEnd) as {
    account_code: string;
    account_name: string;
    amount: number;
    transaction_date: string;
  }[];

  let promedioMovil6mUtilidad: number | null = null;
  if (histRows.length > 0) {
    // Agrupa por mes calendario para promediar utilidad mensual, no
    // solo sumar todo el rango de 6 meses de una vez.
    const byMonth = new Map<string, typeof histRows>();
    for (const r of histRows) {
      const monthKey = r.transaction_date.slice(0, 7); // YYYY-MM
      if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
      byMonth.get(monthKey)!.push(r);
    }
    const monthlyUtilidades = Array.from(byMonth.values()).map((monthRows) => {
      const i = sumByAccount(monthRows, "ingreso").total;
      const g = sumByAccount(monthRows, "gasto").total;
      const c = sumByAccount(monthRows, "costo").total;
      return i - g - c;
    });
    promedioMovil6mUtilidad =
      monthlyUtilidades.reduce((sum, v) => sum + v, 0) / monthlyUtilidades.length;
  }

  const desviacionVsPromedioPct =
    promedioMovil6mUtilidad !== null && promedioMovil6mUtilidad !== 0
      ? ((utilidad - promedioMovil6mUtilidad) / Math.abs(promedioMovil6mUtilidad)) * 100
      : null;

  return {
    clientId,
    clientName: client.name,
    periodStart,
    periodEnd,
    totalIngresos: ingresos.total,
    totalGastos: gastos.total,
    totalCostos: costos.total,
    utilidad,
    ingresosBreakdown: ingresos.breakdown,
    gastosBreakdown: gastos.breakdown,
    costosBreakdown: costos.breakdown,
    comparativo: {
      periodoAnteriorUtilidad: utilidadAnterior,
      variacionUtilidadPct,
      promedioMovil6mUtilidad,
      desviacionVsPromedioPct,
    },
  };
}

// --- Datos de demostración ---
// Diana todavía no tiene histórico cargado. En vez de esperar, generamos
// 7 meses de movimientos plausibles para un cliente ficticio de PYME
// colombiana (los últimos 6 meses sirven de base para el promedio móvil,
// el 7º es "el mes actual" que se reporta) usando cuentas PUC reales.
// Queda marcado con source='demo' para poder distinguirlo y borrarlo
// fácilmente el día que entren datos reales.
const DEMO_ACCOUNTS: { code: string; name: string }[] = [
  { code: "4135", name: "Comercio al por mayor y al por menor" },
  { code: "4210", name: "Ingresos financieros" },
  { code: "5105", name: "Gastos de personal" },
  { code: "5110", name: "Honorarios" },
  { code: "5115", name: "Impuestos" },
  { code: "5120", name: "Arrendamientos" },
  { code: "5135", name: "Servicios" },
  { code: "6135", name: "Costo de mercancía vendida" },
];

// Generador determinista (sin Math.random) para que la demo sea
// reproducible entre corridas, como prefiere Diego.
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export function seedDemoFinancialData(
  db: Database.Database,
  officeId: number,
  clientName: string = "Cliente Demo PYME"
): { clientId: number; recordsInserted: number; months: string[] } {
  const client = getOrCreateClient(db, officeId, clientName);

  // Limpia demo previa de este cliente para poder regenerar sin duplicar.
  db.prepare("DELETE FROM financial_records WHERE client_id = ? AND source = 'demo'").run(client.id);

  const today = new Date();
  const months: string[] = [];
  const records: FinancialRecordInput[] = [];

  for (let monthsAgo = 6; monthsAgo >= 0; monthsAgo--) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 15);
    const monthKey = monthDate.toISOString().slice(0, 7);
    months.push(monthKey);
    const dateStr = `${monthKey}-15`;

    DEMO_ACCOUNTS.forEach((acc, idx) => {
      const seed = monthsAgo * 100 + idx * 7 + 1;
      const base =
        acc.code.startsWith("4") ? 18_000_000 : acc.code.startsWith("6") ? 7_000_000 : 2_500_000;
      // Variación ±15% para que no sea una línea recta, más una ligera
      // caída simulada en el mes más reciente (monthsAgo === 0) en
      // ingresos, para que la demo también dispare una anomalía real.
      const noise = 1 + (pseudoRandom(seed) - 0.5) * 0.3;
      const dip = monthsAgo === 0 && acc.code.startsWith("4") ? 0.82 : 1;
      const amount = Math.round(base * noise * dip);

      records.push({
        accountCode: acc.code,
        accountName: acc.name,
        amount,
        transactionDate: dateStr,
        source: "demo",
      });
    });
  }

  insertFinancialRecords(db, officeId, client.id, records);

  return { clientId: client.id, recordsInserted: records.length, months };
}
