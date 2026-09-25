// Copies the browser libraries the GUI needs from node_modules into the Neutralino resources.
// pdf.js is the build bundled with pdf-parse, so the GUI parses PDF registers exactly like the CLI.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const copies = [
    ['node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js', 'resources/js/pdfjs/pdf.js'],
    ['node_modules/pdf-parse/lib/pdf.js/v1.10.100/build/pdf.worker.js', 'resources/js/pdfjs/pdf.worker.js'],
    ['node_modules/jszip/dist/jszip.min.js', 'resources/js/jszip/jszip.min.js']
];

for (const [src, dest] of copies) {
    fs.mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
    fs.copyFileSync(path.join(root, src), path.join(root, dest));
}
console.log('Copied pdf.js and JSZip into resources/js');
