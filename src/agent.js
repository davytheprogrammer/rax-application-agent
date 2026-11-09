import { BrowserController } from './browser.js';
import { listFiles, readFile, writeFile, searchFileContents } from './files.js';
import { ask, pickFile } from './io.js';
import { createResponse } from './muse.js';
import { instructions } from './prompt.js';
import { config } from './config.js';
import { journal, readProfile, saveApplication, listApplications, loadApplication, paths } from './state.js';
import fs from 'node:fs/promises';
import { AnswerCurator } from './curator.js';

const target = { type: 'object', properties: { index: { type: 'integer' }, css: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' }, placeholder: { type: 'string' }, text: { type: 'string' } } };
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, strict: false });
const tools = [
  tool('browser_snapshot', 'Read current page URL, text, and visible interactive controls.'),
  tool('inspect_form', 'Audit visible form fields, required status, validation messages, select choices, and character limits.'),
  tool('browser_tabs', 'List open Chrome tabs.'),
  tool('browser_history', 'Go back or forward in the current Chrome tab.', { direction: { type: 'string', enum: ['back', 'forward'] } }, ['direction']),
  tool('browser_switch_tab', 'Switch to an open Chrome tab by index.', { index: { type: 'integer' } }, ['index']),
  tool('browser_goto', 'Navigate the visible Chrome tab to an HTTP(S) URL.', { url: { type: 'string' } }, ['url']),
  tool('browser_click', 'Click a visible control. Final submit controls save a local form snapshot.', { target }, ['target']),
  tool('browser_hover', 'Move the pointer over a visible target to reveal menus or tooltips.', { target }, ['target']),
  tool('browser_download', 'Click a download link and save the downloaded file under this application record.', { target }, ['target']),
  tool('browser_fill', 'Fill a text input or textarea.', { target, value: { type: 'string' } }, ['target', 'value']),
  tool('browser_fill_fields', 'Fill up to 20 inspected text fields on the current page in order. Only high-risk answers need independent review. Use stable labels or selectors when available.', { fields: { type: 'array', items: { type: 'object', properties: { target, value: { type: 'string' } }, required: ['target', 'value'], additionalProperties: false } } }, ['fields']),
  tool('browser_select', 'Select a native dropdown value or label.', { target, value: { type: 'string' } }, ['target', 'value']),
  tool('browser_check', 'Check or uncheck a checkbox.', { target, checked: { type: 'boolean' } }, ['target', 'checked']),
  tool('browser_upload', 'Upload one local file through a file input.', { target, file: { type: 'string' } }, ['target', 'file']),
  tool('computer_wait', 'Wait for a page, animation, or upload to settle. Maximum 10 seconds.', { milliseconds: { type: 'number' } }, ['milliseconds']),
  tool('find_files', 'Find file names recursively in a directory, up to depth 4. Search by name only.', { directory: { type: 'string' }, query: { type: 'string' } }),
  tool('search_file_contents', 'Search text inside local files in a chosen directory using a literal, case-insensitive phrase. Returns at most 40 matching lines.', { directory: { type: 'string' }, query: { type: 'string' } }, ['directory', 'query']),
  tool('read_local_file', 'Read a local text or PDF file. Use only when relevant to the application.', { file: { type: 'string' } }, ['file']),
  tool('attach_local_file', 'Attach a known relevant local file path to this application record before browser_upload.', { file: { type: 'string' } }, ['file']),
  tool('pick_file', 'Ask the user to choose a file in Rax when its path cannot be found or the choice is ambiguous.', { purpose: { type: 'string' } }, ['purpose']),
  tool('write_local_file', 'Create or overwrite an application-related local text file.', { file: { type: 'string' }, content: { type: 'string' } }, ['file', 'content']),
  tool('application_history', 'List prior application IDs, goals, statuses, and confirmations.'),
  tool('read_application', 'Read one prior application record to reuse accurate answers.', { id: { type: 'string' } }, ['id']),
  tool('save_profile_note', 'Append one source-verified applicant fact to persistent knowledge.', { note: { type: 'string' } }, ['note']),
  tool('save_application_note', 'Save a short decision, fact, question, or next step to this application record for later sessions.', { note: { type: 'string' } }, ['note']),
  tool('ask_user', 'Ask only for a mandatory fact or user-only decision that cannot be resolved from saved knowledge, documents, prior applications, or the current page.', { question: { type: 'string' } }, ['question']),
  tool('handoff_to_user', 'Pause while the user handles login, CAPTCHA, passkey, payment, or an inaccessible browser control.', { message: { type: 'string' } }, ['message']),
  tool('record_confirmation', 'Record observed proof of submission. Only call after observing confirmation in Chrome.', { confirmation: { type: 'string' } }, ['confirmation']),
];
const pageChangeTools = new Set(['browser_switch_tab', 'browser_goto', 'browser_history', 'browser_click', 'browser_hover', 'browser_download', 'browser_fill', 'browser_fill_fields', 'browser_select', 'browser_check', 'browser_upload', 'computer_wait', 'handoff_to_user']);

function outputText(response) {
  if (response.output_text) return response.output_text;
  return response.output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
}
function truncate(value) {
  const serialized = JSON.stringify(value);
  return serialized.length <= config.toolOutputLimit ? serialized : serialized.slice(0, config.toolOutputLimit) + '...[truncated]';
}

async function pageMessage(browser, note = 'Current Chrome page') {
  const [page, form] = await Promise.all([browser.snapshot(), browser.formInventory().catch(() => null)]);
  return { role: 'user', content: `${note}. Inspect this page and act on incomplete required fields directly. ${JSON.stringify({ url: page.url, title: page.title, text: page.text.slice(0, 6000), controls: page.controls.slice(0, 120), form })}` };
}

function defaultEmit(event) {
  if (event.type === 'message') console.log(`\nRax: ${event.text}\n`);
  else if (event.type === 'tool') console.log(`→ ${event.name}`);
  else if (event.type === 'tool_error') console.error(`  ${event.text}`);
  else if (event.type === 'status' && event.text.startsWith('Stopped')) console.log(event.text);
}

function recoveryInput(record, profile, userMessage) {
  return { role: 'user', content: `Recover this interrupted application from local state. Do not assume a pending click or upload succeeded. Inspect the current page before repeating an action.\nGoal: ${record.goal}\nOriginal URL: ${record.url}\nLast URL: ${record.currentUrl}\nCurrent user request: ${userMessage}\nApplicant knowledge: ${profile.slice(0, 25000)}\nSelected files: ${JSON.stringify(record.sourceFiles || [])}\nChat answers: ${JSON.stringify((record.chat || []).slice(-30)).slice(0, 15000)}\nNotes: ${JSON.stringify((record.notes || []).slice(-30))}\nLast saved form draft: ${JSON.stringify(record.draftSnapshot || {}).slice(0, 30000)}\nRecent actions: ${JSON.stringify((record.events || []).slice(-40)).slice(0, 15000)}\nPrior confirmation: ${JSON.stringify(record.confirmation || null)}` };
}

export async function runAgent(record, userMessage, { emit = defaultEmit, signal, takeMessages = () => [], waitIfPaused = async () => false, keepBrowserOpen = true } = {}) {
  const browser = new BrowserController(record, { onWait: text => emit({ type: 'status', text }) });
  let errorCaptured = false;
  const captureError = async () => {
    if (errorCaptured) return;
    errorCaptured = true;
    try {
      const shot = await browser.screenshot();
      emit({ type: 'screenshot', path: shot.file, url: shot.url });
    } catch { /* A screenshot failure must not hide the original error. */ }
  };
  const onAbort = () => { void browser.detach().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
    await browser.open();
    if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
    const initialInventory = await browser.formInventory().catch(() => null);
    if (initialInventory?.requiredRemaining === 0) {
      const initialSnapshot = await browser.snapshot().catch(() => null);
      const submit = initialSnapshot?.controls?.find(control => /\b(submit application|submit|apply now|send application)\b/i.test(control.text || ''));
      if (submit) {
        emit({ type: 'status', text: 'Saved form is complete. Submitting it now.' });
        await browser.click({ index: submit.i });
      } else {
        try {
          emit({ type: 'status', text: 'Saved form is complete. Submitting it now.' });
          await browser.click({ role: 'button', name: 'Submit application' });
        } catch { /* Let Muse inspect an unusual submit control. */ }
      }
    }
    const profile = await readProfile();
    const curator = new AnswerCurator(record, profile, emit);
    const history = (await listApplications()).filter(item => item.id !== record.id).slice(0, 15).map(item => ({ id: item.id, goal: item.goal, status: item.status, url: item.url }));
    const pendingCalls = record.pendingCalls || [];
    const savedOutputs = record.pendingOutputs || [];
    const initialInput = pendingCalls.length
      ? pendingCalls.map(call => savedOutputs.find(item => item.call_id === call.call_id) || { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ error: 'The previous run stopped during this tool call. Its side effect is unknown. Inspect the browser or file before deciding what to do; do not blindly repeat a submit or write.' }) })
      : [{ role: 'user', content: `Application goal: ${record.goal}\nStarting URL: ${record.url}\nApplicant knowledge (user-maintained, may be incomplete):\n${profile.slice(0, 25000)}\nSelected source files: ${JSON.stringify(record.sourceFiles || [])}\nSaved chat answers: ${JSON.stringify((record.chat || []).slice(-30)).slice(0, 15000)}\nSaved application notes: ${JSON.stringify((record.notes || []).slice(-30))}\nRecent application records (use application_history or read_application for detail):\n${JSON.stringify(history)}\nCurrent user request: ${userMessage}\nCurrent browser URL: ${browser.current().url()}` }];
    let nextInput = [...initialInput, await pageMessage(browser, pendingCalls.length ? `Resumed run. Current user request: ${userMessage}` : 'Initial page observation')];
    let previousResponseId = record.responseId;
    for (let step = 0; step < config.maxSteps; step++) {
      if (signal?.aborted) throw new Error('Stopped by user');
      if (await waitIfPaused()) nextInput.push(await pageMessage(browser, 'User handed Chrome back; inspect the current page before acting'));
      const incoming = takeMessages();
      for (const message of incoming) nextInput.push({ role: 'user', content: `User clarification for this application: ${message}` });
      emit({ type: 'status', text: `Thinking · step ${step + 1}` });
      let response;
      try { response = await createResponse({ input: nextInput, previousResponseId, instructions, tools, signal, onWait: text => emit({ type: 'status', text }) }); }
      catch (error) {
        const lostContext = previousResponseId && [400, 404].includes(error.status) && /previous_response_id|response.*(not found|expired|unknown|invalid)/i.test(error.message);
        if (!lostContext) throw error;
        emit({ type: 'status', text: 'Muse context expired; rebuilding from local application state.' });
        journal(record, 'recovery', 'Muse server context unavailable; rebuilt from local state');
        previousResponseId = null;
        record.responseId = null;
        record.pendingCalls = [];
        record.pendingOutputs = [];
        await saveApplication(record);
        nextInput = [recoveryInput(record, profile, userMessage), await pageMessage(browser, 'Recovery page observation')];
        response = await createResponse({ input: nextInput, instructions, tools, signal, onWait: text => emit({ type: 'status', text }) });
      }
      previousResponseId = response.id;
      record.responseId = response.id;
      record.pendingOutputs = [];
      const calls = response.output.filter(item => item.type === 'function_call');
      record.pendingCalls = calls.map(call => ({ name: call.name, call_id: call.call_id }));
      const message = outputText(response);
      if (message) { emit({ type: 'message', text: message }); record.summary = message; journal(record, 'message', message.slice(0, 2000)); }
      await saveApplication(record);
      const takeoverAfterResponse = await waitIfPaused();
      if (takeoverAfterResponse && calls.length) {
        nextInput = calls.map(call => ({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ skipped: true, reason: 'The user took over Chrome after this action was planned. Inspect the current page before acting.' }) }));
        record.pendingOutputs = [...nextInput];
        await saveApplication(record);
        nextInput.push(await pageMessage(browser, 'User handed Chrome back; previous planned actions were skipped'));
        continue;
      }
      if (!calls.length) {
        const lateMessages = takeMessages();
        if (lateMessages.length || takeoverAfterResponse) {
          nextInput = lateMessages.map(item => ({ role: 'user', content: `User clarification for this application: ${item}` }));
          if (takeoverAfterResponse) nextInput.push(await pageMessage(browser, 'User handed Chrome back; inspect the page before finishing'));
          continue;
        }
        record.status = record.confirmation ? 'submitted' : 'paused';
        await saveApplication(record);
        emit({ type: 'complete', status: record.status, id: record.id });
        return;
      }
      nextInput = [];
      let interruptedByTakeover = false;
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex];
        if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
        if (await waitIfPaused()) {
          for (const skipped of calls.slice(callIndex)) nextInput.push({ type: 'function_call_output', call_id: skipped.call_id, output: JSON.stringify({ skipped: true, reason: 'User took over Chrome; inspect the changed page before acting.' }) });
          record.pendingOutputs = [...nextInput];
          await saveApplication(record);
          interruptedByTakeover = true;
          break;
        }
        let result;
        let beforeUrl = record.currentUrl;
        try { beforeUrl = browser.current().url(); } catch {}
        try {
          const args = JSON.parse(call.arguments || '{}');
          emit({ type: 'tool', name: call.name, detail: safeArgs(call.name, args) });
          result = await executeTool(call.name, args, browser, record, curator, signal);
          if (['browser_fill', 'browser_fill_fields', 'browser_select', 'browser_check'].includes(call.name)) {
            const inventory = await browser.formInventory().catch(() => null);
            if (inventory?.requiredRemaining === 0) {
              const snapshot = await browser.snapshot().catch(() => null);
              const submit = snapshot?.controls?.find(control => /\b(submit application|submit|apply now|send application)\b/i.test(control.text || ''));
              if (submit) {
                emit({ type: 'status', text: 'Required fields are complete. Submitting the application now.' });
                const submitted = await browser.click({ index: submit.i });
                result = { ...result, autoSubmitted: true, submit: submitted };
              } else {
                try {
                  emit({ type: 'status', text: 'Required fields are complete. Submitting the application now.' });
                  const submitted = await browser.click({ role: 'button', name: 'Submit application' });
                  result = { ...result, autoSubmitted: true, submit: submitted };
                } catch { /* Let Muse inspect an unusual submit control. */ }
              }
            }
          }
          journal(record, 'tool', { name: call.name, args: safeArgs(call.name, args), result: summarizeResult(result) });
          const needsFact = Array.isArray(result?.needsFact) ? result.needsFact.map(item => item.reason || item.needsFact || '').filter(Boolean).join('; ') : result?.needsFact;
          const issue = String(result?.issue || result?.error || needsFact || '').trim();
          if (issue) {
            journal(record, 'issue', { name: call.name, error: issue.slice(0, 2000) });
            emit({ type: 'issue', name: call.name, text: issue.slice(0, 2000) });
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          result = { error: error.message || String(error) };
          journal(record, 'tool_error', { name: call.name, error: result.error });
          emit({ type: 'tool_error', name: call.name, text: result.error });
          await captureError();
        }
        nextInput.push({ type: 'function_call_output', call_id: call.call_id, output: truncate(result) });
        try { record.currentUrl = browser.current().url(); } catch {}
        if (record.currentUrl !== beforeUrl && callIndex + 1 < calls.length) {
          for (const skipped of calls.slice(callIndex + 1)) nextInput.push({ type: 'function_call_output', call_id: skipped.call_id, output: JSON.stringify({ skipped: true, reason: 'The page changed; inspect the new page before acting.' }) });
          record.pendingOutputs = [...nextInput];
          await saveApplication(record);
          break;
        }
        if (['browser_fill', 'browser_fill_fields', 'browser_select', 'browser_check', 'browser_upload', 'browser_click', 'keyboard_press', 'keyboard_type'].includes(call.name)) {
          try { record.draftSnapshot = await browser.reviewState(); } catch {}
        }
        emit({ type: 'url', url: record.currentUrl });
        record.pendingOutputs = [...nextInput];
        await saveApplication(record);
      }
      record.pendingOutputs = [...nextInput];
      await saveApplication(record);
      if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
      if (interruptedByTakeover || calls.some(call => pageChangeTools.has(call.name))) nextInput.push(await pageMessage(browser, interruptedByTakeover ? 'User handed Chrome back; inspect changes before continuing' : 'Page observation after the last action'));
    }
    record.status = 'paused';
    const notice = `Stopped after ${config.maxSteps} model steps. Resume application ${record.id}.`;
    journal(record, 'issue', notice);
    record.summary = notice;
    emit({ type: 'issue', text: notice });
    await saveApplication(record);
  } catch (error) {
    if (!signal?.aborted) await captureError();
    throw error;
  } finally {
    // Chrome belongs to the user. A finished, stopped, or failed run only disconnects Rax.
    signal?.removeEventListener('abort', onAbort);
    if (keepBrowserOpen) await browser.detach().catch(() => {});
    else await browser.close().catch(() => {});
  }
}

function safeArgs(name, args) {
  if (name === 'browser_fill') return { target: args.target, value: '[redacted]' };
  if (name === 'browser_fill_fields') return { fields: (args.fields || []).map(item => ({ target: item.target, value: '[redacted]' })) };
  if (name === 'keyboard_type') return { text: '[redacted]' };
  if (name === 'curate_answer') return { question: args.question, draft: '[redacted]' };
  if (name === 'measure_answer') return { text: '[redacted]', maxWords: args.maxWords, maxCharacters: args.maxCharacters };
  if (name === 'run_command') return { command: '[omitted from journal]', directory: args.directory };
  if (name === 'write_local_file') return { file: args.file, content: '[redacted]' };
  if (name === 'save_profile_note') return { note: '[redacted]' };
  if (name === 'read_local_file') return { file: args.file };
  return args;
}
function summarizeResult(result) {
  if (result?.fieldsFilled !== undefined) return { fieldsFilled: result.fieldsFilled, needsFact: result.needsFact, stoppedAt: result.stoppedAt, issue: result.issue };
  if (result?.answer !== undefined) return { answer: '[redacted from journal]' };
  if (result?.fields) return { url: result.url, fields: result.fields.length, requiredRemaining: result.requiredRemaining };
  if (result?.matches) return { root: result.root, matches: result.matches.length, truncated: result.truncated };
  if (result?.decision && result?.text !== undefined) return { decision: result.decision, note: result.note, text: '[redacted from journal]' };
  if (result?.draft || result?.proposed) return { filled: result.filled, typed: result.typed, needsFact: result.needsFact, issue: result.issue, answer: '[redacted from journal]' };
  if (result?.content) return { path: result.path, size: result.size, truncated: result.truncated };
  if (result?.text) return { url: result.url, title: result.title, controls: result.controls?.length };
  if (result?.preSubmitSnapshot) return { id: result.id, status: result.status, summary: '[available to model]' };
  if (Array.isArray(result)) return { items: result.length };
  if (result?.exitCode !== undefined) return { cwd: result.cwd, exitCode: result.exitCode, timedOut: result.timedOut, stdoutCharacters: result.stdout?.length, stderrCharacters: result.stderr?.length };
  return result;
}

async function prepareField(browser, curator, target, value, signal, pageText) {
  if (typeof value !== 'string') throw new Error('Field value must be text');
  const field = await browser.describeTarget(target);
  if (field.type === 'password') throw new Error('Passwords and login fields belong to the user. Use handoff_to_user.');
  const context = value.trim().length >= 70 ? pageText ?? await browser.pageText() : '';
  const review = await curator.review({ draft: value, field, pageText: context, signal });
  return { target, field, review };
}

async function applyField(browser, prepared) {
  const { target, field, review } = prepared;
  if (review.decision === 'needs_fact') return { filled: false, needsFact: review.note };
  if (field.maxLength && review.text.length > field.maxLength) return { filled: false, issue: `Curated answer exceeds ${field.maxLength} characters` };
  await browser.fill(target, review.text);
  return { filled: true, curation: review.decision, note: review.note, characters: review.text.length };
}

async function fillField(browser, curator, target, value, signal) {
  return applyField(browser, await prepareField(browser, curator, target, value, signal));
}

async function executeTool(name, args, browser, record, curator, signal) {
  switch (name) {
    case 'browser_snapshot': return browser.snapshot();
    case 'inspect_form': return browser.formInventory();
    case 'browser_tabs': return browser.tabs();
    case 'browser_history': return args.direction === 'back' ? browser.back() : args.direction === 'forward' ? browser.forward() : { error: 'direction must be back or forward' };
    case 'browser_switch_tab': return browser.switchTab(args.index);
    case 'browser_goto': return browser.goto(args.url);
    case 'browser_click': return browser.click(args.target);
    case 'browser_hover': return browser.hover(args.target);
    case 'browser_download': return browser.download(args.target);
    case 'browser_fill': return fillField(browser, curator, args.target, args.value, signal);
    case 'browser_fill_fields': {
      if (!Array.isArray(args.fields) || args.fields.length < 1 || args.fields.length > 20) throw new Error('Provide 1 to 20 fields');
      const startedUrl = browser.current().url();
      const pageText = args.fields.some(item => String(item.value || '').trim().length >= 70) ? await browser.pageText() : '';
      const prepared = [];
      for (let index = 0; index < args.fields.length; index += 3) {
        if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
        const chunk = args.fields.slice(index, index + 3);
        prepared.push(...await Promise.all(chunk.map(async item => {
          try { return { value: await prepareField(browser, curator, item.target, item.value, signal, pageText) }; }
          catch (error) { return { error }; }
        })));
      }
      const results = [];
      for (let index = 0; index < args.fields.length; index++) {
        if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
        if (browser.current().url() !== startedUrl) return { fieldsFilled: results.filter(item => item.filled).length, results, stoppedAt: index, issue: 'Page changed during batch; inspect the new page before continuing.' };
        const item = args.fields[index];
        try {
          if (prepared[index].error) throw prepared[index].error;
          results.push({ index, target: item.target, ...await applyField(browser, prepared[index].value) });
        }
        catch (error) {
          if (signal?.aborted) throw error;
          return { fieldsFilled: results.filter(item => item.filled).length, results, stoppedAt: index, issue: error.message || String(error) };
        }
      }
      return { fieldsFilled: results.filter(item => item.filled).length, needsFact: results.filter(item => item.needsFact).map(item => ({ index: item.index, reason: item.needsFact })), results };
    }
    case 'browser_select': return browser.select(args.target, args.value);
    case 'browser_check': return browser.check(args.target, args.checked);
    case 'browser_upload': return browser.upload(args.target, args.file);
    case 'computer_wait': return browser.wait(args.milliseconds);
    case 'keyboard_press': return browser.pressKey(args.key);
    case 'keyboard_type': {
      const field = await browser.describeFocusedField();
      if (field.type === 'password') throw new Error('Passwords and login fields belong to the user. Use handoff_to_user.');
      const review = await curator.review({ draft: args.text, field, pageText: await browser.pageText(), signal });
      if (review.decision === 'needs_fact') return { typed: false, needsFact: review.note, draft: args.text };
      if (field.maxLength && review.text.length > field.maxLength) return { typed: false, issue: `Curated answer exceeds ${field.maxLength} characters`, proposed: review.text };
      return browser.typeText(review.text);
    }
    case 'find_files': {
      record.toolCounts ||= {};
      record.toolCounts.findFiles = (record.toolCounts.findFiles || 0) + 1;
      if (record.toolCounts.findFiles > 6) return { matches: [], issue: 'File search budget reached for this run; use the documents already read.' };
      return listFiles(args.directory, args.query);
    }
    case 'search_file_contents': {
      record.toolCounts ||= {};
      record.toolCounts.searchContents = (record.toolCounts.searchContents || 0) + 1;
      if (record.toolCounts.searchContents > 8) return { root: args.directory, query: args.query, matches: [], issue: 'Content search budget reached for this run; use the documents already read.' };
      return searchFileContents(args.directory, args.query);
    }
    case 'read_local_file': return readFile(args.file);
    case 'pick_file': {
      const chosen = await pickFile(args.purpose);
      if (!chosen) return { cancelled: true };
      const file = (await fs.realpath(chosen));
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Selected path is not a regular file');
      record.sourceFiles ||= [];
      if (!record.sourceFiles.includes(file)) record.sourceFiles.push(file);
      await saveApplication(record);
      return { path: file, size: stat.size, purpose: args.purpose };
    }
    case 'attach_local_file': {
      const file = await fs.realpath(String(args.file || ''));
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Only regular files can be attached');
      record.sourceFiles ||= [];
      if (!record.sourceFiles.includes(file)) record.sourceFiles.push(file);
      await saveApplication(record);
      return { attached: file, size: stat.size };
    }
    case 'curate_answer': return curator.review({ draft: args.draft, field: { label: args.question, question: args.question }, pageText: await browser.pageText(), signal });
    case 'write_local_file': return writeFile(args.file, args.content);
    case 'application_history': return (await listApplications()).map(item => ({ id: item.id, goal: item.goal, status: item.status, url: item.url, confirmation: item.confirmation }));
    case 'read_application': {
      const item = await loadApplication(args.id);
      return { id: item.id, goal: item.goal, url: item.url, status: item.status, summary: item.summary, confirmation: item.confirmation, userAnswers: (item.chat || []).filter(entry => entry.role === 'user').slice(-20).map(entry => entry.text), notes: (item.notes || []).slice(-20), sourceFiles: item.sourceFiles || [], preSubmitSnapshot: item.preSubmitSnapshot };
    }
    case 'save_profile_note': {
      const note = String(args.note || '').trim();
      if (!note || note.length > 2000) throw new Error('Verified profile note must be 1 to 2,000 characters');
      await fs.appendFile(paths().profilePath, `\n- ${note.replace(/\n/g, ' ')}\n`, { mode: 0o600 });
      return { saved: true };
    }
    case 'save_application_note': {
      const note = String(args.note || '').trim();
      if (!note || note.length > 2000) throw new Error('Application note must be 1 to 2,000 characters');
      record.notes ||= [];
      record.notes.push({ at: new Date().toISOString(), text: note });
      await saveApplication(record);
      return { saved: true, notes: record.notes.length };
    }
    case 'ask_user': {
      const question = String(args.question || '').trim();
      if (!question) throw new Error('Question cannot be empty');
      record.chat ||= [];
      record.chat.push({ role: 'assistant', text: question, at: new Date().toISOString() });
      await saveApplication(record);
      const answer = await ask(`\nRax asks: ${question}\n> `);
      record.chat.push({ role: 'user', text: answer, at: new Date().toISOString() });
      await saveApplication(record);
      return { answer };
    }
    case 'handoff_to_user': return browser.handoff(args.message);
    case 'record_confirmation': {
      const page = await browser.snapshot();
      const proof = String(args.confirmation || '').trim();
      const visible = proof.length >= 4 && await browser.current().evaluate(phrase => document.body?.innerText?.toLowerCase().includes(phrase.toLowerCase()), proof);
      if (!visible) throw new Error('Confirmation text must appear on the current page. Quote an exact visible phrase or identifier.');
      if (!record.preSubmitSnapshot || !record.approvedSubmitAt) throw new Error('No submission attempt was recorded for this application.');
      if (record.preSubmitSnapshot.text?.toLowerCase().includes(proof.toLowerCase())) throw new Error('This confirmation text was already present before submission; choose new evidence from the result page.');
      record.confirmation = { text: proof, url: page.url, at: new Date().toISOString() };
      await saveApplication(record);
      return record.confirmation;
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
