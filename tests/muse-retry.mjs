import assert from 'node:assert/strict';

process.env.MODEL_API_KEY = 'local-test-key';
process.env.MUSE_MODEL = 'local-test-model';
const { createResponse } = await import('../src/muse.js');

const originalFetch = globalThis.fetch;
let calls = 0;
try {
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }) });
    return new Response(JSON.stringify({ id: 'response-after-retry', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await createResponse({ input: [{ role: 'user', content: 'Connectivity check' }], instructions: 'Test', tools: [] });
  assert.equal(result.id, 'response-after-retry');
  assert.equal(calls, 2);
  console.log('Muse network retry passed: a transient connection failure is retried.');
} finally {
  globalThis.fetch = originalFetch;
}
