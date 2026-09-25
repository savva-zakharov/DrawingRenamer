const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const JSZip = require("jszip");
const readline = require("readline");
const core = require("./resources/register-core");
const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
// Simple CLI arg helper for --register / -r
function getArgValue(names) {
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        for (const name of names) {
            if (a === name && process.argv[i + 1]) return process.argv[i + 1];
            if (a.startsWith(name + "=")) return a.split("=")[1];
        }
    }
    return null;
}
const registerArg = getArgValue(['--register', '-r']);

// --------------------
// 1️⃣ Find register (Word preferred over PDF)
// --------------------
function isRegisterFile(name) {
    const lower = name.toLowerCase();
    return !lower.startsWith("~$") && (lower.endsWith(".docx") || lower.endsWith(".pdf"));
}

// Files named "...register..." in dir; a Word register beats a PDF one, and the last by name
// (registers are usually date-prefixed, so that's the latest) beats earlier ones
function findRegister(dir = ".") {
    const candidates = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().includes("register") && isRegisterFile(f))
        .sort();
    const found = candidates.filter(f => f.toLowerCase().endsWith(".docx")).pop() || candidates.pop();
    return found ? path.resolve(dir, found) : null;
}

function ask(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

// --------------------
// 2️⃣ Parse register into token map
// --------------------
async function parseRegister(filePath) {
    const buffer = fs.readFileSync(filePath);
    if (filePath.toLowerCase().endsWith(".docx")) {
        const zip = await JSZip.loadAsync(buffer);
        return core.readDocxTitles(await zip.file("word/document.xml").async("string"));
    }
    const data = await pdfParse(buffer);
    return core.parsePdfText(data.text);
}

// --------------------
// 3️⃣ Sanitize filenames
// --------------------
function sanitizeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, "-");
}

// Path given on the command line or typed in -> register file, or null with an error printed
function resolveRegister(input) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
        console.error("❌ Provided path does not exist.");
        return null;
    }
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
        if (!isRegisterFile(path.basename(resolved))) {
            console.error('❌ Provided file is not a Word (.docx) or PDF register.');
            return null;
        }
        return resolved;
    }
    if (stat.isDirectory()) {
        const found = findRegister(resolved);
        if (!found) console.error('❌ No register found in that directory.');
        return found;
    }
    console.error('❌ Unsupported path type.');
    return null;
}

// --------------------
// 4️⃣ Rename files based on drawing number match
// --------------------
async function renameFiles() {
    let register = findRegister();

    // If user provided --register / -r use that before prompting
    if (!register && registerArg) {
        register = resolveRegister(registerArg);
        if (!register) return;
    }

    // If still not found, prompt interactively
    if (!register) {
        console.error("❌ No register found in current folder.");
        const input = (await ask("Enter path to register (.docx or .pdf, file or directory) or press Enter to cancel: ")).trim();
        if (!input) {
            console.log("Aborted by user.");
            return;
        }
        register = resolveRegister(input);
        if (!register) return;
    }

    if (dryRun) console.log('🔎 Running in dry-run mode — no files will be renamed.');
    console.log(`📚 Parsing register: ${register} ...`);
    const tokenMap = await parseRegister(register);

    console.log(`📘 Loaded ${Object.keys(tokenMap).length} drawing entries from register.`);

    // --------------------
    // 🔹 Debugging: Print full map
    // --------------------
    console.log("\n🗂 Full drawing map from register:");
    for (const [number, title] of Object.entries(tokenMap)) {
        console.log(`${number} => ${title}`);
    }
    console.log("\n");

    const registerBasename = path.basename(register);
    // The register's own PDF (e.g. exported from the Word register) isn't a drawing
    const registerPdf = registerBasename.replace(/\.[^.]+$/, "") + ".pdf";
    // Use the directory containing the register as the target directory
    const targetDir = path.dirname(register);
    const matchToken = core.makeMatcher(Object.keys(tokenMap));
    const files = fs.readdirSync(targetDir);
    for (let file of files) {
        if (!file.toLowerCase().endsWith(".pdf") || file === registerBasename || file === registerPdf) continue;

        const match = matchToken(file);
        if (!match) {
            console.warn(`❔ No title found for file: ${file}`);
            continue;
        }

        const title = tokenMap[match];
        const safeTitle = sanitizeFilename(title);
        const newName = `${match} - ${safeTitle}.pdf`;

        if (file === newName) continue; // already correct

        try {
            const oldPath = path.join(targetDir, file);
            const newPath = path.join(targetDir, newName);
            if (dryRun) {
                console.log(`ℹ️ Dry-run: would rename ${file} → ${newName}`);
            } else {
                fs.renameSync(oldPath, newPath);
                console.log(`✅ Renamed ${file} → ${newName}`);
            }
        } catch (err) {
            console.error(`❌ Failed to rename ${file}: ${err.message}`);
        }
    }
}


// --------------------
// Run
// --------------------
renameFiles();
