#!/usr/bin/env node
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config, requireModelConfig } from './config.js';
import { setAskHandler, setFilePicker } from './io.js';
import { createApplication, ensureState, journal, listApplications, loadApplication, paths, readHomeChat, readProfile, saveApplication, saveHomeChat } from './state.js';
import { runAgent } from './agent.js';
import { interpretHomeRequest } from './home-assistant.js';
import { browseDirectory } from './files.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let active = null;
let closing = false;
let pendingQuestion = null;
let nextQuestionId = 1;
let homeBusy = false;
let homeController = null;

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function event(data) { send({ kind: 'event', ...data }); }
function summaries(records) {
  return records.map(item => ({ id: item.id, url: item.url, currentUrl: item.currentUrl, goal: item.goal, status: item.status, updatedAt: item.updatedAt, summary: item.summary, confirmation: item.confirmation }));
}

setAskHandler(question => new Promise((resolve, reject) => {
  if (pendingQuestion) return reject(new Error('Another user question is already open'));
  const id = nextQuestionId++;
  const purpose = question.includes('Type yes to continue') ? 'approval' : question.startsWith('Chrome needs you:') ? 'handoff' : question.startsWith('\nRax asks:') ? 'clarification' : 'question';
  pendingQuestion = { id, resolve, purpose, question };
  send({ kind: 'request_input', id, question, purpose });
}));
setFilePicker(purpose => new Promise((resolve, reject) => {
  if (pendingQuestion) return reject(new Error('Another user prompt is already open'));
  const id = nextQuestionId++;
  pendingQuestion = { id, resolve, purpose: 'file', question: purpose };
  event({ type: 'waiting', id, purpose: 'file', text: `Choose a file: ${purpose}` });
  send({ kind: 'request_file', id, purpose });
}));

async function run(record, message) {
  const controller = new AbortController();
  const runState = { id: record.id, controller, record, messages: [], paused: false, takeoverEpoch: 0, seenEpoch: 0, resumeWaiters: [] };
  active = runState;
  try {
    record.status = 'active';
    record.controlMode = 'agent';
    record.runCount = (record.runCount || 0) + 1;
    await saveApplication(record);
    event({ type: 'started', id: record.id, url: record.currentUrl || record.url });
    await runAgent(record, message, {
      signal: controller.signal,
      takeMessages: () => runState.messages.splice(0),
      waitIfPaused: async () => {
        if (runState.paused) await new Promise(resolve => runState.resumeWaiters.push(resolve));
        if (controller.signal.aborted) throw new DOMException('Stopped by user', 'AbortError');
        const changed = runState.takeoverEpoch !== runState.seenEpoch;
        runState.seenEpoch = runState.takeoverEpoch;
        return changed;
      },
      emit: data => event({ ...data, id: record.id }),
    });
  } catch (error) {
    record.status = 'paused';
    const detail = error.message || String(error);
    if (!controller.signal.aborted) {
      journal(record, 'error', detail);
      record.summary = `Rax stopped: ${detail}`;
    }
    event({ type: controller.signal.aborted ? 'stopped' : 'error', id: record.id, text: detail });
    try { await saveApplication(record); }
    catch (saveError) { event({ type: 'error', id: record.id, text: `Could not save the application after the failure: ${saveError.message || saveError}` }); }
  } finally {
    if (pendingQuestion) {
      const id = pendingQuestion.id;
      pendingQuestion.resolve('');
      pendingQuestion = null;
      event({ type: 'input_resolved', id });
    }
    runState.resumeWaiters.splice(0).forEach(resolve => resolve());
    active = null;
    event({ type: 'record_updated', id: record.id });
    if (closing) process.exit(0);
  }
}

async function handle(command) {
  const { action, requestId } = command;
  try {
    let data;
    if (action === 'state') {
      await ensureState();
      data = { applications: summaries(await listApplications()), homeChat: await readHomeChat(), profile: await readProfile(), model: config.model, curatorModel: config.curatorModel, keySet: Boolean(config.apiKey), dataDir: config.dataDir, documentsDir: paths().documentsDir, activeId: active?.id || null, pausedByUser: active?.paused || false, stopping: Boolean(active?.controller.signal.aborted), pendingPrompt: pendingQuestion && { id: pendingQuestion.id, purpose: pendingQuestion.purpose, question: pendingQuestion.question } };
    } else if (action === 'home_request') {
      if (active) throw new Error('An application is running. Use its conversation to guide Rax.');
      if (homeBusy) throw new Error('Rax is still answering your previous request.');
      requireModelConfig();
      const message = String(command.message || '').trim();
      if (!message || message.length > 5000) throw new Error('Message must be 1 to 5,000 characters');
      homeBusy = true;
      homeController = new AbortController();
      try {
        const history = await readHomeChat();
        const userEntry = { role: 'user', text: message, at: new Date().toISOString() };
        await saveHomeChat([...history, userEntry]);
        const decision = await interpretHomeRequest({ message, history, profile: await readProfile(), applications: summaries(await listApplications()), signal: homeController.signal, onWait: text => event({ type: 'home_wait', text }) });
        if (homeController.signal.aborted) throw new Error('Request cancelled');
        let action = decision.action;
        let id = null;
        if (action === 'start') {
          if (active) throw new Error('Another application started while Rax was planning.');
          const source = decision.url || `https://www.bing.com/search?q=${encodeURIComponent(decision.searchQuery || '')}`;
          const url = new URL(source);
          if (!['http:', 'https:'].includes(url.protocol) || !decision.url && !decision.searchQuery) throw new Error('Rax needs a direct link or a search query before starting.');
          const goal = String(decision.goal || message).slice(0, 5000);
          const record = await createApplication(url.toString(), goal);
          id = record.id;
          run(record, goal);
        }
        const reply = String(decision.reply || (action === 'start' ? 'I am opening Chrome and starting this application.' : 'Tell me which application or program you mean.'));
        const homeChat = await saveHomeChat([...history, userEntry, { role: 'assistant', text: reply, at: new Date().toISOString() }]);
        data = { action, reply, id, homeChat };
      } finally { homeBusy = false; homeController = null; }
    } else if (action === 'cancel_home_request') {
      if (!homeController) throw new Error('No home request is running');
      homeController.abort();
      data = { cancelled: true };
    } else if (action === 'start') {
      if (active) throw new Error('An application is already running');
      requireModelConfig();
      const url = new URL(command.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) application URLs are allowed');
      const record = await createApplication(url.toString(), String(command.goal || 'Complete this application accurately.'));
      data = { id: record.id };
      run(record, command.goal || 'Complete this application accurately.');
    } else if (action === 'resume') {
      if (active) throw new Error('An application is already running');
      requireModelConfig();
      const record = await loadApplication(command.id);
      if (record.model && record.model !== config.model) throw new Error(`This application used ${record.model}; select that model to resume it.`);
      // An explicit Resume is a fresh planning turn. Replaying a stale pending
      // model call is what caused old checkbox and scroll actions to loop.
      record.responseId = null;
      record.pendingCalls = [];
      record.pendingOutputs = [];
      data = { id: record.id };
      run(record, String(command.message || 'Continue the application from its saved context.'));
    } else if (action === 'stop') {
      if (!active) throw new Error('No application is running');
      const stoppingId = active.id;
      active.controller.abort();
      active.resumeWaiters.splice(0).forEach(resolve => resolve());
      if (pendingQuestion) { const id = pendingQuestion.id; pendingQuestion.resolve(''); pendingQuestion = null; event({ type: 'input_resolved', id }); }
      event({ type: 'stopping', id: stoppingId, text: 'Stopping Rax. Chrome stays open.' });
      data = { stopping: stoppingId };
    } else if (action === 'takeover') {
      if (!active) throw new Error('No application is running');
      if (!active.paused) {
        active.paused = true;
        active.takeoverEpoch++;
        active.record.controlMode = 'human';
        await saveApplication(active.record);
        event({ type: 'takeover', id: active.id, text: 'You control Chrome. Rax will wait at the next safe point.' });
      }
      data = { paused: true, id: active.id };
    } else if (action === 'handback') {
      if (!active || !active.paused) throw new Error('Rax is not in takeover mode');
      const note = String(command.message || '').trim().slice(0, 2000);
      active.record.controlMode = 'agent';
      active.paused = false;
      active.messages.push(note || 'I finished using Chrome. Inspect the current page and continue.');
      await saveApplication(active.record);
      active.resumeWaiters.splice(0).forEach(resolve => resolve());
      event({ type: 'handback', id: active.id, text: 'Rax is inspecting Chrome and continuing.' });
      data = { resumed: true, id: active.id };
    } else if (action === 'answer') {
      if (!pendingQuestion || pendingQuestion.id !== command.id) throw new Error('No matching question');
      const id = pendingQuestion.id;
      pendingQuestion.resolve(String(command.answer ?? ''));
      pendingQuestion = null;
      event({ type: 'input_resolved', id });
      data = { accepted: true };
    } else if (action === 'chat') {
      const text = String(command.text || '').trim();
      if (!text || text.length > 5000) throw new Error('Chat message must be 1 to 5,000 characters');
      const record = active?.id === command.id ? active.record : await loadApplication(command.id);
      if (active && active.id !== record.id) throw new Error('Finish the running application before chatting in another one');
      if (['clarification', 'question'].includes(pendingQuestion?.purpose) && active?.id === record.id) {
        const id = pendingQuestion.id;
        pendingQuestion.resolve(text);
        pendingQuestion = null;
        event({ type: 'input_resolved', id });
        data = { delivered: true, id: record.id };
      } else if (active?.id === record.id) {
        throw new Error('Rax is working. Stop the run before sending another message.');
      } else {
        requireModelConfig();
        if (record.model && record.model !== config.model) throw new Error(`This application used ${record.model}; select that model to continue it.`);
        record.chat ||= [];
        record.chat.push({ role: 'user', text, at: new Date().toISOString() });
        await saveApplication(record);
        run(record, text);
        data = { resumed: true, id: record.id };
      }
    } else if (action === 'save_profile') {
      await ensureState();
      if (typeof command.profile !== 'string' || command.profile.length > 100000) throw new Error('Profile must be text under 100,000 characters');
      await fs.writeFile(paths().profilePath, command.profile, { mode: 0o600 });
      data = { saved: true };
    } else if (action === 'save_settings') {
      const model = String(command.model || '').trim();
      const curatorModel = String(command.curatorModel || '').trim();
      const key = String(command.apiKey || '').trim();
      if ([model, curatorModel, key].some(value => /[\r\n]/.test(value))) throw new Error('Settings cannot contain newlines');
      if (model) config.model = model;
      config.curatorModel = curatorModel;
      if (key) config.apiKey = key;
      let existing = '';
      try { existing = await fs.readFile(envPath, 'utf8'); } catch {}
      const retained = existing.split(/\r?\n/).filter(line => !/^\s*(MODEL_API_KEY|MUSE_MODEL|MUSE_CURATOR_MODEL)\s*=/.test(line) && line.trim() !== '');
      const quoted = value => JSON.stringify(value);
      const content = [...retained, `MODEL_API_KEY=${quoted(config.apiKey)}`, `MUSE_MODEL=${quoted(config.model)}`, `MUSE_CURATOR_MODEL=${quoted(config.curatorModel)}`, ''].join('\n');
      await fs.writeFile(envPath, content, { mode: 0o600 });
      data = { saved: true, model: config.model, curatorModel: config.curatorModel, keySet: Boolean(config.apiKey) };
    } else if (action === 'list_local_files') {
      data = await browseDirectory(command.directory, command.query);
    } else if (action === 'attach_file') {
      const file = await fs.realpath(String(command.file || ''));
      if (!(await fs.stat(file)).isFile()) throw new Error('Selected path is not a file');
      const record = active?.id === command.id ? active.record : await loadApplication(command.id);
      record.sourceFiles ||= [];
      if (!record.sourceFiles.includes(file)) record.sourceFiles.push(file);
      await saveApplication(record);
      data = { attached: file, id: record.id, sourceFiles: record.sourceFiles };
    } else if (action === 'application') {
      const record = await loadApplication(command.id);
      data = { id: record.id, url: record.url, currentUrl: record.currentUrl, goal: record.goal, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, controlMode: record.controlMode || 'agent', summary: record.summary, confirmation: record.confirmation, sourceFiles: record.sourceFiles || [], downloads: record.downloads || [], notes: record.notes || [], chat: record.chat || [], events: record.events.slice(-100), preSubmitSnapshot: record.preSubmitSnapshot || null };
    } else throw new Error(`Unknown action: ${action}`);
    send({ kind: 'reply', requestId, ok: true, data });
  } catch (error) {
    send({ kind: 'reply', requestId, ok: false, error: error.message || String(error) });
  }
}

lines.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { send({ kind: 'event', type: 'error', text: 'Invalid desktop command JSON' }); return; }
  void handle(command);
});
lines.on('close', () => {
  closing = true;
  if (pendingQuestion) { pendingQuestion.resolve(''); pendingQuestion = null; }
  if (active) { active.controller.abort(); active.resumeWaiters.splice(0).forEach(resolve => resolve()); }
  else process.exit(0);
});
