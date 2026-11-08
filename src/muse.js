import { config } from './config.js';
import { museFetch } from './muse-transport.js';

function stopped() { return new DOMException('Stopped by user', 'AbortError'); }
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(stopped()); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(stopped()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function createResponse({ input, previousResponseId, instructions, tools, signal, onWait = () => {} }) {
  const body = { model: config.model, instructions, input, tools, parallel_tool_calls: true, store: true };
  if (previousResponseId) body.previous_response_id = previousResponseId;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw stopped();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const heartbeat = setInterval(() => onWait(`Muse is still responding (attempt ${attempt + 1}/4). Checking again shortly.`), 12000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await museFetch(`${config.baseUrl}/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error(`Muse returned invalid JSON (HTTP ${response.status})`); }
      if (!response.ok) {
        const message = data.error?.message || data.message || `HTTP ${response.status}`;
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) { lastError = new Error(message); await delay(1000 * 2 ** attempt, signal); continue; }
        const error = new Error(`Muse API: ${message}`);
        error.status = response.status;
        error.code = data.error?.code;
        throw error;
      }
      if (!data.id || !Array.isArray(data.output)) throw new Error('Muse response is missing id or output');
      return data;
    } catch (error) {
      if (signal?.aborted) throw stopped();
      lastError = error;
      const transientNetworkFailure = error.name === 'AbortError' ||
        error instanceof TypeError && /fetch failed/i.test(error.message) ||
        ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH'].includes(error.cause?.code);
      if (!transientNetworkFailure || attempt >= 3) break;
      await delay(1000 * 2 ** attempt, signal);
    } finally { clearTimeout(timeout); clearInterval(heartbeat); signal?.removeEventListener('abort', onAbort); }
  }
  throw lastError;
}
