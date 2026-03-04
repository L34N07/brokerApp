const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PYTHON_SCRIPT = path.join(__dirname, 'script.py');
let mainWindow = null;
let loginWindow = null;
let operationsWindow = null;

function runPythonCommand(command, payload = null) {
  return new Promise((resolve, reject) => {
    const args = [PYTHON_SCRIPT, command];
    if (payload && typeof payload === 'object') {
      args.push(JSON.stringify(payload));
    }
    const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    width: 640,
    height: 540,
    resizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile('login.html');
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
  return loginWindow;
}

function createOperationsWindow() {
  if (operationsWindow && !operationsWindow.isDestroyed()) {
    operationsWindow.focus();
    return;
  }

  operationsWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  operationsWindow.loadFile('operaciones.html');
  operationsWindow.on('closed', () => {
    operationsWindow = null;
  });
}

ipcMain.handle('broker:check-token', async (_event, payload) => {
  try {
    return await runPythonCommand('check-token', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:get-portfolio', async (_event, payload) => {
  try {
    return await runPythonCommand('portfolio', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:get-account-status', async (_event, payload) => {
  try {
    return await runPythonCommand('account-status', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:get-operations', async (_event, filters) => {
  try {
    return await runPythonCommand('operations', filters || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:open-operations-window', () => {
  createOperationsWindow();
  return { estado: 'ok' };
});

ipcMain.handle('broker:open-login-window', () => {
  createLoginWindow();
  return { estado: 'ok' };
});

ipcMain.handle('broker:activate-session', () => {
  createMainWindow();
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  return { estado: 'ok' };
});

ipcMain.handle('broker:list-accounts', async () => {
  try {
    return await runPythonCommand('list-accounts');
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:login', async (_event, payload) => {
  try {
    return await runPythonCommand('login', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:select-account', async (_event, payload) => {
  try {
    return await runPythonCommand('select-account', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

app.whenReady().then(() => {
  createLoginWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createLoginWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
