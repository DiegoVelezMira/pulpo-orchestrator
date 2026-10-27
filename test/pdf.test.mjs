// Pruebas de lectura de PDF y tope mensual. La IA es un servidor falso local (ANTHROPIC_BASE_URL): no hay costo ni llave real.
// Uso: npm test (Node 20; requiere pdftotext y python3 con reportlab para generar los PDF sintéticos).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
require("ts-node/register");
const L = require("../src/services/pdf-lector");

const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "clave-admin-de-prueba-1234";
let dir, dbPath, srv, fake, llamadasIa = 0, A, B, cA, cB, adm, pdfDir;

const llamar = (metodo, url, body, cookie) =>
  fetch(BASE + url, { method: metodo, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const cookieDe = (r) => r.headers.getSetCookie().find((x) => x.startsWith("pulpo_sesion=")).split(";")[0];
const pdf = (n) => ({ nombre: n, base64: readFileSync(join(pdfDir, n)).toString("base64") });
const esperarLote = async (loteId, cookie) => {
  for (let i = 0; i < 120; i++) {
    const j = await (await llamar("GET", `/api/crews/contable/lote/${loteId}`, null, cookie)).json();
    if (j.terminado) return j;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("el lote no terminó");
};

// IA falsa: lee el número de factura del texto y responde como lo haría el modelo (FE-1003 con un total mal leído).
function respuestaIa(texto) {
  const numero = texto.match(/No\. (FE-\d+)/)[1];
  const cufe = texto.replace(/\s+/g, "").match(/[0-9a-f]{96}/)?.[0] ?? null;
  const comprador = texto.match(/Adquiriente:.*NIT ([\d.]+-\d)/)[1];
  const sub = Number(texto.match(/SUBTOTAL ([\d.]+),/)[1].replace(/\./g, ""));
  const iva = Number(texto.match(/IVA 19% ([\d.]+),/)[1].replace(/\./g, ""));
  const json = {
    tipo: "factura", numero, fecha_emision: "2026-10-08", fecha_aprobacion: "2026-10-08", emisor_nit: "900555444-3", emisor_nombre: "SUMINISTROS DEMO S.A.S.",
    comprador_nit: comprador, comprador_nombre: "CLIENTE DEMO S.A.S.", cufe, subtotal: sub, iva, otros_cargos: 0, retenciones: 0,
    total: numero === "FE-1003" ? 250000 : sub + iva, total_a_pagar: null, moneda: "COP",
    lineas: [{ descripcion: "Papeleria y suministros de oficina", cantidad: 10, precio_unitario: sub / 10, valor: sub }], alertas: [],
  };
  return "```json\n" + JSON.stringify(json) + "\n```";
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pulpo-pdf-"));
  dbPath = join(dir, "t.db");
  pdfDir = join(dir, "pdf");
  execFileSync("python3", ["crews/generar_pdf_sinteticos.py", pdfDir], { stdio: "ignore" });
  fake = createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (d) => (cuerpo += d));
    req.on("end", () => {
      llamadasIa++;
      const texto = JSON.parse(cuerpo).messages[0].content;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: respuestaIa(texto) }], usage: { input_tokens: 1600, output_tokens: 400 }, stop_reason: "end_turn" }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  srv = spawn(process.execPath, ["-r", "ts-node/register", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATABASE_PATH: dbPath, PULPO_ADMIN_KEY: ADMIN, PULPO_SESSION_SECRET: "z".repeat(40),
           ANTHROPIC_API_KEY: "llave-falsa", ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  adm = cookieDe(await llamar("POST", "/api/acceso/admin", { clave: ADMIN }));
  const a = await (await llamar("POST", "/api/admin/oficinas", { name: "Oficina A" }, adm)).json();
  const b = await (await llamar("POST", "/api/admin/oficinas", { name: "Oficina B" }, adm)).json();
  A = a.id; B = b.id;
  cA = cookieDe(await llamar("POST", "/api/acceso/entrar", { officeId: A, nombre: "Laura", clave: a.clave }));
  cB = cookieDe(await llamar("POST", "/api/acceso/entrar", { officeId: B, nombre: "Pedro", clave: b.clave }));
  // Cliente de la oficina A: el comprador de total_mal.pdf
  await llamar("POST", `/api/crews/oficinas/${A}/clientes`, { nit: "800123456-1", nombre: "Comercial Norte" }, cA);
});
after(() => { srv?.kill(); fake?.close(); rmSync(dir, { recursive: true, force: true }); });

test("reglas locales: CUFE partido en líneas, cifras en formato colombiano y total a pagar", () => {
  const t = "CUFE:\n" + "ab".repeat(24) + "\n" + "cd".repeat(24) + "\nTOTAL A PAGAR 1.190.000,00";
  assert.equal(L.cufeLocal(t), ("ab".repeat(24) + "cd".repeat(24)));
  assert.ok(L.cifrasDelTexto("1.190.000,00 y 2,774,971.85 y 96.520,76").some((n) => n === 1190000));
  assert.ok(L.cifrasDelTexto("2,774,971.85").includes(2774971.85));
  // Caso real: el PDF solo imprime el total a pagar (ya sin retención); total = subtotal + IVA.
  const texto = "SUBTOTAL 2,413,019.00\nIVA 458,473.61\nRETENCIÓN 96,520.76\nTOTAL A PAGAR 2,774,971.85\nNIT 900555444-3\nNIT 901979163-2";
  const ia = { emisor_nit: "900555444", comprador_nit: "901979163", subtotal: 2413019, iva: 458473.61, retenciones: 96520.76, total: 2871492.61, total_a_pagar: 2774971.85, fecha_emision: "2026-10-08", numero: "X1" };
  assert.deepEqual(L.contrastar(texto, ia, null), []);
  assert.ok(L.contrastar(texto, { ...ia, total_a_pagar: 2000000 }, null).some((h) => h.campo === "total"));
  assert.ok(L.contrastar(texto, { ...ia, comprador_nit: "123456789" }, null).some((h) => h.campo === "comprador_nit"));
  const cufe = "ab".repeat(48);
  assert.ok(L.contrastar(texto + cufe, { ...ia, cufe: "ab".repeat(47) + "cd" }, cufe).some((h) => h.campo === "cufe"));
});

test("alertas de fechas: aprobación anterior a la emisión y fechas futuras", () => {
  assert.equal(L.alertasDeFechas({ fecha_emision: "2026-10-08", fecha_aprobacion: "2026-10-08" }, "2026-10-24").length, 0);
  assert.equal(L.alertasDeFechas({ fecha_emision: "2026-10-08", fecha_aprobacion: "2025-10-29" }, "2026-10-24").length, 1);
  assert.equal(L.alertasDeFechas({ fecha_emision: "2026-12-01", fecha_aprobacion: null }, "2026-10-24").length, 1);
});

test("solo el administrador fija el tope, y debe ser un entero", async () => {
  assert.equal((await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: 2 }, cA)).status, 403);
  assert.equal((await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: -1 }, adm)).status, 400);
  assert.equal((await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: "dos" }, adm)).status, 400);
  assert.equal((await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: 2 }, adm)).status, 200);
  const t = await (await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cA)).json();
  assert.equal(t.tope, 2);
  assert.equal(t.usados, 0);
  assert.equal(t.nivel, "normal");
});

test("lote con PDF: lee con IA, deduplica por CUFE sin gastar, para en el tope y deja el escaneado para una persona", async () => {
  const r = await llamar("POST", "/api/crews/contable/lote", { officeId: A, archivos: ["buena_1.pdf", "buena_1_copia.pdf", "buena_2.pdf", "total_mal.pdf", "escaneado.pdf"].map(pdf) }, cA);
  assert.equal(r.status, 202);
  const lote = await esperarLote((await r.json()).loteId, cA);
  const por = Object.fromEntries(lote.items.map((i) => [i.nombre, i.estado]));
  assert.equal(por["buena_1.pdf"], "sin_cliente");
  assert.equal(por["buena_1_copia.pdf"], "duplicado");
  assert.equal(por["buena_2.pdf"], "sin_cliente");
  assert.equal(por["total_mal.pdf"], "en_espera");
  assert.equal(por["escaneado.pdf"], "no_leido");
  assert.equal(llamadasIa, 2, "solo 2 PDF se mandaron a la IA (copia, tope y escaneado no gastan)");
  const t = await (await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cA)).json();
  assert.equal(t.usados, 2);
  assert.equal(t.nivel, "agotado");
  assert.equal(t.en_espera, 1);
  assert.equal(t.tokens_in, 3200);
  const docs = await (await llamar("GET", `/api/crews/oficinas/${A}/documentos`, null, cA)).json();
  const est = (e) => docs.documentos.filter((d) => d.estado_pulpo === e).length;
  assert.equal(est("en_espera"), 1);
  assert.equal(est("necesita_ayuda"), 3); // 2 sin cliente + el escaneado
});

test("volver a subir el mismo lote no gasta IA", async () => {
  const antes = llamadasIa;
  const r = await llamar("POST", "/api/crews/contable/lote", { officeId: A, archivos: ["buena_1.pdf", "buena_2.pdf", "escaneado.pdf", "total_mal.pdf"].map(pdf) }, cA);
  const lote = await esperarLote((await r.json()).loteId, cA);
  assert.deepEqual(lote.items.map((i) => i.estado), ["duplicado", "duplicado", "duplicado", "duplicado"]);
  assert.equal(llamadasIa, antes);
});

test("liberar lo que está en espera: sin cupo no hace nada; con más tope lee y contrasta contra el texto", async () => {
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/en-espera/procesar`, null, cA)).status, 409);
  assert.equal((await llamar("POST", `/api/crews/oficinas/${A}/en-espera/procesar`, null, cB)).status, 403);
  await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: 3 }, adm);
  assert.equal((await (await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cA)).json()).nivel, "aviso"); // 2 de 3
  const antes = llamadasIa;
  const r = await llamar("POST", `/api/crews/oficinas/${A}/en-espera/procesar`, null, cA);
  assert.equal(r.status, 202);
  const lote = await esperarLote((await r.json()).loteId, cA);
  assert.equal(llamadasIa, antes + 1);
  // La IA "leyó mal" el total (250000, que no está en el texto): no se contabiliza sola, queda para una persona.
  assert.equal(lote.items[0].estado, "requiere_revision");
  assert.match(lote.items[0].detalle, /total/i);
  const t = await (await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cA)).json();
  assert.equal(t.usados, 3);
  assert.equal(t.nivel, "agotado");
  assert.equal(t.en_espera, 0);
  const docs = (await (await llamar("GET", `/api/crews/oficinas/${A}/documentos`, null, cA)).json()).documentos;
  assert.equal(docs.filter((d) => d.estado_pulpo === "en_espera").length, 0);
  const rev = docs.find((d) => d.documento_id.startsWith("FE-1003"));
  assert.equal(rev.estado_pulpo, "necesita_ayuda");
  assert.equal(rev.cliente_nombre, "Comercial Norte");
  // Aunque quede para una persona, el documento trae sus cifras (calculadas por reglas, sin IA) y el aviso de la lectura.
  const det = (await (await llamar("GET", `/api/crews/oficinas/${A}/documentos/${encodeURIComponent(rev.documento_id)}`, null, cA)).json()).documento;
  assert.ok(det.base_gravable > 0, "trae la base para que quien revisa la vea");
  assert.ok(det.motivos.length >= 1 && det.motivos.some((m) => /total/i.test(m)));
  assert.equal(docs.some((d) => d.documento_id.startsWith("pdf-") && d.estado === "recibido"), false, "el marcador de espera se retiró");
});

test("sin tope no hay límite, y quitarlo con 0 funciona", async () => {
  await llamar("PUT", `/api/admin/oficinas/${A}/tope`, { tope: 0 }, adm);
  const t = await (await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cA)).json();
  assert.equal(t.tope, null);
  assert.equal(t.nivel, "sin_tope");
  assert.equal(t.usados, 3);
});

test("la oficina B tiene su propio conteo y no ve el de A", async () => {
  const t = await (await llamar("GET", `/api/crews/oficinas/${B}/tope`, null, cB)).json();
  assert.equal(t.usados, 0);
  assert.equal((await llamar("GET", `/api/crews/oficinas/${A}/tope`, null, cB)).status, 403);
});

test("niveles del tope: 60% aviso, 85% alto, 100% agotado", () => {
  const { iniciarTope, estadoTope, registrarLectura } = require("../src/services/tope");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE offices (id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO offices (id, name) VALUES (1, 'X')").run();
  iniciarTope(db);
  db.prepare("UPDATE offices SET tope_pdf_mes = 10 WHERE id = 1").run();
  const niv = () => estadoTope(db, 1).nivel;
  assert.equal(niv(), "normal");
  for (let i = 0; i < 6; i++) registrarLectura(db, 1, null, "m", 1, 1);
  assert.equal(niv(), "aviso");
  for (let i = 0; i < 3; i++) registrarLectura(db, 1, null, "m", 1, 1);
  assert.equal(niv(), "alto");
  registrarLectura(db, 1, null, "m", 1, 1);
  assert.equal(niv(), "agotado");
  assert.equal(estadoTope(db, 1).restantes, 0);
});

test("el lector de XML entrega el CUFE (cbc:UUID) para poder unir el PDF con su XML", () => {
  execFileSync("python3", ["crews/generar_xml_sinteticos.py", join(dir, "xml")], { stdio: "ignore" });
  const original = readFileSync(join(dir, "xml", "SINT-001_compra_normal.xml"), "utf8");
  const conUuid = original.replace("<cbc:ID>", `<cbc:UUID schemeName="CUFE-SHA384">${"A1".repeat(48)}</cbc:UUID><cbc:ID>`);
  assert.notEqual(conUuid, original);
  const ruta = join(dir, "con-uuid.xml");
  require("node:fs").writeFileSync(ruta, conUuid);
  const r = JSON.parse(execFileSync("python3", ["crews/xml_a_documento.py", ruta, "--retenedor", "no", "--gran", "no"]).toString());
  assert.equal(r.ok, true);
  assert.equal(r.documento.cufe, "a1".repeat(48));
});

test("un PDF cuyo XML ya está cargado se une a él: no gasta IA y no queda como duplicado", async () => {
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO documentos_procesados (office_id, documento_id, tipo_documento, estado, revision_humana, procesado_at, cufe)
              VALUES (?, 'FE-1001_900555444', 'factura_compra', 'procesado', 'no_aplica', ?, ?)`).run(String(B), new Date().toISOString(), "a1".repeat(48));
  db.close();
  const antes = llamadasIa;
  for (let vez = 0; vez < 2; vez++) {
    const r = await llamar("POST", "/api/crews/contable/lote", { officeId: B, archivos: [pdf("buena_1.pdf")] }, cB);
    const lote = await esperarLote((await r.json()).loteId, cB);
    assert.equal(lote.items[0].estado, "unido");
    assert.match(lote.items[0].detalle, /Unido a su XML/);
    assert.equal(lote.items[0].documento_id, "FE-1001_900555444");
  }
  assert.equal(llamadasIa, antes);
  const lista = await (await llamar("GET", `/api/crews/oficinas/${B}/documentos`, null, cB)).json();
  assert.equal((lista.documentos ?? lista).length, 1);
});

test("CUFE: un número pegado antes (la hora de aprobación) no se cuela, y el partido en líneas sigue funcionando", () => {
  const real = "510aa10b7d326cbbf3abf2af39bcb182d693945d79d790f0b441ec5b0058becda2b9d178752638233eb966fd3effc238";
  const t = `Código único factura electrónica: Fecha y Hora de Aprobación: 31/OCT/2026 08:32\n${real}\n\nProveedor Tecnológico: FENALCO`;
  assert.equal(L.cufeLocal(t), real);
  assert.equal(L.cufeLocal(`Aprobación 08 32\n2026\n${real}`), real);
  assert.equal(L.cufeLocal(`CUFE: ${real.slice(0, 40)}\n${real.slice(40)}`), real);
  assert.equal(L.cufeLocal("sin cufe aquí"), null);
});
