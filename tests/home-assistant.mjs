import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rax-home-test-'));
process.env.RAX_DATA_DIR = path.join(temp, 'data');
process.env.MODEL_API_KEY = 'local-test-key';
process.env.MUSE_MODEL = 'local-test-model';
process.env.MUSE_BASE_URL = 'http://127.0.0.1:1/v1';
const { interpretHomeRequest } = await import('../src/home-assistant.js');
const { readHomeChat, saveHomeChat } = await import('../src/state.js');
const originalFetch = globalThis.fetch;
let next;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'test-response', output: [{ type: 'message', content: [{ type: 'output_text', text: next }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  next = JSON.stringify({ action: 'respond', reply: 'Hi. Tell me what you want to work on.', goal: '', url: '', searchQuery: '' });
  assert.equal((await interpretHomeRequest({ message: 'Hi Rax' })).action, 'respond');
  next = JSON.stringify({ action: 'start', reply: 'I will open the application.', goal: 'Apply to the test program', url: 'https://example.org/apply', searchQuery: '' });
  const direct = await interpretHomeRequest({ message: 'Apply here: https://example.org/apply' });
  assert.equal(direct.action, 'start');
  assert.equal(direct.url, 'https://example.org/apply');
  next = JSON.stringify({ action: 'start', reply: 'I will look for the program.', goal: 'Find the test program', url: 'https://invented.example/apply', searchQuery: 'test program application' });
  const search = await interpretHomeRequest({ message: 'Find the test program application' });
  assert.equal(search.url, '');
  assert.equal(search.searchQuery, 'test program application');
  next = 'not valid JSON';
  assert.equal((await interpretHomeRequest({ message: 'Help me apply' })).action, 'clarify');
  const saved = await saveHomeChat([{ role: 'user', text: 'Hi Rax' }, { role: 'assistant', text: 'Hi.' }]);
  assert.equal(saved.length, 2);
  assert.equal((await readHomeChat()).map(item => item.text).join('|'), 'Hi Rax|Hi.');
  console.log('Home assistant passed: conversation, safe URL choice, malformed output, and persistence.');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(temp, { recursive: true, force: true });
}
