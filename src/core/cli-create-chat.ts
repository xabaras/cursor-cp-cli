/**
 * Create a new Cursor CLI chat via `agent create-chat`.
 */

import { spawn } from 'node:child_process';

export async function createCliChat(options: {
  agentBin: string;
  cwd: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<{ chatId: string }> {
  const env = { ...process.env };
  if (options.apiKey) env.CURSOR_API_KEY = options.apiKey;

  return new Promise((resolve, reject) => {
    const child = spawn(options.agentBin, ['create-chat'], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('create-chat timed out'));
    }, options.timeoutMs ?? 60_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const id = stdout.trim().split(/\s+/).find((t) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
      );
      if (code === 0 && id) {
        resolve({ chatId: id });
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `create-chat exited with code ${code}`
        )
      );
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
