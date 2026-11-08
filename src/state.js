import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { config } from './config.js';

const applicationsDir = path.join(config.dataDir, 'applications');
const profilePath = path.join(config.dataDir, 'profile.md');
const homeChatPath = path.join(config.dataDir, 'home-chat.json');
const browserDir = path.join(config.dataDir, 'chrome-profile');
const documentsDir = path.join(os.homedir(), 'Documents', 'Kito');
const writeQueues = new Map();

export async function ensureState() {
  await fs.mkdir(applicationsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(browserDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(documentsDir, { recursive: true, mode: 0o700 });
  try { await fs.access(profilePath); } catch {
    await fs.writeFile(profilePath, '# Applicant knowledge\n\nAdd verified facts about your experience, education, projects, ventures, links, eligibility, and reusable answers here. Do not add passwords or API keys.\n', { mode: 0o600 });
  }
}

export function paths() { return { applicationsDir, profilePath, homeChatPath, browserDir, documentsDir }; }
export async function readProfile() { await ensureState(); return fs.readFile(profilePath, 'utf8'); }
export async function readHomeChat() {
  await ensureState();
  try {
    const items = JSON.parse(await fs.readFile(homeChatPath, 'utf8'));
    return Array.isArray(items) ? items.filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string').slice(-60) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error instanceof SyntaxError) { console.warn('Ignoring unreadable home chat history'); return []; }
    throw error;
  }
}
export async function saveHomeChat(items) {
  await ensureState();
  const safe = items.filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string').slice(-60).map(item => ({ role: item.role, text: item.text.slice(0, 5000), at: item.at || new Date().toISOString() }));
  await writeJsonAtomic(homeChatPath, safe);
  return safe;
}
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function createApplication(url, goal) {
  await ensureState();
  const now = new Date().toISOString();
  const record = { id: `${now.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`, revision: 0, url, currentUrl: url, goal, model: config.model, status: 'active', createdAt: now, updatedAt: now, responseId: null, pendingOutputs: [], sourceFiles: [], notes: [], events: [], summary: '', confirmation: null };
  await saveApplication(record);
  return record;
}
export async function saveApplication(record) {
  const file = path.join(applicationsDir, `${record.id}.json`);
  const previous = writeQueues.get(file) || Promise.resolve();
  const queued = previous.catch(() => {}).then(async () => {
    const lock = `${file}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await fs.open(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await fs.unlink(lock); } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!handle) throw new Error(`Timed out waiting for application lock: ${record.id}`);
    try {
      let current;
      try { current = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((current?.revision || 0) !== (record.revision || 0)) throw new Error(`Application ${record.id} changed in another process. Reload before saving.`);
      record.revision = (current?.revision || 0) + 1;
      record.updatedAt = new Date().toISOString();
      await writeJsonAtomic(file, record);
    } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
  });
  writeQueues.set(file, queued);
  try { await queued; } finally { if (writeQueues.get(file) === queued) writeQueues.delete(file); }
}
export async function loadApplication(id) {
  await ensureState();
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid application ID');
  return JSON.parse(await fs.readFile(path.join(applicationsDir, `${id}.json`), 'utf8'));
}
export async function listApplications() {
  await ensureState();
  const names = (await fs.readdir(applicationsDir)).filter(name => name.endsWith('.json'));
  const records = await Promise.all(names.map(async name => {
    try {
      const record = JSON.parse(await fs.readFile(path.join(applicationsDir, name), 'utf8'));
      if (!record || typeof record.id !== 'string' || typeof record.updatedAt !== 'string') throw new Error('invalid record');
      return record;
    } catch (error) {
      console.warn(`Skipping unreadable application record ${name}: ${error.message}`);
      return null;
    }
  }));
  return records.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function journal(record, type, detail) {
  record.events.push({ at: new Date().toISOString(), type, detail });
  if (record.events.length > 500) record.events.splice(0, record.events.length - 500);
}
