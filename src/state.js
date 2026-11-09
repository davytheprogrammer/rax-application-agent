import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { config } from './config.js';

const applicationsDir = path.join(config.dataDir, 'applications');
const profilePath = path.join(config.dataDir, 'profile.md');
const homeChatPath = path.join(config.dataDir, 'home-chat.json');
const answerCachePath = path.join(config.dataDir, 'answer-cache.json');
const browserDir = path.join(config.dataDir, 'chrome-profile');
const newDocumentsDir = path.join(os.homedir(), 'Documents', 'Rax');
const oldDocumentsDir = path.join(os.homedir(), 'Documents', 'Kito');
const documentsDir = existsSync(newDocumentsDir) ? newDocumentsDir : existsSync(oldDocumentsDir) ? oldDocumentsDir : newDocumentsDir;
const writeQueues = new Map();

export async function ensureState() {
  await fs.mkdir(applicationsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(browserDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(documentsDir, { recursive: true, mode: 0o700 });
  try { await fs.access(profilePath); } catch {
    await fs.writeFile(profilePath, '# Applicant knowledge\n\nAdd verified facts about your experience, education, projects, ventures, links, eligibility, and reusable answers here. Do not add passwords or API keys.\n', { mode: 0o600 });
  }
}

export function paths() { return { dataDir: config.dataDir, applicationsDir, profilePath, homeChatPath, answerCachePath, browserDir, documentsDir }; }
export async function readProfile() { await ensureState(); return fs.readFile(profilePath, 'utf8'); }
function normalizeQuestion(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokens(value) { return new Set(normalizeQuestion(value).split(' ').filter(token => token.length > 2)); }
export function projectKey(url, goal = '') {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const goalKey = normalizeQuestion(goal).split(' ').filter(token => token.length > 3).slice(0, 8).join('-');
  return `${host || 'unknown'}:${goalKey}`;
}
export async function findCachedAnswer({ question, fieldType = '', maxLength = null, profileHash = '', highRisk = false } = {}) {
  await ensureState();
  let entries = [];
  try { entries = JSON.parse(await fs.readFile(answerCachePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(entries)) return null;
  const query = normalizeQuestion(question);
  const queryTokens = tokens(query);
  const eligible = entries.filter(entry => entry?.answer && (!fieldType || !entry.fieldType || entry.fieldType === fieldType) && (!maxLength || entry.answer.length <= maxLength) && (!highRisk || entry.profileHash === profileHash));
  const exact = eligible.find(entry => entry.questionKey === query);
  if (exact) return { ...exact, matchedBy: 'exact' };
  let best = null;
  for (const entry of eligible) {
    const candidate = tokens(entry.questionKey);
    const overlap = [...queryTokens].filter(token => candidate.has(token)).length;
    const score = overlap / Math.max(queryTokens.size, candidate.size, 1);
    if (score >= 0.78 && (!best || score > best.score)) best = { ...entry, matchedBy: 'similar', score };
  }
  return best;
}
export async function rememberAnswer({ question, answer, fieldType = '', maxLength = null, profileHash = '', highRisk = false, source = 'curated' } = {}) {
  await ensureState();
  const questionKey = normalizeQuestion(question);
  if (!questionKey || typeof answer !== 'string' || !answer.trim()) return null;
  let entries = [];
  try { entries = JSON.parse(await fs.readFile(answerCachePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(entries)) entries = [];
  const entry = { questionKey, answer: answer.trim(), fieldType, maxLength, profileHash, highRisk, source, verifiedAt: new Date().toISOString() };
  entries = [entry, ...entries.filter(item => item?.questionKey !== questionKey)].slice(0, 300);
  await writeJsonAtomic(answerCachePath, entries);
  return entry;
}
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
  const record = { id: `${now.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`, revision: 0, url, currentUrl: url, projectKey: projectKey(url, goal), goal, model: config.model, status: 'active', createdAt: now, updatedAt: now, responseId: null, pendingCalls: [], pendingOutputs: [], sourceFiles: [], notes: [], events: [], timings: [], answerPlan: [], completedFields: [], checkpoint: null, summary: '', confirmation: null };
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
