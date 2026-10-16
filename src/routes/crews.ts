import express from 'express';
import Database from 'better-sqlite3';
import { executeContableCrew } from '../services/crewai-bridge';

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

  const router = express.Router();

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

      res.json(resultado);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  });

  return router;
}

export default crearCrewsRouter;
