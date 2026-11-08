import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kito-integration-'));
process.env.KITO_DATA_DIR = path.join(temporary, 'data');
process.env.MODEL_API_KEY = 'local-test-key';
process.env.MUSE_MODEL = 'local-test-model';

let responses = 0;
let screenshots = 0;
let curationCalls = 0;
const sourceFile = path.join(temporary, 'venture.md');
await fs.writeFile(sourceFile, 'Our venture builds accessible tools for founders. The founder profile is verified.\n');
const extraFile = path.join(temporary, 'pitch-notes.md');
await fs.writeFile(extraFile, 'Verified pitch notes for the controlled application.\n');
const longDraft = 'Our venture builds accessible tools for founders. We help them complete applications and keep the information accurate.';
const sequence = [
  { name: 'inspect_form', args: {} },
  { name: 'search_file_contents', args: { directory: temporary, query: 'accessible tools' } },
  { name: 'measure_answer', args: { text: 'A short accurate answer', maxWords: 5, maxCharacters: 40 } },
  { name: 'save_application_note', args: { note: 'Use the verified venture description.' } },
  { name: 'browser_snapshot', args: {} },
  { name: 'pick_file', args: { purpose: 'Choose a venture description' } },
  { name: 'attach_local_file', args: { file: extraFile } },
  { name: 'browser_fill_fields', args: { fields: [
    { target: { label: 'Project description' }, value: longDraft },
    { target: { label: 'Project name' }, value: 'Test Venture' },
  ] } },
  { name: 'browser_click', args: { target: { role: 'button', name: 'Submit' } } },
  { name: 'record_confirmation', args: { confirmation: 'Application received' } },
];

const server = http.createServer(async (request, response) => {
  if (request.url === '/application') {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Test application</title><a href="/download">Guidelines</a><form action="/done" method="get"><label>Project name <input name="project" required></label><label>Project description <textarea name="description"></textarea></label><button type="submit">Submit</button></form>');
    return;
  }
  if (request.url === '/download') {
    response.setHeader('content-type', 'text/plain');
    response.setHeader('content-disposition', 'attachment; filename="guidelines.txt"');
    response.end('Local test guidelines');
    return;
  }
  if (request.url?.startsWith('/done')) {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Submitted</title><h1>Application received</h1>');
    return;
  }
  if (request.url === '/v1/responses') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'local-test-model');
    assert.equal(body.instructions.length > 100, true);
    const hasImage = body.input.some(item => item.role === 'user' && item.content?.some?.(part => part.type === 'input_image'));
    const previousStep = sequence[responses - 1];
    const expectImage = responses === 0 || ['browser_fill_fields', 'browser_click'].includes(previousStep?.name);
    assert.equal(hasImage, expectImage);
    if (hasImage) screenshots++;
    if (responses > 0) assert.equal(body.previous_response_id, `resp_${responses}`);
    responses++;
    const step = sequence[responses - 1];
    const output = step ? [{ type: 'function_call', name: step.name, call_id: `call_${responses}`, arguments: JSON.stringify(step.args), status: 'completed' }] : [{ type: 'message', content: [{ type: 'output_text', text: 'Application submitted and confirmed.' }] }];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `resp_${responses}`, output }));
    return;
  }
  if (request.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.response_format.type, 'json_schema');
    curationCalls++;
    response.setHeader('content-type', 'application/json');
    const text = JSON.stringify(body).includes('unsupported claim') ? 'Our venture has 99% success.' : 'Our venture builds accessible tools for founders and helps them complete applications with accurate information.';
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decision: 'revise', text, note: 'Clearer and grounded in the selected source.' }) } }] }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.MUSE_BASE_URL = `${origin}/v1`;

try {
  const { setAskHandler, setFilePicker } = await import('../src/io.js');
  setAskHandler(async () => 'yes');
  setFilePicker(async () => sourceFile);
  const { createApplication } = await import('../src/state.js');
  const { runAgent } = await import('../src/agent.js');
  const { runCommand } = await import('../src/commands.js');
  const record = await createApplication(`${origin}/application`, 'Submit the controlled test application');
  const events = [];
  await runAgent(record, record.goal, { emit: item => events.push(item), keepBrowserOpen: false });
  assert.equal(record.status, 'submitted');
  assert.equal(record.confirmation.text, 'Application received');
  assert.equal(record.preSubmitSnapshot.fields.some(item => item.value === 'Test Venture'), true);
  assert.equal(record.preSubmitSnapshot.fields.some(item => item.value.includes('accurate information')), true);
  assert.equal(responses, 11);
  assert.equal(screenshots, 3);
  assert.equal(events.some(item => item.type === 'screenshot'), true);
  assert.equal(events.some(item => item.type === 'curation' && item.stage === 'revise'), true);
  assert.equal(record.sourceFiles.includes(sourceFile), true);
  assert.equal(record.sourceFiles.includes(extraFile), true);
  assert.equal(record.notes[0].text, 'Use the verified venture description.');
  assert.equal(record.events.filter(item => item.type === 'tool_error').length, 0);
  assert.equal(record.events.find(item => item.detail?.name === 'inspect_form')?.detail?.result?.requiredRemaining, 1);
  assert.equal(record.events.find(item => item.detail?.name === 'search_file_contents')?.detail?.result?.matches > 0, true);
  assert.equal(record.events.find(item => item.detail?.name === 'measure_answer')?.detail?.result?.withinWordLimit, true);
  assert.equal(curationCalls, 1);
  const { AnswerCurator } = await import('../src/curator.js');
  const curator = new AnswerCurator(record, 'Our venture builds accessible tools for founders.');
  const draft = longDraft;
  const review = await curator.review({ draft, field: { label: 'What does your venture do?', question: 'Describe the venture' }, pageText: 'Describe the venture in one paragraph.' });
  assert.equal(review.decision, 'revise');
  assert.equal(review.text.includes('accurate information'), true);
  const cached = await curator.review({ draft, field: { label: 'What does your venture do?', question: 'Describe the venture' }, pageText: 'Describe the venture in one paragraph.' });
  assert.equal(cached.cached, true);
  assert.equal(curationCalls, 2);
  const unsupported = await curator.review({ draft: 'This unsupported claim about performance is important but has no verified source in the profile or selected document.', field: { label: 'Impact', question: 'Describe measurable impact' }, pageText: 'Impact' });
  assert.equal(unsupported.decision, 'needs_fact');
  assert.equal(curationCalls, 3);
  const sensitive = await curator.review({ draft: 'a'.repeat(100), field: { label: 'Password', type: 'password' }, pageText: 'Sign in' });
  assert.equal(sensitive.decision, 'use');
  assert.equal(curationCalls, 3);
  const { BrowserController } = await import('../src/browser.js');
  const pointerRecord = await createApplication(`${origin}/application`, 'Exercise pixel computer controls');
  const pointer = new BrowserController(pointerRecord);
  await pointer.open();
  try {
    const inventory = await pointer.formInventory();
    const indexedName = inventory.fields.find(item => item.label === 'Project name');
    assert.equal(Number.isInteger(indexedName.index), true);
    await pointer.fill({ index: indexedName.index }, 'Index target works');
    assert.equal(await pointer.current().getByRole('textbox', { name: 'Project name' }).inputValue(), 'Index target works');
    await pointer.current().getByRole('textbox', { name: 'Project name' }).fill('');
    const box = await pointer.current().getByRole('textbox', { name: 'Project name' }).boundingBox();
    const moved = await pointer.moveCursor(box.x + box.width / 2, box.y + box.height / 2);
    if (process.env.XDG_SESSION_TYPE === 'x11') assert.equal(moved.physicalCursorMoved, true);
    await pointer.hover({ role: 'link', name: 'Guidelines' });
    const downloaded = await pointer.download({ role: 'link', name: 'Guidelines' });
    assert.equal(await fs.readFile(downloaded.file, 'utf8'), 'Local test guidelines');
    assert.equal(pointerRecord.downloads.includes(downloaded.file), true);
    const drag = await pointer.drag(30, 30, 70, 70);
    assert.equal(drag.dragged.toX, 70);
    await pointer.clickAt(box.x + box.width / 2, box.y + box.height / 2);
    await pointer.typeText('Cursor flow');
    await pointer.pressKey('Tab');
    await pointer.scrollAt(50, 50, 100);
    const filled = await pointer.snapshot();
    assert.equal(filled.controls.some(item => item.value === 'Cursor flow'), true);
    const submit = await pointer.current().getByRole('button', { name: 'Submit' }).boundingBox();
    await pointer.clickAt(submit.x + submit.width / 2, submit.y + submit.height / 2);
    await pointer.current().waitForURL(/\/done/, { timeout: 10000 });
    assert.equal((await pointer.snapshot()).text.includes('Application received'), true);
    await pointer.back();
    assert.equal(pointer.current().url().includes('/application'), true);
    await pointer.forward();
    assert.equal(pointer.current().url().includes('/done'), true);
  } finally {
    await pointer.close();
  }
  const command = await runCommand('printf controlled-command', temporary);
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, 'controlled-command');
  setAskHandler(async () => 'no');
  const createdFile = path.join(temporary, 'autonomous-command');
  const created = await runCommand(`touch ${createdFile}`, temporary);
  assert.equal(created.exitCode, 0);
  assert.equal((await fs.stat(createdFile)).isFile(), true);
  console.log('Local integration passed: form audit, file search, downloads, history, pixel controls, file picker, answer curation, saved notes, submission evidence, and autonomous command.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
