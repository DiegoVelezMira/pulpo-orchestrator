// Pruebas del acceso por oficina. Arranca el servidor real con una base temporal y lo consulta por HTTP.
// Uso: npm test   (Node 20)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "clave-admin-de-prueba-1234";
let dir, dbPath, srv;

async function esperarServidor() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("El servidor no arrancó");
}
function cookieDe(res) {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("pulpo_sesion="));
  return c ? c.split(";")[0] : null;
}
const post = (url, body, cookie, extra = {}) =>
  fetch(BASE + url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
const get = (url, cookie) => fetch(BASE + url, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulpo-test-"));
  dbPath = join(dir, "t.db");
  srv = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, PULPO_ADMIN_KEY: ADMIN, PULPO_SESSION_SECRET: "x".repeat(40), PULPO_BLOQUEO_MIN: "5" },
    stdio: "ignore",
  });
  await esperarServidor();
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

let cookieAdmin, A, B, claveA, claveB, cookieA;

test("sin sesión: la API responde 401, las páginas redirigen y /health es público", async () => {
  assert.equal((await get("/api/crews/oficinas/1/documentos")).status, 401);
  assert.equal((await get("/offices")).status, 401);
  const r = await get("/cargar.html");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/entrar\.html/);
  assert.equal((await get("/health")).status, 200);
  assert.equal((await get("/entrar.html")).status, 200);
});

test("administrador: clave incorrecta falla, la correcta crea oficinas con clave", async () => {
  assert.equal((await post("/api/acceso/admin", { clave: "mala" })).status, 401);
  const ok = await post("/api/acceso/admin", { clave: ADMIN });
  assert.equal(ok.status, 200);
  cookieAdmin = cookieDe(ok);
  assert.ok(cookieAdmin);
  const a = await (await post("/api/admin/oficinas", { name: "Oficina A" }, cookieAdmin)).json();
  const b = await (await post("/api/admin/oficinas", { name: "Oficina B" }, cookieAdmin)).json();
  assert.match(a.clave, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  ({ id: A, clave: claveA } = a); ({ id: B, clave: claveB } = b);
  // La clave no queda en texto plano en la base
  const db = new Database(dbPath, { readonly: true });
  const fila = db.prepare("SELECT clave_hash FROM offices WHERE id = ?").get(A);
  db.close();
  assert.ok(fila.clave_hash.startsWith("scrypt$"));
  assert.ok(!fila.clave_hash.includes(claveA));
});

test("oficina A entra con su clave y ve lo suyo, no lo de B", async () => {
  assert.equal((await post("/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: claveB })).status, 401, "la clave de B no abre A");
  const r = await post("/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: claveA });
  assert.equal(r.status, 200);
  cookieA = cookieDe(r);
  assert.match((await fetch(BASE + "/api/acceso/estado", { headers: { Cookie: cookieA } }).then((x) => x.json())).nombre, /Laura/);
  assert.equal((await get(`/api/crews/oficinas/${A}/documentos`, cookieA)).status, 200);
  assert.equal((await get(`/api/crews/oficinas/${B}/documentos`, cookieA)).status, 403);
  assert.equal((await get(`/offices/${B}/tasks`, cookieA)).status, 403);
  assert.equal((await get("/offices", cookieA)).status, 403, "la lista de oficinas es del administrador");
  assert.equal((await get("/directives", cookieA)).status, 403);
  assert.equal((await get("/api/admin/oficinas", cookieA)).status, 403);
  assert.equal((await post("/api/crews/contable/lote", { officeId: B, archivos: [] }, cookieA)).status, 403);
});

test("una tarea de otra oficina no se puede tocar", async () => {
  const db = new Database(dbPath);
  const id = db.prepare("INSERT INTO tasks (office_id, agent_type, content, status) VALUES (?, 'contable', 'prueba', 'pending')").run(B).lastInsertRowid;
  db.close();
  assert.equal((await post(`/tasks/${id}/approve`, {}, cookieA)).status, 403);
});

test("el administrador ve todas las oficinas", async () => {
  assert.equal((await get(`/api/crews/oficinas/${B}/documentos`, cookieAdmin)).status, 200);
  const lista = await (await get("/api/admin/oficinas", cookieAdmin)).json();
  assert.equal(lista.length >= 2, true);
});

test("una cookie alterada se rechaza", async () => {
  const [nombre, valor] = cookieA.split("=");
  const [payload, firma] = valor.split(".");
  const falso = Buffer.from(JSON.stringify({ r: "a", o: null, n: "x", e: Date.now() + 1e6 })).toString("base64url");
  assert.equal((await get("/api/admin/oficinas", `${nombre}=${falso}.${firma}`)).status, 401);
  assert.equal((await get("/api/admin/oficinas", `${nombre}=${payload}.${firma}x`)).status, 401);
});

test("bloqueo: tres fallos bloquean, incluso con la clave correcta", async () => {
  const c = await (await post("/api/admin/oficinas", { name: "Oficina C" }, cookieAdmin)).json();
  assert.equal((await post("/api/acceso/entrar", { officeId: c.id, nombre: "Ana", clave: "mala1" })).status, 401);
  assert.equal((await post("/api/acceso/entrar", { officeId: c.id, nombre: "Ana", clave: "mala2" })).status, 401);
  const tercero = await post("/api/acceso/entrar", { officeId: c.id, nombre: "Ana", clave: "mala3" });
  assert.equal(tercero.status, 429);
  assert.match((await tercero.json()).error, /espera \d+ minuto/);
  assert.equal((await post("/api/acceso/entrar", { officeId: c.id, nombre: "Ana", clave: c.clave })).status, 429);
});

test("cambiar la clave invalida la anterior y desbloquea", async () => {
  const nueva = await (await post(`/api/admin/oficinas/${A}/clave`, {}, cookieAdmin)).json();
  assert.equal((await post("/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: claveA })).status, 401);
  assert.equal((await post("/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: nueva.clave })).status, 200);
});

test("peticiones de otro origen no pasan", async () => {
  const r = await post("/api/acceso/admin", { clave: ADMIN }, null, { Origin: "https://otro-sitio.example" });
  assert.equal(r.status, 403);
});

test("el nombre del historial sale de la sesión, no del navegador", async () => {
  // Un documento solo se revisa si ya tiene cliente.
  const cli = await (await post(`/api/crews/oficinas/${A}/clientes`, { nit: "900111222-3", nombre: "Cliente de prueba" }, cookieA)).json();
  const db = new Database(dbPath);
  db.prepare("INSERT INTO documentos_procesados (office_id, documento_id, estado, revision_humana, procesado_at, cliente_id) VALUES (?, 'DOC-1', 'procesado', 'pendiente', ?, ?)").run(String(A), new Date().toISOString(), cli.cliente.id);
  db.close();
  const r = await post(`/api/crews/oficinas/${A}/documentos/DOC-1/revision`, { decision: "aprobado", revisor: "Nombre Falso" }, cookieA);
  assert.equal(r.status, 200);
  const db2 = new Database(dbPath, { readonly: true });
  const f = db2.prepare("SELECT revisado_por FROM documentos_procesados WHERE office_id = ? AND documento_id = 'DOC-1'").get(String(A));
  db2.close();
  assert.equal(f.revisado_por, "Laura");
});
