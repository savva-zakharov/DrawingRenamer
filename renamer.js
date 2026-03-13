import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import readline from "readline";
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
// 1️⃣ Find register PDF
// --------------------
function findRegisterPDF(dir = ".") {
    const files = fs.readdirSync(dir);
    const found = files.find(f => f.toLowerCase().includes("register") && f.toLowerCase().endsWith(".pdf"));
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
// 2️⃣ Parse register PDF into token map
// --------------------
async function parseRegisterPDF(filePath) {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    const text = data.text.replace(/\r?\n/g, " "); // flatten all newlines

    const map = {};
    
    // Regex explanation:
    // (1) Drawing number: [A-Z]+(?:-[A-Z0-9]+)*-\d+
    // (2) Title: non-greedy match up to first scale 1:\d+
    const entryRegex = /([A-Z]+(?:-[A-Z0-9]+)*-\d+)\s+(.+?)\s+1:\d+/gi;

    let match;
    while ((match = entryRegex.exec(text)) !== null) {
        const drawingNumber = match[1].toUpperCase();
        const title = match[2].trim().replace(/\s+/g, " "); // collapse any spaces
        map[drawingNumber] = title;
    }

    return map;
}









// --------------------
// 3️⃣ Sanitize filenames
// --------------------
function sanitizeFilename(name) {
    return name.replace(/[\/\\:*?"<>|]/g, "-");
}


// --------------------
// 4️⃣ Rename files based on exact token match
// --------------------
async function renameFiles() {
    let registerPDF = findRegisterPDF();

    // If user provided --register / -r use that before prompting
    if (!registerPDF && registerArg) {
        const resolved = path.resolve(registerArg);
        if (!fs.existsSync(resolved)) {
            console.error("❌ Provided --register path does not exist.");
            return;
        }
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
            if (!resolved.toLowerCase().endsWith('.pdf')) {
                console.error('❌ Provided file is not a PDF.');
                return;
            }
            registerPDF = resolved;
        } else if (stat.isDirectory()) {
            const found = findRegisterPDF(resolved);
            if (!found) {
                console.error('❌ No register PDF found in that directory.');
                return;
            }
            registerPDF = found;
        } else {
            console.error('❌ Unsupported path type for --register.');
            return;
        }
    }

    // If still not found, prompt interactively
    if (!registerPDF) {
        console.error("❌ No register PDF found in current folder.");
        const input = (await ask("Enter path to register PDF (file or directory) or press Enter to cancel: ")).trim();
        if (!input) {
            console.log("Aborted by user.");
            return;
        }

        const resolved = path.resolve(input);
        if (!fs.existsSync(resolved)) {
            console.error("❌ Provided path does not exist.");
            return;
        }

        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
            if (!resolved.toLowerCase().endsWith('.pdf')) {
                console.error('❌ Provided file is not a PDF.');
                return;
            }
            registerPDF = resolved;
        } else if (stat.isDirectory()) {
            const found = findRegisterPDF(resolved);
            if (!found) {
                console.error('❌ No register PDF found in that directory.');
                return;
            }
            registerPDF = found;
        } else {
            console.error('❌ Unsupported path type.');
            return;
        }
    }

    if (dryRun) console.log('🔎 Running in dry-run mode — no files will be renamed.');
    console.log(`📚 Parsing PDF register: ${registerPDF} ...`);
    const tokenMap = await parseRegisterPDF(registerPDF);

    console.log(`📘 Loaded ${Object.keys(tokenMap).length} drawing entries from register.`);

    // --------------------
    // 🔹 Debugging: Print full map
    // --------------------
    console.log("\n🗂 Full drawing map from register:");
    for (const [number, title] of Object.entries(tokenMap)) {
        console.log(`${number} => ${title}`);
    }
    console.log("\n");

    const registerBasename = path.basename(registerPDF);
    // Use the directory containing the register PDF as the target directory
    const targetDir = path.dirname(registerPDF);
    const files = fs.readdirSync(targetDir);
    for (let file of files) {
        if (!file.toLowerCase().endsWith(".pdf") || file === registerBasename) continue;

        // Find exact match in filename
        const match = Object.keys(tokenMap).find(token => file.includes(token));
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
