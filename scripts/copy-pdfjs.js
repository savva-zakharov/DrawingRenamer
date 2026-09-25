// Copies the pdf.js build bundled with pdf-parse into the Neutralino resources,
// so the GUI parses registers with exactly the same pdf.js version as the CLI.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'pdf-parse', 'lib', 'pdf.js', 'v1.10.100', 'build');
const dest = path.join(__dirname, '..', 'resources', 'js', 'pdfjs');

fs.mkdirSync(dest, { recursive: true });
for (const file of ['pdf.js', 'pdf.worker.js']) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log('Copied pdf.js into resources/js/pdfjs');
