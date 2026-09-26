param(
    [string]$TargetDir = "."
)

Write-Host "📂 Scanning directory: $(Resolve-Path $TargetDir)`n"

# --------------------
# 1️⃣ Load PdfPig DLL
# --------------------
# Download PdfPig via NuGet: https://www.nuget.org/packages/UglyToad.PdfPig/
# Extract the DLL and provide path here
$PdfPigPath = "C:\path\to\UglyToad.PdfPig.dll"
Add-Type -Path $PdfPigPath

# --------------------
# 2️⃣ Find register PDF
# --------------------
$registerPDF = Get-ChildItem -Path $TargetDir -Filter *.pdf | Where-Object { $_.Name -match "register" }

if (-not $registerPDF) {
    Write-Host "❌ No register PDF found in the specified directory."
    exit
}

$registerPath = $registerPDF.FullName
Write-Host "📚 Parsing PDF register: $registerPath ..."

# --------------------
# 3️⃣ Parse register PDF into token map
# --------------------
$tokenMap = @{}

# Open PDF and extract text
$readerType = [UglyToad.PdfPig.PdfDocument]
$pdf = [UglyToad.PdfPig.PdfDocument]::Open($registerPath)

$text = ""
foreach ($page in $pdf.GetPages()) {
    $text += $page.Text + " "
}

$text = $text -replace "\r?\n", " "  # flatten all newlines

$entryPattern = "([A-Z]+(?:-[A-Z0-9]+)*-\d+)\s+(.+?)\s+1:\d+"
[regex]::Matches($text, $entryPattern) | ForEach-Object {
    $drawingNumber = $_.Groups[1].Value.ToUpper()
    $title = $_.Groups[2].Value.Trim() -replace "\s+", " "
    $tokenMap[$drawingNumber] = $title
}

Write-Host "📘 Loaded $($tokenMap.Count) drawing entries from register.`n"

# --------------------
# Sanitize filenames
# --------------------
function Sanitize-Filename($name) {
    return ($name -replace '[\/\\\\:*?"<>|]', '-')
}


# --------------------
# 5️⃣ Rename files and track unmatched items
# --------------------
$unmatchedTokens = $tokenMap.Keys

Get-ChildItem -Path $TargetDir -Filter *.pdf | ForEach-Object {
    $file = $_
    if ($file.FullName -eq $registerPath) { return }

    $match = $tokenMap.Keys | Where-Object { $file.Name -like "*$_*" } | Select-Object -First 1
    if (-not $match) {
        Write-Warning "❔ No title found for file: $($file.Name)"
        return
    }

    $title = $tokenMap[$match]
    $safeTitle = Sanitize-Filename $title
    $newName = "$match - $safeTitle.pdf"
    $newPath = Join-Path $TargetDir $newName

    if ($file.Name -ne $newName) {
        Rename-Item -Path $file.FullName -NewName $newName
        Write-Host "✅ Renamed $($file.Name) → $newName"
    }

    # Remove from unmatched
    $unmatchedTokens = $unmatchedTokens | Where-Object { $_ -ne $match }
}

# --------------------
# 🔹 Print unmatched register items
# --------------------
if ($unmatchedTokens.Count -gt 0) {
    Write-Host "`n⚠️ The following register entries were not matched to any file:"
    foreach ($token in $unmatchedTokens) {
        Write-Host "$token => $($tokenMap[$token])"
    }
} else {
    Write-Host "`n🎉 All register entries matched successfully!"
}
