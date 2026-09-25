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
  // size (A0-A4) for drawings without a scale.
  function parsePdfText(text) {
    const flat = text.replace(/\r?\n/g, ' ');
    const entryRe = new RegExp('(' + DRAWING_NUMBER + ')\\s+(.+?)\\s+(?:1:\\d+|N\\.?T\\.?S\\.?(?=\\s)|A[0-4](?=\\s))', 'g');
    const map = {};
    let m;
    while ((m = entryRe.exec(flat)) !== null) {
      map[m[1]] = m[2].trim().replace(/\s+/g, ' ');
    }
    return map;
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
      if (DRAWING_NUMBER_RE.test(token)) rows.push({ token, row: tr, titleCell: cells[1] });
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

  // Formatting of the first run in the paragraph, without any recorded formatting change
  function firstRunProps(inner) {
    const run = findElements(inner, 'w:r')[0];
    if (!run) return '';
    const { inner: runInner } = splitElement(run.xml);
    const rPr = childElements(runInner).find(c => tagName(c) === 'w:rPr');
    return rPr ? rPr.replace(/<w:rPrChange[\s>][\s\S]*?<\/w:rPrChange>/g, '') : '';
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
    const rev = makeRevisions(xml, opts.author || 'Drawing Renamer', opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    const applied = {};
    const changes = [];
    for (const { token, titleCell } of registerRows(xml)) {
      if (!(token in edits) || token in applied) continue;
      const from = cellText(titleCell.xml);
      const to = collapse(edits[token]);
      applied[token] = { from, to };
      if (from === to) continue;
      changes.push({ start: titleCell.start, end: titleCell.end, xml: setCellTitle(titleCell.xml, to, opts, rev) });
    }
    let out = xml;
    for (const c of changes.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.xml + out.slice(c.end);
    }
    return { xml: out, applied, notFound: Object.keys(edits).filter(t => !(t in applied)) };
  }

  return {
    DRAWING_NUMBER,
    parsePdfText,
    makeMatcher,
    readDocxTitles,
    editDocxTitles,
    decodeXml
  };
});
