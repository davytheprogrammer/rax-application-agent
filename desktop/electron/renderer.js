const companionMode = new URLSearchParams(location.search).get('mode') === 'companion';
document.body.classList.add(companionMode ? 'companion-mode' : 'main-mode');
const byId = id => document.getElementById(id);
if (companionMode) byId('companion-app').hidden = false;
const state = { applications: [], selectedId: null, activeId: null, pausedByUser: false, stopping: false, pendingPrompt: null, runDetail: '', issue: null, profileDirty: false, current: null, view: 'welcome', backendOnline: false, configured: false, homeChat: [], homeBusy: false, homeCancelled: false, documentsDir: '', lastFileDirectory: '' };
let toastTimer;
let fileBrowser = null;
let fileSearchTimer;
const dismissedIssues = new Set();
const announcedIssues = new Set();
const soundTimes = new Map();
let audioContext;

function soundsEnabled() {
  try { return (localStorage.getItem('rax:sounds') ?? localStorage.getItem('kito:sounds')) !== 'off'; }
  catch { return true; }
}
function renderSoundControl() {
  const button = byId('sound-toggle');
  button.textContent = soundsEnabled() ? 'On' : 'Muted';
  button.setAttribute('aria-pressed', String(soundsEnabled()));
}
async function playSound(kind, force = false) {
  if ((!force && !soundsEnabled()) || !window.AudioContext) return;
  const now = Date.now();
  if (!force && now - (soundTimes.get(kind) || 0) < (kind === 'error' ? 10000 : 1500)) return;
  soundTimes.set(kind, now);
  try {
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();
    const notes = kind === 'success' ? [659, 784, 1047] : kind === 'error' ? [440, 330] : [523, 659];
    const start = audioContext.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const at = start + index * 0.115;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(kind === 'error' ? 0.045 : 0.06, at + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.23);
    });
  } catch { /* The visual notification still works if audio is unavailable. */ }
}

function toast(message) {
  const node = byId('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}
async function call(action, values = {}) {
  try { return await window.rax.command(action, values); }
  catch (error) { toast(error.message || String(error)); throw error; }
}
function text(node, value) { node.textContent = value == null ? '' : String(value); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function shorten(value, length = 64) { const item = String(value || ''); return item.length > length ? item.slice(0, length - 1) + '…' : item; }
function appendActivity(value, kind = '') {
  const container = byId('activity');
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = `activity-line ${kind}`;
  line.textContent = value;
  container.appendChild(line);
  while (container.children.length > 150) container.firstChild.remove();
  container.scrollTop = container.scrollHeight;
}
function chatLine(role, value, targets = [byId('chat-history'), byId('companion-chat')]) {
  for (const container of targets) {
    const line = document.createElement('div');
    line.className = `chat-line ${role === 'user' ? 'user' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = role === 'user' ? 'Y' : 'R';
    const body = document.createElement('div'); body.className = 'chat-body';
    const speaker = document.createElement('div');
    speaker.className = 'speaker';
    speaker.textContent = role === 'user' ? 'You' : 'Rax';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = String(value || '');
    body.append(speaker, bubble);
    line.append(avatar, body);
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }
}
function renderChat(items) {
  clear(byId('chat-history'));
  clear(byId('companion-chat'));
  for (const item of items || []) chatLine(item.role, item.text);
  if (!(items || []).length && !state.activeId) {
    const empty = document.createElement('div'); empty.className = 'chat-empty';
    empty.innerHTML = '<svg><use href="#i-spark"/></svg><strong>Ready when you are.</strong><p>Resume this application or send Rax a message to continue from saved context.</p>';
    byId('chat-history').appendChild(empty);
  }
}
function renderHomeChat(items) {
  state.homeChat = items || [];
  const container = byId('home-chat-history'); clear(container);
  byId('welcome-view').classList.toggle('has-chat', state.homeChat.length > 0);
  for (const item of state.homeChat) chatLine(item.role, item.text, [container]);
  container.scrollTop = container.scrollHeight;
}
function renderFileBrowser() {
  if (!fileBrowser) return;
  const list = byId('file-browser-list'); clear(list);
  const query = byId('file-search').value.trim().toLowerCase();
  if (fileBrowser.selected && !fileBrowser.selected.name.toLowerCase().includes(query)) fileBrowser.selected = null;
  const items = fileBrowser.items.filter(item => item.name.toLowerCase().includes(query));
  if (!items.length) {
    const empty = document.createElement('div'); empty.className = 'file-browser-empty';
    empty.textContent = fileBrowser.items.length ? 'No files match this filter.' : 'This folder is empty. Try Downloads or Home above.';
    list.appendChild(empty);
  }
  for (const item of items) {
    const row = document.createElement('button'); row.type = 'button'; row.className = `file-browser-row ${fileBrowser.selected?.path === item.path ? 'selected' : ''}`;
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(fileBrowser.selected?.path === item.path)); row.title = item.path;
    const icon = document.createElement('span'); icon.className = 'file-browser-icon'; icon.textContent = item.type === 'directory' ? '▣' : '▤';
    const name = document.createElement('span'); name.textContent = item.name;
    const size = document.createElement('small'); size.textContent = item.type === 'directory' ? 'Folder →' : `${Math.max(1, Math.round((item.bytes || 0) / 1024))} KB`;
    row.append(icon, name, size);
    row.addEventListener('click', () => {
      if (item.type === 'directory') { void browseFileDirectory(item.path); return; }
      fileBrowser.selected = item; text(byId('file-hint'), item.path); byId('file-select').disabled = false;
      for (const candidate of list.querySelectorAll('.file-browser-row')) {
        const selected = candidate.title === item.path;
        candidate.classList.toggle('selected', selected);
        candidate.setAttribute('aria-selected', String(selected));
      }
    });
    row.addEventListener('dblclick', () => { if (item.type === 'file') { fileBrowser.selected = item; void selectFileBrowserFile(); } });
    list.appendChild(row);
  }
  byId('file-select').disabled = !fileBrowser.selected || fileBrowser.loading;
}
async function browseFileDirectory(directory, initial = false, query = '') {
  if (!fileBrowser) return;
  if (fileBrowser.loading) { fileBrowser.queuedDirectory = { directory, query }; return; }
  const browser = fileBrowser;
  fileBrowser.loading = true;
  byId('file-select').disabled = true;
  text(byId('file-hint'), 'Loading files…');
  try {
    let result = await call('list_local_files', { directory, query });
    if (initial && !query && !result.items.length && result.locations.downloads && result.directory !== result.locations.downloads) {
      result = await call('list_local_files', { directory: result.locations.downloads });
      text(byId('file-hint'), 'Rax documents is empty, so Downloads is shown.');
    } else text(byId('file-hint'), result.truncated ? 'Showing the first 500 items in this folder.' : 'Select a file, or open a folder.');
    if (fileBrowser !== browser) return;
    fileBrowser.directory = result.directory;
    fileBrowser.parent = result.parent;
    fileBrowser.locations = result.locations;
    fileBrowser.items = result.items;
    fileBrowser.truncated = result.truncated;
    fileBrowser.serverQuery = query;
    fileBrowser.selected = null;
    state.lastFileDirectory = result.directory;
    byId('file-path').value = result.directory;
    byId('file-search').value = query;
  } catch (error) { text(byId('file-hint'), `Could not open folder: ${error.message || error}`); }
  finally {
    if (fileBrowser === browser) {
      browser.loading = false;
      renderFileBrowser();
      if (browser.queuedDirectory) {
        const next = browser.queuedDirectory;
        browser.queuedDirectory = null;
        void browseFileDirectory(next.directory, false, next.query);
      }
    }
  }
}
async function openFileBrowser({ mode, requestId = null, purpose = '', applicationId = null }) {
  if (fileBrowser) {
    if (mode !== 'agent' || fileBrowser.mode === 'agent') return;
    fileBrowser = null;
    byId('file-overlay').hidden = true;
  }
  fileBrowser = { mode, requestId, applicationId, directory: '', parent: '', locations: {}, items: [], selected: null, loading: false, queuedDirectory: null, truncated: false, serverQuery: '' };
  text(byId('file-title'), mode === 'agent' ? 'Choose a file for Rax' : 'Attach a file');
  text(byId('file-purpose'), purpose || (mode === 'agent' ? 'Rax needs a source document to continue.' : 'Select a local file to add to this application.'));
  text(byId('file-select'), mode === 'agent' ? 'Use selected file' : 'Attach selected file');
  byId('file-overlay').hidden = false;
  await browseFileDirectory(state.lastFileDirectory || state.documentsDir || '', true);
  byId('file-search').focus();
}
async function closeFileBrowser() {
  if (!fileBrowser) return;
  const current = fileBrowser;
  fileBrowser = null;
  byId('file-overlay').hidden = true;
  if (current.mode === 'agent') await call('answer', { id: current.requestId, answer: '' });
}
async function selectFileBrowserFile() {
  if (!fileBrowser?.selected || fileBrowser.loading) return;
  const current = fileBrowser;
  current.loading = true;
  byId('file-select').disabled = true;
  try {
    if (current.mode === 'agent') await call('answer', { id: current.requestId, answer: current.selected.path });
    else {
      await call('attach_file', { id: current.applicationId, file: current.selected.path });
      toast(`Attached ${current.selected.name} to this application.`);
      await selectApplication(current.applicationId);
    }
    fileBrowser = null;
    byId('file-overlay').hidden = true;
  } catch (error) { if (fileBrowser === current) { current.loading = false; text(byId('file-hint'), `Could not use file: ${error.message || error}`); renderFileBrowser(); } }
}
function issueKey(issue) { return `${issue.id || 'agent'}:${issue.type}:${issue.name || ''}:${issue.text}`; }
function renderIssue(issue, announce = false) {
  state.issue = issue;
  const banner = byId('issue-banner');
  const key = issue && issueKey(issue);
  banner.hidden = !issue || dismissedIssues.has(key);
  if (!issue || banner.hidden) return;
  const title = issue.type === 'tool_error' ? 'Rax hit a page issue' : issue.type === 'curation' ? 'Answer review needs attention' : issue.type === 'preview' ? 'Chrome preview issue' : 'Rax needs attention';
  const detail = issue.name ? `${activityLabel(issue.name)}: ${issue.text}` : issue.text;
  text(byId('issue-title'), title);
  text(byId('issue-text'), detail);
  if (announce && !announcedIssues.has(key)) {
    chatLine('assistant', `${title}: ${detail}`);
    announcedIssues.add(key);
  }
}
function activityLabel(name) {
  return ({ browser_snapshot: 'Read the current page', inspect_form: 'Inspect application fields', browser_fill: 'Fill an answer', browser_fill_fields: 'Fill application answers', browser_click: 'Click a page control', curate_answer: 'Review an answer', read_local_file: 'Read a source document', record_confirmation: 'Record submission confirmation', browser_upload: 'Upload an attached file' })[name] || String(name || 'Action').replaceAll('_', ' ');
}
function renderTaskCard(record) {
  const container = byId('chat-history');
  container.querySelector('.task-card')?.remove();
  const card = document.createElement('div'); card.className = 'task-card';
  const heading = document.createElement('div'); heading.className = 'task-card-heading';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-bolt'); icon.appendChild(use);
  const title = document.createElement('strong'); title.textContent = 'Application activity';
  const status = document.createElement('span'); status.textContent = state.activeId === record.id ? state.pendingPrompt ? 'Waiting for you' : state.pausedByUser ? 'You have control' : state.stopping ? 'Stopping' : 'In progress' : record.status === 'submitted' ? 'Submitted' : 'Recorded';
  heading.append(icon, title, status); card.appendChild(heading);
  const list = document.createElement('div'); list.className = 'task-list';
  const toolEvents = (record.events || []).filter(item => item.type === 'tool' || item.type === 'tool_error').slice(-5);
  if (!toolEvents.length) {
    const empty = document.createElement('div'); empty.className = 'task-empty'; empty.textContent = state.activeId === record.id ? 'Rax is getting started. Actions will appear here as they happen.' : 'No recorded tool actions yet.'; list.appendChild(empty);
  }
  for (const item of toolEvents) {
    const row = document.createElement('div'); row.className = `task-row ${item.type === 'tool_error' ? 'tool-error' : ''} ${item.pending ? 'pending' : ''}`;
    const rowIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const rowUse = document.createElementNS('http://www.w3.org/2000/svg', 'use'); rowUse.setAttribute('href', item.type === 'tool_error' || item.pending ? '#i-bolt' : '#i-check'); rowIcon.appendChild(rowUse);
    const name = document.createElement('span'); name.textContent = activityLabel(item.detail?.name || item.detail?.error || item.detail || item.type);
    const time = document.createElement('small'); time.textContent = item.pending ? 'Working' : String(item.at || '').slice(11, 16);
    row.append(rowIcon, name, time); list.appendChild(row);
  }
  card.appendChild(list); container.appendChild(card); container.scrollTop = container.scrollHeight;
}
function renderConversation(record) {
  const container = byId('chat-history'); clear(container);
  const intro = document.createElement('div'); intro.className = 'conversation-intro'; intro.textContent = 'Application conversation'; container.appendChild(intro);
  const items = [];
  if (record.goal) items.push({ role: 'user', text: record.goal, at: record.createdAt || '', initial: true });
  for (const item of record.chat || []) items.push({ role: item.role, text: item.text, at: item.at || '' });
  for (const item of record.events || []) {
    if (item.type === 'message' && typeof item.detail === 'string') items.push({ role: 'assistant', text: item.detail, at: item.at || '' });
    if (['tool_error', 'error', 'issue'].includes(item.type)) {
      const detail = typeof item.detail === 'string' ? item.detail : item.detail?.error || '';
      if (detail) items.push({ role: 'assistant', text: `Rax hit an issue: ${detail}`, at: item.at || '' });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  const seen = new Set();
  for (const item of items.slice(-30)) {
    const key = `${item.role}:${item.text}`;
    if (!item.text || seen.has(key)) continue;
    seen.add(key);
    chatLine(item.role, item.text, [container]);
  }
  if (!items.some(item => item.role === 'assistant') && record.summary) chatLine('assistant', record.summary, [container]);
  if (items.length === 0 && !record.summary) {
    const empty = document.createElement('div'); empty.className = 'chat-empty';
    empty.innerHTML = '<svg><use href="#i-spark"/></svg><strong>Ready when you are.</strong><p>Resume this application or send Rax a message to continue from saved context.</p>';
    container.appendChild(empty);
  }
  renderTaskCard(record);
  container.scrollTop = 0;
}
function showView(view) {
  state.view = view;
  for (const name of ['welcome', 'work', 'history']) byId(`${name}-view`).hidden = name !== view;
}
function openStart() {
  if (state.activeId) { toast('Finish or stop the running application before starting another.'); return; }
  if (!state.configured) { showTab('settings'); toast('Set the Muse model and API key first.'); return; }
  byId('start-overlay').hidden = false;
  byId('start-url').focus();
}
function renderHistory() {
  const container = byId('application-list');
  const rail = byId('rail-applications');
  clear(container);
  clear(rail);
  if (!state.applications.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No applications yet.'; container.appendChild(empty);
  }
  for (const item of state.applications) {
    const button = document.createElement('button');
    button.className = `application-item ${item.id === state.selectedId ? 'selected' : ''}`;
    const name = document.createElement('strong'); name.textContent = item.goal || item.url || item.id;
    const meta = document.createElement('span');
    const status = document.createElement('span'); status.textContent = item.status || 'unknown';
    const time = document.createElement('span'); time.textContent = String(item.updatedAt || '').slice(0, 16).replace('T', ' ');
    meta.append(status, time);
    button.append(name, meta);
    button.addEventListener('click', () => selectApplication(item.id));
    container.appendChild(button);
    const railButton = document.createElement('button');
    railButton.className = `rail-app ${item.id === state.selectedId && state.view === 'work' ? 'selected' : ''}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-folder'); icon.appendChild(use);
    const label = document.createElement('span'); label.textContent = item.goal || item.url || item.id;
    railButton.append(icon, label);
    railButton.addEventListener('click', () => selectApplication(item.id));
    rail.appendChild(railButton);
  }
}
function renderControls() {
  const running = Boolean(state.activeId);
  const offline = !state.backendOnline;
  const prompt = state.pendingPrompt?.purpose;
  const awaitingReply = running && !state.stopping && !state.pausedByUser && ['clarification', 'question'].includes(prompt);
  const chatEnabled = !offline && state.configured && Boolean(state.selectedId) && (!running || awaitingReply);
  for (const id of ['start-btn', 'resume-btn']) byId(id).disabled = offline || !state.configured || running || id === 'resume-btn' && !state.selectedId;
  byId('stop-btn').disabled = offline || !running || state.stopping;
  byId('companion-stop').disabled = offline || !running || state.stopping;
  byId('takeover-btn').disabled = offline || !running || state.pausedByUser || Boolean(prompt);
  byId('companion-takeover').disabled = offline || !running || state.pausedByUser || Boolean(prompt);
  byId('handback-btn').disabled = offline || !running || !state.pausedByUser;
  byId('companion-handback').disabled = offline || !running || !state.pausedByUser;
  byId('attach-btn').disabled = offline || !state.selectedId;
  byId('composer-attach').disabled = offline || !state.selectedId;
  byId('answers-btn').disabled = offline || !state.selectedId;
  byId('chat-input').disabled = !chatEnabled;
  byId('send-btn').disabled = !chatEnabled;
  byId('companion-input').disabled = !chatEnabled;
  byId('companion-send').disabled = !chatEnabled;
  byId('home-input').disabled = offline || !state.configured || running || state.homeBusy;
  byId('home-send').disabled = offline || !state.configured || running || state.homeBusy;
  byId('home-cancel').hidden = !state.homeBusy;
  byId('home-cancel').disabled = offline;
  byId('back-home-btn').disabled = running;
  byId('new-app-btn').disabled = offline || running;
  byId('setup-agent-btn').hidden = offline || state.configured;
  const mode = !state.backendOnline ? 'offline' : !state.configured ? 'setup' : state.stopping ? 'stopping' : state.pausedByUser ? 'human' : running && prompt ? 'waiting' : running ? 'running' : state.homeBusy ? 'thinking' : 'idle';
  const label = ({ offline: 'Agent unavailable', setup: 'Set up Muse', stopping: 'Stopping Rax', human: 'You control Chrome', waiting: prompt === 'handoff' ? 'Waiting for sign-in' : prompt === 'approval' ? 'Approval needed' : prompt === 'file' ? 'Choose a file' : 'Waiting for your answer', running: 'Rax is working', thinking: 'Rax is thinking', idle: 'Not running' })[mode];
  text(byId('rail-status'), label);
  byId('connection-status').classList.toggle('offline', !state.backendOnline);
  byId('connection-status').classList.toggle('setup', state.backendOnline && !state.configured);
  byId('connection-status').innerHTML = `<i class="dot"></i> ${!state.backendOnline ? 'Offline' : state.configured ? 'Online' : 'Setup needed'}`;
  text(byId('run-status'), label);
  text(byId('companion-status'), label);
  byId('run-status').className = `status-pill ${mode === 'running' ? 'running' : ['waiting', 'human'].includes(mode) ? 'human' : ''}`;
  const banner = byId('run-banner');
  banner.className = `run-banner ${mode}`;
  text(byId('run-banner-title'), label);
  text(byId('run-banner-detail'), mode === 'waiting' ? prompt === 'handoff' ? 'Finish sign-in or verification in Chrome, then click I finished in Chrome.' : prompt === 'approval' ? 'Review the action and choose Approve or Deny.' : prompt === 'file' ? 'Choose a file in the desktop picker.' : 'Reply to Rax’s question below so it can continue.' : mode === 'running' ? state.runDetail || 'Rax is working through this application. Stop the agent to send a new instruction.' : mode === 'stopping' ? 'Rax is stopping. Chrome will remain open.' : mode === 'human' ? 'Finish your work in Chrome, then hand control back to Rax.' : mode === 'idle' ? 'Send a message to continue this application.' : label);
  const selected = state.applications.find(item => item.id === (state.activeId || state.selectedId));
  text(byId('companion-title'), selected?.goal || 'No application selected');
  text(byId('companion-url'), selected?.currentUrl || selected?.url || 'Start one in the full workspace.');
  text(byId('composer-title'), awaitingReply ? 'Rax needs your answer' : running ? 'Stop Rax to send a new message' : 'Message Rax to continue');
  text(byId('composer-hint'), awaitingReply ? 'Your reply resumes Rax automatically.' : running ? prompt === 'handoff' ? 'Complete sign-in in Chrome, then use the button here.' : 'Rax is working. Stop it before sending new instructions.' : 'Rax can finish and submit applications automatically.');
  byId('chat-input').placeholder = awaitingReply ? 'Type your answer to Rax…' : running ? 'Stop Rax to send a message' : 'Message Rax to continue…';
  byId('companion-input').placeholder = awaitingReply ? 'Type your answer to Rax…' : running ? 'Stop Rax to send a message' : 'Message Rax to continue…';
  byId('suggest-attach').disabled = offline || !state.selectedId;
  byId('suggest-answers').disabled = offline || !state.selectedId;
  text(byId('suggest-answers'), state.current?.preSubmitSnapshot ? 'Review answers' : running ? 'View activity' : 'Resume application');
  byId('suggest-control').disabled = offline || running && Boolean(prompt);
  text(byId('suggest-control'), running ? state.pausedByUser ? 'Hand back to Rax' : 'Take over Chrome' : 'New application');
}
function renderProgress(record) {
  const list = byId('progress-list'); clear(list);
  const status = record.status || 'paused';
  const hasWork = (record.events || []).some(item => item.type === 'tool') || Boolean(record.preSubmitSnapshot || record.confirmation);
  const workingDone = status !== 'active' && hasWork;
  const reviewDone = Boolean(record.confirmation);
  const phases = [
    ['Application created', true, record.createdAt ? String(record.createdAt).slice(0, 16).replace('T', ' ') : 'Saved locally'],
    ['Working through the form', workingDone, status === 'active' ? state.pendingPrompt ? 'Waiting for you' : state.pausedByUser ? 'You have control' : 'Rax is working' : hasWork ? 'Activity saved' : 'Waiting to begin'],
    ['Review & refine', reviewDone, record.preSubmitSnapshot ? 'Form state captured' : 'Checking answers before submission'],
    ['Submitted', status === 'submitted', record.confirmation ? 'Confirmation recorded' : 'Awaiting confirmation']
  ];
  const currentIndex = status === 'active' || !workingDone ? 1 : !reviewDone ? 2 : status !== 'submitted' ? 3 : -1;
  for (const [index, [title, done, detail]] of phases.entries()) {
    const row = document.createElement('div'); row.className = `progress-item ${done ? 'done' : ''} ${index === currentIndex ? 'current' : ''}`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', done ? '#i-check' : '#i-layers'); icon.appendChild(use);
    const copy = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = title; const small = document.createElement('small'); small.textContent = detail; copy.append(strong, small); row.append(icon, copy); list.appendChild(row);
  }
}
function renderFiles(record) {
  const files = record.sourceFiles || [];
  text(byId('file-count'), `(${files.length})`);
  const list = byId('file-list'); clear(list);
  if (!files.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No files attached yet.'; list.appendChild(empty); }
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const kind = document.createElement('span'); kind.className = 'file-kind'; kind.textContent = String(file).split('.').pop().slice(0, 4).toUpperCase();
    const copy = document.createElement('div'); const name = document.createElement('strong'); name.textContent = String(file).split(/[\\/]/).pop(); const detail = document.createElement('small'); detail.textContent = 'Attached context'; copy.append(name, detail);
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-check'); check.appendChild(use); row.append(kind, copy, check); list.appendChild(row);
  }
}
function renderApplication(record) {
  state.current = record;
  const events = record.events || [];
  const issueIndex = events.findLastIndex(item => ['tool_error', 'error', 'issue'].includes(item.type));
  const laterProgress = events.slice(issueIndex + 1).some(item => item.type === 'tool' || item.type === 'confirmation');
  const lastIssue = issueIndex >= 0 && !laterProgress ? events[issueIndex] : null;
  renderIssue(lastIssue ? { id: record.id, type: lastIssue.type, name: lastIssue.detail?.name, text: typeof lastIssue.detail === 'string' ? lastIssue.detail : lastIssue.detail?.error || 'An issue interrupted this application.' } : null);
  text(byId('work-title'), record.goal || record.url || 'Application');
  text(byId('work-url'), record.currentUrl || record.url || '');
  text(byId('run-url'), record.currentUrl || record.url || 'Chrome is not running');
  let overview = 'Application target';
  try {
    const original = new URL(record.url);
    const current = new URL(record.currentUrl || record.url);
    overview = `Target: ${original.hostname}\nCurrent page: ${current.pathname === '/' ? 'Homepage' : current.pathname}`;
    if (current.pathname === '/' && record.status !== 'submitted') overview += '\nUse a direct form link or tell Rax which program to find.';
  } catch { /* The saved URL is still shown in the workspace heading. */ }
  text(byId('overview-summary'), overview);
  text(byId('overview-status'), record.status || 'paused');
  text(byId('overview-date'), String(record.updatedAt || '').slice(0, 10));
  renderProgress(record);
  renderFiles(record);
  renderChat(record.chat || []);
  renderConversation(record);
  renderControls();
  const feed = byId('activity');
  clear(feed);
  appendActivity(`Application: ${record.goal || record.id}`, 'message');
  if (record.confirmation) appendActivity(`Confirmed: ${record.confirmation.text}`, 'message');
  for (const item of (record.events || []).slice(-80)) {
    const detail = typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail || {});
    appendActivity(`${String(item.at || '').slice(11, 19)}  ${item.type}: ${shorten(detail, 360)}`, item.type === 'tool_error' ? 'error' : '');
  }
}
async function selectApplication(id) {
  if (state.activeId && id !== state.activeId) {
    toast('Finish or stop the running application before opening another record.');
    return;
  }
  state.selectedId = id;
  showTab('applications'); showView('work');
  renderHistory(); renderControls();
  try { renderApplication(await call('application', { id })); }
  catch { /* command already showed the error */ }
}
async function refresh() {
  const data = await call('state');
  state.backendOnline = true;
  state.configured = Boolean(data.keySet && data.model);
  state.applications = data.applications || [];
  state.activeId = data.activeId || null;
  state.pausedByUser = Boolean(data.pausedByUser);
  state.stopping = Boolean(data.stopping);
  state.pendingPrompt = data.pendingPrompt || null;
  state.documentsDir = data.documentsDir || state.documentsDir;
  if (state.activeId) { state.selectedId = state.activeId; showView('work'); }
  else if (!state.applications.some(item => item.id === state.selectedId)) state.selectedId = state.applications[0]?.id || null;
  renderHistory(); renderControls();
  if (state.pendingPrompt?.purpose === 'approval') showApproval(state.pendingPrompt);
  if (state.pendingPrompt?.purpose === 'handoff') { byId('handoff-btn').hidden = false; byId('companion-done').hidden = false; }
  if (!state.profileDirty) byId('profile-text').value = data.profile || '';
  byId('model-input').value = data.model || '';
  byId('curator-model-input').value = data.curatorModel || '';
  text(byId('key-status'), data.keySet ? 'API key saved locally' : 'API key missing');
  text(byId('data-dir'), `Local data: ${data.dataDir || ''}`);
  if (!state.homeBusy) renderHomeChat(data.homeChat || []);
  if (state.selectedId) {
    try { renderApplication(await call('application', { id: state.selectedId })); }
    catch { /* command already showed the error */ }
  }
}
function showTab(tab) {
  for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('active', button.dataset.tab === tab);
  for (const section of document.querySelectorAll('.tab-content')) section.classList.toggle('active', section.id === `${tab}-tab`);
  text(byId('page-title'), tab === 'profile' ? 'Knowledge' : tab === 'settings' ? 'Agent settings' : 'Applications');
  text(byId('page-subtitle'), tab === 'profile' ? 'The verified context Rax can reuse in applications.' : tab === 'settings' ? 'Configure the local agent and its model.' : 'Your personal agent for every application, from first draft to final submission.');
}
function showApproval(message) {
  state.pendingPrompt = message;
  text(byId('approval-title'), message.question.startsWith('Review this application') ? 'Review before submission' : 'Review Rax\'s action');
  text(byId('approval-text'), message.question.replace(/ Type yes to continue:\s*$/, ''));
  byId('approval-overlay').hidden = false;
  renderControls();
}
async function answerApproval(approved) {
  const prompt = state.pendingPrompt;
  if (!prompt) return;
  await call('answer', { id: prompt.id, answer: approved ? 'yes' : 'no' });
  byId('approval-overlay').hidden = true;
  if (state.pendingPrompt?.id === prompt.id) state.pendingPrompt = null;
}
function onMessage(message) {
  if (message.kind === 'request_file') { if (message.audible !== false) void playSound('attention'); void openFileBrowser({ mode: 'agent', requestId: message.id, purpose: message.purpose }); return; }
  if (message.kind === 'request_input') {
    if (message.audible !== false) void playSound('attention');
    const purpose = message.purpose || 'question';
    if (purpose === 'approval') { showApproval(message); return; }
    state.pendingPrompt = message;
    if (purpose === 'handoff') {
      chatLine('assistant', message.question.replace('Chrome needs you: ', '').replace('Use the visible browser, then press Enter when ready: ', '').trim());
      byId('handoff-btn').hidden = false;
      byId('companion-done').hidden = false;
    } else {
      chatLine('assistant', message.question.replace('Rax asks:', '').replace(/\n>\s*$/, '').trim());
    }
    renderControls();
    if (purpose !== 'handoff') (companionMode ? byId('companion-input') : byId('chat-input')).focus();
    return;
  }
  if (message.kind !== 'event') return;
  if (message.type === 'home_wait' && state.homeBusy) {
    const bubble = byId('home-chat-history').querySelector('.chat-line:last-child .bubble');
    if (bubble) text(bubble, message.text);
    return;
  }
  if (message.type === 'input_resolved') {
    if (fileBrowser?.mode === 'agent' && fileBrowser.requestId === message.id) { fileBrowser = null; byId('file-overlay').hidden = true; }
    if (state.pendingPrompt?.id === message.id) state.pendingPrompt = null;
    byId('approval-overlay').hidden = true;
    byId('handoff-btn').hidden = true;
    byId('companion-done').hidden = true;
    renderControls();
    return;
  }
  if (message.type === 'waiting' && message.purpose === 'file') { state.pendingPrompt = { id: message.id, purpose: 'file', question: message.text }; renderControls(); }
  if (message.type === 'started') { state.activeId = message.id; state.selectedId = message.id; state.stopping = false; state.runDetail = 'Opening Chrome and inspecting the application.'; showView('work'); renderControls(); void refresh(); }
  if (message.type === 'takeover') { state.pausedByUser = true; renderControls(); chatLine('assistant', message.text); }
  if (message.type === 'handback') { state.pausedByUser = false; renderControls(); chatLine('assistant', message.text); }
  if (message.type === 'stopping') { state.stopping = true; renderControls(); }
  if (message.type === 'record_updated') { state.activeId = null; state.pendingPrompt = null; state.pausedByUser = false; state.stopping = false; state.runDetail = ''; byId('handoff-btn').hidden = true; byId('companion-done').hidden = true; void refresh(); }
  if (message.type === 'url') { text(byId('run-url'), message.url); text(byId('companion-url'), message.url); }
  if (message.type === 'screenshot') {
    void window.rax.readImage(message.path).then(url => { byId('screenshot').src = url; byId('screenshot').hidden = false; byId('screenshot-empty').hidden = true; }).catch(error => renderIssue({ id: message.id, type: 'preview', text: `Could not show Chrome preview: ${error.message || error}` }, true));
  }
  if (message.type === 'message') {
    appendActivity(`Rax: ${message.text}`, 'message');
    chatLine('assistant', message.text);
    if (state.current?.id === message.id) state.current.summary = message.text;
  }
  if (message.type === 'tool') {
    appendActivity(`→ ${message.name}`);
    if (state.current?.id === message.id) {
      state.current.events ||= [];
      state.current.events.push({ at: new Date().toISOString(), type: 'tool', detail: { name: message.name }, pending: true });
      renderTaskCard(state.current);
    }
  }
  if (['tool_error', 'error', 'issue', 'backend_closed'].includes(message.type)) {
    if (message.audible !== false) void playSound('error');
    appendActivity(message.text || 'Agent error', 'error');
    renderIssue({ id: message.id || state.activeId || state.selectedId, type: message.type, name: message.name, text: message.text || 'The local agent stopped unexpectedly.' }, true);
  }
  if (message.type === 'backend_closed') { state.backendOnline = false; renderControls(); }
  if (message.type === 'curation') {
    appendActivity(`Curator · ${message.stage}: ${message.text || ''}`);
    if (message.stage === 'unavailable') { if (message.audible !== false) void playSound('error'); renderIssue({ id: message.id || state.activeId, type: 'curation', text: message.text || 'Answer review is unavailable.' }, true); }
  }
  if (message.type === 'status') { state.runDetail = message.text; renderControls(); }
  if (message.type === 'complete') { if (message.audible !== false) void playSound(message.status === 'submitted' ? 'success' : 'attention'); appendActivity(`Run ended: ${message.status}`, 'message'); }
}
async function sendChat(value) {
  const body = String(value || '').trim();
  if (!body) return;
  const id = state.activeId || state.selectedId;
  if (!id) { toast('Start or select an application first.'); return; }
  const prompt = state.pendingPrompt;
  if (state.activeId && !['clarification', 'question'].includes(prompt?.purpose)) { toast('Stop Rax before sending a new message.'); return; }
  if (state.stopping) { toast('Rax is stopping. Wait for the run to finish.'); return; }
  if (prompt?.purpose === 'handoff') { toast('Finish in Chrome, then use Done in Chrome.'); return; }
  if (prompt?.purpose === 'approval') { toast('Choose Approve or Deny before sending another message.'); return; }
  await call('chat', { id, text: body });
  chatLine('user', body);
  byId('chat-input').value = '';
  byId('companion-input').value = '';
}
async function sendHomeRequest() {
  const message = byId('home-input').value.trim();
  if (!message || state.homeBusy) return;
  if (state.activeId) { toast('Use the running application conversation to guide Rax.'); return; }
  if (!state.backendOnline) { toast('The local agent is unavailable.'); return; }
  const history = [...state.homeChat];
  state.homeBusy = true;
  byId('home-input').value = '';
  renderHomeChat([...history, { role: 'user', text: message }, { role: 'assistant', text: 'Working on that…' }]);
  renderControls();
  try {
    const result = await call('home_request', { message });
    renderHomeChat(result.homeChat || [...history, { role: 'user', text: message }, { role: 'assistant', text: result.reply || '' }]);
    if (result.action === 'start' && result.id) {
      state.activeId = result.id;
      state.selectedId = result.id;
      showView('work');
      await refresh();
    }
  } catch (error) {
    const detail = String(error?.message || 'Unknown error').slice(0, 500);
    renderHomeChat([...history, { role: 'user', text: message }, { role: 'assistant', text: state.homeCancelled ? 'Stopped. Edit your request and send it again when ready.' : `I could not continue: ${detail}. Check the connection or settings, then try again.` }]);
    byId('home-input').value = message;
  } finally {
    state.homeBusy = false;
    state.homeCancelled = false;
    renderControls();
  }
}
async function finishHandoff() {
  const prompt = state.pendingPrompt;
  if (!prompt || prompt.purpose !== 'handoff') return;
  await call('answer', { id: prompt.id, answer: 'done' });
  state.pendingPrompt = null;
  byId('handoff-btn').hidden = true;
  byId('companion-done').hidden = true;
  chatLine('user', 'Finished in Chrome. Continue.');
}
async function start() {
  const url = byId('start-url').value.trim();
  let parsed;
  try { parsed = new URL(url); } catch { toast('Enter a full application URL.'); return; }
  if (!['http:', 'https:'].includes(parsed.protocol)) { toast('Use an HTTP or HTTPS application URL.'); return; }
  const goal = byId('start-goal').value.trim() || 'Complete this application accurately.';
  if (parsed.pathname === '/' && !parsed.search && /^complete this application accurately\.?$/i.test(goal)) {
    toast('This is a homepage. Tell Rax which application or program to find.');
    byId('start-goal').focus();
    return;
  }
  const result = await call('start', { url, goal });
  byId('start-overlay').hidden = true;
  showTab('applications'); showView('work');
  state.activeId = result.id; state.selectedId = result.id; renderControls();
  await refresh();
}
async function resume() {
  if (!state.selectedId) return;
  const message = byId('chat-input').value.trim() || 'Continue this application from its saved context.';
  byId('chat-input').value = '';
  const result = await call('resume', { id: state.selectedId, message });
  state.activeId = result.id; renderControls();
}
async function attach() {
  if (!state.selectedId) return;
  await openFileBrowser({ mode: 'attach', applicationId: state.selectedId });
}
async function savedAnswers() {
  if (!state.selectedId) return;
  const record = await call('application', { id: state.selectedId });
  if (!record.preSubmitSnapshot) { toast('No reviewed answers saved yet.'); return; }
  text(byId('answers-text'), JSON.stringify(record.preSubmitSnapshot, null, 2));
  byId('answers-overlay').hidden = false;
}
function bind(id, handler) { byId(id).addEventListener('click', () => { Promise.resolve(handler()).catch(() => {}); }); }
for (const button of document.querySelectorAll('.nav-item')) button.addEventListener('click', () => showTab(button.dataset.tab));
bind('documents-btn', () => window.rax.openDocuments());
bind('companion-btn', () => window.rax.showCompanion());
bind('new-app-btn', openStart);
bind('setup-agent-btn', () => showTab('settings'));
bind('quick-start', openStart);
bind('quick-history', () => { showTab('applications'); showView('history'); renderHistory(); });
bind('quick-profile', () => showTab('profile'));
bind('quick-docs', () => window.rax.openDocuments());
bind('back-home-btn', () => showView('welcome'));
bind('close-start-btn', () => { byId('start-overlay').hidden = true; });
bind('composer-attach', attach);
bind('home-cancel', async () => { state.homeCancelled = true; await call('cancel_home_request'); });
bind('suggest-attach', attach);
bind('suggest-answers', () => state.current?.preSubmitSnapshot ? savedAnswers() : state.activeId ? (byId('activity-panel').open = true) : resume());
bind('suggest-control', () => !state.activeId ? openStart() : state.pausedByUser ? call('handback', { message: 'I finished in Chrome. Inspect the current page and continue.' }) : call('takeover'));
bind('refresh-btn', refresh);
bind('issue-dismiss', () => { if (state.issue) dismissedIssues.add(issueKey(state.issue)); byId('issue-banner').hidden = true; });
bind('file-close', closeFileBrowser);
bind('file-cancel', closeFileBrowser);
bind('file-select', selectFileBrowserFile);
bind('file-up', () => browseFileDirectory(fileBrowser?.parent));
bind('file-go', () => browseFileDirectory(byId('file-path').value));
bind('file-rax', () => browseFileDirectory(fileBrowser?.locations.rax));
bind('file-downloads', () => browseFileDirectory(fileBrowser?.locations.downloads));
bind('file-home', () => browseFileDirectory(fileBrowser?.locations.home));
byId('file-search').addEventListener('input', () => {
  renderFileBrowser();
  if (!fileBrowser || !(fileBrowser.truncated || fileBrowser.serverQuery || fileBrowser.loading)) return;
  clearTimeout(fileSearchTimer);
  fileSearchTimer = setTimeout(() => { if (fileBrowser) void browseFileDirectory(fileBrowser.directory, false, byId('file-search').value); }, 180);
});
byId('file-path').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void browseFileDirectory(byId('file-path').value); } });
byId('file-overlay').addEventListener('click', event => { if (event.target === byId('file-overlay')) void closeFileBrowser(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !byId('file-overlay').hidden) void closeFileBrowser(); });
bind('start-btn', start);
bind('resume-btn', resume);
bind('stop-btn', () => call('stop'));
bind('companion-stop', () => call('stop'));
bind('takeover-btn', () => call('takeover'));
bind('companion-takeover', () => call('takeover'));
bind('handback-btn', () => call('handback', { message: 'I finished in Chrome. Inspect the current page and continue.' }));
bind('companion-handback', () => call('handback', { message: 'I finished in Chrome. Inspect the current page and continue.' }));
bind('handoff-btn', finishHandoff);
bind('companion-done', finishHandoff);
bind('answers-btn', savedAnswers);
bind('attach-btn', attach);
bind('open-main-btn', () => window.rax.showMain());
bind('close-companion-btn', () => window.rax.showMain());
bind('approve-btn', () => answerApproval(true));
bind('deny-btn', () => answerApproval(false));
bind('close-answers-btn', () => { byId('answers-overlay').hidden = true; });
bind('save-profile-btn', async () => { await call('save_profile', { profile: byId('profile-text').value }); state.profileDirty = false; toast('Knowledge saved.'); });
bind('save-settings-btn', async () => { await call('save_settings', { model: byId('model-input').value.trim(), curatorModel: byId('curator-model-input').value.trim(), apiKey: byId('api-key-input').value.trim() }); byId('api-key-input').value = ''; toast('Muse settings saved.'); await refresh(); });
bind('sound-toggle', () => { try { localStorage.setItem('rax:sounds', soundsEnabled() ? 'off' : 'on'); } catch {} renderSoundControl(); });
bind('sound-preview', () => { void playSound('success', true); });
window.addEventListener('storage', event => { if (event.key === 'rax:sounds') renderSoundControl(); });
byId('profile-text').addEventListener('input', () => { state.profileDirty = true; });
byId('start-overlay').addEventListener('click', event => { if (event.target === byId('start-overlay')) byId('start-overlay').hidden = true; });
byId('start-url').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); byId('start-goal').focus(); } });
byId('start-goal').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void start().catch(() => {}); } });
byId('home-form').addEventListener('submit', event => { event.preventDefault(); void sendHomeRequest(); });
byId('home-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendHomeRequest(); }
});
byId('chat-form').addEventListener('submit', event => { event.preventDefault(); void sendChat(byId('chat-input').value); });
byId('companion-chat-form').addEventListener('submit', event => { event.preventDefault(); void sendChat(byId('companion-input').value); });
window.rax.onMessage(onMessage);
renderSoundControl();
void refresh().catch(() => {});
