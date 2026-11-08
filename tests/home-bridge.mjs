import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { closeTestChrome } from './close-test-chrome.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-home-bridge-'));
let plannerCalls = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/apply') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Test application</title><h1>Test application</h1>'); return; }
  if (request.url === '/v1/responses') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const planning = String(body.instructions).includes('Interpret the latest user request');
    if (planning && raw.includes('please cancel this request')) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (response.destroyed) return;
    }
    const content = planning
      ? plannerCalls++ === 0
        ? JSON.stringify({ action: 'respond', reply: 'Hi. Tell me about the application.', goal: '', url: '', searchQuery: '' })
        : JSON.stringify({ action: 'start', reply: 'I am opening the application.', goal: 'Complete the controlled application', url: `${origin}/apply`, searchQuery: '' })
      : 'The controlled application is open.';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `response-${Date.now()}`, output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn('node', ['src/desktop-bridge.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, KITO_DATA_DIR: path.join(temp, 'data'), MODEL_API_KEY: 'local-test-key', MUSE_MODEL: 'local-test-model', MUSE_BASE_URL: `${origin}/v1` }, stdio: ['pipe', 'pipe', 'pipe'] });
const messages = [];
let stderr = '';
child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 1000); });
readline.createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch {} });
let nextId = 0;
function send(action, values = {}) { const requestId = ++nextId; child.stdin.write(JSON.stringify({ action, requestId, ...values }) + '\n'); return requestId; }
async function waitFor(predicate, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    if (child.exitCode !== null) throw new Error(`Bridge exited: ${stderr.slice(0, 200)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for bridge: ${stderr.slice(0, 200)}`);
}
try {
  const greeting = send('home_request', { message: 'Hi Kito' });
  const first = await waitFor(item => item.kind === 'reply' && item.requestId === greeting);
  assert.equal(first.ok, true);
  assert.equal(first.data.action, 'respond');
  const stateRequest = send('state');
  const state = await waitFor(item => item.kind === 'reply' && item.requestId === stateRequest);
  assert.equal(state.data.homeChat.length, 2);
  const work = send('home_request', { message: `Help me complete ${origin}/apply` });
  const second = await waitFor(item => item.kind === 'reply' && item.requestId === work);
  assert.equal(second.ok, true);
  assert.equal(second.data.action, 'start');
  assert.equal(Boolean(second.data.id), true);
  await waitFor(item => item.kind === 'event' && item.type === 'record_updated', 30000);
  const saved = JSON.parse(await fs.readFile(path.join(temp, 'data', 'applications', `${second.data.id}.json`), 'utf8'));
  assert.equal(saved.url, `${origin}/apply`);
  assert.equal(saved.status, 'paused');
  assert.equal(JSON.parse(await fs.readFile(path.join(temp, 'data', 'home-chat.json'), 'utf8')).length, 4);
  const pending = send('home_request', { message: 'please cancel this request' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const cancel = send('cancel_home_request');
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === cancel)).data.cancelled, true);
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === pending)).ok, false);
  console.log('Home bridge passed: desktop chat response, persistence, and application start.');
} finally {
  child.stdin.end();
  if (child.exitCode === null) child.kill('SIGTERM');
  await closeTestChrome(path.join(temp, 'data'));
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
