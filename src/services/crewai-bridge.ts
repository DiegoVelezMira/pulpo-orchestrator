import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

interface CrewAIResult {
  status: string;
  [key: string]: any;
}

export async function executeContableCrew(
  documentData: Record<string, any>
): Promise<CrewAIResult> {
  return new Promise((resolve, reject) => {
    const crewPath = path.join(process.cwd(), 'crews', 'contable_crew.py');
    const pythonProcess = spawn('python3', [crewPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    // Un proceso colgado no debe dejar la solicitud (ni un lote) esperando para siempre.
    const limite = setTimeout(() => {
      pythonProcess.kill('SIGKILL');
      reject(new Error('El crew superó los 300 s y se canceló'));
    }, 300_000);

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      clearTimeout(limite);
      try {
        if (code !== 0 && code !== 1) {
          reject(new Error(`Python process exited with code ${code}: ${stderr}`));
          return;
        }

        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse Python output: ${stdout}`));
      }
    });

    pythonProcess.on('error', (error) => {
      clearTimeout(limite);
      reject(error);
    });

    pythonProcess.stdin.on('error', () => {}); // si el hijo muere antes de leer, 'close' ya reporta el fallo
    pythonProcess.stdin.write(JSON.stringify(documentData));
    pythonProcess.stdin.end();
  });
}

export interface ConversionXml {
  ok: boolean;
  documento?: Record<string, any>;
  avisos?: string[];
  error?: string;
}

// Convierte un XML de factura electronica (texto) en el documento del crew, sin modelos y sin anonimizar.
export async function convertirXml(
  contenido: string,
  retenedor: boolean,
  granContribuyente: boolean
): Promise<ConversionXml> {
  const tmp = path.join(os.tmpdir(), `pulpo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(tmp, contenido, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    const script = path.join(process.cwd(), 'crews', 'xml_a_documento.py');
    return await new Promise<ConversionXml>((resolve, reject) => {
      const p = spawn(
        'python3',
        [script, tmp, '--retenedor', retenedor ? 'si' : 'no', '--gran', granContribuyente ? 'si' : 'no'],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let out = '';
      let err = '';
      const limite = setTimeout(() => p.kill('SIGKILL'), 30_000);
      p.stdout.on('data', (d) => (out += d.toString()));
      p.stderr.on('data', (d) => (err += d.toString()));
      // python3 ausente o no ejecutable es un problema del servidor, no del XML: se propaga (el lote lo cuenta como error).
      p.on('error', (e) => { clearTimeout(limite); reject(new Error(`No se pudo ejecutar el conversor: ${e.message}`)); });
      p.on('close', () => {
        clearTimeout(limite);
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({ ok: false, error: `Respuesta inválida del conversor: ${(err || out).slice(0, 200)}` });
        }
      });
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
