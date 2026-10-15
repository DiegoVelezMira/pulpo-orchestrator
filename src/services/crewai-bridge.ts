import { spawn } from 'child_process';
import path from 'path';

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

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
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
      reject(error);
    });

    pythonProcess.stdin.write(JSON.stringify(documentData));
    pythonProcess.stdin.end();
  });
}
