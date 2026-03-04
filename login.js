const accessButton = document.getElementById('btn-access-account');
const addAccountButton = document.getElementById('btn-add-account');
const savedUserSelect = document.getElementById('saved-user-select');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const statusText = document.getElementById('status-text');

function safeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.className = `status-text ${tone}`;
}

function setUserSelectOptions(accounts, activeUser) {
  while (savedUserSelect.firstChild) {
    savedUserSelect.removeChild(savedUserSelect.firstChild);
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Usuarios guardados';
  savedUserSelect.appendChild(placeholder);

  for (const account of accounts || []) {
    const username = safeText(account?.username);
    if (!username) {
      continue;
    }
    const option = document.createElement('option');
    option.value = username;
    const hasToken = account?.has_token ? 'token' : 'sin token';
    option.textContent = `${username} (${hasToken})`;
    savedUserSelect.appendChild(option);
  }

  const preferred = safeText(activeUser);
  if (preferred) {
    savedUserSelect.value = preferred;
    if (!savedUserSelect.value) {
      savedUserSelect.value = '';
    }
  }
}

async function refreshAccounts() {
  const response = await window.apiBroker.listAccounts();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudieron cargar las cuentas guardadas.');
  }

  setUserSelectOptions(response.accounts, response.active_username);
  if (response.active_username) {
    setStatus(`Cuenta activa actual: ${response.active_username}.`, 'neutral');
  } else {
    setStatus('Seleccioná una cuenta guardada o agregá una nueva.', 'neutral');
  }
}

async function ensureToken(username) {
  const response = await window.apiBroker.checkToken({ username });
  if (response.estado !== 'conectado') {
    throw new Error(response.mensaje || 'No se pudo validar la cuenta seleccionada.');
  }
}

async function finalizeLogin() {
  const response = await window.apiBroker.activateSession();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudo abrir el panel principal.');
  }
}

async function handleAccessAccount() {
  accessButton.disabled = true;
  setStatus('Accediendo con cuenta guardada...', 'neutral');

  try {
    const username = safeText(savedUserSelect.value);
    if (!username) {
      setStatus('Seleccioná una cuenta guardada para acceder.', 'error');
      return;
    }

    const selected = await window.apiBroker.selectAccount({ username });
    if (selected.estado !== 'ok') {
      throw new Error(selected.mensaje || 'No se pudo seleccionar la cuenta.');
    }

    await ensureToken(username);
    await finalizeLogin();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    accessButton.disabled = false;
  }
}

async function handleAddAccount() {
  addAccountButton.disabled = true;
  setStatus('Agregando cuenta...', 'neutral');

  try {
    const username = safeText(usernameInput.value);
    const password = safeText(passwordInput.value);

    if (!username) {
      setStatus('Ingresá un usuario para agregar la cuenta.', 'error');
      return;
    }
    if (!password) {
      setStatus('Ingresá la contraseña para agregar la cuenta.', 'error');
      return;
    }

    const loginResponse = await window.apiBroker.login({ username, password });
    if (loginResponse.estado !== 'conectado') {
      throw new Error(loginResponse.mensaje || 'No se pudo agregar la cuenta.');
    }

    passwordInput.value = '';
    await finalizeLogin();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    addAccountButton.disabled = false;
  }
}

savedUserSelect.addEventListener('change', () => {
  const username = safeText(savedUserSelect.value);
  if (username) {
    setStatus(`Cuenta seleccionada: ${username}. Presioná Acceder.`, 'neutral');
  }
});

usernameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    handleAddAccount();
  }
});

passwordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    handleAddAccount();
  }
});

accessButton.addEventListener('click', () => {
  handleAccessAccount();
});

addAccountButton.addEventListener('click', () => {
  handleAddAccount();
});

refreshAccounts().catch((error) => {
  setStatus(error.message, 'error');
});
