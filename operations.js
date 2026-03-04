const reloadButton = document.getElementById('btn-reload-operations');
const changeAccountButton = document.getElementById('btn-change-account');
const statusText = document.getElementById('status-text');
const dataRangeText = document.getElementById('data-range');
const dataSummary = document.getElementById('data-summary');
const chartsGrid = document.getElementById('charts-grid');
const gridAddZone = document.getElementById('grid-add-zone');
const addChartInitialButton = document.getElementById('btn-add-chart-initial');
const mainTabButtons = Array.from(document.querySelectorAll('[data-main-tab]'));
const mainTabPanels = Array.from(document.querySelectorAll('[data-main-panel]'));

let activeUsername = '';
let allOperations = [];
let operationsBySymbol = new Map();
let availableSymbols = [];
let chartIdCounter = 0;

const integerNumberFormatter = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 0
});
const decimalNumberFormatter = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function safeText(value, fallback = '-') {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function nowLocal() {
  return new Date();
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

function buildDefaultRequestFilters() {
  const now = nowLocal();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  return {
    fechaDesde: formatDateISO(yesterday),
    fechaHasta: formatDateISO(now),
    horaDesde: '00:00:00',
    horaHasta: formatTimeISO(now)
  };
}

function formatRangeText(filters) {
  return `${filters.fechaDesde} ${filters.horaDesde} -> ${filters.fechaHasta} ${filters.horaHasta}`;
}

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.className = `status-text ${tone}`;
}

function setActionsEnabled(enabled) {
  reloadButton.disabled = !enabled;
  changeAccountButton.disabled = false;
  const canAddChart = enabled && availableSymbols.length > 0;
  addChartInitialButton.disabled = !canAddChart;
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
  if (normalized.includes('pend') || normalized.includes('proceso')) {
    return 'pendientes';
  }
  return 'otras';
}

function parseOperationNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const raw = safeText(value, '');
  if (!raw) {
    return 0;
  }

  const sanitized = raw.replace(/[^0-9,.-]/g, '');
  if (!sanitized) {
    return 0;
  }

  const hasComma = sanitized.includes(',');
  const hasDot = sanitized.includes('.');

  let normalized = sanitized;
  if (hasComma && hasDot) {
    const lastComma = sanitized.lastIndexOf(',');
    const lastDot = sanitized.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = sanitized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = sanitized.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = sanitized.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  const rounded = Number((value || 0).toFixed(2));
  if (Number.isInteger(rounded)) {
    return integerNumberFormatter.format(rounded);
  }
  return decimalNumberFormatter.format(rounded);
}

function clearCharts() {
  const cards = chartsGrid.querySelectorAll('.chart-card');
  for (const card of cards) {
    card.remove();
  }
}

function setDataSummary(message) {
  dataSummary.textContent = message;
}

function updateAddEntryVisibility() {
  addChartInitialButton.disabled = availableSymbols.length === 0 || !activeUsername;
}

function groupOperationsBySymbol(operations) {
  const groups = new Map();

  for (const operation of operations) {
    const symbol = safeText(operation?.simbolo, '').toUpperCase() || 'SIN_SIMBOLO';
    if (!groups.has(symbol)) {
      groups.set(symbol, []);
    }
    groups.get(symbol).push(operation);
  }

  return groups;
}

function resolveChartStatusGroup(row) {
  const normalizedStatus = row.estadoFiltro || normalizeOperationStatus(row.estado);
  if (normalizedStatus === 'terminadas') {
    return 'terminadas';
  }
  if (normalizedStatus === 'pendientes') {
    return 'pendientes';
  }

  const rawStatus = safeText(row.estado, '').toLowerCase();
  if (rawStatus.includes('proceso')) {
    return 'pendientes';
  }
  return null;
}

function calculateTotalsByStatus(symbol, mode) {
  const rows = operationsBySymbol.get(symbol) || [];

  const totals = {
    terminadas: { cantidadOperada: 0, montoOperado: 0 },
    pendientes: { cantidad: 0, monto: 0, precioSum: 0, precioCount: 0 }
  };

  for (const row of rows) {
    const type = row.tipoFiltro || normalizeOperationType(row.tipo);
    if (type !== mode) {
      continue;
    }

    const statusGroup = resolveChartStatusGroup(row);
    if (!statusGroup) {
      continue;
    }

    if (statusGroup === 'pendientes') {
      totals.pendientes.cantidad += parseOperationNumber(row.cantidad);
      totals.pendientes.monto += parseOperationNumber(row.monto);

      const precioRaw = safeText(row.precio, '');
      if (precioRaw) {
        totals.pendientes.precioSum += parseOperationNumber(precioRaw);
        totals.pendientes.precioCount += 1;
      }
      continue;
    }

    totals.terminadas.cantidadOperada += parseOperationNumber(row.cantidadOperada);
    totals.terminadas.montoOperado += parseOperationNumber(row.montoOperado);
  }

  return totals;
}

function setModeTabStyles(modeButtons, activeMode) {
  for (const button of modeButtons) {
    button.classList.toggle('active', button.dataset.mode === activeMode);
  }
}

function buildValueRow(values) {
  const row = document.createElement('tr');

  for (const value of values) {
    const td = document.createElement('td');
    td.textContent = value;
    row.appendChild(td);
  }
  return row;
}

function buildSummaryTable(headers, values) {
  const table = document.createElement('table');
  table.className = 'summary-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const title of headers) {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbody.appendChild(buildValueRow(values));
  table.appendChild(tbody);

  return table;
}

function renderChartContent(container, symbol, mode) {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const totals = calculateTotalsByStatus(symbol, mode);
  const ppcOrPpv =
    totals.terminadas.cantidadOperada !== 0
      ? totals.terminadas.montoOperado / totals.terminadas.cantidadOperada
      : 0;
  const pendingMontoPromedio =
    totals.pendientes.precioCount > 0 ? totals.pendientes.precioSum / totals.pendientes.precioCount : 0;

  const groups = document.createElement('div');
  groups.className = 'summary-groups';

  const finishedGroup = document.createElement('section');
  finishedGroup.className = 'summary-group';
  const finishedTitle = document.createElement('p');
  finishedTitle.className = 'summary-group-title';
  finishedTitle.textContent = 'Terminadas';
  finishedGroup.appendChild(finishedTitle);
  finishedGroup.appendChild(
    buildSummaryTable(
      ['Cantidad Operada', 'Monto Operado', mode === 'compra' ? 'PPC' : 'PPV'],
      [
        formatNumber(totals.terminadas.cantidadOperada),
        formatNumber(totals.terminadas.montoOperado),
        formatNumber(ppcOrPpv)
      ]
    )
  );

  const pendingGroup = document.createElement('section');
  pendingGroup.className = 'summary-group';
  const pendingTitle = document.createElement('p');
  pendingTitle.className = 'summary-group-title';
  pendingTitle.textContent = 'Pendientes/En Proceso';
  pendingGroup.appendChild(pendingTitle);
  pendingGroup.appendChild(
    buildSummaryTable(
      ['Cantidad', 'Monto', 'Precio Promedio'],
      [
        formatNumber(totals.pendientes.cantidad),
        formatNumber(totals.pendientes.monto),
        formatNumber(pendingMontoPromedio)
      ]
    )
  );

  groups.appendChild(finishedGroup);
  groups.appendChild(pendingGroup);
  container.appendChild(groups);
}

function buildSymbolOptions(select, selectedSymbol) {
  while (select.firstChild) {
    select.removeChild(select.firstChild);
  }

  for (const symbol of availableSymbols) {
    const option = document.createElement('option');
    option.value = symbol;
    option.textContent = symbol;
    select.appendChild(option);
  }

  if (selectedSymbol && availableSymbols.includes(selectedSymbol)) {
    select.value = selectedSymbol;
  } else if (availableSymbols.length > 0) {
    select.value = availableSymbols[0];
  }
}

function createChartCard(defaultSymbol = '') {
  if (availableSymbols.length === 0) {
    setStatus('No hay simbolos disponibles para crear tarjetas.', 'error');
    return;
  }

  chartIdCounter += 1;

  const card = document.createElement('article');
  card.className = 'chart-card';
  card.dataset.chartId = String(chartIdCounter);

  const head = document.createElement('div');
  head.className = 'chart-head';

  const control = document.createElement('div');
  control.className = 'chart-control';

  const label = document.createElement('label');
  label.textContent = 'Simbolo';
  label.setAttribute('for', `chart-symbol-${chartIdCounter}`);

  const symbolSelect = document.createElement('select');
  symbolSelect.className = 'symbol-select';
  symbolSelect.id = `chart-symbol-${chartIdCounter}`;
  buildSymbolOptions(symbolSelect, defaultSymbol);

  control.appendChild(label);
  control.appendChild(symbolSelect);
  head.appendChild(control);

  const modeTabs = document.createElement('div');
  modeTabs.className = 'mode-tabs';

  const compraButton = document.createElement('button');
  compraButton.className = 'mode-tab active';
  compraButton.type = 'button';
  compraButton.dataset.mode = 'compra';
  compraButton.textContent = 'Compra';

  const ventaButton = document.createElement('button');
  ventaButton.className = 'mode-tab';
  ventaButton.type = 'button';
  ventaButton.dataset.mode = 'venta';
  ventaButton.textContent = 'Venta';

  modeTabs.appendChild(compraButton);
  modeTabs.appendChild(ventaButton);

  const content = document.createElement('div');
  content.className = 'chart-content';

  card.appendChild(head);
  card.appendChild(modeTabs);
  card.appendChild(content);
  chartsGrid.insertBefore(card, gridAddZone);

  const state = {
    mode: 'compra'
  };

  const modeButtons = [compraButton, ventaButton];

  const refreshCard = () => {
    const symbol = symbolSelect.value;
    setModeTabStyles(modeButtons, state.mode);
    renderChartContent(content, symbol, state.mode);
  };

  symbolSelect.addEventListener('change', () => {
    refreshCard();
  });

  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      refreshCard();
    });
  }

  refreshCard();
  updateAddEntryVisibility();
}

function syncExistingCardsWithNewData() {
  const cards = Array.from(chartsGrid.querySelectorAll('.chart-card'));
  if (cards.length === 0) {
    updateAddEntryVisibility();
    return;
  }

  for (const card of cards) {
    const select = card.querySelector('.symbol-select');
    const content = card.querySelector('.chart-content');
    const modeButton = card.querySelector('.mode-tab.active');

    const currentSymbol = select ? select.value : '';
    const currentMode = modeButton ? modeButton.dataset.mode : 'compra';

    if (select) {
      buildSymbolOptions(select, currentSymbol);
    }

    if (select && content) {
      renderChartContent(content, select.value, currentMode);
    }
  }

  updateAddEntryVisibility();
}

function applyMainTab(tabId) {
  for (const button of mainTabButtons) {
    button.classList.toggle('active', button.dataset.mainTab === tabId);
  }

  for (const panel of mainTabPanels) {
    panel.classList.toggle('active', panel.id === tabId);
  }
}

async function refreshActiveAccount({ reloadOnChange = false } = {}) {
  const response = await window.apiBroker.listAccounts();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
  }

  const nextUsername = safeText(response.active_username, '').trim();
  const changed = nextUsername !== activeUsername;
  activeUsername = nextUsername;

  if (activeUsername) {
    setActionsEnabled(true);
    setStatus(`Cuenta activa: ${activeUsername}.`, 'ok');

    if (reloadOnChange && changed) {
      await loadOperations();
    }
    return;
  }

  allOperations = [];
  operationsBySymbol = new Map();
  availableSymbols = [];
  clearCharts();
  updateAddEntryVisibility();
  setActionsEnabled(false);
  setDataSummary('No hay cuenta activa.');
  setStatus('No hay cuenta activa. Usa "Cambiar Cuenta".', 'error');
}

async function loadOperations() {
  if (!activeUsername) {
    setStatus('No hay cuenta activa. Usa "Cambiar Cuenta".', 'error');
    return;
  }

  reloadButton.disabled = true;
  setStatus(`Consultando operaciones (${activeUsername})...`, 'neutral');

  const filters = buildDefaultRequestFilters();
  dataRangeText.textContent = formatRangeText(filters);

  try {
    const response = await window.apiBroker.getOperations(filters);

    if (!Array.isArray(response.operaciones)) {
      allOperations = [];
      operationsBySymbol = new Map();
      availableSymbols = [];
      clearCharts();
      updateAddEntryVisibility();
      setDataSummary('No se pudieron cargar operaciones.');
      setStatus(response.mensaje || 'Error al consultar operaciones.', 'error');
      return;
    }

    allOperations = response.operaciones;
    operationsBySymbol = groupOperationsBySymbol(allOperations);
    availableSymbols = Array.from(operationsBySymbol.keys()).sort((a, b) => a.localeCompare(b));

    setDataSummary(`Operaciones cargadas: ${allOperations.length}. Simbolos detectados: ${availableSymbols.length}.`);
    setStatus(`Datos listos para ${availableSymbols.length} simbolos.`, 'ok');

    if (!chartsGrid.querySelector('.chart-card')) {
      updateAddEntryVisibility();
    } else {
      syncExistingCardsWithNewData();
    }
  } catch (error) {
    allOperations = [];
    operationsBySymbol = new Map();
    availableSymbols = [];
    clearCharts();
    updateAddEntryVisibility();
    setDataSummary('Error al cargar operaciones.');
    setStatus(error.message, 'error');
  } finally {
    reloadButton.disabled = false;
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
  applyMainTab('tab-symbols');
  setActionsEnabled(false);
  setDataSummary('Cargando operaciones...');
  dataRangeText.textContent = '';
  setStatus('Cargando cuenta activa...', 'neutral');

  try {
    await refreshActiveAccount();
    await loadOperations();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

for (const button of mainTabButtons) {
  button.addEventListener('click', () => {
    applyMainTab(button.dataset.mainTab);
  });
}

reloadButton.addEventListener('click', () => {
  loadOperations();
});

changeAccountButton.addEventListener('click', () => {
  openLoginWindow();
});

addChartInitialButton.addEventListener('click', () => {
  createChartCard();
});

window.addEventListener('focus', () => {
  refreshActiveAccount({ reloadOnChange: true }).catch(() => {});
});

initialize();
