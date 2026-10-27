import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { executeContableCrew, convertirXml } from '../services/crewai-bridge';
import { procesarPorReglas } from '../services/asiento-reglas';
import {
  crearTablaDocumentos,
  guardarDocumento,
  listarDocumentos,
  obtenerDocumento,
  registrarRevision,
  guardarDocumentoSinCliente,
  marcarOrigenPdf,
  pdfYaRegistrado,
  unirPdfAXml,
  guardarPdfPendiente,
  pdfsEnEspera,
  borrarMarcador,
  eliminarDocumentos,
} from '../services/documentos-procesados';
import { extraerTexto, tieneTexto, cufeLocal, huellaPdf, contrastar, alertasDeFechas, aDocumento, MAX_PDF_BYTES } from '../services/pdf-lector';
import { leerConIa } from '../services/lector-ia';
import { iniciarTope, estadoTope, hayCupo, registrarLectura } from '../services/tope';
import {
  crearTablasClientes,
  migrarPerfilesDeOficina,
  crearCliente,
  obtenerCliente,
  perfilDeCliente,
  buscarClientePorNits,
  aprenderNit,
  nitBase,
  estadoPulpo,
  conteosPorEstado,
} from '../services/clientes';

// Perfil tributario del comprador (la oficina): vive en la base de datos y es la
// fuente de verdad. Si el POST trae officeId y la oficina tiene perfil, ese perfil
// reemplaza lo que venga en documento.comprador (retenedor, gran contribuyente).
// Spec v1: un documento leído se procesa por reglas fijas, sin IA. El Crew (agentes con modelo) queda para la fase 2: PULPO_USAR_CREW=1.
async function procesarDocumento(officeId: string | number, doc: Record<string, any>, rol: 'comprador' | 'vendedor') {
  if (process.env.PULPO_USAR_CREW === '1') return executeContableCrew({ id: officeId, ...doc });
  const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
  return procesarPorReglas(doc, rol, hoy);
}

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
  iniciarTope(db);
  crearTablasClientes(db);
  migrarPerfilesDeOficina(db);

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
      let dueno: { clienteId: number; rol: 'comprador' | 'vendedor' } | undefined;
      if (id) {
        const hallado = buscarClientePorNits(db, id, [
          { nit: doc.comprador?.nit, rol: 'comprador' },
          { nit: doc.nit_proveedor, rol: 'vendedor' },
        ]);
        if (hallado) {
          dueno = { clienteId: hallado.cliente.id, rol: hallado.rol };
          if (hallado.rol === 'comprador') doc.comprador = { ...(doc.comprador || {}), ...perfilDeCliente(hallado.cliente) };
        } else {
          const perfil = leerPerfil(id); // perfil único de la oficina (modelo anterior), solo si no hay cliente
          if (perfil) doc.comprador = { ...(doc.comprador || {}), ...perfil };
        }
      }

      const resultado = await executeContableCrew({
        id: officeId || 'sin_id',
        ...doc,
      });

      // Registro permanente: si falla el guardado, la respuesta no se pierde.
      try {
        guardarDocumento(db, officeId, doc, resultado, dueno);
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
      cliente: idValido(req.query.cliente) ?? undefined,
      estadoPulpo: typeof req.query.estado_pulpo === 'string' ? req.query.estado_pulpo : undefined,
    };
    const docs = listarDocumentos(db, String(req.params.officeId), filtros);
    res.json({ status: 'ok', total: docs.length, documentos: docs });
  });

  type ArchivoLote = { nombre: string; contenido?: string; pdf?: Buffer; textoPdf?: string; huella?: string; marcador?: string };
  type Ctx = { vistos: Set<string>; reprocesar: boolean; seguidos: number; detenido: boolean };

  // Tramo común a XML y PDF: dueño del documento -> crew -> guardado. Devuelve true si fue un error de procesamiento.
  async function tratarDocumento(
    lote: Lote, item: ItemLote, doc: Record<string, any>, ctx: Ctx,
    pdf?: { huella: string; cufe: string | null; nombre: string; hallazgos: string[] }
  ): Promise<boolean> {
    const hallado = buscarClientePorNits(db, lote.officeId, [
      { nit: doc.comprador?.nit, rol: 'comprador' },
      { nit: doc.nit_proveedor, rol: 'vendedor' },
    ]);
    if (hallado && hallado.rol === 'comprador') doc.comprador = { ...(doc.comprador || {}), ...perfilDeCliente(hallado.cliente) };
    item.documento_id = String(doc.id);
    if (ctx.vistos.has(item.documento_id)) {
      item.estado = 'duplicado';
      item.detalle = 'Repetido dentro de este mismo lote';
      return false;
    }
    ctx.vistos.add(item.documento_id);
    const existe = db
      .prepare('SELECT estado, revision_humana FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
      .get(String(lote.officeId), item.documento_id) as { estado: string; revision_humana: string } | undefined;
    // Lo ya revisado (aprobado/corregido) nunca se pisa; con reprocesar se rehace lo que aún no tiene revisión.
    if (existe && !(ctx.reprocesar && ['no_aplica', 'pendiente'].includes(existe.revision_humana) && existe.estado !== 'recibido')) {
      item.estado = 'duplicado';
      item.detalle = `Ya estaba registrado (${existe.estado}; revisión: ${existe.revision_humana})`;
      return false;
    }
    if (!hallado) {
      // Ningún NIT del documento es de un cliente conocido: queda esperando que una persona elija el cliente.
      guardarDocumentoSinCliente(db, lote.officeId, doc);
      if (pdf) marcarOrigenPdf(db, lote.officeId, item.documento_id, pdf);
      item.estado = 'sin_cliente';
      item.detalle = 'Elige a qué cliente pertenece este documento';
      return false;
    }
    const dueno = { clienteId: hallado.cliente.id, rol: hallado.rol };
    if (pdf && pdf.hallazgos.length) {
      // La lectura con IA no pasó el contraste con el texto o tiene una alerta: no se da por buena sola, queda para una persona.
      // Aun así se calculan las cifras y el asiento sugerido (por reglas, sin IA) para que quien revisa los vea junto al aviso.
      const base = await procesarDocumento(lote.officeId, doc, dueno.rol as 'comprador' | 'vendedor');
      const conAviso = base && !base.error
        ? { ...base, status: base.status === 'rechazado' ? 'rechazado' : 'requiere_revision', motivos_revision: [...pdf.hallazgos, ...(base.motivos_revision ?? [])] }
        : { status: 'requiere_revision', documento_id: doc.id, motivos_revision: pdf.hallazgos, timestamp: new Date().toISOString() };
      guardarDocumento(db, lote.officeId, doc, conAviso, dueno);
      marcarOrigenPdf(db, lote.officeId, item.documento_id, pdf);
      item.estado = 'requiere_revision';
      item.detalle = pdf.hallazgos[0].slice(0, 300);
      return false;
    }
    const resultado = await procesarDocumento(lote.officeId, doc, dueno.rol as 'comprador' | 'vendedor');
    const guardado = guardarDocumento(db, lote.officeId, doc, resultado, dueno);
    if (guardado === null) {
      // Error de procesamiento (p. ej. sin crédito de la API): no se registra; 2 seguidos frenan el lote.
      item.estado = 'error';
      item.detalle = String(resultado?.error ?? resultado?.status ?? 'Error de procesamiento').slice(0, 300);
      return true;
    }
    if (pdf) marcarOrigenPdf(db, lote.officeId, item.documento_id, pdf);
    item.estado = String(resultado.status);
    const m = resultado.motivos_revision ?? resultado.detalles?.motivos;
    if (Array.isArray(m) && m.length) item.detalle = String(m[0]).slice(0, 300);
    return false;
  }

  // Un PDF: texto local -> CUFE local -> (cupo del tope) -> IA con solo texto -> contraste -> tramo común.
  async function tratarPdf(lote: Lote, item: ItemLote, a: ArchivoLote, ctx: Ctx): Promise<boolean> {
    const huella = a.huella ?? huellaPdf(a.pdf!);
    const texto = a.textoPdf ?? (await extraerTexto(a.pdf!));
    if (!tieneTexto(texto)) {
      const prev = pdfYaRegistrado(db, lote.officeId, huella, null);
      if (prev) { item.estado = 'duplicado'; item.detalle = 'Este PDF ya estaba registrado'; return false; }
      item.documento_id = guardarPdfPendiente(db, lote.officeId, { huella, cufe: null, nombre: a.nombre, estado: 'ilegible', enEspera: false, motivo: 'PDF sin texto (probablemente escaneado): súbelo en XML o escríbelo a mano' });
      item.estado = 'no_leido';
      item.detalle = 'PDF sin texto (probablemente escaneado)';
      return false;
    }
    const cufe = cufeLocal(texto);
    const prev = pdfYaRegistrado(db, lote.officeId, huella, cufe, a.marcador);
    if (prev && prev.origen !== 'pdf') {
      // Es la representación gráfica de un XML que ya está cargado: se une a él y no se gasta IA.
      unirPdfAXml(db, lote.officeId, prev.documento_id, huella);
      item.estado = 'unido';
      item.documento_id = prev.documento_id;
      item.detalle = 'Unido a su XML, que ya estaba cargado';
      return false;
    }
    if (prev) {
      item.estado = 'duplicado';
      item.documento_id = prev.documento_id;
      item.detalle = `Ya estaba registrado (${prev.en_espera ? 'en espera por tope' : prev.estado})`;
      return false;
    }
    if (!hayCupo(db, lote.officeId)) {
      item.documento_id = guardarPdfPendiente(db, lote.officeId, { huella, cufe, nombre: a.nombre, estado: 'recibido', enEspera: true, motivo: 'En espera por tope: se leerá cuando haya cupo', texto });
      item.estado = 'en_espera';
      item.detalle = 'Se alcanzó el tope mensual de PDF leídos con IA';
      return false;
    }
    const lectura = await leerConIa(texto);
    registrarLectura(db, lote.officeId, huella, lectura.modelo, lectura.tokens_in, lectura.tokens_out);
    const ia = lectura.json;
    if (ia.tipo && !['factura', 'nota_credito'].includes(String(ia.tipo))) {
      item.estado = 'no_leido';
      item.detalle = `Tipo de documento '${ia.tipo}' aún no se contabiliza automáticamente`;
      item.documento_id = guardarPdfPendiente(db, lote.officeId, { huella, cufe, nombre: a.nombre, estado: 'ilegible', enEspera: false, motivo: item.detalle });
      return false;
    }
    const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
    const hallazgos = [...contrastar(texto, ia, cufe).map((h) => h.mensaje), ...alertasDeFechas(ia, hoy)];
    if (!ia.numero || !ia.emisor_nit) {
      item.estado = 'no_leido';
      item.detalle = 'No se pudo leer el número o el NIT del emisor';
      item.documento_id = guardarPdfPendiente(db, lote.officeId, { huella, cufe, nombre: a.nombre, estado: 'ilegible', enEspera: false, motivo: item.detalle });
      return false;
    }
    const doc = aDocumento({ ...ia, cufe: cufe ?? ia.cufe });
    return tratarDocumento(lote, item, doc, ctx, { huella, cufe, nombre: a.nombre, hallazgos });
  }

  async function procesarLote(lote: Lote, archivos: ArchivoLote[], reprocesar: boolean) {
    const ctx: Ctx = { vistos: new Set<string>(), reprocesar, seguidos: 0, detenido: false };
    try {
      for (const a of archivos) {
        const item: ItemLote = { nombre: a.nombre.slice(0, 200), estado: 'procesando' };
        lote.items.push(item);
        if (ctx.detenido) {
          item.estado = 'sin_procesar';
          item.detalle = 'El lote se detuvo tras 2 errores seguidos de procesamiento (p. ej. sin crédito de la API); vuelve a subirlo (lo ya procesado se omite)';
          continue;
        }
        try {
          let fallo = false;
          if (a.pdf || a.textoPdf) {
            fallo = await tratarPdf(lote, item, a, ctx);
          } else {
            // El XML se lee primero sin perfil: el perfil tributario depende del cliente, y el cliente sale del XML.
            const c = await convertirXml(a.contenido!, false, false);
            if (!c.ok || !c.documento) {
              item.estado = 'no_leido';
              item.detalle = c.error || 'No se pudo leer el XML';
              continue;
            }
            fallo = await tratarDocumento(lote, item, { ...c.documento }, ctx);
          }
          if (fallo) { if (++ctx.seguidos >= 2) ctx.detenido = true; } else ctx.seguidos = 0;
          // Un PDF que estaba en espera ya tiene su documento real: se retira el marcador.
          if (a.marcador && !fallo && item.estado !== 'en_espera' && item.documento_id && item.documento_id !== a.marcador) borrarMarcador(db, lote.officeId, a.marcador);
        } catch (e) {
          item.estado = 'error';
          item.detalle = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          if (++ctx.seguidos >= 2) ctx.detenido = true;
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
    if (!Array.isArray(archivos) || archivos.length === 0) {
      return res.status(400).json({ status: 'error', error: 'Envía "archivos": [{ nombre, contenido }]' });
    }
    if (archivos.length > 50) return res.status(400).json({ status: 'error', error: 'Máximo 50 archivos por lote' });
    const lista: ArchivoLote[] = [];
    for (const a of archivos as any[]) {
      if (!a || typeof a.nombre !== 'string') return res.status(400).json({ status: 'error', error: 'Cada archivo necesita un nombre' });
      if (typeof a.base64 === 'string') {
        const buf = Buffer.from(a.base64, 'base64');
        if (buf.length === 0 || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
          return res.status(400).json({ status: 'error', error: `"${a.nombre.slice(0, 80)}" no es un PDF válido` });
        }
        if (buf.length > MAX_PDF_BYTES) return res.status(400).json({ status: 'error', error: `"${a.nombre.slice(0, 80)}" supera 10 MB` });
        lista.push({ nombre: a.nombre, pdf: buf });
      } else if (typeof a.contenido === 'string') {
        lista.push({ nombre: a.nombre, contenido: a.contenido });
      } else {
        return res.status(400).json({ status: 'error', error: 'Cada archivo necesita "contenido" (texto del XML) o "base64" (PDF)' });
      }
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
    void procesarLote(lote, lista, req.body?.reprocesar === true);
    res.status(202).json({ status: 'ok', loteId, total: lote.total, inicio: inicioIso(lote) });
  });

  router.get('/oficinas/:officeId/tope', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    res.json({ status: 'ok', officeId: id, ...estadoTope(db, id), en_espera: pdfsEnEspera(db, id).length });
  });

  // Lee los PDF que quedaron en espera por tope, hasta donde alcance el cupo (útil al cambiar de mes o subir el tope).
  router.post('/oficinas/:officeId/en-espera/procesar', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    for (const l of lotes.values()) {
      if (l.officeId === id && !l.terminado) return res.status(409).json({ status: 'error', error: 'Esta oficina ya tiene un lote en proceso; espera a que termine' });
    }
    const esperando = pdfsEnEspera(db, id);
    if (!esperando.length) return res.json({ status: 'ok', total: 0, mensaje: 'No hay PDF en espera' });
    if (!hayCupo(db, id)) return res.status(409).json({ status: 'error', error: 'Aún no hay cupo en el tope de este mes', ...estadoTope(db, id) });
    const loteId = randomUUID();
    const lote: Lote = { officeId: id, total: esperando.length, items: [], terminado: false, creado: Date.now() };
    lotes.set(loteId, lote);
    void procesarLote(lote, esperando.map((e) => ({ nombre: e.nombre_archivo, textoPdf: e.texto_pdf, huella: e.huella, marcador: e.documento_id })), false);
    res.status(202).json({ status: 'ok', loteId, total: lote.total });
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
    const clienteExp = idValido(req.query.cliente); // un CSV por cliente: ?cliente=ID
    const filas = db
      .prepare(
        `SELECT documento_id, tipo_documento, fecha_documento, proveedor, nit_proveedor, estado, revision_humana, asiento_json
           FROM documentos_procesados WHERE office_id = ? ${clienteExp ? 'AND cliente_id = ' + clienteExp : ''} ${ids ? (ids.length ? `AND documento_id IN (${ids.map(() => '?').join(',')})` : 'AND 0') : ''}
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
    const exportados: string[] = [];
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
      exportados.push(f.documento_id);
      for (const l of lineas) {
        const codigo = (l.cuenta.match(/^\s*(\d+)/) || [])[1] || '';
        out.push([
          texto(f.fecha_documento), texto(f.documento_id), texto(f.tipo_documento), texto(f.nit_proveedor, true), texto(f.proveedor, true),
          texto(codigo), texto(l.cuenta, true), fmt(l.d as number), fmt(l.c as number), texto(f.estado), texto(f.revision_humana),
        ].join(';'));
      }
    }
    // Exportar deja los documentos en Exportado (salvo ?marcar=0 o ?todos=1, que son solo descargas de consulta).
    if (!todos && req.query.marcar !== '0' && exportados.length) {
      const ahora = new Date().toISOString();
      const marca = db.prepare('UPDATE documentos_procesados SET exportado_at = COALESCE(exportado_at, ?), updated_at = CURRENT_TIMESTAMP WHERE office_id = ? AND documento_id = ?');
      db.transaction(() => { for (const d of exportados) marca.run(ahora, oficina, d); })();
    }
    const sufijoCliente = clienteExp ? `_cliente_${clienteExp}` : '';
    const nombre = `asientos_oficina_${oficina.replace(/[^\w.-]/g, '_')}${sufijoCliente}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('X-Documentos-Excluidos', String(excluidos.length));
    if (excluidos.length) res.setHeader('X-Documentos-Excluidos-Ids', excluidos.slice(0, 20).join(',').replace(/[^\w.,-]/g, '_'));
    res.send('﻿' + out.join('\r\n') + '\r\n');
  });

  router.post('/oficinas/:officeId/documentos/eliminar', (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((x: unknown) => typeof x !== 'string' || !x)) {
      return res.status(400).json({ status: 'error', error: 'Indica los documentos a eliminar' });
    }
    res.json({ status: 'ok', ...eliminarDocumentos(db, String(req.params.officeId), ids as string[]) });
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

  // --- Clientes de la oficina ---

  router.get('/oficinas/:officeId/clientes', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    const clientes = db.prepare('SELECT * FROM clientes WHERE office_id = ? ORDER BY nombre').all(id) as any[];
    const docs = db
      .prepare('SELECT cliente_id, estado, revision_humana, exportado_at, en_espera, procesado_at FROM documentos_procesados WHERE office_id = ?')
      .all(String(id)) as any[];
    const lista = clientes.map((c) => {
      const suyos = docs.filter((d) => d.cliente_id === c.id).map((d) => ({ ...d, estado_pulpo: estadoPulpo(d) }));
      return {
        id: c.id, nit: c.nit, nombre: c.nombre, ...perfilDeCliente(c),
        conteos: conteosPorEstado(suyos),
        ultimo_documento: suyos.map((d) => d.procesado_at).sort().pop() ?? null,
      };
    });
    const sinCliente = docs.filter((d) => !d.cliente_id).length;
    res.json({ status: 'ok', total: lista.length, clientes: lista, documentos_sin_cliente: sinCliente });
  });

  router.post('/oficinas/:officeId/clientes', (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    const { nit, nombre, agente_retenedor_renta, gran_contribuyente } = req.body || {};
    if (!nitBase(nit)) return res.status(400).json({ status: 'error', error: 'Escribe el NIT del cliente.' });
    if (typeof nombre !== 'string' || !nombre.trim()) return res.status(400).json({ status: 'error', error: 'Escribe el nombre del cliente.' });
    if (db.prepare('SELECT 1 FROM clientes_nits WHERE office_id = ? AND nit = ?').get(id, nitBase(nit))) {
      return res.status(409).json({ status: 'error', error: 'Ya hay un cliente con ese NIT en esta oficina.' });
    }
    const c = crearCliente(db, id, { nit, nombre, agente_retenedor_renta: agente_retenedor_renta === true, gran_contribuyente: gran_contribuyente === true });
    res.status(201).json({ status: 'ok', cliente: { id: c.id, nit: c.nit, nombre: c.nombre, ...perfilDeCliente(c) } });
  });

  router.get('/oficinas/:officeId/clientes/:clienteId', (req, res) => {
    const id = idValido(req.params.officeId);
    const c = id ? obtenerCliente(db, id, Number(req.params.clienteId)) : undefined;
    if (!c) return res.status(404).json({ status: 'error', error: 'Cliente no encontrado' });
    res.json({ status: 'ok', cliente: { id: c.id, nit: c.nit, nombre: c.nombre, ...perfilDeCliente(c) } });
  });

  router.put('/oficinas/:officeId/clientes/:clienteId', (req, res) => {
    const id = idValido(req.params.officeId);
    const c = id ? obtenerCliente(db, id, Number(req.params.clienteId)) : undefined;
    if (!id || !c) return res.status(404).json({ status: 'error', error: 'Cliente no encontrado' });
    const { nombre, agente_retenedor_renta, gran_contribuyente } = req.body || {};
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) return res.status(400).json({ status: 'error', error: 'El nombre no puede quedar vacío.' });
    for (const [k, v] of [['agente_retenedor_renta', agente_retenedor_renta], ['gran_contribuyente', gran_contribuyente]]) {
      if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ status: 'error', error: `${k} debe ser true o false` });
    }
    db.prepare('UPDATE clientes SET nombre = ?, agente_retenedor_renta = ?, gran_contribuyente = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND office_id = ?').run(
      nombre !== undefined ? nombre.trim() : c.nombre,
      agente_retenedor_renta !== undefined ? (agente_retenedor_renta ? 1 : 0) : c.agente_retenedor_renta,
      gran_contribuyente !== undefined ? (gran_contribuyente ? 1 : 0) : c.gran_contribuyente,
      c.id, id
    );
    const n = obtenerCliente(db, id, c.id);
    res.json({ status: 'ok', cliente: { id: n.id, nit: n.nit, nombre: n.nombre, ...perfilDeCliente(n) } });
  });

  // La persona elige a qué cliente pertenece un documento que quedó sin cliente. Pulpo aprende el NIT
  // elegido (el del comprador por defecto, o el que se indique en "nit") y procesa el documento.
  router.post('/oficinas/:officeId/documentos/:documentoId/cliente', async (req, res) => {
    const id = idValido(req.params.officeId);
    if (!id) return res.status(400).json({ status: 'error', error: 'officeId inválido' });
    const docId = String(req.params.documentoId);
    const fila = db
      .prepare('SELECT estado, documento_json FROM documentos_procesados WHERE office_id = ? AND documento_id = ?')
      .get(String(id), docId) as { estado: string; documento_json: string | null } | undefined;
    if (!fila) return res.status(404).json({ status: 'error', error: 'Documento no encontrado' });
    if (fila.estado !== 'sin_cliente') {
      return res.status(409).json({ status: 'error', error: 'Este documento ya tiene cliente.' });
    }
    let doc: Record<string, any>;
    try { doc = JSON.parse(fila.documento_json || '{}'); } catch { doc = {}; }

    const { clienteId, nuevo, nit } = req.body || {};
    let cliente: any;
    if (nuevo && typeof nuevo === 'object') {
      if (!nitBase(nuevo.nit) || typeof nuevo.nombre !== 'string' || !nuevo.nombre.trim()) {
        return res.status(400).json({ status: 'error', error: 'Para crear el cliente escribe su NIT y su nombre.' });
      }
      if (db.prepare('SELECT 1 FROM clientes_nits WHERE office_id = ? AND nit = ?').get(id, nitBase(nuevo.nit))) {
        return res.status(409).json({ status: 'error', error: 'Ya hay un cliente con ese NIT en esta oficina.' });
      }
      cliente = crearCliente(db, id, {
        nit: nuevo.nit, nombre: nuevo.nombre,
        agente_retenedor_renta: nuevo.agente_retenedor_renta === true, gran_contribuyente: nuevo.gran_contribuyente === true,
      });
    } else {
      cliente = obtenerCliente(db, id, Number(clienteId));
      if (!cliente) return res.status(400).json({ status: 'error', error: 'Elige un cliente de la oficina.' });
    }
    const nitComprador = nitBase(doc.comprador?.nit);
    const nitVendedor = nitBase(doc.nit_proveedor);
    const nitElegido = nit !== undefined ? nitBase(nit) : (nitComprador || nitVendedor);
    if (nit !== undefined && nitElegido !== nitComprador && nitElegido !== nitVendedor) {
      return res.status(400).json({ status: 'error', error: 'Ese NIT no aparece en el documento.' });
    }
    const rol: 'comprador' | 'vendedor' = nitElegido === nitVendedor && nitElegido !== nitComprador ? 'vendedor' : 'comprador';
    if (nitElegido) aprenderNit(db, id, nitElegido, cliente.id);
    if (rol === 'comprador') doc.comprador = { ...(doc.comprador || {}), ...perfilDeCliente(cliente) };
    try {
      const resultado = await procesarDocumento(id, doc, rol);
      const guardado = guardarDocumento(db, id, doc, resultado, { clienteId: cliente.id, rol });
      if (guardado === null) {
        return res.status(502).json({ status: 'error', error: String(resultado?.error ?? 'No se pudo procesar el documento; inténtalo de nuevo.').slice(0, 300), cliente_id: cliente.id });
      }
    } catch (e) {
      return res.status(502).json({ status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 300), cliente_id: cliente.id });
    }
    res.json({ status: 'ok', documento: obtenerDocumento(db, String(id), docId) });
  });

  return router;
}

export default crearCrewsRouter;
