#![cfg_attr(not(feature = "cli-only"), windows_subsystem = "windows")]

use anyhow::Result;
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;
use serde::{Serialize, Deserialize};

#[cfg(feature = "cli-only")]
use clap::Parser;

#[cfg(feature = "cli-only")]
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the register PDF file or directory containing it
    #[arg(short, long)]
    register: Option<PathBuf>,

    /// Run without actually renaming any files
    #[arg(short, long)]
    dry_run: bool,
}

#[derive(Error, Debug, Serialize, Deserialize)]
enum RenameError {
    #[error("Provided path does not exist: {0}")]
    PathNotFound(PathBuf),
    #[error("Provided file is not a PDF: {0}")]
    NotAPdf(PathBuf),
    #[error("No register PDF found in directory: {0}")]
    RegisterNotFoundInDir(PathBuf),
    #[error("Unsupported path type for --register")]
    UnsupportedPathType,
    #[error("Aborted by user")]
    UserAborted,
}

#[cfg(feature = "cli-only")]
fn main() -> Result<()> {
    let args = Args::parse();

    if args.dry_run {
        println!("🔎 Running in dry-run mode — no files will be renamed.");
    }

    // 1. Find the register PDF
    let register_path = find_register_pdf_or_prompt(args.register)?;
    let target_dir = register_path.parent().unwrap_or_else(|| Path::new("."));

    println!("📚 Parsing PDF register: {} ...", register_path.display());

    // 2. Parse the PDF to get the drawing number -> title map
    let token_map = parse_register_pdf(&register_path)?;
    println!(
        "📘 Loaded {} drawing entries from register.",
        token_map.len()
    );

    println!("\n🗂 Full drawing map from register:");
    for (number, title) in &token_map {
        println!("{} => {}", number, title);
    }
    println!("\n");

    let register_basename = register_path.file_name().unwrap_or_default();

    // 3. Iterate through files in the same directory and rename them
    for entry in fs::read_dir(target_dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name_os = path.file_name().unwrap_or_default();
        let file_name = file_name_os.to_string_lossy();

        // Skip the register file itself and any non-PDF files
        if file_name_os == register_basename || !file_name.to_lowercase().ends_with(".pdf") {
            continue;
        }

        // Find which drawing number (token) is in the filename
        let Some(token) = token_map.keys().find(|&token| file_name.contains(token)) else {
            println!("❔ No title found for file: {}", file_name);
            continue;
        };

        let title = &token_map[token];
        let safe_title = sanitize_filename(title);
        let new_name = format!("{} - {}.pdf", token, safe_title);

        if file_name == new_name {
            continue; // Already named correctly
        }

        let new_path = target_dir.join(&new_name);

        if args.dry_run {
            println!("ℹ️ Dry-run: would rename {} → {}", file_name, new_name);
        } else {
            match fs::rename(&path, &new_path) {
                Ok(_) => println!("✅ Renamed {} → {}", file_name, new_name),
                Err(e) => eprintln!("❌ Failed to rename {}: {}", file_name, e),
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn rename_drawings(register_path: PathBuf, drawings_dir: PathBuf, dry_run: bool) -> Result<Vec<String>, RenameError> {
    let mut messages = Vec::new();

    if dry_run {
        messages.push("🔎 Running in dry-run mode — no files will be renamed.".to_string());
    }

    let token_map = parse_register_pdf(&register_path).map_err(|_| RenameError::NotAPdf(register_path.clone()))?;
    messages.push(format!("📘 Loaded {} drawing entries from register.", token_map.len()));

    let register_basename = register_path.file_name().unwrap_or_default();

    for entry in fs::read_dir(drawings_dir).map_err(|_| RenameError::PathNotFound(drawings_dir.clone()))? {
        let entry = entry.map_err(|_| RenameError::PathNotFound(drawings_dir.clone()))?;
        let path = entry.path();
        let file_name_os = path.file_name().unwrap_or_default();
        let file_name = file_name_os.to_string_lossy();

        if file_name_os == register_basename || !file_name.to_lowercase().ends_with(".pdf") {
            continue;
        }

        let Some(token) = token_map.keys().find(|&token| file_name.contains(token)) else {
            messages.push(format!("❔ No title found for file: {}", file_name));
            continue;
        };

        let title = &token_map[token];
        let safe_title = sanitize_filename(title);
        let new_name = format!("{} - {}.pdf", token, safe_title);

        if file_name == new_name {
            continue;
        }

        let new_path = path.with_file_name(new_name.clone());

        if dry_run {
            messages.push(format!("ℹ️ Dry-run: would rename {} → {}", file_name, new_name));
        } else {
            match fs::rename(&path, &new_path) {
                Ok(_) => messages.push(format!("✅ Renamed {} → {}", file_name, new_name)),
                Err(e) => messages.push(format!("❌ Failed to rename {}: {}", file_name, e)),
            }
        }
    }

    Ok(messages)
}


/// Handles the logic of finding the register PDF, whether from an argument or by prompting the user.
#[cfg(feature = "cli-only")]
fn find_register_pdf_or_prompt(register_arg: Option<PathBuf>) -> Result<PathBuf, RenameError> {
    // First, try to use the --register argument if provided
    if let Some(path) = register_arg {
        return resolve_path(path);
    }

    // If no argument, search the current directory
    if let Some(path) = find_register_in_dir(Path::new(".")) {
        return Ok(path);
    }

    // If still not found, prompt the user
    println!("❌ No register PDF found in current folder.");
    let answer = ask("Enter path to register PDF (file or directory) or press Enter to cancel: ")
        .unwrap_or_default();

    if answer.is_empty() {
        return Err(RenameError::UserAborted);
    }

    resolve_path(PathBuf::from(answer))
}

/// Given a path from an argument or prompt, resolve it to a valid register PDF path.
fn resolve_path(path: PathBuf) -> Result<PathBuf, RenameError> {
    if !path.exists() {
        return Err(RenameError::PathNotFound(path));
    }

    if path.is_file() {
        if !path.to_string_lossy().to_lowercase().ends_with(".pdf") {
            return Err(RenameError::NotAPdf(path));
        }
        Ok(path)
    } else if path.is_dir() {
        find_register_in_dir(&path)
            .ok_or_else(|| RenameError::RegisterNotFoundInDir(path.clone()))
    } else {
        Err(RenameError::UnsupportedPathType)
    }
}

/// Searches a single directory for a file with "register" in its name.
fn find_register_in_dir(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir).ok()? .flatten().find_map(|entry| {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy().to_lowercase();
        if file_name.contains("register") && file_name.ends_with(".pdf") {
            Some(path)
        } else {
            None
        }
    })
}

/// Prompts the user with a question and returns their input.
#[cfg(feature = "cli-only")]
fn ask(question: &str) -> io::Result<String> {
    print!("{}", question);
    io::stdout().flush()?;
    let mut buffer = String::new();
    io::stdin().read_line(&mut buffer)?;
    Ok(buffer.trim().to_string())
}

/// Extracts drawing numbers and titles from the PDF text.
fn parse_register_pdf(path: &Path) -> Result<HashMap<String, String>> {
    let text = pdf_extract::extract_text(path)?;
    let flat_text = text.replace(['\r', '\n'], " ");

    // Regex: ([A-Z]+(?:-[A-Z0-9]+)*-\d+)\s+(.+?)\s+1:\d+
    let re = Regex::new(r"([A-Z]+(?:-[A-Z0-9]+)*-\d+)\s+(.+?)\s+1:\d+")?;
    let mut map = HashMap::new();

    for caps in re.captures_iter(&flat_text) {
        let drawing_number = caps.get(1).unwrap().as_str().to_uppercase();
        let title = caps.get(2).unwrap().as_str().trim().replace(r"\s+", " ");
        map.insert(drawing_number, title);
    }

    Ok(map)
}

/// Replaces characters that are invalid in Windows/macOS/Linux filenames.
fn sanitize_filename(name: &str) -> String {
    name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "-")
}

#[cfg(not(feature = "cli-only"))]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![rename_drawings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
