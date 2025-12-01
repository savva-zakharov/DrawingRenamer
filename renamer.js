const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

// --------------------
// 1️⃣ Find register PDF
// --------------------
function findRegisterPDF() {
    const files = fs.readdirSync(".");
    return files.find(f => f.toLowerCase().includes("register") && f.toLowerCase().endsWith(".pdf"));
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
// --------------------
// 4️⃣ Rename files based on exact token match
// --------------------
async function renameFiles() {
    const registerPDF = findRegisterPDF();
    if (!registerPDF) {
        console.error("❌ No register PDF found in current folder.");
        return;
    }

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

    const files = fs.readdirSync(".");
    for (let file of files) {
        if (!file.toLowerCase().endsWith(".pdf") || file === registerPDF) continue;

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
            fs.renameSync(file, newName);
            console.log(`✅ Renamed ${file} → ${newName}`);
        } catch (err) {
            console.error(`❌ Failed to rename ${file}: ${err.message}`);
        }
    }
}


// --------------------
// Run
// --------------------
renameFiles();
