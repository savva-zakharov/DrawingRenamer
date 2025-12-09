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
  const folder = await window.api.chooseFolder();
  if (folder) registerInput.value = folder;
});

window.api.onLog((data) => {
  if (data.type === 'stdout' || data.type === 'stderr') appendLog(data.text);
  if (data.type === 'exit') appendLog('Process exited with code ' + data.code);
});

startBtn.addEventListener('click', async () => {
  logEl.textContent = '';
  const opts = { registerPath: registerInput.value || null, dryRun: !!dryCheckbox.checked };
  appendLog('Starting renamer...');
  await window.api.runRenamer(opts);
});
