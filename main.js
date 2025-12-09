const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
// If this file is executed with plain `node main.js` (not Electron), show a helpful message
if (!process.versions || !process.versions.electron) {
  console.error('This script is the Electron main process. Do not run it with `node main.js`.');
  console.error('Run the GUI with `npm run start-gui` or `npx electron .` after installing dependencies.');
  process.exit(1);
}
const path = require('path');
const { spawn } = require('child_process');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  // Remove the default application menu (File/Edit/View) and hide the menu bar
  try {
    Menu.setApplicationMenu(null);
    // Also hide the menu bar on Windows/Linux
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);
  } catch (e) {
    // If running under a different environment, ignore
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: run renamer as a child process and stream output to renderer
ipcMain.handle('run-renamer', (event, opts) => {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'renamer.js')];
    if (opts.registerPath) args.push('--register', opts.registerPath);
    if (opts.dryRun) args.push('--dry-run');

    const child = spawn(process.execPath, args, { cwd: __dirname });

    child.stdout.on('data', (data) => {
      event.sender.send('renamer-log', { type: 'stdout', text: data.toString() });
    });
    child.stderr.on('data', (data) => {
      event.sender.send('renamer-log', { type: 'stderr', text: data.toString() });
    });
    child.on('close', (code) => {
      event.sender.send('renamer-log', { type: 'exit', code });
      resolve({ code });
    });
  });
});

ipcMain.handle('choose-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled) return null;
  return res.filePaths[0];
});
