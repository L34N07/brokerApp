const statusText = document.getElementById('status-text');
const portfolioButton = document.getElementById('btn-load-portfolio');
const accountButton = document.getElementById('btn-load-account-status');
const operationsButton = document.getElementById('btn-open-operations');
const changeAccountButton = document.getElementById('btn-change-account');
const portfolioContainer = document.getElementById('portfolio');
const accountContainer = document.getElementById('account-status');

let activeUsername = '';

function safeText(value, fallback = 'N/A') {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, decimals = 2) {
  const number = toNumber(value);
  return number === null ? 'N/A' : number.toFixed(decimals);
}

function formatMoney(value, symbol) {
  return `${safeText(symbol, '')} ${formatNumber(value)}`.trim();
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.className = `status-text ${tone}`;
}

function setActionsEnabled(enabled) {
  portfolioButton.disabled = !enabled;
  accountButton.disabled = !enabled;
  operationsButton.disabled = !enabled;
}

function renderError(targetNode, message) {
  clearNode(targetNode);
  const block = document.createElement('div');
  block.className = 'response-block';
  block.textContent = safeText(message, 'Ocurrió un error inesperado.');
  targetNode.appendChild(block);
}

function createCell(value, className = '') {
  const td = document.createElement('td');
  td.textContent = safeText(value);
  if (className) {
    td.className = className;
  }
  return td;
}

function movementClass(value) {
  const number = toNumber(value);
  if (number === null) {
    return '';
  }
  return number < 0 ? 'loss' : 'profit';
}

function renderPanelHeader(container, title) {
  const header = document.createElement('div');
  header.className = 'panel-header';
  header.textContent = title;
  container.appendChild(header);
}

function renderPortfolio(data) {
  clearNode(portfolioContainer);
  renderPanelHeader(portfolioContainer, `Portafolio ${safeText(data.pais, '')}`.trim());

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const columns = ['Símbolo', 'Cantidad', 'Últ. Precio', 'PPC', 'Var. Diaria', 'Ganancia (%)', 'Ganancia ($)', 'Valorizado'];
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const activo of data.activos || []) {
    const row = document.createElement('tr');
    row.appendChild(createCell(activo?.titulo?.simbolo));
    row.appendChild(createCell(activo?.cantidad));
    row.appendChild(createCell(activo?.ultimoPrecio));
    row.appendChild(createCell(activo?.ppc));
    row.appendChild(createCell(activo?.variacionDiaria, movementClass(activo?.variacionDiaria)));
    row.appendChild(createCell(`${formatNumber(activo?.gananciaPorcentaje)}%`, movementClass(activo?.gananciaPorcentaje)));
    row.appendChild(createCell(formatNumber(activo?.gananciaDinero), movementClass(activo?.gananciaDinero)));
    row.appendChild(createCell(formatNumber(activo?.valorizado)));
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  portfolioContainer.appendChild(table);
}

function renderAccountStatus(data) {
  clearNode(accountContainer);
  renderPanelHeader(accountContainer, 'Estado de cuenta');

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const columns = ['Moneda', 'Disponible', 'Comprometido', 'Saldo', 'Títulos valorizados', 'Total'];
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const cuenta of data.cuentas || []) {
    const row = document.createElement('tr');
    const symbol = safeText(cuenta.simboloMoneda, '');
    row.appendChild(createCell(cuenta.moneda));
    row.appendChild(createCell(formatMoney(cuenta.disponible, symbol)));
    row.appendChild(createCell(formatMoney(cuenta.comprometido, symbol)));
    row.appendChild(createCell(formatMoney(cuenta.saldo, symbol)));
    row.appendChild(createCell(formatMoney(cuenta.titulosValorizados, symbol)));
    row.appendChild(createCell(formatMoney(cuenta.total, symbol), movementClass(cuenta.total)));
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  accountContainer.appendChild(table);
}

async function refreshActiveAccount() {
  const response = await window.apiBroker.listAccounts();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
  }

  activeUsername = safeText(response.active_username, '').trim();
  if (activeUsername) {
    setActionsEnabled(true);
    setStatus(`Cuenta activa: ${activeUsername}.`, 'ok');
    return;
  }

  setActionsEnabled(false);
  setStatus('No hay cuenta activa. Usá "Cambiar Cuenta".', 'error');
}

async function loadPortfolio() {
  if (!activeUsername) {
    setStatus('No hay cuenta activa. Usá "Cambiar Cuenta".', 'error');
    return;
  }

  portfolioButton.disabled = true;
  setStatus(`Consultando portafolio (${activeUsername})...`, 'neutral');

  try {
    const response = await window.apiBroker.getPortfolio();
    if (Array.isArray(response.activos)) {
      renderPortfolio(response);
      setStatus('Portafolio actualizado.', 'ok');
      return;
    }

    renderError(portfolioContainer, response.mensaje || JSON.stringify(response, null, 2));
    setStatus(response.mensaje || 'Error al consultar portafolio.', 'error');
  } catch (error) {
    renderError(portfolioContainer, error.message);
    setStatus(error.message, 'error');
  } finally {
    portfolioButton.disabled = false;
  }
}

async function loadAccountStatus() {
  if (!activeUsername) {
    setStatus('No hay cuenta activa. Usá "Cambiar Cuenta".', 'error');
    return;
  }

  accountButton.disabled = true;
  setStatus(`Consultando estado de cuenta (${activeUsername})...`, 'neutral');

  try {
    const response = await window.apiBroker.getAccountStatus();
    if (Array.isArray(response.cuentas)) {
      renderAccountStatus(response);
      setStatus('Estado de cuenta actualizado.', 'ok');
      return;
    }

    renderError(accountContainer, response.mensaje || JSON.stringify(response, null, 2));
    setStatus(response.mensaje || 'Error al consultar estado de cuenta.', 'error');
  } catch (error) {
    renderError(accountContainer, error.message);
    setStatus(error.message, 'error');
  } finally {
    accountButton.disabled = false;
  }
}

async function openLoginWindow() {
  try {
    await window.apiBroker.openLoginWindow();
    setStatus('Ventana de login abierta.', 'neutral');
  } catch (_error) {
    setStatus('No se pudo abrir la ventana de login.', 'error');
  }
}

async function initialize() {
  setActionsEnabled(false);
  setStatus('Cargando cuenta activa...', 'neutral');
  try {
    await refreshActiveAccount();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

portfolioButton.addEventListener('click', () => {
  loadPortfolio();
});

accountButton.addEventListener('click', () => {
  loadAccountStatus();
});

operationsButton.addEventListener('click', async () => {
  try {
    await window.apiBroker.openOperationsWindow();
  } catch (_error) {
    setStatus('No se pudo abrir la pestaña de operaciones.', 'error');
  }
});

changeAccountButton.addEventListener('click', () => {
  openLoginWindow();
});

window.addEventListener('focus', () => {
  refreshActiveAccount().catch(() => {});
});

initialize();
