const registerInput = document.getElementById('register');
const logEl = document.getElementById('log');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const summaryEl = document.getElementById('summary');
const watchingEl = document.getElementById('watching');
const renameBtn = document.getElementById('rename');
const folderBtn = document.getElementById('make-folder');
const wordBtn = document.getElementById('save-word');
const openRegisterBtn = document.getElementById('open-register');
const exportRegisterBtn = document.getElementById('export-register');
const entryBtn = document.getElementById('new-entry');
const hideEmptyCheckbox = document.getElementById('hide-empty');
const checkAllCheckbox = document.getElementById('check-all');
const fileTitlesCheckbox = document.getElementById('show-file-titles');
const fileRevCheckbox = document.getElementById('show-file-rev');
const fileScaleCheckbox = document.getElementById('show-file-scale');
const fileProjectCheckbox = document.getElementById('show-file-project');
// Each shows columns read from the drawings' title blocks (all fields are read in one pass)
const fileDetailCheckboxes = [[fileTitlesCheckbox, 'hide-file-titles'], [fileRevCheckbox, 'hide-file-rev'], [fileScaleCheckbox, 'hide-file-scale'], [fileProjectCheckbox, 'hide-file-project']];
const tableEl = document.getElementById('drawings');
const stackCheckbox = document.getElementById('stack-compare');
const titlesFromFilesBtn = document.getElementById('titles-from-files');
const titlesFromRegisterBtn = document.getElementById('titles-from-register');
const detailsFromFilesBtn = document.getElementById('details-from-files');
const projectDataEl = document.getElementById('project-data');
const revisionDataEl = document.getElementById('revision-data');
const tabButtons = [...document.querySelectorAll('nav.tabs [role=tab]')];

PDFJS.workerSrc = 'js/pdfjs/pdf.worker.js';

const SUPERSEDED_DIR = 'SS';
const DEFAULT_SEPARATOR = ' - ';
// Saved next to the register: which folder each drawing belongs in, for later runs
const LAYOUT_FILE = 'drawing-renamer.json';

// File paths inside targetDir are "relative paths" using '/', e.g. "Plans/PA-100 - Plan.pdf"
const state = {
  registerPath: null,    // full path of the loaded register (.docx or .pdf)
  registerKind: null,    // 'docx', 'xlsx' (Excel, incl. .xlsm) or 'pdf'
  registerInfo: '',      // e.g. which Excel sheet the drawings came from
  xlsxPlaces: {},        // Excel register: code => where its cells are (to check renumbering)
  excelAvailable: null,  // whether Excel can be driven to export PDFs (checked on first use)
  registerModified: null,
  targetDir: null,       // directory containing the register (the parent of any drawing folders)
  tokenMap: {},          // drawing number => title, as in the register
  registerDetails: {},   // drawing number => { scale, size }, as in the register
  registerProject: null, // { heading, fields: [{ key, label, value }], description, client } from the register's header
  registerIssues: null,  // { columns: [{ index, day, month, year, date }], latest, marks: { number: [mark per column] } }
  revisionUi: null,      // Revisions tab choices: { mode, scheme, dateFormat, marks: { number: typed mark } }
  activeTab: 'drawings',
  registerColumns: { scale: false, size: false }, // whether the register has scale / size columns to write to
  titles: {},            // drawing number => title used for renaming (register title or an edit)
  // folders, drawing number => folder, and register changes not yet saved to Word
  // titleEdits and numberEdits are keyed by the drawing number currently in the Word register
  // numberHistory: old number => new number for renumberings already saved to Word, so files
  // still named with an old number keep matching their drawing
  // moves: [{ token, after }] row moves in the register, applied in order ('' = to the top)
  // foldersToRemove: folders from "Reset folders", dropped once their files have moved out
  // separator: what goes between the drawing number and the title in file names
  // detailEdits: drawing number => { scale, size } changes (either may be missing), keyed like titleEdits
  // projectEdits: register header field label => new value ("Heading" for the heading)
  // issueEdit: a staged issue { mode: 'new' | 'update', index, date: { day, month, year }, marks:
  // { register number: mark }, header: { label: value }, highlight: 'RRGGBB' or null, register }
  // (header: the Issue No / Date edits it made; highlight: the colour to highlight the issue column
  // with; register: the file name of the register it's for)
  layout: { folders: [], assignments: {}, titleEdits: {}, detailEdits: {}, projectEdits: {}, issueEdit: null, numberEdits: {}, numberHistory: {}, newEntries: [], moves: [], foldersToRemove: [], separator: DEFAULT_SEPARATOR },
  drag: null,            // what's being dragged: { kind: 'drawing', token } or { kind: 'folder', folder }
  origOf: {},            // drawing number shown => number in the register (for renumbered drawings)
  movedTokens: new Set(), // register numbers of drawings with a pending move
  registerXml: null,     // word/document.xml of a Word register, for previews
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
  fileDetails: new Map(), // full path => { stamp, details } read from a drawing's title block:
                          // details { title, rev, scale, size }, or null if the file couldn't be read
  pollTimer: null,
  busy: false
};

function appendLog(text) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  // Collapsed, the header shows the latest line (its first line, for a message over several)
  const latest = document.getElementById('log-latest');
  latest.textContent = `[${time}] ${text.split('\n')[0]}`;
  latest.title = text;
}

function setLogExpanded(expanded) {
  const toggle = document.getElementById('toggle-log');
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.title = expanded ? 'Hide the log' : 'Show the log';
  logEl.hidden = !expanded;
  if (expanded) logEl.scrollTop = logEl.scrollHeight;
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
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

const REGISTER_KIND_NAMES = { docx: 'Word', xlsx: 'Excel', pdf: 'PDF' };

// Files named "...register..." in dir; Word beats Excel beats PDF (the PDF is usually exported
// from one of the others), and the last by name (registers are usually date-prefixed, so that's
// the latest) beats earlier ones
async function findRegister(dir) {
  const candidates = (await listFiles(dir))
    .filter(f => f.toLowerCase().includes('register') && registerKindOf(f))
    .sort((a, b) => a.localeCompare(b));
  const of = kind => candidates.filter(f => registerKindOf(f) === kind).pop();
  const found = of('docx') || of('xlsx') || of('pdf');
  return found ? joinPath(dir, found) : null;
}

async function resolveRegisterPath(input) {
  const stats = await getStatsOrNull(input);
  if (!stats) throw new Error('Provided register path does not exist.');
  if (stats.isFile) {
    if (!registerKindOf(baseName(input))) throw new Error('Provided file is not a Word (.docx), Excel (.xlsx, .xlsm) or PDF register.');
    return input;
  }
  if (stats.isDirectory) {
    const found = await findRegister(input);
    if (!found) throw new Error('No register (.docx, .xlsx, .xlsm or .pdf with "register" in its name) found in that directory.');
    return found;
  }
  throw new Error('Unsupported path type.');
}

// Titles and numbers can be edited in Word and Excel registers; new entries and moving rows
// need Word
function canEditRegister() {
  return state.registerKind === 'docx' || state.registerKind === 'xlsx';
}

function registerAppName() {
  return state.registerKind === 'xlsx' ? 'Excel' : 'Word';
}

function saveButtonLabel() {
  return `SAVE TO ${registerAppName().toUpperCase()}`;
}

// Drawing numbers as found in text (PA-A-100), or any hyphenated code with a letter and a digit
// (ISO 19650 codes like PAWE-DA-BF-XX-DR-A-6011A)
function isValidNumber(number) {
  return new RegExp('^' + RegisterCore.DRAWING_NUMBER + '$').test(number) || RegisterCore.isLooseCode(number);
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

// Multiplies two PDF transform matrices [a b c d e f]
function transformMatrix(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

// Title, revision, scale and sheet size from a drawing's title block ('' for any not found), from
// its first page. Text positions are taken as the sheet is displayed, so rotated sheets (common
// with ISO 19650 title blocks) read the same as upright ones.
// Pass a PDFJS.PDFWorker to reuse it (starting a worker per file is most of the cost).
async function readFileDetails(filePath, worker) {
  const data = new Uint8Array(await Neutralino.filesystem.readBinaryFile(filePath));
  const doc = await PDFJS.getDocument(worker ? { data, worker } : { data });
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport(1);
    const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    const items = content.items.map(i => {
      const m = transformMatrix(viewport.transform, i.transform);
      // The viewport has y downwards; title block parsing wants y upwards
      return {
        str: i.str, x: m[4], y: viewport.height - m[5], h: Math.hypot(m[2], m[3]) || 1,
        rotated: Math.abs(m[1]) > Math.abs(m[0]) * 0.05,
        // Reading direction, y upwards: sheets plotted sideways on the page are turned to read
        dx: m[0], dy: -m[1]
      };
    });
    return RegisterCore.readTitleBlock(items, { width: viewport.width, height: viewport.height });
  } finally {
    doc.destroy();
  }
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
  state.registerInfo = '';
  state.registerDetails = {};
  state.registerColumns = { scale: false, size: false };
  state.registerProject = null;
  state.registerIssues = null;
  if (registerKindOf(baseName(filePath)) === 'docx') {
    state.registerXml = (await readDocumentXml(filePath)).xml;
    state.registerDetails = RegisterCore.readDocxDetails(state.registerXml);
    state.registerProject = RegisterCore.readDocxProject(state.registerXml);
    state.registerIssues = RegisterCore.readDocxIssues(state.registerXml);
    state.registerColumns = { scale: true, size: true };
    return RegisterCore.readDocxTitles(state.registerXml);
  }
  state.registerXml = null;
  if (registerKindOf(baseName(filePath)) === 'xlsx') {
    const zip = await JSZip.loadAsync(await Neutralino.filesystem.readBinaryFile(filePath));
    const parts = await RegisterCore.loadXlsxParts(zip);
    const found = RegisterCore.readXlsxRegister(parts);
    state.registerProject = RegisterCore.readXlsxProject(parts);
    state.registerIssues = RegisterCore.readXlsxIssues(parts);
    if (found.sheet) state.registerInfo = `sheet "${found.sheet}"` + (found.issue !== null ? `, issue ${found.issue}` : '');
    state.xlsxSheet = found.sheet;
    state.xlsxPlaces = found.places;
    state.registerDetails = found.details;
    const places = Object.values(found.places);
    state.registerColumns = { scale: places.some(pl => pl.scaleCol !== undefined), size: places.some(pl => pl.sizeCol !== undefined) };
    return found.titles;
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
  state.layout = { folders: [], assignments: {}, titleEdits: {}, detailEdits: {}, projectEdits: {}, issueEdit: null, numberEdits: {}, numberHistory: {}, newEntries: [], moves: [], foldersToRemove: [], separator: DEFAULT_SEPARATOR };
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
    // Header edits and a staged issue belong to one register: they're kept per register file
    // (registerDrafts), so another register in the same folder neither sees nor loses them.
    // Older files kept them at the top level, for the register last saved.
    const drafts = {};
    for (const [name, d] of Object.entries(data.registerDrafts || {})) if (d && typeof d === 'object') drafts[name] = d;
    if ((data.projectEdits || data.issueEdit) && data.register && !drafts[data.register]) {
      // A staged issue from before issues recorded their register can't be trusted to be this one's
      drafts[data.register] = { projectEdits: data.projectEdits || {}, issueEdit: data.issueEdit && data.issueEdit.register ? data.issueEdit : null };
    }
    const current = baseName(state.registerPath);
    const mine = drafts[current] || {};
    delete drafts[current];
    const projectEdits = {};
    for (const [label, value] of Object.entries(mine.projectEdits || {})) {
      if (typeof value === 'string') projectEdits[label] = value;
    }
    const issue = mine.issueEdit;
    const issueEdit = issue && ['new', 'update'].includes(issue.mode) && Number.isInteger(issue.index) && issue.date && typeof issue.marks === 'object'
      ? { mode: issue.mode, index: issue.index, date: { day: String(issue.date.day), month: String(issue.date.month), year: String(issue.date.year) },
          marks: Object.fromEntries(Object.entries(issue.marks).filter(([, m]) => typeof m === 'string')), header: issue.header || {},
          highlight: /^[0-9A-F]{6}$/i.test(issue.highlight || '') ? issue.highlight.toUpperCase() : null, register: current }
      : null;
    const others = Object.keys(drafts).filter(name => Object.keys(drafts[name].projectEdits || {}).length || drafts[name].issueEdit);
    if (others.length) appendLog(`ℹ️ ${others.join(', ')} ${others.length === 1 ? 'has' : 'have'} unsaved project detail changes or a staged issue; they're kept for when ${others.length === 1 ? 'it is' : 'they are'} loaded.`);
    const detailEdits = {};
    for (const [token, edit] of Object.entries(data.detailEdits || {})) {
      const kept = {};
      for (const field of ['scale', 'size']) if (edit && typeof edit[field] === 'string') kept[field] = edit[field];
      if (Object.keys(kept).length) detailEdits[token] = kept;
    }
    const numberRe = { test: isValidNumber };
    const newEntries = (Array.isArray(data.newEntries) ? data.newEntries : [])
      .filter(e => e && typeof e.token === 'string' && numberRe.test(e.token) && typeof e.title === 'string' && e.title.trim())
      .map(e => ({
        token: e.token, title: e.title, scale: String(e.scale || ''), size: String(e.size || ''),
        after: typeof e.after === 'string' ? e.after : null, copyMarks: !!e.copyMarks
      }));
    const numberEdits = {};
    for (const [token, number] of Object.entries(data.numberEdits || {})) {
      if (typeof number === 'string' && numberRe.test(number) && number !== token) numberEdits[token] = number;
    }
    const numberHistory = {};
    for (const [token, number] of Object.entries(data.numberHistory || {})) {
      if (typeof number === 'string' && numberRe.test(number) && number !== token) numberHistory[token] = number;
    }
    const moves = (Array.isArray(data.moves) ? data.moves : [])
      .filter(m => m && numberRe.test(m.token) && (m.after === '' || numberRe.test(m.after)))
      .map(m => ({ token: m.token, after: m.after }));
    const foldersToRemove = (Array.isArray(data.foldersToRemove) ? data.foldersToRemove : []).filter(f => typeof f === 'string' && folders.includes(f));
    const separator = typeof data.separator === 'string' && !separatorProblem(data.separator) ? data.separator : DEFAULT_SEPARATOR;
    state.layout = { folders: withAncestors(folders), assignments, titleEdits, detailEdits, projectEdits, issueEdit, otherDrafts: drafts, numberEdits, numberHistory, newEntries, moves, foldersToRemove, separator };
    appendLog(`📁 Loaded folder layout from ${LAYOUT_FILE} (${folders.length} folders).`);
  } catch (err) {
    state.layoutBroken = true;
    appendLog(`⚠️ Could not read ${LAYOUT_FILE}; folder changes won't be saved until it's fixed: ${err.message || err}`);
  }
}

// The layout file's registerDrafts: this register's drafts beside the other registers' (empty ones left out)
function registerDrafts() {
  const all = { ...(state.layout.otherDrafts || {}) };
  if (state.registerPath) all[baseName(state.registerPath)] = { projectEdits: state.layout.projectEdits, issueEdit: state.layout.issueEdit };
  for (const [name, d] of Object.entries(all)) {
    if (!Object.keys(d.projectEdits || {}).length && !d.issueEdit) delete all[name];
  }
  return all;
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
    separator: state.layout.separator,
    folders: state.layout.folders,
    assignments,
    // Changes made in the app that haven't been saved into the Word register yet
    titleEdits: state.layout.titleEdits,
    detailEdits: state.layout.detailEdits,
    // Per register file: project detail changes and a staged issue
    registerDrafts: registerDrafts(),
    numberEdits: state.layout.numberEdits,
    numberHistory: state.layout.numberHistory,
    moves: state.layout.moves,
    foldersToRemove: state.layout.foldersToRemove,
    newEntries: state.layout.newEntries
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
  return `${token}${state.layout.separator}${sanitizeFilename(tokenMap[token])}.pdf`;
}

// Why a separator can't be used, or null if it's fine
function separatorProblem(sep) {
  if (!sep) return 'The separator can\'t be empty.';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(sep)) return 'File names can\'t contain \\ / : * ? " < > |';
  return null;
}

// registerRels: the register and its PDF, which aren't drawings
function matchFiles(tokenMap, files, registerRels) {
  const matchCurrent = RegisterCore.makeMatcher(Object.keys(tokenMap));
  // A file still named with a renumbered drawing's old number belongs to that drawing, for
  // pending renumberings and ones already saved to Word (until no file uses the old number)
  const aliases = {};
  for (const [old, number] of Object.entries(state.layout.numberHistory)) {
    const shown = state.layout.numberEdits[number] || number;
    if (shown in tokenMap) aliases[old] = shown;
  }
  for (const [shown, orig] of Object.entries(state.origOf)) {
    if (shown !== orig) aliases[orig] = shown;
  }
  const matchOld = RegisterCore.makeMatcher(Object.keys(aliases));
  const matchReordered = RegisterCore.makeReorderedMatcher(Object.keys(tokenMap));
  const matchToken = name => {
    const current = matchCurrent(name);
    const old = matchOld(name);
    if (!old) return current;
    if (!current || old.length > current.length) return aliases[old];
    if (current.length > old.length) return current;
    // The number was given to another drawing: files made before the change keep their old
    // drawing, apart from one already renamed to the new drawing's name
    return name.toLowerCase() === newNameFor(current, tokenMap).toLowerCase() ? current : aliases[old];
  };
  const pdfs = files
    .filter(f => f.name.toLowerCase().endsWith('.pdf') && !registerRels.includes(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const byToken = {};
  const unmatched = [];
  const reordered = new Set(); // files whose code has the right fields in a different order
  for (const file of pdfs) {
    let token = matchToken(file.name);
    if (!token) {
      token = matchReordered(file.name);
      if (token) reordered.add(file.rel);
    }
    if (token) (byToken[token] = byToken[token] || []).push(file);
    // A register's own PDF (e.g. exported from the Excel register) isn't a drawing
    else if (!/register/i.test(file.name)) unmatched.push(file);
  }
  return { byToken, unmatched, reordered };
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
  for (const token of Object.keys(state.titles)) {
    const title = state.titles[token];
    const origToken = state.origOf[token];
    const isNew = origToken === undefined;
    const registerTitle = isNew ? undefined : tokenMap[origToken];
    const edited = !isNew && title !== registerTitle;
    const renumbered = !isNew && origToken !== token;
    const moved = !isNew && state.movedTokens.has(origToken);
    const folder = folderOf(token);
    const matches = match.byToken[token];
    if (!matches) {
      rows.push({ key: '#' + token, token, origToken, title, edited, renumbered, moved, isNew, registerTitle, folder, status: 'none' });
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
        key: f.rel, token, origToken, title, edited, renumbered, moved, isNew, registerTitle, folder, file: f.name, dir: f.dir, rel: f.rel, newName, targetRel,
        group, chosen: f === chosen, first: i === 0, last: i === ordered.length - 1
      };
      if (match.reordered && match.reordered.has(f.rel)) {
        row.reordered = true;
        row.reason = `The code in this file name has the same parts as ${token} in a different order`;
      }
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
  // Rows needing a rename start ticked, except files matched by a reordered code
  return ACTION_STATUSES.includes(row.status) && !row.reordered ? !state.unchecked.has(row.key) : state.picked.has(row.key);
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
  folderBtn.textContent = selected ? `FOLDER (${selected})` : '+ FOLDER';
  folderBtn.disabled = state.busy || selected === 0;

  const isDocx = state.registerKind === 'docx';
  const editable = canEditRegister();
  wordBtn.hidden = !editable;
  entryBtn.hidden = !isDocx;
  entryBtn.disabled = state.busy;
  const changes = isDocx
    ? pendingTitleEdits().length + pendingDetailEdits().length + pendingProjectEdits().length + (pendingIssue() ? 1 : 0) + pendingNumberEdits().length + pendingNewEntries().length + state.movedTokens.size
    : editable ? pendingTitleEdits().length + pendingDetailEdits().length + pendingProjectEdits().length + (pendingIssue() ? 1 : 0) + pendingNumberEdits().length : 0;
  wordBtn.textContent = changes ? `${saveButtonLabel()} (${changes})` : saveButtonLabel();
  wordBtn.title = `Write edited titles and numbers into the ${registerAppName()} register`;
  wordBtn.disabled = state.busy || changes === 0;
  openRegisterBtn.hidden = !editable;
  openRegisterBtn.textContent = `OPEN IN ${registerAppName().toUpperCase()}`;
  openRegisterBtn.title = `Open ${state.registerPath ? baseName(state.registerPath) : 'the register'} in ${registerAppName()}. Close it there before saving changes from here.`;
  exportRegisterBtn.hidden = !editable;
  exportRegisterBtn.disabled = state.busy;
  exportRegisterBtn.title = state.registerPath
    ? `Export the register to ${baseName(datedPdfPath())} in this folder with ${registerAppName()}` + (changes ? ' (as last saved: the unsaved changes are left out)' : '')
    : '';

  const which = selected ? `the ${selected} selected drawing${selected === 1 ? '' : 's'}` : 'the selected drawings';
  const copyNote = editable ? '' : '\nTitles can only be changed in a Word or Excel register';
  titlesFromFilesBtn.disabled = titlesFromRegisterBtn.disabled = state.busy || !editable || selected === 0;
  titlesFromFilesBtn.title = `Use the in-file title for ${which}` + copyNote;
  titlesFromRegisterBtn.title = `Put ${which} back to the register title` + copyNote;
  const detailColumns = state.registerColumns.scale || state.registerColumns.size;
  detailsFromFilesBtn.disabled = state.busy || !editable || !detailColumns || selected === 0;
  detailsFromFilesBtn.title = `Use the in-file scale and size for ${which}` +
    (!editable ? copyNote : !detailColumns ? '\nThe register has no scale or size column' : '');

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
  const dragTd = cell(tr, '', 'drag');
  if (!section.unmatched) {
    if (section.folder) addFolderHandle(dragTd, tr, section.folder);
    makeFolderDropTarget(tr, section.folder);
  }
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
  // Includes the in-file detail columns, which may be hidden; stacked, two fewer columns
  td.colSpan = stackCheckbox.checked ? 9 : 11;
  const name = document.createElement('span');
  name.className = 'section-name';
  if (section.unmatched) name.textContent = 'Files not in the register';
  else if (section.folder) {
    name.textContent = '📁 ' + folderLeaf(section.folder);
    name.title = `${displayPath(section.folder)}\nDouble-click to rename`;
    name.classList.add('editable');
    name.addEventListener('dblclick', () => startFolderRename(name, section.folder));
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

// Edit a folder's name in place: Enter or leaving the box renames it, Escape cancels
function startFolderRename(nameEl, folder) {
  if (state.busy || state.editingToken) return;
  state.editingToken = `folder:${folder}`;
  const input = document.createElement('input');
  input.className = 'title-input folder-input';
  input.value = folderLeaf(folder);
  input.spellcheck = false;
  // As wide as the name (with room to type), growing with it
  const fit = () => { input.size = Math.max(input.value.length + 2, 12); };
  fit();
  input.addEventListener('input', fit);
  nameEl.replaceChildren('📁 ', input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    let name = null;
    if (save && input.value.trim() !== folderLeaf(folder)) {
      try {
        name = validateFolderName(input.value);
        if (name.includes('/')) throw new Error('Enter just the folder\'s name; drag the folder to move it into another one.');
      } catch (err) {
        appendLog(`❌ ${err.message} ${displayPath(folder)} wasn't renamed.`);
        name = null;
      }
    }
    finished = true;
    state.editingToken = null;
    if (name) await renameFolder(folder, name);
    // Redrawn even when the rename was refused (e.g. the name is taken)
    render(new Set());
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// --------------------
// Dragging: drawings to reorder the register or change folder, folders to nest them
// --------------------

// Reordering needs a Word register; folder changes work with any register
function canReorder() {
  return state.registerKind === 'docx';
}

function canDragDrawings() {
  return !!state.registerKind && (canReorder() || state.layout.folders.length > 0);
}

function clearDropMarks() {
  for (const el of rowsEl.querySelectorAll('.drop-above, .drop-below, .drop-into, .dragging')) {
    el.classList.remove('drop-above', 'drop-below', 'drop-into', 'dragging');
  }
}

function markDrop(tr, cls) {
  if (tr.classList.contains(cls)) return;
  for (const el of rowsEl.querySelectorAll('.drop-above, .drop-below, .drop-into')) el.classList.remove('drop-above', 'drop-below', 'drop-into');
  tr.classList.add(cls);
}

function startDrag(e, tr, drag, label) {
  if (state.busy || state.editingToken) return e.preventDefault();
  state.drag = drag;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', label);
  // Show the whole row being dragged, not just the handle
  e.dataTransfer.setDragImage(tr, 10, tr.offsetHeight / 2);
  requestAnimationFrame(() => tr.classList.add('dragging'));
}

function makeHandle(title) {
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⋮⋮';
  handle.title = title;
  handle.draggable = true;
  handle.addEventListener('dragend', () => {
    state.drag = null;
    clearDropMarks();
  });
  return handle;
}

function addDragHandle(td, tr, row) {
  const handle = makeHandle(canReorder()
    ? 'Drag to move this drawing in the register, or onto a folder to move it there'
    : 'Drag onto a folder to move this drawing there');
  handle.addEventListener('dragstart', (e) => startDrag(e, tr, { kind: 'drawing', token: row.token }, row.token));
  td.appendChild(handle);
}

function addFolderHandle(td, tr, folder) {
  const handle = makeHandle('Drag onto another folder to put this folder inside it, or onto the top folder to take it out');
  handle.addEventListener('dragstart', (e) => startDrag(e, tr, { kind: 'folder', folder }, folder));
  td.appendChild(handle);
}

// Any row of a drawing is a drop target for drawings: the top half drops before it, the bottom
// half after it (without a Word register, only the folder changes)
function makeDropTarget(tr, row) {
  const above = (e) => e.clientY < tr.getBoundingClientRect().top + tr.offsetHeight / 2;
  const accepts = () => state.drag && state.drag.kind === 'drawing' && state.drag.token !== row.token &&
    (canReorder() || folderOf(state.drag.token) !== row.folder);
  tr.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(tr, canReorder() ? (above(e) ? 'drop-above' : 'drop-below') : 'drop-into');
  });
  tr.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const token = state.drag.token;
    state.drag = null;
    clearDropMarks();
    moveDrawing(token, row.token, above(e), row.folder);
  });
}

// A folder's header (or the top folder's) takes drawings into the folder and folders inside it
function makeFolderDropTarget(tr, folder) {
  const accepts = () => {
    const d = state.drag;
    if (!d) return false;
    if (d.kind === 'drawing') return folderOf(d.token) !== folder;
    // Not into itself, its own subfolders, or the folder it's already in
    return d.folder !== folder && !(folder && isInside(folder, d.folder)) && parentFolder(d.folder) !== folder;
  };
  tr.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(tr, 'drop-into');
  });
  tr.addEventListener('drop', async (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const drag = state.drag;
    state.drag = null;
    clearDropMarks();
    if (drag.kind === 'drawing') {
      setDrawingFolder(drag.token, folder);
      await saveLayout();
      rebuild();
    } else {
      await moveFolder(drag.folder, folder);
    }
  });
}

function parentFolder(folder) {
  return folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
}

// Put a drawing in a folder ('' = the top folder); its files move there on RENAME
function setDrawingFolder(token, folder) {
  if (folderOf(token) === folder) return false;
  if (folder) state.layout.assignments[token] = folder;
  else delete state.layout.assignments[token];
  appendLog(`📁 ${token} will go ${folder ? 'into ' + displayPath(folder) : 'to the top folder'} when you press RENAME.`);
  return true;
}

// Move the drawing shown as `token` just before or after the drawing shown as `target`, into
// the target's folder
async function moveDrawing(token, target, before, targetFolder) {
  let reordered = false;
  if (canReorder()) {
    const order = Object.keys(state.titles).filter(t => t !== token);
    const at = order.indexOf(target) + (before ? 0 : 1);
    const prev = at > 0 ? order[at - 1] : null;
    const entry = state.origOf[token] === undefined && state.layout.newEntries.find(e => e.token === token);
    // Register rows are placed after register rows; a new entry goes in right after its anchor row
    const prevEntry = prev && state.origOf[prev] === undefined && state.layout.newEntries.find(e => e.token === prev);
    const anchor = !prev ? '' : prevEntry ? prevEntry.after || '' : state.origOf[prev];

    if (entry) {
      const list = state.layout.newEntries.filter(e => e !== entry);
      entry.after = anchor;
      // Keep new entries that share an anchor in the order they're shown
      const i = prevEntry ? list.indexOf(prevEntry) + 1 : list.findIndex(e => e.after === anchor);
      list.splice(i < 0 ? list.length : i, 0, entry);
      state.layout.newEntries = list;
    } else {
      state.layout.moves.push({ token: state.origOf[token], after: anchor });
      if (!pendingMoves().length) state.layout.moves = []; // back to the register's order
    }
    reordered = true;
    appendLog(`↕️ ${token} moved ${prev ? 'after ' + prev : 'to the top of the register'}${entry ? '' : ' (press SAVE TO WORD to reorder the register)'}.`);
  }
  const refiled = targetFolder !== undefined && targetFolder !== null && setDrawingFolder(token, targetFolder);
  if (!reordered && !refiled) return;
  await saveLayout();
  rebuild();
}

// Move a folder (with its subfolders and files) into `parent` ('' = the top folder). This moves
// the folder on disk straight away, so the app keeps finding the files inside it.
async function moveFolder(folder, parent) {
  const dest = relJoin(parent, folderLeaf(folder));
  if (dest === folder || state.busy) return;
  if (parent && isInside(parent, folder)) {
    appendLog(`❌ ${displayPath(folder)} can't go inside itself.`);
    return;
  }
  await relocateFolder(folder, dest, 'moved');
}

// Rename a folder where it is, on disk straight away like moving it
async function renameFolder(folder, name) {
  const dest = relJoin(parentFolder(folder), name);
  if (dest === folder || state.busy) return;
  await relocateFolder(folder, dest, 'renamed');
}

// Give a folder a new path: its subfolders, drawing assignments and files go with it
async function relocateFolder(folder, dest, verb) {
  // Only a change of case may reuse the folder's own name
  const sameName = dest.toLowerCase() === folder.toLowerCase();
  if (state.layout.folders.some(f => f !== folder && f.toLowerCase() === dest.toLowerCase()) || (!sameName && await getStatsOrNull(absPath(dest)))) {
    appendLog(`❌ There's already a folder called ${displayPath(dest)}; ${displayPath(folder)} wasn't ${verb}.`);
    return;
  }
  state.busy = true;
  updateButtons();
  try {
    const stats = await getStatsOrNull(absPath(folder));
    if (stats && stats.isDirectory) {
      // Let go of the watchers inside the folder so Windows allows the move
      for (const [dir, id] of [...state.watchers]) {
        if (dir && isInside(dir, folder)) {
          try {
            await Neutralino.filesystem.removeWatcher(id);
          } catch (e) {
            // watcher already gone
          }
          state.watchers.delete(dir);
        }
      }
      if (parentFolder(dest)) await ensureDir(parentFolder(dest));
      await Neutralino.filesystem.move(absPath(folder), absPath(dest));
    }
    const remap = f => (f && isInside(f, folder) ? dest + f.slice(folder.length) : f);
    const remapRel = rel => (rel.startsWith(folder + '/') ? dest + rel.slice(folder.length) : rel);
    state.layout.folders = withAncestors(state.layout.folders.map(remap));
    state.layout.foldersToRemove = (state.layout.foldersToRemove || []).map(remap);
    for (const token of Object.keys(state.layout.assignments)) {
      state.layout.assignments[token] = remap(state.layout.assignments[token]);
    }
    // Keep choices and selections for the files that moved, and don't flash them as new
    if (state.knownFiles) state.knownFiles = new Set([...state.knownFiles].map(remapRel));
    for (const [token, rel] of state.choices) state.choices.set(token, remapRel(rel));
    state.unchecked = new Set([...state.unchecked].map(remapRel));
    state.picked = new Set([...state.picked].map(remapRel));
    await saveLayout();
    appendLog(`📁 ${verb === 'renamed' ? 'Renamed' : 'Moved'} folder ${displayPath(folder)} → ${displayPath(dest)}${stats ? '' : ' (it had no files yet)'}.`);
  } catch (err) {
    appendLog(`❌ Could not ${verb === 'renamed' ? 'rename' : 'move'} ${displayPath(folder)}: ${err.message || err}. Close any window showing files in it and try again.`);
  } finally {
    state.busy = false;
    await refresh();
  }
}

// Where a new row goes, for messages: after is a register number, '' for the top
function describePlace(after) {
  if (after === '') return 'at the top of the register';
  return after && after in state.tokenMap ? `after ${after}` : 'after the last drawing';
}

async function undoMove(token) {
  const orig = state.origOf[token];
  state.layout.moves = state.layout.moves.filter(m => m.token !== orig);
  appendLog(`↕️ ${token} is back in its register position.`);
  await saveLayout();
  rebuild();
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

  // Double-clicking the row opens its file, except where double-clicking edits (titles, numbers)
  if (row.rel) {
    tr.addEventListener('dblclick', (e) => {
      if (e.target.closest('input, button, label, select, a, .editable')) return;
      window.getSelection().removeAllRanges();
      openFile(row.rel);
    });
  }

  const dragTd = cell(tr, '', 'drag');
  if (row.token && canDragDrawings()) {
    if (!row.group || row.first) addDragHandle(dragTd, tr, row);
    makeDropTarget(tr, row);
  }
  if (row.moved) tr.classList.add('moved');

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
  const numberTd = cell(tr, '', 'number');
  if (showDrawing) renderNumber(numberTd, row);
  if (depth) numberTd.style.paddingLeft = `${8 + depth * 22}px`;
  const titleTd = cell(tr, '', 'title');
  // Stacked, the in-file title goes under the register title, in its cell
  const stacked = stackCheckbox.checked;
  const titleTop = stacked ? stackPart(titleTd, 'stack-top title') : titleTd;
  if (showDrawing) renderTitle(titleTop, row);
  const detailTds = { title: stacked ? stackPart(titleTd, 'stack-bottom') : cell(tr, ''), rev: cell(tr, ''), scale: cell(tr, ''), size: cell(tr, '') };
  // Stacked, the drawing's project and client go under the register's
  for (const field of ['project', 'client']) {
    if (!stacked) {
      detailTds[field] = cell(tr, '');
      continue;
    }
    const td = cell(tr, '', 'col-file-project');
    stackPart(td, 'stack-top register-line');
    detailTds[field] = stackPart(td, 'stack-bottom');
  }
  renderFileDetails(detailTds, row);
  // The status cell's revision and project warnings are added below; they update with the title block too
  const detailEntry = { tds: detailTds, row, warn: null, projectWarn: null };
  if (row.rel) {
    if (!fileDetailCells.has(row.rel)) fileDetailCells.set(row.rel, []);
    fileDetailCells.get(row.rel).push(detailEntry);
  }

  const current = row.rel ? displayPath(row.rel) : 'No matching file';
  const fileTd = cell(tr, '', row.rel ? 'file' : 'file missing');
  const fileTop = stacked ? stackPart(fileTd, 'stack-top') : fileTd;
  if (!row.group) fileTop.textContent = current;
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
    fileTop.appendChild(label);
  }

  let target = row.targetRel ? displayPath(row.targetRel) : '';
  if (row.status === 'ok') target = '(already named)';
  else if (row.status === 'superseded') target = displayPath(relJoin(relJoin(row.dir, SUPERSEDED_DIR), supersededName(row.file)));
  else if (row.status === 'skip' || row.status === 'none') target = '';
  // Stacked, the new name goes under the current one, with what changes marked
  const canAdd = row.status === 'unmatched' && state.registerKind === 'docx';
  const targetTd = stacked ? stackPart(fileTd, 'stack-bottom') : cell(tr, '');
  if (!stacked) targetTd.textContent = target;
  else if (target && row.rel && !row.group && row.status !== 'ok') {
    const [before, after] = markDifferences(current, target);
    fileTop.replaceChildren(...before);
    targetTd.append('→ ', ...after);
  } else if (target) targetTd.textContent = `→ ${target}`;
  else if (!canAdd) targetTd.remove();
  if (canAdd) {
    const add = document.createElement('button');
    add.className = 'link';
    add.textContent = 'Add to register…';
    add.title = 'Add a register entry for this file';
    add.addEventListener('click', () => openEntryDialog(row));
    targetTd.appendChild(add);
  }

  const statusTd = cell(tr, '', 'status-cell');
  const badge = document.createElement('span');
  badge.className = 'status ' + row.status;
  badge.textContent = STATUS_LABELS[row.status];
  const tip = row.reason || STATUS_TIPS[row.status];
  if (tip) badge.title = tip;
  statusTd.appendChild(badge);
  if (row.rel) {
    detailEntry.projectWarn = document.createElement('span');
    detailEntry.projectWarn.className = 'status-icon';
    statusTd.appendChild(detailEntry.projectWarn);
    renderProjectWarning(detailEntry.projectWarn, row);
  }
  if (row.reordered) {
    const warn = document.createElement('div');
    warn.className = 'reordered';
    warn.textContent = '⚠ code reordered';
    warn.title = `${row.reason}; tick it to rename the file with the register's code`;
    statusTd.appendChild(warn);
  }
  if (row.token && row.rel) {
    detailEntry.warn = document.createElement('div');
    detailEntry.warn.className = 'reordered';
    statusTd.appendChild(detailEntry.warn);
    renderRevisionWarning(detailEntry.warn, row);
  }

  rowsEl.appendChild(tr);
}

// --------------------
// Title editing
// --------------------
// A line of a stacked cell
function stackPart(td, cls) {
  const div = document.createElement('div');
  div.className = cls;
  td.appendChild(div);
  return div;
}

// Two versions of a text as nodes, with the words only in the first (before) and only in the
// second (after) marked; compared ignoring case
function markDifferences(a, b) {
  const split = t => t.match(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g) || [];
  const x = split(a), y = split(b);
  const same = (i, j) => x[i].toLowerCase() === y[j].toLowerCase();
  // Longest common subsequence of the words and the separators between them
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = same(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const before = [], after = [];
  const add = (list, text, changed) => {
    const last = list[list.length - 1];
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  let i = 0, j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && same(i, j)) {
      add(before, x[i++], false);
      add(after, y[j++], false);
    } else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      add(before, x[i++], true);
    } else {
      add(after, y[j++], true);
    }
  }
  const nodes = list => list.map(({ text, changed }) => {
    if (!changed || !text.trim()) return document.createTextNode(text);
    const mark = document.createElement('mark');
    mark.className = 'diff';
    mark.textContent = text;
    return mark;
  });
  return [nodes(before), nodes(after)];
}

function renderTitle(td, row) {
  td.textContent = '';
  const text = document.createElement('span');
  text.className = 'title-text';
  text.textContent = row.title;
  td.appendChild(text);
  if (row.moved) {
    const badge = document.createElement('button');
    badge.className = 'edit-badge moved';
    badge.textContent = 'moved ✕';
    badge.title = 'Moved in the register; press SAVE TO WORD to reorder it.\nClick to put it back';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      undoMove(row.token);
    });
    td.append(' ', badge);
  }
  if (row.isNew) {
    td.classList.add('edited');
    const badge = document.createElement('button');
    badge.className = 'edit-badge new';
    badge.textContent = 'new ✕';
    badge.title = 'Not in the register yet; press SAVE TO WORD to add it.\nClick to remove this entry';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNewEntry(row.token);
    });
    td.append(' ', badge);
  } else if (row.edited) {
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
  if (canEditRegister()) {
    td.classList.add('editable');
    td.title = row.edited ? `Register: ${row.registerTitle}\nDouble-click to edit` : 'Double-click to edit the title';
    td.addEventListener('dblclick', () => startTitleEdit(td, row));
  } else if (state.registerKind) {
    td.title = 'Titles can only be edited in a Word or Excel register';
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

// --------------------
// Drawing number editing
// --------------------
function renderNumber(td, row) {
  td.textContent = row.token;
  if (row.renumbered) {
    td.classList.add('edited');
    const badge = document.createElement('button');
    badge.className = 'edit-badge number';
    badge.textContent = `was ${row.origToken} ✕`;
    badge.title = `Register: ${row.origToken}\nClick to go back to ${row.origToken}`;
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      setNumberEdit(row.token, row.origToken);
    });
    td.append(document.createElement('br'), badge);
  }
  if (canEditRegister()) {
    td.classList.add('editable');
    td.title = row.renumbered ? `Register: ${row.origToken}\nDouble-click to change the number` : 'Double-click to change the drawing number';
    td.addEventListener('dblclick', () => startNumberEdit(td, row));
  }
}

function startNumberEdit(td, row) {
  if (state.busy || state.editingToken) return;
  state.editingToken = row.token;
  const input = document.createElement('input');
  input.className = 'title-input number-input';
  input.value = row.token;
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    state.editingToken = null;
    const value = input.value.replace(/\s+/g, '').toUpperCase();
    if (save && value && value !== row.token) setNumberEdit(row.token, value);
    else renderAfterEdit();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// Give the drawing shown as `shown` the number `number` (the register's own number undoes it)
async function setNumberEdit(shown, number) {
  const token = state.origOf[shown];
  const entry = token === undefined && state.layout.newEntries.find(e => e.token === shown);
  if (!isValidNumber(number)) {
    appendLog(`❌ "${number}" isn't a drawing number like PA-002 or PAWE-DA-BF-00-DR-A-1010; ${shown} wasn't changed.`);
    return renderAfterEdit();
  }
  // An Excel code split one field per cell needs the same number of fields
  const place = state.registerKind === 'xlsx' && token !== undefined && state.xlsxPlaces[token];
  if (place && place.codeCols.length > 1 && number.split('-').length !== place.codeCols.length) {
    appendLog(`❌ ${shown} is split over ${place.codeCols.length} cells in the register, so a new number needs ${place.codeCols.length} parts; ${number} has ${number.split('-').length}.`);
    return renderAfterEdit();
  }
  if (number in state.titles) {
    appendLog(`❌ ${number} is already used by another drawing; renumber that one first. ${shown} wasn't changed.`);
    return renderAfterEdit();
  }
  if (entry) {
    entry.token = number;
    appendLog(`✏️ New entry ${shown} is now ${number}.`);
  } else if (number === token) {
    delete state.layout.numberEdits[token];
    appendLog(`✏️ ${shown}: back to the register number ${token}.`);
  } else {
    state.layout.numberEdits[token] = number;
    appendLog(`✏️ ${token} renumbered to ${number} (press ${saveButtonLabel()} to write it to the register; RENAME updates the file names).`);
  }
  // The drawing's folder and file choice move with it
  if (state.layout.assignments[shown]) {
    state.layout.assignments[number] = state.layout.assignments[shown];
    delete state.layout.assignments[shown];
  }
  if (state.choices.has(shown)) {
    state.choices.set(number, state.choices.get(shown));
    state.choices.delete(shown);
  }
  await saveLayout();
  renderAfterEdit();
}

function renderAfterEdit() {
  state.renderPending = false;
  rebuild();
}

// title: new title, or null to go back to the register's title
async function setTitleEdit(shown, title) {
  const token = state.origOf[shown];
  const entry = token === undefined && state.layout.newEntries.find(e => e.token === shown);
  if (entry) {
    if (title === null) return;
    entry.title = title;
    appendLog(`✏️ ${shown} (new entry): title changed to "${title}".`);
  } else if (title === null || title === state.tokenMap[token]) {
    delete state.layout.titleEdits[token];
    appendLog(`✏️ ${shown}: back to the register title "${state.tokenMap[token]}".`);
  } else {
    state.layout.titleEdits[token] = title;
    appendLog(`✏️ ${token}: title changed to "${title}" (press ${saveButtonLabel()} to write it to the register).`);
  }
  await saveLayout();
  renderAfterEdit();
}

// --------------------
// In-file details: title, revision, scale and sheet size read from each drawing's title block
// while any of their checkboxes is ticked
// --------------------
const fileDetailCells = new Map(); // rel => [{ tds: { title, rev, scale, size }, row }] in the current table
let fileDetailRun = 0;

const sameTitle = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const DETAIL_COLUMNS = { title: 'col-file-title', rev: 'col-file-rev', scale: 'col-file-scale', size: 'col-file-scale', project: 'col-file-project', client: 'col-file-project' };

// Title blocks are read while any detail column is shown, or the Project data or Revisions tab is open
function fileDetailsShown() {
  return fileDetailCheckboxes.some(([cb]) => cb.checked) || state.activeTab === 'project' || state.activeTab === 'revisions';
}

function renderFileDetails(tds, row) {
  for (const [field, td] of Object.entries(tds)) {
    const line = ['stack-top', 'stack-bottom'].find(c => td.classList.contains(c));
    td.className = `${DETAIL_COLUMNS[field]} file-detail file-${field}` + (line ? ` ${line}` : '');
    td.textContent = '';
    td.removeAttribute('title');
  }
  // Stacked: the register title above, its differences marked once the in-file title is known
  const titleText = tds.title.tagName === 'DIV' ? tds.title.parentElement.querySelector('.title-text') : null;
  if (titleText) titleText.textContent = row.title;
  // Stacked: the register's project and client above the drawing's
  const registerLines = {};
  for (const field of ['project', 'client']) {
    const line = tds[field].tagName === 'DIV' ? tds[field].previousElementSibling : null;
    if (!line) continue;
    const value = registerProjectValue(field);
    line.textContent = value || 'Not in the register';
    line.classList.toggle('none', !value);
    line.title = value ? `Register: ${value}` : '';
    registerLines[field] = line;
  }
  if (!row.rel || !/\.pdf$/i.test(row.rel)) return;
  const entry = state.fileDetails.get(absPath(row.rel));
  if (!entry) {
    tds.title.textContent = 'Reading…';
    tds.rev.textContent = tds.scale.textContent = tds.size.textContent = tds.project.textContent = tds.client.textContent = '…';
    for (const td of Object.values(tds)) td.classList.add('pending');
    return;
  }
  if (!entry.details) {
    tds.title.textContent = "Couldn't read file";
    tds.title.classList.add('none');
    return;
  }
  const { title, rev, scale, size } = entry.details;
  tds.rev.textContent = rev;
  for (const field of ['project', 'client']) {
    const value = entry.details[field] || '';
    tds[field].textContent = value;
    const problem = value && projectFieldProblem(field, value);
    if (problem) tds[field].classList.add('differs');
    const registerValue = registerProjectValue(field);
    tds[field].title = problem || (registerValue ? `Matches the register's "${registerValue}"` : '');
    if (problem && registerValue && registerLines[field]) {
      const [before, after] = markDifferences(registerValue, value);
      registerLines[field].replaceChildren(...before);
      tds[field].replaceChildren(...after);
    }
  }
  renderDetailCompare(tds.scale, row, 'scale', scale);
  renderDetailCompare(tds.size, row, 'size', size);
  if (!title) {
    tds.title.title = 'No title block found in this file';
    return;
  }
  tds.title.textContent = title;
  if (row.title && !sameTitle(title, row.title)) {
    tds.title.classList.add('differs');
    tds.title.title = `Differs from the register title: ${row.title}`;
    if (titleText) {
      const [before, after] = markDifferences(row.title, title);
      titleText.replaceChildren(...before);
      tds.title.replaceChildren(...after);
    }
  }
}

// Scale and size: compared ignoring spaces, case and order, so "1:50/1:20" matches "1:20 / 1:50"
function detailKey(field, value) {
  const v = (value || '').toUpperCase().replace(/\s+/g, '').replace(/N\.?T\.?S\.?/g, 'NTS');
  return field === 'scale' ? v.split(/[\/,&]|AND/).filter(Boolean).sort().join('/') : v;
}
const DETAIL_NAMES = { scale: 'scale', size: 'sheet size' };

function newEntryOf(row) {
  return row.isNew ? state.layout.newEntries.find(e => e.token === row.token) : null;
}

// The register's scale or size for a row's drawing, including a change not saved yet
function registerDetail(row, field) {
  const entry = newEntryOf(row);
  if (entry) return entry[field] || '';
  const edit = state.layout.detailEdits[row.origToken];
  if (edit && edit[field] !== undefined) return edit[field];
  return (state.registerDetails[row.origToken] || {})[field] || '';
}

function pendingDetailEdits() {
  const out = [];
  for (const token of Object.keys(state.tokenMap)) {
    const edit = state.layout.detailEdits[token];
    if (!edit) continue;
    for (const field of ['scale', 'size']) {
      const from = (state.registerDetails[token] || {})[field] || '';
      if (edit[field] !== undefined && edit[field] !== from) out.push({ token, field, from, to: edit[field] });
    }
  }
  return out;
}

async function setDetailEdit(row, field, value) {
  const entry = newEntryOf(row);
  if (entry) {
    entry[field] = value;
    return;
  }
  const token = row.origToken;
  const from = (state.registerDetails[token] || {})[field] || '';
  const edit = { ...state.layout.detailEdits[token] };
  if (value === null || value === from) delete edit[field];
  else edit[field] = value;
  if (Object.keys(edit).length) state.layout.detailEdits[token] = edit;
  else delete state.layout.detailEdits[token];
}

// A scale or size cell: the value read from the file, flagged when the register says otherwise,
// with an undo badge when the register value has been changed to match
function renderDetailCompare(td, row, field, value) {
  td.textContent = value;
  if (!row.token) return;
  const reg = registerDetail(row, field);
  const edit = !row.isNew && state.layout.detailEdits[row.origToken];
  if (edit && edit[field] !== undefined) {
    const original = (state.registerDetails[row.origToken] || {})[field] || '(blank)';
    const badge = document.createElement('button');
    badge.className = 'edit-badge';
    badge.textContent = 'edited ✕';
    badge.title = `Register: ${original} → ${edit[field]} (press ${saveButtonLabel()} to write it).\nClick to undo`;
    badge.addEventListener('click', async () => {
      await setDetailEdit(row, field, null);
      appendLog(`✏️ ${row.token}: ${DETAIL_NAMES[field]} back to the register's "${original}".`);
      await saveLayout();
      rebuild();
    });
    td.appendChild(badge);
  }
  if (value && detailKey(field, value) !== detailKey(field, reg)) {
    td.classList.add('differs');
    td.title = `Register: ${reg || '(blank)'}`;
    const note = document.createElement('div');
    note.className = 'register-value';
    note.textContent = `reg. ${reg || '(blank)'}`;
    td.appendChild(note);
  }
}

// < in the Scale header: the selected drawings' register scale and size become what their files
// say, as pending register edits
async function copyDetails() {
  if (!canEditRegister() || state.editingToken) return;
  const fields = ['scale', 'size'].filter(f => state.registerColumns[f]);
  const changes = [];
  let unread = 0;
  for (const row of selectedRows().filter(r => r.token)) {
    const read = row.rel && state.fileDetails.get(absPath(row.rel));
    if (!read || !read.details) {
      unread++;
      continue;
    }
    for (const field of fields) {
      const value = read.details[field];
      if (!value || detailKey(field, value) === detailKey(field, registerDetail(row, field))) continue;
      await setDetailEdit(row, field, value);
      changes.push(`${row.token} ${DETAIL_NAMES[field]} → ${value}`);
    }
  }
  const plural = n => n === 1 ? '1 drawing' : `${n} drawings`;
  if (changes.length) {
    await saveLayout();
    appendLog(`✏️ Register ${changes.length === 1 ? 'change' : 'changes'} from the drawings: ${changes.join(', ')} (press ${saveButtonLabel()} to write ${changes.length === 1 ? 'it' : 'them'}).`);
  } else {
    appendLog('ℹ️ The register already has the scale and size shown in the selected drawings.');
  }
  if (unread) appendLog(`ℹ️ ${plural(unread)} skipped: title block not read${fileDetailsShown() ? ' (yet)' : ''}.`);
  if (!state.registerColumns.scale || !state.registerColumns.size) {
    appendLog(`ℹ️ The register has no ${state.registerColumns.scale ? 'size' : 'scale'} column, so only the ${state.registerColumns.scale ? 'scale' : 'size'} can be updated.`);
  }
  rebuild();
}

// Reads the details of files not read yet or changed since; the table updates as each one arrives.
// Several files are read at once, each lane with its own pdf.js worker.
const FILE_DETAIL_LANES = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)); // more lanes gained nothing in testing

async function loadFileDetails() {
  if (!fileDetailsShown() || !state.targetDir) return;
  const run = ++fileDetailRun;
  // Stop if every checkbox is unticked, superseded by a newer run, or files are being renamed
  const stopped = () => run !== fileDetailRun || !fileDetailsShown() || state.busy;
  const queue = [...new Set(state.rows.filter(r => r.rel && /\.pdf$/i.test(r.rel)).map(r => r.rel))];
  const started = Date.now();
  let read = 0;

  const lane = async () => {
    let worker = null;
    try {
      while (queue.length && !stopped()) {
        const rel = queue.shift();
        const filePath = absPath(rel);
        const stats = await getStatsOrNull(filePath);
        if (!stats) continue;
        const stamp = `${stats.size}:${stats.modifiedAt}`;
        const cached = state.fileDetails.get(filePath);
        if (cached && cached.stamp === stamp) continue;
        if (!worker) worker = new PDFJS.PDFWorker();
        let details = null;
        try {
          details = await readFileDetails(filePath, worker);
        } catch (e) {
          // shown as unreadable in the table
        }
        state.fileDetails.set(filePath, { stamp, details });
        read++;
        for (const { tds, row, warn } of fileDetailCells.get(rel) || []) {
          renderFileDetails(tds, row);
          if (warn) renderRevisionWarning(warn, row);
        }
        // Without a register value, a drawing is checked against the others, so all may change
        renderProjectWarnings();
        renderProjectData();
        renderRevisionData();
      }
    } finally {
      if (worker) worker.destroy();
    }
  };
  await Promise.all(Array.from({ length: FILE_DETAIL_LANES }, lane));
  if (read > 1 && !stopped()) appendLog(`📄 Read the title blocks of ${read} drawings in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

// < : the selected drawings take the title read from their file, as pending register edits
// > : the selected drawings go back to the title in the register, dropping any edit
async function copyTitles(fromFiles) {
  if (!canEditRegister() || state.editingToken) return;
  const rows = selectedRows().filter(r => r.token);
  let changed = 0, unread = 0;
  for (const row of rows) {
    const entry = row.isNew && state.layout.newEntries.find(e => e.token === row.token);
    if (!fromFiles) {
      // New entries have no register title to go back to
      if (!row.isNew && state.layout.titleEdits[row.origToken] !== undefined) {
        delete state.layout.titleEdits[row.origToken];
        changed++;
      }
      continue;
    }
    const read = row.rel && state.fileDetails.get(absPath(row.rel));
    const title = read && read.details && read.details.title;
    if (!title) {
      unread++;
      continue;
    }
    if (title === row.title) continue;
    if (entry) entry.title = title;
    else if (title === state.tokenMap[row.origToken]) delete state.layout.titleEdits[row.origToken];
    else state.layout.titleEdits[row.origToken] = title;
    changed++;
  }
  const plural = n => n === 1 ? '1 drawing' : `${n} drawings`;
  if (changed) {
    await saveLayout();
    appendLog(fromFiles
      ? `✏️ ${plural(changed)} now use the in-file title (press ${saveButtonLabel()} to write them to the register).`
      : `✏️ ${plural(changed)} back to the register title.`);
  } else {
    appendLog(fromFiles ? 'ℹ️ The selected drawings already use their in-file titles.' : 'ℹ️ The selected drawings already use the register title.');
  }
  if (unread) appendLog(`ℹ️ ${plural(unread)} skipped: no in-file title${fileDetailsShown() ? ' (yet)' : ''}.`);
  rebuild();
}

// --------------------
// Tabs and the Project data tab
// --------------------
function switchTab(name) {
  state.activeTab = name;
  for (const btn of tabButtons) btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.dataset.panel !== name;
  if (name === 'project') {
    renderProjectData();
    loadFileDetails();
  }
  if (name === 'revisions') {
    renderRevisionData(true);
    loadFileDetails();
  }
}

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

// Distinct values of a title block field across the drawings: [{ value, drawings: [label] }], most common first
function drawingValues(field) {
  const byValue = new Map();
  const seen = new Set();
  for (const row of state.rows) {
    if (!row.rel || seen.has(row.rel)) continue;
    seen.add(row.rel);
    const entry = state.fileDetails.get(absPath(row.rel));
    const value = entry && entry.details && entry.details[field];
    if (!value) continue;
    const key = value.toUpperCase();
    if (!byValue.has(key)) byValue.set(key, { value, drawings: [] });
    byValue.get(key).drawings.push(row.token || row.file);
  }
  return [...byValue.values()].sort((a, b) => b.drawings.length - a.drawings.length);
}

// One field's values in the drawings, each marked against the register's value when there is one
function renderDrawingValues(parent, title, field, registerValue) {
  const values = drawingValues(field);
  parent.appendChild(el('h4', title));
  const list = el('ul', undefined, 'project-values');
  if (!values.length) list.appendChild(el('li', 'Not found in any drawing read so far', 'muted'));
  for (const { value, drawings } of values) {
    const li = el('li');
    let mark;
    if (registerValue) {
      // The wording must be the same; only case (drawings often use capitals) and spacing may differ
      const ok = sameTitle(registerValue, value);
      mark = el('span', ok ? '✓ ' : '⚠ ', ok ? 'ok' : 'warn');
      li.title = (ok ? 'Matches' : "Doesn't match") + ` the register's "${registerValue}"\n` + drawings.join('\n');
    } else {
      mark = el('span', values.length > 1 ? '⚠ ' : '', 'warn');
      li.title = (values.length > 1 ? `The drawings name ${values.length} different ${title.toLowerCase()}s\n` : '') + drawings.join('\n');
    }
    li.append(mark, value, el('span', ` — ${drawings.length === 1 ? '1 drawing' : drawings.length + ' drawings'}`, 'muted'));
    list.appendChild(li);
  }
  parent.appendChild(list);
}

// Register header fields changed in the Project data tab and not saved yet: [{ label, from, to }]
function pendingProjectEdits() {
  const fields = (state.registerProject || { fields: [] }).fields;
  return Object.entries(state.layout.projectEdits)
    .map(([label, to]) => ({ label, to, field: fields.find(f => f.label === label) }))
    .filter(e => e.field && e.to !== e.field.value)
    .map(e => ({ label: e.label, from: e.field.value, to: e.to }));
}

function projectValue(field) {
  const edit = state.layout.projectEdits[field.label];
  return edit !== undefined ? edit : field.value;
}

async function setProjectEdit(field, value) {
  const to = value === null ? field.value : value.replace(/\s+/g, ' ').trim();
  if (to === field.value) delete state.layout.projectEdits[field.label];
  else state.layout.projectEdits[field.label] = to;
  appendLog(to === field.value
    ? `🗂️ ${field.label}: back to the register's "${field.value}".`
    : `🗂️ ${field.label}: "${field.value}" → "${to}" (press ${saveButtonLabel()} to write it to the register).`);
  await saveLayout();
  updateButtons();
  renderProjectData(true);
  renderProjectWarnings();
}

// The register's header fields, each an input when the register can be written to
function renderProjectFields(section) {
  const project = state.registerProject;
  section.appendChild(el('h4', `Register: ${baseName(state.registerPath)}${state.registerInfo ? ` (${state.registerInfo})` : ''}`));
  if (!project || !project.fields.length) {
    section.appendChild(el('p', state.registerKind === 'pdf'
      ? 'Project details are only read from Word and Excel registers.'
      : 'No project details found at the top of the register.', 'muted'));
    return;
  }
  const editable = canEditRegister() && !state.busy;
  const dl = el('dl');
  for (const field of project.fields) {
    const dd = el('dd');
    const input = el('input', undefined, 'project-input');
    input.value = projectValue(field);
    input.disabled = !editable;
    input.spellcheck = false;
    input.title = editable ? `In the register: ${field.value || '(blank)'}` : 'Project details can only be changed in a Word or Excel register';
    const edited = state.layout.projectEdits[field.label] !== undefined && state.layout.projectEdits[field.label] !== field.value;
    if (edited) input.classList.add('edited');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = projectValue(field);
        input.blur();
      }
    });
    input.addEventListener('change', () => setProjectEdit(field, input.value));
    dd.appendChild(input);
    if (edited) {
      const undo = el('button', 'edited ✕', 'edit-badge');
      undo.title = `Register: ${field.value || '(blank)'}\nClick to undo`;
      undo.addEventListener('click', () => setProjectEdit(field, null));
      dd.appendChild(undo);
    }
    dl.append(el('dt', field.label), dd);
  }
  if (project.description.length) {
    const dd = el('dd', project.description.join('\n'), 'muted');
    dd.style.whiteSpace = 'pre-line';
    dd.title = 'Read only';
    dl.append(el('dt', 'Description'), dd);
  }
  if (project.client && !project.fields.some(f => f.key === 'client')) {
    const dd = el('dd', project.client, 'muted');
    dd.title = "From the description's \"For ...\" line; read only";
    dl.append(el('dt', 'Client'), dd);
  }
  section.appendChild(dl);
}

// The register's project or client (including unsaved edits), or '' when it doesn't have one
function registerProjectValue(key) {
  const project = state.registerProject;
  if (!project) return '';
  const field = project.fields.find(f => f.key === key);
  return field ? projectValue(field) : key === 'client' ? project.client : '';
}

// A drawing's project and client problems for the table's Status column: a title block value that
// doesn't match the register's, or, when the register has none, differs from most drawings'.
// Empty until the title block has been read.
function projectWarnings(row) {
  const entry = row.rel && state.fileDetails.get(absPath(row.rel));
  const details = entry && entry.details;
  if (!details) return [];
  return ['project', 'client'].map(field => details[field] && projectFieldProblem(field, details[field])).filter(Boolean);
}

// Why a title block's project or client value is flagged, or '' when it isn't
function projectFieldProblem(field, value) {
  const name = field === 'project' ? 'Project' : 'Client';
  const registerValue = registerProjectValue(field);
  // The wording must be the same; only case (drawings often use capitals) and spacing may differ
  if (registerValue) return sameTitle(registerValue, value) ? '' : `${name} "${value}" doesn't match the register's "${registerValue}"`;
  const values = drawingValues(field);
  return values.length > 1 && values[0].value.toUpperCase() !== value.toUpperCase()
    ? `${name} "${value}" differs from most drawings' "${values[0].value}"` : '';
}

function renderProjectWarning(span, row) {
  const problems = projectWarnings(row);
  span.hidden = !problems.length;
  span.textContent = problems.length ? '⚠' : '';
  span.title = problems.join('\n');
}

// The status icons, and the project and client cells, which are compared with the register's
// values or, without them, with the other drawings'
function renderProjectWarnings() {
  for (const cells of fileDetailCells.values()) {
    for (const { tds, row, projectWarn } of cells) {
      if (projectWarn) renderProjectWarning(projectWarn, row);
      if (fileProjectCheckbox.checked) renderFileDetails(tds, row);
    }
  }
}

// What the drawings' title blocks say, marked against the register (including unsaved edits)
function renderProjectDrawings(section) {
  const project = state.registerProject;
  const pdfs = new Set(state.rows.filter(r => r.rel && /\.pdf$/i.test(r.rel)).map(r => r.rel));
  const read = [...pdfs].filter(rel => state.fileDetails.has(absPath(rel))).length;
  renderDrawingValues(section, 'Project', 'project', registerProjectValue('project'));
  renderDrawingValues(section, 'Client', 'client', registerProjectValue('client'));
  section.appendChild(el('p', read < pdfs.size
    ? `Reading title blocks… ${read} of ${pdfs.size} drawings`
    : `From the title blocks of ${pdfs.size} drawing${pdfs.size === 1 ? '' : 's'}. Hover a value to see which.`, 'muted'));
}

// Redraws the tab. The register fields are left alone while one is being typed in (the drawings'
// side still updates as title blocks are read), unless `fields` asks for them too.
function renderProjectData(fields = false) {
  if (state.activeTab !== 'project') return;
  if (!state.registerPath) {
    projectDataEl.className = 'muted';
    projectDataEl.textContent = 'No register loaded.';
    return;
  }
  projectDataEl.className = '';
  let grid = projectDataEl.querySelector('.project-grid');
  if (!grid) {
    projectDataEl.textContent = '';
    grid = el('div', undefined, 'project-grid');
    grid.append(el('section', undefined, 'project-fields'), el('section', undefined, 'project-drawings'));
    projectDataEl.appendChild(grid);
    fields = true;
  }
  const left = grid.querySelector('.project-fields');
  const typing = left.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (fields || !typing) {
    left.textContent = '';
    renderProjectFields(left);
  }
  const right = grid.querySelector('.project-drawings');
  right.textContent = '';
  renderProjectDrawings(right);
}

// --------------------
// Revisions tab: a new issue (the next date column, dated today) or the latest issue re-dated to
// today, with each selected drawing's mark, and the Issue No / Date at the top of the register
// --------------------
function todayParts() {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}
const isoOf = t => `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
const shortDate = c => (c && c.date ? `${c.day.padStart(2, '0')}.${c.month.padStart(2, '0')}.${c.year}` : '');

// Register header fields the issue changes, or undefined
function headerField(key) {
  return ((state.registerProject || { fields: [] }).fields || []).find(f => f.key === key);
}

// Whether the register marks drawings with ticks ("/") rather than revision codes
function registerUsesTicks() {
  const marks = Object.values((state.registerIssues || { marks: {} }).marks).flat().filter(Boolean);
  return marks.length > 0 && marks.every(m => !/[A-Za-z0-9]/.test(m));
}

// The issue the Revisions tab would make: { mode, index, sameDay, column, latestColumn } or null
function issueTarget(mode) {
  const info = state.registerIssues;
  if (!info || !info.columns.length) return null;
  const latest = info.columns[info.latest] || null;
  const sameDay = !!latest && latest.date === isoOf(todayParts());
  if (sameDay || mode === 'update') return latest ? { mode: 'update', index: info.latest, sameDay, column: latest, latestColumn: latest } : null;
  const next = info.columns[info.latest + 1];
  return next ? { mode: 'new', index: info.latest + 1, sameDay, column: next, latestColumn: latest } : null;
}

function describeIssue(issue) {
  const date = [issue.date.day, issue.date.month, issue.date.year].join('.');
  const text = issue.mode === 'new' ? `New issue in column ${issue.index + 1}, dated ${date}` : `Issue in column ${issue.index + 1} dated ${date}`;
  return text + (issue.highlight ? `, highlighted #${issue.highlight}` : '');
}

function pendingIssue() {
  const issue = state.layout.issueEdit;
  return issue && (!issue.register || issue.register === baseName(state.registerPath)) &&
    canEditRegister() && state.registerIssues && state.registerIssues.columns[issue.index] ? issue : null;
}

// A drawing's marks before column `index`: { prev, prevDate } (the last one), and the mark already in it
function previousMark(token, index) {
  const info = state.registerIssues;
  const marks = (info.marks[token] || []);
  for (let i = index - 1; i >= 0; i--) {
    if (marks[i]) return { prev: marks[i], prevDate: shortDate(info.columns[i]), current: marks[index] || '' };
  }
  return { prev: '', prevDate: '', current: marks[index] || '' };
}

function inFileRevision(row) {
  const entry = row.rel && state.fileDetails.get(absPath(row.rel));
  return (entry && entry.details && entry.details.rev) || '';
}

// The mark a drawing gets by default: the revision in its title block, or the one after its last
// issue; with a tick register, the tick it used before
function defaultMark(row, index) {
  const { prev } = previousMark(row.origToken, index);
  if (registerUsesTicks()) return prev || '/';
  return inFileRevision(row) || RegisterCore.nextRevision(prev);
}

// Problems with a drawing's mark: [text]; empty when it's fine
function markProblems(row, mark, index) {
  const { prev, prevDate } = previousMark(row.origToken, index);
  if (!mark) return ['No mark, so the drawing is left out of this issue'];
  if (registerUsesTicks()) return [];
  const problems = [];
  const inFile = inFileRevision(row);
  if (inFile && inFile.toUpperCase() !== mark.toUpperCase()) problems.push(`The drawing's title block says ${inFile}`);
  if (prev && !RegisterCore.revisionFollows(prev, mark)) {
    problems.push(prev.toUpperCase() === mark.toUpperCase()
      ? `Same as issued on ${prevDate}`
      : `Doesn't follow ${prev} (issued ${prevDate}); expected ${RegisterCore.nextRevision(prev)}`);
  }
  return problems;
}

// Revision problems to flag in the table's Status column: for a drawing in the staged issue, its
// mark's problems; otherwise a title block revision that doesn't follow the last one issued (the
// same one means it hasn't been revised since). Empty until the title block has been read.
function revisionWarnings(row) {
  const info = state.registerIssues;
  if (!info || !info.columns.length || !row.token || !row.rel || row.isNew || !info.marks[row.origToken]) return [];
  const staged = pendingIssue();
  if (staged && staged.marks[row.origToken] !== undefined) {
    return markProblems(row, staged.marks[row.origToken], staged.index).map(p => `In the staged issue: ${p}`);
  }
  if (registerUsesTicks()) return [];
  const inFile = inFileRevision(row);
  const { prev: last, prevDate } = previousMark(row.origToken, info.columns.length);
  if (!inFile || !last || inFile.toUpperCase() === last.toUpperCase() || RegisterCore.revisionFollows(last, inFile)) return [];
  return [`The title block says ${inFile}, which doesn't follow ${last} (last issued ${prevDate}); expected ${last} or ${RegisterCore.nextRevision(last)}`];
}

function renderRevisionWarning(div, row) {
  const problems = revisionWarnings(row);
  div.hidden = !problems.length;
  div.textContent = problems.length ? '⚠ revision' : '';
  div.title = problems.join('\n');
}

// Drawings in the issue: the selected rows that are in the register and have a file here
function issueRows() {
  const seen = new Set();
  return selectedRows().filter(r => r.token && r.rel && !r.isNew && state.registerIssues.marks[r.origToken] && !seen.has(r.origToken) && seen.add(r.origToken));
}

function revisionChoices() {
  const issueNo = headerField('issueNo');
  const date = headerField('date');
  if (!state.revisionUi) state.revisionUi = { mode: 'new', scheme: null, dateFormat: null, highlight: null, color: null, marks: {} };
  const ui = state.revisionUi;
  if (!ui.scheme) ui.scheme = (issueNo && RegisterCore.detectNumbering(issueNo.value)) || 'number';
  if (!ui.dateFormat) ui.dateFormat = (date && RegisterCore.detectDateFormat(date.value)) || 'dd.mm.yyyy';
  // Highlight the issue column when the register already highlights its latest one, in that colour
  const inUse = state.registerIssues && state.registerIssues.highlight;
  if (ui.highlight === null) ui.highlight = !!inUse;
  if (!ui.color) ui.color = '#' + (inUse || 'FFFF00');
  return ui;
}

function select(options, value, onChange) {
  const sel = el('select');
  for (const [v, label] of options) {
    const opt = el('option', label);
    opt.value = v;
    opt.selected = v === value;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// Redraws the tab, except while a mark is being typed (unless `force`)
function renderRevisionData(force = false) {
  if (state.activeTab !== 'revisions') return;
  if (!force && revisionDataEl.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  revisionDataEl.textContent = '';
  revisionDataEl.className = '';
  const info = state.registerIssues;
  if (!state.registerPath || !info) {
    revisionDataEl.className = 'muted';
    revisionDataEl.textContent = !state.registerPath ? 'No register loaded.' : 'Issues are only read from Word and Excel registers.';
    return;
  }
  if (!info.columns.length) {
    revisionDataEl.className = 'muted';
    revisionDataEl.textContent = 'No Day / Month / Year issue rows found in the register.';
    return;
  }
  const ui = revisionChoices();
  const today = todayParts();
  const latest = info.columns[info.latest];
  const target = issueTarget(ui.mode);
  const issueNo = headerField('issueNo');
  const dateField = headerField('date');
  const staged = pendingIssue();
  const editable = canEditRegister() && !state.busy;

  const grid = el('div', undefined, 'revision-grid');
  const left = el('section');
  left.appendChild(el('h4', 'Issue'));
  left.appendChild(el('p', latest
    ? `Latest issue: ${shortDate(latest)} (column ${info.latest + 1} of ${info.columns.length})${issueNo ? ` · ${issueNo.label} ${issueNo.value}` : ''}`
    : `No issues yet (${info.columns.length} columns)`, 'muted'));

  // New issue / update the latest
  const modes = el('div', undefined, 'revision-modes');
  const addMode = (value, label, disabled, note) => {
    const lbl = el('label', undefined, 'option');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'issue-mode';
    radio.checked = (target && target.mode) === value;
    radio.disabled = disabled || !editable;
    radio.addEventListener('change', () => { ui.mode = value; renderRevisionData(true); });
    lbl.append(radio, ` ${label}`);
    if (note) lbl.appendChild(el('span', ` ${note}`, 'muted'));
    modes.appendChild(lbl);
  };
  const todayShort = RegisterCore.formatDate(today, 'dd.mm.yy');
  if (latest && latest.date === isoOf(today)) {
    addMode('update', `Add to today's issue (column ${info.latest + 1}, ${todayShort})`, false);
  } else {
    const free = info.columns[info.latest + 1];
    addMode('new', 'Create a new issue', !free, free ? `column ${info.latest + 2}, dated ${todayShort}` : '(no free column left)');
    addMode('update', 'Update the latest issue to today', !latest, latest ? `column ${info.latest + 1}: ${shortDate(latest)} → ${todayShort}` : '');
  }
  left.appendChild(modes);

  // Issue number and date formats
  const dl = el('dl');
  if (issueNo) {
    const schemeLabels = { number: '1, 2, 3', ordinal: '1st, 2nd, 3rd', letter: 'A, B, C' };
    const detected = RegisterCore.detectNumbering(issueNo.value);
    const dd = el('dd');
    const sel = select(RegisterCore.NUMBERING_SCHEMES.map(sc => [sc, schemeLabels[sc] + (sc === detected ? ' (in use)' : '')]), ui.scheme, v => { ui.scheme = v; renderRevisionData(true); });
    sel.disabled = !editable;
    const next = target && target.mode === 'new' ? RegisterCore.nextIssueNumber(issueNo.value, ui.scheme) : issueNo.value;
    dd.append(sel, el('span', target && target.mode === 'new' ? `${issueNo.value} → ${next}` : `stays ${issueNo.value}`, 'muted'));
    dl.append(el('dt', 'Issue numbering'), dd);
  }
  if (dateField) {
    const detected = RegisterCore.detectDateFormat(dateField.value);
    const dd = el('dd');
    const sel = select(RegisterCore.DATE_FORMATS.map(f => [f.id, RegisterCore.formatDate(today, f.id) + (f.id === detected ? ' (in use)' : '')]), ui.dateFormat, v => { ui.dateFormat = v; renderRevisionData(true); });
    sel.disabled = !editable;
    dd.append(sel, el('span', `${dateField.value || '(blank)'} → ${RegisterCore.formatDate(today, ui.dateFormat)}`, 'muted'));
    dl.append(el('dt', 'Date format'), dd);
  }
  {
    const inUse = info.highlight;
    const dd = el('dd');
    const lbl = el('label', undefined, 'option');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = ui.highlight;
    box.disabled = !editable;
    box.addEventListener('change', () => { ui.highlight = box.checked; renderRevisionData(true); });
    lbl.append(box, ' Highlight the issue column');
    const picker = el('input', undefined, 'highlight-color');
    picker.type = 'color';
    picker.value = ui.color.toLowerCase();
    picker.disabled = !editable || !ui.highlight;
    picker.title = 'Highlight colour';
    picker.addEventListener('change', () => { ui.color = picker.value; renderRevisionData(true); });
    dd.append(lbl, picker, el('span', inUse
      ? `in use: #${inUse}${target && target.mode === 'new' ? ', moves from the last issue' : ''}`
      : 'not used in this register', 'muted'));
    dl.append(el('dt', 'Highlight'), dd);
  }
  if (!issueNo || !dateField) left.appendChild(el('p', `The register has no ${[!issueNo && 'Issue No', !dateField && 'Date'].filter(Boolean).join(' or ')} field at the top, so that isn't updated.`, 'muted'));
  left.appendChild(dl);

  // Stage / cancel
  const actions = el('div', undefined, 'revision-actions');
  const rows = target ? issueRows() : [];
  const stage = el('button', staged ? 'Replace the staged issue' : 'Add to register edits', 'secondary');
  stage.disabled = !editable || !target;
  stage.title = `Stage this issue; press ${saveButtonLabel()} to write it to the register`;
  stage.addEventListener('click', () => stageIssue(target, rows));
  actions.appendChild(stage);
  if (staged) {
    const cancel = el('button', 'Cancel staged issue');
    cancel.addEventListener('click', unstageIssue);
    actions.append(cancel, el('span', `Staged: ${describeIssue(staged)}, ${Object.keys(staged.marks).length} drawing(s). Press ${saveButtonLabel()} to write it.`, 'muted'));
  }
  left.appendChild(actions);

  // The drawings in the issue
  const right = el('section');
  right.appendChild(el('h4', `Drawings in this issue (${rows.length} selected)`));
  if (!target) right.appendChild(el('p', 'There is no issue column to use.', 'muted'));
  else if (!rows.length) right.appendChild(el('p', 'Select drawings with files in the table to put them in the issue.', 'muted'));
  else {
    const table = el('table', undefined, 'revision-table');
    const head = el('tr');
    for (const h of ['Drawing', 'Last issued', 'In file', target.mode === 'new' ? 'New mark' : 'Mark', '']) head.appendChild(el('th', h));
    table.appendChild(el('thead')).appendChild(head);
    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      const { prev, prevDate, current } = previousMark(row.origToken, target.index);
      const typed = ui.marks[row.origToken];
      const mark = typed !== undefined ? typed : defaultMark(row, target.index);
      tr.appendChild(el('td', row.token, 'number'));
      tr.appendChild(el('td', prev ? `${prev} (${prevDate})` : '—'));
      tr.appendChild(el('td', inFileRevision(row) || '—'));
      const markTd = el('td');
      const input = el('input', undefined, 'mark-input');
      input.value = mark;
      input.disabled = !editable;
      input.spellcheck = false;
      if (current && target.mode === 'update') input.title = `Currently ${current}`;
      input.addEventListener('change', () => { ui.marks[row.origToken] = input.value.trim(); renderRevisionData(true); });
      markTd.appendChild(input);
      tr.appendChild(markTd);
      const problems = markProblems(row, mark, target.index);
      const check = el('td', problems.length ? `⚠ ${problems.join('; ')}` : (prev || registerUsesTicks() ? '✓' : '✓ first issue'), problems.length ? 'warn' : 'ok');
      tr.appendChild(check);
      body.appendChild(tr);
    }
    table.appendChild(body);
    right.appendChild(table);
  }
  grid.append(left, right);
  revisionDataEl.appendChild(grid);
}

// Turns the Revisions tab's choices into a staged register edit (plus the Issue No / Date header edits)
async function stageIssue(target, rows) {
  if (!target) return;
  const ui = revisionChoices();
  const today = todayParts();
  const two = n => String(n).padStart(2, '0');
  const marks = {};
  for (const row of rows) {
    const typed = ui.marks[row.origToken];
    const mark = (typed !== undefined ? typed : defaultMark(row, target.index)).trim();
    if (mark) marks[row.origToken] = mark;
  }
  // Undo the header edits of an issue staged before
  if (state.layout.issueEdit) {
    for (const [label, value] of Object.entries(state.layout.issueEdit.header || {})) {
      if (state.layout.projectEdits[label] === value) delete state.layout.projectEdits[label];
    }
  }
  const header = {};
  const issueNo = headerField('issueNo');
  if (issueNo && target.mode === 'new') header[issueNo.label] = RegisterCore.nextIssueNumber(issueNo.value, ui.scheme);
  const dateField = headerField('date');
  if (dateField) header[dateField.label] = RegisterCore.formatDate(today, ui.dateFormat);
  for (const [label, value] of Object.entries(header)) {
    const field = state.registerProject.fields.find(f => f.label === label);
    if (value === field.value) delete header[label];
    else state.layout.projectEdits[label] = value;
  }
  state.layout.issueEdit = {
    mode: target.mode, index: target.index,
    date: { day: two(today.d), month: two(today.m), year: two(today.y % 100) },
    marks, header,
    register: baseName(state.registerPath),
    highlight: ui.highlight ? ui.color.replace('#', '').toUpperCase() : null
  };
  const problems = rows.filter(r => markProblems(r, marks[r.origToken] || '', target.index).length).map(r => r.token);
  appendLog(`📅 Staged: ${describeIssue(state.layout.issueEdit)} with ${Object.keys(marks).length} drawing(s)` +
    (Object.keys(header).length ? `; ${Object.entries(header).map(([l, v]) => `${l} → ${v}`).join(', ')}` : '') +
    ` (press ${saveButtonLabel()} to write it).`);
  if (problems.length) appendLog(`⚠️ Check the revisions of ${problems.join(', ')} in the Revisions tab.`);
  await saveLayout();
  rebuild();
  renderRevisionData(true);
}

async function unstageIssue() {
  const issue = state.layout.issueEdit;
  if (!issue) return;
  for (const [label, value] of Object.entries(issue.header || {})) {
    if (state.layout.projectEdits[label] === value) delete state.layout.projectEdits[label];
  }
  state.layout.issueEdit = null;
  appendLog('↩️ Cancelled the staged issue.');
  await saveLayout();
  rebuild();
  renderRevisionData(true);
}

// Checks a saved-to-be register (read back) has the staged issue: '' when it does
function issueReadBackProblem(issue, info, newNumber, notFound) {
  const column = info.columns[issue.index];
  const want = `20${issue.date.year}-${issue.date.month}-${issue.date.day}`;
  if (!column || column.date !== want) return `issue column ${issue.index + 1} didn't read back as ${[issue.date.day, issue.date.month, issue.date.year].join('.')}`;
  const wrong = Object.entries(issue.marks)
    .filter(([token, mark]) => !notFound.includes(token) && ((info.marks[newNumber(token)] || [])[issue.index] || '') !== mark)
    .map(([token]) => token);
  if (wrong.length) return `the marks didn't read back as expected for ${wrong.join(', ')}`;
  return issue.highlight && info.highlight !== issue.highlight ? `the highlight didn't read back as #${issue.highlight}` : '';
}

function logIssueSaved(issue, applied, notFound, how) {
  if (applied.date) appendLog(`📅 ${describeIssue(issue)}${how}`);
  for (const [token, { from, to }] of Object.entries(applied.marks)) appendLog(`📅 ${token}: ${from ? `"${from}" → ` : ''}"${to}"${how}`);
  for (const token of notFound) appendLog(`⚠️ ${token} wasn't found in the register, so it wasn't marked.`);
}

function render(newFiles) {
  // Don't throw away a title the user is typing; renderAfterEdit() catches up
  if (state.editingToken) {
    state.renderPending = true;
    return;
  }
  rowsEl.textContent = '';
  fileDetailCells.clear();
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
  const added = pendingNewEntries().length;
  const parts = [
    `${entries} register entries` + (added ? ` + ${added} new` : ''),
    `${count('rename') + count('supersede')} to rename`,
    `${count('ok')} already named`,
    `${count('unmatched')} unmatched`
  ];
  if (count('move')) parts.push(`${count('move')} to move`);
  if (count('none')) parts.push(`${count('none')} missing`);
  if (count('supersede')) parts.push(`${count('supersede')} replacing older files`);
  if (count('conflict')) parts.push(`${count('conflict')} conflicts`);
  summaryEl.textContent = parts.join(' · ');

  renderProjectData();
  renderRevisionData();
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

// Register numbers in order, with pending row moves applied
function applyMoves(order, moves) {
  const out = order.slice();
  for (const { token, after } of moves) {
    const from = out.indexOf(token);
    if (from < 0 || token === after) continue;
    out.splice(from, 1);
    if (after === '') out.unshift(token);
    else {
      const i = out.indexOf(after);
      out.splice(i < 0 ? out.length : i + 1, 0, token);
    }
  }
  return out;
}

function registerOrder() {
  return applyMoves(Object.keys(state.tokenMap), state.layout.moves);
}

// Row moves that change the register's order (none if the rows are back where they started)
function pendingMoves() {
  const moves = state.layout.moves.filter(m => m.token in state.tokenMap && (m.after === '' || m.after in state.tokenMap));
  const original = Object.keys(state.tokenMap);
  return applyMoves(original, moves).join('|') === original.join('|') ? [] : moves;
}

// Register titles with any edits made in the app applied, in the order rows will be in (moves
// applied, new entries placed after the drawing they'll be inserted after)
function effectiveTitles() {
  const titles = {};
  const pending = pendingNewEntries();
  const addAfter = (token) => {
    for (const e of pending) if (e.after === token && !(e.token in titles)) titles[e.token] = e.title;
  };
  state.origOf = {};
  addAfter('');
  for (const token of registerOrder()) {
    const title = state.tokenMap[token];
    const edit = state.layout.titleEdits[token];
    const shown = state.layout.numberEdits[token] || token;
    titles[shown] = edit && edit !== title ? edit : title;
    state.origOf[shown] = token;
    addAfter(token);
  }
  for (const e of pending) if (!(e.token in titles)) titles[e.token] = e.title;
  return titles;
}

// Drop old numbers from the history once no PDF is named with them (apart from a file already
// renamed for a drawing that now has that number). Returns whether anything was dropped.
function expireNumberHistory(files) {
  const history = state.layout.numberHistory;
  const olds = Object.keys(history);
  if (!olds.length) return false;
  const longest = RegisterCore.makeMatcher([...new Set([...Object.keys(state.titles), ...olds])]);
  let changed = false;
  for (const old of olds) {
    const renamed = old in state.titles ? newNameFor(old, state.titles).toLowerCase() : null;
    const inUse = files.some(f => f.name.toLowerCase().endsWith('.pdf') && longest(f.name) === old && f.name.toLowerCase() !== renamed);
    if (!inUse) {
      delete history[old];
      changed = true;
    }
  }
  return changed;
}

// Numbers the register's drawings will have once pending renumberings are saved
function registerNumbers() {
  return new Set(Object.keys(state.tokenMap).map(t => state.layout.numberEdits[t] || t));
}

// New entries that aren't in the register yet
function pendingNewEntries() {
  const numbers = registerNumbers();
  return state.layout.newEntries.filter(e => !numbers.has(e.token));
}

// The register and its PDF, which aren't drawings
function registerRels() {
  return [baseName(state.registerPath), baseName(registerPdfPath())];
}

// Renumbered drawings: [{ token: number in the register, to: new number }]
function pendingNumberEdits() {
  return Object.keys(state.tokenMap)
    .filter(t => state.layout.numberEdits[t] && state.layout.numberEdits[t] !== t)
    .map(t => ({ token: t, to: state.layout.numberEdits[t] }));
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
  state.movedTokens = new Set(pendingMoves().map(m => m.token));
  state.match = matchFiles(state.titles, state.files, registerRels());
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
      appendLog(`📘 Loaded ${Object.keys(state.tokenMap).length} drawing entries from register${state.registerInfo ? ` (${state.registerInfo})` : ''}.`);
      // Edits and new entries the register now contains are done with
      const done = Object.keys(state.layout.titleEdits).filter(t => state.tokenMap[t] === state.layout.titleEdits[t]);
      const added = state.layout.newEntries.filter(e => e.token in state.tokenMap && !state.layout.numberEdits[e.token]);
      // A renumbering can't apply once its old number is gone from the register (saved ones are
      // cleared when they're saved)
      const renumbered = Object.keys(state.layout.numberEdits).filter(t => !(t in state.tokenMap));
      const detailsDone = [];
      for (const [t, edit] of Object.entries(state.layout.detailEdits)) {
        for (const field of Object.keys(edit)) {
          if (!(t in state.tokenMap) || edit[field] === ((state.registerDetails[t] || {})[field] || '')) detailsDone.push([t, field]);
        }
      }
      const fieldValue = label => (((state.registerProject || { fields: [] }).fields.find(f => f.label === label)) || {}).value;
      const projectDone = Object.keys(state.layout.projectEdits).filter(label => [undefined, state.layout.projectEdits[label]].includes(fieldValue(label)));
      if (done.length || added.length || renumbered.length || detailsDone.length || projectDone.length) {
        for (const label of projectDone) delete state.layout.projectEdits[label];
        for (const t of done) delete state.layout.titleEdits[t];
        for (const [t, field] of detailsDone) {
          delete state.layout.detailEdits[t][field];
          if (!Object.keys(state.layout.detailEdits[t]).length) delete state.layout.detailEdits[t];
        }
        for (const t of renumbered) delete state.layout.numberEdits[t];
        state.layout.moves = state.layout.moves.filter(m => m.token in state.tokenMap);
        state.layout.newEntries = state.layout.newEntries.filter(e => !added.includes(e));
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
    state.titles = effectiveTitles();
    if (expireNumberHistory(files)) await saveLayout();
    state.match = matchFiles(state.titles, files, registerRels());
    // Arrival times are only needed to pick a default when several files match one drawing
    state.addedTimes = {};
    for (const group of Object.values(state.match.byToken)) {
      if (group.length < 2) continue;
      for (const f of group) {
        state.addedTimes[f.rel] = addedTime(await getStatsOrNull(absPath(f.rel)));
      }
    }
    if (await pruneResetFolders()) {
      await saveLayout();
      state.files = state.files.filter(f => !f.dir || state.layout.folders.includes(f.dir));
    }
    rebuild(newFiles);
    loadFileDetails();
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
      editingToken: null,
      revisionUi: null
    });
    state.unchecked.clear();
    state.picked.clear();
    state.choices.clear();
    await loadLayout();
    appendLog(`📚 Reading ${REGISTER_KIND_NAMES[state.registerKind]} register: ${registerPath} ...`);
    if (state.registerKind !== 'docx' && await findWordTwin()) {
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
async function askWordOptions(edits, additions, numbers, movedCount, details = [], project = [], issue = null) {
  const excel = state.registerKind === 'xlsx';
  const wordOk = excel ? await checkExcelAvailable() : await checkWordAvailable();
  const pdfTarget = excel ? await excelPdfPath() : registerPdfPath();
  // Excel has no tracked changes
  document.getElementById('word-tracked').closest('label').hidden = excel;
  document.getElementById('word-export-label').textContent = `Also update the register PDF using ${registerAppName()}`;
  const total = edits.length + additions.length + numbers.length + movedCount + details.length + project.length + (issue ? 1 : 0);
  document.getElementById('word-dialog-title').textContent =
    `Save ${total === 1 ? '1 change' : total + ' changes'} to ${baseName(state.registerPath)}`;
  const list = document.getElementById('word-changes');
  list.textContent = '';
  for (const e of additions) {
    const li = document.createElement('li');
    const num = document.createElement('b');
    num.textContent = e.token;
    const title = document.createElement('ins');
    title.textContent = e.title;
    const where = document.createElement('span');
    where.className = 'muted';
    where.textContent = ` (new row ${describePlace(e.after)})`;
    li.append('➕ ', num, ' ', title, where);
    list.appendChild(li);
  }
  if (movedCount) {
    const li = document.createElement('li');
    li.textContent = `↕️ ${movedCount === 1 ? '1 drawing moves' : movedCount + ' drawings move'} to a new place in the register (${[...state.movedTokens].join(', ')})`;
    list.appendChild(li);
  }
  for (const e of numbers) {
    const li = document.createElement('li');
    const from = document.createElement('del');
    from.textContent = e.token;
    const to = document.createElement('ins');
    to.textContent = e.to;
    const what = document.createElement('span');
    what.className = 'muted';
    what.textContent = ` (new number for "${state.titles[e.to] || state.tokenMap[e.token]}")`;
    li.append('# ', from, ' → ', to, what);
    list.appendChild(li);
  }
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
  if (issue) {
    const li = document.createElement('li');
    const marks = Object.entries(issue.marks).map(([t, m]) => `${t} ${m}`);
    li.append(`📅 ${describeIssue(issue)}`);
    if (marks.length) li.append(': ', Object.assign(document.createElement('ins'), { textContent: marks.join(', ') }));
    list.appendChild(li);
  }
  for (const e of project) {
    const li = document.createElement('li');
    const label = document.createElement('b');
    label.textContent = e.label;
    const from = document.createElement('del');
    from.textContent = e.from || '(blank)';
    const to = document.createElement('ins');
    to.textContent = e.to || '(blank)';
    li.append('🗂️ ', label, ' ', from, ' → ', to);
    list.appendChild(li);
  }
  for (const e of details) {
    const li = document.createElement('li');
    const num = document.createElement('b');
    num.textContent = e.token;
    const from = document.createElement('del');
    from.textContent = e.from || '(blank)';
    const to = document.createElement('ins');
    to.textContent = e.to;
    li.append(num, ` ${DETAIL_NAMES[e.field]} `, from, ' → ', to);
    list.appendChild(li);
  }
  const exportBox = document.getElementById('word-export');
  exportBox.disabled = !wordOk;
  exportBox.checked = wordOk;
  document.getElementById('word-export-note').textContent = wordOk
    ? ((await getStatsOrNull(pdfTarget)) ? `Overwrites ${baseName(pdfTarget)} (a dated copy of the old one goes to ${SUPERSEDED_DIR}\\).` : `Creates ${baseName(pdfTarget)}.`)
      + (excel && state.xlsxSheet ? ` Only sheet "${state.xlsxSheet}" is exported.` : '')
    : `Microsoft ${registerAppName()} isn't available, so export the PDF from ${registerAppName()} yourself.`;
  document.getElementById('word-backup-note').textContent =
    `A dated copy of the ${registerAppName()} file is saved in SS first. Close the register in ${registerAppName()} before saving.`;
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
      finish({ tracked: !excel && document.getElementById('word-tracked').checked, exportPdf: exportBox.checked && !exportBox.disabled, pdf: pdfTarget });
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    form.addEventListener('submit', onSubmit);
    wordDialog.addEventListener('cancel', onCancel);
  });
}

// Remember saved renumberings so files with the old numbers keep matching. Earlier ones follow
// this one (PA-001 -> PA-002 before, PA-002 -> PA-003 now: PA-001 -> PA-003); within one save,
// old numbers all refer to the register before it.
function recordRenumbers(applied) {
  const history = state.layout.numberHistory;
  for (const old of Object.keys(history)) {
    if (applied[history[old]]) history[old] = applied[history[old]].to;
  }
  for (const [token, { to }] of Object.entries(applied)) {
    delete state.layout.numberEdits[token];
    history[token] = to;
  }
}

// Scale and size edits that are now in the register (keyed by the numbers they were saved under)
function clearSavedDetails(scalesApplied, sizesApplied) {
  for (const [field, applied] of [['scale', scalesApplied], ['size', sizesApplied]]) {
    for (const token of Object.keys(applied)) {
      const edit = state.layout.detailEdits[token];
      if (!edit) continue;
      delete edit[field];
      if (!Object.keys(edit).length) delete state.layout.detailEdits[token];
    }
  }
}

async function saveToWord() {
  if (state.registerKind === 'xlsx') return saveToExcel();
  const edits = pendingTitleEdits();
  const details = pendingDetailEdits();
  const additions = pendingNewEntries();
  const numbers = pendingNumberEdits();
  const moves = pendingMoves();
  const project = pendingProjectEdits();
  const issue = pendingIssue();
  if ((!edits.length && !details.length && !project.length && !issue && !additions.length && !numbers.length && !moves.length) || state.registerKind !== 'docx') return;
  const options = await askWordOptions(edits, additions, numbers, state.movedTokens.size, details, project, issue);
  const wantOrder = Object.keys(state.titles);
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
    const revOpts = { tracked: options.tracked, author, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    // Titles, then numbers (both found by the register's current numbers), then new rows, so a
    // new entry can take a number another drawing has just given up
    const result = RegisterCore.editDocxTitles(xml, Object.fromEntries(edits.map(e => [e.token, e.to])), revOpts);
    const detailsOf = field => Object.fromEntries(details.filter(e => e.field === field).map(e => [e.token, e.to]));
    const scales = RegisterCore.editDocxScales(result.xml, detailsOf('scale'), revOpts);
    const sizes = RegisterCore.editDocxSizes(scales.xml, detailsOf('size'), revOpts);
    const header = RegisterCore.editDocxProject(sizes.xml, Object.fromEntries(project.map(e => [e.label, e.to])), revOpts);
    const issued = issue ? RegisterCore.editDocxIssue(header.xml, issue, revOpts) : { xml: header.xml, applied: null, notFound: [] };
    const renumber = RegisterCore.editDocxNumbers(issued.xml, Object.fromEntries(numbers.map(e => [e.token, e.to])), revOpts);
    const newNumber = t => (renumber.applied[t] ? renumber.applied[t].to : t);
    const move = RegisterCore.moveDocxRows(renumber.xml, moves.map(m => ({ token: newNumber(m.token), after: m.after && newNumber(m.after) })), revOpts);
    const insert = RegisterCore.insertDocxRows(move.xml, additions.map(e => ({ ...e, after: e.after && newNumber(e.after) })), revOpts);

    // Check the edited document reads back exactly as intended before touching the file
    const expected = {};
    for (const [token, title] of Object.entries(RegisterCore.readDocxTitles(xml))) {
      expected[newNumber(token)] = result.applied[token] ? result.applied[token].to : title;
    }
    for (const e of additions) if (insert.inserted.includes(e.token)) expected[e.token] = e.title.replace(/\s+/g, ' ').trim();
    const check = RegisterCore.readDocxTitles(insert.xml);
    const wrong = [...new Set([...Object.keys(expected), ...Object.keys(check)])].filter(t => check[t] !== expected[t]);
    if (wrong.length) throw new Error(`the edited document didn't read back as expected for ${wrong.join(', ')}; nothing was saved.`);
    // ...and in the order shown in the table
    const want = wantOrder.filter(t => t in check);
    const got = Object.keys(check).filter(t => want.includes(t));
    if (want.join('|') !== got.join('|')) throw new Error('the rows came out in a different order from the table; nothing was saved.');
    // ...with every scale and size as intended
    const detailsBefore = RegisterCore.readDocxDetails(xml);
    const detailsAfter = RegisterCore.readDocxDetails(insert.xml);
    const wrongDetails = Object.keys(detailsBefore).filter(token => {
      const want = {
        scale: scales.applied[token] ? scales.applied[token].to : detailsBefore[token].scale,
        size: sizes.applied[token] ? sizes.applied[token].to : detailsBefore[token].size
      };
      const got = detailsAfter[newNumber(token)];
      return !got || got.scale !== want.scale || got.size !== want.size;
    });
    if (wrongDetails.length) throw new Error(`the scale or size didn't read back as expected for ${wrongDetails.join(', ')}; nothing was saved.`);
    // ...and the project details
    const headerAfter = RegisterCore.readDocxProject(insert.xml).fields;
    const wrongHeader = RegisterCore.readDocxProject(xml).fields.filter(f => {
      const got = headerAfter.find(g => g.label === f.label);
      return !got || got.value !== (header.applied[f.label] ? header.applied[f.label].to : f.value);
    }).map(f => f.label);
    if (wrongHeader.length) throw new Error(`the project details didn't read back as expected (${wrongHeader.join(', ')}); nothing was saved.`);
    // ...and the issue column
    if (issue) {
      const problem = issueReadBackProblem(issue, RegisterCore.readDocxIssues(insert.xml), newNumber, issued.notFound);
      if (problem) throw new Error(`${problem}; nothing was saved.`);
    }

    await backupToSS(docx);
    zip.file('word/document.xml', insert.xml);
    const data = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await Neutralino.filesystem.writeBinaryFile(docx, data);

    const how = options.tracked ? 'as tracked changes' : 'directly';
    for (const [token, { from, to }] of Object.entries(result.applied)) {
      appendLog(`📝 ${token}: "${from}" → "${to}" (${how})`);
    }
    for (const [field, applied] of [['scale', scales.applied], ['size', sizes.applied]]) {
      for (const [token, { from, to }] of Object.entries(applied)) {
        if (from !== to) appendLog(`📝 ${token} ${DETAIL_NAMES[field]}: "${from}" → "${to}" (${how})`);
      }
    }
    for (const [label, { from, to }] of Object.entries(header.applied)) {
      if (from !== to) appendLog(`🗂️ ${label}: "${from}" → "${to}" (${how})`);
    }
    for (const label of header.notFound) appendLog(`⚠️ The "${label}" field wasn't found in ${baseName(docx)}; its edit was kept.`);
    if (issued.applied) logIssueSaved(issue, issued.applied, issued.notFound, ` (${how})`);
    for (const e of additions.filter(a => insert.inserted.includes(a.token))) {
      appendLog(`➕ ${e.token}: added "${e.title}" ${describePlace(e.after)} (${how})`);
    }
    for (const token of insert.skipped) appendLog(`⚠️ ${token} is already in ${baseName(docx)}, so it wasn't added again.`);
    for (const [token, { to }] of Object.entries(renumber.applied)) appendLog(`# ${token} renumbered to ${to} (${how})`);
    if (move.moved.length) appendLog(`↕️ Moved ${[...new Set(move.moved)].join(', ')} in the register (${how})`);
    for (const token of [...new Set([...result.notFound, ...scales.notFound, ...sizes.notFound, ...renumber.notFound])]) {
      appendLog(`⚠️ ${token} wasn't found in a table row of ${baseName(docx)}; its edit was kept.`);
    }
    for (const token of Object.keys(result.applied)) delete state.layout.titleEdits[token];
    clearSavedDetails(scales.applied, sizes.applied);
    for (const label of Object.keys(header.applied)) delete state.layout.projectEdits[label];
    if (issue) state.layout.issueEdit = null;
    recordRenumbers(renumber.applied);
    // Saved moves are done; any later ones (made after this save started) stay
    state.layout.moves = state.layout.moves.filter(m => !moves.includes(m));
    state.layout.newEntries = state.layout.newEntries.filter(e => !insert.inserted.includes(e.token) && !insert.skipped.includes(e.token));
    await saveLayout();
    const saved = [
      `${Object.keys(result.applied).length} title change(s)`,
      `${Object.keys(scales.applied).length + Object.keys(sizes.applied).length} scale/size change(s)`,
      `${Object.keys(header.applied).length} project detail change(s)`,
      ...(issue ? [issue.mode === 'new' ? 'a new issue' : 'an issue update'] : []),
      `${Object.keys(renumber.applied).length} new number(s)`,
      `${new Set(move.moved).size} move(s)`,
      `${insert.inserted.length} new entr${insert.inserted.length === 1 ? 'y' : 'ies'}`
    ];
    appendLog(`✅ Saved ${saved.join(', ')} to ${baseName(docx)}.`);

    if (options.exportPdf) {
      const pdf = options.pdf;
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
// Saving titles and numbers into an Excel register
// --------------------

// The register PDF to update for an Excel register: one with the same name, else the latest
// "...register..." PDF next to it (Excel exports are often named differently), else a new one
async function excelPdfPath() {
  const same = registerPdfPath();
  if (await getStatsOrNull(same)) return same;
  const pdfs = (await listFiles(state.targetDir))
    .filter(f => /register/i.test(f) && f.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b));
  return pdfs.length ? joinPath(state.targetDir, pdfs[pdfs.length - 1]) : same;
}

async function checkExcelAvailable() {
  if (state.excelAvailable !== null) return state.excelAvailable;
  state.excelAvailable = false;
  if (typeof NL_OS !== 'undefined' && NL_OS !== 'Windows') return false;
  try {
    const res = await runPowerShell(`if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Excel.Application') { 'yes' } else { 'no' }`);
    state.excelAvailable = (res.stdOut || '').trim() === 'yes';
  } catch (e) {
    // PowerShell not available
  }
  return state.excelAvailable;
}

// Have Excel export one sheet of the workbook to PDF (its print area and page setup), with
// macros switched off. Uses a hidden Excel of its own; if Excel is already open, it borrows it
// without hiding or closing it and puts its settings back afterwards.
async function exportPdfWithExcel(xlsxPath, sheetName, pdfPath) {
  const script = `
$ErrorActionPreference = 'Stop'
try { $excel = New-Object -ComObject Excel.Application } catch { 'ERROR: Excel could not be started'; exit 2 }
$own = ($excel.Workbooks.Count -eq 0)
$alerts = $excel.DisplayAlerts
$security = $excel.AutomationSecurity
if ($own) { $excel.Visible = $false }
$excel.DisplayAlerts = $false
$excel.AutomationSecurity = 3
$wb = $null
try {
  $wb = $excel.Workbooks.Open(${psString(xlsxPath)}, 0, $true)
  $wb.Worksheets.Item(${psString(sheetName)}).ExportAsFixedFormat(0, ${psString(pdfPath)})
  'OK'
} catch {
  'ERROR: ' + $_.Exception.Message
  exit 1
} finally {
  if ($wb) { $wb.Close($false) }
  $excel.AutomationSecurity = $security
  $excel.DisplayAlerts = $alerts
  if ($own) { $excel.Quit() }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}`;
  const res = await runPowerShell(script);
  const out = (res.stdOut || '').trim();
  if (res.exitCode !== 0 || !out.endsWith('OK')) throw new Error(out.replace(/^ERROR:\s*/, '') || (res.stdErr || '').trim() || `PowerShell exited with ${res.exitCode}`);
}

// The register's PDF in the working folder, named after it with today's date in front
// (replacing a date it already starts with, e.g. "00-00-00 ")
function datedPdfPath() {
  const stem = baseName(state.registerPath).replace(/\.[^.]+$/, '').replace(/^\d{2}-\d{2}-\d{2}\s+/, '');
  return joinPath(state.targetDir, `${datePrefix()} ${stem}.pdf`);
}

// Export the register, as last saved, to a dated PDF with Word or Excel
async function exportRegisterPdf() {
  if (state.busy || !canEditRegister()) return;
  const excel = state.registerKind === 'xlsx';
  const app = registerAppName();
  const register = state.registerPath;
  const pdf = datedPdfPath();
  state.busy = true;
  updateButtons();
  try {
    if (!(excel ? await checkExcelAvailable() : await checkWordAvailable())) throw new Error(`${app} isn't installed`);
    appendLog(`🖨️ Exporting ${baseName(pdf)}${excel ? ` (sheet "${state.xlsxSheet}")` : ''} with ${app}...`);
    if (await getStatsOrNull(pdf)) await backupToSS(pdf);
    if (excel) await exportPdfWithExcel(register, state.xlsxSheet, pdf);
    else await exportPdfWithWord(register, pdf);
    appendLog(`✅ Exported ${baseName(pdf)}.`);
    await openPath(pdf, baseName(pdf));
  } catch (err) {
    appendLog(`❌ Could not export ${baseName(pdf)}: ${err.message || err}`);
  } finally {
    state.busy = false;
    await refresh();
  }
}

async function saveToExcel() {
  const edits = pendingTitleEdits();
  const details = pendingDetailEdits();
  const numbers = pendingNumberEdits();
  const project = pendingProjectEdits();
  const issue = pendingIssue();
  if (!edits.length && !details.length && !project.length && !issue && !numbers.length) return;
  const options = await askWordOptions(edits, [], numbers, 0, details, project, issue);
  if (!options) return;

  const xlsx = state.registerPath;
  state.busy = true;
  updateButtons();
  try {
    if (await isOpenInWord(xlsx)) {
      throw new Error(`${baseName(xlsx)} is open in Excel. Close it there first, then save again.`);
    }
    const zip = await JSZip.loadAsync(await Neutralino.filesystem.readBinaryFile(xlsx));
    const parts = await RegisterCore.loadXlsxParts(zip);
    const before = RegisterCore.readXlsxRegister(parts);
    const result = RegisterCore.editXlsxRegister(parts, {
      titles: Object.fromEntries(edits.map(e => [e.token, e.to])),
      numbers: Object.fromEntries(numbers.map(e => [e.token, e.to])),
      scales: Object.fromEntries(details.filter(e => e.field === 'scale').map(e => [e.token, e.to])),
      sizes: Object.fromEntries(details.filter(e => e.field === 'size').map(e => [e.token, e.to])),
      project: Object.fromEntries(project.map(e => [e.label, e.to])),
      issue
    });
    if (result.errors.length) throw new Error(result.errors.join('; ') + '; nothing was saved.');

    // Check the edited sheet reads back exactly as intended before touching the file
    const after = RegisterCore.readXlsxRegister({ ...parts, sheets: { ...parts.sheets, [result.path]: result.xml } });
    const newNumber = t => (result.applied.numbers[t] ? result.applied.numbers[t].to : t);
    const expected = {};
    for (const [code, title] of Object.entries(before.titles)) {
      expected[newNumber(code)] = result.applied.titles[code] ? result.applied.titles[code].to : title;
    }
    const wrong = [...new Set([...Object.keys(expected), ...Object.keys(after.titles)])].filter(t => after.titles[t] !== expected[t]);
    for (const [code, was] of Object.entries(before.details)) {
      const want = {
        scale: result.applied.scales[code] ? result.applied.scales[code].to : was.scale,
        size: result.applied.sizes[code] ? result.applied.sizes[code].to : was.size
      };
      const got = after.details[newNumber(code)];
      if ((!got || got.scale !== want.scale || got.size !== want.size) && !wrong.includes(code)) wrong.push(code);
    }
    const headerAfter = RegisterCore.readXlsxProject({ ...parts, sheets: { ...parts.sheets, [result.path]: result.xml } }).fields;
    for (const f of RegisterCore.readXlsxProject(parts).fields) {
      const got = headerAfter.find(g => g.label === f.label);
      if (!got || got.value !== (result.applied.project[f.label] ? result.applied.project[f.label].to : f.value)) wrong.push(f.label);
    }
    if (issue) {
      const problem = issueReadBackProblem(issue, RegisterCore.readXlsxIssues({ ...parts, styles: result.styles, sheets: { ...parts.sheets, [result.path]: result.xml } }), newNumber,
        Object.keys(issue.marks).filter(t => result.notFound.includes(t)));
      if (problem) throw new Error(`${problem}; nothing was saved.`);
    }
    if (wrong.length || after.sheet !== before.sheet) {
      throw new Error(`the edited sheet didn't read back as expected${wrong.length ? ' for ' + wrong.join(', ') : ''}; nothing was saved.`);
    }

    await backupToSS(xlsx);
    zip.file(result.path, result.xml);
    if (result.styles !== parts.styles) zip.file('xl/styles.xml', result.styles);
    const data = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    await Neutralino.filesystem.writeBinaryFile(xlsx, data);

    for (const [code, { from, to }] of Object.entries(result.applied.titles)) appendLog(`📝 ${code}: "${from}" → "${to}"`);
    for (const [field, applied] of [['scale', result.applied.scales], ['size', result.applied.sizes]]) {
      for (const [code, { from, to }] of Object.entries(applied)) appendLog(`📝 ${code} ${DETAIL_NAMES[field]}: "${from}" → "${to}"`);
    }
    for (const [code, { to }] of Object.entries(result.applied.numbers)) appendLog(`# ${code} renumbered to ${to}`);
    for (const code of result.notFound) appendLog(`⚠️ ${code} wasn't found on sheet "${result.sheet}"; its edit was kept.`);
    for (const code of Object.keys(result.applied.titles)) delete state.layout.titleEdits[code];
    clearSavedDetails(result.applied.scales, result.applied.sizes);
    for (const [label, { from, to }] of Object.entries(result.applied.project)) {
      appendLog(`🗂️ ${label}: "${from}" → "${to}"`);
      delete state.layout.projectEdits[label];
    }
    if (result.applied.issue) {
      logIssueSaved(issue, result.applied.issue, Object.keys(issue.marks).filter(t => result.notFound.includes(t)), '');
      state.layout.issueEdit = null;
    }
    recordRenumbers(result.applied.numbers);
    await saveLayout();
    const detailCount = Object.keys(result.applied.scales).length + Object.keys(result.applied.sizes).length;
    const issueText = result.applied.issue ? (issue.mode === 'new' ? ', a new issue' : ', an issue update') : '';
    appendLog(`✅ Saved ${Object.keys(result.applied.titles).length} title change(s), ${detailCount} scale/size change(s), ${Object.keys(result.applied.project).length} project detail change(s)${issueText} and ${Object.keys(result.applied.numbers).length} new number(s) to sheet "${result.sheet}" of ${baseName(xlsx)}.`);

    if (options.exportPdf) {
      const pdf = options.pdf;
      appendLog(`🖨️ Exporting ${baseName(pdf)} (sheet "${result.sheet}") with Excel...`);
      if (await getStatsOrNull(pdf)) await backupToSS(pdf);
      await exportPdfWithExcel(xlsx, result.sheet, pdf);
      appendLog(`✅ Exported ${baseName(pdf)}.`);
    }
  } catch (err) {
    appendLog('❌ Could not save to Excel: ' + (err.message || err));
  } finally {
    state.busy = false;
    await refresh();
  }
}

// --------------------
// 7️⃣ New register entries
// --------------------
const entryDialog = document.getElementById('entry-dialog');
const entryFields = {
  token: document.getElementById('entry-number'),
  title: document.getElementById('entry-title'),
  scale: document.getElementById('entry-scale'),
  size: document.getElementById('entry-size'),
  after: document.getElementById('entry-after'),
  copyMarks: document.getElementById('entry-marks')
};

// Natural order of drawing numbers (PA-2 < PA-10)
function compareNumbers(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

// Everything before a drawing number's last run of digits ("PA-A-" for PA-A-107, "PA-" for PA-002-D)
function numberSeries(token) {
  return token.replace(/\d+[^\d]*$/, '');
}

// Where a new drawing number would sit: after the highest drawing in the same series that sorts
// before it, else just before that series, else after the last drawing
function suggestAfter(token) {
  const tokens = Object.keys(state.tokenMap);
  const series = tokens.filter(t => numberSeries(t) === numberSeries(token));
  const lower = series.filter(t => compareNumbers(t, token) < 0);
  if (lower.length) return lower.reduce((a, b) => (compareNumbers(a, b) >= 0 ? a : b));
  if (series.length) {
    const i = tokens.indexOf(series[0]);
    return i > 0 ? tokens[i - 1] : series[0];
  }
  return tokens[tokens.length - 1] || null;
}

// Drawing number and title from a file name like "12345-PA-A-107_Plant Deck.pdf"
function guessFromFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  // Drawing numbers are in capitals, so "...-A-1900-Block F" stops before "Block"; names written
  // all in lower case are tried in capitals
  const numberRe = new RegExp(RegisterCore.DRAWING_NUMBER + '(?![A-Za-z0-9])');
  const m = numberRe.exec(stem) || numberRe.exec(stem.toUpperCase()) ||
    new RegExp(RegisterCore.DRAWING_NUMBER).exec(stem.toUpperCase());
  if (!m) return { token: '', title: '' };
  const rest = stem.slice(m.index + m[0].length).replace(/_/g, ' ').replace(/^[\s\-–]+/, '').replace(/\s+/g, ' ').trim();
  return { token: m[0], title: rest };
}

function updateEntryPreview() {
  const after = entryFields.after.value;
  const details = state.registerXml && after ? RegisterCore.readDocxDetails(state.registerXml)[after] : null;
  entryFields.scale.placeholder = details && details.scale ? `e.g. ${details.scale}` : 'e.g. 1:100';
  const marks = state.registerXml && after ? RegisterCore.readRowMarks(state.registerXml, after).filter(Boolean) : [];
  const label = document.getElementById('entry-marks-label');
  label.textContent = after
    ? `Copy the issue marks from ${after} (${marks.length ? marks.join(' ') : 'none'})`
    : 'Copy the issue marks from the row above';
}

// Resolves once the dialog closes; adds the entry if confirmed
// Fills the new entry dialog's empty title, scale and size from the file's title block (read
// now if it hasn't been yet), unless the dialog has moved on to another file
async function fillEntryFromTitleBlock(rel) {
  const filePath = absPath(rel);
  const apply = details => {
    if (!details || !entryDialog.open || entryDialog.dataset.rel !== rel) return;
    if (!entryFields.title.value.trim() && details.title) entryFields.title.value = details.title;
    if (!entryFields.scale.value.trim() && details.scale) entryFields.scale.value = details.scale;
    if (!entryFields.size.value && [...entryFields.size.options].some(o => o.value === details.size)) entryFields.size.value = details.size;
    updateEntryPreview();
  };
  const cached = state.fileDetails.get(filePath);
  if (cached) return apply(cached.details);
  if (!/\.pdf$/i.test(rel)) return;
  try {
    const stats = await getStatsOrNull(filePath);
    const details = await readFileDetails(filePath);
    if (stats) state.fileDetails.set(filePath, { stamp: `${stats.size}:${stats.modifiedAt}`, details });
    apply(details);
  } catch (e) {
    // the fields stay empty to fill in by hand
  }
}

// fromRow: the table row of a file not in the register (its number and title are guessed from the
// file name, the scale and size from its title block), or null for a blank entry
function openEntryDialog(fromRow) {
  if (state.registerKind !== 'docx' || state.busy) return;
  const fromFile = fromRow ? fromRow.file : null;
  const guess = fromFile ? guessFromFileName(fromFile) : { token: '', title: '' };
  entryFields.token.value = guess.token;
  entryFields.title.value = guess.title;
  entryFields.scale.value = '';
  entryFields.size.value = '';
  entryFields.copyMarks.checked = false;
  entryDialog.dataset.rel = (fromRow && fromRow.rel) || '';

  const afterSelect = entryFields.after;
  afterSelect.textContent = '';
  for (const token of Object.keys(state.tokenMap)) {
    const opt = document.createElement('option');
    opt.value = token;
    opt.textContent = `${token} — ${state.tokenMap[token]}`;
    afterSelect.appendChild(opt);
  }
  let afterTouched = false;
  const suggest = () => {
    if (afterTouched) return;
    const token = entryFields.token.value.trim().toUpperCase();
    const suggestion = token ? suggestAfter(token) : null;
    if (suggestion) afterSelect.value = suggestion;
    updateEntryPreview();
  };
  suggest();
  document.getElementById('entry-dialog-title').textContent = fromFile ? `Add ${fromFile} to the register` : 'New register entry';
  document.getElementById('entry-error').textContent = '';
  entryDialog.showModal();
  (guess.token ? entryFields.title : entryFields.token).focus();
  if (fromRow && fromRow.rel) fillEntryFromTitleBlock(fromRow.rel);

  return new Promise(resolve => {
    const form = entryDialog.querySelector('form');
    const onNumber = () => suggest();
    const onAfter = () => {
      afterTouched = true;
      updateEntryPreview();
    };
    const finish = () => {
      form.removeEventListener('submit', onSubmit);
      entryDialog.removeEventListener('cancel', onCancel);
      entryFields.token.removeEventListener('input', onNumber);
      afterSelect.removeEventListener('change', onAfter);
      entryDialog.close();
      resolve();
    };
    const onSubmit = async (e) => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === 'cancel') return finish();
      const token = entryFields.token.value.trim().toUpperCase();
      const title = entryFields.title.value.replace(/\s+/g, ' ').trim();
      const error = document.getElementById('entry-error');
      if (!new RegExp('^' + RegisterCore.DRAWING_NUMBER + '$').test(token)) {
        error.textContent = 'Enter a drawing number like PA-A-107 or PA-002-D.';
        return entryFields.token.focus();
      }
      if (token in state.titles) {
        error.textContent = `${token} is already in the register.`;
        return entryFields.token.focus();
      }
      if (!title) {
        error.textContent = 'Enter a title.';
        return entryFields.title.focus();
      }
      const entry = {
        token, title,
        scale: entryFields.scale.value.trim(),
        size: entryFields.size.value,
        after: afterSelect.value || null,
        copyMarks: entryFields.copyMarks.checked
      };
      state.layout.newEntries.push(entry);
      await saveLayout();
      appendLog(`➕ ${token} "${title}" will be added ${describePlace(entry.after)} when you press SAVE TO WORD.`);
      finish();
      await refresh();
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish();
    };
    form.addEventListener('submit', onSubmit);
    entryDialog.addEventListener('cancel', onCancel);
    entryFields.token.addEventListener('input', onNumber);
    afterSelect.addEventListener('change', onAfter);
  });
}

async function removeNewEntry(token) {
  state.layout.newEntries = state.layout.newEntries.filter(e => e.token !== token);
  await saveLayout();
  appendLog(`➖ Removed new entry ${token}.`);
  await refresh();
}

// --------------------
// More-actions menu
// --------------------
const menuBtn = document.getElementById('menu-btn');
const menuEl = document.getElementById('menu');

function menuItem(action) {
  return menuEl.querySelector(`[data-action="${action}"]`);
}

function openMenu() {
  const loaded = !!state.registerPath && !state.busy;
  const reset = menuItem('reset-folders');
  reset.disabled = !loaded || !state.layout.folders.length;
  reset.title = state.layout.folders.length ? 'Take every drawing out of its folder' : 'There are no folders';
  const sort = menuItem('sort');
  sort.disabled = !loaded || !canReorder();
  sort.title = canReorder() ? 'Put the register in drawing number order' : 'Sorting reorders the register, which needs a Word register';
  const pending = unsavedRegisterChanges();
  const discard = menuItem('discard');
  discard.disabled = !loaded || !pending.total;
  discard.title = pending.total ? `Forget ${pending.summary}` : 'There are no unsaved register changes';
  const open = menuItem('open-folder');
  open.disabled = !state.targetDir;
  open.title = state.targetDir ? displayPath(state.targetDir) : 'Load a register first';
  separatorInput.value = state.layout.separator;
  separatorInput.disabled = !loaded;
  showSeparatorPreview(state.layout.separator);
  menuEl.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  menuEl.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (menuEl.hidden) openMenu();
  else closeMenu();
});
document.addEventListener('click', (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuEl.hidden) closeMenu();
});
menuEl.addEventListener('click', (e) => {
  const item = e.target.closest('button[data-action]');
  if (!item || item.disabled) return;
  closeMenu();
  if (item.dataset.action === 'reset-folders') resetFolders();
  if (item.dataset.action === 'sort') sortByNumber();
  if (item.dataset.action === 'discard') discardRegisterChanges();
  if (item.dataset.action === 'open-folder') openFolderInExplorer();
});

// ---------- number-title separator ----------
const separatorInput = document.getElementById('separator-input');
const separatorPreview = document.getElementById('separator-preview');

function showSeparatorPreview(sep) {
  const problem = separatorProblem(sep);
  separatorPreview.classList.toggle('error', !!problem);
  if (problem) {
    separatorPreview.textContent = problem;
    return;
  }
  const token = Object.keys(state.titles)[0] || 'PA-001';
  const title = state.titles[token] || 'Masterplan';
  separatorPreview.textContent = `${token}${sep}${sanitizeFilename(title)}.pdf`;
}

async function setSeparator(sep) {
  if (separatorProblem(sep) || sep === state.layout.separator) return;
  state.layout.separator = sep;
  appendLog(`✏️ File names now use "${sep}" between the drawing number and title; files named the old way show as Rename.`);
  await saveLayout();
  rebuild();
}

separatorInput.addEventListener('input', () => showSeparatorPreview(separatorInput.value));
separatorInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    setSeparator(separatorInput.value);
    closeMenu();
  }
});
separatorInput.addEventListener('change', () => setSeparator(separatorInput.value));

// ---------- discard unsaved register changes ----------
function unsavedRegisterChanges() {
  const counts = {
    titles: pendingTitleEdits().length,
    details: pendingDetailEdits().length,
    project: pendingProjectEdits().length,
    issue: pendingIssue() ? 1 : 0,
    numbers: pendingNumberEdits().length,
    entries: pendingNewEntries().length,
    moves: state.movedTokens.size
  };
  const parts = [];
  if (counts.titles) parts.push(`${counts.titles} title change(s)`);
  if (counts.details) parts.push(`${counts.details} scale/size change(s)`);
  if (counts.project) parts.push(`${counts.project} project detail change(s)`);
  if (counts.issue) parts.push(state.layout.issueEdit.mode === 'new' ? 'a new issue' : 'an issue update');
  if (counts.numbers) parts.push(`${counts.numbers} new number(s)`);
  if (counts.entries) parts.push(`${counts.entries} new entr${counts.entries === 1 ? 'y' : 'ies'}`);
  if (counts.moves) parts.push(`${counts.moves} moved drawing(s)`);
  return { ...counts, total: counts.titles + counts.details + counts.project + counts.issue + counts.numbers + counts.entries + counts.moves, summary: parts.join(', ') };
}

// Forget title and number edits, new entries and moves that haven't been saved to the register.
// Folder assignments that followed a renumbering go back to the register's number.
async function discardRegisterChanges() {
  const pending = unsavedRegisterChanges();
  if (!pending.total) return;
  let answer = 'YES';
  try {
    answer = await Neutralino.os.showMessageBox('Discard unsaved register changes',
      `Forget ${pending.summary}? The register itself isn't changed.`, 'YES_NO', 'WARNING');
  } catch (e) {
    answer = window.confirm(`Forget ${pending.summary}?`) ? 'YES' : 'NO';
  }
  if (answer !== 'YES') return;

  const assignments = state.layout.assignments;
  for (const [token, number] of Object.entries(state.layout.numberEdits)) {
    if (assignments[number] !== undefined) {
      assignments[token] = assignments[number];
      delete assignments[number];
    }
    if (state.choices.has(number)) {
      state.choices.set(token, state.choices.get(number));
      state.choices.delete(number);
    }
  }
  for (const e of state.layout.newEntries) {
    if (!(e.token in state.tokenMap)) delete assignments[e.token];
  }
  state.layout.titleEdits = {};
  state.layout.detailEdits = {};
  state.layout.projectEdits = {};
  state.layout.issueEdit = null;
  state.layout.numberEdits = {};
  state.layout.newEntries = [];
  state.layout.moves = [];
  appendLog(`↩️ Discarded ${pending.summary}.`);
  await saveLayout();
  rebuild();
}

// ---------- open a file in its default app ----------
function openFile(rel) {
  return openPath(absPath(rel), displayPath(rel));
}

async function openPath(filePath, shown) {
  try {
    if (typeof NL_OS !== 'undefined' && NL_OS !== 'Windows') await Neutralino.os.open(filePath);
    else await Neutralino.os.execCommand(`explorer.exe "${filePath.replace(/\//g, '\\')}"`, { background: true });
  } catch (err) {
    appendLog(`❌ Could not open ${shown}: ${err.message || err}`);
  }
}

// ---------- open folder ----------
async function openFolderInExplorer() {
  if (!state.targetDir) return;
  const dir = state.targetDir.replace(/\//g, '\\');
  try {
    if (typeof NL_OS !== 'undefined' && NL_OS !== 'Windows') await Neutralino.os.open(state.targetDir);
    else await Neutralino.os.execCommand(`explorer.exe "${dir}"`, { background: true });
  } catch (err) {
    appendLog(`❌ Could not open ${dir}: ${err.message || err}`);
  }
}

// Take every drawing out of its folder. Their files move to the top folder on RENAME; each folder
// is removed from the layout (and deleted from disk, if nothing else is in it) once it's empty.
async function resetFolders() {
  const folders = state.layout.folders.slice();
  if (!folders.length) return;
  const assigned = Object.keys(state.layout.assignments).length;
  let answer = 'YES';
  try {
    answer = await Neutralino.os.showMessageBox('Reset folders',
      `Take all ${assigned} drawing(s) out of the ${folders.length} folder(s)? Their files move back to the top folder when you press RENAME, and the empty folders are then removed.`,
      'YES_NO', 'QUESTION');
  } catch (e) {
    answer = window.confirm('Take every drawing out of its folder?') ? 'YES' : 'NO';
  }
  if (answer !== 'YES') return;
  state.layout.assignments = {};
  state.layout.foldersToRemove = folders;
  appendLog(`📁 Took ${assigned} drawing(s) out of their folders; files move to the top folder when you press RENAME.`);
  await saveLayout();
  await refresh();
}

// Remove reset folders that nothing is assigned to and no scanned file is in (deepest first).
// Deletes the folder on disk only when it's completely empty. Returns whether any were removed.
async function pruneResetFolders() {
  const pending = state.layout.foldersToRemove || [];
  if (!pending.length) return false;
  let changed = false;
  for (const folder of pending.slice().sort((a, b) => folderDepth(b) - folderDepth(a))) {
    const inUse = Object.values(state.layout.assignments).some(f => isInside(f, folder)) ||
      state.files.some(f => f.dir && isInside(f.dir, folder)) ||
      state.layout.folders.some(f => f !== folder && isInside(f, folder));
    if (inUse) continue;
    state.layout.folders = state.layout.folders.filter(f => f !== folder);
    state.layout.foldersToRemove = state.layout.foldersToRemove.filter(f => f !== folder);
    changed = true;
    try {
      const stats = await getStatsOrNull(absPath(folder));
      if (stats && stats.isDirectory) {
        if (!(await Neutralino.filesystem.readDirectory(absPath(folder))).length) {
          const id = state.watchers.get(folder);
          if (id !== undefined) {
            try {
              await Neutralino.filesystem.removeWatcher(id);
            } catch (e) {
              // watcher already gone
            }
            state.watchers.delete(folder);
          }
          await Neutralino.filesystem.remove(absPath(folder));
          appendLog(`📁 Removed empty folder ${displayPath(folder)}.`);
        } else {
          appendLog(`📁 ${displayPath(folder)} is no longer a drawing folder; it still holds other files (e.g. ${SUPERSEDED_DIR}), so it was left on disk.`);
        }
      } else {
        appendLog(`📁 Removed folder ${displayPath(folder)} from the layout.`);
      }
    } catch (err) {
      appendLog(`⚠️ Could not delete ${displayPath(folder)}: ${err.message || err}`);
    }
  }
  return changed;
}

// Indexes of a longest increasing run (not necessarily adjacent) in values
function longestIncreasing(values) {
  const tails = []; // index of the smallest tail for each length
  const prev = new Array(values.length).fill(-1);
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

// Put the register in drawing number order (natural: PA-2 before PA-10), by the numbers shown.
// Only drawings that are out of order get a move, so SAVE TO WORD changes as few rows as possible.
async function sortByNumber() {
  if (!canReorder()) return;
  const shown = t => state.layout.numberEdits[t] || t;
  const current = registerOrder(); // register numbers, in the order the rows will be in
  const sorted = current.slice().sort((a, b) => compareNumbers(shown(a), shown(b)));
  const rank = new Map(sorted.map((t, i) => [t, i]));
  const keep = longestIncreasing(current.map(t => rank.get(t)));
  const stays = new Set([...keep].map(i => current[i]));
  const moves = [];
  sorted.forEach((token, i) => {
    if (!stays.has(token)) moves.push({ token, after: i ? sorted[i - 1] : '' });
  });

  // New entries go after the register drawing that precedes them in number order
  const entries = pendingNewEntries().slice().sort((a, b) => compareNumbers(a.token, b.token));
  let entriesMoved = 0;
  for (const e of entries) {
    const before = sorted.filter(t => compareNumbers(shown(t), e.token) < 0).pop();
    const after = before === undefined ? '' : before;
    if (e.after !== after) entriesMoved++;
    e.after = after;
  }
  const others = state.layout.newEntries.filter(e => !entries.includes(e));
  state.layout.newEntries = [...others, ...entries];

  if (!moves.length && !entriesMoved) {
    appendLog('↕️ The register is already in drawing number order.');
    return;
  }
  state.layout.moves.push(...moves);
  if (!pendingMoves().length) state.layout.moves = [];
  appendLog(`↕️ Sorted the register by drawing number: ${moves.length} drawing(s)${entriesMoved ? ` and ${entriesMoved} new entr${entriesMoved === 1 ? 'y' : 'ies'}` : ''} move (press SAVE TO WORD to reorder the register).`);
  await saveLayout();
  rebuild();
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
        { name: 'Drawing registers', extensions: ['docx', 'xlsx', 'xlsm', 'pdf'] },
        { name: 'Word documents', extensions: ['docx'] },
        { name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] },
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

for (const btn of tabButtons) btn.addEventListener('click', () => switchTab(btn.dataset.tab));

titlesFromFilesBtn.addEventListener('click', () => copyTitles(true));
titlesFromRegisterBtn.addEventListener('click', () => copyTitles(false));
detailsFromFilesBtn.addEventListener('click', copyDetails);

// Stacked comparisons: the in-file title's copy button moves into the register title's header
stackCheckbox.addEventListener('change', () => {
  const stacked = stackCheckbox.checked;
  tableEl.classList.toggle('stacked', stacked);
  document.getElementById(stacked ? 'stacked-file-title-label' : 'file-title-th').prepend(titlesFromFilesBtn);
  render(new Set());
});

for (const [cb, hideClass] of fileDetailCheckboxes) {
  cb.addEventListener('change', () => {
    tableEl.classList.toggle(hideClass, !cb.checked);
    if (cb.checked) loadFileDetails();
  });
}

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
exportRegisterBtn.addEventListener('click', exportRegisterPdf);
openRegisterBtn.addEventListener('click', () => {
  if (state.registerPath) openPath(state.registerPath, baseName(state.registerPath));
});
entryBtn.addEventListener('click', () => openEntryDialog(null));
renameBtn.addEventListener('click', renameSelected);

document.getElementById('clear-log').addEventListener('click', () => {
  logEl.textContent = '';
  document.getElementById('log-latest').textContent = '';
});
document.getElementById('toggle-log').addEventListener('click', () => setLogExpanded(logEl.hidden));
