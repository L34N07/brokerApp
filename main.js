const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PYTHON_SCRIPT = path.join(__dirname, 'script.py');

function runPythonCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [PYTHON_SCRIPT, command], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(new Error(`No se pudo iniciar Python (${PYTHON_BIN}): ${error.message}`));
    });

    child.on('close', (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const payload = lines[lines.length - 1];

      if (code !== 0 && !payload) {
        reject(new Error(`Python finalizó con code=${code}. ${stderr.trim()}`));
        return;
      }

      if (!payload) {
        reject(new Error(`Python no devolvió respuesta. ${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(payload));
      } catch (error) {
        reject(new Error(`Respuesta inválida de Python: ${payload}`));
      }
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

ipcMain.handle('broker:check-token', async () => {
  try {
    return await runPythonCommand('check-token');
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:get-portfolio', async () => {
  try {
    return await runPythonCommand('portfolio');
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
