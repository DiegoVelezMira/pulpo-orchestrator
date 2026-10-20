import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { executeContableCrew, convertirXml } from '../services/crewai-bridge';
import {
  crearTablaDocumentos,
  guardarDocumento,
  listarDocumentos,
  obtenerDocumento,
  registrarRevision,
} from '../services/documentos-procesados';

// Perfil tributario del comprador (la oficina): vive en la base de datos y es la
// fuente de verdad. Si el POST trae officeId y la oficina tiene perfil, ese perfil
// reemplaza lo que venga en documento.comprador (retenedor, gran contribuyente).
export function crearCrewsRouter(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_tax_profiles (
      office_id INTEGER PRIMARY KEY,
      agente_retenedor_renta INTEGER NOT NULL,
      gran_contribuyente INTEGER NOT NULL,
      razon_social TEXT,
      nit TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (office_id) REFERENCES offices(id)
    );
  `);

  crearTablaDocumentos(db);

  const router = express.Router();

  // Lotes de carga: se procesan en segundo plano (un lote puede tardar minutos) y el estado
  // vive en memoria; lo que importa queda en documentos_procesados.
  type ItemLote = { nombre: string; estado: string; documento_id?: string; detalle?: string };
  type Lote = { officeId: number; total: number; items: ItemLote[]; terminado: boolean; creado: number };
  const inicioIso = (l: Lote) => new Date(l.creado).toISOString();
  const lotes = new Map<string, Lote>();

  const leerPerfil = (officeId: number) => {
    const f = db
      .prepare('SELECT * FROM office_tax_profiles WHERE office_id = ?')
      .get(officeId) as any;
    if (!f) return null;
    const perfil: Record<string, any> = {
      agente_retenedor_renta: f.agente_retenedor_renta === 1,
      gran_contribuyente: f.gran_contribuyente === 1,
    };
    if (f.razon_social) perfil.razon_social = f.razon_social;
    if (f.nit) perfil.nit = f.nit;
    return perfil;
  };

  const idValido = (v: any): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  router.get('/oficinas/:officeId/perfil-tributario', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    const perfil = leerPerfil(id);
    if (!perfil) {
      return res.status(404).json({ status: 'error', error: 'La oficina no tiene perfil tributario cargado' });
    }
    res.json({ status: 'ok', officeId: id, perfil });
  });

  router.put('/oficinas/:officeId/perfil-tributario', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    const { agente_retenedor_renta, gran_contribuyente, razon_social, nit } = req.body || {};
    if (typeof agente_retenedor_renta !== 'boolean' || typeof gran_contribuyente !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        error: 'agente_retenedor_renta y gran_contribuyente son obligatorios y deben ser true o false',
      });
    }
    const oficina = db.prepare('SELECT id FROM offices WHERE id = ?').get(id);
    if (!oficina) return res.status(404).json({ status: 'error', error: 'La oficina no existe' });

    db.prepare(
      `INSERT INTO office_tax_profiles (office_id, agente_retenedor_renta, gran_contribuyente, razon_social, nit, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(office_id) DO UPDATE SET
         agente_retenedor_renta = excluded.agente_retenedor_renta,
         gran_contribuyente = excluded.gran_contribuyente,
         razon_social = excluded.razon_social,
         nit = excluded.nit,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      id,
      agente_retenedor_renta ? 1 : 0,
      gran_contribuyente ? 1 : 0,
      typeof razon_social === 'string' ? razon_social : null,
      typeof nit === 'string' ? nit : null
    );
    res.json({ status: 'ok', officeId: id, perfil: leerPerfil(id) });
  });

  router.post('/contable/procesar', async (req, res) => {
    try {
      const { documento, officeId } = req.body;

      if (!documento) {
        return res.status(400).json({
          status: 'error',
          error: 'Campo "documento" requerido',
        });
      }

      const doc: Record<string, any> = { ...documento };
      const id = idValido(officeId);
      if (id) {
        const perfil = leerPerfil(id);
        if (perfil) {
          doc.comprador = { ...(doc.comprador || {}), ...perfil };
        }
      }

      const resultado = await executeContableCrew({
        id: officeId || 'sin_id',
        ...doc,
      });

      // Registro permanente: si falla el guardado, la respuesta no se pierde.
      try {
        guardarDocumento(db, officeId, doc, resultado);
      } catch (e) {
        console.error('No se pudo guardar el documento procesado:', e);
      }

      res.json(resultado);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  });

  router.get('/oficinas/:officeId/documentos', (req, res) => {
    const filtros = {
      estado: typeof req.query.estado === 'string' ? req.query.estado : undefined,
      revision: typeof req.query.revision === 'string' ? req.query.revision : undefined,
    };
    const docs = listarDocumentos(db, String(req.params.officeId), filtros);
    res.json({ status: 'ok', total: docs.length, documentos: docs });
  });

  async function procesarLote(
    lote: Lote,
    perfil: Record<string, any>,
    archivos: { nombre: string; contenido: string }[],
    reprocesar: boolean
  ) {
    let detenido = false;
    let seguidos = 0; // errores de procesamiento consecutivos
    const vistos = new Set<string>(); // ids ya tratados en este lote
    try {
      for (const a of archivos) {
        const item: ItemLote = { nombre: a.nombre.slice(0, 200), estado: 'procesando' };
        lote.items.push(item);
        if (detenido) {
          item.estado = 'sin_procesar';
          item.detalle = 'El lote se detuvo tras 2 errores seguidos de procesamiento (p. ej. sin crédito de la API); vuelve a subirlo (lo ya procesado se omite)';
          continue;
        }
        try {
          const c = await convertirXml(a.contenido, perfil.agente_retenedor_renta === true, perfil.gran_contribuyente === true);
          if (!c.ok || !c.documento) {
            item.estado = 'no_leido';
            item.detalle = c.error || 'No se pudo leer el XML';
            continue;
          }
          // El perfil de la oficina manda sobre los indicadores tributarios, pero no sobre la identidad:
          // si el adquirente del XML no es la oficina, no se contabiliza aquí.
          const nitXml = String(c.documento.comprador?.nit ?? '').split('-')[0].replace(/\D/g, '');
          const nitOficina = String(perfil.nit ?? '').split('-')[0].replace(/\D/g, '');
          if (nitOficina && nitXml && nitXml !== nitOficina) {
            item.estado = 'no_leido';
            item.detalle = `El XML es de otro adquirente (NIT ${nitXml}); la oficina es ${nitOficina}`;
            continue;
          }
          const doc: Record<string, any> = { ...c.documento };
          doc.comprador = { ...(doc.comprador || {}), ...perfil };
          item.documento_id = String(doc.id);
          if (vistos.has(item.documento_id)) {
            item.estado = 'duplicado';
            item.detalle = 'Repetido dentro de este mismo lote';
            continue;
          }
          vistos.add(item.documento_id);
          const existe = db
            .prepare('SELECT estado, revision_humana FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
            .get(String(lote.officeId), item.documento_id) as { estado: string; revision_humana: string } | undefined;
          // Lo ya revisado (aprobado/corregido) nunca se pisa; con reprocesar se rehace lo que aún no tiene revisión.
          if (existe && !(reprocesar && ['no_aplica', 'pendiente'].includes(existe.revision_humana))) {
            item.estado = 'duplicado';
            item.detalle = `Ya estaba registrado (${existe.estado}; revisión: ${existe.revision_humana})`;
            continue;
          }
          const resultado = await executeContableCrew({ id: lote.officeId, ...doc });
          const guardado = guardarDocumento(db, lote.officeId, doc, resultado);
          if (guardado === null) {
            // Error de procesamiento (p. ej. sin crédito de la API): no se registra; 2 seguidos frenan el lote.
            item.estado = 'error';
            item.detalle = String(resultado?.error ?? resultado?.status ?? 'Error de procesamiento').slice(0, 300);
            if (++seguidos >= 2) detenido = true;
          } else {
            seguidos = 0;
            item.estado = String(resultado.status);
            const m = resultado.motivos_revision ?? resultado.detalles?.motivos;
            if (Array.isArray(m) && m.length) item.detalle = String(m[0]).slice(0, 300);
          }
        } catch (e) {
          item.estado = 'error';
          item.detalle = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          if (++seguidos >= 2) detenido = true;
        }
      }
    } finally {
      lote.terminado = true;
    }
  }

  router.post('/contable/lote', (req, res) => {
    const { officeId, archivos } = req.body || {};
    const id = idValido(officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido (número de la oficina)' });
    if (!db.prepare('SELECT id FROM offices WHERE id = ?').get(id)) {
      return res.status(404).json({ status: 'error', error: 'La oficina no existe' });
    }
    const perfil = leerPerfil(id);
    if (!perfil) {
      return res.status(400).json({ status: 'error', error: 'La oficina no tiene perfil tributario cargado (PUT /api/crews/oficinas/:id/perfil-tributario)' });
    }
    if (!Array.isArray(archivos) || archivos.length === 0) {
      return res.status(400).json({ status: 'error', error: 'Envía "archivos": [{ nombre, contenido }]' });
    }
    if (archivos.length > 50) return res.status(400).json({ status: 'error', error: 'Máximo 50 archivos por lote' });
    if (!archivos.every((a: any) => a && typeof a.nombre === 'string' && typeof a.contenido === 'string')) {
      return res.status(400).json({ status: 'error', error: 'Cada archivo necesita nombre y contenido (texto del XML)' });
    }
    for (const l of lotes.values()) {
      if (l.officeId === id && !l.terminado) {
        return res.status(409).json({ status: 'error', error: 'Esta oficina ya tiene un lote en proceso; espera a que termine' });
      }
    }
    for (const [k, l] of lotes) if (l.terminado && Date.now() - l.creado > 2 * 3600 * 1000) lotes.delete(k);

    const loteId = randomUUID();
    const lote: Lote = { officeId: id, total: archivos.length, items: [], terminado: false, creado: Date.now() };
    lotes.set(loteId, lote);
    void procesarLote(lote, perfil, archivos, req.body?.reprocesar === true);
    res.status(202).json({ status: 'ok', loteId, total: lote.total, inicio: inicioIso(lote) });
  });

  router.get('/contable/lote/:loteId', (req, res) => {
    const l = lotes.get(String(req.params.loteId));
    if (!l) return res.status(404).json({ status: 'error', error: 'Lote no encontrado (¿se reinició el servidor?)' });
    res.json({ status: 'ok', officeId: l.officeId, total: l.total, terminado: l.terminado, inicio: inicioIso(l), items: l.items });
  });

  // Asientos en CSV (una fila por línea de asiento), separador ';', BOM UTF-8, decimales con coma (Excel es-CO;
  // ?decimal=punto para punto). Por defecto solo lo listo para contabilizar: procesado sin pendientes o aprobado.
  // Un 'corregido' no se exporta: el asiento guardado es el original, no el corregido a mano. ?ids=a,b limita a
  // esos documentos (para exportar solo un lote); ?todos=1 incluye todo con su estado.
  // Los documentos con asiento ausente o descuadrado se excluyen y se cuentan en la cabecera X-Documentos-Excluidos.
  router.get('/oficinas/:officeId/documentos/export.csv', (req, res) => {
    const todos = req.query.todos === '1';
    const coma = req.query.decimal !== 'punto';
    const ids =
      typeof req.query.ids === 'string'
        ? req.query.ids.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200)
        : null;
    const oficina = String(req.params.officeId);
    const filas = db
      .prepare(
        `SELECT documento_id, tipo_documento, fecha_documento, proveedor, nit_proveedor, estado, revision_humana, asiento_json
           FROM documentos_procesados WHERE office_id = ? ${ids ? (ids.length ? `AND documento_id IN (${ids.map(() => '?').join(',')})` : 'AND 0') : ''}
          ORDER BY fecha_documento, documento_id`
      )
      .all(...(ids ? [oficina, ...ids] : [oficina])) as any[];
    // Texto: solo lo que viene de fuera (tercero, cuenta) lleva el apóstrofe anti-fórmulas de Excel.
    const texto = (v: any, externo = false) => {
      let t = String(v ?? '');
      if (externo && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    // null/vacío = 0 (el crew debe dar 0 donde no aplica); texto no numérico = inválido.
    const num = (v: any): number | null => {
      if (v === null || v === undefined || v === '') return 0;
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const fmt = (n: number) => (coma ? n.toFixed(2).replace('.', ',') : n.toFixed(2));
    const out: string[] = [
      ['fecha', 'documento', 'tipo', 'nit_tercero', 'tercero', 'codigo_cuenta', 'cuenta', 'debito', 'credito', 'estado', 'revision'].join(';'),
    ];
    const excluidos: string[] = [];
    for (const f of filas) {
      if (!todos && (f.estado === 'rechazado' || !['no_aplica', 'aprobado'].includes(f.revision_humana))) continue;
      let asiento: any;
      try { asiento = f.asiento_json ? JSON.parse(f.asiento_json) : null; } catch { asiento = null; }
      if (!Array.isArray(asiento) || asiento.length === 0) {
        if (f.estado === 'procesado') excluidos.push(f.documento_id); // procesado sin asiento utilizable
        continue;
      }
      const lineas = asiento.map((l: any) => ({ cuenta: String(l?.cuenta ?? ''), d: num(l?.debito), c: num(l?.credito) }));
      const sumD = lineas.reduce((a, l) => a + (l.d ?? 0), 0);
      const sumC = lineas.reduce((a, l) => a + (l.c ?? 0), 0);
      if (lineas.some((l) => l.d === null || l.c === null) || Math.abs(sumD - sumC) > 1) {
        excluidos.push(f.documento_id); // monto no numérico o asiento descuadrado
        continue;
      }
      for (const l of lineas) {
        const codigo = (l.cuenta.match(/^\s*(\d+)/) || [])[1] || '';
        out.push([
          texto(f.fecha_documento), texto(f.documento_id), texto(f.tipo_documento), texto(f.nit_proveedor, true), texto(f.proveedor, true),
          texto(codigo), texto(l.cuenta, true), fmt(l.d as number), fmt(l.c as number), texto(f.estado), texto(f.revision_humana),
        ].join(';'));
      }
    }
    const nombre = `asientos_oficina_${oficina.replace(/[^\w.-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('X-Documentos-Excluidos', String(excluidos.length));
    if (excluidos.length) res.setHeader('X-Documentos-Excluidos-Ids', excluidos.slice(0, 20).join(',').replace(/[^\w.,-]/g, '_'));
    res.send('﻿' + out.join('\r\n') + '\r\n');
  });

  router.get('/oficinas/:officeId/documentos/:documentoId', (req, res) => {
    const d = obtenerDocumento(db, String(req.params.officeId), String(req.params.documentoId));
    if (!d) return res.status(404).json({ status: 'error', error: 'Documento no encontrado' });
    res.json({ status: 'ok', documento: d });
  });

  router.post('/oficinas/:officeId/documentos/:documentoId/revision', (req, res) => {
    const { decision, nota, revisor } = req.body || {};
    const r = registrarRevision(
      db,
      String(req.params.officeId),
      String(req.params.documentoId),
      String(decision ?? ''),
      typeof nota === 'string' ? nota : undefined,
      typeof revisor === 'string' ? revisor : undefined
    );
    if (!r.ok) return res.status(r.codigo).json({ status: 'error', error: r.error });
    res.json({ status: 'ok', documento: obtenerDocumento(db, String(req.params.officeId), String(req.params.documentoId)) });
  });

  return router;
}

export default crearCrewsRouter;
