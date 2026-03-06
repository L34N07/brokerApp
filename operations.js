const menuButton = document.getElementById('btn-top-menu');
const topMenu = document.getElementById('top-menu');
const reloadButton = document.getElementById('btn-reload-operations');
const autoRefreshToggle = document.getElementById('auto-refresh-enabled');
const autoRefreshIntervalSelect = document.getElementById('auto-refresh-interval');
const autoRefreshLight = document.getElementById('auto-refresh-light');
const autoRefreshLabel = document.getElementById('auto-refresh-label');
const lastRefreshText = document.getElementById('last-refresh-text');

const chartsGrid = document.getElementById('charts-grid');
const gridAddZone = document.getElementById('grid-add-zone');
const addChartInitialButton = document.getElementById('btn-add-chart-initial');

const detailedDateFromInput = document.getElementById('detail-date-from');
const detailedTimeFromInput = document.getElementById('detail-time-from');
const detailedDateToInput = document.getElementById('detail-date-to');
const detailedTimeToInput = document.getElementById('detail-time-to');
const detailedTypeSelect = document.getElementById('detail-type-filter');
const detailedLoadButton = document.getElementById('btn-load-detailed-operations');
const detailedOperationsBody = document.getElementById('detailed-operations-body');
const detailedEmpty = document.getElementById('detailed-empty');

const mainTabButtons = Array.from(document.querySelectorAll('[data-main-tab]'));
const mainTabPanels = Array.from(document.querySelectorAll('[data-main-panel]'));

const AUTO_REFRESH_INTERVALS = new Set([20, 30, 60, 120, 300]);

let activeUsername = '';
let chartIdCounter = 0;

let summaryOperations = [];
let operationsBySymbol = new Map();
let availableSymbols = [];
let isSummaryLoading = false;

let detailedOperations = [];
let detailedFilters = { ...buildDefaultRequestFilters(), tipo: 'todas' };
let detailLoadedOnce = false;
let isDetailedLoading = false;

let autoRefreshEnabled = false;
let autoRefreshSeconds = 60;
let autoRefreshTimerId = null;
let lastSummaryRefreshTime = null;
let toastNode = null;
let toastTimeoutId = null;

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

function isBusinessDay(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function getPreviousBusinessDay(referenceDate = nowLocal()) {
  const cursor = new Date(referenceDate.getTime());
  cursor.setHours(0, 0, 0, 0);

  do {
    cursor.setDate(cursor.getDate() - 1);
  } while (!isBusinessDay(cursor));

  return cursor;
}

function buildDefaultRequestFilters() {
  const now = nowLocal();
  const previousBusinessDay = getPreviousBusinessDay(now);

  return {
    fechaDesde: formatDateISO(previousBusinessDay),
    fechaHasta: formatDateISO(now),
    horaDesde: '00:00:00',
    horaHasta: formatTimeISO(now)
  };
}

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
        max-width: min(460px, calc(100vw - 24px));
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

function formatMaybeNumeric(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return '-';
  }

  const text = String(value).trim();
  if (!/[0-9]/.test(text)) {
    return text;
  }

  const parsed = parseOperationNumber(value);
  const looksNumeric = /[0-9]+(?:[.,][0-9]+)?/.test(text);
  if (!looksNumeric) {
    return text;
  }
  return formatNumber(parsed);
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return null;
}

function buildDateTimeFromParts(dateValue, timeValue) {
  const d = safeText(dateValue, '');
  const t = safeText(timeValue, '00:00:00');
  if (!d) {
    return null;
  }
  const normalizedTime = t.length === 5 ? `${t}:00` : t;
  return new Date(`${d}T${normalizedTime}`);
}

function setDetailedFiltersInputs(filters) {
  detailedDateFromInput.value = safeText(filters.fechaDesde, '');
  detailedDateToInput.value = safeText(filters.fechaHasta, '');
  detailedTimeFromInput.value = safeText(filters.horaDesde, '00:00:00');
  detailedTimeToInput.value = safeText(filters.horaHasta, '00:00:00');
  detailedTypeSelect.value = sanitizeDetailedTypeFilter(filters.tipo);
}

function sanitizeDetailedTypeFilter(value) {
  const normalized = safeText(value, 'todas').toLowerCase();
  if (normalized === 'compra' || normalized === 'venta') {
    return normalized;
  }
  return 'todas';
}

function readDetailedFiltersFromInputs() {
  return {
    fechaDesde: safeText(detailedDateFromInput.value, ''),
    fechaHasta: safeText(detailedDateToInput.value, ''),
    horaDesde: safeText(detailedTimeFromInput.value, '00:00:00'),
    horaHasta: safeText(detailedTimeToInput.value, '00:00:00'),
    tipo: sanitizeDetailedTypeFilter(detailedTypeSelect.value)
  };
}

function validateFilters(filters) {
  if (!filters.fechaDesde || !filters.fechaHasta) {
    throw new Error('Debes completar fecha desde y fecha hasta.');
  }

  const from = buildDateTimeFromParts(filters.fechaDesde, filters.horaDesde);
  const to = buildDateTimeFromParts(filters.fechaHasta, filters.horaHasta);
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Rango de fecha/hora invalido.');
  }
  if (from > to) {
    throw new Error('fechaDesde/horaDesde no puede ser mayor a fechaHasta/horaHasta.');
  }
}

function setMenuOpen(isOpen) {
  topMenu.hidden = !isOpen;
  menuButton.setAttribute('aria-expanded', String(isOpen));
}

function formatRefreshClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toLocaleTimeString('es-AR', { hour12: false });
}

function updateLastRefreshText() {
  lastRefreshText.textContent = `Ult refresh: ${formatRefreshClock(lastSummaryRefreshTime)}`;
}

function updateAutoRefreshPill() {
  const enabled = autoRefreshEnabled && Boolean(activeUsername);
  autoRefreshLight.classList.toggle('on', enabled);
  autoRefreshLight.classList.toggle('off', !enabled);

  if (!enabled) {
    autoRefreshLabel.textContent = 'AR: OFF';
    return;
  }
  autoRefreshLabel.textContent = `AR: ${autoRefreshSeconds}s`;
}

function clearAutoRefreshTimer() {
  if (autoRefreshTimerId !== null) {
    clearInterval(autoRefreshTimerId);
    autoRefreshTimerId = null;
  }
}

function configureAutoRefresh() {
  clearAutoRefreshTimer();
  if (!autoRefreshEnabled || !activeUsername) {
    updateAutoRefreshPill();
    return;
  }

  autoRefreshTimerId = setInterval(() => {
    loadSummaryOperations({ source: 'auto' });
  }, autoRefreshSeconds * 1000);

  updateAutoRefreshPill();
}

function setControlsEnabled(enabled) {
  const hasActiveUser = enabled && Boolean(activeUsername);

  menuButton.disabled = !hasActiveUser;
  reloadButton.disabled = !hasActiveUser || isSummaryLoading;
  autoRefreshToggle.disabled = !hasActiveUser;
  autoRefreshIntervalSelect.disabled = !hasActiveUser;
  detailedTypeSelect.disabled = !hasActiveUser || isDetailedLoading;
  detailedLoadButton.disabled = !hasActiveUser || isDetailedLoading;

  const canAddChart = hasActiveUser && availableSymbols.length > 0;
  addChartInitialButton.disabled = !canAddChart;

  if (!hasActiveUser) {
    autoRefreshEnabled = false;
    autoRefreshToggle.checked = false;
    clearAutoRefreshTimer();
    updateAutoRefreshPill();
  }
}

function clearCharts() {
  const cards = chartsGrid.querySelectorAll('.chart-card');
  for (const card of cards) {
    card.remove();
  }
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

function parseOperationDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsedTimestamp = new Date(value);
    if (!Number.isNaN(parsedTimestamp.getTime())) {
      return parsedTimestamp;
    }
  }

  const raw = safeText(value, '');
  if (!raw) {
    return null;
  }

  const text = raw.trim();
  if (!text) {
    return null;
  }

  const normalizedIso = text.includes(' ') ? text.replace(' ', 'T') : text;
  const parsedIso = new Date(normalizedIso);
  if (!Number.isNaN(parsedIso.getTime())) {
    return parsedIso;
  }

  const ddmmyyyyMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!ddmmyyyyMatch) {
    return null;
  }

  const day = Number(ddmmyyyyMatch[1]);
  const month = Number(ddmmyyyyMatch[2]) - 1;
  const year = Number(ddmmyyyyMatch[3]);
  const hour = Number(ddmmyyyyMatch[4] || '0');
  const minute = Number(ddmmyyyyMatch[5] || '0');
  const second = Number(ddmmyyyyMatch[6] || '0');

  const parsedLocal = new Date(year, month, day, hour, minute, second);
  if (Number.isNaN(parsedLocal.getTime())) {
    return null;
  }
  return parsedLocal;
}

function resolveOperationDateKey(row) {
  const candidateDate = firstDefined(row, ['fechaOperada', 'fechaOrden', 'fecha']);
  const parsed = parseOperationDate(candidateDate);
  if (!parsed) {
    return null;
  }
  return formatDateISO(parsed);
}

function calculateTotalsByStatus(symbol, mode) {
  const rows = operationsBySymbol.get(symbol) || [];
  const now = nowLocal();
  const todayKey = formatDateISO(now);
  const previousBusinessDayKey = formatDateISO(getPreviousBusinessDay(now));

  const totals = {
    hoy: { cantidadOperada: 0, montoOperado: 0 },
    diaPrevio: { cantidadOperada: 0, montoOperado: 0 },
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

    const operationDateKey = resolveOperationDateKey(row);
    if (operationDateKey === todayKey) {
      totals.hoy.cantidadOperada += parseOperationNumber(row.cantidadOperada);
      totals.hoy.montoOperado += parseOperationNumber(row.montoOperado);
      continue;
    }

    if (operationDateKey === previousBusinessDayKey) {
      totals.diaPrevio.cantidadOperada += parseOperationNumber(row.cantidadOperada);
      totals.diaPrevio.montoOperado += parseOperationNumber(row.montoOperado);
    }
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

function buildSummaryTable(headers, rows) {
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
  for (const rowValues of rows) {
    tbody.appendChild(buildValueRow(rowValues));
  }
  table.appendChild(tbody);

  return table;
}

function renderChartContent(container, symbol, mode) {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const totals = calculateTotalsByStatus(symbol, mode);
  const todayPpcOrPpv =
    totals.hoy.cantidadOperada !== 0
      ? totals.hoy.montoOperado / totals.hoy.cantidadOperada
      : 0;
  const previousPpcOrPpv =
    totals.diaPrevio.cantidadOperada !== 0
      ? totals.diaPrevio.montoOperado / totals.diaPrevio.cantidadOperada
      : 0;
  const pendingPrecioPromedio =
    totals.pendientes.precioCount > 0 ? totals.pendientes.precioSum / totals.pendientes.precioCount : 0;
  const priceLabel = mode === 'compra' ? 'PPC' : 'PPV';

  const groups = document.createElement('div');
  groups.className = 'summary-groups';

  const compactSummaryTable = buildSummaryTable(
    ['Periodo', 'Cant', 'Monto', priceLabel],
    [
      [
        'Hoy',
        formatNumber(totals.hoy.cantidadOperada),
        formatNumber(totals.hoy.montoOperado),
        formatNumber(todayPpcOrPpv)
      ],
      [
        'Dia Previo',
        formatNumber(totals.diaPrevio.cantidadOperada),
        formatNumber(totals.diaPrevio.montoOperado),
        formatNumber(previousPpcOrPpv)
      ],
      [
        'Pendientes',
        formatNumber(totals.pendientes.cantidad),
        formatNumber(totals.pendientes.monto),
        formatNumber(pendingPrecioPromedio)
      ]
    ]
  );

  groups.appendChild(compactSummaryTable);
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
  setControlsEnabled(Boolean(activeUsername));
}

function syncExistingCardsWithNewData() {
  const cards = Array.from(chartsGrid.querySelectorAll('.chart-card'));
  if (cards.length === 0) {
    setControlsEnabled(Boolean(activeUsername));
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

  setControlsEnabled(Boolean(activeUsername));
}

function resetSummaryData() {
  summaryOperations = [];
  operationsBySymbol = new Map();
  availableSymbols = [];
  clearCharts();
}

function appendDetailedCell(row, value) {
  const td = document.createElement('td');
  td.textContent = safeText(value);
  row.appendChild(td);
}

function filterDetailedOperationsByType(operations, typeFilter) {
  const selectedType = sanitizeDetailedTypeFilter(typeFilter);
  if (selectedType === 'todas') {
    return operations.slice();
  }

  return operations.filter((operation) => {
    const normalizedType = operation.tipoFiltro || normalizeOperationType(operation.tipo);
    return normalizedType === selectedType;
  });
}

function renderDetailedOperationsTable(operations) {
  while (detailedOperationsBody.firstChild) {
    detailedOperationsBody.removeChild(detailedOperationsBody.firstChild);
  }

  for (const operation of operations) {
    const row = document.createElement('tr');

    appendDetailedCell(row, firstDefined(operation, ['fechaOrden', 'fecha']));
    appendDetailedCell(row, operation.tipo);
    appendDetailedCell(row, operation.estado);
    appendDetailedCell(row, operation.mercado);
    appendDetailedCell(row, operation.simbolo);
    appendDetailedCell(row, formatMaybeNumeric(operation.cantidad));
    appendDetailedCell(row, formatMaybeNumeric(operation.monto));
    appendDetailedCell(row, formatMaybeNumeric(operation.precio));
    appendDetailedCell(row, formatMaybeNumeric(operation.cantidadOperada));
    appendDetailedCell(row, formatMaybeNumeric(firstDefined(operation, ['precioOperado', 'precioPromedio'])));
    appendDetailedCell(row, formatMaybeNumeric(operation.montoOperado));

    detailedOperationsBody.appendChild(row);
  }

  detailedEmpty.hidden = operations.length > 0;
  if (operations.length === 0) {
    detailedEmpty.textContent = 'No hay operaciones para el rango seleccionado.';
  }
}

function resetDetailedData(message = 'Aun no hay datos cargados para este filtro.') {
  detailedOperations = [];
  detailLoadedOnce = false;
  while (detailedOperationsBody.firstChild) {
    detailedOperationsBody.removeChild(detailedOperationsBody.firstChild);
  }
  detailedEmpty.hidden = false;
  detailedEmpty.textContent = message;
}

function renderDetailedOperationsFromCurrentState() {
  const filteredOperations = filterDetailedOperationsByType(detailedOperations, detailedFilters.tipo);
  renderDetailedOperationsTable(filteredOperations);
  return filteredOperations.length;
}

async function loadDetailedOperations() {
  if (!activeUsername || isDetailedLoading) {
    return;
  }

  try {
    const nextFilters = readDetailedFiltersFromInputs();
    validateFilters(nextFilters);
    detailedFilters = nextFilters;
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  isDetailedLoading = true;
  setControlsEnabled(true);
  setStatus(`Consultando operaciones detalladas (${activeUsername})...`, 'neutral');

  try {
    const response = await window.apiBroker.getOperations(detailedFilters);

    if (!Array.isArray(response.operaciones)) {
      resetDetailedData('No se pudieron cargar operaciones detalladas.');
      setStatus(response.mensaje || 'Error al consultar operaciones detalladas.', 'error');
      return;
    }

    detailedOperations = response.operaciones;
    detailLoadedOnce = true;
    const visibleCount = renderDetailedOperationsFromCurrentState();
    const selectedType = sanitizeDetailedTypeFilter(detailedFilters.tipo);
    const typeDetail = selectedType === 'todas' ? 'todas' : selectedType;
    setStatus(`Operaciones detalladas cargadas: ${visibleCount} (tipo: ${typeDetail}).`, 'ok');
  } catch (error) {
    resetDetailedData('Error al cargar operaciones detalladas.');
    setStatus(error.message, 'error');
  } finally {
    isDetailedLoading = false;
    setControlsEnabled(true);
  }
}

async function loadSummaryOperations({ source = 'manual' } = {}) {
  if (!activeUsername || isSummaryLoading) {
    return;
  }

  isSummaryLoading = true;
  setControlsEnabled(true);

  if (source !== 'auto') {
    setStatus(`Consultando resumen por simbolo (${activeUsername})...`, 'neutral');
  }

  const filters = buildDefaultRequestFilters();

  try {
    const response = await window.apiBroker.getOperations(filters);

    if (!Array.isArray(response.operaciones)) {
      resetSummaryData();
      setControlsEnabled(true);
      setStatus(response.mensaje || 'Error al consultar operaciones.', 'error');
      return;
    }

    summaryOperations = response.operaciones;
    operationsBySymbol = groupOperationsBySymbol(summaryOperations);
    availableSymbols = Array.from(operationsBySymbol.keys()).sort((a, b) => a.localeCompare(b));
    lastSummaryRefreshTime = nowLocal();
    updateLastRefreshText();

    if (!chartsGrid.querySelector('.chart-card')) {
      setControlsEnabled(true);
    } else {
      syncExistingCardsWithNewData();
    }

    if (source !== 'auto') {
      setStatus(`Resumen actualizado. Operaciones: ${summaryOperations.length}. Simbolos: ${availableSymbols.length}.`, 'ok');
    }
  } catch (error) {
    resetSummaryData();
    setControlsEnabled(true);
    setStatus(error.message, 'error');
  } finally {
    isSummaryLoading = false;
    setControlsEnabled(true);
  }
}

function applyMainTab(tabId) {
  for (const button of mainTabButtons) {
    button.classList.toggle('active', button.dataset.mainTab === tabId);
  }

  for (const panel of mainTabPanels) {
    panel.classList.toggle('active', panel.id === tabId);
  }

  if (tabId === 'tab-all-operations' && activeUsername && !detailLoadedOnce) {
    loadDetailedOperations();
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
    setControlsEnabled(true);

    if (changed) {
      resetSummaryData();
      resetDetailedData('Aun no hay datos cargados para este filtro.');
      setDetailedFiltersInputs(detailedFilters);
    }

    if (reloadOnChange && changed) {
      await loadSummaryOperations({ source: 'manual' });
    } else if (!summaryOperations.length && !isSummaryLoading) {
      await loadSummaryOperations({ source: 'manual' });
    } else if (changed) {
      setStatus(`Cuenta activa: ${activeUsername}.`, 'ok');
    }

    configureAutoRefresh();
    return;
  }

  resetSummaryData();
  resetDetailedData('No hay cuenta activa.');
  lastSummaryRefreshTime = null;
  updateLastRefreshText();
  setControlsEnabled(false);
  setStatus('No hay cuenta activa.', 'error');
}

function handleAutoRefreshToggleChange() {
  autoRefreshEnabled = autoRefreshToggle.checked;
  configureAutoRefresh();

  if (autoRefreshEnabled && activeUsername) {
    setStatus(`Auto refresh activado (${autoRefreshSeconds}s).`, 'ok');
    loadSummaryOperations({ source: 'manual' });
  } else {
    setStatus('Auto refresh desactivado.', 'neutral');
  }
}

function handleAutoRefreshIntervalChange() {
  const value = Number(autoRefreshIntervalSelect.value);
  if (!AUTO_REFRESH_INTERVALS.has(value)) {
    autoRefreshIntervalSelect.value = String(autoRefreshSeconds);
    return;
  }

  autoRefreshSeconds = value;
  configureAutoRefresh();
  if (autoRefreshEnabled && activeUsername) {
    setStatus(`Intervalo de auto refresh: ${autoRefreshSeconds}s.`, 'neutral');
  }
}

function handleDetailedTypeFilterChange() {
  detailedFilters.tipo = sanitizeDetailedTypeFilter(detailedTypeSelect.value);
  detailedTypeSelect.value = detailedFilters.tipo;

  if (!detailLoadedOnce) {
    return;
  }

  const visibleCount = renderDetailedOperationsFromCurrentState();
  setStatus(`Filtro de tipo aplicado: ${detailedFilters.tipo}. Operaciones: ${visibleCount}.`, 'neutral');
}

function handleMenuClickOutside(event) {
  if (topMenu.hidden) {
    return;
  }

  const target = event.target;
  if (topMenu.contains(target) || menuButton.contains(target)) {
    return;
  }

  setMenuOpen(false);
}

async function initialize() {
  detailedFilters = { ...buildDefaultRequestFilters(), tipo: 'todas' };
  setDetailedFiltersInputs(detailedFilters);
  applyMainTab('tab-symbols');
  setControlsEnabled(false);
  updateAutoRefreshPill();
  updateLastRefreshText();

  try {
    await refreshActiveAccount();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

menuButton.addEventListener('click', () => {
  setMenuOpen(topMenu.hidden);
});

reloadButton.addEventListener('click', () => {
  setMenuOpen(false);
  loadSummaryOperations({ source: 'manual' });
});

autoRefreshToggle.addEventListener('change', () => {
  handleAutoRefreshToggleChange();
});

autoRefreshIntervalSelect.addEventListener('change', () => {
  handleAutoRefreshIntervalChange();
});

detailedLoadButton.addEventListener('click', () => {
  loadDetailedOperations();
});

detailedTypeSelect.addEventListener('change', () => {
  handleDetailedTypeFilterChange();
});

addChartInitialButton.addEventListener('click', () => {
  createChartCard();
});

for (const button of mainTabButtons) {
  button.addEventListener('click', () => {
    applyMainTab(button.dataset.mainTab);
  });
}

window.addEventListener('focus', () => {
  refreshActiveAccount({ reloadOnChange: true }).catch(() => {});
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setMenuOpen(false);
  }
});

document.addEventListener('mousedown', handleMenuClickOutside);

initialize();
