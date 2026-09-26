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
  // { title, rev, scale, size, project, client, sources } ('' or [] where not found). Items are { str, x, y, h, rotated } in PDF units
  // as the sheet is displayed (rotation applied), y upwards; page is { width, height }. Items may
  // also give their reading direction { dx, dy } (y upwards), so a sheet plotted sideways on the
  // page can be turned to read its title block.
  function readTitleBlock(items, page) {
    ({ items, page } = uprightSheet(items, page));
    // Only horizontal text; rotated notes and dimensions aren't title block fields
    const text = items.filter(i => i.str.trim() && !i.rotated);
    const scaleField = readField(text, SCALE_LABEL_RE);
    const sizeField = readField(text, SIZE_LABEL_RE);
    const parsed = splitScale(scaleField);
    return {
      title: readLabelled(text, TITLE_LABEL_RE),
      project: readLabelled(text, PROJECT_LABEL_RE),
      client: readLabelled(text, CLIENT_LABEL_RE),
      rev: readRevision(text),
      scale: parsed.scale || scalesOnSheet(items),
      size: (sizeField.match(SHEET_SIZE_RE) || [])[0] || parsed.size || (page ? sheetSizeOf(page.width, page.height) : ''),
      sources: sourceFiles(items)
    };
  }

  // The drawing's source model or CAD file, when the sheet prints its path (Revit and AutoCAD can
  // add it to the title block): the path as printed, or [] if there isn't one. A path wrapped onto
  // the next line is joined back with a space, and also without one in case the break was mid-word,
  // so it gives the ways to try, most likely first.
  const SOURCE_START_RE = /[A-Za-z]:\\|\\\\[^\\\s]+\\/;
  const SOURCE_FILE_RE = /(?:[A-Za-z]:\\|\\\\[^\\\s]+\\)[^<>"|?*\r\n]*?\.(?:rvt|rfa|rte|dwg|dxf|dgn|pln|pla|skp|ifc|nwd|nwf|3dm)(?![A-Za-z0-9])/i;
  function sourceFiles(items) {
    const strs = items.map(i => i.str).filter(s => s.trim());
    for (let k = 0; k < strs.length; k++) {
      if (!SOURCE_START_RE.test(strs[k])) continue;
      const parts = [strs[k].trim()];
      for (let n = 1; n <= 3; n++) {
        const m = SOURCE_FILE_RE.exec(parts.join(' '));
        if (m) {
          const spaced = m[0].trim();
          const joined = SOURCE_FILE_RE.exec(parts.join(''));
          return parts.length > 1 && joined && joined[0].trim() !== spaced ? [spaced, joined[0].trim()] : [spaced];
        }
        if (k + n >= strs.length) break;
        parts.push(strs[k + n].trim());
      }
    }
    return [];
  }

  // A sheet's items and size turned so that its title block reads left to right: the way most of
  // the title block labels read (or, without any, most of the text), in quarter turns. Unchanged
  // when that's already upright or the items don't give their direction.
  const LABEL_RES = () => [TITLE_LABEL_RE, PROJECT_LABEL_RE, CLIENT_LABEL_RE, REV_LABEL_RE, SCALE_LABEL_RE, SIZE_LABEL_RE];
  function uprightSheet(items, page) {
    const quarter = i => (Math.round(Math.atan2(i.dy, i.dx) / (Math.PI / 2)) + 4) % 4;
    const withDir = items.filter(i => i.str.trim() && Number.isFinite(i.dx) && Number.isFinite(i.dy) && (i.dx || i.dy));
    if (!withDir.length) return { items, page };
    const tally = (list, weight) => {
      const counts = [0, 0, 0, 0];
      for (const i of list) counts[quarter(i)] += weight(i);
      return counts.indexOf(Math.max(...counts));
    };
    const labels = withDir.filter(i => LABEL_RES().some(re => re.test(i.str)));
    const turn = labels.length ? tally(labels, () => 1) : tally(withDir, i => i.str.trim().length);
    if (!turn) return { items, page };
    // Turn the sheet back by `turn` quarter turns (clockwise), keeping coordinates positive
    const rotate = (x, y) => {
      for (let k = 0; k < turn; k++) [x, y] = [y, -x];
      return [x, y];
    };
    const corners = [[0, 0], [page.width, 0], [0, page.height], [page.width, page.height]].map(([x, y]) => rotate(x, y));
    const minX = Math.min(...corners.map(c => c[0])), minY = Math.min(...corners.map(c => c[1]));
    const turned = items.map(i => {
      const [x, y] = rotate(i.x, i.y);
      const out = { ...i, x: x - minX, y: y - minY };
      if (Number.isFinite(i.dx) && Number.isFinite(i.dy)) {
        [out.dx, out.dy] = rotate(i.dx, i.dy);
        out.rotated = Math.abs(out.dy) > Math.abs(out.dx) * 0.05;
      }
      return out;
    });
    return { items: turned, page: turn % 2 ? { width: page.height, height: page.width } : page };
  }

  // The title sits to the right of a "Title." label, from the label's top down to the next label
  // under it (e.g. "Client."), possibly over several lines, which are joined with spaces. The
  // project and client are laid out the same way.
  const TITLE_LABEL_RE = /^\s*(?:drawing\s+|dwg\.?\s+)?title\s*[.:]?\s*$/i;
  const PROJECT_LABEL_RE = /^\s*project\s*[.:]?\s*$/i;
  const CLIENT_LABEL_RE = /^\s*client\s*[.:]?\s*$/i;
  function readLabelled(text, labelRe) {
    let best = '';
    for (const label of text.filter(i => labelRe.test(i.str))) {
      const sameColumn = i => Math.abs(i.x - label.x) < 2;
      const below = text.filter(i => i !== label && sameColumn(i) && i.y < label.y - 1);
      const floor = below.length ? Math.max(...below.map(i => i.y)) : label.y - label.h * 8;
      const top = label.y + label.h;
      const parts = text.filter(i => i.x > label.x + 1 && !sameColumn(i) && i.y < top && i.y > floor);
      const title = joinLines(parts, ' ', true);
      if (title.length > best.length) best = title;
    }
    return best;
  }

  // Items grouped into lines by baseline, top to bottom, each line read left to right
  // With stopAtLabels, reading stops at the first line that is only labels ("Rev." "Status."), the
  // next row of the title block below a field with nothing under it in its own column
  const LABEL_WORD_RE = /^\s*[A-Za-z][A-Za-z ]{0,20}[.:]\s*$/;
  function joinLines(parts, separator, stopAtLabels) {
    const lines = [];
    for (const p of parts) {
      const line = lines.find(l => Math.abs(l.y - p.y) < p.h * 0.4);
      if (line) line.parts.push(p);
      else lines.push({ y: p.y, parts: [p] });
    }
    lines.sort((a, b) => b.y - a.y);
    const end = stopAtLabels ? lines.findIndex(l => l.parts.every(p => LABEL_WORD_RE.test(p.str))) : -1;
    return (end < 0 ? lines : lines.slice(0, end))
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
  const SCALE_HEADERS = ['SCALE', 'SCALES'];
  const SIZE_HEADERS = ['SIZE', 'SHEET SIZE', 'PAPER SIZE', 'DRAWING SIZE', 'DWG SIZE', 'SHEET'];

  // Columns of a "DRAWING CODE" ... "DRAWING TITLE" header row, or null. Scale and size columns
  // are optional (undefined when the sheet has none).
  function headerColumns(cells) {
    const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
    const code = cols.find(c => CODE_HEADERS.includes(norm(cells[c])));
    const title = cols.find(c => TITLE_HEADERS.includes(norm(cells[c])));
    if (code === undefined || title === undefined || title <= code) return null;
    const after = headers => cols.find(c => c > title && headers.includes(norm(cells[c])));
    return { code, title, scale: after(SCALE_HEADERS), size: after(SIZE_HEADERS) };
  }

  // Drawings on one sheet: rows under a "DRAWING CODE" / "DRAWING TITLE" header, the code joined
  // from every cell between the two headers (codes split into one cell per field work too);
  // without such a header, a row whose first text is a code and whose next text is its title
  function readSheetDrawings(rows) {
    const titles = {};
    const details = {}; // code => { scale, size } ('' where the sheet has no such column)
    const places = {}; // code => { row, codeCols, titleCol, scaleCol, sizeCol }: where the drawing's cells are
    let issue = null;
    let codeFrom = null;
    let titleCol = null;
    let scaleCol;
    let sizeCol;
    // Sheets with header rows only read rows under a header (not the project details above it)
    const hasHeader = rows.some(r => headerColumns(r.cells));
    for (const { row, cells } of rows) {
      const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
      const header = headerColumns(cells);
      if (header) {
        codeFrom = header.code;
        titleCol = header.title;
        scaleCol = header.scale;
        sizeCol = header.size;
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
        place = { row, codeCols, titleCol, scaleCol, sizeCol };
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
        const cellOf = col => (col !== undefined && cells[col] ? collapse(cells[col]) : '');
        details[code] = { scale: cellOf(place.scaleCol), size: cellOf(place.sizeCol) };
      }
    }
    return { titles, details, issue, places };
  }

  // parts: { workbook, rels, sharedStrings, styles, sheets: { 'xl/worksheets/sheet1.xml': xml } }
  // Returns { titles, details, places, sheet, path, issue } for the current register sheet: the
  // one with the highest issue number, or the last sheet with drawings when there are no issue
  // numbers. details: { code: { scale, size } }.
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
      const candidate = { titles: found.titles, details: found.details, places: found.places, sheet: sheet.name, path: sheet.path, issue: found.issue, order };
      if (!best) best = candidate;
      else if (candidate.issue !== null && best.issue !== null) {
        if (candidate.issue >= best.issue) best = candidate;
      } else if (candidate.issue !== null || best.issue === null) best = candidate;
    });
    return best
      ? { titles: best.titles, details: best.details, places: best.places, sheet: best.sheet, path: best.path, issue: best.issue }
      : { titles: {}, details: {}, places: {}, sheet: null, path: null, issue: null };
  }

  // --------------------
  // Excel cell fills (the highlighted issue column)
  // --------------------

  // styles.xml -> { xml, fills: [fill xml], xfs: [xf xml] } with helpers to read and add styles
  function styleBook(stylesXml) {
    const section = tag => {
      const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(stylesXml || '');
      return m ? m[1] : '';
    };
    const fills = findElements(section('fills'), 'fill').map(f => f.xml);
    const xfs = findElements(section('cellXfs'), 'xf').map(f => f.xml);
    const added = { fills: [], xfs: [] };
    const book = {
      fills, xfs,
      fillOf: styleIndex => {
        const xf = xfs[styleIndex || 0];
        return xf ? parseInt((/\bfillId="(\d+)"/.exec(xf) || [0, 0])[1], 10) : 0;
      },
      // 'RRGGBB' of a solid fill, or null (none, pattern or theme colour)
      solidColor: fillId => {
        const f = fills[fillId] || '';
        if (!/patternType="solid"/.test(f)) return null;
        const rgb = (/<fgColor\b[^>]*\brgb="([0-9A-Fa-f]{6,8})"/.exec(f) || [])[1];
        return rgb ? rgb.slice(-6).toUpperCase() : null;
      },
      // A fill with this solid colour (reused when the workbook has one)
      solidFill: color => {
        const want = color.toUpperCase();
        const existing = fills.findIndex(f => /patternType="solid"/.test(f) && book.solidColor(fills.indexOf(f)) === want &&
          !/<fgColor\b[^>]*\b(theme|indexed)=/.test(f));
        if (existing >= 0) return existing;
        fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${want}"/><bgColor indexed="64"/></patternFill></fill>`);
        added.fills.push(fills.length - 1);
        return fills.length - 1;
      },
      // The style `styleIndex` with another fill (borders, font, alignment and number format kept)
      withFill: (styleIndex, fillId) => {
        const base = xfs[styleIndex || 0] || xfs[0];
        if (book.fillOf(styleIndex) === fillId) return styleIndex || 0;
        let xf = base.replace(/\bfillId="\d+"/, `fillId="${fillId}"`);
        if (!/\bfillId=/.test(xf)) xf = xf.replace(/^<xf\b/, `<xf fillId="${fillId}"`);
        if (/\bapplyFill="0"/.test(xf)) xf = xf.replace(/\bapplyFill="0"/, 'applyFill="1"');
        else if (!/\bapplyFill=/.test(xf)) xf = xf.replace(/^<xf\b/, '<xf applyFill="1"');
        const same = xfs.indexOf(xf);
        if (same >= 0) return same;
        xfs.push(xf);
        added.xfs.push(xfs.length - 1);
        return xfs.length - 1;
      },
      // styles.xml with the added fills and styles
      toXml: () => {
        let out = stylesXml;
        const append = (tag, child, items) => {
          out = out.replace(new RegExp('(<' + tag + '\\b[^>]*?)(?:\\s+count="\\d+")?(\\s*>)([\\s\\S]*?)(</' + tag + '>)'),
            (m, open, gt, inner, close) => `${open} count="${items.length}"${gt}${inner}${items.slice(items.length - added[child].length).join('')}${close}`);
        };
        if (added.fills.length) append('fills', 'fills', fills);
        if (added.xfs.length) append('cellXfs', 'xfs', xfs);
        return out;
      }
    };
    return book;
  }

  // Style index of every cell in a sheet: { 'T8': 99 }
  function cellStyles(sheetXml) {
    const out = {};
    for (const m of sheetXml.matchAll(/<c\s([^>]*?)\/?>/g)) {
      const ref = (/\br="([A-Z]+\d+)"/.exec(m[1]) || [])[1];
      if (ref) out[ref] = parseInt((/\bs="(\d+)"/.exec(m[1]) || [0, 0])[1], 10);
    }
    return out;
  }

  // Change the style of cells: styles { row: { col: styleIndex } }; missing cells are added empty
  function setCellStyles(sheetXml, styles) {
    let xml = sheetXml;
    const rows = findElements(xml, 'row').filter(r => styles[(/\br="(\d+)"/.exec(r.xml) || [])[1]]);
    for (const r of rows.reverse()) {
      const rowNum = (/\br="(\d+)"/.exec(r.xml) || [])[1];
      const { open, inner, close } = splitElement(r.xml);
      const cells = childElements(inner);
      for (const [colText, style] of Object.entries(styles[rowNum])) {
        const col = Number(colText);
        const ref = columnName(col) + rowNum;
        const i = cells.findIndex(c => (/\br="([A-Z]+\d+)"/.exec(c) || [])[1] === ref);
        if (i >= 0) {
          cells[i] = cells[i].replace(/^<c\b[^>]*?(?=\/?>)/, o => (/\bs="\d+"/.test(o) ? o.replace(/\bs="\d+"/, `s="${style}"`) : `${o} s="${style}"`));
        } else {
          const at = cells.findIndex(c => columnIndex((/\br="([A-Z]+)\d+"/.exec(c) || [])[1] || 'A') > col);
          cells.splice(at < 0 ? cells.length : at, 0, `<c r="${ref}" s="${style}"/>`);
        }
      }
      xml = xml.slice(0, r.start) + (open.endsWith('/>') ? open.replace(/\/>$/, '>') + cells.join('') + '</row>' : open + cells.join('') + close) + xml.slice(r.end);
    }
    return xml;
  }

  // The style of the issue column two over from `col` in a row (issue columns alternate two
  // shades, so it has the column's usual shading): the one before, or after at the first columns
  function neighbourStyle(styles, row, col, firstCol) {
    return [col - 2 >= firstCol ? col - 2 : null, col + 2].filter(c => c !== null)
      .map(c => styles[columnName(c) + row]).find(v => v !== undefined);
  }

  // Cells of an issue column that are highlighted: a solid fill unlike its neighbour's
  function highlightedCells(styles, book, col, rows, firstCol) {
    const found = [];
    for (const row of rows) {
      const own = book.fillOf(styles[columnName(col) + row]);
      const color = book.solidColor(own);
      if (!color) continue;
      const neighbour = neighbourStyle(styles, row, col, firstCol);
      if (neighbour === undefined || book.fillOf(neighbour) !== own) found.push({ row, color });
    }
    return found;
  }

  function columnName(index) {
    let name = '';
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  }

  // Set cells in one row of a worksheet: values { columnIndex: text or { text, number: true } }.
  // Text goes in as an inline string, except whole numbers replacing a number, or asked to be
  // numbers (which are written as numbers). Styles are kept.
  function setRowCells(rowXml, rowNum, values, zeroPad) {
    const { open, inner, close } = splitElement(rowXml);
    const cells = childElements(inner);
    for (const [colText, value] of Object.entries(values)) {
      const text = typeof value === 'object' ? value.text : value;
      const asNumber = typeof value === 'object' && value.number && /^\d+$/.test(text);
      const col = Number(colText);
      const ref = columnName(col) + rowNum;
      const i = cells.findIndex(c => (/\br="([A-Z]+\d+)"/.exec(c) || [])[1] === ref);
      const old = i >= 0 ? cells[i] : null;
      const oldOpen = old ? /^<c\b[^>]*?(?=\/?>)/.exec(old)[0] : `<c r="${ref}"`;
      const style = (/\bs="(\d+)"/.exec(oldOpen) || [])[1];
      const wasNumber = !!old && !/\bt="/.test(oldOpen) && /<v>/.test(old);
      const width = style !== undefined ? zeroPad[style] || 0 : 0;
      const keepNumber = asNumber || (wasNumber && /^\d+$/.test(text) && (!/^0\d/.test(text) || width === text.length));
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

  // Change titles, drawing numbers, scales and sizes on the current register sheet of an Excel
  // register. edits: { titles: { code: newTitle }, numbers: { code: newCode }, scales: { code:
  // scale }, sizes: { code: size } } (codes as currently in the register). A code split one field
  // per cell is split the same way again, so a new number must have the same number of fields.
  // edits.project: { label: value } changes the project fields above the drawings (labels as
  // readXlsxProject gives them). edits.issue: { index, date: { day, month, year } or null, marks:
  // { code: mark }, highlight: 'RRGGBB' or null } dates an issue column (in every date block) and/or
  // sets drawings' marks in it, and highlights it (moving the highlight from the previous column).
  // styles (in the result) is styles.xml, changed when a highlight added styles. Returns { path, sheet, xml (of that sheet), applied: { titles,
  // numbers, scales, sizes, project } ({ code or label: { from, to } }), notFound: [code or label],
  // errors: [message] }.
  function editXlsxRegister(parts, edits) {
    const reg = readXlsxRegister(parts);
    if (!reg.path) throw new Error('No drawings found in the workbook.');
    const zeroPad = zeroPadStyles(parts.styles);
    const sharedStrings = parts.sharedStrings ? findElements(parts.sharedStrings, 'si').map(si => stringItemText(si.xml)) : [];
    const rowCells = {};
    for (const r of readSheetRows(parts.sheets[reg.path], sharedStrings, zeroPad)) rowCells[r.row] = r.cells;

    const applied = { titles: {}, numbers: {}, scales: {}, sizes: {}, project: {}, issue: null };
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
    if (edits.issue) {
      const issues = readXlsxIssues(parts);
      const column = issues.columns[edits.issue.index];
      if (!column) errors.push(`sheet "${reg.sheet}" has no issue column ${edits.issue.index + 1}`);
      else {
        applied.issue = { index: edits.issue.index, date: null, marks: {} };
        const d = edits.issue.date;
        if (d) {
          // Every DAY / MONTH / YEAR block on the sheet (they repeat above each section)
          for (const block of issues.blocks) {
            set(block.day, column.col, d.day);
            set(block.month, column.col, d.month);
            set(block.year, column.col, { text: d.year, number: true });
          }
          applied.issue.date = { from: column.date ? [column.day, column.month, column.year].join('.') : '', to: [d.day, d.month, d.year].join('.') };
        }
        for (const [code, mark] of Object.entries(edits.issue.marks || {})) {
          const place = reg.places[code];
          if (!place) {
            notFound.push(code);
            continue;
          }
          const from = (issues.marks[code] || [])[edits.issue.index] || '';
          if (collapse(mark) === from) continue;
          set(place.row, column.col, collapse(mark));
          applied.issue.marks[code] = { from, to: collapse(mark) };
        }
      }
    }
    if (edits.project && Object.keys(edits.project).length) {
      const { fields } = readXlsxProject(parts);
      for (const [label, value] of Object.entries(edits.project)) {
        const field = fields.find(f => f.label === label);
        if (!field) {
          notFound.push(label);
          continue;
        }
        const to = collapse(value);
        if (to === field.value) continue;
        set(field.ref.row, field.ref.col, to);
        applied.project[label] = { from: field.value, to };
      }
    }
    for (const [field, colKey, header] of [['scales', 'scaleCol', 'SCALE'], ['sizes', 'sizeCol', 'SIZE']]) {
      for (const [code, value] of Object.entries(edits[field] || {})) {
        const place = reg.places[code];
        if (!place) {
          notFound.push(code);
          continue;
        }
        if (place[colKey] === undefined) {
          errors.push(`sheet "${reg.sheet}" has no ${header} column for ${code}`);
          continue;
        }
        const from = reg.details[code][field === 'scales' ? 'scale' : 'size'];
        const to = collapse(value);
        if (to === from) continue;
        set(place.row, place[colKey], to);
        applied[field][code] = { from, to };
      }
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
    let stylesXml = parts.styles;
    // Highlight the issue column: its dates and marked cells; the previously highlighted column
    // (the latest one before) goes back to its usual shading
    if (applied.issue && edits.issue.highlight) {
      const issues = readXlsxIssues(parts);
      const col = issues.columns[edits.issue.index].col;
      const book = styleBook(stylesXml);
      const styles = cellStyles(xml);
      const fill = book.solidFill(edits.issue.highlight);
      const byStyleRow = {};
      const setStyle = (row, c, style) => ((byStyleRow[row] = byStyleRow[row] || {})[c] = style);
      const dateRows = issues.blocks.flatMap(b => [b.day, b.month, b.year]);
      const allRows = dateRows.concat(Object.values(reg.places).map(pl => pl.row));
      const old = issues.latest >= 0 && issues.latest !== edits.issue.index ? issues.columns[issues.latest].col : null;
      if (old !== null) {
        for (const { row } of highlightedCells(styles, book, old, allRows, issues.columns[0].col)) {
          const neighbour = neighbourStyle(styles, row, old, issues.columns[0].col);
          setStyle(row, old, book.withFill(styles[columnName(old) + row], book.fillOf(neighbour)));
        }
      }
      const markedRows = Object.entries(reg.places)
        .filter(([code]) => ((applied.issue.marks[code] || {}).to || (issues.marks[code] || [])[edits.issue.index]))
        .map(([, pl]) => pl.row);
      for (const row of dateRows.concat(markedRows)) setStyle(row, col, book.withFill(styles[columnName(col) + row], fill));
      xml = setCellStyles(xml, byStyleRow);
      stylesXml = book.toXml();
      applied.issue.highlight = edits.issue.highlight;
    }
    const rowNumOf = r => parseInt((/\br="(\d+)"/.exec(r.xml) || [])[1], 10);
    const rows = findElements(xml, 'row').filter(r => byRow[rowNumOf(r)]);
    for (const r of rows.reverse()) {
      xml = xml.slice(0, r.start) + setRowCells(r.xml, rowNumOf(r), byRow[rowNumOf(r)], zeroPad) + xml.slice(r.end);
    }
    return { path: reg.path, sheet: reg.sheet, xml, styles: stylesXml, applied, notFound, errors };
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
    let { open, inner, close } = splitElement(p);
    // An empty paragraph can be written <w:p/>
    if (open.endsWith('/>')) {
      open = open.replace(/\s*\/>$/, '>');
      close = '</w:p>';
    }
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

  // Apply { drawingNumber: scale } / { drawingNumber: size } to the scale and size columns; as editDocxTitles
  function editDocxScales(xml, edits, opts = {}) {
    return editDocxCells(xml, edits, 2, opts);
  }
  function editDocxSizes(xml, edits, opts = {}) {
    return editDocxCells(xml, edits, 3, opts);
  }

  // Replace the text of one column (0 = number, 1 = title, 2 = scale, 3 = size) in the rows of
  // the given drawings. A row without that column counts as not found.
  function editDocxCells(xml, edits, column, opts) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const applied = {};
    const changes = [];
    for (const { token, cells } of registerRows(xml)) {
      if (!(token in edits) || token in applied) continue;
      const target = cells[column];
      if (!target) continue;
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

  // --------------------
  // Project details at the top of a register
  // --------------------

  // Register header labels -> a key the app understands (others are shown but not used)
  const PROJECT_FIELD_KEYS = {
    'PROJECT': 'project', 'ISSUE NO': 'issueNo', 'ISSUE NUMBER': 'issueNo', 'ISSUE SERIES': 'issueSeries',
    'JOB NO': 'jobNo', 'JOB NUMBER': 'jobNo', 'DATE': 'date', 'REF': 'ref', 'OUR REF': 'ref',
    'MODEL NO': 'modelNo', 'CLIENT': 'client'
  };
  const FIELD_LABEL_RE = /^[A-Za-z][A-Za-z .'\/]{0,30}:$/;
  function projectField(label, value, ref) {
    const name = label.replace(/:$/, '').replace(/\./g, '').trim();
    return { key: PROJECT_FIELD_KEYS[name.toUpperCase().replace(/\s+/g, ' ')] || null, label: name, value: collapse(value), ref };
  }

  // Label/value pairs along a row of cells ([{ text, ref }]): "Project:" | "Park West" | "Job No:" |
  // "24023". In Word the value is the cell right after the label (possibly empty); in Excel, where
  // merged cells leave gaps, it's the next cell with text that isn't another label.
  function labelledPairs(cells, adjacent) {
    const fields = [];
    cells.forEach((cell, i) => {
      if (!FIELD_LABEL_RE.test(cell.text)) return;
      const next = adjacent ? cells[i + 1] : cells.slice(i + 1).find(c => c.text);
      if (next && !FIELD_LABEL_RE.test(next.text)) fields.push(projectField(cell.text, next.text, next.ref));
    });
    return fields;
  }

  // A heading row (a single cell of text above the fields) becomes the "Heading" field
  function headingField(cells) {
    const withText = cells.filter(c => c.text);
    return withText.length === 1 && !FIELD_LABEL_RE.test(withText[0].text)
      ? { key: 'heading', label: 'Heading', value: withText[0].text, ref: withText[0].ref }
      : null;
  }

  // word/document.xml -> { heading, fields: [{ key, label, value, ref }], description: [lines], client }.
  // The fields (the heading first, when there is one) come from the tables above the first
  // drawing row; ref is { tr, tc }, the value cell's row (among all w:tr) and cell index. The
  // description is the multi-line cell beside the issue dates ("Planning Application ... / For
  // Greenseed Limited"), and the client its "For ..." line.
  function readDocxProject(xml) {
    const firstDrawing = (registerRows(xml)[0] || { row: { start: xml.length } }).row.start;
    const out = { heading: '', fields: [], description: [], client: '' };
    findElements(xml, 'w:tr').forEach((tr, trIndex) => {
      if (tr.start >= firstDrawing) return;
      const tcs = findElements(xml, 'w:tc', tr.start, tr.end);
      const cells = tcs.map((c, tc) => ({ text: cellText(c.xml), ref: { tr: trIndex, tc } }));
      const heading = !out.fields.length && headingField(cells);
      if (heading) {
        out.heading = heading.value;
        out.fields.push(heading);
        return;
      }
      out.fields.push(...labelledPairs(cells, true));
      for (const c of tcs) {
        const lines = paragraphsOf(c.xml).map(pp => collapse(paragraphText(pp.xml))).filter(Boolean);
        if (lines.length > 1 && !out.description.length) out.description = lines;
      }
    });
    const forLine = out.description.find(l => /^for\s+\S/i.test(l));
    const clientField = out.fields.find(f => f.key === 'client');
    out.client = clientField ? clientField.value : forLine ? forLine.replace(/^for\s+/i, '') : '';
    return out;
  }

  // Change project fields in word/document.xml: edits { label: value } (labels as readDocxProject
  // gives them, "Heading" for the heading). opts as editDocxTitles.
  // Returns { xml, applied: { label: { from, to } }, notFound: [label] }
  function editDocxProject(xml, edits, opts = {}) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const { fields } = readDocxProject(xml);
    const rows = findElements(xml, 'w:tr');
    const applied = {};
    const notFound = [];
    const changes = [];
    for (const [label, value] of Object.entries(edits)) {
      const field = fields.find(f => f.label === label);
      const tr = field && rows[field.ref.tr];
      const cell = tr && findElements(xml, 'w:tc', tr.start, tr.end)[field.ref.tc];
      if (!cell) {
        notFound.push(label);
        continue;
      }
      const to = collapse(value);
      applied[label] = { from: field.value, to };
      if (to !== field.value) changes.push({ start: cell.start, end: cell.end, xml: setCellTitle(cell.xml, to, opts, rev) });
    }
    let out = xml;
    for (const c of changes.sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.xml + out.slice(c.end);
    return { xml: out, applied, notFound };
  }

  // The same for the current register sheet of an Excel register: label cells ("PROJECT:") in the
  // rows above the first "DRAWING CODE" header, each with the value to its right; ref is { row, col }
  function readXlsxProject(parts) {
    const reg = readXlsxRegister(parts);
    const out = { heading: '', fields: [], description: [], client: '' };
    if (!reg.path) return out;
    const sharedStrings = parts.sharedStrings ? findElements(parts.sharedStrings, 'si').map(si => stringItemText(si.xml)) : [];
    for (const { row, cells } of readSheetRows(parts.sheets[reg.path], sharedStrings, zeroPadStyles(parts.styles))) {
      if (headerColumns(cells)) break;
      const list = Object.keys(cells).map(Number).sort((a, b) => a - b).map(col => ({ text: collapse(cells[col]), ref: { row, col } }));
      const heading = !out.fields.length && headingField(list);
      if (heading) {
        out.heading = heading.value;
        out.fields.push(heading);
        continue;
      }
      out.fields.push(...labelledPairs(list, false));
    }
    const clientField = out.fields.find(f => f.key === 'client');
    if (clientField) out.client = clientField.value;
    return out;
  }

  // --------------------
  // Issues: the date columns and each drawing's mark (revision) in them
  // --------------------

  function issueDate(day, month, year) {
    const d = parseInt(day, 10), m = parseInt(month, 10);
    let y = parseInt(year, 10);
    if (!d || !m || isNaN(y)) return null;
    if (y < 100) y += 2000;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Issue columns from the rows labelled Day / Month / Year: [{ index, day, month, year, date }]
  // (date 'YYYY-MM-DD' or null when the column hasn't been used). latest: index of the last dated column.
  function issueColumns(days, months, years) {
    const columns = days.map((day, index) => {
      const month = months[index] || '', year = years[index] || '';
      return { index, day: day || '', month, year, date: issueDate(day, month, year) };
    });
    let latest = -1;
    columns.forEach((c, i) => { if (c.date) latest = i; });
    return { columns, latest };
  }

  // word/document.xml -> { columns, latest, marks: { token: [mark per column] }, rows: { day, month, year } }.
  // The Day/Month/Year rows sit above the drawing list; the dates follow the row's label cell, and
  // each drawing's marks follow its number, title, scale and size cells, column by column.
  function readDocxIssues(xml) {
    const firstDrawing = (registerRows(xml)[0] || { row: { start: xml.length } }).row.start;
    const found = {};
    findElements(xml, 'w:tr').forEach((tr, trIndex) => {
      if (tr.start >= firstDrawing) return;
      const texts = findElements(xml, 'w:tc', tr.start, tr.end).map(c => cellText(c.xml));
      for (const key of ['day', 'month', 'year']) {
        const at = texts.findIndex(t => t.toLowerCase() === key);
        if (at >= 0 && !found[key]) found[key] = { tr: trIndex, from: at + 1, values: texts.slice(at + 1) };
      }
    });
    if (!found.day || !found.month || !found.year) return { columns: [], latest: -1, marks: {}, rows: null, highlight: null };
    const { columns, latest } = issueColumns(found.day.values, found.month.values, found.year.values);
    const marks = {};
    const drawingRows = registerRows(xml);
    for (const { token, cells } of drawingRows) {
      if (!(token in marks)) marks[token] = columns.map((c, i) => (cells[4 + i] ? cellText(cells[4 + i].xml) : ''));
    }
    // Whether the latest issue column is highlighted (shaded), and in what colour
    let highlight = null;
    if (latest >= 0) {
      const trs = findElements(xml, 'w:tr');
      const rows = ['day', 'month', 'year'].map(k => found[k]).map(r => ({ tcs: findElements(xml, 'w:tc', trs[r.tr].start, trs[r.tr].end), at: r.from + latest, first: r.from }))
        .concat(drawingRows.map(r => ({ tcs: r.cells, at: 4 + latest, first: 4 })));
      const shaded = docxHighlighted(rows).map(({ tcs, at }) => cellShading(tcs[at].xml));
      if (shaded.length) highlight = mostCommon(shaded);
    }
    return { columns, latest, marks, rows: { day: found.day, month: found.month, year: found.year }, highlight };
  }

  // A table cell's shading colour ('RRGGBB'), or null
  function cellShading(cellXml) {
    const shd = /<w:tcPr\b[\s\S]*?<w:shd\b([^>]*)\/?>/.exec(cellXml);
    const fill = shd && (/\bw:fill="([0-9A-Fa-f]{6})"/.exec(shd[1]) || [])[1];
    return fill ? fill.toUpperCase() : null;
  }

  // The cell with its shading set to `color` ('RRGGBB') or removed (null)
  function setCellShading(cellXml, color) {
    const shd = color ? `<w:shd w:val="clear" w:color="auto" w:fill="${color}"/>` : '';
    // The cell's own properties come before its first paragraph (a nested table's don't)
    const bodyAt = cellXml.search(/<w:(p|tbl)\b/);
    const head = bodyAt < 0 ? cellXml : cellXml.slice(0, bodyAt);
    if (/<w:tcPr\b[^>]*\/>/.test(head)) return cellXml.replace(/<w:tcPr\b([^>]*)\/>/, `<w:tcPr$1>${shd}</w:tcPr>`);
    if (!/<w:tcPr\b/.test(head)) return color ? cellXml.replace(/^<w:tc\b[^>]*>/, open => `${open}<w:tcPr>${shd}</w:tcPr>`) : cellXml;
    return cellXml.replace(/<w:tcPr\b([^>]*)>([\s\S]*?)<\/w:tcPr>/, (m, attrs, inner) => {
      const without = inner.replace(/<w:shd\b[^>]*\/>/, '');
      // w:shd goes after the cell's width, borders and merge settings and before its margins and alignment
      const after = /<w:(noWrap|tcMar|textDirection|tcFitText|vAlign|hideMark|headers|cellIns|cellDel|cellMerge|tcPrChange)\b/.exec(without);
      const at = after ? after.index : without.length;
      return `<w:tcPr${attrs}>${without.slice(0, at)}${shd}${without.slice(at)}</w:tcPr>`;
    });
  }

  // The issue cell two over from `at` (see neighbourStyle): rows alternate two shades
  function docxNeighbour({ tcs, at, first }) {
    return (at - 2 >= first ? tcs[at - 2] : null) || tcs[at + 2];
  }

  // Cells of an issue column that are highlighted: shaded unlike their neighbour. rows: [{ tcs, at,
  // first }] with `at` the column's cell index in that row and `first` the row's first issue cell.
  function docxHighlighted(rows) {
    return rows.filter(r => {
      const own = r.tcs[r.at] && cellShading(r.tcs[r.at].xml);
      if (!own) return false;
      const neighbour = docxNeighbour(r);
      return !neighbour || cellShading(neighbour.xml) !== own;
    });
  }

  // Date an issue column and/or set drawings' marks in it: issue { index, date: { day, month, year }
  // or null, marks: { token: mark }, highlight: 'RRGGBB' or null }. With a highlight, the column's
  // dates and marked cells are shaded, and the previously highlighted (latest) column's shading
  // goes back to the one beside it. opts as editDocxTitles.
  // Returns { xml, applied: { index, date: { from, to } | null, marks: { token: { from, to } } }, notFound: [token] }
  function editDocxIssue(xml, issue, opts = {}) {
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const info = readDocxIssues(xml);
    const column = info.columns[issue.index];
    if (!column) throw new Error(`the register has no issue column ${issue.index + 1}`);
    const rows = findElements(xml, 'w:tr');
    const changes = [];
    const setCell = (cell, text) => {
      if (cell && cellText(cell.xml) !== text) changes.push({ start: cell.start, end: cell.end, xml: setCellTitle(cell.xml, text, opts, rev) });
    };
    const applied = { index: issue.index, date: null, marks: {} };
    if (issue.date) {
      for (const key of ['day', 'month', 'year']) {
        const r = info.rows[key];
        const tr = rows[r.tr];
        setCell(findElements(xml, 'w:tc', tr.start, tr.end)[r.from + issue.index], issue.date[key]);
      }
      applied.date = { from: column.date ? [column.day, column.month, column.year].join('.') : '', to: [issue.date.day, issue.date.month, issue.date.year].join('.') };
    }
    const notFound = [];
    const done = new Set();
    for (const { token, cells } of registerRows(xml)) {
      if (!(token in (issue.marks || {})) || done.has(token)) continue;
      done.add(token);
      const cell = cells[4 + issue.index];
      if (!cell) {
        notFound.push(token);
        continue;
      }
      const to = collapse(issue.marks[token]);
      const from = cellText(cell.xml);
      if (from !== to) applied.marks[token] = { from, to };
      setCell(cell, to);
    }
    for (const token of Object.keys(issue.marks || {})) if (!done.has(token)) notFound.push(token);
    let out = xml;
    for (const c of changes.sort((a, b) => b.start - a.start)) out = out.slice(0, c.start) + c.xml + out.slice(c.end);
    if (issue.highlight) {
      out = shadeIssueColumn(out, issue, info);
      applied.highlight = issue.highlight;
    }
    return { xml: out, applied, notFound };
  }

  // Shading for a highlighted issue column (see editDocxIssue); formatting isn't tracked
  function shadeIssueColumn(xml, issue, before) {
    const info = readDocxIssues(xml);
    const trs = findElements(xml, 'w:tr');
    const cellsOf = tr => findElements(xml, 'w:tc', tr.start, tr.end);
    const dateRows = ['day', 'month', 'year'].map(k => info.rows[k]).map(r => ({ tr: trs[r.tr], from: r.from }));
    const drawingRows = registerRows(xml);
    const column = (index, onlyMarked) => [
      ...dateRows.map(r => ({ tr: r.tr, tcs: cellsOf(r.tr), at: r.from + index, first: r.from })),
      ...drawingRows.filter(r => !onlyMarked || (info.marks[r.token] || [])[index]).map(r => ({ tr: r.row, tcs: r.cells, at: 4 + index, first: 4 }))
    ];
    const changes = [];
    const old = before.latest >= 0 && before.latest !== issue.index ? before.latest : -1;
    if (old >= 0) {
      for (const r of docxHighlighted(column(old, false))) {
        const neighbour = docxNeighbour(r);
        changes.push({ cell: r.tcs[r.at], color: neighbour ? cellShading(neighbour.xml) : null });
      }
    }
    for (const { tcs, at } of column(issue.index, true)) if (tcs[at]) changes.push({ cell: tcs[at], color: issue.highlight.toUpperCase() });
    let out = xml;
    for (const c of changes.sort((a, b) => b.cell.start - a.cell.start)) {
      out = out.slice(0, c.cell.start) + setCellShading(c.cell.xml, c.color) + out.slice(c.cell.end);
    }
    return out;
  }

  // The same for the current register sheet of an Excel register: columns from the first
  // DAY / MONTH / YEAR block, running from the REVISION NUMBER heading to the last cell the
  // DAY row has (used or not); blocks: [{ day, month, year }] row numbers of every repeat of it.
  function readXlsxIssues(parts) {
    const reg = readXlsxRegister(parts);
    const empty = { columns: [], latest: -1, marks: {}, blocks: [], highlight: null };
    if (!reg.path) return empty;
    const sheetXml = parts.sheets[reg.path];
    const sharedStrings = parts.sharedStrings ? findElements(parts.sharedStrings, 'si').map(si => stringItemText(si.xml)) : [];
    const rows = readSheetRows(sheetXml, sharedStrings, zeroPadStyles(parts.styles));
    const byRow = {};
    for (const r of rows) byRow[r.row] = r.cells;
    const labelAt = (cells, word) => Object.keys(cells).map(Number).find(c => norm(cells[c]) === word);
    const blocks = [];
    rows.forEach((r, i) => {
      const col = labelAt(r.cells, 'DAY');
      if (col === undefined) return;
      const month = rows.slice(i + 1, i + 3).find(x => labelAt(x.cells, 'MONTH') === col);
      const year = rows.slice(i + 1, i + 4).find(x => labelAt(x.cells, 'YEAR') === col);
      if (month && year) blocks.push({ day: r.row, month: month.row, year: year.row, labelCol: col });
    });
    if (!blocks.length) return empty;
    let startCol;
    for (const r of rows) {
      const c = Object.keys(r.cells).map(Number).find(k => /^REVISION( NUMBER| ISSUED)?$|^ISSUE DATE$/.test(norm(r.cells[k])));
      if (c !== undefined && c > blocks[0].labelCol) {
        startCol = c;
        break;
      }
    }
    if (startCol === undefined) startCol = blocks[0].labelCol + 1;
    const dayRowXml = (findElements(sheetXml, 'row').find(r => (/\br="(\d+)"/.exec(r.xml) || [])[1] === String(blocks[0].day)) || { xml: '' }).xml;
    const lastCol = Math.max(startCol, ...[...dayRowXml.matchAll(/<c\s[^>]*\br="([A-Z]+)\d+"/g)].map(m => columnIndex(m[1])));
    const cols = [];
    for (let c = startCol; c <= lastCol; c++) cols.push(c);
    const first = blocks[0];
    const at = (row, c) => ((byRow[row] || {})[c] || '').trim();
    const { columns, latest } = issueColumns(cols.map(c => at(first.day, c)), cols.map(c => at(first.month, c)), cols.map(c => at(first.year, c)));
    columns.forEach((column, i) => { column.col = cols[i]; });
    const marks = {};
    for (const [code, place] of Object.entries(reg.places)) marks[code] = cols.map(c => at(place.row, c));
    // Whether the latest issue column is highlighted, and in what colour
    let highlight = null;
    if (latest >= 0) {
      const book = styleBook(parts.styles);
      const rowsOf = blocks.flatMap(b => [b.day, b.month, b.year]).concat(Object.values(reg.places).map(pl => pl.row));
      const found = highlightedCells(cellStyles(sheetXml), book, cols[latest], rowsOf, cols[0]);
      if (found.length) highlight = mostCommon(found.map(f => f.color));
    }
    return { columns, latest, marks, blocks, highlight };
  }

  function mostCommon(values) {
    const counts = {};
    for (const v of values) counts[v] = (counts[v] || 0) + 1;
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  // Numbering of the register's issue number: 'number' (1, 2, 3), 'ordinal' (1st, 2nd, 3rd) or
  // 'letter' (A, B, C ... Z, AA)
  const NUMBERING_SCHEMES = ['number', 'ordinal', 'letter'];
  function detectNumbering(value) {
    const v = (value || '').trim();
    if (/^\d+$/.test(v)) return 'number';
    if (/^\d+\s*(st|nd|rd|th)$/i.test(v)) return 'ordinal';
    if (/^[A-Z]{1,2}$/i.test(v)) return 'letter';
    return null;
  }
  function ordinalSuffix(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return 'th';
    return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  }
  function parseNumbering(value) {
    const v = (value || '').trim().toUpperCase();
    const digits = /^(\d+)/.exec(v);
    if (digits) return parseInt(digits[1], 10);
    if (/^[A-Z]{1,2}$/.test(v)) return [...v].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    return null;
  }
  function formatNumbering(n, scheme) {
    if (scheme === 'ordinal') return n + ordinalSuffix(n);
    if (scheme === 'letter') {
      let out = '';
      for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out;
      return out;
    }
    return String(n);
  }
  // The issue number after `value`, written in `scheme` (default: the one `value` uses)
  function nextIssueNumber(value, scheme) {
    const n = parseNumbering(value);
    return formatNumbering(n === null ? 1 : n + 1, scheme || detectNumbering(value) || 'number');
  }

  // A drawing's next revision after `prev`: C07 -> C08, P1 -> P2, 01 -> 02, 2nd -> 3rd, B -> C;
  // a mark that isn't a code (a tick like "/") stays the same
  function nextRevision(prev) {
    const v = (prev || '').trim();
    if (!v) return '';
    let m = /^([A-Za-z]*)(\d+)$/.exec(v);
    if (m) return m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
    m = /^(\d+)\s*(st|nd|rd|th)$/i.exec(v);
    if (m) return formatNumbering(parseInt(m[1], 10) + 1, 'ordinal');
    if (/^[A-Z]{1,2}$/.test(v)) return formatNumbering(parseNumbering(v) + 1, 'letter');
    if (/^[a-z]{1,2}$/.test(v)) return formatNumbering(parseNumbering(v) + 1, 'letter').toLowerCase();
    return v;
  }
  // Whether `next` properly follows `prev` (anything follows no previous issue)
  function revisionFollows(prev, next) {
    if (!(prev || '').trim()) return true;
    return (next || '').trim().toUpperCase() === nextRevision(prev).toUpperCase();
  }

  // Header date formats, detected from the register's current date and used to write the new one
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DATE_FORMATS = [
    { id: 'dd.mm.yyyy', re: /^\d{1,2}\.\d{1,2}\.\d{4}$/ },
    { id: 'dd/mm/yyyy', re: /^\d{1,2}\/\d{1,2}\/\d{4}$/ },
    { id: 'dd-mm-yyyy', re: /^\d{1,2}-\d{1,2}-\d{4}$/ },
    { id: 'dd.mm.yy', re: /^\d{1,2}\.\d{1,2}\.\d{2}$/ },
    { id: 'dd/mm/yy', re: /^\d{1,2}\/\d{1,2}\/\d{2}$/ },
    { id: 'yyyy-mm-dd', re: /^\d{4}-\d{2}-\d{2}$/ },
    { id: 'dth mmmm yyyy', re: /^\d{1,2}(st|nd|rd|th)\s+[A-Za-z]+\s+\d{4}$/ },
    { id: 'd mmmm yyyy', re: /^\d{1,2}\s+[A-Za-z]{4,}\s+\d{4}$/ },
    { id: 'd mmm yyyy', re: /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/ }
  ];
  function detectDateFormat(text) {
    const found = DATE_FORMATS.find(f => f.re.test((text || '').trim()));
    return found ? found.id : null;
  }
  // date: { y, m, d } numbers
  function formatDate(date, format) {
    const dd = String(date.d).padStart(2, '0'), mm = String(date.m).padStart(2, '0');
    const yyyy = String(date.y), yy = yyyy.slice(-2);
    switch (format) {
      case 'dd/mm/yyyy': return `${dd}/${mm}/${yyyy}`;
      case 'dd-mm-yyyy': return `${dd}-${mm}-${yyyy}`;
      case 'dd.mm.yy': return `${dd}.${mm}.${yy}`;
      case 'dd/mm/yy': return `${dd}/${mm}/${yy}`;
      case 'yyyy-mm-dd': return `${yyyy}-${mm}-${dd}`;
      case 'dth mmmm yyyy': return `${date.d}${ordinalSuffix(date.d)} ${MONTH_NAMES[date.m - 1]} ${yyyy}`;
      case 'd mmmm yyyy': return `${date.d} ${MONTH_NAMES[date.m - 1]} ${yyyy}`;
      case 'd mmm yyyy': return `${date.d} ${MONTH_NAMES[date.m - 1].slice(0, 3)} ${yyyy}`;
      default: return `${dd}.${mm}.${yyyy}`;
    }
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
    sourceFiles,
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
    readDocxProject,
    readDocxIssues,
    editDocxIssue,
    readXlsxIssues,
    NUMBERING_SCHEMES,
    detectNumbering,
    formatNumbering,
    nextIssueNumber,
    nextRevision,
    revisionFollows,
    DATE_FORMATS,
    detectDateFormat,
    formatDate,
    editDocxProject,
    readXlsxProject,
    readRowMarks,
    editDocxTitles,
    editDocxNumbers,
    editDocxScales,
    editDocxSizes,
    insertDocxRows,
    moveDocxRows,
    decodeXml
  };
});
