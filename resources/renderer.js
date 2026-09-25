const registerInput = document.getElementById('register');
const logEl = document.getElementById('log');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const summaryEl = document.getElementById('summary');
const watchingEl = document.getElementById('watching');
const renameBtn = document.getElementById('rename');
const folderBtn = document.getElementById('make-folder');
const wordBtn = document.getElementById('save-word');
const hideEmptyCheckbox = document.getElementById('hide-empty');
const checkAllCheckbox = document.getElementById('check-all');

PDFJS.workerSrc = 'js/pdfjs/pdf.worker.js';

const SUPERSEDED_DIR = 'SS';
// Saved next to the register: which folder each drawing belongs in, for later runs
const LAYOUT_FILE = 'drawing-renamer.json';

// File paths inside targetDir are "relative paths" using '/', e.g. "Plans/PA-100 - Plan.pdf"
const state = {
  registerPath: null,    // full path of the loaded register (.docx or .pdf)
  registerKind: null,    // 'docx' or 'pdf'
  registerModified: null,
  targetDir: null,       // directory containing the register (the parent of any drawing folders)
  tokenMap: {},          // drawing number => title, as in the register
  titles: {},            // drawing number => title used for renaming (register title or an edit)
  layout: { folders: [], assignments: {}, titleEdits: {} }, // folders, drawing number => folder, title edits not yet in Word
  editingToken: null,    // drawing whose title is being edited in the table
  wordAvailable: null,   // whether Word can be driven to export PDFs (checked on first use)
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
// 1️⃣ Find register (Word preferred over PDF)
// --------------------
function registerKindOf(name) {
  const lower = name.toLowerCase();
  if (lower.startsWith('~$')) return null; // Word's lock file for an open document
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

// Files named "...register..." in dir; a Word register beats a PDF one, and the last by name
// (registers are usually date-prefixed, so that's the latest) beats earlier ones
async function findRegister(dir) {
  const candidates = (await listFiles(dir))
    .filter(f => f.toLowerCase().includes('register') && registerKindOf(f))
    .sort((a, b) => a.localeCompare(b));
  const found = candidates.filter(f => registerKindOf(f) === 'docx').pop() || candidates.pop();
  return found ? joinPath(dir, found) : null;
}

async function resolveRegisterPath(input) {
  const stats = await getStatsOrNull(input);
  if (!stats) throw new Error('Provided register path does not exist.');
  if (stats.isFile) {
    if (!registerKindOf(baseName(input))) throw new Error('Provided file is not a Word (.docx) or PDF register.');
    return input;
  }
  if (stats.isDirectory) {
    const found = await findRegister(input);
    if (!found) throw new Error('No register (.docx or .pdf with "register" in its name) found in that directory.');
    return found;
  }
  throw new Error('Unsupported path type.');
}

// The PDF next to a Word register with the same name (usually exported from it)
function registerPdfPath() {
  return state.registerPath.replace(/\.[^./\\]+$/, '') + '.pdf';
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
// 3️⃣ Parse register into token map
// --------------------
async function readDocumentXml(docxPath) {
  const zip = await JSZip.loadAsync(await Neutralino.filesystem.readBinaryFile(docxPath));
  const part = zip.file('word/document.xml');
  if (!part) throw new Error(`${baseName(docxPath)} doesn't look like a Word document.`);
  return { zip, xml: await part.async('string') };
}

async function parseRegister(filePath) {
  if (registerKindOf(baseName(filePath)) === 'docx') {
    return RegisterCore.readDocxTitles((await readDocumentXml(filePath)).xml);
  }
  const buffer = await Neutralino.filesystem.readBinaryFile(filePath);
  return RegisterCore.parsePdfText(await extractPdfText(buffer));
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
  state.layout = { folders: [], assignments: {}, titleEdits: {} };
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
    const titleEdits = {};
    for (const [token, title] of Object.entries(data.titleEdits || {})) {
      if (typeof title === 'string' && title.trim()) titleEdits[token] = title;
    }
    state.layout = { folders: withAncestors(folders), assignments, titleEdits };
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
    register: baseName(state.registerPath),
    folders: state.layout.folders,
    assignments,
    // Title changes made in the app that haven't been saved into the Word register yet
    titleEdits: state.layout.titleEdits
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

// --------------------
// Nested folders ("Plans/Houses/House 1")
// --------------------
function folderDepth(folder) {
  return folder ? folder.split('/').length : 0;
}

function folderLeaf(folder) {
  return folder.split('/').pop();
}

function isInside(folder, ancestor) {
  return folder === ancestor || folder.startsWith(ancestor + '/');
}

// Tree order: parents before their subfolders, siblings alphabetically
function compareFolders(a, b) {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = pa[i].localeCompare(pb[i]);
    if (c) return c;
  }
  return pa.length - pb.length;
}

// Every folder plus all of its parent folders, in tree order
function withAncestors(folders) {
  const all = new Set();
  for (const folder of folders) {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }
  return [...all].sort(compareFolders);
}

// Reuse the capitalisation of folder levels that already exist ("plans/new" -> "Plans/new")
function matchExistingCase(folder) {
  let result = '';
  for (const part of folder.split('/')) {
    const candidate = relJoin(result, part);
    result = state.layout.folders.find(f => f.toLowerCase() === candidate.toLowerCase()) || candidate;
  }
  return result;
}

// Returns the normalised folder path ("Plans/Houses/House 1"), or throws with a reason.
// Levels can be separated with \, / or > ("Plans > Houses > House 1").
function validateFolderName(input) {
  const parts = input.split(/[\\/>]+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Enter a folder name.');
  for (const part of parts) {
    if (/[:*?"<|]/.test(part)) throw new Error('Folder names can\'t contain : * ? " < |');
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

// registerRels: the register and its PDF, which aren't drawings
function matchFiles(tokenMap, files, registerRels) {
  const matchToken = RegisterCore.makeMatcher(Object.keys(tokenMap));
  const pdfs = files
    .filter(f => f.name.toLowerCase().endsWith('.pdf') && !registerRels.includes(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const byToken = {};
  const unmatched = [];
  for (const file of pdfs) {
    const token = matchToken(file.name);
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
    const title = state.titles[token];
    const edited = title !== tokenMap[token];
    const registerTitle = tokenMap[token];
    const folder = folderOf(token);
    const matches = match.byToken[token];
    if (!matches) {
      rows.push({ key: '#' + token, token, title, edited, registerTitle, folder, status: 'none' });
      continue;
    }
    const newName = newNameFor(token, state.titles);
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
        key: f.rel, token, title, edited, registerTitle, folder, file: f.name, dir: f.dir, rel: f.rel, newName, targetRel,
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

  wordBtn.hidden = state.registerKind !== 'docx';
  const edits = state.registerKind === 'docx' ? pendingTitleEdits().length : 0;
  wordBtn.textContent = edits ? `SAVE TO WORD (${edits})` : 'SAVE TO WORD';
  wordBtn.disabled = state.busy || edits === 0;

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

// Rows split into the top folder, each drawing folder (in tree order), then files matching nothing
function sections(rows) {
  const top = { folder: '', rows: [] };
  const byFolder = new Map(state.layout.folders.slice().sort(compareFolders).map(f => [f, { folder: f, rows: [] }]));
  const unmatched = { unmatched: true, rows: [] };
  for (const row of rows) {
    if (row.status === 'unmatched') unmatched.rows.push(row);
    else (byFolder.get(row.folder) || top).rows.push(row);
  }
  return [top, ...byFolder.values(), unmatched];
}

// `inside` is the visible rows of this folder and all of its subfolders
function renderSectionHeader(section, visible, inside) {
  const tr = document.createElement('tr');
  tr.className = 'section';
  const selectable = inside.filter(isSelectable);
  const depth = folderDepth(section.folder);

  const checkTd = cell(tr, '');
  if (selectable.length) {
    const allOn = selectable.every(isSelected);
    const cb = makeCheckbox(allOn, () => {
      for (const row of selectable) setSelected(row.key, cb.checked);
      render(new Set());
    });
    cb.indeterminate = !allOn && selectable.some(isSelected);
    cb.title = 'Select every drawing in this folder and its subfolders';
    checkTd.appendChild(cb);
  }

  const td = cell(tr, '');
  td.colSpan = 5;
  const name = document.createElement('span');
  name.className = 'section-name';
  if (section.unmatched) name.textContent = 'Files not in the register';
  else if (section.folder) {
    name.textContent = '📁 ' + folderLeaf(section.folder);
    name.title = displayPath(section.folder);
    td.style.paddingLeft = `${8 + (depth - 1) * 22}px`;
  } else name.textContent = `📂 ${baseName(state.targetDir)} (top folder)`;
  td.appendChild(name);

  if (!section.unmatched) {
    const plural = n => n === 1 ? '1 drawing' : `${n} drawings`;
    const direct = new Set(section.rows.map(r => r.token)).size;
    const count = document.createElement('span');
    count.className = 'muted section-count';
    count.textContent = plural(direct);
    if (section.folder) {
      const total = new Set(state.rows.filter(r => r.token && r.folder && isInside(r.folder, section.folder)).map(r => r.token)).size;
      if (total > direct) count.textContent += ` · ${plural(total)} including subfolders`;
    }
    td.appendChild(count);
  }

  // A folder can be dropped from the layout once nothing is assigned to it or stored in it, and it has no subfolders
  if (section.folder && !section.rows.length && !state.files.some(f => f.dir === section.folder) &&
      !state.layout.folders.some(f => f !== section.folder && isInside(f, section.folder))) {
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

function renderRow(row, newFiles, alt, depth) {
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
  const numberTd = cell(tr, showDrawing ? row.token : '', 'number');
  if (depth) numberTd.style.paddingLeft = `${8 + depth * 22}px`;
  const titleTd = cell(tr, '', 'title');
  if (showDrawing) renderTitle(titleTd, row);

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

// --------------------
// Title editing
// --------------------
function renderTitle(td, row) {
  td.textContent = row.title;
  if (row.edited) {
    td.classList.add('edited');
    const badge = document.createElement('button');
    badge.className = 'edit-badge';
    badge.textContent = 'edited ✕';
    badge.title = `Register: ${row.registerTitle}\nClick to undo this change`;
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      setTitleEdit(row.token, null);
    });
    td.append(' ', badge);
  }
  if (state.registerKind === 'docx') {
    td.classList.add('editable');
    td.title = row.edited ? `Register: ${row.registerTitle}\nDouble-click to edit` : 'Double-click to edit the title';
    td.addEventListener('dblclick', () => startTitleEdit(td, row));
  } else if (state.registerKind === 'pdf') {
    td.title = 'Load the Word (.docx) register to edit titles';
  }
}

function startTitleEdit(td, row) {
  if (state.busy || state.editingToken) return;
  state.editingToken = row.token;
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = row.title;
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    state.editingToken = null;
    const value = input.value.replace(/\s+/g, ' ').trim();
    if (save && value && value !== row.title) setTitleEdit(row.token, value);
    else renderAfterEdit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renderAfterEdit() {
  state.renderPending = false;
  rebuild();
}

// title: new title, or null to go back to the register's title
async function setTitleEdit(token, title) {
  if (title === null || title === state.tokenMap[token]) {
    delete state.layout.titleEdits[token];
    appendLog(`✏️ ${token}: back to the register title "${state.tokenMap[token]}".`);
  } else {
    state.layout.titleEdits[token] = title;
    appendLog(`✏️ ${token}: title changed to "${title}" (press SAVE TO WORD to write it to the register).`);
  }
  await saveLayout();
  renderAfterEdit();
}

function render(newFiles) {
  // Don't throw away a title the user is typing; renderAfterEdit() catches up
  if (state.editingToken) {
    state.renderPending = true;
    return;
  }
  rowsEl.textContent = '';
  const showHeaders = state.layout.folders.length > 0;
  state.displayKeys = [];
  let dataRows = 0;

  const isVisible = r => !(hideEmptyCheckbox.checked && r.status === 'none');
  const all = sections(state.rows);
  for (const section of all) {
    const visible = section.rows.filter(isVisible);
    // Once folders exist, every folder gets a header (even when empty); the unmatched list only when it has rows
    const header = showHeaders && (!section.unmatched || visible.length);
    if (header) {
      const inside = section.folder
        ? all.filter(s => !s.unmatched && s.folder && isInside(s.folder, section.folder)).flatMap(s => s.rows.filter(isVisible))
        : visible;
      renderSectionHeader(section, visible, inside);
    }
    for (const row of visible) {
      if (isSelectable(row)) state.displayKeys.push(row.key);
      renderRow(row, newFiles, dataRows % 2 === 1, section.unmatched ? 0 : folderDepth(section.folder));
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
    emptyEl.textContent = state.registerPath ? 'No drawings found in this folder yet.' : 'Choose a drawing register or the folder containing it.';
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

// Register titles with any edits made in the app applied
function effectiveTitles() {
  const titles = {};
  for (const [token, title] of Object.entries(state.tokenMap)) {
    const edit = state.layout.titleEdits[token];
    titles[token] = edit && edit !== title ? edit : title;
  }
  return titles;
}

// Title edits for drawings in the register that differ from it
function pendingTitleEdits() {
  return Object.keys(state.tokenMap)
    .filter(t => state.layout.titleEdits[t] && state.layout.titleEdits[t] !== state.tokenMap[t])
    .map(t => ({ token: t, from: state.tokenMap[t], to: state.layout.titleEdits[t] }));
}

function rebuild(newFiles = new Set()) {
  if (!state.match) return;
  state.titles = effectiveTitles();
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
    const regStats = await getStatsOrNull(state.registerPath);
    if (!regStats) {
      appendLog(`⚠️ Register is no longer in the folder: ${baseName(state.registerPath)}`);
    } else if (registerStamp(regStats) !== state.registerModified) {
      if (state.registerModified !== null) appendLog('📚 Register changed, re-reading it...');
      state.tokenMap = await parseRegister(state.registerPath);
      state.registerModified = registerStamp(regStats);
      appendLog(`📘 Loaded ${Object.keys(state.tokenMap).length} drawing entries from register.`);
      // Edits the register now contains are done with
      const done = Object.keys(state.layout.titleEdits).filter(t => state.tokenMap[t] === state.layout.titleEdits[t]);
      if (done.length) {
        for (const t of done) delete state.layout.titleEdits[t];
        await saveLayout();
      }
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
    state.match = matchFiles(state.tokenMap, files, [baseName(state.registerPath), baseName(registerPdfPath())]);
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
    appendLog('❌ Choose a drawing register or the folder containing it first.');
    return;
  }
  try {
    const registerPath = await resolveRegisterPath(input);
    await stopWatching();
    Object.assign(state, {
      registerPath,
      registerKind: registerKindOf(baseName(registerPath)),
      registerModified: null,
      targetDir: dirName(registerPath),
      tokenMap: {},
      titles: {},
      rows: [],
      files: [],
      match: null,
      addedTimes: {},
      knownFiles: null,
      anchorKey: null,
      editingToken: null
    });
    state.unchecked.clear();
    state.picked.clear();
    state.choices.clear();
    await loadLayout();
    appendLog(`📚 Reading ${state.registerKind === 'docx' ? 'Word' : 'PDF'} register: ${registerPath} ...`);
    if (state.registerKind === 'pdf' && await findWordTwin()) {
      appendLog(`ℹ️ A Word version of this register is next to it; load it (or the folder) to edit titles.`);
    }
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
    const folder = matchExistingCase(result.folder);
    state.layout.folders = withAncestors([...state.layout.folders, folder]);
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
// 6️⃣ Save title edits into the Word register
// --------------------

// For a PDF register: the Word register with the same name next to it, if any
async function findWordTwin() {
  const twin = state.registerPath.replace(/\.[^./\\]+$/, '') + '.docx';
  return (await getStatsOrNull(twin)) ? twin : null;
}

// Word keeps "~$" + the name (minus its first two characters, for longer names) next to an open document
async function isOpenInWord(docxPath) {
  const name = baseName(docxPath);
  const files = await listFiles(dirName(docxPath));
  return files.some(f => f.startsWith('~$') && f.length >= name.length && name.endsWith(f.slice(2)));
}

// Copy a file into the top folder's SS folder with today's date in front, before it's overwritten
async function backupToSS(filePath) {
  await ensureDir(SUPERSEDED_DIR);
  const name = baseName(filePath);
  const dot = name.lastIndexOf('.');
  const stem = supersededName(name.slice(0, dot));
  const ext = name.slice(dot);
  let dest = stem + ext;
  for (let n = 2; await getStatsOrNull(absPath(relJoin(SUPERSEDED_DIR, dest))); n++) dest = `${stem} (${n})${ext}`;
  await Neutralino.filesystem.copy(filePath, absPath(relJoin(SUPERSEDED_DIR, dest)));
  appendLog(`📦 Backed up ${name} → ${SUPERSEDED_DIR}\\${dest}`);
}

// PowerShell -EncodedCommand takes base64 of UTF-16LE
function encodePowerShell(script) {
  let binary = '';
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    binary += String.fromCharCode(c & 0xff, c >> 8);
  }
  return btoa(binary);
}

function psString(s) {
  return "'" + s.replace(/\//g, '\\').replace(/'/g, "''") + "'";
}

async function runPowerShell(script) {
  return Neutralino.os.execCommand(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`);
}

async function checkWordAvailable() {
  if (state.wordAvailable !== null) return state.wordAvailable;
  state.wordAvailable = false;
  if (typeof NL_OS !== 'undefined' && NL_OS !== 'Windows') return false;
  try {
    const res = await runPowerShell(`if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application') { 'yes' } else { 'no' }`);
    state.wordAvailable = (res.stdOut || '').trim() === 'yes';
  } catch (e) {
    // PowerShell not available
  }
  return state.wordAvailable;
}

// Have Word export the register to PDF, as the document looks with all tracked changes accepted.
// Uses a hidden Word of its own; if Word is already open, it borrows it without hiding or closing it.
async function exportPdfWithWord(docxPath, pdfPath) {
  const script = `
$ErrorActionPreference = 'Stop'
try { $word = New-Object -ComObject Word.Application } catch { 'ERROR: Word could not be started'; exit 2 }
$own = ($word.Documents.Count -eq 0)
if ($own) { $word.Visible = $false }
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open(${psString(docxPath)}, $false, $true, $false)
  $doc.ActiveWindow.View.RevisionsFilter.Markup = 0
  $doc.ActiveWindow.View.RevisionsFilter.View = 0
  $doc.ExportAsFixedFormat(${psString(pdfPath)}, 17)
  $doc.Close(0)
  'OK'
} catch {
  'ERROR: ' + $_.Exception.Message
  exit 1
} finally {
  if ($own) { $word.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}`;
  const res = await runPowerShell(script);
  const out = (res.stdOut || '').trim();
  if (res.exitCode !== 0 || !out.endsWith('OK')) throw new Error(out.replace(/^ERROR:\s*/, '') || (res.stdErr || '').trim() || `PowerShell exited with ${res.exitCode}`);
}

const wordDialog = document.getElementById('word-dialog');

// Resolves to { tracked, exportPdf } or null if cancelled
async function askWordOptions(edits) {
  const wordOk = await checkWordAvailable();
  document.getElementById('word-dialog-title').textContent =
    `Save ${edits.length === 1 ? '1 title change' : edits.length + ' title changes'} to ${baseName(state.registerPath)}`;
  const list = document.getElementById('word-changes');
  list.textContent = '';
  for (const e of edits) {
    const li = document.createElement('li');
    const num = document.createElement('b');
    num.textContent = e.token;
    const from = document.createElement('del');
    from.textContent = e.from;
    const to = document.createElement('ins');
    to.textContent = e.to;
    li.append(num, ' ', from, ' → ', to);
    list.appendChild(li);
  }
  const exportBox = document.getElementById('word-export');
  exportBox.disabled = !wordOk;
  exportBox.checked = wordOk;
  document.getElementById('word-export-note').textContent = wordOk
    ? `Overwrites ${baseName(registerPdfPath())} (a dated copy of the old one goes to ${SUPERSEDED_DIR}\\).`
    : 'Microsoft Word isn\'t available, so export the PDF from Word yourself.';
  wordDialog.showModal();

  return new Promise(resolve => {
    const form = wordDialog.querySelector('form');
    const finish = (result) => {
      form.removeEventListener('submit', onSubmit);
      wordDialog.removeEventListener('cancel', onCancel);
      wordDialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === 'cancel') return finish(null);
      finish({ tracked: document.getElementById('word-tracked').checked, exportPdf: exportBox.checked && !exportBox.disabled });
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    form.addEventListener('submit', onSubmit);
    wordDialog.addEventListener('cancel', onCancel);
  });
}

async function saveToWord() {
  const edits = pendingTitleEdits();
  if (!edits.length || state.registerKind !== 'docx') return;
  const options = await askWordOptions(edits);
  if (!options) return;

  const docx = state.registerPath;
  state.busy = true;
  updateButtons();
  try {
    if (await isOpenInWord(docx)) {
      throw new Error(`${baseName(docx)} is open in Word. Close it there first, then save again.`);
    }
    const { zip, xml } = await readDocumentXml(docx);
    let author = 'Drawing Renamer';
    try {
      const user = await Neutralino.os.getEnv('USERNAME');
      if (user) author = `${user} (Drawing Renamer)`;
    } catch (e) {
      // keep the default author
    }
    const result = RegisterCore.editDocxTitles(xml, Object.fromEntries(edits.map(e => [e.token, e.to])), { tracked: options.tracked, author });

    // Check the edited document reads back as intended before touching the file
    const check = RegisterCore.readDocxTitles(result.xml);
    const wrong = Object.keys(result.applied).filter(t => check[t] !== result.applied[t].to);
    if (wrong.length) throw new Error(`the edited document didn't read back correctly for ${wrong.join(', ')}; nothing was saved.`);
    const original = RegisterCore.readDocxTitles(xml);
    const changed = Object.keys(original).filter(t => !(t in result.applied) && check[t] !== original[t]);
    if (changed.length) throw new Error(`other titles would have changed (${changed.join(', ')}); nothing was saved.`);

    await backupToSS(docx);
    zip.file('word/document.xml', result.xml);
    const data = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await Neutralino.filesystem.writeBinaryFile(docx, data);

    const how = options.tracked ? 'as tracked changes' : 'directly';
    for (const [token, { from, to }] of Object.entries(result.applied)) {
      appendLog(`📝 ${token}: "${from}" → "${to}" (${how})`);
    }
    for (const token of result.notFound) appendLog(`⚠️ ${token} wasn't found in a table row of ${baseName(docx)}; its edit was kept.`);
    for (const token of Object.keys(result.applied)) delete state.layout.titleEdits[token];
    await saveLayout();
    appendLog(`✅ Saved ${Object.keys(result.applied).length} title change(s) to ${baseName(docx)}.`);

    if (options.exportPdf) {
      const pdf = registerPdfPath();
      appendLog(`🖨️ Exporting ${baseName(pdf)} with Word...`);
      if (await getStatsOrNull(pdf)) await backupToSS(pdf);
      await exportPdfWithWord(docx, pdf);
      appendLog(`✅ Exported ${baseName(pdf)}.`);
    }
  } catch (err) {
    appendLog('❌ Could not save to Word: ' + (err.message || err));
  } finally {
    state.busy = false;
    await refresh();
  }
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
    const files = await Neutralino.os.showOpenDialog('Select drawing register', {
      filters: [
        { name: 'Drawing registers', extensions: ['docx', 'pdf'] },
        { name: 'Word documents', extensions: ['docx'] },
        { name: 'PDF files', extensions: ['pdf'] }
      ]
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
wordBtn.addEventListener('click', saveToWord);
renameBtn.addEventListener('click', renameSelected);

document.getElementById('clear-log').addEventListener('click', () => {
  logEl.textContent = '';
});
