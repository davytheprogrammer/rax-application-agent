const { app, BrowserWindow, Notification, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const root = path.resolve(__dirname, '../..');
const bridgePath = path.join(root, 'src/desktop-bridge.js');
const uiPath = path.join(__dirname, 'index.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
let mainWindow;
let companionWindow;
let bridge;
let nextRequestId = 1;
let activeId = null;
let documentsDir = path.join(app.getPath('documents'), 'Rax');
let dataDir = '';
let pending = new Map();
let quitting = false;
let allowQuit = false;
const noticeTimes = new Map();
let pendingFileRequest = null;

function backgroundNotice(kind, title, body, cooldown = 10000) {
  if (quitting || mainWindow?.isFocused() || companionWindow?.isFocused()) return;
  const now = Date.now();
  if (now - (noticeTimes.get(kind) || 0) < cooldown) return;
  noticeTimes.set(kind, now);
  try {
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title, body: String(body || '').slice(0, 240), silent: true });
    notice.on('click', fullWindow);
    notice.show();
  } catch { /* The in-app event remains visible. */ }
}

function sendToWindows(message) {
  const soundWindow = companionWindow?.isVisible() ? companionWindow : mainWindow;
  for (const window of [mainWindow, companionWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('rax:message', { ...message, audible: window === soundWindow });
  }
}

function command(action, values = {}) {
  if (!bridge || bridge.exitCode !== null || !bridge.stdin.writable) return Promise.reject(new Error('Local agent is not running'));
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    bridge.stdin.write(JSON.stringify({ action, requestId, ...values }) + '\n', error => {
      if (error && pending.delete(requestId)) reject(error);
    });
  });
}

function companion() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  companionWindow.show();
  companionWindow.focus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (pendingFileRequest) companionWindow.webContents.send('rax:message', { ...pendingFileRequest, audible: false });
}

function fullWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.hide();
  if (pendingFileRequest) mainWindow.webContents.send('rax:message', { ...pendingFileRequest, audible: false });
}

function onBridgeMessage(message) {
  if (message.kind === 'reply') {
    const request = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (request) (message.ok ? request.resolve(message.data) : request.reject(new Error(message.error || 'Agent error')));
    return;
  }
  if (message.kind === 'request_file') {
    pendingFileRequest = message;
    backgroundNotice('attention', 'Rax needs a file', message.purpose || 'Choose a file to continue.');
    const window = companionWindow?.isVisible() ? companionWindow : mainWindow;
    if (window && !window.isDestroyed()) window.webContents.send('rax:message', { ...message, audible: true });
    else void command('answer', { id: message.id, answer: '' }).catch(() => {});
    return;
  }
  if (message.kind === 'request_input') backgroundNotice('attention', 'Rax needs your input', message.question || 'Open Rax to continue.');
  if (message.kind === 'event') {
    if (message.type === 'started') activeId = message.id;
    if (message.type === 'record_updated') activeId = null;
    if (message.type === 'input_resolved' && pendingFileRequest?.id === message.id) pendingFileRequest = null;
    if (['tool_error', 'error', 'issue', 'backend_closed'].includes(message.type)) backgroundNotice('problem', 'Rax hit a problem', message.text || 'Open Rax for details.', 30000);
    if (message.type === 'curation' && message.stage === 'unavailable') backgroundNotice('problem', 'Answer review is unavailable', message.text || 'Rax kept the draft.', 30000);
    if (message.type === 'complete') backgroundNotice('finished', message.status === 'submitted' ? 'Application submitted' : 'Rax paused', message.status === 'submitted' ? 'Rax recorded submission evidence.' : 'Open Rax for the application status.');
  }
  sendToWindows(message);
}

function startBridge() {
  bridge = spawn(process.env.RAX_NODE_BINARY || 'node', [bridgePath], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  bridge.stderr.on('data', chunk => sendToWindows({ kind: 'event', type: 'error', text: String(chunk).slice(0, 1500) }));
  bridge.on('error', error => sendToWindows({ kind: 'event', type: 'backend_closed', text: `Could not start local agent: ${error.message}` }));
  readline.createInterface({ input: bridge.stdout }).on('line', line => {
    try { onBridgeMessage(JSON.parse(line)); }
    catch { sendToWindows({ kind: 'event', type: 'error', text: 'The local agent sent invalid data.' }); }
  });
  bridge.on('exit', code => {
    for (const request of pending.values()) request.reject(new Error(`Local agent exited (${code ?? 'unknown'}).`));
    pending.clear();
    sendToWindows({ kind: 'event', type: 'backend_closed', text: 'Local agent stopped.' });
  });
}

function makeWindow({ width, height, minWidth, minHeight, frame = true, alwaysOnTop = false }) {
  const window = new BrowserWindow({
    width, height, minWidth, minHeight, frame, alwaysOnTop, icon: path.join(__dirname, 'assets/rax-icon.png'), backgroundColor: '#0b0817',
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(uiPath, { query: { mode: frame ? 'main' : 'companion' } });
  return window;
}

app.whenReady().then(async () => {
  startBridge();
  mainWindow = makeWindow({ width: 1280, height: 840, minWidth: 940, minHeight: 640 });
  companionWindow = makeWindow({ width: 420, height: 420, minWidth: 360, minHeight: 330, frame: false, alwaysOnTop: true });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  companionWindow.on('close', event => { if (!quitting) { event.preventDefault(); fullWindow(); } });
  mainWindow.on('closed', () => { mainWindow = null; if (!quitting) app.quit(); });
  companionWindow.on('closed', () => { companionWindow = null; });
  try {
    const state = await command('state');
    documentsDir = state.documentsDir || documentsDir;
    dataDir = state.dataDir || '';
    activeId = state.activeId || null;
    fullWindow();
  } catch (error) { sendToWindows({ kind: 'event', type: 'error', text: error.message }); }
});

function validSender(event) {
  return [mainWindow, companionWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
}
ipcMain.handle('rax:command', async (event, action, values) => {
  if (!validSender(event)) throw new Error('Unknown Rax window');
  const allowed = new Set(['state', 'new_chat', 'home_request', 'cancel_home_request', 'start', 'resume', 'stop', 'takeover', 'handback', 'answer', 'chat', 'save_profile', 'save_settings', 'list_local_files', 'attach_file', 'application']);
  if (!allowed.has(action) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid command');
  const result = await command(action, values);
  if (action === 'state') { documentsDir = result.documentsDir || documentsDir; dataDir = result.dataDir || dataDir; activeId = result.activeId || null; }
  return result;
});
ipcMain.handle('rax:open-documents', async event => {
  if (!validSender(event)) throw new Error('Unknown Rax window');
  await fs.mkdir(documentsDir, { recursive: true, mode: 0o700 });
  const error = await shell.openPath(documentsDir);
  if (error) throw new Error(error);
  return documentsDir;
});
ipcMain.handle('rax:read-image', async (event, file) => {
  if (!validSender(event) || typeof file !== 'string' || !dataDir) throw new Error('Invalid screenshot request');
  const allowedDir = await fs.realpath(path.join(dataDir, 'applications'));
  const actual = await fs.realpath(file);
  if (!actual.startsWith(allowedDir + path.sep) || path.extname(actual).toLowerCase() !== '.png') throw new Error('Screenshot path is outside application data');
  return `data:image/png;base64,${(await fs.readFile(actual)).toString('base64')}`;
});
ipcMain.handle('rax:show-main', event => { if (!validSender(event)) throw new Error('Unknown Rax window'); fullWindow(); });
ipcMain.handle('rax:show-companion', event => { if (!validSender(event)) throw new Error('Unknown Rax window'); companion(); });
ipcMain.handle('rax:quit', event => { if (!validSender(event)) throw new Error('Unknown Rax window'); app.quit(); });

app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const finish = () => { allowQuit = true; app.quit(); };
  if (!bridge || bridge.exitCode !== null) { finish(); return; }
  if (activeId) void command('stop').catch(() => {}).finally(() => bridge.stdin.end());
  else bridge.stdin.end();
  const timeout = setTimeout(() => { if (bridge.exitCode === null) bridge.kill('SIGTERM'); finish(); }, 15000);
  bridge.once('exit', () => { clearTimeout(timeout); finish(); });
});
