import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-edges-'));
process.env.KITO_DATA_DIR = path.join(temporary, 'data');
process.env.MODEL_API_KEY = 'local-edge-test-key';
process.env.MUSE_MODEL = 'local-edge-test-model';
const privateFile = path.join(temporary, 'private-financials.txt');
await fs.writeFile(privateFile, 'controlled private test file');
let siteWrites = 0;
let modelRequests = 0;
let modelMode = 'normal';
let curatorMode = 'use';
const server = http.createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><textarea id="answer"></textarea><input type="file" aria-label="Pitch deck"><button id="login" onclick="window.open('/popup')">Login</button><button id="write" onclick="fetch('/write',{method:'POST'}).catch(()=>{})">Write</button><script>document.querySelector('#answer').addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') location.href='/done'; });</script>`);
    return;
  }
  if (request.url === '/popup') { response.setHeader('content-type', 'text/html'); response.end('<title>Login popup</title>'); return; }
  if (request.url === '/done') { response.setHeader('content-type', 'text/html'); response.end('<h1>Submitted</h1>'); return; }
  if (request.url === '/write') { siteWrites++; response.end('saved'); return; }
  if (request.url === '/responses') {
    modelRequests++;
    response.setHeader('content-type', 'application/json');
    if (modelMode === 'expired' && modelRequests === 2) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { message: 'previous_response_id not found' } }));
      return;
    }
    const output = modelMode === 'expired' && modelRequests === 1
      ? [{ type: 'function_call', name: 'browser_snapshot', call_id: 'call_1', arguments: '{}', status: 'completed' }]
      : [{ type: 'message', content: [{ type: 'output_text', text: 'Recovered.' }] }];
    response.end(JSON.stringify({ id: `resp_${modelRequests}`, output }));
    return;
  }
  if (request.url === '/chat/completions') {
    response.setHeader('content-type', 'application/json');
    if (curatorMode === 'error') { response.writeHead(500); response.end(JSON.stringify({ error: { message: 'service down' } })); return; }
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: 'use', text: 'Completely different invented answer.', note: 'Use it.' }) } }] }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.MUSE_BASE_URL = origin;

try {
  const { setAskHandler } = await import('../src/io.js');
  const { createApplication, loadApplication, saveApplication, listApplications, paths } = await import('../src/state.js');
  const { BrowserController } = await import('../src/browser.js');
  const { createResponse } = await import('../src/muse.js');
  const { AnswerCurator } = await import('../src/curator.js');
  const { runAgent } = await import('../src/agent.js');
  const record = await createApplication(`${origin}/`, 'Controlled edge cases');
  const browser = new BrowserController(record);
  let prompts = 0;
  setAskHandler(async () => { prompts++; return 'no'; });
  await browser.open();
  try {
    await browser.current().locator('#answer').focus();
    await assert.rejects(browser.upload({ label: 'Pitch deck' }, privateFile), /not attached/);
    record.sourceFiles.push(privateFile);
    await browser.upload({ label: 'Pitch deck' }, privateFile);
    await browser.current().locator('#write').click();
    await browser.wait(300);
    assert.equal(siteWrites, 1);
    let inApproval = 0;
    let maxConcurrentApprovals = 0;
    setAskHandler(async () => {
      prompts++;
      inApproval++;
      maxConcurrentApprovals = Math.max(maxConcurrentApprovals, inApproval);
      await new Promise(resolve => setTimeout(resolve, 40));
      inApproval--;
      return 'yes';
    });
    await browser.current().evaluate(() => Promise.all([fetch('/write', { method: 'POST' }), fetch('/write', { method: 'POST' })]));
    assert.equal(siteWrites, 3);
    assert.equal(maxConcurrentApprovals, 0);
    assert.equal(prompts, 0);
    const popupOpened = browser.context.waitForEvent('page');
    await browser.current().locator('#login').click();
    const popup = await popupOpened;
    await popup.waitForLoadState('domcontentloaded');
    await popup.close();
    assert.equal(browser.current().url(), `${origin}/`);
    await browser.current().locator('#answer').focus();
    await browser.pressKey('Control+Enter');
    await browser.current().waitForURL(/\/done/);
    assert.equal(Boolean(record.approvedSubmitAt), true);
    assert.equal(record.preSubmitSnapshot.fields.some(field => field.type === 'file' && field.value === 'private-financials.txt'), true);
  } finally { await browser.close(); }

  const concurrent = await createApplication(`${origin}/`, 'Concurrent write audit');
  const writes = await Promise.allSettled(Array.from({ length: 12 }, () => saveApplication(concurrent)));
  assert.equal(writes.filter(item => item.status === 'rejected').length, 0);
  const stale = { ...concurrent };
  await saveApplication(concurrent);
  await assert.rejects(saveApplication(stale), /changed in another process/);
  assert.equal((await loadApplication(concurrent.id)).revision, concurrent.revision);
  const brokenRecord = path.join(paths().applicationsDir, 'broken.json');
  await fs.writeFile(brokenRecord, '{incomplete');
  const previousWarn = console.warn;
  console.warn = () => {};
  try { assert.equal((await listApplications()).some(item => item.id === concurrent.id), true); }
  finally { console.warn = previousWarn; await fs.unlink(brokenRecord); }

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(createResponse({ input: 'probe', instructions: 'probe', tools: [], signal: aborted.signal }), /Stopped by user/);
  assert.equal(modelRequests, 0);

  const curator = new AnswerCurator(record, 'Verified founder facts only.');
  const draft = 'We build accessible founder tools and help people complete applications using verified information from their own records.';
  assert.equal((await curator.review({ draft, field: { label: 'Venture description' }, pageText: 'Describe your venture.' })).text, draft);
  curatorMode = 'error';
  assert.equal((await curator.review({ draft: draft + ' Please explain our approach.', field: { label: 'Approach' }, pageText: 'Explain your approach.' })).decision, 'use');

  modelMode = 'expired';
  modelRequests = 0;
  const recovery = await createApplication(`${origin}/`, 'Recover lost Muse context');
  await runAgent(recovery, recovery.goal, { emit: () => {}, keepBrowserOpen: false });
  assert.equal(modelRequests, 3);
  assert.equal(recovery.events.some(event => event.type === 'recovery'), true);
  console.log('Edge cases passed: autonomous same-origin upload and submission, popup fallback, concurrent saves, damaged record isolation, abort, curator fallback, and context recovery.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
