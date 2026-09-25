// Drawing register logic shared by the GUI (loaded as a <script>, exposes window.RegisterCore)
// and the CLI (require('./resources/register-core')): reading registers from PDF text or Word
// XML, matching file names to drawing numbers, and writing title changes back into Word.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RegisterCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // e.g. PA-000, PA-A-100, PA-V-B-103, PA-002-A (a numbered part, optionally followed by suffixes)
  const DRAWING_NUMBER = '[A-Z]+(?:-[A-Z0-9]+)*-\\d+(?:-[A-Z0-9]+)*';
  const DRAWING_NUMBER_RE = new RegExp('^' + DRAWING_NUMBER + '$');

  // --------------------
  // PDF registers
  // --------------------

  // Text extracted from a PDF register -> { drawingNumber: title }.
  // A title runs from the drawing number to the scale (1:100), or to "NTS" or the sheet
  // size (A0-A4) for drawings without a scale, or for a row with neither, to where the next
  // drawing number starts.
  function parsePdfText(text) {
    const flat = text.replace(/\r?\n/g, ' ');
    const end = '\\s+(?:1:\\d+|N\\.?T\\.?S\\.?(?=\\s)|A[0-4](?=\\s))';
    const nextEntry = '(?=\\s+' + DRAWING_NUMBER + '\\s)';
    const entryRe = new RegExp('(' + DRAWING_NUMBER + ')\\s+(.+?)(?:' + end + '|' + nextEntry + ')', 'g');
    const map = {};
    let m;
    while ((m = entryRe.exec(flat)) !== null) {
      map[m[1]] = m[2].trim().replace(/\s+/g, ' ');
    }
    return map;
  }

  // --------------------
  // Drawing title blocks
  // --------------------

  // Details printed in a drawing's title block, from the text items on its first page:
  // { title, rev, scale, size } ('' where not found). Items are { str, x, y, h, rotated } in PDF units
  // as the sheet is displayed (rotation applied), y upwards; page is { width, height }.
  function readTitleBlock(items, page) {
    // Only horizontal text; rotated notes and dimensions aren't title block fields
    const text = items.filter(i => i.str.trim() && !i.rotated);
    const scaleField = readField(text, SCALE_LABEL_RE);
    const sizeField = readField(text, SIZE_LABEL_RE);
    const parsed = splitScale(scaleField);
    return {
      title: readTitle(text),
      rev: readRevision(text),
      scale: parsed.scale || scalesOnSheet(items),
      size: (sizeField.match(SHEET_SIZE_RE) || [])[0] || parsed.size || (page ? sheetSizeOf(page.width, page.height) : '')
    };
  }

  // The title sits to the right of a "Title." label, from the label's top down to the next label
  // under it (e.g. "Client."), possibly over several lines, which are joined with spaces
  const TITLE_LABEL_RE = /^\s*(?:drawing\s+|dwg\.?\s+)?title\s*[.:]?\s*$/i;
  function readTitle(text) {
    let best = '';
    for (const label of text.filter(i => TITLE_LABEL_RE.test(i.str))) {
      const sameColumn = i => Math.abs(i.x - label.x) < 2;
      const below = text.filter(i => i !== label && sameColumn(i) && i.y < label.y - 1);
      const floor = below.length ? Math.max(...below.map(i => i.y)) : label.y - label.h * 8;
      const top = label.y + label.h;
      const parts = text.filter(i => i.x > label.x + 1 && !sameColumn(i) && i.y < top && i.y > floor);
      const title = joinLines(parts, ' ');
      if (title.length > best.length) best = title;
    }
    return best;
  }

  // Items grouped into lines by baseline, top to bottom, each line read left to right
  function joinLines(parts, separator) {
    const lines = [];
    for (const p of parts) {
      const line = lines.find(l => Math.abs(l.y - p.y) < p.h * 0.4);
      if (line) line.parts.push(p);
      else lines.push({ y: p.y, parts: [p] });
    }
    return lines.sort((a, b) => b.y - a.y)
      .map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.str).join(''))
      .join(separator).replace(/\s+/g, ' ').trim();
  }

  // Title strip fields have the label at the top of the cell and the value under it. The value
  // is the first line below the label, from the label's left edge up to the next label along.
  function fieldValue(text, label) {
    const h = label.h;
    const labelRow = text.filter(i => i !== label && Math.abs(i.y - label.y) < h * 0.5 && i.x > label.x + 1);
    const right = labelRow.length ? Math.min(...labelRow.map(i => i.x)) - 1 : label.x + h * 20;
    const inCell = text.filter(i => i.y < label.y - h * 0.5 && i.y > label.y - h * 4 &&
      i.x > label.x - h * 1.5 && i.x < right);
    if (!inCell.length) return '';
    const top = Math.max(...inCell.map(i => i.y));
    return joinLines(inCell.filter(i => Math.abs(i.y - top) < i.h * 0.4), ' ');
  }

  // The lowest matching label on the sheet: the title strip is along the bottom, and tables
  // with the same headings (the revision history) sit above it
  function lowestLabels(text, labelRe) {
    return text.filter(i => labelRe.test(i.str)).sort((a, b) => a.y - b.y);
  }

  function readField(text, labelRe) {
    for (const label of lowestLabels(text, labelRe)) {
      const value = fieldValue(text, label);
      if (value) return value;
    }
    return '';
  }

  // "Rev. No.", "Rev.", "Revision" - but not the Rev column of a revision history table, which
  // has a description column beside it
  const REV_LABEL_RE = /^\s*rev(?:ision|\.)?\s*(?:no\.?|number)?\s*[.:]?\s*$/i;
  const HISTORY_HEADING_RE = /^\s*(?:description|amendments?|details|initials|remarks|comments?)\b/i;
  function readRevision(text) {
    const labels = lowestLabels(text, REV_LABEL_RE).filter(label =>
      !text.some(i => HISTORY_HEADING_RE.test(i.str) && Math.abs(i.y - label.y) < label.h * 0.5 && Math.abs(i.x - label.x) < label.h * 60));
    // A revision is a short code (C07, P1, A, 03); anything longer isn't one
    for (const label of labels) {
      const value = fieldValue(text, label);
      if (value && value.length <= 8) return value;
    }
    return '';
  }

  const SCALE_LABEL_RE = /^\s*scales?\s*[.:]?\s*$/i;
  const SIZE_LABEL_RE = /^\s*(?:sheet|paper|drawing)?\s*size\s*[.:]?\s*$/i;
  const SHEET_SIZE_RE = /\bA[0-4]\b/i;

  // "1:200 @ A1" -> { scale: '1:200', size: 'A1' }; "1:50@A0", "As indicated @ A1", "NTS" etc.
  function splitScale(value) {
    const at = value.lastIndexOf('@');
    const sizePart = at >= 0 ? value.slice(at + 1) : value;
    const sizeMatch = sizePart.match(SHEET_SIZE_RE);
    let scale = at >= 0 ? value.slice(0, at) : sizeMatch ? value.replace(SHEET_SIZE_RE, '') : value;
    scale = scale.replace(/\s*([:@])\s*/g, '$1').replace(/^[\s,;-]+|[\s,;-]+$/g, '');
    return { scale, size: sizeMatch ? sizeMatch[0].toUpperCase() : '' };
  }

  // For a title block without a scale: every scale written anywhere on the sheet (view titles
  // like "1 : 50"), largest first, e.g. "1:50/1:20". Not times (11:51:17), references (SECT 31:1)
  // or gradients (FALL 1:40, RAMP 1:12).
  const SHEET_SCALE_RE = /(?<![\d.:])1\s*:\s*(\d+(?:\.\d+)?)(?![\d:])/g;
  const GRADIENT_RE = /\b(?:falls?|gradient|slope|pitch|ramp)\b/i;
  function scalesOnSheet(items) {
    const found = new Set();
    for (const item of items) {
      if (GRADIENT_RE.test(item.str)) continue;
      for (const m of item.str.matchAll(SHEET_SCALE_RE)) found.add(Number(m[1]));
    }
    return [...found].sort((a, b) => b - a).map(n => `1:${n}`).join('/');
  }

  // ISO A sheet from the page size in points, allowing a few percent for plotter margins
  const SHEET_SIZES_MM = [['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297]];
  function sheetSizeOf(width, height) {
    const [short, long] = [width, height].map(v => v * 25.4 / 72).sort((a, b) => a - b);
    const found = SHEET_SIZES_MM.find(([, s, l]) => Math.abs(short - s) / s < 0.03 && Math.abs(long - l) / l < 0.03);
    return found ? found[0] : '';
  }

  // --------------------
  // Excel registers (.xlsx / .xlsm)
  // --------------------

  // Any hyphenated code with a letter and a digit in it (ISO 19650 codes like
  // PAWE-DA-BF-XX-DR-A-6011A have no all-digit part). Only used where a cell is known to hold a
  // code, not for searching text.
  const LOOSE_CODE_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
  function isLooseCode(s) {
    return LOOSE_CODE_RE.test(s) && /\d/.test(s) && /[A-Z]/.test(s);
  }

  function columnIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64;
    return n;
  }

  // Text of an Excel string item (<si> or <is>), without phonetic guides
  function stringItemText(xml) {
    const plain = xml.replace(/<rPh[\s>][\s\S]*?<\/rPh>/g, '');
    let out = '';
    const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let m;
    while ((m = re.exec(plain)) !== null) out += decodeXml(m[1]);
    return out;
  }

  // Rows of a worksheet as [{ row, cells: { columnIndex: text } }]
  function readSheetRows(sheetXml, sharedStrings, zeroPad) {
    const rows = [];
    for (const r of findElements(sheetXml, 'row')) {
      const cells = {};
      const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let m;
      while ((m = cellRe.exec(r.xml)) !== null) {
        const attrs = m[1];
        const inner = m[2] || '';
        const ref = (/\br="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        if (!ref) continue;
        const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        const v = /<v>([^<]*)<\/v>/.exec(inner);
        let text = null;
        if (type === 's' && v) text = sharedStrings[parseInt(v[1], 10)] || '';
        else if (type === 'inlineStr') {
          const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
          text = is ? stringItemText(is[1]) : '';
        } else if (v) {
          text = decodeXml(v[1]);
          // Numbers shown with leading zeros ("0000" format) keep them
          const style = (/\bs="(\d+)"/.exec(attrs) || [])[1];
          const width = style !== undefined ? zeroPad[style] : 0;
          if (width && /^\d+$/.test(text)) text = text.padStart(width, '0');
        }
        if (text !== null && text.trim() !== '') cells[columnIndex(ref)] = text;
      }
      const rowNum = parseInt((/\br="(\d+)"/.exec(r.xml) || [])[1] || '0', 10);
      rows.push({ row: rowNum, cells });
    }
    return rows;
  }

  // style index => number of digits for styles with a "0000"-style number format
  function zeroPadStyles(stylesXml) {
    const pad = {};
    if (!stylesXml) return pad;
    const formats = {};
    for (const m of stylesXml.matchAll(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) formats[m[1]] = decodeXml(m[2]);
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (!xfs) return pad;
    let i = 0;
    for (const m of xfs[1].matchAll(/<xf\s([^>]*?)\/?>/g)) {
      const id = (/numFmtId="(\d+)"/.exec(m[1]) || [])[1];
      const code = formats[id];
      if (code && /^0+$/.test(code)) pad[i] = code.length;
      i++;
    }
    return pad;
  }

  const norm = s => collapse(s).toUpperCase();

  const CODE_HEADERS = ['DRAWING CODE', 'DRAWING NUMBER', 'DRAWING NO.', 'DRAWING NO', 'DWG. REF.', 'DWG REF'];
  const TITLE_HEADERS = ['DRAWING TITLE', 'TITLE'];

  // Columns of a "DRAWING CODE" ... "DRAWING TITLE" header row, or null
  function headerColumns(cells) {
    const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
    const code = cols.find(c => CODE_HEADERS.includes(norm(cells[c])));
    const title = cols.find(c => TITLE_HEADERS.includes(norm(cells[c])));
    return code !== undefined && title !== undefined && title > code ? { code, title } : null;
  }

  // Drawings on one sheet: rows under a "DRAWING CODE" / "DRAWING TITLE" header, the code joined
  // from every cell between the two headers (codes split into one cell per field work too);
  // without such a header, a row whose first text is a code and whose next text is its title
  function readSheetDrawings(rows) {
    const titles = {};
    const places = {}; // code => { row, codeCols, titleCol }: where the drawing's cells are
    let issue = null;
    let codeFrom = null;
    let titleCol = null;
    // Sheets with header rows only read rows under a header (not the project details above it)
    const hasHeader = rows.some(r => headerColumns(r.cells));
    for (const { row, cells } of rows) {
      const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
      const header = headerColumns(cells);
      if (header) {
        codeFrom = header.code;
        titleCol = header.title;
        continue;
      }
      // "ISSUE NO:" label followed by the issue number
      const issueLabel = cols.find(c => /^ISSUE NO\.?:?$/.test(norm(cells[c])));
      if (issueLabel !== undefined) {
        const value = cols.find(c => c > issueLabel && /^\d+$/.test(cells[c].trim()));
        if (value !== undefined) issue = parseInt(cells[value], 10);
      }
      let code = null;
      let title = null;
      let place = null;
      if (codeFrom !== null) {
        const codeCols = cols.filter(c => c >= codeFrom && c < titleCol);
        code = codeCols.map(c => cells[c].trim()).join('').replace(/\s+/g, '').toUpperCase();
        title = cells[titleCol];
        place = { row, codeCols, titleCol };
      } else if (!hasHeader) {
        const i = cols.findIndex(c => isLooseCode(cells[c].trim().toUpperCase()));
        if (i >= 0) {
          code = cells[cols[i]].trim().toUpperCase();
          title = cells[cols[i + 1]];
          place = { row, codeCols: [cols[i]], titleCol: cols[i + 1] };
        }
      }
      code = code && code.replace(/-+$/, '');
      if (code && isLooseCode(code) && title && collapse(title) && !(code in titles)) {
        titles[code] = collapse(title);
        places[code] = place;
      }
    }
    return { titles, issue, places };
  }

  // parts: { workbook, rels, sharedStrings, styles, sheets: { 'xl/worksheets/sheet1.xml': xml } }
  // Returns { titles, sheet, issue } for the current register sheet: the one with the highest
  // issue number, or the last sheet with drawings when there are no issue numbers.
  function readXlsxRegister(parts) {
    const sharedStrings = parts.sharedStrings
      ? findElements(parts.sharedStrings, 'si').map(si => stringItemText(si.xml))
      : [];
    const zeroPad = zeroPadStyles(parts.styles);
    const targets = {};
    for (const m of (parts.rels || '').matchAll(/<Relationship\s[^>]*>/g)) {
      const id = (/\bId="([^"]+)"/.exec(m[0]) || [])[1];
      const target = (/\bTarget="([^"]+)"/.exec(m[0]) || [])[1];
      if (id && target) targets[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
    }
    const sheets = [];
    for (const m of (parts.workbook || '').matchAll(/<sheet\s[^>]*\/?>/g)) {
      const name = decodeXml((/\bname="([^"]*)"/.exec(m[0]) || [])[1] || '');
      const rid = (/\br:id="([^"]+)"/.exec(m[0]) || [])[1];
      const path = targets[rid];
      if (path && parts.sheets[path]) sheets.push({ name, path });
    }
    let best = null;
    sheets.forEach((sheet, order) => {
      const found = readSheetDrawings(readSheetRows(parts.sheets[sheet.path], sharedStrings, zeroPad));
      if (!Object.keys(found.titles).length) return;
      const candidate = { titles: found.titles, places: found.places, sheet: sheet.name, path: sheet.path, issue: found.issue, order };
      if (!best) best = candidate;
      else if (candidate.issue !== null && best.issue !== null) {
        if (candidate.issue >= best.issue) best = candidate;
      } else if (candidate.issue !== null || best.issue === null) best = candidate;
    });
    return best
      ? { titles: best.titles, places: best.places, sheet: best.sheet, path: best.path, issue: best.issue }
      : { titles: {}, places: {}, sheet: null, path: null, issue: null };
  }

  function columnName(index) {
    let name = '';
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  }

  // Set cells in one row of a worksheet: values { columnIndex: text }. Text goes in as an inline
  // string, except whole numbers replacing a number (which stay numbers). Styles are kept.
  function setRowCells(rowXml, rowNum, values, zeroPad) {
    const { open, inner, close } = splitElement(rowXml);
    const cells = childElements(inner);
    for (const [colText, text] of Object.entries(values)) {
      const col = Number(colText);
      const ref = columnName(col) + rowNum;
      const i = cells.findIndex(c => (/\br="([A-Z]+\d+)"/.exec(c) || [])[1] === ref);
      const old = i >= 0 ? cells[i] : null;
      const oldOpen = old ? /^<c\b[^>]*?(?=\/?>)/.exec(old)[0] : `<c r="${ref}"`;
      const style = (/\bs="(\d+)"/.exec(oldOpen) || [])[1];
      const wasNumber = !!old && !/\bt="/.test(oldOpen) && /<v>/.test(old);
      const width = style !== undefined ? zeroPad[style] || 0 : 0;
      const keepNumber = wasNumber && /^\d+$/.test(text) && (!/^0\d/.test(text) || width === text.length);
      const attrs = oldOpen.replace(/\s+t="[^"]*"/, '');
      const cell = keepNumber
        ? `${attrs}><v>${parseInt(text, 10)}</v></c>`
        : `${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
      if (i >= 0) cells[i] = cell;
      else {
        // Keep cells in column order
        const at = cells.findIndex(c => columnIndex((/\br="([A-Z]+)\d+"/.exec(c) || [])[1] || 'A') > col);
        cells.splice(at < 0 ? cells.length : at, 0, cell);
      }
    }
    return open + cells.join('') + close;
  }

  // Change titles and drawing numbers on the current register sheet of an Excel register.
  // edits: { titles: { code: newTitle }, numbers: { code: newCode } } (codes as currently in the
  // register). A code split one field per cell is split the same way again, so a new number must
  // have the same number of fields. Returns { path, sheet, xml (of that sheet), applied: { titles,
  // numbers } ({ code: { from, to } }), notFound: [code], errors: [message] }.
  function editXlsxRegister(parts, edits) {
    const reg = readXlsxRegister(parts);
    if (!reg.path) throw new Error('No drawings found in the workbook.');
    const zeroPad = zeroPadStyles(parts.styles);
    const sharedStrings = parts.sharedStrings ? findElements(parts.sharedStrings, 'si').map(si => stringItemText(si.xml)) : [];
    const rowCells = {};
    for (const r of readSheetRows(parts.sheets[reg.path], sharedStrings, zeroPad)) rowCells[r.row] = r.cells;

    const applied = { titles: {}, numbers: {} };
    const notFound = [];
    const errors = [];
    const byRow = {}; // row => { column: text }
    const set = (row, col, text) => ((byRow[row] = byRow[row] || {})[col] = text);

    for (const [code, title] of Object.entries(edits.titles || {})) {
      const place = reg.places[code];
      if (!place) {
        notFound.push(code);
        continue;
      }
      const to = collapse(title);
      if (to === reg.titles[code]) continue;
      set(place.row, place.titleCol, to);
      applied.titles[code] = { from: reg.titles[code], to };
    }
    for (const [code, number] of Object.entries(edits.numbers || {})) {
      const place = reg.places[code];
      if (!place) {
        notFound.push(code);
        continue;
      }
      const to = number.trim().toUpperCase();
      if (to === code) continue;
      const cols = place.codeCols;
      if (cols.length === 1) set(place.row, cols[0], to);
      else {
        const fields = to.split('-');
        if (fields.length !== cols.length) {
          errors.push(`${code} is split over ${cols.length} cells, but ${to} has ${fields.length} parts`);
          continue;
        }
        // Keep each cell's own trailing hyphen ("PAWE-", "DA-", ... "0001"); only changed
        // fields are rewritten
        cols.forEach((col, i) => {
          const old = (rowCells[place.row] || {})[col] || '';
          const value = fields[i] + (/-\s*$/.test(old) ? '-' : '');
          if (value !== old.trim()) set(place.row, col, value);
        });
      }
      applied.numbers[code] = { from: code, to };
    }

    let xml = parts.sheets[reg.path];
    const rowNumOf = r => parseInt((/\br="(\d+)"/.exec(r.xml) || [])[1], 10);
    const rows = findElements(xml, 'row').filter(r => byRow[rowNumOf(r)]);
    for (const r of rows.reverse()) {
      xml = xml.slice(0, r.start) + setRowCells(r.xml, rowNumOf(r), byRow[rowNumOf(r)], zeroPad) + xml.slice(r.end);
    }
    return { path: reg.path, sheet: reg.sheet, xml, applied, notFound, errors };
  }

  // How many cells a drawing's code is split over in an Excel register (1 when it's one cell)
  function xlsxCodeCells(reg, code) {
    const place = reg && reg.places && reg.places[code];
    return place ? place.codeCols.length : 1;
  }

  // The worksheet parts readXlsxRegister needs, from a JSZip archive
  async function loadXlsxParts(zip) {
    const text = async p => (zip.file(p) ? zip.file(p).async('string') : null);
    const parts = {
      workbook: await text('xl/workbook.xml'),
      rels: await text('xl/_rels/workbook.xml.rels'),
      sharedStrings: await text('xl/sharedStrings.xml'),
      styles: await text('xl/styles.xml'),
      sheets: {}
    };
    if (!parts.workbook) throw new Error("This doesn't look like an Excel workbook.");
    for (const p of Object.keys(zip.files).filter(f => /^xl\/worksheets\/[^/]+\.xml$/.test(f))) {
      parts.sheets[p] = await text(p);
    }
    return parts;
  }

  // --------------------
  // Matching file names
  // --------------------

  // Returns a function fileName -> drawing number (or null). The longest drawing number that
  // appears in the name as a whole wins, so "PA-002-A.pdf" matches PA-002-A rather than PA-002,
  // and "PA-0010.pdf" doesn't match PA-001. Ties go to the first entry in the register.
  function makeMatcher(tokens) {
    const ordered = tokens
      .map((token, i) => ({ token, i, re: new RegExp('(?<![A-Z0-9])' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Z0-9])') }))
      .sort((a, b) => b.token.length - a.token.length || a.i - b.i);
    return function match(fileName) {
      const upper = fileName.toUpperCase();
      const hit = ordered.find(t => t.re.test(upper));
      return hit ? hit.token : null;
    };
  }

  // For long codes (5 or more fields, as in ISO 19650 names) only: returns a function
  // fileName -> the one register code whose fields are the same as the code at the start of the
  // file name in a different order (e.g. PAWE-BF-XX-DR-DA-A-6002 for PAWE-DA-BF-XX-DR-A-6002),
  // or null when there's none or more than one.
  function makeReorderedMatcher(tokens) {
    const key = parts => parts.slice().sort().join('-');
    const byLength = {};
    for (const token of tokens) {
      const parts = token.split('-');
      if (parts.length < 5) continue;
      const k = key(parts);
      const bucket = (byLength[parts.length] = byLength[parts.length] || {});
      (bucket[k] = bucket[k] || []).push(token);
    }
    const lengths = Object.keys(byLength).map(Number);
    return function match(fileName) {
      const lead = /^[A-Z0-9]+(?:-[A-Z0-9]+)+/.exec(fileName.toUpperCase());
      if (!lead) return null;
      const parts = lead[0].split('-');
      const hits = new Set();
      for (const n of lengths) {
        if (parts.length < n) continue;
        for (const t of byLength[n][key(parts.slice(0, n))] || []) hits.add(t);
      }
      return hits.size === 1 ? [...hits][0] : null;
    };
  }

  // --------------------
  // Word (.docx) XML helpers
  // --------------------
  function decodeXml(s) {
    return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (all, e) => {
      switch (e.toLowerCase()) {
        case 'lt': return '<';
        case 'gt': return '>';
        case 'amp': return '&';
        case 'quot': return '"';
        case 'apos': return "'";
        default: return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      }
    });
  }

  function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Outermost <tag>...</tag> elements in xml (nesting-aware): [{ start, end, xml }]
  function findElements(xml, tag, from = 0, to = xml.length) {
    const re = new RegExp('<(/?)' + tag + '(?=[\\s/>])[^>]*?(/?)>', 'g');
    re.lastIndex = from;
    const out = [];
    let depth = 0;
    let start = -1;
    let m;
    while ((m = re.exec(xml)) !== null && m.index < to) {
      const closing = m[1] === '/';
      const selfClosing = m[2] === '/';
      if (!closing) {
        if (depth === 0) start = m.index;
        if (selfClosing) {
          if (depth === 0) out.push({ start, end: re.lastIndex, xml: xml.slice(start, re.lastIndex) });
        } else depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0) out.push({ start, end: re.lastIndex, xml: xml.slice(start, re.lastIndex) });
      }
    }
    return out;
  }

  // Direct children of an element's content, as strings (tags only; text between them is ignored)
  function childElements(inner) {
    const out = [];
    const re = /<(\/?)([\w:]+)(?=[\s/>])[^>]*?(\/?)>/g;
    let depth = 0;
    let start = -1;
    let m;
    while ((m = re.exec(inner)) !== null) {
      const closing = m[1] === '/';
      const selfClosing = m[3] === '/';
      if (!closing) {
        if (depth === 0) start = m.index;
        if (selfClosing) {
          if (depth === 0) out.push(inner.slice(start, re.lastIndex));
        } else depth++;
      } else {
        depth--;
        if (depth === 0) out.push(inner.slice(start, re.lastIndex));
      }
    }
    return out;
  }

  function tagName(el) {
    const m = /^<([\w:]+)/.exec(el);
    return m ? m[1] : '';
  }

  // Split an element into its open tag, inner content and close tag
  function splitElement(el) {
    const open = /^<[^>]*>/.exec(el)[0];
    if (open.endsWith('/>')) return { open, inner: '', close: '' };
    const closeStart = el.lastIndexOf('</');
    return { open, inner: el.slice(open.length, closeStart), close: el.slice(closeStart) };
  }

  // Visible text of a paragraph (as Word shows it with tracked changes accepted)
  function paragraphText(p) {
    let text = '';
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(?:tab|br|cr)\/>/g;
    let m;
    while ((m = re.exec(p)) !== null) text += m[1] !== undefined ? decodeXml(m[1]) : ' ';
    return text;
  }

  function collapse(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function paragraphsOf(cellXml) {
    return findElements(cellXml, 'w:p');
  }

  // A cell's text with its lines joined by spaces
  function cellText(cellXml) {
    return collapse(paragraphsOf(cellXml).map(p => paragraphText(p.xml)).join(' '));
  }

  // Table rows whose first cell is a drawing number: [{ token, row, titleCell }]
  function registerRows(xml) {
    const rows = [];
    for (const tr of findElements(xml, 'w:tr')) {
      const cells = findElements(xml, 'w:tc', tr.start, tr.end);
      if (cells.length < 2) continue;
      const token = cellText(cells[0].xml);
      if (DRAWING_NUMBER_RE.test(token)) rows.push({ token, row: tr, cells, titleCell: cells[1] });
    }
    return rows;
  }

  // word/document.xml -> { drawingNumber: title }, first row wins for repeated numbers
  function readDocxTitles(xml) {
    const map = {};
    for (const { token, titleCell } of registerRows(xml)) {
      const title = cellText(titleCell.xml);
      if (title && !(token in map)) map[token] = title;
    }
    return map;
  }

  // --------------------
  // Writing titles into Word
  // --------------------
  const CONTENT_TAGS = ['w:r', 'w:ins', 'w:del', 'w:hyperlink', 'w:smartTag', 'w:proofErr', 'w:fldSimple', 'w:moveFrom', 'w:moveTo'];

  function makeRevisions(xml, author, date) {
    let id = 0;
    const re = /\sw:id="(\d+)"/g;
    let m;
    while ((m = re.exec(xml)) !== null) id = Math.max(id, parseInt(m[1], 10));
    return {
      attrs() {
        id++;
        return ` w:id="${id}" w:author="${escapeXml(author).replace(/"/g, '&quot;')}" w:date="${date}"`;
      }
    };
  }

  // Formatting of the first run in the paragraph, without any recorded formatting change.
  // An empty paragraph falls back to its paragraph mark's formatting.
  function firstRunProps(inner) {
    const run = findElements(inner, 'w:r')[0];
    let rPr = '';
    if (run) {
      rPr = childElements(splitElement(run.xml).inner).find(c => tagName(c) === 'w:rPr') || '';
    } else {
      const pPr = childElements(inner).find(c => tagName(c) === 'w:pPr');
      rPr = pPr ? childElements(splitElement(pPr).inner).find(c => tagName(c) === 'w:rPr') || '' : '';
    }
    return rPr.replace(/<w:rPrChange[\s>][\s\S]*?<\/w:rPrChange>/g, '').replace(/<w:(ins|del)\s[^>]*\/>/g, '');
  }

  function newRun(rPr, text) {
    return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  }

  // A run marked as deleted text
  function asDeleted(run) {
    return run.replace(/<w:t(?=[\s>])/g, '<w:delText').replace(/<\/w:t>/g, '</w:delText>')
      .replace(/<w:instrText(?=[\s>])/g, '<w:delInstrText').replace(/<\/w:instrText>/g, '</w:delInstrText>');
  }

  // Mark every run inside `inner` as deleted (for tracked changes)
  function deleteRuns(inner, rev) {
    return childElements(inner).map(child => {
      const tag = tagName(child);
      if (tag === 'w:r') return `<w:del${rev.attrs()}>${asDeleted(child)}</w:del>`;
      if (tag === 'w:del' || tag === 'w:proofErr') return tag === 'w:del' ? child : '';
      if (tag === 'w:ins' || tag === 'w:hyperlink' || tag === 'w:smartTag') {
        const parts = splitElement(child);
        return parts.open + deleteRuns(parts.inner, rev) + parts.close;
      }
      return child;
    }).join('');
  }

  // Replace the text of one paragraph, keeping its paragraph properties and first run's formatting
  function setParagraphText(p, text, opts, rev) {
    const { open, inner, close } = splitElement(p);
    const children = childElements(inner);
    const pPr = children.find(c => tagName(c) === 'w:pPr') || '';
    const body = children.filter(c => c !== pPr);
    const rPr = firstRunProps(inner);
    const firstContent = body.findIndex(c => CONTENT_TAGS.includes(tagName(c)));
    const insertAt = firstContent < 0 ? body.length : firstContent;

    let result;
    if (opts.tracked) {
      const deleted = deleteRuns(body.join(''), rev);
      const inserted = text ? `<w:ins${rev.attrs()}>${newRun(rPr, text)}</w:ins>` : '';
      result = deleted + inserted;
    } else {
      // Keep bookmarks and comment ranges; replace all text with a single run
      const kept = body.filter(c => !CONTENT_TAGS.includes(tagName(c)));
      const before = body.slice(0, insertAt).filter(c => kept.includes(c));
      const after = body.slice(insertAt).filter(c => kept.includes(c));
      result = before.join('') + (text ? newRun(rPr, text) : '') + after.join('');
    }
    return open + pPr + result + close;
  }

  // Record a paragraph mark as deleted, so Word merges the paragraph with the next one
  function deleteParagraphMark(p, rev) {
    const mark = `<w:del${rev.attrs()}/>`;
    const { open, inner, close } = splitElement(p);
    const children = childElements(inner);
    const pPr = children.find(c => tagName(c) === 'w:pPr');
    if (!pPr) return open + `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>` + inner + close;
    const parts = splitElement(pPr);
    const pChildren = childElements(parts.inner);
    const rPr = pChildren.find(c => tagName(c) === 'w:rPr');
    let newPPr;
    if (rPr) {
      const r = splitElement(rPr);
      newPPr = parts.open + parts.inner.replace(rPr, r.open + mark + r.inner + r.close) + parts.close;
    } else {
      // rPr goes before any sectPr / pPrChange
      const late = pChildren.findIndex(c => ['w:sectPr', 'w:pPrChange'].includes(tagName(c)));
      const list = pChildren.slice();
      list.splice(late < 0 ? list.length : late, 0, `<w:rPr>${mark}</w:rPr>`);
      newPPr = parts.open + list.join('') + parts.close;
    }
    return open + inner.replace(pPr, newPPr) + close;
  }

  // New content for a title cell. Leading and trailing lines of a multi-line title that the new
  // title still starts/ends with are left untouched; the changed text goes on the first line that
  // differs, and lines no longer needed are removed.
  function setCellTitle(cellXml, title, opts, rev) {
    const paras = paragraphsOf(cellXml);
    if (!paras.length) return cellXml;
    const texts = paras.map(p => collapse(paragraphText(p.xml)));
    const n = paras.length;

    let first = 0;
    let rest = title;
    while (first < n - 1 && texts[first] && rest.startsWith(texts[first] + ' ')) {
      rest = rest.slice(texts[first].length + 1);
      first++;
    }
    let end = n; // lines from `end` onwards are kept as they are
    while (end - 1 > first && texts[end - 1] && rest.endsWith(' ' + texts[end - 1])) {
      rest = rest.slice(0, rest.length - texts[end - 1].length - 1);
      end--;
    }

    const replaced = paras.map((p, i) => {
      if (i < first || i >= end) return p.xml;
      if (i === first) return rest === texts[i] && end === first + 1 ? p.xml : setParagraphText(p.xml, rest, opts, rev);
      if (!opts.tracked) return '';
      return setParagraphText(p.xml, '', opts, rev);
    });

    if (opts.tracked) {
      // Merge removed lines away: delete their marks, or if nothing follows them in the cell,
      // the marks from the changed line up to the second-last line
      const marks = [];
      if (end < n) for (let i = first + 1; i < end; i++) marks.push(i);
      else for (let i = first; i < n - 1; i++) marks.push(i);
      for (const i of marks) replaced[i] = deleteParagraphMark(replaced[i], rev);
    }

    let out = '';
    let pos = 0;
    paras.forEach((p, i) => {
      out += cellXml.slice(pos, p.start) + replaced[i];
      pos = p.end;
    });
    return out + cellXml.slice(pos);
  }

  // Apply { drawingNumber: newTitle } to word/document.xml.
  // opts: { tracked: bool, author: string, date: ISO string }
  // Returns { xml, applied: { token: { from, to } }, notFound: [token] }
  function editDocxTitles(xml, edits, opts = {}) {
    return editDocxCells(xml, edits, 1, opts);
  }

  // Apply { drawingNumber: newNumber } to word/document.xml (renumbering drawings); as editDocxTitles.
  function editDocxNumbers(xml, edits, opts = {}) {
    return editDocxCells(xml, edits, 0, opts);
  }

  // Replace the text of one column (0 = number, 1 = title) in the rows of the given drawings
  function editDocxCells(xml, edits, column, opts) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const applied = {};
    const changes = [];
    for (const { token, cells } of registerRows(xml)) {
      if (!(token in edits) || token in applied) continue;
      const target = cells[column];
      const from = cellText(target.xml);
      const to = collapse(edits[token]);
      applied[token] = { from, to };
      if (from === to) continue;
      changes.push({ start: target.start, end: target.end, xml: setCellTitle(target.xml, to, opts, rev) });
    }
    let out = xml;
    for (const c of changes.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.xml + out.slice(c.end);
    }
    return { xml: out, applied, notFound: Object.keys(edits).filter(t => !(t in applied)) };
  }

  // --------------------
  // Adding rows to the Word register
  // --------------------

  // A copy of a row with all tracked changes accepted and ids that must be unique removed
  function cleanRowCopy(rowXml) {
    let xml = rowXml
      .replace(/\sw14:(paraId|textId)="[^"]*"/g, '')
      .replace(/<w:(bookmarkStart|bookmarkEnd|proofErr|vMerge)(\s[^>]*)?\/>/g, '')
      .replace(/<w:(ins|del)\s[^>]*\/>/g, '');
    for (const tag of ['w:del', 'w:rPrChange', 'w:pPrChange', 'w:trPrChange', 'w:tcPrChange', 'w:moveFrom']) {
      for (const el of findElements(xml, tag).reverse()) xml = xml.slice(0, el.start) + xml.slice(el.end);
    }
    // Keep inserted text, drop the insertion wrapper
    return xml.replace(/<w:(ins|moveTo)(\s[^>]*)?>/g, '').replace(/<\/w:(ins|moveTo)>/g, '');
  }

  // Mark a paragraph's runs and mark as inserted
  function markParagraphInserted(p, rev) {
    const { open, inner, close } = splitElement(p);
    const children = childElements(inner);
    let pPr = children.find(c => tagName(c) === 'w:pPr');
    const mark = `<w:ins${rev.attrs()}/>`;
    if (!pPr) pPr = `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
    else {
      const parts = splitElement(pPr);
      const pChildren = childElements(parts.inner);
      const rPr = pChildren.find(c => tagName(c) === 'w:rPr');
      if (rPr) {
        const r = splitElement(rPr);
        pPr = parts.open + parts.inner.replace(rPr, r.open + mark + r.inner + r.close) + parts.close;
      } else {
        const late = pChildren.findIndex(c => ['w:sectPr', 'w:pPrChange'].includes(tagName(c)));
        pChildren.splice(late < 0 ? pChildren.length : late, 0, `<w:rPr>${mark}</w:rPr>`);
        pPr = parts.open + pChildren.join('') + parts.close;
      }
    }
    const body = children.filter(c => tagName(c) !== 'w:pPr')
      .map(c => tagName(c) === 'w:r' ? `<w:ins${rev.attrs()}>${c}</w:ins>` : c).join('');
    return open + pPr + body + close;
  }

  // Mark a row as inserted in its row properties
  function markRowInserted(rowXml, rev) {
    const { open, inner, close } = splitElement(rowXml);
    const children = childElements(inner);
    const trPr = children.find(c => tagName(c) === 'w:trPr');
    const mark = `<w:ins${rev.attrs()}/>`;
    if (trPr) {
      const parts = splitElement(trPr);
      return open + inner.replace(trPr, parts.open + parts.inner + mark + parts.close) + close;
    }
    // trPr goes after tblPrEx, before the first cell
    const exIdx = children.findIndex(c => tagName(c) === 'w:tblPrEx');
    children.splice(exIdx + 1, 0, `<w:trPr>${mark}</w:trPr>`);
    return open + children.join('') + close;
  }

  // Build a new register row from a template row: number, title, scale and size in the first
  // four cells; the issue columns are cleared unless copyMarks is set.
  function buildRow(templateXml, entry, opts, rev) {
    let row = cleanRowCopy(templateXml);
    const values = [entry.token, entry.title, entry.scale || '', entry.size || ''];
    const cells = findElements(row, 'w:tc');
    for (let i = cells.length - 1; i >= 0; i--) {
      const cell = cells[i].xml;
      const paras = paragraphsOf(cell);
      if (!paras.length) continue;
      let newCell;
      if (i >= values.length && entry.copyMarks) {
        newCell = cell;
      } else {
        // One paragraph holding the new value
        const text = i < values.length ? collapse(values[i]) : '';
        const first = setParagraphText(paras[0].xml, text, { tracked: false });
        newCell = cell.slice(0, paras[0].start) + first + cell.slice(paras[paras.length - 1].end);
      }
      if (opts.tracked) {
        let marked = '';
        let pos = 0;
        for (const p of paragraphsOf(newCell)) {
          marked += newCell.slice(pos, p.start) + markParagraphInserted(p.xml, rev);
          pos = p.end;
        }
        newCell = marked + newCell.slice(pos);
      }
      row = row.slice(0, cells[i].start) + newCell + row.slice(cells[i].end);
    }
    return opts.tracked ? markRowInserted(row, rev) : row;
  }

  // Insert new register rows, each after the row of entry.after (or after the last register row
  // when that isn't found), copying that row's formatting.
  // entries: [{ token, title, scale, size, after, copyMarks }]; opts as for editDocxTitles.
  // Returns { xml, inserted: [token], skipped: [token already in the register] }
  function insertDocxRows(xml, entries, opts = {}) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const rows = registerRows(xml);
    if (!rows.length) throw new Error('No drawing rows found in the document to copy formatting from.');
    const existing = new Set(rows.map(r => r.token));
    const firstRowOf = {};
    for (const r of rows) if (!(r.token in firstRowOf)) firstRowOf[r.token] = r.row;
    const last = rows[rows.length - 1].row;

    const inserted = [];
    const skipped = [];
    const byAnchor = new Map(); // row start -> { row, html }
    for (const entry of entries) {
      if (existing.has(entry.token)) {
        skipped.push(entry.token);
        continue;
      }
      const atStart = entry.after === '';
      const anchor = atStart ? rows[0].row : firstRowOf[entry.after] || last;
      const key = (atStart ? 'before:' : 'after:') + anchor.start;
      if (!byAnchor.has(key)) byAnchor.set(key, { row: anchor, atStart, add: '' });
      byAnchor.get(key).add += buildRow(anchor.xml, entry, opts, rev);
      existing.add(entry.token);
      inserted.push(entry.token);
    }
    let out = xml;
    // Insert from the end so earlier positions stay valid
    const at = x => (x.atStart ? x.row.start : x.row.end);
    for (const x of [...byAnchor.values()].sort((a, b) => at(b) - at(a))) {
      out = out.slice(0, at(x)) + x.add + out.slice(at(x));
    }
    return { xml: out, inserted, skipped };
  }

  // Mark a whole row as deleted (for tracked changes)
  function markRowDeleted(rowXml, rev) {
    let row = rowXml;
    const paras = findElements(row, 'w:p');
    for (let i = paras.length - 1; i >= 0; i--) {
      const p = paras[i].xml;
      const { open, inner, close } = splitElement(p);
      const children = childElements(inner);
      const pPr = children.find(c => tagName(c) === 'w:pPr') || '';
      const body = children.filter(c => c !== pPr).join('');
      const deleted = deleteParagraphMark(open + pPr + deleteRuns(body, rev) + close, rev);
      row = row.slice(0, paras[i].start) + deleted + row.slice(paras[i].end);
    }
    const { open, inner, close } = splitElement(row);
    const children = childElements(inner);
    const trPr = children.find(c => tagName(c) === 'w:trPr');
    const mark = `<w:del${rev.attrs()}/>`;
    if (trPr) {
      const parts = splitElement(trPr);
      return open + inner.replace(trPr, parts.open + parts.inner + mark + parts.close) + close;
    }
    const exIdx = children.findIndex(c => tagName(c) === 'w:tblPrEx');
    children.splice(exIdx + 1, 0, `<w:trPr>${mark}</w:trPr>`);
    return open + children.join('') + close;
  }

  // Move drawing rows, one after another: [{ token, after }] where after is the drawing to follow
  // ('' = before the first drawing row). With opts.tracked the old row is marked deleted and a
  // copy is inserted at the new place (Word can't track moves of table rows).
  // Returns { xml, moved: [token], notFound: [token] }
  function moveDocxRows(xml, moves, opts = {}) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const moved = [];
    const notFound = [];
    let out = xml;
    for (const { token, after } of moves) {
      const rows = registerRows(out);
      const source = rows.find(r => r.token === token);
      if (!source || token === after) {
        notFound.push(token);
        continue;
      }
      const rowXml = source.row.xml;
      let withoutRow;
      let copy;
      if (opts.tracked) {
        withoutRow = out.slice(0, source.row.start) + markRowDeleted(rowXml, rev) + out.slice(source.row.end);
        copy = markRowInserted(cleanRowCopy(rowXml), rev);
        let marked = '';
        let pos = 0;
        for (const p of findElements(copy, 'w:p')) {
          marked += copy.slice(pos, p.start) + markParagraphInserted(p.xml, rev);
          pos = p.end;
        }
        copy = marked + copy.slice(pos);
      } else {
        withoutRow = out.slice(0, source.row.start) + out.slice(source.row.end);
        copy = rowXml;
      }
      const remaining = registerRows(withoutRow);
      if (!remaining.length) {
        notFound.push(token);
        continue;
      }
      if (after === '') {
        const first = remaining[0].row;
        out = withoutRow.slice(0, first.start) + copy + withoutRow.slice(first.start);
      } else {
        const anchor = (remaining.find(r => r.token === after) || remaining[remaining.length - 1]).row;
        out = withoutRow.slice(0, anchor.end) + copy + withoutRow.slice(anchor.end);
      }
      moved.push(token);
    }
    return { xml: out, moved, notFound };
  }

  // Text of the cells after number/title/scale/size in a drawing's row (its revision marks)
  function readRowMarks(xml, token) {
    const r = registerRows(xml).find(x => x.token === token);
    if (!r) return [];
    return findElements(xml, 'w:tc', r.row.start, r.row.end).slice(4).map(c => cellText(c.xml));
  }

  // Scale and size cells of each drawing row: { token: { scale, size } }
  function readDocxDetails(xml) {
    const details = {};
    for (const { token, row } of registerRows(xml)) {
      if (token in details) continue;
      const cells = findElements(xml, 'w:tc', row.start, row.end);
      details[token] = { scale: cells[2] ? cellText(cells[2].xml) : '', size: cells[3] ? cellText(cells[3].xml) : '' };
    }
    return details;
  }

  return {
    DRAWING_NUMBER,
    parsePdfText,
    readTitleBlock,
    splitScale,
    sheetSizeOf,
    isLooseCode,
    readXlsxRegister,
    editXlsxRegister,
    xlsxCodeCells,
    loadXlsxParts,
    makeMatcher,
    makeReorderedMatcher,
    readDocxTitles,
    readDocxDetails,
    readRowMarks,
    editDocxTitles,
    editDocxNumbers,
    insertDocxRows,
    moveDocxRows,
    decodeXml
  };
});
