import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { procesarPorReglas } = require("../dist/services/asiento-reglas.js");

const base = { id: "F-1", tipo: "factura_compra", fecha: "2026-10-01", nit_proveedor: "830513729-3", subtotal: 100000, iva: 19000, total: 119000, items: [{ cantidad: 1, valor_unitario: 100000 }] };
const sumas = (a) => [a.reduce((s, l) => s + l.debito, 0), a.reduce((s, l) => s + l.credito, 0)];

test("reglas fijas: compra con IVA da un asiento balanceado, sin retenciones ni IA", () => {
  const r = procesarPorReglas(base, "comprador", "2026-10-26");
  assert.equal(r.status, "procesado");
  const a = r.asientos.detalles.asiento;
  assert.equal(a.length, 3);
  assert.deepEqual(sumas(a), [119000, 119000]);
  assert.equal(r.calculos_oficiales.determinable, false);
  assert.equal(r.calculos_oficiales.version_reglas, "reglas-fijas-v1");
});

test("reglas fijas: venta usa clientes/ingresos y nota crédito invierte el asiento", () => {
  const v = procesarPorReglas(base, "vendedor", "2026-10-26").asientos.detalles.asiento;
  assert.equal(v[0].debito, 119000);
  const nc = procesarPorReglas({ ...base, tipo: "nota_credito" }, "comprador", "2026-10-26").asientos.detalles.asiento;
  assert.deepEqual(sumas(nc), [119000, 119000]);
  assert.equal(nc[nc.length - 1].debito, 119000);
});

test("reglas fijas: cifras que no cuadran, fecha futura o falta de NIT piden revisión y no generan asiento", () => {
  const r = procesarPorReglas({ ...base, total: 120000, fecha: "2027-01-01", nit_proveedor: "" }, "comprador", "2026-10-26");
  assert.equal(r.status, "requiere_revision");
  assert.equal(r.motivos_revision.length, 3);
  assert.equal(r.asientos.detalles.asiento, null);
});

test("reglas fijas: precios con IVA incluido (factura de supermercado) no se marcan, y un descuadre real sí", () => {
  const ara = { id: "O95A085665", tipo: "factura_compra", fecha: "2026-10-01", nit_proveedor: "900480569-1", subtotal: 10254, iva: 1036, total: 11290, items: [{ cantidad: 1, valor_unitario: 4800 }, { cantidad: 1, valor_unitario: 6490 }] };
  const r = procesarPorReglas(ara, "comprador", "2026-10-26");
  assert.equal(r.status, "procesado");
  assert.deepEqual(r.motivos_revision, []);
  const mal = procesarPorReglas({ ...ara, items: [{ cantidad: 1, valor_unitario: 4800 }, { cantidad: 1, valor_unitario: 9999 }] }, "comprador", "2026-10-26");
  assert.equal(mal.status, "requiere_revision");
});
