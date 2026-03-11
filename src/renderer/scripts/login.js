const accessButton = document.getElementById('btn-access-account');
const addAccountButton = document.getElementById('btn-add-account');
const deleteAccountButton = document.getElementById('btn-delete-account');
const savedUserSelect = document.getElementById('saved-user-select');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const passwordToggleButton = document.getElementById('btn-toggle-password');

let toastNode = null;
let toastTimeoutId = null;

function ensureToastNode() {
  if (!toastNode) {
    toastNode = document.createElement('div');
    toastNode.className = 'broker-toast';
    document.body.appendChild(toastNode);
  }

  return toastNode;
}

function safeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value).trim();
}

function setPasswordVisibility(visible) {
  const shouldShow = Boolean(visible);
  passwordInput.type = shouldShow ? 'text' : 'password';
  passwordToggleButton.setAttribute('aria-pressed', String(shouldShow));
  passwordToggleButton.setAttribute(
    'aria-label',
    shouldShow ? 'Ocultar contraseña' : 'Mostrar contraseña'
  );
  passwordToggleButton.setAttribute(
    'title',
    shouldShow ? 'Ocultar contraseña' : 'Mostrar contraseña'
  );
}

function setStatus(message, tone = 'neutral') {
  if (!message) {
    return;
  }

  const node = ensureToastNode();
  node.textContent = String(message);
  node.className = `broker-toast ${tone}`;
  node.classList.add('show');

  if (toastTimeoutId !== null) {
    clearTimeout(toastTimeoutId);
  }
  toastTimeoutId = setTimeout(() => {
    node.classList.remove('show');
  }, 2000);
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
    option.textContent = username;
    savedUserSelect.appendChild(option);
  }

  const preferred = safeText(activeUser);
  if (preferred) {
    savedUserSelect.value = preferred;
    if (!savedUserSelect.value) {
      savedUserSelect.value = '';
    }
  }
  deleteAccountButton.disabled = !safeText(savedUserSelect.value);
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
    setPasswordVisibility(false);
    await finalizeLogin();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    addAccountButton.disabled = false;
  }
}

async function handleDeleteAccount() {
  const username = safeText(savedUserSelect.value);
  if (!username) {
    setStatus('Seleccioná una cuenta guardada para eliminar.', 'error');
    return;
  }

  const confirmed = window.confirm(`¿Eliminar la cuenta guardada '${username}'?`);
  if (!confirmed) {
    return;
  }

  deleteAccountButton.disabled = true;
  accessButton.disabled = true;
  setStatus(`Eliminando cuenta '${username}'...`, 'neutral');

  try {
    const response = await window.apiBroker.deleteAccount({ username });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo eliminar la cuenta.');
    }

    await refreshAccounts();
    setStatus(response.mensaje || 'Cuenta eliminada.', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    accessButton.disabled = false;
    deleteAccountButton.disabled = !safeText(savedUserSelect.value);
  }
}

savedUserSelect.addEventListener('change', () => {
  const username = safeText(savedUserSelect.value);
  deleteAccountButton.disabled = !username;
  if (username) {
    setStatus(`Cuenta seleccionada: ${username}.`, 'neutral');
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

deleteAccountButton.addEventListener('click', () => {
  handleDeleteAccount();
});

passwordToggleButton.addEventListener('click', () => {
  setPasswordVisibility(passwordInput.type === 'password');
});

setPasswordVisibility(false);

refreshAccounts().catch((error) => {
  setStatus(error.message, 'error');
});
