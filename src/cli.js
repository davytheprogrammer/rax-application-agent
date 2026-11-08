#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { config, requireModelConfig } from './config.js';
import { ask, closeTerminal } from './io.js';
import { createApplication, ensureState, listApplications, loadApplication, paths, saveApplication } from './state.js';
import { runAgent } from './agent.js';

function help() {
  console.log(`Kito — local application agent

Usage:
  kito start <url>       Start a job, grant, or other application
  kito resume <id>       Resume an application
  kito list              List application records
  kito profile           Open your verified applicant knowledge in $EDITOR
  kito config            Show configuration paths and status

Set MODEL_API_KEY and MUSE_MODEL in .env first. Chrome opens visibly.`);
}

async function editProfile() {
  await ensureState();
  const editor = process.env.EDITOR || 'nano';
  const child = spawn(editor, [paths().profilePath], { stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Editor exited ${code}`))); child.on('error', reject); });
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!command || ['-h', '--help', 'help'].includes(command)) return help();
  if (command === 'config') {
    await ensureState();
    console.log(JSON.stringify({ dataDir: config.dataDir, profile: paths().profilePath, browserProfile: paths().browserDir, baseUrl: config.baseUrl, model: config.model || '(unset)', apiKey: config.apiKey ? '(set)' : '(unset)' }, null, 2));
    return;
  }
  if (command === 'profile') return editProfile();
  if (command === 'list') {
    const records = await listApplications();
    for (const item of records) console.log(`${item.id}\t${item.status}\t${item.url}\t${item.updatedAt}`);
    if (!records.length) console.log('No applications yet.');
    return;
  }
  if (command === 'start') {
    if (!argument) throw new Error('Provide an application URL');
    const url = new URL(argument);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
    requireModelConfig();
    const goal = await ask('What are you applying for, and what should Kito know?\n> ');
    const record = await createApplication(url.toString(), goal || 'Complete this application accurately.');
    console.log(`Application ID: ${record.id}`);
    try { await runAgent(record, goal); }
    catch (error) { record.status = 'paused'; await saveApplication(record); throw error; }
    return;
  }
  if (command === 'resume') {
    if (!argument) throw new Error('Provide an application ID from kito list');
    requireModelConfig();
    const record = await loadApplication(argument);
    if (record.model && record.model !== config.model) throw new Error(`This application used ${record.model}. Set MUSE_MODEL to that model before resuming.`);
    const message = await ask(`Resume ${record.id}. Any new instructions?\n> `);
    if (!record.pendingOutputs?.length) {
      record.status = 'active';
      await saveApplication(record);
    }
    try { await runAgent(record, message || 'Continue the application from the current browser and saved context.'); }
    catch (error) { record.status = 'paused'; await saveApplication(record); throw error; }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { console.error(`Kito error: ${error.message}`); process.exitCode = 1; }).finally(() => closeTerminal());
