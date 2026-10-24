// Pruebas de clientes por oficina, los seis estados, revisión, elección de cliente y CSV por cliente.
// Arranca el servidor real con una base temporal. Uso: npm test (Node 20).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
require("ts-node/register");
const { nitBase, estadoPulpo, crearTablasClientes, migrarPerfilesDeOficina } = require("../src/services/clientes");
const { crearTablaDocumentos } = require("../src/services/documentos-procesados");

const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "clave-admin-de-prueba-1234";
let dir, dbPath, srv, cA, cB, A, B, xmlDir;

const llamar = (metodo, url, body, cookie) =>
  fetch(BASE + url, { method: metodo, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const cookieDe = (r) => r.headers.getSetCookie().find((x) => x.startsWith("pulpo_sesion=")).split(";")[0];
const asiento = [
  { cuenta: "5135 Servicios", debito: 100, credito: 0 },
  { cuenta: "2205 Proveedores", debito: 0, credito: 100 },
];
function doc(db, oficina, id, { estado = "procesado", rev = "no_aplica", cliente = null, exportado = null, enEspera = 0, aS = asiento } = {}) {
  db.prepare(
    `INSERT INTO documentos_procesados (office_id, documento_id, tipo_documento, fecha_documento, proveedor, nit_proveedor, estado, asiento_json, revision_humana, procesado_at, cliente_id, exportado_at, en_espera)
     VALUES (?, ?, 'factura_compra', '2026-10-08', 'Proveedor', '900111222', ?, ?, ?, ?, ?, ?, ?)`
  ).run(String(oficina), id, estado, JSON.stringify(aS), rev, new Date().toISOString(), cliente, exportado, enEspera);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulpo-cli-"));
  dbPath = join(dir, "t.db");
  xmlDir = join(dir, "xml");
  execFileSync("python3", ["crews/generar_xml_sinteticos.py", xmlDir], { stdio: "ignore" });
  srv = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, PULPO_ADMIN_KEY: ADMIN, PULPO_SESSION_SECRET: "y".repeat(40) },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  const adm = cookieDe(await llamar("POST", "/api/acceso/admin", { clave: ADMIN }));
  const a = await (await llamar("POST", "/api/admin/oficinas", { name: "Oficina A" }, adm)).json();
  const b = await (await llamar("POST", "/api/admin/oficinas", { name: "Oficina B" }, adm)).json();
  A = a.id; B = b.id;
  cA = cookieDe(await llamar("POST", "/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: a.clave }));
  cB = cookieDe(await llamar("POST", "/api/acceso/entrar", { officeId: B, nombre: "Pedro", clave: b.clave }));
});
after(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }); });

test("nitBase: los formatos del mismo NIT coinciden", () => {
  for (const f of ["901979163-2", "901979163 - 2", "901.979.163-2", "901979163", "9019791632"]) assert.equal(nitBase(f), "901979163", f);
  assert.equal(nitBase(""), "");
  assert.equal(nitBase(null), "");
});

test("estadoPulpo: los seis estados salen de lo guardado", () => {
  const base = { estado: "procesado", revision_humana: "no_aplica", cliente_id: 1 };
  assert.equal(estadoPulpo({ ...base }), "leido");
  assert.equal(estadoPulpo({ ...base, revision_humana: "pendiente" }), "necesita_ayuda");
  assert.equal(estadoPulpo({ ...base, revision_humana: "aprobado" }), "revisado");
  assert.equal(estadoPulpo({ ...base, revision_humana: "corregido" }), "revisado");
  assert.equal(estadoPulpo({ ...base, revision_humana: "aprobado", exportado_at: "2026-10-24" }), "exportado");
  assert.equal(estadoPulpo({ ...base, en_espera: 1 }), "en_espera");
  assert.equal(estadoPulpo({ ...base, estado: "recibido" }), "recibido");
  assert.equal(estadoPulpo({ ...base, estado: "rechazado" }), "necesita_ayuda");
  assert.equal(estadoPulpo({ ...base, estado: "sin_cliente", cliente_id: null }), "necesita_ayuda");
});

let c1, c2;
test("crear clientes: valida, no repite NIT (aunque cambie el formato) y separa oficinas", async () => {
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/clientes`, { nombre: "Sin NIT" }, cA)).status, 400);
  const r = await llamar("POST", `/api/crews/oficinas/${A}/clientes`, { nit: "901.979.163-2", nombre: "Bruma Home S.A.S.", agente_retenedor_renta: true }, cA);
  assert.equal(r.status, 201);
  c1 = (await r.json()).cliente;
  assert.equal(c1.nit, "901979163");
  assert.equal(c1.agente_retenedor_renta, true);
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/clientes`, { nit: "901979163 - 2", nombre: "Repetido" }, cA)).status, 409);
  c2 = (await (await llamar("POST", `/api/crews/oficinas/${A}/clientes`, { nit: "800123456-1", nombre: "Comercial Norte" }, cA)).json()).cliente;
  // el mismo NIT en otra oficina es otro cliente
  assert.equal((await llamar("POST", `/api/crews/oficinas/${B}/clientes`, { nit: "901979163-2", nombre: "Bruma en B" }, cB)).status, 201);
  const lista = await (await llamar("GET", `/api/crews/oficinas/${A}/clientes`, null, cA)).json();
  assert.deepEqual(lista.clientes.map((c) => c.nombre).sort(), ["Bruma Home S.A.S.", "Comercial Norte"]);
});

test("una oficina no ve ni toca los clientes de otra", async () => {
  assert.equal((await llamar("GET", `/api/crews/oficinas/${A}/clientes`, null, cB)).status, 403);
  assert.equal((await llamar("PUT", `/api/crews/oficinas/${A}/clientes/${c1.id}`, { nombre: "Hackeado" }, cB)).status, 403);
  // aunque B use su propia ruta con el id de un cliente de A, no lo encuentra
  assert.equal((await llamar("GET", `/api/crews/oficinas/${B}/clientes/${c1.id}`, null, cB)).status, 404);
});

test("editar el perfil tributario de un cliente", async () => {
  const r = await llamar("PUT", `/api/crews/oficinas/${A}/clientes/${c2.id}`, { gran_contribuyente: true }, cA);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).cliente.gran_contribuyente, true);
  assert.equal((await llamar("PUT", `/api/crews/oficinas/${A}/clientes/${c2.id}`, { gran_contribuyente: "si" }, cA)).status, 400);
});

test("los documentos muestran su estado, filtran por cliente y por estado, y los conteos cuadran", async () => {
  const db = new Database(dbPath);
  doc(db, A, "L1", { cliente: c1.id });
  doc(db, A, "L2", { cliente: c1.id });
  doc(db, A, "AYU", { estado: "requiere_revision", rev: "pendiente", cliente: c1.id });
  doc(db, A, "REV", { rev: "aprobado", cliente: c1.id });
  doc(db, A, "EXP", { rev: "aprobado", cliente: c1.id, exportado: "2026-10-20T10:00:00Z" });
  doc(db, A, "ESP", { cliente: c1.id, enEspera: 1 });
  doc(db, A, "N1", { cliente: c2.id });
  doc(db, A, "SIN", { estado: "sin_cliente", rev: "pendiente" });
  db.close();
  const todos = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos`, null, cA)).json();
  const por = Object.fromEntries(todos.documentos.map((d) => [d.documento_id, d.estado_pulpo]));
  assert.deepEqual(por, { L1: "leido", L2: "leido", AYU: "necesita_ayuda", REV: "revisado", EXP: "exportado", ESP: "en_espera", N1: "leido", SIN: "necesita_ayuda" });
  const soloC1 = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos?cliente=${c1.id}`, null, cA)).json();
  assert.equal(soloC1.total, 6);
  const ayuda = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos?estado_pulpo=necesita_ayuda`, null, cA)).json();
  assert.deepEqual(ayuda.documentos.map((d) => d.documento_id).sort(), ["AYU", "SIN"]);
  assert.equal(ayuda.documentos.find((d) => d.documento_id === "AYU").cliente_nombre, "Bruma Home S.A.S.");
  const cl = await (await llamar("GET", `/api/crews/oficinas/${A}/clientes`, null, cA)).json();
  const k1 = cl.clientes.find((c) => c.id === c1.id);
  assert.deepEqual(k1.conteos, { recibido: 0, leido: 2, necesita_ayuda: 1, en_espera: 1, revisado: 1, exportado: 1, total: 6 });
  assert.equal(cl.documentos_sin_cliente, 1);
});

test("revisión: Leído pasa a Revisado, se puede devolver a ayuda, y lo exportado o sin cliente no se toca", async () => {
  const rev = (id, body) => llamar("POST", `/api/crews/oficinas/${A}/documentos/${id}/revision`, body, cA);
  assert.equal((await rev("L1", { decision: "aprobado" })).status, 200);
  let d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/L1`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "revisado");
  assert.equal(d.documento.revisado_por, "Laura", "el nombre sale de la sesión");
  assert.equal((await rev("L1", { decision: "aprobado" })).status, 409, "ya estaba revisado");
  assert.equal((await rev("L1", { decision: "devolver", nota: "Falta el soporte" })).status, 200);
  d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/L1`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "necesita_ayuda");
  assert.equal((await rev("EXP", { decision: "devolver" })).status, 409, "lo exportado no se cambia");
  assert.equal((await rev("SIN", { decision: "aprobado" })).status, 409, "sin cliente no se revisa");
  assert.equal((await rev("L2", { decision: "corregido" })).status, 400, "corregido pide nota");
});

test("CSV por cliente: solo ese cliente, y exportar deja los documentos en Exportado", async () => {
  const db = new Database(dbPath);
  doc(db, A, "C1A", { rev: "aprobado", cliente: c1.id });
  doc(db, A, "C2A", { rev: "aprobado", cliente: c2.id });
  db.close();
  const csv1 = await llamar("GET", `/api/crews/oficinas/${A}/documentos/export.csv?cliente=${c1.id}&marcar=0`, null, cA);
  assert.equal(csv1.status, 200);
  assert.match(csv1.headers.get("content-disposition"), new RegExp(`cliente_${c1.id}`));
  const t1 = await csv1.text();
  assert.ok(t1.includes("C1A") && !t1.includes("C2A"), "solo documentos del cliente pedido");
  // con marcar=0 no cambia el estado
  let d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/C1A`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "revisado");
  // exportando de verdad
  const csv2 = await llamar("GET", `/api/crews/oficinas/${A}/documentos/export.csv?cliente=${c2.id}`, null, cA);
  const t2 = await csv2.text();
  assert.ok(t2.includes("C2A") && !t2.includes("C1A"));
  d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/C2A`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "exportado");
  d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/C1A`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "revisado", "el de otro cliente no se marcó");
});

test("lote con XML de un cliente desconocido: queda esperando que elijan cliente; elegir aprende el NIT", async () => {
  const xml = readFileSync(join(xmlDir, "SINT-001_compra_normal.xml"), "utf8");
  const r = await llamar("POST", "/api/crews/contable/lote", { officeId: A, archivos: [{ nombre: "SINT-001.xml", contenido: xml }] }, cA);
  assert.equal(r.status, 202, "ya no exige perfil de oficina");
  const { loteId } = await r.json();
  let est;
  for (let i = 0; i < 60; i++) {
    est = await (await llamar("GET", `/api/crews/contable/lote/${loteId}`, null, cA)).json();
    if (est.terminado) break;
    await new Promise((x) => setTimeout(x, 300));
  }
  assert.equal(est.items[0].estado, "sin_cliente");
  const id = est.items[0].documento_id;
  const d = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/${id}`, null, cA)).json();
  assert.equal(d.documento.estado_pulpo, "necesita_ayuda");
  assert.match(d.documento.motivos[0], /Elige a qué cliente/);
  // elegir un cliente que no existe, o un NIT que no está en el documento, se rechaza
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/documentos/${id}/cliente`, { clienteId: 99999 }, cA)).status, 400);
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/documentos/${id}/cliente`, { clienteId: c1.id, nit: "123456789" }, cA)).status, 400);
  // otra oficina no puede asignar
  assert.equal((await llamar("POST", `/api/crews/oficinas/${B}/documentos/${id}/cliente`, { clienteId: c1.id }, cB)).status, 404);
  // elegir al cliente: Pulpo aprende el NIT del comprador (901000111) aunque el crew de IA no esté disponible aquí
  const el = await llamar("POST", `/api/crews/oficinas/${A}/documentos/${id}/cliente`, { clienteId: c2.id }, cA);
  assert.ok([200, 502].includes(el.status));
  const db = new Database(dbPath, { readonly: true });
  const alias = db.prepare("SELECT cliente_id FROM clientes_nits WHERE office_id = ? AND nit = '901000111'").get(A);
  db.close();
  assert.equal(alias.cliente_id, c2.id, "Pulpo aprendió el NIT");
  // un segundo XML del mismo comprador ya no queda sin cliente
  const xml2 = readFileSync(join(xmlDir, "SINT-004_iva_5.xml"), "utf8");
  const r2 = await llamar("POST", "/api/crews/contable/lote", { officeId: A, archivos: [{ nombre: "SINT-004.xml", contenido: xml2 }] }, cA);
  const l2 = (await r2.json()).loteId;
  let e2;
  for (let i = 0; i < 60; i++) { e2 = await (await llamar("GET", `/api/crews/contable/lote/${l2}`, null, cA)).json(); if (e2.terminado) break; await new Promise((x) => setTimeout(x, 300)); }
  assert.notEqual(e2.items[0].estado, "sin_cliente", "el NIT aprendido reconoce al cliente");
});

test("migración: el perfil único de la oficina pasa a ser un cliente y se queda con lo ya procesado", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE offices (id INTEGER PRIMARY KEY, name TEXT);");
  db.exec("CREATE TABLE office_tax_profiles (office_id INTEGER PRIMARY KEY, agente_retenedor_renta INTEGER, gran_contribuyente INTEGER, razon_social TEXT, nit TEXT);");
  db.prepare("INSERT INTO offices VALUES (7, 'Vieja')").run();
  db.prepare("INSERT INTO office_tax_profiles VALUES (7, 1, 0, 'Empresa Vieja SAS', '901.234.567-8')").run();
  crearTablaDocumentos(db);
  crearTablasClientes(db);
  db.prepare("INSERT INTO documentos_procesados (office_id, documento_id, estado, procesado_at) VALUES ('7', 'D1', 'procesado', 'x')").run();
  migrarPerfilesDeOficina(db);
  migrarPerfilesDeOficina(db); // repetir no duplica
  const cs = db.prepare("SELECT * FROM clientes").all();
  assert.equal(cs.length, 1);
  assert.equal(cs[0].nit, "901234567");
  assert.equal(cs[0].agente_retenedor_renta, 1);
  assert.equal(db.prepare("SELECT cliente_id FROM documentos_procesados WHERE documento_id = 'D1'").get().cliente_id, cs[0].id);
  db.close();
});
