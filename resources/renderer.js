const startBtn = document.getElementById('start');
const registerInput = document.getElementById('register');
const dryCheckbox = document.getElementById('dry');
const logEl = document.getElementById('log');
const chooseBtn = document.getElementById('choose');
const chooseFileBtn = document.getElementById('choose-file');

PDFJS.workerSrc = 'js/pdfjs/pdf.worker.js';

function appendLog(text) {
  logEl.textContent += text + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

Neutralino.init();

Neutralino.events.on('windowClose', () => Neutralino.app.exit());

chooseBtn.addEventListener('click', async () => {
  try {
    const folder = await Neutralino.os.showFolderDialog('Select folder containing the register PDF');
    if (folder) registerInput.value = folder;
  } catch (err) {
    appendLog('Could not open folder dialog: ' + (err.message || err));
  }
});

chooseFileBtn.addEventListener('click', async () => {
  try {
    const files = await Neutralino.os.showOpenDialog('Select register PDF', {
      filters: [{ name: 'PDF files', extensions: ['pdf'] }]
    });
    if (files && files.length) registerInput.value = files[0];
  } catch (err) {
    appendLog('Could not open file dialog: ' + (err.message || err));
  }
});

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
// 4️⃣ Rename files based on exact token match
// --------------------
async function renameFiles(registerInputPath, dryRun) {
  const registerPDF = await resolveRegisterPath(registerInputPath);

  if (dryRun) appendLog('🔎 Running in dry-run mode — no files will be renamed.');
  appendLog(`📚 Parsing PDF register: ${registerPDF} ...`);
  const tokenMap = await parseRegisterPDF(registerPDF);
  appendLog(`📘 Loaded ${Object.keys(tokenMap).length} drawing entries from register.`);

  appendLog('\n🗂 Full drawing map from register:');
  for (const [number, title] of Object.entries(tokenMap)) {
    appendLog(`${number} => ${title}`);
  }
  appendLog('');

  const registerBasename = baseName(registerPDF);
  const targetDir = dirName(registerPDF);
  const files = await listFiles(targetDir);
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf') || file === registerBasename) continue;

    const match = Object.keys(tokenMap).find(token => file.includes(token));
    if (!match) {
      appendLog(`❔ No title found for file: ${file}`);
      continue;
    }

    const newName = `${match} - ${sanitizeFilename(tokenMap[match])}.pdf`;
    if (file === newName) continue; // already correct

    try {
      if (dryRun) {
        appendLog(`ℹ️ Dry-run: would rename ${file} → ${newName}`);
      } else {
        await Neutralino.filesystem.move(joinPath(targetDir, file), joinPath(targetDir, newName));
        appendLog(`✅ Renamed ${file} → ${newName}`);
      }
    } catch (err) {
      appendLog(`❌ Failed to rename ${file}: ${err.message || err}`);
    }
  }
}

startBtn.addEventListener('click', async () => {
  logEl.textContent = '';
  const registerPath = registerInput.value.trim();
  if (!registerPath) {
    appendLog('❌ Choose a register PDF or the folder containing it first.');
    return;
  }

  startBtn.disabled = true;
  try {
    await renameFiles(registerPath, dryCheckbox.checked);
    appendLog('Done.');
  } catch (err) {
    appendLog('❌ ' + (err.message || err));
  } finally {
    startBtn.disabled = false;
  }
});
