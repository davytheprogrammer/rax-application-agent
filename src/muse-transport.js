import { Agent } from 'undici';

const metaDispatcher = new Agent({ connect: { family: 4, timeout: 10000 }, keepAliveTimeout: 1000 });

export function museFetch(url, options) {
  const host = new URL(url).hostname;
  return fetch(url, host === 'api.meta.ai' ? { ...options, dispatcher: metaDispatcher } : options);
}
