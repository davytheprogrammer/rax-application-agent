import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { paths } from './state.js';
const execFileAsync = promisify(execFile);
const ignored = new Set(['node_modules', '.git', '.cache', '.local', '.npm', '.config', 'chrome-profile']);
const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.htm', '.xml', '.log', '.js', '.ts', '.py', '.env.example']);
function absolute(p) { return path.resolve(p.replace(/^~(?=\/|$)/, os.homedir())); }

export async function browseDirectory(directory, query = '') {
  const current = absolute(String(directory || paths().documentsDir));
  const stat = await fs.stat(current);
  if (!stat.isDirectory()) throw new Error('Choose a folder to browse');
  const entries = await fs.readdir(current, { withFileTypes: true });
  const needle = String(query || '').trim().toLowerCase().slice(0, 200);
  const eligible = entries.filter(entry => !entry.name.startsWith('.') && (!needle || entry.name.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const visible = eligible.slice(0, 500);
  const items = await Promise.all(visible.map(async entry => {
    const file = path.join(current, entry.name);
    let info;
    try { info = await fs.stat(file); } catch { return null; }
    return info.isFile() || info.isDirectory() ? { name: entry.name, path: file, type: info.isDirectory() ? 'directory' : 'file', bytes: info.isFile() ? info.size : null } : null;
  }));
  return {
    directory: current,
    parent: path.dirname(current),
    locations: { rax: paths().documentsDir, downloads: path.join(os.homedir(), 'Downloads'), home: os.homedir() },
    items: items.filter(Boolean).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    truncated: eligible.length > visible.length,
  };
}

export async function listFiles(directory, query = '', limit = 80) {
  const root = absolute(directory || os.homedir());
  const matches = [];
  const needle = query.toLowerCase();
  const visit = async (dir, depth) => {
    if (depth > 4 || matches.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (matches.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!needle || entry.name.toLowerCase().includes(needle)) matches.push({ path: full, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(full, depth + 1);
    }
  };
  await visit(root, 0);
  return { root, matches };
}

export async function readFile(file, maxChars = 30000) {
  const full = absolute(file);
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (stat.size > 20_000_000) throw new Error('File is over 20 MB; select a smaller source');
  const extension = path.extname(full).toLowerCase();
  let content;
  if (extension === '.pdf') {
    try { content = (await execFileAsync('pdftotext', ['-layout', full, '-'], { maxBuffer: 5_000_000 })).stdout; }
    catch { throw new Error('PDF extraction needs pdftotext (poppler-utils) installed'); }
  } else if (extension === '.docx') {
    content = (await mammoth.extractRawText({ path: full })).value;
  } else if (textExtensions.has(extension) || !extension) {
    content = await fs.readFile(full, 'utf8');
    if (content.includes('\u0000')) throw new Error('Binary file; use it as an upload instead of reading as text');
  } else throw new Error(`Unsupported text format ${extension}; upload this file instead`);
  return { path: full, size: stat.size, content: content.slice(0, Math.min(maxChars, 50000)), truncated: content.length > maxChars };
}

export async function writeFile(file, content) {
  const full = absolute(file);
  if (typeof content !== 'string' || content.length > 100000) throw new Error('Write content must be text under 100,000 characters');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, { mode: 0o600 });
  return { written: full, characters: content.length };
}

export async function createPdf(file, content, title = 'Application Document', author = '') {
  const full = absolute(file);
  if (!full.toLowerCase().endsWith('.pdf')) throw new Error('PDF output path must end in .pdf');
  if (typeof content !== 'string' || !content.trim() || content.length > 100000) throw new Error('PDF content must be non-empty text under 100,000 characters');
  const script = path.resolve(process.cwd(), 'scripts/create_pdf.py');
  const payload = JSON.stringify({ file: full, content, title, author });
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || `PDF generation failed with exit code ${code}`)));
    child.stdin.end(payload);
  });
  return { ...JSON.parse(stdout.trim()), path: full };
}

export async function searchFileContents(directory, query) {
  const root = absolute(directory || os.homedir());
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw new Error('Search text must be 2 to 200 characters');
  const args = ['-n', '-i', '-F', '--max-count', '2', '--max-columns', '250', '--max-filesize', '2M', '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!*.lock', '--', query, root];
  try {
    const result = await execFileAsync('rg', args, { timeout: 10000, maxBuffer: 1_000_000 });
    const lines = result.stdout.split('\n').filter(Boolean);
    return { root, query, matches: lines.slice(0, 40), truncated: lines.length > 40 };
  } catch (error) {
    if (error.code === 1) return { root, query, matches: [], truncated: false };
    if (error.killed || error.signal) throw new Error('File search timed out');
    throw new Error(`File search failed: ${error.message}`);
  }
}

export async function fileMetadata(file) {
  const full = absolute(file);
  const stat = await fs.stat(full);
  return { path: full, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', bytes: stat.size, modifiedAt: stat.mtime.toISOString(), extension: path.extname(full).toLowerCase() };
}
