import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './state.js';
import { readFile } from './files.js';

const INDEX_VERSION = 1;
const DIMENSIONS = 384;
const supported = new Set(['.pdf', '.docx', '.txt', '.md', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.htm', '.xml', '.log']);

function normalize(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function terms(text) { return normalize(text).split(' ').filter(token => token.length > 2); }
function hash(value) { return crypto.createHash('sha1').update(value).digest('hex'); }
function vector(text) {
  const values = new Float32Array(DIMENSIONS);
  const source = terms(text);
  for (let i = 0; i < source.length; i++) {
    const token = source[i];
    const index = Number.parseInt(hash(`t:${token}`).slice(0, 8), 16) % DIMENSIONS;
    values[index] += 1;
    if (i + 1 < source.length) values[Number.parseInt(hash(`b:${token}:${source[i + 1]}`).slice(0, 8), 16) % DIMENSIONS] += 0.55;
  }
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return [...values].map(value => Number((value / norm).toFixed(5)));
}
function cosine(a, b) { let score = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) score += a[i] * b[i]; return score; }
function lexical(query, text) {
  const wanted = new Set(terms(query));
  const found = terms(text);
  if (!wanted.size || !found.length) return 0;
  const hits = found.reduce((sum, token) => sum + (wanted.has(token) ? 1 : 0), 0);
  return hits / Math.sqrt(wanted.size * found.length);
}
function chunks(text, size = 1400, overlap = 180) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  const output = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    const chunk = clean.slice(start, start + size).trim();
    if (chunk.length >= 80) output.push(chunk);
    if (start + size >= clean.length) break;
  }
  return output;
}
async function walk(root, output = [], depth = 0) {
  if (depth > 3 || output.length >= 100) return output;
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(full, output, depth + 1);
    else if (supported.has(path.extname(entry.name).toLowerCase())) output.push(full);
    if (output.length >= 100) break;
  }
  return output;
}
async function sourceFiles(explicit = []) {
  const candidates = [...await walk(paths().documentsDir), ...explicit];
  return [...new Set(candidates)].slice(0, 120);
}

export async function createKnowledgeIndex(profile = '', explicitFiles = []) {
  const indexPath = path.join(paths().dataDir, 'knowledge-index.json');
  let old = null;
  try { old = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch {}
  const files = await sourceFiles(explicitFiles);
  const sources = [];
  if (profile.trim()) sources.push({ path: 'profile.md', modifiedAt: 'profile', content: profile });
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 20_000_000) continue;
      const previous = old?.sources?.find(item => item.path === file && item.bytes === stat.size && item.modifiedAt === stat.mtime.toISOString());
      if (previous) { sources.push(previous); continue; }
      const result = await readFile(file, 120_000);
      sources.push({ path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), content: result.content });
    } catch { /* Unsupported or unreadable sources do not block applications. */ }
  }
  const entries = sources.flatMap(source => chunks(source.content).map((content, order) => ({ id: hash(`${source.path}:${order}:${content}`), source: source.path, order, content, vector: vector(content) })));
  const index = { version: INDEX_VERSION, builtAt: new Date().toISOString(), sources, entries };
  await fs.mkdir(paths().dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(indexPath, JSON.stringify(index), { mode: 0o600 });
  return index;
}

export function searchKnowledge(index, query, limit = 6) {
  if (!index?.entries?.length || !String(query || '').trim()) return [];
  const queryVector = vector(query);
  return index.entries.map(entry => ({ ...entry, score: cosine(queryVector, entry.vector) * 0.78 + lexical(query, entry.content) * 0.22 }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ vector: ignored, ...entry }) => ({ ...entry, score: Number(entry.score.toFixed(4)) }));
}

export function formatKnowledge(results, maxChars = 12000) {
  let output = '';
  for (const item of results || []) {
    const block = `\n[Source: ${item.source}; relevance ${item.score}]\n${item.content}`;
    if (output.length + block.length > maxChars) break;
    output += block;
  }
  return output.trim() || 'No relevant dossier or document context was found.';
}
