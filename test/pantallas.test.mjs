// Pantallas del navegador: sirven solo con sesión, y la API no filtra el texto crudo de los PDF.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const PORT = 4200 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "clave-admin-de-prueba-1234";
let dir, dbPath, srv, A, cA;
const post = (u, b, c) => fetch(BASE + u, { method: "POST", headers: { "Content-Type": "application/json", ...(c ? { Cookie: c } : {}) }, body: JSON.stringify(b) });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulpo-pan-"));
  dbPath = join(dir, "t.db");
  srv = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], { env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, PULPO_ADMIN_KEY: ADMIN, PULPO_SESSION_SECRET: "w".repeat(40) }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  const adm = (await post("/api/acceso/admin", { clave: ADMIN })).headers.getSetCookie()[0].split(";")[0];
  const o = await (await post("/api/admin/oficinas", { name: "Oficina A" }, adm)).json();
  A = o.id;
  cA = (await post("/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: o.clave })).headers.getSetCookie()[0].split(";")[0];
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO documentos_procesados (office_id, documento_id, tipo_documento, estado, revision_humana, procesado_at, en_espera, origen, texto_pdf)
              VALUES (?, 'pdf-1', 'pdf', 'recibido', 'pendiente', ?, 1, 'pdf', 'TEXTO CONFIDENCIAL DE LA FACTURA')`).run(String(A), new Date().toISOString());
  db.close();
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

test("sin sesión, las pantallas mandan a Entrar", async () => {
  for (const p of ["/documentos.html", "/documento.html?id=x", "/cargar.html", "/clientes.html"]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    assert.equal(r.status, 302, p);
    assert.match(r.headers.get("location"), /^\/entrar\.html/);
  }
});

test("con sesión de oficina, las pantallas y sus recursos se sirven", async () => {
  for (const p of ["/documentos.html", "/documento.html", "/cargar.html", "/clientes.html", "/pulpo.css", "/pulpo.js", "/revision.html"]) {
    const r = await fetch(BASE + p, { headers: { Cookie: cA } });
    assert.equal(r.status, 200, p);
  }
});

test("la lista y el detalle no entregan el texto crudo del PDF", async () => {
  const lista = await (await fetch(`${BASE}/api/crews/oficinas/${A}/documentos`, { headers: { Cookie: cA } })).json();
  assert.equal(lista.documentos[0].estado_pulpo, "en_espera");
  assert.equal(lista.documentos[0].origen, "pdf");
  const det = await (await fetch(`${BASE}/api/crews/oficinas/${A}/documentos/pdf-1`, { headers: { Cookie: cA } })).json();
  assert.ok(!JSON.stringify(lista).includes("CONFIDENCIAL"));
  assert.ok(!JSON.stringify(det).includes("CONFIDENCIAL"));
});

test("Oficinas: la lista del administrador trae tope, uso y documentos por estado; la oficina no la ve", async () => {
  const adm = (await post("/api/acceso/admin", { clave: ADMIN })).headers.getSetCookie()[0].split(";")[0];
  const put = await fetch(BASE + `/api/admin/oficinas/${A}/tope`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: adm }, body: JSON.stringify({ tope: 50 }) });
  assert.equal(put.status, 200);
  const lista = await (await fetch(BASE + "/api/admin/oficinas", { headers: { Cookie: adm } })).json();
  const a = lista.find((o) => o.id === A);
  assert.equal(a.tope, 50);
  assert.equal(a.usados, 0);
  assert.equal(a.nivel, "normal");
  assert.equal(a.documentos.en_espera, 1);
  assert.equal(a.documentos.total, 1);
  assert.equal((await fetch(BASE + "/api/admin/oficinas", { headers: { Cookie: cA } })).status, 403);
  // La página de inicio sirve solo con sesión y es la de Oficinas.
  assert.equal((await fetch(BASE + "/", { redirect: "manual" })).status, 302);
  const html = await (await fetch(BASE + "/", { headers: { Cookie: adm } })).text();
  assert.match(html, /<title>Oficinas/);
});
