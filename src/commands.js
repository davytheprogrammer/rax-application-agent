import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function runCommand(command, directory, signal) {
  if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('Command must be nonempty and under 4,000 characters');
  const cwd = path.resolve(directory || process.cwd());
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory');
  if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
  const environment = { ...process.env };
  delete environment.MODEL_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-s'], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = 16000;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, 60000);
    const onAbort = () => killGroup();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(0, limit); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, limit); });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ cwd, exitCode: code, timedOut, stdout, stderr }); });
    child.stdin.end(command + '\n');
  });
}
