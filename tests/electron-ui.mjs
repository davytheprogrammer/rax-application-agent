import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const pageUrl = pathToFileURL(path.resolve('desktop/electron/index.html')).href;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  await context.addInitScript(() => {
    const listeners = [];
    window.__calls = [];
    window.__activeId = null;
    window.__emit = message => listeners.forEach(listener => listener(message));
    window.rax = {
      command: async (action, values) => {
        window.__calls.push({ action, values });
        if (action === 'state') return { applications: window.__activeId ? [{ id: window.__activeId, goal: 'Controlled application', url: 'https://example.org/apply', status: 'active' }, { id: 'older-app', goal: 'Older application', url: 'https://example.org/older', status: 'paused' }] : [], profile: '# Founder profile', model: 'local-test-model', curatorModel: '', keySet: true, dataDir: '/tmp/rax-test', documentsDir: '/docs', activeId: window.__activeId, pausedByUser: false };
        if (action === 'list_local_files') {
          const directory = values.directory || '/docs';
          return { directory, parent: '/home', locations: { rax: '/docs', downloads: '/downloads', home: '/home' }, items: directory === '/downloads' ? [{ name: 'resume.pdf', path: '/downloads/resume.pdf', type: 'file', bytes: 32768 }, { name: 'Projects', path: '/downloads/Projects', type: 'directory', bytes: null }] : [], truncated: false };
        }
        if (action === 'start') { window.__activeId = 'test-app'; return { id: 'test-app' }; }
        if (action === 'home_request') {
          const user = { role: 'user', text: values.message };
          if (/fail/i.test(values.message)) throw new Error('Controlled network failure');
          if (/apply/i.test(values.message)) {
            window.__activeId = 'chat-app';
            return { action: 'start', id: 'chat-app', reply: 'I am opening the application.', homeChat: [user, { role: 'assistant', text: 'I am opening the application.' }] };
          }
          return { action: 'respond', reply: 'Tell me what you want to work on.', homeChat: [user, { role: 'assistant', text: 'Tell me what you want to work on.' }] };
        }
        if (action === 'application') return { id: 'test-app', url: 'https://example.org/apply', goal: 'Controlled application', status: 'active', chat: [], events: [] };
        return { accepted: true };
      },
      pickFile: async () => '', openDocuments: async () => '', readImage: async () => '',
      showMain: async () => {}, showCompanion: async () => {}, quit: async () => {},
      onMessage: callback => { listeners.push(callback); return () => {}; },
    };
  });
  const main = await context.newPage();
  await main.goto(`${pageUrl}?mode=main`);
  await main.locator('#quick-start').waitFor();
  assert.equal(await main.locator('#main-app').isVisible(), true);
  assert.equal(await main.locator('#welcome-view').isVisible(), true);
  await main.locator('#quick-start').click();
  assert.equal(await main.locator('#start-overlay').isVisible(), true);
  await main.locator('#start-url').fill('https://example.org/');
  await main.locator('#start-btn').click();
  assert.equal(await main.evaluate(() => window.__calls.some(item => item.action === 'start')), false);
  await main.locator('#start-url').fill('https://example.org/apply');
  await main.locator('#start-btn').click();
  await main.waitForFunction(() => window.__calls.some(item => item.action === 'start'));
  assert.equal(await main.locator('#work-view').isVisible(), true);
  await main.locator('.task-card').waitFor();
  await main.locator('.rail-app').filter({ hasText: 'Older application' }).click();
  assert.equal(await main.locator('#work-title').textContent(), 'Controlled application');
  assert.equal(await main.locator('#chat-input').isDisabled(), true);
  assert.equal(await main.locator('#run-banner-title').textContent(), 'Rax is working');
  await main.locator('#attach-btn').click();
  await main.locator('#file-browser-list').getByText('resume.pdf').waitFor();
  assert.equal(await main.locator('#file-path').inputValue(), '/downloads');
  await main.locator('#file-browser-list').getByText('resume.pdf').click();
  assert.equal(await main.locator('#file-select').isEnabled(), true);
  await main.locator('#file-select').click();
  await main.waitForFunction(() => window.__calls.some(item => item.action === 'attach_file' && item.values.file === '/downloads/resume.pdf'));
  assert.equal(await main.locator('#file-overlay').isHidden(), true);
  await main.evaluate(() => window.__emit({ kind: 'request_file', id: 12, purpose: 'Choose a source document' }));
  await main.locator('#file-overlay').waitFor({ state: 'visible' });
  await main.locator('#file-cancel').click();
  await main.waitForFunction(() => window.__calls.some(item => item.action === 'answer' && item.values.id === 12 && item.values.answer === ''));
  await main.evaluate(() => sendChat('Do something else'));
  assert.equal(await main.evaluate(() => window.__calls.some(item => item.action === 'chat')), false);
  await main.evaluate(() => window.__emit({ kind: 'event', type: 'message', id: 'test-app', text: 'I am checking the application requirements.' }));
  assert.equal(await main.locator('#chat-history').getByText('I am checking the application requirements.').isVisible(), true);
  await main.evaluate(() => window.__emit({ kind: 'event', type: 'tool', id: 'test-app', name: 'inspect_form' }));
  assert.equal(await main.locator('.task-card').getByText('Inspect application fields').isVisible(), true);
  await main.evaluate(() => window.__emit({ kind: 'event', type: 'tool_error', id: 'test-app', name: 'browser_click', text: 'Control did not respond' }));
  assert.equal(await main.locator('#issue-banner').isVisible(), true);
  assert.match(await main.locator('#issue-text').textContent(), /Control did not respond/);
  assert.equal(await main.locator('#chat-history').getByText(/Rax hit a page issue/).isVisible(), true);
  await main.locator('#issue-dismiss').click();
  assert.equal(await main.locator('#issue-banner').isHidden(), true);
  await main.evaluate(() => window.__emit({ kind: 'event', type: 'error', id: 'test-app', text: 'Muse is unavailable' }));
  assert.equal(await main.locator('#issue-banner').isVisible(), true);
  assert.match(await main.locator('#issue-text').textContent(), /Muse is unavailable/);
  await main.locator('#suggest-control').click();
  await main.waitForFunction(() => window.__calls.some(item => item.action === 'takeover'));
  await main.evaluate(() => window.__emit({ kind: 'request_input', id: 7, purpose: 'approval', question: 'Review application before submit. Type yes to continue:' }));
  assert.equal(await main.locator('#approval-overlay').isVisible(), true);
  assert.equal(await main.locator('#run-banner-title').textContent(), 'Approval needed');
  await main.evaluate(() => sendChat('Unrelated guidance'));
  assert.equal(await main.locator('#approval-overlay').isVisible(), true);
  assert.equal(await main.evaluate(() => window.__calls.some(item => item.action === 'answer' && item.values.id === 7)), false);
  await main.locator('#approve-btn').click();
  await main.waitForFunction(() => window.__calls.some(item => item.action === 'answer' && item.values.id === 7 && item.values.answer === 'yes'));
  await main.evaluate(() => window.__emit({ kind: 'event', type: 'backend_closed', text: 'Local agent stopped.' }));
  assert.equal(await main.locator('#connection-status').textContent().then(value => value.includes('Offline')), true);
  assert.equal(await main.locator('#send-btn').isDisabled(), true);
  const companion = await context.newPage();
  await companion.goto(`${pageUrl}?mode=companion`);
  assert.equal(await companion.locator('#companion-app').isVisible(), true);
  assert.equal(await companion.locator('#main-app').isVisible(), false);
  assert.equal(await companion.getByText('Take over', { exact: true }).count(), 1);
  await companion.evaluate(() => { window.__activeId = 'test-app'; window.__emit({ kind: 'event', type: 'started', id: 'test-app', url: 'https://example.org/apply' }); });
  await companion.evaluate(() => window.__emit({ kind: 'request_input', id: 8, purpose: 'handoff', question: 'Chrome needs you: Sign in. Use the visible browser, then press Enter when ready: ' }));
  assert.equal(await companion.locator('#companion-done').isVisible(), true);
  assert.equal(await companion.locator('#companion-input').isDisabled(), true);
  assert.equal(await companion.locator('#companion-status').textContent(), 'Waiting for sign-in');
  await companion.locator('#companion-done').click();
  await companion.waitForFunction(() => window.__calls.some(item => item.action === 'answer' && item.values.id === 8));
  await companion.evaluate(() => window.__emit({ kind: 'request_input', id: 9, purpose: 'clarification', question: '\nRax asks: What is the project name?\n> ' }));
  assert.equal(await companion.locator('#companion-input').isEnabled(), true);
  assert.equal(await companion.locator('#companion-status').textContent(), 'Waiting for your answer');
  await companion.locator('#companion-input').fill('Verified Project');
  await companion.locator('#companion-chat-form button').click();
  await companion.waitForFunction(() => window.__calls.some(item => item.action === 'chat' && item.values.text === 'Verified Project'));
  await companion.evaluate(() => window.__emit({ kind: 'event', type: 'input_resolved', id: 9 }));
  assert.equal(await companion.locator('#companion-input').isDisabled(), true);
  assert.equal(await companion.locator('#companion-status').textContent(), 'Rax is working');
  const natural = await context.newPage();
  await natural.goto(`${pageUrl}?mode=main`);
  await natural.locator('#home-input').fill('Hi Rax');
  await natural.locator('#home-send').click();
  await natural.locator('#home-chat-history').getByText('Tell me what you want to work on.').waitFor();
  assert.equal(await natural.locator('#welcome-view').isVisible(), true);
  await natural.locator('#home-input').fill('fail this request');
  await natural.locator('#home-send').click();
  await natural.locator('#home-chat-history').getByText(/Controlled network failure/).waitFor();
  assert.equal(await natural.locator('#home-input').inputValue(), 'fail this request');
  await natural.locator('#home-input').fill('Help me apply to the test program');
  await natural.locator('#home-send').click();
  await natural.locator('#work-view').waitFor();
  assert.equal(await natural.evaluate(() => window.__calls.filter(item => item.action === 'home_request').length), 3);
  console.log('Electron renderer passed: workspace, start, approval, compact login handoff, and chat.');
} finally { await browser.close(); }
