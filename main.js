const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

let mainWindow = null;
let loginWindow = null;
let operationsWindow = null;

function getBackendRuntime() {
  if (app.isPackaged) {
    const backendName = process.platform === 'win32' ? 'broker-backend.exe' : 'broker-backend';
    return {
      command: path.join(process.resourcesPath, 'backend', backendName),
      args: []
    };
  }

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return {
    command: pythonBin,
    args: [path.join(__dirname, 'script.py')]
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

function runPythonCommand(command, payload = null) {
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

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(new Error(`No se pudo iniciar backend (${backendRuntime.command}): ${error.message}`));
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
    x: 0,
    y: 0,
    width: 790,
    height: 560,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(mainWindow);
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
    x: 0,
    y: 0,
    width: 760,
    height: 620,
    minWidth: 620,
    minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(loginWindow);
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
    x: 0,
    y: 0,
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(operationsWindow);
  operationsWindow.loadFile('operaciones.html');
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

ipcMain.handle('broker:logout', async () => {
  try {
    const response = await runPythonCommand('logout');
    if (response.estado === 'ok') {
      if (operationsWindow && !operationsWindow.isDestroyed()) {
        operationsWindow.close();
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
