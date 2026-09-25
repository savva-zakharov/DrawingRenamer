const startBtn = document.getElementById('start');
const registerInput = document.getElementById('register');
const dryCheckbox = document.getElementById('dry');
const logEl = document.getElementById('log');
const chooseBtn = document.getElementById('choose');

function appendLog(text, cls) {
  logEl.textContent += text + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

chooseBtn.addEventListener('click', async () => {
  if (window.api && window.api.chooseFolder) {
    const folder = await window.api.chooseFolder();
    if (folder) registerInput.value = folder;
    return;
  }

  // Fallback for Neutralino or plain browser: ask via prompt
  if (window.Neutralino && Neutralino.os) {
    try {
      // Neutralino has a dialog API in some versions, but to keep compatibility use prompt fallback
      const fallback = prompt('Enter folder path:');
      if (fallback) registerInput.value = fallback;
    } catch (e) {
      const fallback = prompt('Enter folder path:');
      if (fallback) registerInput.value = fallback;
    }
    return;
  }

  const fallback = prompt('Enter folder path:');
  if (fallback) registerInput.value = fallback;
});

// Hook logs for Electron, otherwise Neutralino will stream output differently
if (window.api && window.api.onLog) {
  window.api.onLog((data) => {
    if (data.type === 'stdout' || data.type === 'stderr') appendLog(data.text);
    if (data.type === 'exit') appendLog('Process exited with code ' + data.code);
  });
}

startBtn.addEventListener('click', async () => {
  logEl.textContent = '';
  const registerPath = registerInput.value || null;
  const dry = !!dryCheckbox.checked;
  appendLog('Starting renamer...');

  // If Neutralino is available, use it to run the node script
  if (window.Neutralino && Neutralino.os && Neutralino.os.execCommand) {
    try {
      await Neutralino.init();
    } catch (e) {
      // ignore if already initialized
    }
    const cmdParts = ['node', 'renamer.js'];
    if (registerPath) {
      cmdParts.push('--register');
      cmdParts.push('"' + registerPath + '"');
    }
    if (dry) cmdParts.push('--dry-run');
    const cmd = cmdParts.join(' ');
    appendLog('> ' + cmd);
    try {
      const res = await Neutralino.os.execCommand(cmd);
      // res may be string or object depending on runtime; attempt to print useful parts
      if (typeof res === 'string') {
        appendLog(res);
      } else if (res && res.stdOut) {
        appendLog(res.stdOut);
      } else if (res && res.stdout) {
        appendLog(res.stdout);
      } else if (res && res.output) {
        appendLog(res.output);
      } else {
        appendLog(JSON.stringify(res));
      }
      appendLog('Process finished.');
    } catch (err) {
      appendLog('Error running renamer: ' + (err && err.message ? err.message : String(err)));
    }
    return;
  }

  // Fallback to Electron API if present
  if (window.api && window.api.runRenamer) {
    const opts = { registerPath, dryRun: dry };
    await window.api.runRenamer(opts);
    return;
  }

  appendLog('No runtime available to execute renamer (Neutralino or Electron).');
});
