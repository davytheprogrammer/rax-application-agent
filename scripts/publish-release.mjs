import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});

const version = process.env.RELEASE_VERSION || (await import('../package.json', { with: { type: 'json' } })).default.version;
const tag = `v${version}`;
await run('npx', ['electron-builder', '--linux', 'AppImage', 'deb', '--win', 'nsis', 'portable']);
const artifacts = (await readdir('dist')).filter(name => !name.endsWith('.yml') && !name.endsWith('.blockmap')).map(name => `dist/${name}`);
if (!artifacts.length) throw new Error('No release artifacts found in dist/');
await run('gh', ['release', 'create', tag, ...artifacts, '--repo', 'davytheprogrammer/rax-application-agent', '--title', `Rax ${version}`, '--generate-notes']);
