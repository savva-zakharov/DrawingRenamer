// Copies the browser libraries the GUI needs from node_modules into the Neutralino resources.
// pdf.js is the build bundled with pdf-parse, so the GUI parses PDF registers exactly like the CLI.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
    ['node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js', 'resources/js/pdfjs/pdf.js'],
    ['node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.worker.js', 'resources/js/pdfjs/pdf.worker.js'],
    ['node_modules/jszip/dist/jszip.min.js', 'resources/js/jszip/jszip.min.js'],
    // The built-in spelling dictionary (Hunspell format)
    ['node_modules/dictionary-en-gb/index.aff', 'resources/js/dictionaries/en-GB/en_GB.aff'],
    ['node_modules/dictionary-en-gb/index.dic', 'resources/js/dictionaries/en-GB/en_GB.dic'],
    ['node_modules/dictionary-en-gb/license', 'resources/js/dictionaries/en-GB/license']
];

for (const [src, dest] of copies) {
    fs.mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
    fs.copyFileSync(path.join(root, src), path.join(root, dest));
}

// nspell (the spellchecker) is CommonJS; wrap its files into one script that sets window.NSpell
function bundleNspell() {
    const modules = {};
    const add = (id, file) => {
        modules[id] = fs.readFileSync(path.join(root, file), 'utf8');
    };
    const libDir = path.join(root, 'node_modules/nspell/lib');
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) add('nspell/' + path.relative(libDir, full).replace(/\\/g, '/'), path.relative(root, full));
        }
    };
    walk(libDir);
    add('is-buffer', 'node_modules/is-buffer/index.js');

    const body = Object.entries(modules)
        .map(([id, code]) => `${JSON.stringify(id)}: function (module, exports, require) {\n${code}\n}`)
        .join(',\n');
    const out = `// nspell ${require(path.join(root, 'node_modules/nspell/package.json')).version} (MIT), bundled by scripts/copy-libs.js
(function () {
  var defs = {
${body}
  };
  var cache = {};
  function resolve(from, request) {
    if (request.charAt(0) !== '.') return request;
    var parts = from.split('/').slice(0, -1);
    request.split('/').forEach(function (p) {
      if (p === '..') parts.pop();
      else if (p !== '.') parts.push(p);
    });
    var id = parts.join('/');
    return defs[id] ? id : id + '.js';
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = cache[id] = { exports: {} };
    defs[id](module, module.exports, function (request) { return load(resolve(id, request)); });
    return module.exports;
  }
  window.NSpell = load('nspell/index.js');
})();
`;
    const dest = path.join(root, 'resources/js/nspell/nspell.js');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
}
bundleNspell();

console.log('Copied pdf.js, JSZip, nspell and the en-GB dictionary into resources/js');
