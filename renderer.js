const portfolioButton = document.getElementById('btn-load-portfolio');
const accountButton = document.getElementById('btn-load-account-status');
const operationsButton = document.getElementById('btn-open-operations');
const changeAccountButton = document.getElementById('btn-change-account');
const portfolioContainer = document.getElementById('portfolio');
const accountContainer = document.getElementById('account-status');

let activeUsername = '';
let toastNode = null;
let toastTimeoutId = null;
let hasShownActiveAccountToast = false;
const integerNumberFormatter = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 0
});
const decimalFormatters = new Map();

function ensureToastNode() {
  let styleNode = document.getElementById('broker-toast-style');
  if (!styleNode) {
    styleNode = document.createElement('style');
    styleNode.id = 'broker-toast-style';
    styleNode.textContent = `
      .broker-toast {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 9999;
        max-width: min(420px, calc(100vw - 24px));
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #dbe3df;
        background: #f6f8f7;
        color: #2c3a3f;
        font-size: 0.9rem;
        box-shadow: 0 12px 28px rgba(29, 49, 42, 0.18);
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .broker-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      .broker-toast.ok {
        color: #1f6f53;
        background: #e3f2eb;
        border-color: #cde7db;
      }
      .broker-toast.error {
        color: #8e2f3a;
        background: #f9ecee;
        border-color: #f2d4d8;
      }
    `;
    document.head.appendChild(styleNode);
  }

  if (!toastNode) {
    toastNode = document.createElement('div');
    toastNode.className = 'broker-toast';
    document.body.appendChild(toastNode);
  }

  return toastNode;
}

function getDecimalFormatter(decimals) {
  if (!decimalFormatters.has(decimals)) {
    decimalFormatters.set(
      decimals,
      new Intl.NumberFormat('es-AR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
    );
  }

  return decimalFormatters.get(decimals);
}

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
  if (number === null) {
    return 'N/A';
  }

  const rounded = Number(number.toFixed(decimals));
  if (decimals > 0 && Number.isInteger(rounded)) {
    return integerNumberFormatter.format(rounded);
  }
  return getDecimalFormatter(decimals).format(rounded);
}

function formatMoney(value, symbol) {
  return `${safeText(symbol, '')} ${formatNumber(value)}`.trim();
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function setStatus(message, tone = 'neutral', options = {}) {
  if (options.silent || !message) {
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

  const previousUsername = activeUsername;
  activeUsername = safeText(response.active_username, '').trim();
  if (activeUsername) {
    setActionsEnabled(true);
    if (!hasShownActiveAccountToast || activeUsername !== previousUsername) {
      setStatus(`Cuenta activa: ${activeUsername}.`, 'ok');
      hasShownActiveAccountToast = true;
    }
    return;
  }

  hasShownActiveAccountToast = false;
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
