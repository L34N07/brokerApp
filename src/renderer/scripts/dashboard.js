const dashboardShell = document.getElementById('dashboard-shell');
const dashboardCanvas = document.getElementById('dashboard-canvas');
const dashboardPanel = document.getElementById('dashboard-panel');
const dashboardEmpty = document.getElementById('dashboard-empty');
const panelToggleButton = document.getElementById('btn-toggle-dashboard-panel');
const layoutNameInput = document.getElementById('dashboard-layout-name');
const saveLayoutButton = document.getElementById('btn-save-dashboard-layout');
const loadLayoutButton = document.getElementById('btn-load-dashboard-layout');
const paletteItems = Array.from(document.querySelectorAll('[data-dashboard-object-type]'));

const SUMMARY_REFRESH_INTERVALS = [20, 30, 60, 120, 300];
const FLAGS_REFRESH_INTERVALS = [10, 20, 30, 60, 120, 300];
const FLAGS_DEPTH_LEVEL_LIMIT = 6;
const TRADINGVIEW_WIDGET_SCRIPT_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
const DEFAULT_TRADINGVIEW_SYMBOL = 'NASDAQ:AAPL';
const DASHBOARD_OBJECT_TYPES = {
  summary: {
    label: 'Resumen operaciones',
    width: 340,
    height: 240,
    minWidth: 280,
    minHeight: 170
  },
  tradingview: {
    label: 'TradingView',
    width: 540,
    height: 330,
    minWidth: 360,
    minHeight: 230
  },
  flags: {
    label: 'Puntas compra/venta',
    width: 360,
    height: 250,
    minWidth: 300,
    minHeight: 180
  }
};

let activeUsername = '';
let dashboardItems = [];
let dashboardItemIdCounter = 0;
let dashboardLayerCounter = 1;
let lastSummaryRefreshInterval = 60;
let lastFlagsRefreshInterval = 60;
let summaryOperations = [];
let operationsBySymbol = new Map();
let availableOperationSymbols = [];
let lastOperationsRefreshAt = null;
let pointerAction = null;
let draggedPaletteType = '';
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

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
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

function formatRefreshClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toLocaleTimeString('es-AR', { hour12: false });
}

function formatNumber(value) {
  const rounded = Number((value || 0).toFixed(2));
  if (Number.isInteger(rounded)) {
    return integerNumberFormatter.format(rounded);
  }
  return decimalNumberFormatter.format(rounded);
}

function formatOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return '-';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '-';
  }
  return formatNumber(number);
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getRefreshIntervalsForType(type) {
  if (type === 'flags') {
    return FLAGS_REFRESH_INTERVALS;
  }
  return SUMMARY_REFRESH_INTERVALS;
}

function getDefaultRefreshIntervalForType(type) {
  if (type === 'summary') {
    return lastSummaryRefreshInterval;
  }
  if (type === 'flags') {
    return lastFlagsRefreshInterval;
  }
  return null;
}

function ensureToastNode() {
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
  }, 2200);
}

function setPaletteEnabled(enabled) {
  const canUsePalette = Boolean(enabled && activeUsername);
  for (const item of paletteItems) {
    item.disabled = !canUsePalette;
  }
}

function syncEmptyState() {
  dashboardEmpty.hidden = dashboardItems.length > 0;
}

function groupOperationsBySymbol(operations) {
  const groups = new Map();

  for (const operation of operations) {
    const symbol = safeText(operation?.simbolo, '').toUpperCase();
    if (!symbol) {
      continue;
    }
    if (!groups.has(symbol)) {
      groups.set(symbol, []);
    }
    groups.get(symbol).push(operation);
  }

  return groups;
}

function syncSummaryOperationsData(operations, refreshedAt) {
  summaryOperations = operations;
  operationsBySymbol = groupOperationsBySymbol(summaryOperations);
  availableOperationSymbols = Array.from(operationsBySymbol.keys()).sort((a, b) => a.localeCompare(b));
  lastOperationsRefreshAt = refreshedAt;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = safeText(value, '');
    if (text) {
      return text;
    }
  }
  return '';
}

function normalizeStockMarket(value) {
  if (value && typeof value === 'object') {
    return firstNonEmpty([value.codigo, value.code, value.nombre, value.name, value.descripcion]);
  }
  return safeText(value, '');
}

function buildStockOptionKey(symbol, market) {
  return `${safeText(market, '').toLowerCase()}::${safeText(symbol, '').toUpperCase()}`;
}

function addStockOption(optionMap, candidate) {
  const symbol = safeText(candidate.symbol, '').toUpperCase();
  if (!symbol) {
    return;
  }

  const market = normalizeStockMarket(candidate.market);
  const key = buildStockOptionKey(symbol, market);
  const existing = optionMap.get(key);
  if (existing) {
    if (!existing.sources.includes(candidate.source)) {
      existing.sources.push(candidate.source);
    }
    if (!existing.sourceLabels.includes(candidate.sourceLabel)) {
      existing.sourceLabels.push(candidate.sourceLabel);
    }
    if (!existing.market && market) {
      existing.market = market;
    }
    return;
  }

  optionMap.set(key, {
    key,
    symbol,
    market,
    label: candidate.label || symbol,
    sources: [candidate.source],
    sourceLabels: [candidate.sourceLabel],
  });
}

function buildPortfolioStockOptions(portfolio) {
  const options = new Map();
  const activos = Array.isArray(portfolio?.activos) ? portfolio.activos : [];

  for (const activo of activos) {
    const titulo = activo?.titulo || {};
    const symbol = firstNonEmpty([titulo.simbolo, activo?.simbolo]);
    const market = firstNonEmpty([titulo.mercado, activo?.mercado, titulo.mercadoCodigo, activo?.mercadoCodigo]);
    const label = firstNonEmpty([titulo.descripcion, titulo.descripcionTitulo, titulo.nombre, symbol]);
    addStockOption(options, {
      symbol,
      market,
      label,
      source: 'portfolio',
      sourceLabel: 'Portfolio',
    });
  }

  return Array.from(options.values());
}

function buildRecentOperationStockOptions(operations) {
  const options = new Map();
  for (const operation of operations || []) {
    const symbol = safeText(operation?.simbolo, '').toUpperCase();
    const market = firstNonEmpty([operation?.mercado, operation?.mercadoCodigo]);
    addStockOption(options, {
      symbol,
      market,
      label: symbol,
      source: 'operations',
      sourceLabel: 'Operaciones',
    });
  }
  return Array.from(options.values());
}

function mergeStockOptions(optionGroups) {
  const merged = new Map();
  for (const group of optionGroups) {
    for (const option of group) {
      addStockOption(merged, {
        symbol: option.symbol,
        market: option.market,
        label: option.label,
        source: option.sources[0],
        sourceLabel: option.sourceLabels[0],
      });
      const stored = merged.get(option.key);
      if (!stored) {
        continue;
      }
      for (let index = 1; index < option.sources.length; index += 1) {
        if (!stored.sources.includes(option.sources[index])) {
          stored.sources.push(option.sources[index]);
        }
        if (!stored.sourceLabels.includes(option.sourceLabels[index])) {
          stored.sourceLabels.push(option.sourceLabels[index]);
        }
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    const symbolCompare = a.symbol.localeCompare(b.symbol);
    if (symbolCompare !== 0) {
      return symbolCompare;
    }
    return safeText(a.market, '').localeCompare(safeText(b.market, ''));
  });
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
  if (normalized.includes('pend') || normalized.includes('proceso') || normalized.includes('iniciad')) {
    return 'pendientes';
  }
  return 'otras';
}

function firstDefined(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
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

function resolveChartStatusGroup(row) {
  const normalizedStatus = row.estadoFiltro || normalizeOperationStatus(row.estado);
  if (normalizedStatus === 'terminadas') {
    return 'terminadas';
  }
  if (normalizedStatus === 'pendientes') {
    return 'pendientes';
  }

  const rawStatus = safeText(row.estado, '').toLowerCase();
  if (rawStatus.includes('proceso') || rawStatus.includes('iniciad')) {
    return 'pendientes';
  }
  return null;
}

function resolveOperationAmount(value, quantity = 0, price = 0) {
  const amount = parseOperationNumber(value);
  if (amount !== 0) {
    return amount;
  }
  if (quantity > 0 && price > 0) {
    return quantity * price;
  }
  return 0;
}

function resolveOperationQuantity(value, amount = 0, price = 0) {
  const quantity = parseOperationNumber(value);
  if (quantity !== 0) {
    return quantity;
  }
  if (amount > 0 && price > 0) {
    return amount / price;
  }
  return 0;
}

function splitPendingOperation(row) {
  const orderPrice = Math.max(parseOperationNumber(row.precio), 0);
  const totalAmountSeed = Math.max(parseOperationNumber(row.monto), 0);
  const totalQuantity = Math.max(resolveOperationQuantity(row.cantidad, totalAmountSeed, orderPrice), 0);
  const totalAmount = Math.max(resolveOperationAmount(row.monto, totalQuantity, orderPrice), 0);

  const operatedPrice = Math.max(parseOperationNumber(firstDefined(row, ['precioOperado', 'precioPromedio'])), 0);
  const operatedAmountSeed = Math.max(parseOperationNumber(row.montoOperado), 0);
  const operatedQuantityRaw = Math.max(
    resolveOperationQuantity(row.cantidadOperada, operatedAmountSeed, operatedPrice),
    0
  );
  const operatedAmountRaw = Math.max(resolveOperationAmount(row.montoOperado, operatedQuantityRaw, operatedPrice), 0);

  const operatedQuantity = totalQuantity > 0 ? Math.min(operatedQuantityRaw, totalQuantity) : operatedQuantityRaw;
  const operatedAmount = totalAmount > 0 ? Math.min(operatedAmountRaw, totalAmount) : operatedAmountRaw;
  const remainingQuantity = Math.max(totalQuantity - operatedQuantity, 0);
  const remainingAmount = Math.max(totalAmount - operatedAmount, 0);

  return {
    orderPrice,
    operatedAmount,
    operatedQuantity,
    remainingAmount,
    remainingQuantity
  };
}

function buildPendingOperationSummary(row, pendingSplit) {
  return {
    fecha: safeText(firstDefined(row, ['fechaOrden', 'fecha', 'fechaOperada'])),
    estado: safeText(row.estado),
    mercado: safeText(row.mercado),
    cantidadPendiente: pendingSplit.remainingQuantity,
    montoPendiente: pendingSplit.remainingAmount,
    precio: pendingSplit.orderPrice,
    cantidadOperada: pendingSplit.operatedQuantity,
    montoOperado: pendingSplit.operatedAmount
  };
}

function calculateTotalsByStatus(operations, mode) {
  const now = nowLocal();
  const todayKey = formatDateISO(now);
  const previousBusinessDayKey = formatDateISO(getPreviousBusinessDay(now));

  const totals = {
    hoy: { cantidadOperada: 0, montoOperado: 0 },
    diaPrevio: { cantidadOperada: 0, montoOperado: 0 },
    pendientes: { cantidad: 0, monto: 0, operaciones: [] }
  };

  for (const row of operations) {
    const type = row.tipoFiltro || normalizeOperationType(row.tipo);
    if (type !== mode) {
      continue;
    }

    const statusGroup = resolveChartStatusGroup(row);
    if (!statusGroup) {
      continue;
    }

    if (statusGroup === 'pendientes') {
      const pendingSplit = splitPendingOperation(row);
      const operationDateKey = resolveOperationDateKey(row);

      if (pendingSplit.operatedQuantity > 0 || pendingSplit.operatedAmount > 0) {
        if (operationDateKey === todayKey) {
          totals.hoy.cantidadOperada += pendingSplit.operatedQuantity;
          totals.hoy.montoOperado += pendingSplit.operatedAmount;
        } else if (operationDateKey === previousBusinessDayKey) {
          totals.diaPrevio.cantidadOperada += pendingSplit.operatedQuantity;
          totals.diaPrevio.montoOperado += pendingSplit.operatedAmount;
        }
      }

      totals.pendientes.cantidad += pendingSplit.remainingQuantity;
      totals.pendientes.monto += pendingSplit.remainingAmount;

      if (pendingSplit.remainingQuantity > 0 || pendingSplit.remainingAmount > 0) {
        totals.pendientes.operaciones.push(buildPendingOperationSummary(row, pendingSplit));
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
  for (const rowConfig of rows) {
    const values = Array.isArray(rowConfig) ? rowConfig : rowConfig.values;
    const row = buildValueRow(values);
    const isExpandable = !Array.isArray(rowConfig) && rowConfig.expandable;

    if (isExpandable) {
      row.classList.add('summary-row-expandable');
      const labelCell = row.firstElementChild;
      if (labelCell) {
        clearNode(labelCell);

        const button = document.createElement('button');
        button.className = 'summary-row-toggle';
        button.type = 'button';
        button.setAttribute('aria-expanded', String(Boolean(rowConfig.expanded)));
        if (rowConfig.detailId) {
          button.setAttribute('aria-controls', rowConfig.detailId);
        }

        const label = document.createElement('span');
        label.className = 'summary-row-toggle-label';
        label.textContent = values[0];
        button.appendChild(label);

        if (rowConfig.toggleMeta) {
          const meta = document.createElement('span');
          meta.className = 'summary-row-toggle-meta';
          meta.textContent = rowConfig.toggleMeta;
          button.appendChild(meta);
        }

        const icon = document.createElement('span');
        icon.className = 'summary-row-toggle-icon';
        icon.textContent = rowConfig.expanded ? '-' : '+';
        button.appendChild(icon);

        button.addEventListener('click', rowConfig.onToggle);
        labelCell.appendChild(button);
      }
    }

    tbody.appendChild(row);

    if (isExpandable && rowConfig.expanded && rowConfig.detailNode) {
      const detailRow = document.createElement('tr');
      detailRow.className = 'summary-detail-row';

      const detailCell = document.createElement('td');
      detailCell.colSpan = headers.length;
      detailCell.className = 'summary-detail-cell';
      if (rowConfig.detailId) {
        detailCell.id = rowConfig.detailId;
      }
      detailCell.appendChild(rowConfig.detailNode);
      detailRow.appendChild(detailCell);

      tbody.appendChild(detailRow);
    }
  }
  table.appendChild(tbody);

  return table;
}

function buildPendingOperationsSummary(operations, summary = {}, priceLabel = 'PPC') {
  if (!Array.isArray(operations) || operations.length === 0) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pending-operations-list';
    const empty = document.createElement('p');
    empty.className = 'pending-operations-empty';
    empty.textContent = 'No hay operaciones pendientes para mostrar.';
    wrapper.appendChild(empty);
    return wrapper;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'pending-operations-list';

  const pendingSummaryTable = buildSummaryTable(
    ['Cant', 'Monto', priceLabel],
    [[formatNumber(summary.cantidadTotal), formatNumber(summary.montoTotal), formatNumber(summary.precioPromedio)]]
  );
  pendingSummaryTable.classList.add('pending-total-table');

  const pendingRows = operations.map((operation, index) => [
    String(index + 1),
    formatNumber(operation.cantidadOperada),
    formatNumber(operation.cantidadPendiente),
    formatNumber(operation.montoPendiente),
    formatNumber(operation.precio)
  ]);

  const pendingTable = buildSummaryTable(['Op', 'Operadas', 'Cantidad', 'Monto', 'Precio'], pendingRows);
  pendingTable.classList.add('pending-operations-table');

  wrapper.appendChild(pendingSummaryTable);
  wrapper.appendChild(pendingTable);

  return wrapper;
}

function createStateNode(message, tone = 'neutral') {
  const node = document.createElement('p');
  node.className = tone === 'error' ? 'dashboard-state error' : 'dashboard-state';
  node.textContent = message;
  return node;
}

function getItemById(itemId) {
  return dashboardItems.find((item) => item.id === itemId) || null;
}

function getCanvasRect() {
  return dashboardCanvas.getBoundingClientRect();
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function constrainItemToCanvas(item) {
  const rect = getCanvasRect();
  const typeConfig = DASHBOARD_OBJECT_TYPES[item.type];
  const minWidth = typeConfig?.minWidth || 260;
  const minHeight = typeConfig?.minHeight || 180;
  const maxWidth = Math.max(rect.width, minWidth);
  const maxHeight = Math.max(rect.height, minHeight);

  item.width = clamp(item.width, minWidth, maxWidth);
  item.height = clamp(item.height, minHeight, maxHeight);
  item.x = clamp(item.x, 0, Math.max(rect.width - item.width, 0));
  item.y = clamp(item.y, 0, Math.max(rect.height - item.height, 0));
}

function updateItemFrame(item) {
  const element = dashboardCanvas.querySelector(`[data-dashboard-item-id="${item.id}"]`);
  if (!element) {
    return;
  }

  element.style.left = `${item.x}px`;
  element.style.top = `${item.y}px`;
  element.style.width = `${item.width}px`;
  element.style.height = `${item.height}px`;
  element.style.zIndex = String(item.zIndex || 1);
}

function bringDashboardItemToFront(itemId) {
  const item = getItemById(itemId);
  if (!item) {
    return;
  }
  dashboardLayerCounter += 1;
  item.zIndex = dashboardLayerCounter;
  updateItemFrame(item);
}

function createDashboardObjectElement(item) {
  const element = document.createElement('article');
  element.className = `dashboard-object dashboard-object-${item.type}`;
  element.dataset.dashboardItemId = item.id;
  element.addEventListener('pointerenter', () => {
    bringDashboardItemToFront(item.id);
  });
  element.addEventListener('focusin', () => {
    bringDashboardItemToFront(item.id);
  });

  const inner = document.createElement('div');
  inner.className = 'dashboard-object-inner';
  inner.dataset.dashboardObjectInner = 'true';
  element.appendChild(inner);

  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('button');
    handle.className = 'dashboard-resize-handle';
    handle.type = 'button';
    handle.dataset.corner = corner;
    handle.setAttribute('aria-label', 'Redimensionar objeto');
    handle.title = 'Redimensionar';
    element.appendChild(handle);
  }

  dashboardCanvas.appendChild(element);
  return element;
}

function ensureDashboardObjectElement(item) {
  const existing = dashboardCanvas.querySelector(`[data-dashboard-item-id="${item.id}"]`);
  return existing || createDashboardObjectElement(item);
}

function isRefreshableItem(item) {
  return item.type === 'summary' || item.type === 'flags';
}

function itemHasRefreshTarget(item) {
  if (item.type === 'summary') {
    return Boolean(item.selectedSymbol);
  }
  if (item.type === 'flags') {
    return Boolean(item.selectedStock && item.selectedStock.market);
  }
  return false;
}

function isItemRefreshActive(item) {
  return Boolean(activeUsername && isRefreshableItem(item) && itemHasRefreshTarget(item) && !item.refreshPaused);
}

function createHeaderTitleControl(item, fallbackText) {
  if (item.type === 'summary') {
    const select = document.createElement('select');
    select.className = 'dashboard-header-select';
    select.setAttribute('aria-label', 'Seleccionar símbolo');
    select.appendChild(createSelectOption('', 'Símbolo'));
    for (const symbol of availableOperationSymbols) {
      select.appendChild(createSelectOption(symbol, symbol));
    }
    select.value = item.selectedSymbol || '';
    select.disabled = !activeUsername || item.loading || availableOperationSymbols.length === 0;
    select.addEventListener('change', () => {
      handleSummarySymbolChange(item.id, select.value);
    });
    return select;
  }

  if (item.type === 'flags') {
    const select = document.createElement('select');
    select.className = 'dashboard-header-select';
    select.setAttribute('aria-label', 'Seleccionar acción');
    select.appendChild(createSelectOption('', item.sourcesLoading ? 'Cargando...' : 'Acción'));
    for (const option of item.stockOptions || []) {
      const optionLabel = [
        option.symbol,
        option.market || 'sin mercado',
        option.sourceLabels.join(' + ')
      ].join(' · ');
      select.appendChild(createSelectOption(option.key, optionLabel));
    }
    select.value = item.selectedStockKey || '';
    select.disabled = !activeUsername || item.sourcesLoading || item.loading || item.stockOptions.length === 0;
    select.addEventListener('change', () => {
      handleFlagsStockChange(item.id, select.value);
    });
    return select;
  }

  const symbolText = document.createElement('span');
  symbolText.className = 'dashboard-object-symbol';
  symbolText.textContent = fallbackText || DASHBOARD_OBJECT_TYPES[item.type]?.label || 'Objeto';
  return symbolText;
}

function handleRefreshToggle(itemId) {
  const item = getItemById(itemId);
  if (!item || !isRefreshableItem(item)) {
    return;
  }

  item.refreshPaused = !item.refreshPaused;
  if (item.refreshPaused) {
    clearSummaryTimer(item);
  } else if (item.type === 'summary') {
    configureSummaryTimer(item);
    if (item.selectedSymbol) {
      loadSummaryItem(item.id, { source: 'manual' });
    }
  } else {
    configureFlagsTimer(item);
    if (item.selectedStock) {
      loadFlagsForItem(item.id, { source: 'manual' });
    }
  }

  renderDashboardItem(item);
}

function createObjectHeader(item, _kindLabel, options = {}) {
  const header = document.createElement('div');
  header.className = 'dashboard-object-head';

  const moveButton = document.createElement('button');
  moveButton.className = 'dashboard-move-handle';
  moveButton.type = 'button';
  moveButton.setAttribute('aria-label', 'Mover objeto');
  moveButton.title = 'Mover';

  const title = document.createElement('div');
  title.className = 'dashboard-object-title';
  title.appendChild(createHeaderTitleControl(item, options.titleText || item.selectedSymbol));

  header.appendChild(moveButton);
  header.appendChild(title);

  if (options.showRefreshControls && isRefreshableItem(item)) {
    const isActive = isItemRefreshActive(item);
    const refreshToggle = document.createElement('button');
    refreshToggle.className = `dashboard-refresh-toggle ${isActive ? 'active' : 'paused'}`;
    refreshToggle.type = 'button';
    refreshToggle.setAttribute('aria-label', isActive ? 'Detener refresco' : 'Activar refresco');
    refreshToggle.setAttribute('aria-pressed', String(isActive));
    refreshToggle.title = isActive ? 'Detener refresco' : 'Activar refresco';
    refreshToggle.addEventListener('click', () => {
      handleRefreshToggle(item.id);
    });
    header.appendChild(refreshToggle);
  }

  if (options.showLastUpdated) {
    const lastUpdated = document.createElement('span');
    lastUpdated.className = 'dashboard-object-meta';
    lastUpdated.textContent = item.lastUpdatedAt ? formatRefreshClock(item.lastUpdatedAt) : '--:--:--';
    header.appendChild(lastUpdated);
  }

  if (options.showInterval) {
    const intervalSelect = document.createElement('select');
    intervalSelect.className = 'dashboard-interval-select';
    intervalSelect.setAttribute('aria-label', 'Intervalo de refresco');

    for (const seconds of getRefreshIntervalsForType(item.type)) {
      const option = document.createElement('option');
      option.value = String(seconds);
      option.textContent = `${seconds}s`;
      intervalSelect.appendChild(option);
    }
    intervalSelect.value = String(item.refreshIntervalSec);
    intervalSelect.addEventListener('change', () => {
      handleRefreshIntervalChange(item.id, Number(intervalSelect.value));
    });
    header.appendChild(intervalSelect);
  }

  const closeButton = document.createElement('button');
  closeButton.className = 'dashboard-close-btn';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Quitar objeto');
  closeButton.title = 'Quitar';
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => {
    removeDashboardItem(item.id);
  });
  header.appendChild(closeButton);

  return header;
}

function createSelectOption(value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

function createModeTabs(item) {
  const modeTabs = document.createElement('div');
  modeTabs.className = 'mode-tabs';

  for (const mode of ['compra', 'venta']) {
    const button = document.createElement('button');
    button.className = `mode-tab ${item.mode === mode ? 'active' : ''}`.trim();
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = mode === 'compra' ? 'Compra' : 'Venta';
    button.addEventListener('click', () => {
      item.mode = mode;
      item.pendingExpanded = false;
      renderDashboardItem(item);
    });
    modeTabs.appendChild(button);
  }

  return modeTabs;
}

function renderOperationSummaryContent(container, item) {
  const totals = calculateTotalsByStatus(item.operations, item.mode);
  const todayPpcOrPpv =
    totals.hoy.cantidadOperada !== 0
      ? totals.hoy.montoOperado / totals.hoy.cantidadOperada
      : 0;
  const previousPpcOrPpv =
    totals.diaPrevio.cantidadOperada !== 0
      ? totals.diaPrevio.montoOperado / totals.diaPrevio.cantidadOperada
      : 0;
  const pendingPrecioPromedio =
    totals.pendientes.cantidad !== 0 ? totals.pendientes.monto / totals.pendientes.cantidad : 0;
  const pendingOperations = totals.pendientes.operaciones;
  const priceLabel = item.mode === 'compra' ? 'PPC' : 'PPV';
  const pendingDetailId = `dashboard-summary-pending-${item.id}-${item.mode}`;

  const groups = document.createElement('div');
  groups.className = 'summary-groups';

  const compactSummaryTable = buildSummaryTable(
    ['Periodo', 'Cant', 'Monto', priceLabel],
    [
      {
        values: [
          'Hoy',
          formatNumber(totals.hoy.cantidadOperada),
          formatNumber(totals.hoy.montoOperado),
          formatNumber(todayPpcOrPpv)
        ]
      },
      {
        values: [
          'Dia Previo',
          formatNumber(totals.diaPrevio.cantidadOperada),
          formatNumber(totals.diaPrevio.montoOperado),
          formatNumber(previousPpcOrPpv)
        ]
      },
      {
        values: [
          'Pendientes',
          formatNumber(totals.pendientes.cantidad),
          formatNumber(totals.pendientes.monto),
          formatNumber(pendingPrecioPromedio)
        ],
        expandable: pendingOperations.length > 0,
        expanded: Boolean(item.pendingExpanded) && pendingOperations.length > 0,
        detailId: pendingDetailId,
        detailNode: buildPendingOperationsSummary(pendingOperations, {
          cantidadTotal: totals.pendientes.cantidad,
          montoTotal: totals.pendientes.monto,
          precioPromedio: pendingPrecioPromedio
        }, priceLabel),
        toggleMeta: pendingOperations.length === 1 ? '1 op' : `${pendingOperations.length} ops`,
        onToggle: () => {
          item.pendingExpanded = !item.pendingExpanded;
          renderDashboardItem(item);
        }
      }
    ]
  );

  groups.appendChild(compactSummaryTable);
  container.appendChild(groups);
}

function renderSummaryObject(item, root) {
  root.appendChild(createObjectHeader(item, 'Resumen operaciones', {
    showLastUpdated: true,
    showInterval: true,
    showRefreshControls: true,
    titleText: item.selectedSymbol || 'Sin símbolo'
  }));

  const body = document.createElement('div');
  body.className = 'dashboard-object-body';

  const content = document.createElement('div');
  content.className = 'dashboard-summary-content';

  if (!activeUsername) {
    content.appendChild(createStateNode('No hay cuenta activa.', 'error'));
  } else if (item.loading) {
    content.appendChild(createStateNode('Cargando operaciones...'));
  } else if (item.error) {
    content.appendChild(createStateNode(item.error, 'error'));
  } else if (availableOperationSymbols.length === 0 && lastOperationsRefreshAt) {
    content.appendChild(createStateNode('No hay operaciones con símbolo para el rango actual.'));
  } else if (!item.selectedSymbol) {
    content.appendChild(createStateNode('Seleccioná un símbolo de tus operaciones.'));
  } else {
    content.appendChild(createModeTabs(item));
    renderOperationSummaryContent(content, item);
  }

  body.appendChild(content);
  root.appendChild(body);
}

function renderChartState(frame, message, tone = 'neutral') {
  clearNode(frame);
  const state = document.createElement('p');
  state.className = tone === 'error' ? 'empty-state error' : 'empty-state';
  state.textContent = message;
  frame.appendChild(state);
}

function renderTradingViewWidget(frame) {
  clearNode(frame);

  const loading = document.createElement('p');
  loading.className = 'dashboard-chart-loading';
  loading.textContent = 'Cargando gráfico...';

  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  container.style.height = '100%';
  container.style.width = '100%';

  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.height = '100%';
  widget.style.width = '100%';

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = TRADINGVIEW_WIDGET_SCRIPT_URL;
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: DEFAULT_TRADINGVIEW_SYMBOL,
    interval: 'D',
    timezone: 'exchange',
    theme: 'light',
    style: '1',
    locale: 'es',
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    allow_symbol_change: true,
    save_image: true,
    calendar: false,
    support_host: 'https://www.tradingview.com'
  });
  script.addEventListener('load', () => {
    loading.remove();
  });
  script.addEventListener('error', () => {
    renderChartState(frame, 'No se pudo cargar el gráfico de TradingView.', 'error');
  });

  container.appendChild(widget);
  container.appendChild(script);
  frame.appendChild(loading);
  frame.appendChild(container);
}

function renderTradingViewObject(item, root) {
  root.appendChild(createObjectHeader(item, 'Panel TradingView', {
    titleText: 'TradingView'
  }));

  const body = document.createElement('div');
  body.className = 'dashboard-object-body';

  const frame = document.createElement('div');
  frame.className = 'dashboard-chart-frame';
  renderTradingViewWidget(frame);

  body.appendChild(frame);
  root.appendChild(body);
}

function hasUsefulFlag(flag) {
  if (!flag || typeof flag !== 'object') {
    return false;
  }
  return ['cantidadCompra', 'precioCompra', 'precioVenta', 'cantidadVenta'].some((key) => {
    const value = flag[key];
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
}

function buildFlagsDepthLevels(flags, side) {
  const isBuySide = side === 'buy';
  const priceKey = isBuySide ? 'precioCompra' : 'precioVenta';
  const quantityKey = isBuySide ? 'cantidadCompra' : 'cantidadVenta';

  return flags
    .map((flag) => ({
      price: parseOptionalNumber(flag[priceKey]),
      quantity: parseOptionalNumber(flag[quantityKey])
    }))
    .filter((level) => level.price !== null || level.quantity !== null)
    .sort((left, right) => {
      if (left.price === null && right.price === null) {
        return 0;
      }
      if (left.price === null) {
        return 1;
      }
      if (right.price === null) {
        return -1;
      }
      return isBuySide ? right.price - left.price : left.price - right.price;
    })
    .slice(0, FLAGS_DEPTH_LEVEL_LIMIT);
}

function createFlagsDepthRow(level, maxQuantity, side) {
  const row = document.createElement('div');
  row.className = `dashboard-flags-depth-row ${side}`;

  const price = document.createElement('span');
  price.className = 'dashboard-flags-depth-price';
  price.textContent = formatOptionalNumber(level.price);

  const barTrack = document.createElement('span');
  barTrack.className = 'dashboard-flags-depth-track';

  const bar = document.createElement('span');
  bar.className = 'dashboard-flags-depth-bar';
  const width = maxQuantity > 0 && Number.isFinite(level.quantity)
    ? Math.max(8, Math.min(100, (level.quantity / maxQuantity) * 100))
    : 0;
  bar.style.width = `${width}%`;
  barTrack.appendChild(bar);

  const quantity = document.createElement('span');
  quantity.className = 'dashboard-flags-depth-quantity';
  quantity.textContent = formatOptionalNumber(level.quantity);

  row.appendChild(price);
  row.appendChild(barTrack);
  row.appendChild(quantity);
  return row;
}

function createFlagsDepthSide(title, levels, side) {
  const section = document.createElement('section');
  section.className = `dashboard-flags-depth-side ${side}`;

  const heading = document.createElement('h3');
  heading.textContent = title;
  section.appendChild(heading);

  if (levels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-flags-depth-empty';
    empty.textContent = 'Sin puntas';
    section.appendChild(empty);
    return section;
  }

  const maxQuantity = levels.reduce((max, level) => {
    const quantity = Number.isFinite(level.quantity) ? level.quantity : 0;
    return Math.max(max, quantity);
  }, 0);

  const rows = document.createElement('div');
  rows.className = 'dashboard-flags-depth-rows';
  for (const level of levels) {
    rows.appendChild(createFlagsDepthRow(level, maxQuantity, side));
  }
  section.appendChild(rows);
  return section;
}

function renderFlagsContent(container, item) {
  if (item.sourcesLoading) {
    container.appendChild(createStateNode('Cargando portfolio y operaciones...'));
    return;
  }
  if (item.sourcesError) {
    container.appendChild(createStateNode(item.sourcesError, 'error'));
    return;
  }
  if (!item.stockOptions.length) {
    container.appendChild(createStateNode('No hay acciones disponibles desde portfolio u operaciones recientes.'));
    return;
  }
  if (!item.selectedStock) {
    container.appendChild(createStateNode('Seleccioná una acción del portfolio u operaciones recientes.'));
    return;
  }
  if (!item.selectedStock.market) {
    container.appendChild(createStateNode('No hay mercado disponible para consultar puntas de esta acción.', 'error'));
    return;
  }
  if (item.loading) {
    container.appendChild(createStateNode('Cargando puntas...'));
    return;
  }
  if (item.error) {
    container.appendChild(createStateNode(item.error, 'error'));
    return;
  }

  const flags = Array.isArray(item.flags?.puntas) ? item.flags.puntas.filter(hasUsefulFlag) : [];
  if (flags.length === 0) {
    container.appendChild(createStateNode('No hay puntas de compra/venta para mostrar.'));
    return;
  }

  const buyLevels = buildFlagsDepthLevels(flags, 'buy');
  const sellLevels = buildFlagsDepthLevels(flags, 'sell');
  if (buyLevels.length === 0 && sellLevels.length === 0) {
    container.appendChild(createStateNode('No hay puntas de compra/venta para mostrar.'));
    return;
  }

  const chart = document.createElement('div');
  chart.className = 'dashboard-flags-depth-chart';
  chart.appendChild(createFlagsDepthSide('Compra', buyLevels, 'buy'));
  chart.appendChild(createFlagsDepthSide('Venta', sellLevels, 'sell'));
  container.appendChild(chart);
}

function renderFlagsObject(item, root) {
  root.appendChild(createObjectHeader(item, 'Puntas compra/venta', {
    showLastUpdated: true,
    showInterval: true,
    showRefreshControls: true,
    titleText: item.selectedStock?.symbol || 'Sin acción'
  }));

  const body = document.createElement('div');
  body.className = 'dashboard-object-body';

  const content = document.createElement('div');
  content.className = 'dashboard-flags-content';
  renderFlagsContent(content, item);

  body.appendChild(content);
  root.appendChild(body);
}

function renderDashboardItem(item) {
  const element = ensureDashboardObjectElement(item);
  constrainItemToCanvas(item);
  updateItemFrame(item);

  const inner = element.querySelector('[data-dashboard-object-inner]');
  clearNode(inner);

  if (item.type === 'summary') {
    renderSummaryObject(item, inner);
  } else if (item.type === 'tradingview') {
    renderTradingViewObject(item, inner);
  } else if (item.type === 'flags') {
    renderFlagsObject(item, inner);
  }
}

function renderAllDashboardItems() {
  for (const item of dashboardItems) {
    renderDashboardItem(item);
  }
  syncEmptyState();
}

function renderSummaryDashboardItems() {
  for (const item of dashboardItems) {
    if (item.type === 'summary') {
      renderDashboardItem(item);
    }
  }
  syncEmptyState();
}

function buildDashboardItem(type, position = null) {
  const typeConfig = DASHBOARD_OBJECT_TYPES[type];
  if (!typeConfig) {
    return null;
  }

  dashboardItemIdCounter += 1;
  const rect = getCanvasRect();
  const offset = ((dashboardItemIdCounter - 1) % 6) * 22;
  const preferredX = position ? position.x - typeConfig.width / 2 : 26 + offset;
  const preferredY = position ? position.y - 24 : 26 + offset;

  const item = {
    id: `dashboard-item-${dashboardItemIdCounter}`,
    type,
    zIndex: dashboardLayerCounter += 1,
    x: preferredX,
    y: preferredY,
    width: Math.min(typeConfig.width, Math.max(rect.width - 32, typeConfig.minWidth)),
    height: Math.min(typeConfig.height, Math.max(rect.height - 32, typeConfig.minHeight)),
    selectedSymbol: '',
    selectedStockKey: '',
    selectedStock: null,
    stockOptions: [],
    sourcesLoading: false,
    sourcesError: '',
    flags: null,
    mode: 'compra',
    pendingExpanded: false,
    loading: false,
    error: '',
    operations: [],
    lastUpdatedAt: null,
    refreshIntervalSec: getDefaultRefreshIntervalForType(type),
    refreshPaused: false,
    timerId: null,
    requestId: 0,
    sourcesRequestId: 0
  };

  constrainItemToCanvas(item);
  return item;
}

function addDashboardItem(type, position = null) {
  const item = buildDashboardItem(type, position);
  if (!item) {
    return;
  }

  dashboardItems.push(item);
  renderDashboardItem(item);
  syncEmptyState();

  if (item.type === 'summary' && activeUsername) {
    loadSummaryItem(item.id, { source: 'manual' });
  } else if (item.type === 'flags' && activeUsername) {
    loadFlagsStockOptions(item.id);
  }
}

function clearSummaryTimer(item) {
  if (item.timerId !== null) {
    clearInterval(item.timerId);
    item.timerId = null;
  }
}

function configureSummaryTimer(item) {
  clearSummaryTimer(item);
  if (item.type !== 'summary' || !item.selectedSymbol || !activeUsername || item.refreshPaused) {
    return;
  }

  item.timerId = setInterval(() => {
    loadSummaryItem(item.id, { source: 'auto' });
  }, item.refreshIntervalSec * 1000);
}

function configureFlagsTimer(item) {
  clearSummaryTimer(item);
  if (item.type !== 'flags' || !item.selectedStock || !item.selectedStock.market || !activeUsername || item.refreshPaused) {
    return;
  }

  item.timerId = setInterval(() => {
    loadFlagsForItem(item.id, { source: 'auto' });
  }, item.refreshIntervalSec * 1000);
}

function removeDashboardItem(itemId) {
  const item = getItemById(itemId);
  if (item) {
    clearSummaryTimer(item);
  }

  dashboardItems = dashboardItems.filter((candidate) => candidate.id !== itemId);
  const element = dashboardCanvas.querySelector(`[data-dashboard-item-id="${itemId}"]`);
  if (element) {
    element.remove();
  }
  syncEmptyState();
}

function getLayoutName() {
  return safeText(layoutNameInput?.value, '').trim();
}

function serializeDashboardLayout() {
  return {
    items: dashboardItems.map((item) => ({
      type: item.type,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      zIndex: item.zIndex || 1
    }))
  };
}

function readLayoutNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clearDashboardLayout() {
  for (const item of dashboardItems) {
    clearSummaryTimer(item);
  }
  pointerAction = null;
  dashboardItems = [];
  for (const element of Array.from(dashboardCanvas.querySelectorAll('.dashboard-object'))) {
    element.remove();
  }
}

function applyDashboardLayout(layout) {
  const rawItems = Array.isArray(layout?.items) ? layout.items : [];
  clearDashboardLayout();
  let maxLayer = dashboardLayerCounter;

  for (const rawItem of rawItems) {
    const type = safeText(rawItem?.type, '');
    if (!DASHBOARD_OBJECT_TYPES[type]) {
      continue;
    }

    const item = buildDashboardItem(type);
    item.x = readLayoutNumber(rawItem.x, item.x);
    item.y = readLayoutNumber(rawItem.y, item.y);
    item.width = readLayoutNumber(rawItem.width, item.width);
    item.height = readLayoutNumber(rawItem.height, item.height);
    item.zIndex = Math.max(1, readLayoutNumber(rawItem.zIndex, item.zIndex));
    maxLayer = Math.max(maxLayer, item.zIndex);
    constrainItemToCanvas(item);
    dashboardItems.push(item);
    renderDashboardItem(item);
  }

  dashboardLayerCounter = Math.max(dashboardLayerCounter, maxLayer);
  syncEmptyState();

  if (!activeUsername) {
    return;
  }

  for (const item of dashboardItems) {
    if (item.type === 'summary') {
      loadSummaryItem(item.id, { source: 'manual' });
    } else if (item.type === 'flags') {
      loadFlagsStockOptions(item.id);
    }
  }
}

async function saveDashboardLayout() {
  const name = getLayoutName();
  if (!name) {
    setStatus('Indicá un nombre de diseño.', 'error');
    layoutNameInput?.focus();
    return;
  }

  saveLayoutButton.disabled = true;
  try {
    const response = await window.apiBroker.saveDashboardLayout({
      name,
      ...serializeDashboardLayout()
    });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo guardar el diseño.');
    }
    setStatus(`Diseño guardado: ${name}.`, 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo guardar el diseño.', 'error');
  } finally {
    saveLayoutButton.disabled = false;
  }
}

async function loadDashboardLayout() {
  const name = getLayoutName();
  if (!name) {
    setStatus('Indicá el nombre del diseño a cargar.', 'error');
    layoutNameInput?.focus();
    return;
  }

  loadLayoutButton.disabled = true;
  try {
    const response = await window.apiBroker.loadDashboardLayout({ name });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo cargar el diseño.');
    }
    applyDashboardLayout(response.layout);
    setStatus(`Diseño cargado: ${name}.`, 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo cargar el diseño.', 'error');
  } finally {
    loadLayoutButton.disabled = false;
  }
}

function resetSummaryItemData(item) {
  item.operations = [];
  item.error = '';
  item.lastUpdatedAt = null;
  item.loading = false;
  item.pendingExpanded = false;
  item.requestId += 1;
}

function handleSummarySymbolChange(itemId, symbol) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'summary') {
    return;
  }

  item.selectedSymbol = safeText(symbol, '');
  item.operations = item.selectedSymbol ? (operationsBySymbol.get(item.selectedSymbol) || []) : [];
  item.lastUpdatedAt = item.selectedSymbol && lastOperationsRefreshAt ? lastOperationsRefreshAt : null;
  item.error = '';
  item.pendingExpanded = false;
  configureSummaryTimer(item);

  renderDashboardItem(item);
  if (item.selectedSymbol) {
    loadSummaryItem(item.id, { source: 'manual' });
  }
}

function handleRefreshIntervalChange(itemId, intervalSeconds) {
  const item = getItemById(itemId);
  if (!item || (item.type !== 'summary' && item.type !== 'flags')) {
    return;
  }

  if (!getRefreshIntervalsForType(item.type).includes(intervalSeconds)) {
    renderDashboardItem(item);
    return;
  }

  item.refreshIntervalSec = intervalSeconds;
  if (item.type === 'summary') {
    lastSummaryRefreshInterval = intervalSeconds;
    configureSummaryTimer(item);
  } else {
    lastFlagsRefreshInterval = intervalSeconds;
    configureFlagsTimer(item);
  }
  renderDashboardItem(item);

  if (item.refreshPaused) {
    return;
  }

  if (item.type === 'summary' && item.selectedSymbol) {
    loadSummaryItem(item.id, { source: 'manual' });
  } else if (item.type === 'flags' && item.selectedStock) {
    loadFlagsForItem(item.id, { source: 'manual' });
  }
}

async function loadFlagsStockOptions(itemId) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'flags' || !activeUsername || item.sourcesLoading) {
    return;
  }

  const requestId = item.sourcesRequestId + 1;
  item.sourcesRequestId = requestId;
  item.sourcesLoading = true;
  item.sourcesError = '';
  renderDashboardItem(item);

  try {
    const [portfolioResponse, operationsResponse] = await Promise.all([
      window.apiBroker.getPortfolio(),
      window.apiBroker.getOperations(buildDefaultRequestFilters()),
    ]);

    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.sourcesRequestId !== requestId) {
      return;
    }

    if (!Array.isArray(portfolioResponse.activos)) {
      throw new Error(portfolioResponse.mensaje || 'No se pudo cargar el portfolio.');
    }
    if (!Array.isArray(operationsResponse.operaciones)) {
      throw new Error(operationsResponse.mensaje || 'No se pudieron cargar operaciones recientes.');
    }

    const stockOptions = mergeStockOptions([
      buildPortfolioStockOptions(portfolioResponse),
      buildRecentOperationStockOptions(operationsResponse.operaciones),
    ]);

    latestItem.stockOptions = stockOptions;
    latestItem.sourcesLoading = false;
    latestItem.sourcesError = '';

    if (latestItem.selectedStockKey) {
      latestItem.selectedStock = stockOptions.find((option) => option.key === latestItem.selectedStockKey) || null;
      if (!latestItem.selectedStock) {
        latestItem.selectedStockKey = '';
        latestItem.flags = null;
        latestItem.lastUpdatedAt = null;
        clearSummaryTimer(latestItem);
      }
    }

    renderDashboardItem(latestItem);
  } catch (error) {
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.sourcesRequestId !== requestId) {
      return;
    }
    latestItem.sourcesLoading = false;
    latestItem.sourcesError = error.message || 'No se pudieron cargar acciones.';
    renderDashboardItem(latestItem);
  }
}

function handleFlagsStockChange(itemId, stockKey) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'flags') {
    return;
  }

  item.selectedStockKey = stockKey;
  item.selectedStock = item.stockOptions.find((option) => option.key === stockKey) || null;
  item.flags = null;
  item.error = '';
  item.lastUpdatedAt = null;
  configureFlagsTimer(item);
  renderDashboardItem(item);

  if (item.selectedStock) {
    loadFlagsForItem(item.id, { source: 'manual' });
  }
}

async function loadFlagsForItem(itemId, options = {}) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'flags' || !activeUsername || item.loading || !item.selectedStock) {
    return;
  }

  if (!item.selectedStock.market) {
    item.error = 'No hay mercado disponible para consultar puntas de esta acción.';
    renderDashboardItem(item);
    return;
  }

  const requestId = item.requestId + 1;
  item.requestId = requestId;
  item.loading = true;
  item.error = '';
  renderDashboardItem(item);

  try {
    const response = await window.apiBroker.getQuoteFlags({
      mercado: item.selectedStock.market,
      simbolo: item.selectedStock.symbol,
    });
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }

    if (response.estado !== 'ok' || !response.cotizacion) {
      throw new Error(response.mensaje || 'No se pudieron consultar puntas.');
    }

    latestItem.flags = response.cotizacion;
    latestItem.lastUpdatedAt = nowLocal();
    latestItem.error = '';
    latestItem.loading = false;
    renderDashboardItem(latestItem);

    if (options.source !== 'auto') {
      setStatus(`Puntas actualizadas: ${latestItem.selectedStock.symbol}.`, 'ok');
    }
  } catch (error) {
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }
    latestItem.error = error.message || 'No se pudieron consultar puntas.';
    latestItem.loading = false;
    renderDashboardItem(latestItem);
  }
}

async function loadSummaryItem(itemId, options = {}) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'summary' || !activeUsername || item.loading) {
    return;
  }

  const requestId = item.requestId + 1;
  item.requestId = requestId;
  item.loading = true;
  item.error = '';
  renderDashboardItem(item);

  try {
    const response = await window.apiBroker.getOperations(buildDefaultRequestFilters());
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }

    if (!Array.isArray(response.operaciones)) {
      throw new Error(response.mensaje || 'Error al consultar operaciones.');
    }

    const refreshedAt = nowLocal();
    syncSummaryOperationsData(response.operaciones, refreshedAt);
    latestItem.operations = latestItem.selectedSymbol ? (operationsBySymbol.get(latestItem.selectedSymbol) || []) : [];
    latestItem.lastUpdatedAt = latestItem.selectedSymbol ? refreshedAt : null;
    latestItem.error = '';
    latestItem.loading = false;
    renderSummaryDashboardItems();

    if (options.source !== 'auto' && latestItem.selectedSymbol) {
      setStatus(`Resumen actualizado: ${latestItem.selectedSymbol}.`, 'ok');
    }
  } catch (error) {
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }
    latestItem.error = error.message || 'Error al consultar operaciones.';
    latestItem.loading = false;
    renderDashboardItem(latestItem);
  }
}

function startPointerAction(event, item, type, corner = '') {
  const element = dashboardCanvas.querySelector(`[data-dashboard-item-id="${item.id}"]`);
  if (!element) {
    return;
  }

  event.preventDefault();
  element.classList.add('active-drag');
  element.setPointerCapture(event.pointerId);

  pointerAction = {
    type,
    corner,
    itemId: item.id,
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startX: item.x,
    startY: item.y,
    startWidth: item.width,
    startHeight: item.height
  };
}

function movePointerAction(event, item) {
  const rect = getCanvasRect();
  const dx = event.clientX - pointerAction.startClientX;
  const dy = event.clientY - pointerAction.startClientY;
  item.x = clamp(pointerAction.startX + dx, 0, Math.max(rect.width - item.width, 0));
  item.y = clamp(pointerAction.startY + dy, 0, Math.max(rect.height - item.height, 0));
  updateItemFrame(item);
}

function resizePointerAction(event, item) {
  const rect = getCanvasRect();
  const typeConfig = DASHBOARD_OBJECT_TYPES[item.type];
  const minWidth = typeConfig?.minWidth || 260;
  const minHeight = typeConfig?.minHeight || 180;
  const dx = event.clientX - pointerAction.startClientX;
  const dy = event.clientY - pointerAction.startClientY;
  const corner = pointerAction.corner;

  let x = pointerAction.startX;
  let y = pointerAction.startY;
  let width = pointerAction.startWidth;
  let height = pointerAction.startHeight;

  if (corner.includes('e')) {
    width = pointerAction.startWidth + dx;
  }
  if (corner.includes('s')) {
    height = pointerAction.startHeight + dy;
  }
  if (corner.includes('w')) {
    width = pointerAction.startWidth - dx;
    x = pointerAction.startX + dx;
  }
  if (corner.includes('n')) {
    height = pointerAction.startHeight - dy;
    y = pointerAction.startY + dy;
  }

  if (width < minWidth) {
    if (corner.includes('w')) {
      x = pointerAction.startX + pointerAction.startWidth - minWidth;
    }
    width = minWidth;
  }
  if (height < minHeight) {
    if (corner.includes('n')) {
      y = pointerAction.startY + pointerAction.startHeight - minHeight;
    }
    height = minHeight;
  }

  if (x < 0) {
    if (corner.includes('w')) {
      width += x;
    }
    x = 0;
  }
  if (y < 0) {
    if (corner.includes('n')) {
      height += y;
    }
    y = 0;
  }
  if (x + width > rect.width) {
    width = rect.width - x;
  }
  if (y + height > rect.height) {
    height = rect.height - y;
  }

  item.x = x;
  item.y = y;
  item.width = Math.max(width, minWidth);
  item.height = Math.max(height, minHeight);
  constrainItemToCanvas(item);
  updateItemFrame(item);
}

function handlePointerMove(event) {
  if (!pointerAction || event.pointerId !== pointerAction.pointerId) {
    return;
  }

  const item = getItemById(pointerAction.itemId);
  if (!item) {
    return;
  }

  if (pointerAction.type === 'move') {
    movePointerAction(event, item);
  } else {
    resizePointerAction(event, item);
  }
}

function finishPointerAction(event) {
  if (!pointerAction || event.pointerId !== pointerAction.pointerId) {
    return;
  }

  const element = dashboardCanvas.querySelector(`[data-dashboard-item-id="${pointerAction.itemId}"]`);
  if (element) {
    element.classList.remove('active-drag');
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  }
  pointerAction = null;
}

function handleCanvasPointerDown(event) {
  const objectElement = event.target.closest('.dashboard-object');
  if (!objectElement) {
    return;
  }

  const item = getItemById(objectElement.dataset.dashboardItemId);
  if (!item) {
    return;
  }
  bringDashboardItemToFront(item.id);

  const resizeHandle = event.target.closest('.dashboard-resize-handle');
  if (resizeHandle) {
    startPointerAction(event, item, 'resize', resizeHandle.dataset.corner || 'se');
    return;
  }

  const moveHandle = event.target.closest('.dashboard-move-handle');
  if (moveHandle) {
    startPointerAction(event, item, 'move');
  }
}

function getDropPosition(event) {
  const rect = getCanvasRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function hasDataTransferType(dataTransfer, type) {
  const types = dataTransfer?.types;
  if (!types) {
    return false;
  }
  if (typeof types.includes === 'function') {
    return types.includes(type);
  }
  if (typeof types.contains === 'function') {
    return types.contains(type);
  }
  return Array.from(types).includes(type);
}

function handlePaletteDragStart(event) {
  const type = event.currentTarget.dataset.dashboardObjectType;
  if (!DASHBOARD_OBJECT_TYPES[type]) {
    event.preventDefault();
    return;
  }

  draggedPaletteType = type;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-dashboard-object', type);
  event.dataTransfer.setData('text/plain', type);
}

function handlePaletteDragEnd(event) {
  draggedPaletteType = '';
  event.currentTarget.classList.remove('dragging');
  dashboardCanvas.classList.remove('drag-over');
}

function handleCanvasDragOver(event) {
  const type = hasDataTransferType(event.dataTransfer, 'application/x-dashboard-object')
    ? event.dataTransfer.getData('application/x-dashboard-object') || draggedPaletteType
    : draggedPaletteType;
  if (!DASHBOARD_OBJECT_TYPES[type]) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dashboardCanvas.classList.add('drag-over');
}

function handleCanvasDrop(event) {
  const type = event.dataTransfer.getData('application/x-dashboard-object') || draggedPaletteType;
  dashboardCanvas.classList.remove('drag-over');
  if (!DASHBOARD_OBJECT_TYPES[type]) {
    return;
  }

  event.preventDefault();
  addDashboardItem(type, getDropPosition(event));
}

function handleCanvasDragLeave(event) {
  if (!dashboardCanvas.contains(event.relatedTarget)) {
    dashboardCanvas.classList.remove('drag-over');
  }
}

function toggleDashboardPanel() {
  const collapsed = !dashboardShell.classList.contains('dashboard-panel-collapsed');
  dashboardShell.classList.toggle('dashboard-panel-collapsed', collapsed);
  dashboardPanel.hidden = collapsed;
  panelToggleButton.setAttribute('aria-expanded', String(!collapsed));
  requestAnimationFrame(() => {
    for (const item of dashboardItems) {
      constrainItemToCanvas(item);
      updateItemFrame(item);
    }
  });
}

async function refreshActiveAccount() {
  try {
    const response = await window.apiBroker.listAccounts();
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
    }

    const nextUsername = safeText(response.active_username, '').trim();
    const changed = nextUsername !== activeUsername;
    activeUsername = nextUsername;
    setPaletteEnabled(Boolean(activeUsername));

    if (!activeUsername) {
      for (const item of dashboardItems) {
        if (item.type === 'summary' || item.type === 'flags') {
          clearSummaryTimer(item);
        }
      }
      renderAllDashboardItems();
      setStatus('No hay cuenta activa.', 'error');
      return;
    }

    if (changed) {
      for (const item of dashboardItems) {
        if (item.type === 'summary') {
          resetSummaryItemData(item);
          configureSummaryTimer(item);
          loadSummaryItem(item.id, { source: 'manual' });
        } else if (item.type === 'flags') {
          clearSummaryTimer(item);
          item.stockOptions = [];
          item.selectedStockKey = '';
          item.selectedStock = null;
          item.sourcesError = '';
          item.flags = null;
          item.error = '';
          item.lastUpdatedAt = null;
          loadFlagsStockOptions(item.id);
        }
      }
      renderAllDashboardItems();
    }
  } catch (error) {
    activeUsername = '';
    setPaletteEnabled(false);
    setStatus(error.message || 'No se pudo cargar la cuenta activa.', 'error');
  }
}

function handleWindowResize() {
  for (const item of dashboardItems) {
    constrainItemToCanvas(item);
    updateItemFrame(item);
  }
}

async function initialize() {
  syncEmptyState();
  setPaletteEnabled(false);

  await refreshActiveAccount();
  setPaletteEnabled(Boolean(activeUsername));
}

for (const item of paletteItems) {
  item.addEventListener('dragstart', handlePaletteDragStart);
  item.addEventListener('dragend', handlePaletteDragEnd);
  item.addEventListener('click', () => {
    addDashboardItem(item.dataset.dashboardObjectType);
  });
}

panelToggleButton.addEventListener('click', toggleDashboardPanel);
saveLayoutButton.addEventListener('click', saveDashboardLayout);
loadLayoutButton.addEventListener('click', loadDashboardLayout);
dashboardCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
dashboardCanvas.addEventListener('dragover', handleCanvasDragOver);
dashboardCanvas.addEventListener('drop', handleCanvasDrop);
dashboardCanvas.addEventListener('dragleave', handleCanvasDragLeave);
window.addEventListener('pointermove', handlePointerMove);
window.addEventListener('pointerup', finishPointerAction);
window.addEventListener('pointercancel', finishPointerAction);
window.addEventListener('resize', handleWindowResize);
window.addEventListener('focus', () => {
  refreshActiveAccount();
});
window.addEventListener('beforeunload', () => {
  for (const item of dashboardItems) {
    if (item.type === 'summary' || item.type === 'flags') {
      clearSummaryTimer(item);
    }
  }
});

initialize();
