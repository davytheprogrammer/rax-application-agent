import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, saveApplication } from './state.js';
import { ask } from './io.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const execFileAsync = promisify(execFile);

function safeUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  return url.toString();
}

async function connectToVisibleChrome(directory) {
  const portFile = path.join(directory, 'DevToolsActivePort');
  const connect = async () => {
    const port = Number((await fs.readFile(portFile, 'utf8')).split('\n')[0]);
    if (!Number.isInteger(port) || port < 1) throw new Error('Chrome debugging port is invalid');
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
  };
  try { return await connect(); } catch { /* Chrome is closed or still starting. */ }
  const chrome = process.env.RAX_CHROME_PATH || '/usr/bin/google-chrome';
  const child = spawn(chrome, [
    `--user-data-dir=${directory}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--start-maximized', 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  let lastError;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { return await connect(); } catch (error) { lastError = error; }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Could not connect to visible Chrome. Close an old Rax Chrome profile if it is locked, then retry. ${lastError?.message || ''}`);
}

export class BrowserController {
  constructor(record, { onWait = () => {} } = {}) { this.record = record; this.browser = null; this.context = null; this.page = null; this.onWait = onWait; this.selectionLockUntil = 0; this.lastScroll = null; }
  async open() {
    this.browser = await connectToVisibleChrome(paths().browserDir);
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error('Chrome did not expose its default browser context');
    this.context.setDefaultTimeout(30000);
    // Leave normal page traffic in Chrome. Intercepting every resource here made
    // large application forms wait on a Node round trip for each request.
    await this.context.route(/^https:\/\/docs\.google\.com\/offline\/extension\/report(?:[?#]|$)/i, route => route.abort('blockedbyclient'));
    const existingPages = this.context.pages().filter(page => !page.isClosed());
    const newApplication = (this.record.runCount || 1) === 1 && !this.record.responseId && !(this.record.events || []).length && !(this.record.pendingCalls || []).length;
    if (newApplication && existingPages.some(page => page.url() !== 'about:blank')) {
      this.page = await this.context.newPage();
    } else if (existingPages.length) {
      const scored = await Promise.all(existingPages.map(async page => {
        try {
          const score = await page.evaluate(() => ({
            url: location.href,
            filled: [...document.querySelectorAll('input,textarea,select')].filter(el => String(el.value || '').trim()).length,
            focused: document.hasFocus() ? 1 : 0,
          }));
          return { page, score };
        } catch { return { page, score: { url: page.url(), filled: -1, focused: 0 } }; }
      }));
      this.page = scored.sort((a, b) => b.score.filled - a.score.filled || b.score.focused - a.score.focused)[0]?.page || existingPages.at(-1);
    } else {
      this.page = await this.context.newPage();
    }
    if (newApplication) { await this.page.bringToFront(); this.selectionLockUntil = Date.now() + 10000; }
    for (const page of this.context.pages()) this.trackPage(page, false);
    this.context.on('page', page => this.trackPage(page));
    if (this.page.url() === 'about:blank') await this.goto(this.record.currentUrl || this.record.url);
  }
  current() {
    if (!this.page || this.page.isClosed()) this.page = this.context?.pages().find(page => !page.isClosed()) || null;
    if (!this.page) throw new Error('All Chrome tabs were closed');
    return this.page;
  }
  trackPage(page, select = true) {
    if (select) this.page = page;
    page.on('close', () => {
      if (this.page === page) this.page = this.context.pages().find(candidate => !candidate.isClosed()) || null;
    });
  }
  async syncFocusedPage() {
    if (Date.now() < this.selectionLockUntil && this.page && !this.page.isClosed()) return this.page;
    if (this.page && !this.page.isClosed()) {
      try { if (await this.page.evaluate(() => document.hasFocus())) return this.page; } catch {}
    }
    const pages = this.context.pages().filter(page => !page.isClosed());
    for (const page of pages) {
      try { if (await page.evaluate(() => document.hasFocus())) { this.page = page; return page; } } catch {}
    }
    if (!this.page || this.page.isClosed()) this.page = pages.at(-1) || null;
    return this.current();
  }
  tabs() { return this.context.pages().map((page, index) => ({ index, url: page.url() })); }
  async switchTab(index) {
    const page = this.context.pages()[index];
    if (!page) throw new Error(`No Chrome tab at index ${index}`);
    this.page = page;
    await page.bringToFront();
    return this.snapshot();
  }
  async awaitPage(operation, label) {
    let settled = false;
    const pending = operation().finally(() => { settled = true; });
    while (!settled) {
      let timer;
      await Promise.race([pending.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 8000); })]);
      clearTimeout(timer);
      if (!settled) this.onWait(`${label} is still loading. I will check again in a few seconds.`);
    }
    return pending;
  }
  async goto(url) {
    const destination = safeUrl(url);
    if (this.current().url() === destination) return { unchanged: true, url: destination, note: 'This URL is already open; the current form was preserved.' };
    try { await this.awaitPage(() => this.current().goto(safeUrl(url), { waitUntil: 'commit', timeout: 120000 }), 'Chrome page'); }
    catch (error) {
      if (error.name !== 'TimeoutError' || this.current().url() === 'about:blank') throw error;
      this.onWait('The page is still loading slowly. I will inspect what Chrome has received so far.');
      await this.current().waitForTimeout(5000);
    }
    await this.current().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => this.onWait('The page has opened but is still rendering. I will inspect it now.'));
    return this.snapshot();
  }
  async back() { await this.awaitPage(() => this.current().goBack({ waitUntil: 'commit', timeout: 120000 }), 'Previous page'); return this.snapshot(); }
  async forward() { await this.awaitPage(() => this.current().goForward({ waitUntil: 'commit', timeout: 120000 }), 'Next page'); return this.snapshot(); }
  async snapshot() {
    const page = await this.syncFocusedPage();
    const data = await page.evaluate(() => {
      const isVisible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const inViewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; const submitControl = el.matches('button,input[type="submit"],input[type="button"]'); return r.width > 0 && r.height > 0 && (inViewport || submitControl) && s.visibility !== 'hidden' && s.display !== 'none'; };
      const label = el => el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || '';
      document.querySelectorAll('[data-rax-index]').forEach(el => el.removeAttribute('data-rax-index'));
      const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]')].filter(isVisible).slice(0, 250).map((el, i) => { el.setAttribute('data-rax-index', String(i)); const type = el.getAttribute('type'); const role = el.getAttribute('role'); return { i, tag: el.tagName.toLowerCase(), type, role, text: String(label(el)).trim().slice(0, 140), name: el.getAttribute('name'), id: el.id, value: ['password', 'hidden'].includes(type) ? '[hidden]' : String(el.value ?? '').slice(0, 120), checked: ['checkbox', 'radio'].includes(type) ? Boolean(el.checked) : ['checkbox', 'radio', 'switch'].includes(role) ? el.getAttribute('aria-checked') === 'true' : undefined, href: el.tagName === 'A' ? el.href : undefined, required: el.required || undefined }; });
      const root = document.scrollingElement || document.documentElement;
      return { title: document.title, text: document.body?.innerText?.slice(0, 14000) || '', controls, scroll: { top: root.scrollTop, height: root.scrollHeight, viewport: root.clientHeight, atBottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 4 } };
    });
    return { url: page.url(), ...data };
  }
  async resolve(target) {
    const page = this.current();
    if (Number.isInteger(target.index)) return page.locator(`[data-rax-index="${target.index}"]`).first();
    if (target.css) return page.locator(target.css).first();
    if (target.role && target.name) return page.getByRole(target.role, { name: target.name, exact: true }).first();
    if (target.label) return page.getByLabel(target.label, { exact: true }).first();
    if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact: true }).first();
    if (target.text) return page.getByText(target.text, { exact: true }).first();
    throw new Error('Specify index from a recent snapshot, css, role + name, label, placeholder, or text');
  }
  async click(target) {
    const locator = await this.resolve(target);
    const details = await locator.evaluate(el => ({ text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 180), type: el.getAttribute('type'), tag: el.tagName.toLowerCase(), formSubmit: el.tagName === 'BUTTON' && el.closest('form') && (!el.getAttribute('type') || el.getAttribute('type') === 'submit') }));
    if (['submit', 'image'].includes(details.type) || details.formSubmit || /\b(submit|send|complete|finalize|finish|confirm|apply|register)\b/i.test(details.text)) {
      if (!await this.approveSubmission(details.text || details.type || 'button')) return { cancelled: true, reason: 'User declined submission' };
    }
    await this.awaitPage(() => locator.click({ timeout: 60000 }), 'Chrome control');
    return { clicked: details, url: this.current().url() };
  }
  async fill(target, value) { await this.awaitPage(() => this.resolve(target).then(locator => locator.fill(String(value), { timeout: 60000 })), 'Form field'); return { filled: true }; }
  async formInventory() {
    // Snapshot assigns the same DOM indices that resolve({ index }) uses.
    // Form-only numbering would point at missing or unrelated controls.
    await this.snapshot();
    const page = this.current();
    const inventory = await page.evaluate(() => {
      const visible = el => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
      const all = [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].filter(visible).slice(0, 200).map(el => ({
        index: el.hasAttribute('data-rax-index') ? Number(el.getAttribute('data-rax-index')) : null,
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.tagName.toLowerCase(),
        label: (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 180),
        name: el.getAttribute('name') || '', required: Boolean(el.required),
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        value: el.type === 'password' ? '[hidden]' : ['checkbox', 'radio'].includes(el.type) ? String(el.checked) : String(el.value || '').slice(0, 160),
        valid: el.validity?.valid ?? null, validationMessage: el.validationMessage?.slice(0, 150) || '',
        options: el.tagName === 'SELECT' ? [...el.options].slice(0, 40).map(option => ({ value: option.value, label: option.textContent.trim().slice(0, 100) })) : undefined,
      }));
      const incomplete = all.filter(field => field.required && !field.valid);
      return { fields: incomplete.slice(0, 80), totalFields: all.length, requiredRemaining: all.filter(field => field.required && !field.valid).length };
    });
    return { url: page.url(), ...inventory };
  }
  async describeTarget(target) {
    return (await this.resolve(target)).evaluate(el => ({
      label: el.labels?.[0]?.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      question: el.closest('fieldset')?.innerText?.slice(0, 600) || el.parentElement?.parentElement?.innerText?.slice(0, 600) || '',
      maxLength: el.maxLength > 0 ? el.maxLength : null,
    }));
  }
  async describeFocusedField() {
    return this.current().evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { label: '', name: '', type: '', question: '', maxLength: null };
      return {
        label: el.labels?.[0]?.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        question: el.closest('fieldset')?.innerText?.slice(0, 600) || el.parentElement?.parentElement?.innerText?.slice(0, 600) || '',
        maxLength: el.maxLength > 0 ? el.maxLength : null,
      };
    });
  }
  async pageText(limit = 5000) { return this.current().evaluate(max => document.body?.innerText?.slice(0, max) || '', limit); }
  async select(target, value) {
    const locator = await this.resolve(target);
    const current = await locator.inputValue().catch(() => '');
    if (current === String(value)) return { selected: value, changed: false, alreadySelected: true };
    await this.awaitPage(() => locator.selectOption(String(value), { timeout: 60000 }), 'Dropdown');
    return { selected: value, changed: true };
  }
  async check(target, checked) {
    const locator = await this.resolve(target);
    const current = await locator.isChecked().catch(() => null);
    if (current === Boolean(checked)) return { checked: Boolean(checked), changed: false, alreadySet: true };
    await this.awaitPage(() => locator.setChecked(Boolean(checked), { timeout: 60000 }), 'Checkbox');
    return { checked: Boolean(checked), changed: true };
  }
  async upload(target, file) {
    const absolute = await fs.realpath(path.resolve(file));
    const allowed = await Promise.all((this.record.sourceFiles || []).map(item => fs.realpath(item).catch(() => null)));
    if (!allowed.includes(absolute)) throw new Error('File is not attached to this application. Use pick_file or Add source file first.');
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Upload path is not a regular file');
    await (await this.resolve(target)).setInputFiles(absolute);
    return { uploaded: absolute, bytes: stat.size };
  }
  async reviewState() {
    const page = await this.syncFocusedPage();
    return page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 12000) || '',
      fields: [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 180).map(el => ({
        label: (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 180),
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        value: el.type === 'password' ? '[hidden]' : el.type === 'file' ? [...(el.files || [])].map(file => file.name).join(', ') : el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value ?? el.innerText ?? '').slice(0, 5000),
        required: Boolean(el.required), valid: el.validity?.valid ?? null,
      })),
    }));
  }
  async approveSubmission(label) {
    const review = await this.reviewState();
    review.action = label;
    this.record.preSubmitSnapshot = review;
    this.record.approvedSubmitAt = new Date().toISOString();
    await saveApplication(this.record);
    return true;
  }
  async hover(target) {
    const locator = await this.resolve(target);
    const box = await locator.boundingBox();
    if (!box) throw new Error('Target is not visible');
    await this.moveCursor(box.x + box.width / 2, box.y + box.height / 2);
    return { hovered: target, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  async download(target) {
    const page = this.current();
    const locator = await this.resolve(target);
    const kind = await locator.evaluate(el => ({ type: el.getAttribute('type'), text: (el.innerText || el.value || '').trim().slice(0, 100) }));
    if (kind.type === 'submit' || /\b(submit|send application|apply now)\b/i.test(kind.text)) throw new Error('This control may submit the form; use browser_click so Rax captures the form state first');
    const [download] = await this.awaitPage(() => Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      locator.click({ timeout: 60000 }),
    ]), 'Download');
    const directory = path.join(paths().applicationsDir, this.record.id, 'downloads');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.basename(download.suggestedFilename() || 'download');
    const file = path.join(directory, `${Date.now()}-${filename}`);
    await download.saveAs(file);
    this.record.downloads ||= [];
    this.record.downloads.push(file);
    return { file, sourceUrl: download.url(), size: (await fs.stat(file)).size };
  }
  async screenshot() {
    const dir = path.join(paths().applicationsDir, this.record.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now()}.png`);
    await this.current().screenshot({ path: file, fullPage: true, timeout: 30000 });
    return { file, url: this.current().url() };
  }
  async scrollPage(deltaY) {
    if (!Number.isFinite(deltaY)) throw new Error('Scroll amount must be a number');
    const requested = deltaY;
    deltaY = Math.max(-5000, Math.min(5000, deltaY));
    const direction = Math.sign(deltaY);
    if (this.lastScroll && direction && direction !== this.lastScroll.direction && Date.now() - this.lastScroll.at < 15000) {
      return { requestedPixels: requested, appliedPixels: 0, ignored: true, reason: 'Ignored a rapid reverse scroll; inspect the current page before changing direction.', url: this.current().url() };
    }
    const before = await this.current().evaluate(() => (document.scrollingElement || document.documentElement).scrollTop);
    await this.current().mouse.wheel(0, deltaY);
    await this.current().waitForTimeout(200);
    const after = await this.current().evaluate(() => { const root = document.scrollingElement || document.documentElement; return { top: root.scrollTop, height: root.scrollHeight, viewport: root.clientHeight }; });
    this.lastScroll = { direction, at: Date.now() };
    return { requestedPixels: requested, appliedPixels: deltaY, before, after: after.top, atBottom: after.top + after.viewport >= after.height - 4, moved: after.top !== before, url: this.current().url() };
  }
  async moveCursor(x, y) {
    const page = this.current();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw new Error('Mouse coordinates are outside the browser viewport');
    await page.bringToFront();
    await page.mouse.move(x, y);
    let physical = false;
    if (process.env.XDG_SESSION_TYPE === 'x11' && process.env.DISPLAY) {
      try {
        const geometry = await page.evaluate(() => ({ x: screenX, y: screenY, outerWidth, outerHeight, innerWidth, innerHeight }));
        const left = Math.max(0, Math.round(geometry.x + (geometry.outerWidth - geometry.innerWidth) / 2 + x));
        const top = Math.max(0, Math.round(geometry.y + geometry.outerHeight - geometry.innerHeight + y));
        await execFileAsync('xdotool', ['mousemove', String(left), String(top)], { timeout: 3000 });
        physical = true;
      } catch { /* Playwright pointer still moved inside Chrome. */ }
    }
    return { x, y, physicalCursorMoved: physical };
  }
  async clickAt(x, y, button = 'left') {
    const page = this.current();
    const beforeUrl = page.url();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw new Error('Click coordinates are outside the browser viewport');
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const control = el?.closest('button,input,[role="button"],a') || el;
      return { tag: control?.tagName?.toLowerCase(), type: control?.getAttribute('type'), text: (control?.innerText || control?.value || control?.getAttribute('aria-label') || '').trim().slice(0, 180), formSubmit: control?.tagName === 'BUTTON' && control.closest('form') && (!control.getAttribute('type') || control.getAttribute('type') === 'submit') };
    }, { x, y });
    if (button === 'left' && (['submit', 'image'].includes(hit.type) || hit.formSubmit || /\b(submit|send|complete|finalize|finish|confirm|apply|register)\b/i.test(hit.text))) {
      if (!await this.approveSubmission(hit.text || hit.type || 'button')) return { cancelled: true };
    }
    await this.moveCursor(x, y);
    await page.mouse.click(x, y, { button, timeout: 15000 });
    await Promise.race([
      page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 10000 }).catch(() => {}),
      page.waitForTimeout(700),
    ]);
    if (page.url() !== beforeUrl) await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    return { clicked: { x, y, button, hit }, url: page.url() };
  }
  async scrollAt(x, y, deltaY, deltaX = 0) {
    await this.moveCursor(x, y);
    await this.current().mouse.wheel(deltaX, deltaY);
    await this.current().waitForTimeout(200);
    return { scrolled: { x, y, deltaX, deltaY } };
  }
  async drag(fromX, fromY, toX, toY) {
    const viewport = await this.current().evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (![fromX, fromY, toX, toY].every(Number.isFinite) || fromX < 0 || fromY < 0 || toX < 0 || toY < 0 || fromX >= viewport.width || toX >= viewport.width || fromY >= viewport.height || toY >= viewport.height) throw new Error('Drag coordinates are outside the browser viewport');
    await this.moveCursor(fromX, fromY);
    const mouse = this.current().mouse;
    await mouse.down();
    try {
      await mouse.move(toX, toY, { steps: 20 });
    } finally { await mouse.up(); }
    await this.moveCursor(toX, toY);
    return { dragged: { fromX, fromY, toX, toY } };
  }
  async wait(milliseconds) {
    const duration = Math.max(100, Math.min(Number(milliseconds) || 1000, 10000));
    await this.current().waitForTimeout(duration);
    return { waitedMilliseconds: duration, url: this.current().url() };
  }
  async pressKey(key) {
    const page = this.current();
    const enter = /(^|\+)(?:Numpad)?Enter$/i.test(key);
    if (enter || /^(Space|Spacebar)$/i.test(key)) {
      const risky = enter || await page.evaluate(() => Boolean(document.activeElement?.closest('form') || document.activeElement?.matches('button,[role="button"]')));
      if (risky && !await this.approveSubmission(`press ${key}`)) return { cancelled: true };
    }
    await page.keyboard.press(key);
    return { pressed: key };
  }
  async typeText(text) {
    if (typeof text !== 'string' || text.length > 20000) throw new Error('Text must be under 20,000 characters');
    await this.current().keyboard.insertText(text);
    return { typedCharacters: text.length };
  }
  async handoff(message) {
    await ask(`Chrome needs you: ${message}\nUse the visible browser, then press Enter when ready: `);
    return this.snapshot();
  }
  async detach() { await this.browser?.close(); this.browser = null; this.context = null; this.page = null; }
  async close() {
    try { await (await this.browser?.newBrowserCDPSession())?.send('Browser.close'); } catch {}
    await this.detach();
    const portFile = path.join(paths().browserDir, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await fs.access(portFile); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
