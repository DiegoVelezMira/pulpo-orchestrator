import express from 'express';
import { executeContableCrew } from '../services/crewai-bridge';

const router = express.Router();

router.post('/contable/procesar', async (req, res) => {
  try {
    const { documento, officeId } = req.body;

    if (!documento) {
      return res.status(400).json({
        status: 'error',
        error: 'Campo "documento" requerido',
      });
    }

    const resultado = await executeContableCrew({
      id: officeId || 'sin_id',
      ...documento,
    });

    res.json(resultado);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Error desconocido',
    });
  }
});

export default router;
