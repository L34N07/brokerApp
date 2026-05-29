const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const BACKEND_SCRIPT_PATH = path.join(__dirname, '..', 'backend', 'script.py');
const SYMBOL_SEARCH_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.BROKERAPP_SYMBOL_SEARCH_TIMEOUT_MS || '45000',
  10
) || 45000;

let mainWindow = null;
let loginWindow = null;
let operationsWindow = null;
let symbolsWindow = null;
let dashboardWindow = null;

function isExecutableFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    return process.platform === 'win32' || Boolean(stats.mode & 0o111);
  } catch (_error) {
    return false;
  }
}

function getPythonCommand() {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }

  const venvPython = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, '.venv', 'bin', 'python');

  if (isExecutableFile(venvPython)) {
    return venvPython;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function getBackendRuntime() {
  if (app.isPackaged) {
    const backendName = process.platform === 'win32' ? 'broker-backend.exe' : 'broker-backend';
    return {
      command: path.join(process.resourcesPath, 'backend', backendName),
      args: []
    };
  }

  return {
    command: getPythonCommand(),
    args: [BACKEND_SCRIPT_PATH]
  };
}

function lockDownWindow(win) {
  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toUpperCase();
    const ctrlOrCmd = input.control || input.meta;
    const devtoolsShortcut = ctrlOrCmd && input.shift && (key === 'I' || key === 'J' || key === 'C');
    const reloadShortcut = key === 'F5' || (ctrlOrCmd && key === 'R');
    const forceReloadShortcut = ctrlOrCmd && input.shift && key === 'R';
    if (key === 'F12' || devtoolsShortcut || reloadShortcut || forceReloadShortcut) {
      event.preventDefault();
    }
  });
}

function runPythonCommand(command, payload = null, options = {}) {
  return new Promise((resolve, reject) => {
    const backendRuntime = getBackendRuntime();
    const args = [...backendRuntime.args, command];
    const userDataDir = app.getPath('userData');
    const backendEnv = {
      ...process.env,
      BROKERAPP_DATA_DIR: userDataDir
    };
    if (payload && typeof payload === 'object') {
      args.push(JSON.stringify(payload));
    }
    const child = spawn(backendRuntime.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: backendEnv
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId = null;

    if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      reject(new Error(`No se pudo iniciar backend (${backendRuntime.command}): ${error.message}`));
    });

    child.on('close', (code) => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }

      if (timedOut) {
        reject(new Error(`Python excedió el tiempo máximo (${options.timeoutMs}ms) para ${command}.`));
        return;
      }

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
    x: 0,
    y: 0,
    width: 790,
    height: 560,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(mainWindow);
  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
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
    x: 0,
    y: 0,
    width: 760,
    height: 620,
    minWidth: 620,
    minHeight: 520,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(loginWindow);
  loginWindow.loadFile(path.join(RENDERER_DIR, 'login.html'));
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
    x: 0,
    y: 0,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(operationsWindow);
  operationsWindow.loadFile(path.join(RENDERER_DIR, 'operaciones.html'));
  operationsWindow.once('ready-to-show', () => {
    if (!operationsWindow || operationsWindow.isDestroyed()) {
      return;
    }
    operationsWindow.maximize();
  });
  operationsWindow.on('closed', () => {
    operationsWindow = null;
  });
}

function createSymbolsWindow() {
  if (symbolsWindow && !symbolsWindow.isDestroyed()) {
    symbolsWindow.focus();
    return;
  }

  symbolsWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(symbolsWindow);
  symbolsWindow.loadFile(path.join(RENDERER_DIR, 'simbolos.html'));
  symbolsWindow.once('ready-to-show', () => {
    if (!symbolsWindow || symbolsWindow.isDestroyed()) {
      return;
    }
    symbolsWindow.maximize();
  });
  symbolsWindow.on('closed', () => {
    symbolsWindow = null;
  });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(dashboardWindow);
  dashboardWindow.loadFile(path.join(RENDERER_DIR, 'dashboard.html'));
  dashboardWindow.once('ready-to-show', () => {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) {
      return;
    }
    dashboardWindow.maximize();
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
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

ipcMain.handle('broker:get-symbol-search-config', async (_event, payload) => {
  try {
    return await runPythonCommand('symbol-search-config', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:get-symbols', async (_event, payload) => {
  try {
    return await runPythonCommand('symbols', payload || {}, { timeoutMs: SYMBOL_SEARCH_COMMAND_TIMEOUT_MS });
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

ipcMain.handle('broker:get-quote-flags', async (_event, payload) => {
  try {
    return await runPythonCommand('quote-flags', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:sell-order', async (_event, payload) => {
  try {
    return await runPythonCommand('sell-order', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:cancel-operation', async (_event, payload) => {
  try {
    return await runPythonCommand('cancel-operation', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:save-dashboard-layout', async (_event, payload) => {
  try {
    return await runPythonCommand('save-dashboard-layout', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:load-dashboard-layout', async (_event, payload) => {
  try {
    return await runPythonCommand('load-dashboard-layout', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:list-dashboard-layouts', async (_event, payload) => {
  try {
    return await runPythonCommand('list-dashboard-layouts', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

ipcMain.handle('broker:delete-dashboard-layout', async (_event, payload) => {
  try {
    return await runPythonCommand('delete-dashboard-layout', payload || {});
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

ipcMain.handle('broker:open-symbols-window', () => {
  createSymbolsWindow();
  return { estado: 'ok' };
});

ipcMain.handle('broker:open-dashboard-window', () => {
  createDashboardWindow();
  return { estado: 'ok' };
});

ipcMain.handle('broker:logout', async () => {
  try {
    const response = await runPythonCommand('logout');
    if (response.estado === 'ok') {
      if (operationsWindow && !operationsWindow.isDestroyed()) {
        operationsWindow.close();
      }
      if (symbolsWindow && !symbolsWindow.isDestroyed()) {
        symbolsWindow.close();
      }
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.close();
      }
      createLoginWindow();
    }
    return response;
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
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

ipcMain.handle('broker:delete-account', async (_event, payload) => {
  try {
    return await runPythonCommand('delete-account', payload || {});
  } catch (error) {
    return {
      estado: 'error',
      mensaje: error.message
    };
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
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
