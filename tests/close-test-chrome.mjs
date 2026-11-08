import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export async function closeTestChrome(dataDir) {
  const portFile = path.join(dataDir, 'chrome-profile', 'DevToolsActivePort');
  let port;
  try { port = Number((await fs.readFile(portFile, 'utf8')).split('\n')[0]); } catch { return; }
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
    try { await (await browser.newBrowserCDPSession()).send('Browser.close'); } catch {}
    await browser.close().catch(() => {});
  } catch {}
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fs.access(portFile); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
