const dateFromInput = document.getElementById('fecha-desde');
const dateToInput = document.getElementById('fecha-hasta');
const timeFromInput = document.getElementById('hora-desde');
const timeToInput = document.getElementById('hora-hasta');
const loadButton = document.getElementById('btn-load-operations');
const changeAccountButton = document.getElementById('btn-change-account');
const statusText = document.getElementById('status-text');
const operationsBody = document.getElementById('operations-body');
const operationsEmpty = document.getElementById('operations-empty');
const typeFilters = Array.from(document.querySelectorAll('input[data-type]'));
const statusFilters = Array.from(document.querySelectorAll('input[data-status]'));

let allOperations = [];
let activeUsername = '';

function safeText(value, fallback = '-') {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function formatDateISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeISO(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function nowLocal() {
  return new Date();
}

function setDefaultFilters() {
  const now = nowLocal();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  dateFromInput.value = formatDateISO(yesterday);
  dateToInput.value = formatDateISO(now);
  timeFromInput.value = '00:00:00';
  timeToInput.value = '';
}

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.className = `status-text ${tone}`;
}

function setSearchEnabled(enabled) {
  loadButton.disabled = !enabled;
}

function normalizeOperationType(value) {
  const normalized = safeText(value, '').toLowerCase();
  if (normalized.startsWith('compra')) {
    return 'compra';
  }
  if (normalized.startsWith('venta')) {
    return 'venta';
  }
  return 'otro';
}

function normalizeOperationStatus(value) {
  const normalized = safeText(value, '').toLowerCase();
  if (normalized.includes('cancel')) {
    return 'canceladas';
  }
  if (normalized.includes('terminad')) {
    return 'terminadas';
  }
  if (normalized.includes('pend')) {
    return 'pendientes';
  }
  return 'otras';
}

function getSelectedTypes() {
  return new Set(typeFilters.filter((item) => item.checked).map((item) => item.dataset.type));
}

function getSelectedStatuses() {
  return new Set(statusFilters.filter((item) => item.checked).map((item) => item.dataset.status));
}

function clearTable() {
  while (operationsBody.firstChild) {
    operationsBody.removeChild(operationsBody.firstChild);
  }
}

function appendCell(row, value, className = '') {
  const td = document.createElement('td');
  if (className) {
    td.className = className;
  }
  td.textContent = safeText(value);
  row.appendChild(td);
}

function renderTypeTag(tipo) {
  const span = document.createElement('span');
  const normalized = normalizeOperationType(tipo);
  span.className = `tag ${normalized === 'compra' ? 'tag-compra' : normalized === 'venta' ? 'tag-venta' : ''}`.trim();
  span.textContent = safeText(tipo);
  return span;
}

function renderRows(rows) {
  clearTable();
  operationsEmpty.style.display = rows.length === 0 ? 'block' : 'none';
  if (rows.length === 0) {
    return;
  }

  for (const operation of rows) {
    const row = document.createElement('tr');

    appendCell(row, operation.numero);
    appendCell(row, operation.fechaOrden);

    const typeCell = document.createElement('td');
    typeCell.appendChild(renderTypeTag(operation.tipo));
    row.appendChild(typeCell);

    appendCell(row, operation.estado);
    appendCell(row, operation.mercado);
    appendCell(row, operation.simbolo);
    appendCell(row, operation.cantidad);
    appendCell(row, operation.monto);
    appendCell(row, operation.modalidad);
    appendCell(row, operation.precio);
    appendCell(row, operation.fechaOperada);
    appendCell(row, operation.cantidadOperada);
    appendCell(row, operation.precioOperado);
    appendCell(row, operation.montoOperado);
    appendCell(row, operation.plazo);

    operationsBody.appendChild(row);
  }
}

function applyClientFilters() {
  const selectedTypes = getSelectedTypes();
  const selectedStatuses = getSelectedStatuses();

  const filtered = allOperations.filter((operation) => {
    const opType = operation.tipoFiltro || normalizeOperationType(operation.tipo);
    const opStatus = operation.estadoFiltro || normalizeOperationStatus(operation.estado);

    const typeMatch = selectedTypes.has(opType);
    const statusMatch = selectedStatuses.has(opStatus);
    return typeMatch && statusMatch;
  });

  renderRows(filtered);
}

function buildRequestFilters() {
  const now = nowLocal();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fechaDesde = dateFromInput.value || formatDateISO(yesterday);
  const fechaHasta = dateToInput.value || formatDateISO(now);
  const horaDesde = timeFromInput.value || '00:00:00';

  let horaHasta = timeToInput.value;
  if (!horaHasta) {
    horaHasta = formatTimeISO(now);
  }

  return {
    fechaDesde,
    fechaHasta,
    horaDesde,
    horaHasta
  };
}

async function refreshActiveAccount() {
  const response = await window.apiBroker.listAccounts();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
  }

  activeUsername = safeText(response.active_username, '');
  if (activeUsername) {
    setSearchEnabled(true);
    setStatus(`Cuenta activa: ${activeUsername}.`, 'ok');
    return;
  }

  setSearchEnabled(false);
  setStatus('No hay cuenta activa. Usá "Cambiar Cuenta".', 'error');
}

async function loadOperations() {
  if (!activeUsername) {
    setStatus('No hay cuenta activa. Usá "Cambiar Cuenta".', 'error');
    return;
  }

  loadButton.disabled = true;
  setStatus(`Consultando operaciones (${activeUsername})...`, 'neutral');

  try {
    const filters = buildRequestFilters();
    const response = await window.apiBroker.getOperations(filters);

    if (!Array.isArray(response.operaciones)) {
      setStatus(response.mensaje || 'Error al consultar operaciones.', 'error');
      allOperations = [];
      renderRows([]);
      return;
    }

    allOperations = response.operaciones;
    applyClientFilters();
    setStatus(`Operaciones cargadas: ${allOperations.length}.`, 'ok');
  } catch (error) {
    allOperations = [];
    renderRows([]);
    setStatus(error.message, 'error');
  } finally {
    loadButton.disabled = false;
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

for (const checkbox of typeFilters) {
  checkbox.addEventListener('change', () => {
    applyClientFilters();
  });
}

for (const checkbox of statusFilters) {
  checkbox.addEventListener('change', () => {
    applyClientFilters();
  });
}

loadButton.addEventListener('click', () => {
  loadOperations();
});

changeAccountButton.addEventListener('click', () => {
  openLoginWindow();
});

window.addEventListener('focus', () => {
  refreshActiveAccount().catch(() => {});
});

setDefaultFilters();
setSearchEnabled(false);
setStatus('Cargando cuenta activa...', 'neutral');
refreshActiveAccount().catch((error) => {
  setStatus(error.message, 'error');
});
