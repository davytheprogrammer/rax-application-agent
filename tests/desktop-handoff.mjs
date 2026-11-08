import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { closeTestChrome } from './close-test-chrome.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-desktop-flow-'));
const sourceFile = path.join(temporary, 'resume.txt');
await fs.writeFile(sourceFile, 'Controlled resume');
let modelRequests = 0;
let releaseThird;
let thirdRequested;
const thirdRequest = new Promise(resolve => { thirdRequested = resolve; });
const thirdGate = new Promise(resolve => { releaseThird = resolve; });
const server = http.createServer(async (request, response) => {
  if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<title>Application</title><h1>Application page</h1>'); return; }
  if (request.url === '/responses') {
    modelRequests++;
    if (modelRequests === 3) { thirdRequested(); await thirdGate; }
    const calls = [
      { name: 'handoff_to_user', args: { message: 'Please sign in or sign up in Chrome, then return.' } },
      { name: 'ask_user', args: { question: 'What is your verified project name?' } },
      { name: 'browser_snapshot', args: {} },
      { name: 'pick_file', args: { purpose: 'Choose the resume for this application' } },
    ];
    const call = calls[modelRequests - 1];
    const output = call
      ? [{ type: 'function_call', name: call.name, call_id: `call_${modelRequests}`, arguments: JSON.stringify(call.args), status: 'completed' }]
      : [{ type: 'message', content: [{ type: 'output_text', text: 'Application paused after handback.' }] }];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `resp_${modelRequests}`, output }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn('node', ['src/desktop-bridge.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, KITO_DATA_DIR: path.join(temporary, 'data'), MODEL_API_KEY: 'local-desktop-test-key', MUSE_MODEL: 'local-desktop-test-model', MUSE_BASE_URL: origin },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const messages = [];
readline.createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch {} });
let nextId = 0;
function send(action, values = {}) { const requestId = ++nextId; child.stdin.write(JSON.stringify({ action, requestId, ...values }) + '\n'); return requestId; }
async function waitFor(predicate, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    if (child.exitCode !== null) throw new Error(`Bridge exited early: ${child.exitCode}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for desktop bridge event');
}
try {
  const started = send('start', { url: `${origin}/`, goal: 'Controlled handoff' });
  const reply = await waitFor(item => item.kind === 'reply' && item.requestId === started);
  assert.equal(reply.ok, true);
  const id = reply.data.id;
  const handoff = await waitFor(item => item.kind === 'request_input' && item.purpose === 'handoff');
  send('answer', { id: handoff.id, answer: 'done' });
  const question = await waitFor(item => item.kind === 'request_input' && item.purpose === 'clarification');
  assert.match(question.question, /project name/);
  const pendingState = send('state');
  const pendingReply = await waitFor(item => item.kind === 'reply' && item.requestId === pendingState);
  assert.equal(pendingReply.data.activeId, id);
  assert.equal(pendingReply.data.pendingPrompt.purpose, 'clarification');
  const chatRequest = send('chat', { id, text: 'Verified Project Name' });
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === chatRequest)).data.delivered, true);
  await waitFor(item => item.kind === 'event' && item.type === 'input_resolved' && item.id === question.id);
  await thirdRequest;
  const blockedChat = send('chat', { id, text: 'Do unrelated work while running' });
  const blockedReply = await waitFor(item => item.kind === 'reply' && item.requestId === blockedChat);
  assert.equal(blockedReply.ok, false);
  assert.match(blockedReply.error, /Stop the run/);
  const takeoverRequest = send('takeover');
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === takeoverRequest)).data.paused, true);
  releaseThird();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(modelRequests, 3);
  assert.equal(messages.some(item => item.kind === 'event' && item.type === 'tool' && item.name === 'browser_snapshot'), false);
  const handbackRequest = send('handback', { message: 'I completed sign-in.' });
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === handbackRequest)).data.resumed, true);
  const picker = await waitFor(item => item.kind === 'request_file');
  assert.match(picker.purpose, /resume/);
  const fileAnswer = send('answer', { id: picker.id, answer: sourceFile });
  assert.equal((await waitFor(item => item.kind === 'reply' && item.requestId === fileAnswer)).ok, true);
  await waitFor(item => item.kind === 'event' && item.type === 'record_updated', 30000);
  assert.equal(modelRequests, 5);
  const record = JSON.parse(await fs.readFile(path.join(temporary, 'data', 'applications', `${id}.json`), 'utf8'));
  assert.equal(record.chat.some(item => item.role === 'assistant' && item.text.includes('project name')), true);
  assert.equal(record.chat.some(item => item.role === 'user' && item.text === 'Verified Project Name'), true);
  assert.equal(record.controlMode, 'agent');
  assert.equal(record.sourceFiles.includes(sourceFile), true);
  assert.equal(record.events.some(item => item.type === 'tool' && item.detail?.name === 'browser_snapshot'), false);
  console.log('Desktop handoff passed: login handoff, clarification chat, takeover, stale action skip, and handback.');
} finally {
  releaseThird();
  child.stdin.end();
  if (child.exitCode === null) child.kill('SIGTERM');
  await closeTestChrome(path.join(temporary, 'data'));
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
