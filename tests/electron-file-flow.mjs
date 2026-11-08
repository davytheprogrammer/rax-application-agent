import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rax-electron-files-'));
const dataDir = path.join(temporary, 'data');
process.env.RAX_DATA_DIR = dataDir;
process.env.MUSE_MODEL = 'local-test-model';
process.env.MODEL_API_KEY = 'local-test-key';
const { createApplication, saveApplication } = await import('../src/state.js');
const record = await createApplication('https://example.org/apply', 'Controlled file attachment');
record.status = 'paused';
await saveApplication(record);
const testFile = path.join(temporary, 'resume.txt');
await fs.writeFile(testFile, 'Controlled resume text');
let electron;
try {
  electron = await _electron.launch({ args: ['.'], cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, XDG_CONFIG_HOME: path.join(temporary, 'config') } });
  await electron.firstWindow();
  let window;
  for (let attempt = 0; attempt < 50; attempt++) {
    window = electron.windows().find(page => page.url().includes('mode=main'));
    if (window) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(window, 'Rax main window opened');
  await window.locator('#rail-applications .rail-app').first().click();
  await window.locator('#attach-btn').click();
  await window.locator('#file-overlay').waitFor({ state: 'visible' });
  await window.waitForFunction(() => document.querySelector('#file-path').value.length > 0);
  await window.locator('#file-path').fill(temporary);
  await window.locator('#file-path').press('Enter');
  await window.locator('#file-browser-list').getByText('resume.txt').click();
  if (process.env.RAX_CAPTURE_FILE_UI === '1') await window.screenshot({ path: '/tmp/rax-file-selector.png' });
  await window.locator('#file-select').click();
  await window.locator('#file-overlay').waitFor({ state: 'hidden' });
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'applications', `${record.id}.json`), 'utf8'));
  assert.equal(saved.sourceFiles.includes(testFile), true);
  console.log('Electron file flow passed: in-app selection attaches a real local file through IPC.');
} finally {
  await electron?.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
