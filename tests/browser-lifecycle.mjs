import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-browser-life-'));
process.env.KITO_DATA_DIR = path.join(temporary, 'data');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/slow') {
    response.write('<!doctype html><title>Slow page</title><h1>Partial page is visible</h1>');
    setTimeout(() => response.end('<p>Finished</p>'), 12000);
    return;
  }
  response.end('<!doctype html><title>Still open</title><h1>Chrome stays open</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const { BrowserController } = await import('../src/browser.js');
const record = { id: 'browser-lifecycle', url, currentUrl: url, sourceFiles: [] };
const waitEvents = [];
const first = new BrowserController(record, { onWait: value => waitEvents.push(value) });
let second;
try {
  await first.open();
  assert.match((await first.snapshot()).text, /Chrome stays open/);
  const began = Date.now();
  const partial = await first.goto(`${url}slow`);
  assert.match(partial.text, /Partial page is visible/);
  assert.ok(Date.now() - began < 11500, 'Kito inspects a partial page without waiting for the whole response');
  assert.ok(waitEvents.some(value => /still rendering/.test(value)));
  await first.detach();
  const port = Number((await fs.readFile(path.join(temporary, 'data', 'chrome-profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  const endpoint = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.equal(endpoint.ok, true, 'Chrome remains running after Kito detaches');
  record.responseId = 'previous-run';
  second = new BrowserController(record);
  await second.open();
  assert.match((await second.snapshot()).text, /Partial page is visible/);
  const newRecord = { id: 'another-application', url, currentUrl: url, sourceFiles: [], events: [] };
  const third = new BrowserController(newRecord);
  try {
    await third.open();
    assert.equal(third.current().url(), url);
    assert.ok(third.context.pages().length >= 2, 'new applications use a new tab');
  } finally { await third.detach(); }
  console.log('Browser lifecycle passed: Chrome stays open, Kito reconnects, and slow pages are inspected early.');
} finally {
  await second?.close().catch(() => {});
  await first.detach().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
