const registerInput = document.getElementById('register');
const logEl = document.getElementById('log');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const summaryEl = document.getElementById('summary');
const watchingEl = document.getElementById('watching');
const renameBtn = document.getElementById('rename');
const folderBtn = document.getElementById('make-folder');
const hideEmptyCheckbox = document.getElementById('hide-empty');
const checkAllCheckbox = document.getElementById('check-all');

PDFJS.workerSrc = 'js/pdfjs/pdf.worker.js';

const SUPERSEDED_DIR = 'SS';
// Saved next to the register: which folder each drawing belongs in, for later runs
const LAYOUT_FILE = 'drawing-renamer.json';

// File paths inside targetDir are "relative paths" using '/', e.g. "Plans/PA-100 - Plan.pdf"
const state = {
  registerPDF: null,     // full path of the loaded register
  registerModified: null,
  targetDir: null,       // directory containing the register (the parent of any drawing folders)
  tokenMap: {},          // drawing number => title
  layout: { folders: [], assignments: {} }, // folder list and drawing number => folder
  layoutBroken: false,   // the layout file couldn't be read, so don't overwrite it
  rows: [],
  files: [],             // { dir, name, rel } for the top folder and every drawing folder
  match: null,           // result of matchFiles()
  addedTimes: {},        // rel => when a file sharing a drawing number arrived in its folder
  choices: new Map(),    // drawing number => rel of the file the user picked to use
  unchecked: new Set(),  // keys of rows the user deselected (rows needing a rename start selected)
  picked: new Set(),     // keys of rows the user selected
  anchorKey: null,       // last ticked/unticked row, start of a Shift+click range
  displayKeys: [],       // keys of the selectable rows in the order shown
  knownFiles: null,      // rels seen on the previous refresh, to highlight new arrivals
  watchers: new Map(),   // rel dir => watcher id
  pollTimer: null,
  busy: false
};

function appendLog(text) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

Neutralino.init();

Neutralino.events.on('windowClose', () => Neutralino.app.exit());

// --------------------
// Path helpers
// --------------------
function joinPath(dir, name) {
  return dir.replace(/[\\/]+$/, '') + '/' + name;
}

function dirName(filePath) {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

function baseName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

async function getStatsOrNull(p) {
  try {
    return await Neutralino.filesystem.getStats(p);
  } catch (e) {
    return null;
  }
}

async function listFiles(dir) {
  const entries = await Neutralino.filesystem.readDirectory(dir);
  return entries.filter(e => e.type === 'FILE').map(e => e.entry);
}

// --------------------
// 1️⃣ Find register PDF
// --------------------
async function findRegisterPDF(dir) {
  const files = await listFiles(dir);
  const found = files.find(f => f.toLowerCase().includes('register') && f.toLowerCase().endsWith('.pdf'));
  return found ? joinPath(dir, found) : null;
}

async function resolveRegisterPath(input) {
  const stats = await getStatsOrNull(input);
  if (!stats) throw new Error('Provided register path does not exist.');
  if (stats.isFile) {
    if (!input.toLowerCase().endsWith('.pdf')) throw new Error('Provided file is not a PDF.');
    return input;
  }
  if (stats.isDirectory) {
    const found = await findRegisterPDF(input);
    if (!found) throw new Error('No register PDF found in that directory.');
    return found;
  }
  throw new Error('Unsupported path type.');
}

// --------------------
// 2️⃣ Extract text (same algorithm as pdf-parse, so results match the CLI)
// --------------------
async function extractPdfText(buffer) {
  const doc = await PDFJS.getDocument({ data: new Uint8Array(buffer) });
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    let pageText = '';
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY;
      for (const item of content.items) {
        if (lastY == item.transform[5] || !lastY) pageText += item.str;
        else pageText += '\n' + item.str;
        lastY = item.transform[5];
      }
    } catch (e) {
      pageText = '';
    }
    text = `${text}\n\n${pageText}`;
  }
  doc.destroy();
  return text;
}

// --------------------
// 3️⃣ Parse register PDF into token map
// --------------------
async function parseRegisterPDF(filePath) {
  const buffer = await Neutralino.filesystem.readBinaryFile(filePath);
  const text = (await extractPdfText(buffer)).replace(/\r?\n/g, ' ');

  const map = {};
  // (1) Drawing number: [A-Z]+(?:-[A-Z0-9]+)*-\d+
  // (2) Title: non-greedy match up to first scale 1:\d+
  const entryRegex = /([A-Z]+(?:-[A-Z0-9]+)*-\d+)\s+(.+?)\s+1:\d+/gi;
  let match;
  while ((match = entryRegex.exec(text)) !== null) {
    const drawingNumber = match[1].toUpperCase();
    map[drawingNumber] = match[2].trim().replace(/\s+/g, ' ');
  }
  return map;
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '-');
}

// --------------------
// Relative paths inside targetDir
// --------------------
function relJoin(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function absPath(rel) {
  return rel ? joinPath(state.targetDir, rel) : state.targetDir;
}

function displayPath(rel) {
  return rel.replace(/\//g, '\\');
}

async function ensureDir(rel) {
  let current = '';
  for (const part of rel.split('/').filter(Boolean)) {
    current = relJoin(current, part);
    const stats = await getStatsOrNull(absPath(current));
    if (!stats) await Neutralino.filesystem.createDirectory(absPath(current));
    else if (!stats.isDirectory) throw new Error(`"${displayPath(current)}" exists but is not a folder`);
  }
}

// Files in the top folder plus every drawing folder in the layout
async function scanFiles() {
  const files = [];
  for (const dir of ['', ...state.layout.folders]) {
    let names;
    try {
      names = await listFiles(absPath(dir));
    } catch (e) {
      continue; // folder not created yet
    }
    for (const name of names) files.push({ dir, name, rel: relJoin(dir, name) });
  }
  return files;
}

// --------------------
// Folder layout file
// --------------------
function layoutPath() {
  return joinPath(state.targetDir, LAYOUT_FILE);
}

async function loadLayout() {
  state.layout = { folders: [], assignments: {} };
  state.layoutBroken = false;
  if (!(await getStatsOrNull(layoutPath()))) return;
  try {
    const data = JSON.parse(await Neutralino.filesystem.readFile(layoutPath()));
    const folders = Array.isArray(data.folders) ? data.folders.filter(f => typeof f === 'string') : [];
    const assignments = {};
    for (const [token, folder] of Object.entries(data.assignments || {})) {
      if (typeof folder !== 'string' || !folder) continue;
      assignments[token] = folder;
      if (!folders.includes(folder)) folders.push(folder);
    }
    state.layout = { folders, assignments };
    appendLog(`📁 Loaded folder layout from ${LAYOUT_FILE} (${folders.length} folders).`);
  } catch (err) {
    state.layoutBroken = true;
    appendLog(`⚠️ Could not read ${LAYOUT_FILE}; folder changes won't be saved until it's fixed: ${err.message || err}`);
  }
}

async function saveLayout() {
  if (state.layoutBroken) {
    appendLog(`⚠️ Not saving folders: ${LAYOUT_FILE} could not be read when the register was loaded.`);
    return;
  }
  // Keep assignments in register order so the file is easy to read
  const assignments = {};
  for (const token of Object.keys(state.tokenMap)) {
    if (state.layout.assignments[token]) assignments[token] = state.layout.assignments[token];
  }
  for (const [token, folder] of Object.entries(state.layout.assignments)) {
    if (!(token in assignments)) assignments[token] = folder; // drawings no longer in the register
  }
  const data = {
    version: 1,
    register: baseName(state.registerPDF),
    folders: state.layout.folders,
    assignments
  };
  try {
    await Neutralino.filesystem.writeFile(layoutPath(), JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    appendLog(`❌ Could not save ${LAYOUT_FILE}: ${err.message || err}`);
  }
}

function folderOf(token) {
  return state.layout.assignments[token] || '';
}

// Returns the normalised folder path ("Plans/Level 1"), or throws with a reason
function validateFolderName(input) {
  const parts = input.split(/[\\/]+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter a folder name.');
  for (const part of parts) {
    if (/[:*?"<>|]/.test(part)) throw new Error('Folder names can\'t contain : * ? " < > |');
    if (part === '.' || part === '..' || /[. ]$/.test(part)) throw new Error('Folder names can\'t end with a dot or space.');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(part)) throw new Error(`"${part}" is reserved by Windows.`);
    if (part.toLowerCase() === SUPERSEDED_DIR.toLowerCase()) throw new Error(`"${SUPERSEDED_DIR}" is used for superseded drawings.`);
  }
  return parts.join('/');
}

// --------------------
// 4️⃣ Match files to register entries (exact token match, first register entry wins)
// --------------------
function newNameFor(token, tokenMap) {
  return `${token} - ${sanitizeFilename(tokenMap[token])}.pdf`;
}

function matchFiles(tokenMap, files, registerRel) {
  const tokens = Object.keys(tokenMap);
  const pdfs = files
    .filter(f => f.name.toLowerCase().endsWith('.pdf') && f.rel !== registerRel)
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const byToken = {};
  const unmatched = [];
  for (const file of pdfs) {
    const token = tokens.find(t => file.name.includes(t));
    if (!token) unmatched.push(file);
    else (byToken[token] = byToken[token] || []).push(file);
  }
  return { byToken, unmatched };
}

// When several files match one drawing, the user picks which to use.
// Default: the file most recently added to its folder (a file already in place wins a tie).
function chosenFile(token, files, targetRel, addedTimes, choices) {
  const choice = choices.get(token);
  const picked = choice && files.find(f => f.rel === choice);
  if (picked) return picked;
  return files.slice().sort((a, b) =>
    (addedTimes[b.rel] || 0) - (addedTimes[a.rel] || 0) || (a.rel === targetRel) - (b.rel === targetRel)
  )[0];
}

function computeRows(tokenMap, match, files, addedTimes, choices) {
  // Windows file names are case-insensitive, so compare lowercased
  const existing = new Set(files.map(f => f.rel.toLowerCase()));

  const rows = [];
  for (const token of Object.keys(tokenMap)) {
    const title = tokenMap[token];
    const folder = folderOf(token);
    const matches = match.byToken[token];
    if (!matches) {
      rows.push({ key: '#' + token, token, title, folder, status: 'none' });
      continue;
    }
    const newName = newNameFor(token, tokenMap);
    const targetRel = relJoin(folder, newName);
    // The file already sitting at the target path, if any
    const occupant = matches.find(f => f.rel === targetRel) ||
      matches.find(f => f.rel.toLowerCase() === targetRel.toLowerCase()) || null;
    const group = matches.length > 1;
    const chosen = group ? chosenFile(token, matches, targetRel, addedTimes, choices) : matches[0];

    // Newest first; kept stable so picking a different file doesn't reorder the rows
    const ordered = matches.slice().sort((a, b) => (addedTimes[b.rel] || 0) - (addedTimes[a.rel] || 0) || a.rel.localeCompare(b.rel));
    ordered.forEach((f, i) => {
      const row = {
        key: f.rel, token, title, folder, file: f.name, dir: f.dir, rel: f.rel, newName, targetRel,
        group, chosen: f === chosen, first: i === 0, last: i === ordered.length - 1
      };
      if (f === chosen) {
        if (f.rel === targetRel) {
          row.status = 'ok';
        } else if (!occupant && existing.has(targetRel.toLowerCase())) {
          // Target path is taken by a file that doesn't match this drawing
          row.status = 'conflict';
          row.reason = 'A file with this name already exists';
        } else if (occupant && occupant !== f) {
          row.status = 'supersede';
          row.occupant = occupant;
        } else {
          row.status = f.name === newName ? 'move' : 'rename';
        }
      } else if (f === occupant) {
        row.status = 'superseded';
      } else {
        row.status = 'skip';
      }
      rows.push(row);
    });
  }
  for (const f of match.unmatched) {
    rows.push({ key: f.rel, token: null, title: null, folder: null, file: f.name, dir: f.dir, rel: f.rel, status: 'unmatched' });
  }
  return rows;
}

// --------------------
// Selection
// --------------------
const ACTION_STATUSES = ['rename', 'supersede', 'move'];

// One checkbox per drawing: on the file being used, or on the register entry if there's no file
function isSelectable(row) {
  return !!row.token && (!row.group || row.chosen);
}

function isSelected(row) {
  if (!isSelectable(row)) return false;
  return ACTION_STATUSES.includes(row.status) ? !state.unchecked.has(row.key) : state.picked.has(row.key);
}

function setSelected(key, on) {
  if (on) {
    state.unchecked.delete(key);
    state.picked.add(key);
  } else {
    state.unchecked.add(key);
    state.picked.delete(key);
  }
}

function selectedRows() {
  return state.rows.filter(isSelected);
}

function renameRows() {
  return selectedRows().filter(r => ACTION_STATUSES.includes(r.status));
}

function visibleRows() {
  return state.rows.filter(r => !(hideEmptyCheckbox.checked && r.status === 'none'));
}

function updateButtons() {
  const n = renameRows().length;
  renameBtn.textContent = n ? `RENAME (${n})` : 'RENAME';
  renameBtn.disabled = state.busy || n === 0;

  const selected = selectedRows().length;
  folderBtn.textContent = selected ? `MAKE FOLDER (${selected})` : 'MAKE FOLDER';
  folderBtn.disabled = state.busy || selected === 0;

  const selectable = visibleRows().filter(isSelectable);
  const on = selectable.filter(isSelected).length;
  checkAllCheckbox.checked = selectable.length > 0 && on === selectable.length;
  checkAllCheckbox.indeterminate = on > 0 && on < selectable.length;
}

// Keys of the selectable rows shown, from one row to another inclusive (for Shift+click)
function rangeBetween(fromKey, toKey) {
  const keys = state.displayKeys;
  const a = keys.indexOf(fromKey);
  const b = keys.indexOf(toKey);
  if (a < 0 || b < 0) return [toKey];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// --------------------
// Rendering
// --------------------
const STATUS_LABELS = {
  rename: 'Rename',
  move: 'Move',
  supersede: 'Replace',
  superseded: 'To SS',
  ok: 'Named',
  skip: 'Not used',
  none: 'Missing',
  unmatched: 'Unmatched',
  conflict: 'Conflict'
};

const STATUS_TIPS = {
  move: 'Already named; will be moved into its folder',
  supersede: `Will be renamed; the current file moves to ${SUPERSEDED_DIR}\\`,
  superseded: `Will be moved to ${SUPERSEDED_DIR}\\ when the replacement is renamed`,
  skip: 'Left as it is; pick it with the radio button to use it instead',
  none: 'No file matches this drawing number'
};

function cell(tr, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text || '';
  tr.appendChild(td);
  return td;
}

function makeCheckbox(checked, onClick) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('click', onClick);
  return cb;
}

// Rows split into the top folder, each drawing folder, then files matching nothing
function sections(rows) {
  const top = { folder: '', rows: [] };
  const byFolder = new Map(state.layout.folders.slice().sort((a, b) => a.localeCompare(b)).map(f => [f, { folder: f, rows: [] }]));
  const unmatched = { unmatched: true, rows: [] };
  for (const row of rows) {
    if (row.status === 'unmatched') unmatched.rows.push(row);
    else (byFolder.get(row.folder) || top).rows.push(row);
  }
  return [top, ...byFolder.values(), unmatched];
}

function renderSectionHeader(section, visible) {
  const tr = document.createElement('tr');
  tr.className = 'section';
  const selectable = visible.filter(isSelectable);

  const checkTd = cell(tr, '');
  if (selectable.length) {
    const allOn = selectable.every(isSelected);
    const cb = makeCheckbox(allOn, () => {
      for (const row of selectable) setSelected(row.key, cb.checked);
      render(new Set());
    });
    cb.indeterminate = !allOn && selectable.some(isSelected);
    cb.title = 'Select every drawing in this folder';
    checkTd.appendChild(cb);
  }

  const td = cell(tr, '');
  td.colSpan = 5;
  const name = document.createElement('span');
  name.className = 'section-name';
  if (section.unmatched) name.textContent = 'Files not in the register';
  else if (section.folder) name.textContent = '📁 ' + displayPath(section.folder);
  else name.textContent = `📂 ${baseName(state.targetDir)} (top folder)`;
  td.appendChild(name);

  if (!section.unmatched) {
    const drawings = new Set(section.rows.map(r => r.token)).size;
    const count = document.createElement('span');
    count.className = 'muted section-count';
    count.textContent = drawings === 1 ? '1 drawing' : `${drawings} drawings`;
    td.appendChild(count);
  }

  // A folder can be dropped from the layout once nothing is assigned to it or stored in it
  if (section.folder && !section.rows.length && !state.files.some(f => f.dir === section.folder)) {
    const btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = 'Remove folder';
    btn.addEventListener('click', async () => {
      state.layout.folders = state.layout.folders.filter(f => f !== section.folder);
      await saveLayout();
      appendLog(`📁 Removed empty folder ${displayPath(section.folder)} from the layout.`);
      rebuild();
    });
    td.appendChild(btn);
  }
  rowsEl.appendChild(tr);
}

function renderRow(row, newFiles, alt) {
  const tr = document.createElement('tr');
  if (row.status === 'none') tr.className = 'no-file';
  if (row.status === 'ok') tr.className = 'named';
  if (alt) tr.classList.add('alt');
  if (row.rel && newFiles.has(row.rel)) tr.classList.add('new');
  if (row.group) {
    tr.classList.add('group');
    if (row.first) tr.classList.add('group-first');
    if (row.last) tr.classList.add('group-last');
    if (!row.chosen) tr.classList.add('not-chosen');
  }

  const checkTd = cell(tr, '');
  if (isSelectable(row)) {
    const cb = makeCheckbox(isSelected(row), (e) => {
      const range = e.shiftKey && state.anchorKey ? rangeBetween(state.anchorKey, row.key) : [row.key];
      for (const key of range) setSelected(key, cb.checked);
      state.anchorKey = row.key;
      if (range.length > 1) render(new Set());
      else updateButtons();
    });
    checkTd.appendChild(cb);
  }

  // Only label the drawing once per group
  const showDrawing = !row.group || row.first;
  cell(tr, showDrawing ? row.token : '', 'number');
  cell(tr, showDrawing ? row.title : '');

  const current = row.rel ? displayPath(row.rel) : 'No matching file';
  const fileTd = cell(tr, row.group ? '' : current, row.rel ? 'file' : 'file missing');
  if (row.group) {
    const label = document.createElement('label');
    label.className = 'choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'choice-' + row.token;
    radio.checked = row.chosen;
    radio.title = 'Use this file for ' + row.token;
    radio.addEventListener('change', () => {
      state.choices.set(row.token, row.rel);
      rebuild();
    });
    label.append(radio, document.createTextNode(current));
    fileTd.appendChild(label);
  }

  let target = row.targetRel ? displayPath(row.targetRel) : '';
  if (row.status === 'ok') target = '(already named)';
  else if (row.status === 'superseded') target = displayPath(relJoin(relJoin(row.dir, SUPERSEDED_DIR), supersededName(row.file)));
  else if (row.status === 'skip' || row.status === 'none') target = '';
  cell(tr, target);

  const statusTd = cell(tr, '');
  const badge = document.createElement('span');
  badge.className = 'status ' + row.status;
  badge.textContent = STATUS_LABELS[row.status];
  const tip = row.reason || STATUS_TIPS[row.status];
  if (tip) badge.title = tip;
  statusTd.appendChild(badge);

  rowsEl.appendChild(tr);
}

function render(newFiles) {
  rowsEl.textContent = '';
  const showHeaders = state.layout.folders.length > 0;
  state.displayKeys = [];
  let dataRows = 0;

  for (const section of sections(state.rows)) {
    const visible = section.rows.filter(r => !(hideEmptyCheckbox.checked && r.status === 'none'));
    // Once folders exist, every folder gets a header (even when empty); the unmatched list only when it has rows
    const header = showHeaders && (!section.unmatched || visible.length);
    if (header) renderSectionHeader(section, visible);
    for (const row of visible) {
      if (isSelectable(row)) state.displayKeys.push(row.key);
      renderRow(row, newFiles, dataRows % 2 === 1);
      dataRows++;
    }
  }

  const count = s => state.rows.filter(r => r.status === s).length;
  const entries = Object.keys(state.tokenMap).length;
  const parts = [
    `${entries} register entries`,
    `${count('rename') + count('supersede')} to rename`,
    `${count('ok')} already named`,
    `${count('unmatched')} unmatched`
  ];
  if (count('move')) parts.push(`${count('move')} to move`);
  if (count('none')) parts.push(`${count('none')} missing`);
  if (count('supersede')) parts.push(`${count('supersede')} replacing older files`);
  if (count('conflict')) parts.push(`${count('conflict')} conflicts`);
  summaryEl.textContent = parts.join(' · ');

  emptyEl.style.display = dataRows ? 'none' : '';
  if (!dataRows) {
    emptyEl.textContent = state.registerPDF ? 'No drawings found in this folder yet.' : 'Choose a register PDF or the folder containing it.';
  }
  updateButtons();
}

// --------------------
// Loading and live refresh
// --------------------
// When a file arrived in its folder. On Windows, Neutralino's getStats reports the creation
// time (as both createdAt and modifiedAt), which Windows sets when a file is copied or saved
// into a folder and keeps through renames.
function addedTime(stats) {
  return stats ? (stats.createdAt || stats.modifiedAt || 0) : 0;
}

// Size is included because an in-place overwrite may not change the reported timestamp
function registerStamp(stats) {
  return `${stats.modifiedAt}:${stats.size}`;
}

function rebuild(newFiles = new Set()) {
  if (!state.match) return;
  state.rows = computeRows(state.tokenMap, state.match, state.files, state.addedTimes, state.choices);
  render(newFiles);
}

let refreshRunning = false;
let refreshQueued = false;
let refreshTimer = null;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

async function refresh() {
  if (!state.targetDir || state.busy) return;
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  try {
    // Re-parse the register if it has been replaced or edited
    const regStats = await getStatsOrNull(state.registerPDF);
    if (!regStats) {
      appendLog(`⚠️ Register PDF is no longer in the folder: ${baseName(state.registerPDF)}`);
    } else if (registerStamp(regStats) !== state.registerModified) {
      if (state.registerModified !== null) appendLog('📚 Register changed, re-reading it...');
      state.tokenMap = await parseRegisterPDF(state.registerPDF);
      state.registerModified = registerStamp(regStats);
      appendLog(`📘 Loaded ${Object.keys(state.tokenMap).length} drawing entries from register.`);
    }

    const files = await scanFiles();
    const newFiles = new Set();
    if (state.knownFiles) {
      for (const f of files) {
        if (!state.knownFiles.has(f.rel)) {
          newFiles.add(f.rel);
          if (f.name.toLowerCase().endsWith('.pdf')) appendLog(`➕ New file: ${displayPath(f.rel)}`);
        }
      }
    }
    state.knownFiles = new Set(files.map(f => f.rel));

    state.files = files;
    state.match = matchFiles(state.tokenMap, files, baseName(state.registerPDF));
    // Arrival times are only needed to pick a default when several files match one drawing
    state.addedTimes = {};
    for (const group of Object.values(state.match.byToken)) {
      if (group.length < 2) continue;
      for (const f of group) {
        state.addedTimes[f.rel] = addedTime(await getStatsOrNull(absPath(f.rel)));
      }
    }
    rebuild(newFiles);
    await syncWatchers();
  } catch (err) {
    appendLog('❌ Could not refresh folder: ' + (err.message || err));
  } finally {
    refreshRunning = false;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

async function stopWatching() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  for (const id of state.watchers.values()) {
    try {
      await Neutralino.filesystem.removeWatcher(id);
    } catch (e) {
      // watcher already gone
    }
  }
  state.watchers.clear();
  watchingEl.textContent = '';
}

// Watch the top folder and every drawing folder that exists
async function syncWatchers() {
  if (state.pollTimer) return;
  const wanted = [];
  for (const dir of ['', ...state.layout.folders]) {
    const stats = await getStatsOrNull(absPath(dir));
    if (stats && stats.isDirectory) wanted.push(dir);
  }
  for (const [dir, id] of state.watchers) {
    if (wanted.includes(dir)) continue;
    try {
      await Neutralino.filesystem.removeWatcher(id);
    } catch (e) {
      // watcher already gone
    }
    state.watchers.delete(dir);
  }
  for (const dir of wanted) {
    if (state.watchers.has(dir)) continue;
    try {
      state.watchers.set(dir, await Neutralino.filesystem.createWatcher(absPath(dir)));
    } catch (err) {
      // Fall back to polling if the native watcher is unavailable
      state.pollTimer = setInterval(refresh, 3000);
      watchingEl.textContent = '● Checking folders every 3s';
      return;
    }
  }
  watchingEl.textContent = state.watchers.size > 1 ? `● Watching ${state.watchers.size} folders` : '● Watching folder';
}

Neutralino.events.on('watchFile', (evt) => {
  if (evt.detail && [...state.watchers.values()].includes(evt.detail.id)) scheduleRefresh();
});

async function load() {
  const input = registerInput.value.trim();
  if (!input) {
    appendLog('❌ Choose a register PDF or the folder containing it first.');
    return;
  }
  try {
    const registerPDF = await resolveRegisterPath(input);
    await stopWatching();
    Object.assign(state, {
      registerPDF,
      registerModified: null,
      targetDir: dirName(registerPDF),
      tokenMap: {},
      rows: [],
      files: [],
      match: null,
      addedTimes: {},
      knownFiles: null,
      anchorKey: null
    });
    state.unchecked.clear();
    state.picked.clear();
    state.choices.clear();
    await loadLayout();
    appendLog(`📚 Parsing PDF register: ${registerPDF} ...`);
    summaryEl.textContent = 'Reading register...';
    await refresh();
  } catch (err) {
    appendLog('❌ ' + (err.message || err));
  }
}

// --------------------
// Folder dialog
// --------------------
const folderDialog = document.getElementById('folder-dialog');
const folderNameInput = document.getElementById('folder-name');
const folderError = document.getElementById('folder-error');

// Resolves to { action: 'ok', folder } | { action: 'remove' } | { action: 'cancel' }
function askForFolder(count, current) {
  document.getElementById('folder-dialog-title').textContent =
    count === 1 ? 'Put 1 drawing in folder' : `Put ${count} drawings in folder`;
  const list = document.getElementById('folder-list');
  list.textContent = '';
  for (const f of state.layout.folders) {
    const opt = document.createElement('option');
    opt.value = displayPath(f);
    list.appendChild(opt);
  }
  folderNameInput.value = current ? displayPath(current) : '';
  folderError.textContent = '';
  folderDialog.showModal();
  folderNameInput.select();

  return new Promise(resolve => {
    const form = folderDialog.querySelector('form');
    const finish = (result) => {
      form.removeEventListener('submit', onSubmit);
      folderDialog.removeEventListener('cancel', onCancel);
      folderDialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const action = e.submitter ? e.submitter.value : 'ok'; // Enter in the text box means OK
      if (action !== 'ok') return finish({ action });
      try {
        finish({ action: 'ok', folder: validateFolderName(folderNameInput.value) });
      } catch (err) {
        folderError.textContent = err.message;
        folderNameInput.focus();
      }
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish({ action: 'cancel' });
    };
    form.addEventListener('submit', onSubmit);
    folderDialog.addEventListener('cancel', onCancel);
  });
}

async function makeFolder() {
  const rows = selectedRows();
  if (!rows.length) return;
  const tokens = [...new Set(rows.map(r => r.token))];
  const folders = new Set(tokens.map(folderOf));
  const current = folders.size === 1 ? [...folders][0] : '';

  const result = await askForFolder(tokens.length, current);
  if (result.action === 'cancel') return;

  if (result.action === 'remove') {
    for (const token of tokens) delete state.layout.assignments[token];
    appendLog(`📁 ${tokens.length} drawing(s) will go back to the top folder when you press RENAME.`);
  } else {
    const folder = state.layout.folders.find(f => f.toLowerCase() === result.folder.toLowerCase()) || result.folder;
    if (!state.layout.folders.includes(folder)) state.layout.folders.push(folder);
    for (const token of tokens) state.layout.assignments[token] = folder;
    appendLog(`📁 ${tokens.length} drawing(s) assigned to ${displayPath(folder)}; files move there when you press RENAME.`);
  }
  await saveLayout();
  // New folders may already hold files (e.g. layout edited by hand), so rescan
  await refresh();
}

// --------------------
// 5️⃣ Rename selected files
// --------------------

// Today's date as YY-MM-DD, matching the register's file naming
function datePrefix(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getFullYear() % 100)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function supersededName(file) {
  return `${datePrefix()} ${file}`;
}

// Move a file into the SS (superseded) folder next to it, prefixed with today's date,
// adding " (2)", " (3)"... if that name is taken there
async function supersede(file) {
  const ssRel = relJoin(file.dir, SUPERSEDED_DIR);
  await ensureDir(ssRel);

  const stem = supersededName(file.name).replace(/\.pdf$/i, '');
  const ext = file.name.slice(file.name.replace(/\.pdf$/i, '').length);
  let dest = stem + ext;
  for (let n = 2; await getStatsOrNull(absPath(relJoin(ssRel, dest))); n++) {
    dest = `${stem} (${n})${ext}`;
  }
  await Neutralino.filesystem.move(absPath(file.rel), absPath(relJoin(ssRel, dest)));
  appendLog(`📦 Moved ${displayPath(file.rel)} → ${displayPath(relJoin(ssRel, dest))}`);
}

async function renameSelected() {
  const toRename = renameRows();
  if (!toRename.length) return;

  state.busy = true;
  updateButtons();
  let renamed = 0;
  for (const row of toRename) {
    try {
      if (row.folder) await ensureDir(row.folder);
      if (row.status === 'supersede') await supersede(row.occupant);
      await Neutralino.filesystem.move(absPath(row.rel), absPath(row.targetRel));
      const verb = row.status === 'move' ? '📁 Moved' : '✅ Renamed';
      appendLog(`${verb} ${displayPath(row.rel)} → ${displayPath(row.targetRel)}`);
      renamed++;
      // Keep using the renamed file, so leftover older copies don't try to replace it
      if (row.group) state.choices.set(row.token, row.targetRel);
      // Renamed files shouldn't be highlighted as new arrivals
      state.knownFiles.add(row.targetRel);
    } catch (err) {
      appendLog(`❌ Failed to rename ${displayPath(row.rel)}: ${err.message || err}`);
    }
  }
  appendLog(`Renamed ${renamed} of ${toRename.length} files.`);
  state.busy = false;
  await refresh();
}

// --------------------
// UI wiring
// --------------------
document.getElementById('choose').addEventListener('click', async () => {
  try {
    const folder = await Neutralino.os.showFolderDialog('Select folder containing the register PDF');
    if (folder) {
      registerInput.value = folder;
      load();
    }
  } catch (err) {
    appendLog('Could not open folder dialog: ' + (err.message || err));
  }
});

document.getElementById('choose-file').addEventListener('click', async () => {
  try {
    const files = await Neutralino.os.showOpenDialog('Select register PDF', {
      filters: [{ name: 'PDF files', extensions: ['pdf'] }]
    });
    if (files && files.length) {
      registerInput.value = files[0];
      load();
    }
  } catch (err) {
    appendLog('Could not open file dialog: ' + (err.message || err));
  }
});

document.getElementById('load').addEventListener('click', load);
registerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') load();
});

hideEmptyCheckbox.addEventListener('change', () => render(new Set()));

checkAllCheckbox.addEventListener('change', () => {
  for (const row of visibleRows()) {
    if (isSelectable(row)) setSelected(row.key, checkAllCheckbox.checked);
  }
  render(new Set());
});

// Stop Shift+click from selecting the table text between the two clicks
rowsEl.addEventListener('mousedown', (e) => {
  if (e.shiftKey) e.preventDefault();
});

folderBtn.addEventListener('click', makeFolder);
renameBtn.addEventListener('click', renameSelected);

document.getElementById('clear-log').addEventListener('click', () => {
  logEl.textContent = '';
});
