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
// 1️⃣ Find register (Word preferred over Excel over PDF)
// --------------------
function registerKind(name) {
    const lower = name.toLowerCase();
    if (lower.startsWith("~$")) return null; // Word/Excel lock file
    if (lower.endsWith(".docx")) return "docx";
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
    if (lower.endsWith(".pdf")) return "pdf";
    return null;
}

function isRegisterFile(name) {
    return registerKind(name) !== null;
}

// Files named "...register..." in dir; Word beats Excel beats PDF, and the last by name
// (registers are usually date-prefixed, so that's the latest) beats earlier ones
function findRegister(dir = ".") {
    const candidates = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().includes("register") && isRegisterFile(f))
        .sort();
    const of = kind => candidates.filter(f => registerKind(f) === kind).pop();
    const found = of("docx") || of("xlsx") || of("pdf");
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
    const kind = registerKind(path.basename(filePath));
    if (kind === "docx") {
        const zip = await JSZip.loadAsync(buffer);
        return core.readDocxTitles(await zip.file("word/document.xml").async("string"));
    }
    if (kind === "xlsx") {
        const found = core.readXlsxRegister(await core.loadXlsxParts(await JSZip.loadAsync(buffer)));
        if (found.sheet) console.log(`📄 Using sheet "${found.sheet}"${found.issue !== null ? ` (issue ${found.issue})` : ""}.`);
        return found.titles;
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

// What goes between the drawing number and title: the separator the app saved for this folder in
// drawing-renamer.json, else " - "
function separatorFor(dir) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, "drawing-renamer.json"), "utf8"));
        if (typeof data.separator === "string" && data.separator && !/[\\/:*?"<>|\x00-\x1f]/.test(data.separator)) {
            return data.separator;
        }
    } catch (err) {
        // no layout file, or it can't be read
    }
    return " - ";
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
            console.error('❌ Provided file is not a Word (.docx), Excel (.xlsx, .xlsm) or PDF register.');
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
        const input = (await ask("Enter path to register (.docx, .xlsx, .xlsm or .pdf, file or directory) or press Enter to cancel: ")).trim();
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
    const separator = separatorFor(targetDir);
    const matchToken = core.makeMatcher(Object.keys(tokenMap));
    const matchReordered = core.makeReorderedMatcher(Object.keys(tokenMap));
    const files = fs.readdirSync(targetDir);
    for (let file of files) {
        if (!file.toLowerCase().endsWith(".pdf") || file === registerBasename || file === registerPdf) continue;

        const match = matchToken(file);
        if (!match) {
            // Not renamed without asking: use the app to check and tick these
            const reordered = matchReordered(file);
            if (reordered) console.warn(`⚠️ ${file} looks like ${reordered} with its code fields in a different order; not renamed.`);
            else if (!/register/i.test(file)) console.warn(`❔ No title found for file: ${file}`);
            continue;
        }

        const title = tokenMap[match];
        const safeTitle = sanitizeFilename(title);
        const newName = `${match}${separator}${safeTitle}.pdf`;

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
