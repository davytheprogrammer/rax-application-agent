import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browseDirectory } from '../src/files.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-files-'));
try {
  await fs.mkdir(path.join(temporary, 'Folder'));
  await fs.writeFile(path.join(temporary, 'resume.pdf'), 'controlled file');
  await fs.writeFile(path.join(temporary, '.private'), 'hidden');
  const listing = await browseDirectory(temporary);
  assert.equal(listing.directory, temporary);
  assert.deepEqual(listing.items.map(item => [item.name, item.type]), [['Folder', 'directory'], ['resume.pdf', 'file']]);
  assert.equal(listing.items[1].bytes, 15);
  await assert.rejects(browseDirectory(path.join(temporary, 'resume.pdf')), /Choose a folder/);
  await Promise.all(Array.from({ length: 505 }, (_, index) => fs.writeFile(path.join(temporary, `other-${index}.txt`), 'x')));
  assert.equal((await browseDirectory(temporary)).truncated, true);
  const filtered = await browseDirectory(temporary, 'resume');
  assert.deepEqual(filtered.items.map(item => item.name), ['resume.pdf']);
  assert.equal(filtered.truncated, false);
  console.log('File browser passed: folders and files are listed with usable metadata.');
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
