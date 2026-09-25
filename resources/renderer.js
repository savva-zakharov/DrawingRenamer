const registerInput = document.getElementById('register');
const logEl = document.getElementById('log');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const summaryEl = document.getElementById('summary');
const watchingEl = document.getElementById('watching');
const renameBtn = document.getElementById('rename');
const hideEmptyCheckbox = document.getElementById('hide-empty');
const checkAllCheckbox = document.getElementById('check-all');

PDFJS.workerSrc = 'js/pdfjs/pdf.worker.js';

const state = {
  registerPDF: null,     // full path of the loaded register
  registerModified: null,
  targetDir: null,       // directory containing the register (and the drawings)
  tokenMap: {},          // drawing number => title
  rows: [],
  files: [],             // all files in targetDir
  match: null,           // result of matchFiles()
  addedTimes: {},        // when each file sharing a drawing number arrived in the folder
  choices: new Map(),    // drawing number => file the user picked to use
  unchecked: new Set(),  // files the user has deselected
  anchorFile: null,      // last ticked/unticked file, start of a Shift+click range
  knownFiles: null,      // files seen on the previous refresh, to highlight new arrivals
  watcherId: null,
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
// 4️⃣ Match files to register entries (exact token match, first register entry wins)
// --------------------
const SUPERSEDED_DIR = 'SS';

function newNameFor(token, tokenMap) {
  return `${token} - ${sanitizeFilename(tokenMap[token])}.pdf`;
}

function matchFiles(tokenMap, allFiles, registerBasename) {
  const tokens = Object.keys(tokenMap);
  const pdfs = allFiles
    .filter(f => f.toLowerCase().endsWith('.pdf') && f !== registerBasename)
    .sort((a, b) => a.localeCompare(b));

  const byToken = {};
  const unmatched = [];
  for (const file of pdfs) {
    const token = tokens.find(t => file.includes(t));
    if (!token) unmatched.push(file);
    else (byToken[token] = byToken[token] || []).push(file);
  }
  return { byToken, unmatched };
}

// When several files match one drawing, the user picks which to use.
// Default: the file most recently added to the folder (an unnamed file wins a tie).
function chosenFile(token, files, newName, addedTimes, choices) {
  const choice = choices.get(token);
  if (choice && files.includes(choice)) return choice;
  return files.slice().sort((a, b) =>
    (addedTimes[b] || 0) - (addedTimes[a] || 0) || (a === newName) - (b === newName)
  )[0];
}

function computeRows(tokenMap, match, allFiles, addedTimes, choices) {
  // Windows file names are case-insensitive, so compare lowercased
  const existing = new Set(allFiles.map(f => f.toLowerCase()));

  const rows = [];
  for (const token of Object.keys(tokenMap)) {
    const title = tokenMap[token];
    const files = match.byToken[token];
    if (!files) {
      rows.push({ token, title, file: null, newName: null, status: 'none' });
      continue;
    }
    const newName = newNameFor(token, tokenMap);
    const named = files.find(f => f === newName) || null;
    const group = files.length > 1;
    const chosen = group ? chosenFile(token, files, newName, addedTimes, choices) : files[0];

    // Newest first; kept stable so picking a different file doesn't reorder the rows
    const ordered = files.slice().sort((a, b) => (addedTimes[b] || 0) - (addedTimes[a] || 0) || a.localeCompare(b));
    ordered.forEach((file, i) => {
      const row = { token, title, file, newName, group, chosen: file === chosen, named, first: i === 0, last: i === ordered.length - 1 };
      if (file === chosen) {
        if (file === newName) {
          row.status = 'ok';
        } else if (!named && existing.has(newName.toLowerCase()) && file.toLowerCase() !== newName.toLowerCase()) {
          // Target name is taken by a file that doesn't match this drawing (e.g. different letter case)
          row.status = 'conflict';
          row.reason = 'A file with this name already exists';
        } else {
          row.status = named ? 'supersede' : 'rename';
        }
      } else if (file === named) {
        row.status = 'superseded';
      } else {
        row.status = 'skip';
      }
      rows.push(row);
    });
  }
  for (const file of match.unmatched) {
    rows.push({ token: null, title: null, file, newName: null, status: 'unmatched' });
  }
  return rows;
}

// --------------------
// Rendering
// --------------------
const STATUS_LABELS = {
  rename: 'Rename',
  supersede: 'Replace',
  superseded: 'To SS',
  ok: 'Named',
  skip: 'Not used',
  none: 'Missing',
  unmatched: 'Unmatched',
  conflict: 'Conflict'
};

const STATUS_TIPS = {
  supersede: `Will be renamed; the current file moves to ${SUPERSEDED_DIR}\\`,
  superseded: `Will be moved to ${SUPERSEDED_DIR}\\ when the replacement is renamed`,
  skip: 'Left as it is; pick it with the radio button to use it instead',
  none: 'No file in the folder matches this drawing number'
};

const ACTION_STATUSES = ['rename', 'supersede'];

function cell(tr, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text || '';
  tr.appendChild(td);
  return td;
}

function selectedRows() {
  return state.rows.filter(r => ACTION_STATUSES.includes(r.status) && !state.unchecked.has(r.file));
}

function updateRenameButton() {
  const n = selectedRows().length;
  renameBtn.textContent = n ? `RENAME (${n})` : 'RENAME';
  renameBtn.disabled = state.busy || n === 0;
  const renameable = state.rows.filter(r => ACTION_STATUSES.includes(r.status));
  checkAllCheckbox.checked = renameable.length > 0 && n === renameable.length;
  checkAllCheckbox.indeterminate = n > 0 && n < renameable.length;
}

// Files of the tickable rows currently shown, from one file to another inclusive (for Shift+click)
function rangeBetween(fromFile, toFile) {
  const files = state.rows
    .filter(r => ACTION_STATUSES.includes(r.status) && !(hideEmptyCheckbox.checked && r.status === 'none'))
    .map(r => r.file);
  const a = files.indexOf(fromFile);
  const b = files.indexOf(toFile);
  if (a < 0 || b < 0) return [toFile];
  return files.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function render(newFiles) {
  rowsEl.textContent = '';
  const hideEmpty = hideEmptyCheckbox.checked;

  for (const row of state.rows) {
    if (hideEmpty && row.status === 'none') continue;

    const tr = document.createElement('tr');
    if (row.status === 'none') tr.className = 'no-file';
    if (row.status === 'ok') tr.className = 'named';
    if (row.file && newFiles.has(row.file)) tr.classList.add('new');
    if (row.group) {
      tr.classList.add('group');
      if (row.first) tr.classList.add('group-first');
      if (row.last) tr.classList.add('group-last');
      if (!row.chosen) tr.classList.add('not-chosen');
    }

    const checkTd = cell(tr, '');
    if (ACTION_STATUSES.includes(row.status)) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.unchecked.has(row.file);
      cb.addEventListener('click', (e) => {
        const range = e.shiftKey && state.anchorFile ? rangeBetween(state.anchorFile, row.file) : [row.file];
        for (const file of range) {
          if (cb.checked) state.unchecked.delete(file);
          else state.unchecked.add(file);
        }
        state.anchorFile = row.file;
        if (range.length > 1) render(new Set());
        else updateRenameButton();
      });
      checkTd.appendChild(cb);
    }

    // Only label the drawing once per group
    const showDrawing = !row.group || row.first;
    cell(tr, showDrawing ? row.token : '', 'number');
    cell(tr, showDrawing ? row.title : '');

    const fileTd = cell(tr, row.group ? '' : (row.file || 'No matching file'), row.file ? 'file' : 'file missing');
    if (row.group) {
      const label = document.createElement('label');
      label.className = 'choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'choice-' + row.token;
      radio.checked = row.chosen;
      radio.title = 'Use this file for ' + row.token;
      radio.addEventListener('change', () => {
        state.choices.set(row.token, row.file);
        rebuild();
      });
      label.append(radio, document.createTextNode(row.file));
      fileTd.appendChild(label);
    }

    let target = row.newName;
    if (row.status === 'ok') target = '(already named)';
    else if (row.status === 'superseded') target = `${SUPERSEDED_DIR}\\${supersededName(row.file)}`;
    else if (row.status === 'skip') target = '';
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

  const count = s => state.rows.filter(r => r.status === s).length;
  const entries = Object.keys(state.tokenMap).length;
  const parts = [
    `${entries} register entries`,
    `${count('rename') + count('supersede')} to rename`,
    `${count('ok')} already named`,
    `${count('unmatched')} unmatched`
  ];
  if (count('none')) parts.push(`${count('none')} missing`);
  if (count('supersede')) parts.push(`${count('supersede')} replacing older files`);
  if (count('conflict')) parts.push(`${count('conflict')} conflicts`);
  summaryEl.textContent = parts.join(' · ');

  emptyEl.style.display = rowsEl.children.length ? 'none' : '';
  if (!rowsEl.children.length) {
    emptyEl.textContent = state.registerPDF ? 'No drawings found in this folder yet.' : 'Choose a register PDF or the folder containing it.';
  }
  updateRenameButton();
}

// --------------------
// Loading and live refresh
// --------------------
// When a file arrived in the folder. On Windows, Neutralino's getStats reports the creation
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

    const files = await listFiles(state.targetDir);
    const newFiles = new Set();
    if (state.knownFiles) {
      for (const f of files) {
        if (!state.knownFiles.has(f)) {
          newFiles.add(f);
          if (f.toLowerCase().endsWith('.pdf')) appendLog(`➕ New file: ${f}`);
        }
      }
    }
    state.knownFiles = new Set(files);

    state.files = files;
    state.match = matchFiles(state.tokenMap, files, baseName(state.registerPDF));
    // Arrival times are only needed to pick a default when several files match one drawing
    state.addedTimes = {};
    for (const group of Object.values(state.match.byToken)) {
      if (group.length < 2) continue;
      for (const f of group) {
        state.addedTimes[f] = addedTime(await getStatsOrNull(joinPath(state.targetDir, f)));
      }
    }
    rebuild(newFiles);
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
  if (state.watcherId !== null) {
    try {
      await Neutralino.filesystem.removeWatcher(state.watcherId);
    } catch (e) {
      // watcher already gone
    }
    state.watcherId = null;
  }
  watchingEl.textContent = '';
}

async function startWatching(dir) {
  try {
    state.watcherId = await Neutralino.filesystem.createWatcher(dir);
    watchingEl.textContent = '● Watching folder';
  } catch (err) {
    // Fall back to polling if the native watcher is unavailable
    state.pollTimer = setInterval(refresh, 3000);
    watchingEl.textContent = '● Checking folder every 3s';
  }
}

Neutralino.events.on('watchFile', (evt) => {
  if (evt.detail && evt.detail.id === state.watcherId) scheduleRefresh();
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
      knownFiles: null
    });
    state.unchecked.clear();
    state.choices.clear();
    state.anchorFile = null;
    appendLog(`📚 Parsing PDF register: ${registerPDF} ...`);
    summaryEl.textContent = 'Reading register...';
    await refresh();
    await startWatching(state.targetDir);
  } catch (err) {
    appendLog('❌ ' + (err.message || err));
  }
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

// Move a file into the SS (superseded) folder, prefixed with today's date,
// adding " (2)", " (3)"... if that name is taken there
async function supersede(file) {
  const ssDir = joinPath(state.targetDir, SUPERSEDED_DIR);
  const ssStats = await getStatsOrNull(ssDir);
  if (!ssStats) await Neutralino.filesystem.createDirectory(ssDir);
  else if (!ssStats.isDirectory) throw new Error(`"${SUPERSEDED_DIR}" exists but is not a folder`);

  const stem = supersededName(file).replace(/\.pdf$/i, '');
  const ext = file.slice(file.replace(/\.pdf$/i, '').length);
  let dest = stem + ext;
  for (let n = 2; await getStatsOrNull(joinPath(ssDir, dest)); n++) {
    dest = `${stem} (${n})${ext}`;
  }
  await Neutralino.filesystem.move(joinPath(state.targetDir, file), joinPath(ssDir, dest));
  appendLog(`📦 Moved ${file} → ${SUPERSEDED_DIR}\\${dest}`);
}

async function renameSelected() {
  const toRename = selectedRows();
  if (!toRename.length) return;

  state.busy = true;
  updateRenameButton();
  let renamed = 0;
  for (const row of toRename) {
    try {
      if (row.status === 'supersede') await supersede(row.named);
      await Neutralino.filesystem.move(joinPath(state.targetDir, row.file), joinPath(state.targetDir, row.newName));
      appendLog(`✅ Renamed ${row.file} → ${row.newName}`);
      renamed++;
      // Keep using the renamed file, so leftover older copies don't try to replace it
      if (row.group) state.choices.set(row.token, row.newName);
    } catch (err) {
      appendLog(`❌ Failed to rename ${row.file}: ${err.message || err}`);
    }
  }
  appendLog(`Renamed ${renamed} of ${toRename.length} files.`);
  state.busy = false;
  // Renamed files shouldn't be highlighted as new arrivals
  for (const row of toRename) state.knownFiles.add(row.newName);
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
  for (const row of state.rows) {
    if (!ACTION_STATUSES.includes(row.status)) continue;
    if (checkAllCheckbox.checked) state.unchecked.delete(row.file);
    else state.unchecked.add(row.file);
  }
  render(new Set());
});

// Stop Shift+click from selecting the table text between the two clicks
rowsEl.addEventListener('mousedown', (e) => {
  if (e.shiftKey) e.preventDefault();
});

renameBtn.addEventListener('click', renameSelected);

document.getElementById('clear-log').addEventListener('click', () => {
  logEl.textContent = '';
});
