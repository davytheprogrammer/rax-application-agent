import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { closeTestChrome } from './close-test-chrome.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-stop-browser-'));
let responseMode = 'hang';
let modelStarted;
const modelRequest = new Promise(resolve => { modelStarted = resolve; });
const server = http.createServer(async (request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<title>Open application</title><h1>Chrome remains visible</h1>'); return; }
  if (request.url === '/responses') {
    if (responseMode === 'error') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled Muse rejection' } }));
      return;
    }
    modelStarted();
    request.on('close', () => { if (!response.writableEnded) response.destroy(); });
    return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn('node', ['src/desktop-bridge.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, KITO_DATA_DIR: path.join(temporary, 'data'), MODEL_API_KEY: 'local-test-key', MUSE_MODEL: 'local-test-model', MUSE_BASE_URL: origin },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const messages = [];
readline.createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch {} });
let nextId = 0;
function send(action, values = {}) { const requestId = ++nextId; child.stdin.write(JSON.stringify({ action, requestId, ...values }) + '\n'); return requestId; }
async function waitFor(predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    if (child.exitCode !== null) throw new Error('Bridge exited unexpectedly');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for desktop bridge');
}
try {
  const start = send('start', { url: origin, goal: 'Controlled stop test' });
  const started = await waitFor(item => item.kind === 'reply' && item.requestId === start);
  assert.equal(started.ok, true);
  await modelRequest;
  const began = Date.now();
  const stop = send('stop');
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === stop)).ok, true);
  await waitFor(item => item.kind === 'event' && item.type === 'record_updated', 5000);
  assert.ok(Date.now() - began < 5000, 'Stop responds without waiting for the slow model');
  const port = Number((await fs.readFile(path.join(temporary, 'data', 'chrome-profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).ok, true);
  responseMode = 'error';
  const resume = send('resume', { id: started.data.id, message: 'Continue the controlled application' });
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === resume)).ok, true);
  const failure = await waitFor(item => item.kind === 'event' && item.type === 'error', 15000);
  assert.match(failure.text, /Controlled Muse rejection/);
  await waitFor(item => item.kind === 'event' && item.type === 'record_updated', 5000);
  const saved = JSON.parse(await fs.readFile(path.join(temporary, 'data', 'applications', `${started.data.id}.json`), 'utf8'));
  assert.equal(saved.status, 'paused');
  assert.equal(saved.events.some(item => item.type === 'error' && String(item.detail).includes('Controlled Muse rejection')), true);
  console.log('Stop and error reporting passed: Chrome stays open and fatal errors are saved.');
} finally {
  child.stdin.end();
  if (child.exitCode === null) child.kill('SIGTERM');
  await closeTestChrome(path.join(temporary, 'data'));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
