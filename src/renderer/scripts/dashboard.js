const dashboardShell = document.getElementById('dashboard-shell');
const dashboardCanvas = document.getElementById('dashboard-canvas');
const dashboardPanel = document.getElementById('dashboard-panel');
const dashboardEmpty = document.getElementById('dashboard-empty');
const panelToggleButton = document.getElementById('btn-toggle-dashboard-panel');
const layoutNameInput = document.getElementById('dashboard-layout-name');
const saveLayoutButton = document.getElementById('btn-save-dashboard-layout');
const loadLayoutButton = document.getElementById('btn-load-dashboard-layout');
const deleteLayoutButton = document.getElementById('btn-delete-dashboard-layout');
const layoutSelect = document.getElementById('dashboard-layout-select');
const paletteItems = Array.from(document.querySelectorAll('[data-dashboard-object-type]'));

const SUMMARY_REFRESH_INTERVALS = [20, 30, 60, 120, 300];
const FLAGS_REFRESH_INTERVALS = [10, 20, 30, 60, 120, 300];
const PORTFOLIO_REFRESH_INTERVALS = [10, 20, 30, 60, 120, 300];
const FLAGS_DEPTH_LEVEL_LIMIT = 6;
const TRADINGVIEW_WIDGET_SCRIPT_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
const DEFAULT_TRADINGVIEW_SYMBOL = 'NASDAQ:AAPL';
const DASHBOARD_CACHE_TTLS_MS = {
  operations: 3000,
  portfolio: 3000,
  quoteFlags: 1800,
  priceStep: 5 * 60 * 1000,
  priceStepError: 30000
};
const DASHBOARD_PRICE_STEP_CONCURRENCY = 4;
const DASHBOARD_OBJECT_TYPES = {
  summary: {
    label: 'Resumen de operaciones',
    width: 340,
    height: 240,
    minWidth: 280,
    minHeight: 170
  },
  tradingview: {
    label: 'Panel de TradingView',
    width: 540,
    height: 330,
    minWidth: 360,
    minHeight: 230
  },
  flags: {
    label: 'Puntas compra/venta',
    width: 360,
    height: 220,
    minWidth: 300,
    minHeight: 150
  },
  portfolioActions: {
    label: 'Acciones de portafolio',
    width: 620,
    height: 190,
    minWidth: 520,
    minHeight: 145
  }
};

let activeUsername = '';
let dashboardItems = [];
let dashboardItemIdCounter = 0;
let dashboardLayerCounter = 1;
let lastSummaryRefreshInterval = 60;
let lastFlagsRefreshInterval = 60;
let lastPortfolioRefreshInterval = 60;
let summaryOperations = [];
let operationsBySymbol = new Map();
let availableOperationSymbols = [];
let lastOperationsRefreshAt = null;
let pointerAction = null;
let draggedPaletteType = '';
let toastNode = null;
let toastTimeoutId = null;
let activeConfirmDialog = null;
let lastDashboardLayoutName = '';
let autoLoadedLastLayout = false;
let activeAccountRefreshRequestId = 0;

const dashboardRequestCache = new Map();
const dashboardInflightRequests = new Map();
const dashboardCacheVersions = new Map();
const portfolioPriceStepCache = new Map();

const dashboardPerfEnabled = (() => {
  try {
    return window.localStorage?.getItem('brokerDashboardPerf') === '1'
      || new URLSearchParams(window.location.search).has('dashboardPerf');
  } catch (_error) {
    return false;
  }
})();

const integerNumberFormatter = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 0
});
const decimalNumberFormatter = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function getPerfNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function startDashboardPerf(label, details = {}) {
  if (!dashboardPerfEnabled) {
    return null;
  }
  return {
    label,
    details,
    startedAt: getPerfNow()
  };
}

function finishDashboardPerf(timer, details = {}) {
  if (!timer) {
    return;
  }
  const elapsed = Math.round((getPerfNow() - timer.startedAt) * 10) / 10;
  console.debug('[dashboard:perf]', timer.label, `${elapsed}ms`, {
    ...timer.details,
    ...details
  });
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function getDashboardCacheNamespace(key) {
  return String(key).split(':')[0] || String(key);
}

function getDashboardCacheVersion(namespace) {
  return dashboardCacheVersions.get(namespace) || 0;
}

function invalidateDashboardCache(namespace) {
  dashboardCacheVersions.set(namespace, getDashboardCacheVersion(namespace) + 1);
  for (const key of Array.from(dashboardRequestCache.keys())) {
    if (getDashboardCacheNamespace(key) === namespace) {
      dashboardRequestCache.delete(key);
    }
  }
}

async function getCachedDashboardResource(key, requestFactory, options = {}) {
  const ttlMs = Math.max(Number(options.ttlMs) || 0, 0);
  const now = Date.now();
  const cached = dashboardRequestCache.get(key);
  const namespace = getDashboardCacheNamespace(key);
  const cacheVersion = getDashboardCacheVersion(namespace);

  if (!options.force && cached && now - cached.cachedAt <= ttlMs) {
    return cached.value;
  }

  const inflight = dashboardInflightRequests.get(key);
  if (inflight && inflight.version === cacheVersion) {
    return inflight.promise;
  }

  const perf = startDashboardPerf(`request:${namespace}`, { key });
  const request = Promise.resolve()
    .then(requestFactory)
    .then((value) => {
      if (getDashboardCacheVersion(namespace) === cacheVersion) {
        dashboardRequestCache.set(key, {
          cachedAt: Date.now(),
          value
        });
      }
      finishDashboardPerf(perf, { cached: false });
      return value;
    })
    .catch((error) => {
      finishDashboardPerf(perf, { error: error.message || String(error) });
      throw error;
    })
    .finally(() => {
      if (dashboardInflightRequests.get(key)?.promise === request) {
        dashboardInflightRequests.delete(key);
      }
    });

  dashboardInflightRequests.set(key, {
    promise: request,
    version: cacheVersion
  });
  return request;
}

function getDashboardPortfolio(options = {}) {
  return getCachedDashboardResource('portfolio:active', async () => ({
    response: await window.apiBroker.getPortfolio(),
    refreshedAt: nowLocal()
  }), {
    ttlMs: DASHBOARD_CACHE_TTLS_MS.portfolio,
    force: Boolean(options.force)
  });
}

function getDashboardOperations(options = {}) {
  return getCachedDashboardResource('operations:default', async () => {
    const filters = buildDefaultRequestFilters();
    return {
      filters,
      response: await window.apiBroker.getOperations(filters),
      refreshedAt: nowLocal()
    };
  }, {
    ttlMs: DASHBOARD_CACHE_TTLS_MS.operations,
    force: Boolean(options.force)
  });
}

function buildQuoteFlagsCacheKey(payload) {
  return `quoteFlags:${stableStringify({
    mercado: safeText(payload?.mercado, '').toLowerCase(),
    simbolo: safeText(payload?.simbolo, '').toUpperCase()
  })}`;
}

function getPortfolioPriceStepCacheKey(market, symbol) {
  return `${safeText(market, '').toLowerCase()}::${safeText(symbol, '').toUpperCase()}`;
}

function readPortfolioPriceStepCache(market, symbol) {
  const key = getPortfolioPriceStepCacheKey(market, symbol);
  const cached = portfolioPriceStepCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    portfolioPriceStepCache.delete(key);
    return null;
  }
  return cached;
}

function writePortfolioPriceStepCache(market, symbol, step, error = '') {
  const hasStep = Number.isFinite(step) && step > 0;
  portfolioPriceStepCache.set(getPortfolioPriceStepCacheKey(market, symbol), {
    step: hasStep ? step : null,
    error: hasStep ? '' : error,
    expiresAt: Date.now() + (hasStep ? DASHBOARD_CACHE_TTLS_MS.priceStep : DASHBOARD_CACHE_TTLS_MS.priceStepError)
  });
}

function applyCachedPriceStepToRow(row) {
  const cached = readPortfolioPriceStepCache(row.market, row.symbol);
  if (!cached) {
    return false;
  }
  row.priceStep = cached.step;
  row.priceStepError = cached.step ? '' : cached.error || 'Incremento no disponible';
  return true;
}

function getDashboardQuoteFlags(payload, options = {}) {
  const requestPayload = {
    mercado: payload?.mercado,
    simbolo: payload?.simbolo
  };
  return getCachedDashboardResource(buildQuoteFlagsCacheKey(requestPayload), async () => {
    const response = await window.apiBroker.getQuoteFlags(requestPayload);
    if (response?.estado === 'ok' && response.cotizacion) {
      const step = derivePriceStepFromPrices(collectQuotePrices(response.cotizacion));
      writePortfolioPriceStepCache(requestPayload.mercado, requestPayload.simbolo, step, step ? '' : 'Incremento no disponible');
    }
    return {
      response,
      refreshedAt: nowLocal()
    };
  }, {
    ttlMs: DASHBOARD_CACHE_TTLS_MS.quoteFlags,
    force: Boolean(options.force)
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

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
  if (type === 'portfolioActions') {
    return PORTFOLIO_REFRESH_INTERVALS;
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
  if (type === 'portfolioActions') {
    return lastPortfolioRefreshInterval;
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

function closeActiveConfirmDialog(result = false) {
  if (!activeConfirmDialog) {
    return;
  }

  const { overlay, resolve, previousFocus } = activeConfirmDialog;
  activeConfirmDialog = null;
  overlay.remove();
  if (previousFocus && typeof previousFocus.focus === 'function') {
    previousFocus.focus();
  }
  resolve(result);
}

function showDashboardConfirmDialog({ title, message, details = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' }) {
  if (activeConfirmDialog) {
    closeActiveConfirmDialog(false);
  }

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'dashboard-confirm-overlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('section');
    dialog.className = 'dashboard-confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'dashboard-confirm-title');
    dialog.tabIndex = -1;

    const heading = document.createElement('h2');
    heading.id = 'dashboard-confirm-title';
    heading.textContent = title;

    const body = document.createElement('p');
    body.className = 'dashboard-confirm-message';
    body.textContent = message;

    dialog.appendChild(heading);
    dialog.appendChild(body);

    if (details) {
      const detail = document.createElement('p');
      detail.className = 'dashboard-confirm-detail';
      detail.textContent = details;
      dialog.appendChild(detail);
    }

    const actions = document.createElement('div');
    actions.className = 'dashboard-confirm-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'dashboard-confirm-btn secondary';
    cancelButton.textContent = cancelLabel;
    cancelButton.addEventListener('click', () => {
      closeActiveConfirmDialog(false);
    });

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'dashboard-confirm-btn primary';
    confirmButton.textContent = confirmLabel;
    confirmButton.addEventListener('click', () => {
      closeActiveConfirmDialog(true);
    });

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) {
        closeActiveConfirmDialog(false);
      }
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeActiveConfirmDialog(false);
      }
    });

    activeConfirmDialog = { overlay, resolve, previousFocus };
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      dialog.focus();
    });
  });
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

function normalizeSellOrderPlazo(value) {
  const plazo = safeText(value, '').toLowerCase();
  return ['t0', 't1', 't2'].includes(plazo) ? plazo : 't2';
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
      sourceLabel: 'Portafolio',
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

function normalizePortfolioActionRow(activo) {
  const titulo = activo?.titulo || {};
  const symbol = firstNonEmpty([titulo.simbolo, activo?.simbolo]).toUpperCase();
  if (!symbol) {
    return null;
  }

  const market = firstNonEmpty([titulo.mercado, activo?.mercado, titulo.mercadoCodigo, activo?.mercadoCodigo]);
  const plazo = normalizeSellOrderPlazo(firstNonEmpty([titulo.plazo, activo?.plazo]));
  const key = buildStockOptionKey(symbol, market);
  return {
    key,
    symbol,
    market,
    plazo,
    quantity: Math.max(parseOperationNumber(activo?.cantidad), 0),
    ppc: parseOperationNumber(activo?.ppc),
    up: parseOperationNumber(activo?.ultimoPrecio),
    priceStep: null,
    priceStepError: market ? '' : 'Sin mercado',
  };
}

function normalizePortfolioActionRows(portfolio) {
  const activos = Array.isArray(portfolio?.activos) ? portfolio.activos : [];
  return activos
    .map(normalizePortfolioActionRow)
    .filter(Boolean)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function getPortfolioControl(item, row) {
  if (!item.portfolioControls[row.key]) {
    const defaultPrice = row.up > 0 ? String(row.up) : '';
    item.portfolioControls[row.key] = {
      percent: 100,
      percentText: '100%',
      priceText: defaultPrice,
      normalizedPrice: row.up > 0 ? row.up : null,
      sellError: '',
      selling: false,
    };
  }
  return item.portfolioControls[row.key];
}

function calculateSellQuantity(quantity, percent) {
  const owned = Math.max(Math.round(Number(quantity) || 0), 0);
  const normalizedPercent = clamp(Number(percent) || 0, 0, 100);
  if (owned <= 0 || normalizedPercent <= 0) {
    return 0;
  }
  return Math.min(owned, Math.max(1, Math.round((owned * normalizedPercent) / 100)));
}

function normalizePercentInput(value) {
  const parsed = parseOperationNumber(value);
  return clamp(parsed, 0, 100);
}

function normalizeSliderPercentInput(value) {
  const parsed = normalizePercentInput(value);
  return clamp(Math.round(parsed / 5) * 5, 0, 100);
}

function decimalPlaces(value) {
  const text = String(value);
  if (!text.includes('.')) {
    return 0;
  }
  return text.split('.')[1].replace(/0+$/, '').length;
}

function trimDecimalZeroes(value) {
  const text = String(value);
  if (!text.includes('.')) {
    return text;
  }
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function formatPriceForInput(value, step = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  if (!step || !Number.isFinite(step) || step <= 0) {
    return String(number);
  }
  return trimDecimalZeroes(number.toFixed(Math.min(Math.max(decimalPlaces(step), 0), 6)));
}

function collectQuotePrices(flags) {
  const prices = [];
  const puntas = Array.isArray(flags?.puntas) ? flags.puntas : [];
  for (const flag of puntas) {
    for (const key of ['precioCompra', 'precioVenta']) {
      const price = parseOptionalNumber(flag?.[key]);
      if (price !== null && price > 0) {
        prices.push(price);
      }
    }
  }
  const lastPrice = parseOptionalNumber(flags?.ultimoPrecio);
  if (lastPrice !== null && lastPrice > 0) {
    prices.push(lastPrice);
  }
  return prices;
}

function derivePriceStepFromPrices(prices) {
  const unique = Array.from(new Set(
    prices
      .map((price) => Number(price))
      .filter((price) => Number.isFinite(price) && price > 0)
      .map((price) => Number(price.toFixed(6)))
  )).sort((left, right) => left - right);

  let step = null;
  for (let index = 1; index < unique.length; index += 1) {
    const diff = Number((unique[index] - unique[index - 1]).toFixed(6));
    if (diff > 0 && (step === null || diff < step)) {
      step = diff;
    }
  }
  return step;
}

function parsePriceNumber(value) {
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

  if (sanitized.includes(',')) {
    return parseOperationNumber(sanitized);
  }

  if (/^-?\d{1,3}(?:\.\d{3})+$/.test(sanitized)) {
    const parsedThousands = Number(sanitized.replace(/\./g, ''));
    return Number.isFinite(parsedThousands) ? parsedThousands : 0;
  }

  const parsed = Number(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePriceToStep(value, step) {
  const price = parsePriceNumber(value);
  if (price <= 0) {
    return null;
  }
  if (!step || !Number.isFinite(step) || step <= 0) {
    return price;
  }
  return Number((Math.round(price / step) * step).toFixed(Math.min(Math.max(decimalPlaces(step), 0), 6)));
}

function canSubmitSellOrder() {
  return Boolean(window.apiBroker && typeof window.apiBroker.sellOrder === 'function');
}

function canCancelOperation() {
  return Boolean(window.apiBroker && typeof window.apiBroker.cancelOperation === 'function');
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

function resolveOperationNumber(row) {
  const value = firstDefined(row, [
    'numeroOperacion',
    'numero',
    'nroOperacion',
    'idOperacion',
    'numeroOrden',
    'nroOrden',
    'id'
  ]);
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : '';
  }
  const text = safeText(value, '');
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    return '';
  }
  return text;
}

function buildPendingOperationSummary(row, pendingSplit) {
  const numeroOperacion = resolveOperationNumber(row);
  return {
    numeroOperacion,
    fecha: safeText(firstDefined(row, ['fechaOrden', 'fecha', 'fechaOperada'])),
    estado: safeText(row.estado),
    mercado: safeText(row.mercado),
    simbolo: safeText(row.simbolo, ''),
    tipo: safeText(row.tipo, ''),
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

function buildPendingOperationsSummary(operations, summary = {}, priceLabel = 'PPC', item = null) {
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

  const pendingTable = document.createElement('table');
  pendingTable.className = 'summary-table pending-operations-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const title of ['Op', 'Operadas', 'Cantidad', 'Monto', 'Precio', '']) {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  pendingTable.appendChild(thead);

  const tbody = document.createElement('tbody');
  operations.forEach((operation, index) => {
    const tr = document.createElement('tr');
    for (const value of [
      String(index + 1),
      formatNumber(operation.cantidadOperada),
      formatNumber(operation.cantidadPendiente),
      formatNumber(operation.montoPendiente),
      formatNumber(operation.precio)
    ]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }

    const cancelCell = document.createElement('td');
    cancelCell.className = 'pending-operation-cancel-cell';
    const cancelButton = document.createElement('button');
    const operationNumber = operation.numeroOperacion;
    const isCanceling = Boolean(item?.pendingCanceling?.[operationNumber]);
    cancelButton.type = 'button';
    cancelButton.className = 'pending-operation-cancel-btn';
    cancelButton.textContent = isCanceling ? '...' : '×';
    cancelButton.setAttribute('aria-label', 'Cancelar operación pendiente');
    cancelButton.title = operationNumber ? 'Cancelar operación' : 'Sin número de operación';
    cancelButton.disabled = !item || !operationNumber || isCanceling || !canCancelOperation();
    cancelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      handlePendingOperationCancel(item, operation);
    });
    cancelCell.appendChild(cancelButton);
    tr.appendChild(cancelCell);
    tbody.appendChild(tr);
  });
  pendingTable.appendChild(tbody);
  pendingTable.classList.add('pending-operations-table');

  wrapper.appendChild(pendingSummaryTable);
  wrapper.appendChild(pendingTable);

  return wrapper;
}

function removeOperationByNumber(operations, operationNumber) {
  return (operations || []).filter((operation) => resolveOperationNumber(operation) !== operationNumber);
}

async function handlePendingOperationCancel(item, operation) {
  if (!item || item.type !== 'summary') {
    return;
  }
  if (!canCancelOperation()) {
    setStatus('Cancelación no disponible.', 'error');
    return;
  }

  const operationNumber = operation?.numeroOperacion || '';
  if (!operationNumber) {
    setStatus('La operación no tiene número para cancelar.', 'error');
    return;
  }

  const confirmed = await showDashboardConfirmDialog({
    title: 'Cancelar Orden',
    message: `Cancelar operación ${operationNumber}?`,
    details: `${operation.simbolo || item.selectedSymbol} · ${formatNumber(operation.cantidadPendiente)} a ${formatNumber(operation.precio)}`,
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar'
  });
  if (!confirmed) {
    return;
  }

  item.pendingCanceling[operationNumber] = true;
  renderDashboardItem(item);

  try {
    const response = await window.apiBroker.cancelOperation({ numeroOperacion: operationNumber });
    if (!response || response.estado !== 'ok') {
      throw new Error(response?.mensaje || 'No se pudo cancelar la operación.');
    }

    invalidateDashboardCache('operations');
    cancelDashboardRequestsByType('summary');
    const updatedOperations = removeOperationByNumber(summaryOperations, operationNumber);
    applySharedOperationsData(updatedOperations, lastOperationsRefreshAt || nowLocal(), {
      clearErrors: true,
      renderSummaries: true
    });
    item.error = '';
    renderDashboardItem(item);
    setStatus(`Operación cancelada: ${operationNumber}.`, 'ok');
    loadSummaryItem(item.id, { source: 'auto', force: true });
  } catch (error) {
    item.error = error.message || 'No se pudo cancelar la operación.';
  } finally {
    delete item.pendingCanceling[operationNumber];
    renderDashboardItem(item);
  }
}

function createStateNode(message, tone = 'neutral') {
  const node = document.createElement('p');
  node.className = tone === 'error' ? 'dashboard-state error' : 'dashboard-state';
  node.textContent = message;
  return node;
}

function createUpdatingIndicator(message = 'Actualizando') {
  const node = document.createElement('div');
  node.className = 'dashboard-updating';

  const spinner = document.createElement('span');
  spinner.className = 'dashboard-updating-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.textContent = message;

  node.appendChild(spinner);
  node.appendChild(text);
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

function getRenderedItemFrame(item) {
  const rect = getCanvasRect();
  const typeConfig = DASHBOARD_OBJECT_TYPES[item.type];
  const minWidth = typeConfig?.minWidth || 260;
  const minHeight = typeConfig?.minHeight || 180;
  const maxWidth = Math.max(rect.width, minWidth);
  const maxHeight = Math.max(rect.height, minHeight);
  const width = clamp(item.width, minWidth, maxWidth);
  const height = clamp(item.height, minHeight, maxHeight);

  return {
    x: clamp(item.x, 0, Math.max(rect.width - width, 0)),
    y: clamp(item.y, 0, Math.max(rect.height - height, 0)),
    width,
    height,
  };
}

function updateItemFrame(item) {
  const element = dashboardCanvas.querySelector(`[data-dashboard-item-id="${item.id}"]`);
  if (!element) {
    return;
  }

  const frame = getRenderedItemFrame(item);
  element.style.left = `${frame.x}px`;
  element.style.top = `${frame.y}px`;
  element.style.width = `${frame.width}px`;
  element.style.height = `${frame.height}px`;
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
  return item.type === 'summary' || item.type === 'flags' || item.type === 'portfolioActions';
}

function itemHasRefreshTarget(item) {
  if (item.type === 'summary') {
    return Boolean(item.selectedSymbol);
  }
  if (item.type === 'flags') {
    return Boolean(item.selectedStock && item.selectedStock.market);
  }
  if (item.type === 'portfolioActions') {
    return true;
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
      select.appendChild(createSelectOption(option.key, option.symbol));
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
      loadSummaryItem(item.id, { source: 'manual', force: true });
    }
  } else if (item.type === 'flags') {
    configureFlagsTimer(item);
    if (item.selectedStock) {
      loadFlagsForItem(item.id, { source: 'manual', force: true });
    }
  } else {
    configurePortfolioActionsTimer(item);
    loadPortfolioActionsItem(item.id, { source: 'manual', force: true });
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
        }, priceLabel, item),
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
  root.appendChild(createObjectHeader(item, 'Resumen de operaciones', {
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
  } else if (item.loading && (!item.selectedSymbol || item.operations.length === 0)) {
    content.appendChild(createStateNode('Cargando operaciones...'));
  } else if (item.error && item.operations.length === 0) {
    content.appendChild(createStateNode(item.error, 'error'));
  } else if (availableOperationSymbols.length === 0 && lastOperationsRefreshAt) {
    content.appendChild(createStateNode('No hay operaciones con símbolo para el rango actual.'));
  } else if (!item.selectedSymbol) {
    content.appendChild(createStateNode('Seleccioná un símbolo de tus operaciones.'));
  } else {
    if (item.loading) {
      content.appendChild(createUpdatingIndicator('Actualizando'));
    }
    if (item.error) {
      content.appendChild(createStateNode(item.error, 'error'));
    }
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

function renderTradingViewWidget(frame, item) {
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

  container.appendChild(widget);
  frame.appendChild(loading);
  frame.appendChild(container);

  const renderToken = (item.tradingViewRenderToken || 0) + 1;
  item.tradingViewRenderToken = renderToken;
  const injectWidget = () => {
    if (!frame.isConnected || item.tradingViewRenderToken !== renderToken) {
      return;
    }

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
      if (frame.isConnected) {
        renderChartState(frame, 'No se pudo cargar el gráfico de TradingView.', 'error');
      }
    });
    container.appendChild(script);
  };

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(injectWidget, { timeout: 1200 });
  } else {
    window.setTimeout(injectWidget, 80);
  }
}

function renderTradingViewObject(item, root) {
  root.appendChild(createObjectHeader(item, 'Panel de TradingView', {
    titleText: 'Panel de TradingView'
  }));

  const body = document.createElement('div');
  body.className = 'dashboard-object-body';

  const frame = document.createElement('div');
  frame.className = 'dashboard-chart-frame';
  renderTradingViewWidget(frame, item);

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

function createFlagsDepthRow(item, level, maxQuantity, side) {
  const row = document.createElement('div');
  row.className = `dashboard-flags-depth-row ${side}`;

  const price = document.createElement('button');
  price.type = 'button';
  price.className = 'dashboard-flags-depth-price';
  price.textContent = formatOptionalNumber(level.price);
  price.title = 'Usar precio en Acciones de portafolio';
  price.addEventListener('click', () => {
    handleFlagsPriceClick(item, level.price);
  });

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

function createFlagsDepthSide(item, title, levels, side) {
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
    rows.appendChild(createFlagsDepthRow(item, level, maxQuantity, side));
  }
  section.appendChild(rows);
  return section;
}

function handleFlagsPriceClick(flagsItem, price) {
  const numericPrice = parseOptionalNumber(price);
  const stock = flagsItem?.selectedStock;
  if (numericPrice === null || !stock) {
    return;
  }

  let applied = false;
  for (const item of dashboardItems) {
    if (item.type !== 'portfolioActions') {
      continue;
    }
    const row = (item.portfolioRows || []).find((candidate) => {
      const sameSymbol = candidate.symbol === stock.symbol;
      const sameMarket = !stock.market || !candidate.market || candidate.market === stock.market;
      return sameSymbol && sameMarket;
    });
    if (!row) {
      continue;
    }

    const control = getPortfolioControl(item, row);
    const normalizedPrice = normalizePriceToStep(numericPrice, row.priceStep);
    control.normalizedPrice = normalizedPrice;
    control.priceText = formatPriceForInput(normalizedPrice ?? numericPrice, row.priceStep);
    control.sellError = '';
    renderDashboardItem(item);
    applied = true;
  }

  if (applied) {
    setStatus(`Precio aplicado: ${stock.symbol}.`, 'ok');
  }
}

function renderFlagsContent(container, item) {
  if (item.sourcesLoading) {
    container.appendChild(createStateNode('Cargando portafolio y operaciones...'));
    return;
  }
  if (item.sourcesError) {
    container.appendChild(createStateNode(item.sourcesError, 'error'));
    return;
  }
  if (!item.stockOptions.length) {
    container.appendChild(createStateNode('No hay acciones disponibles desde portafolio u operaciones recientes.'));
    return;
  }
  if (!item.selectedStock) {
    container.appendChild(createStateNode('Seleccioná una acción del portafolio u operaciones recientes.'));
    return;
  }
  if (!item.selectedStock.market) {
    container.appendChild(createStateNode('No hay mercado disponible para consultar puntas de esta acción.', 'error'));
    return;
  }
  if (item.loading && !item.flags) {
    container.appendChild(createStateNode('Cargando puntas...'));
    return;
  }
  if (item.error && !item.flags) {
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
  chart.appendChild(createFlagsDepthSide(item, 'Compra', buyLevels, 'buy'));
  chart.appendChild(createFlagsDepthSide(item, 'Venta', sellLevels, 'sell'));
  container.appendChild(chart);

  if (item.error) {
    container.appendChild(createStateNode(item.error, 'error'));
  }
  if (item.loading) {
    container.appendChild(createUpdatingIndicator('Actualizando puntas'));
  }
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

function createPortfolioPercentControl(item, row, control) {
  const wrapper = document.createElement('div');
  wrapper.className = 'portfolio-actions-percent';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '5';
  slider.value = String(control.percent);
  slider.setAttribute('aria-label', `Porcentaje a vender de ${row.symbol}`);
  slider.addEventListener('input', () => {
    control.percent = normalizeSliderPercentInput(slider.value);
    control.percentText = `${control.percent}%`;
    percentInput.value = control.percentText;
  });
  slider.addEventListener('change', () => {
    renderDashboardItem(item);
  });

  const percentInput = document.createElement('input');
  percentInput.type = 'text';
  percentInput.className = 'portfolio-actions-percent-input';
  percentInput.value = control.percentText || `${control.percent}%`;
  percentInput.setAttribute('aria-label', `Editar porcentaje de ${row.symbol}`);
  const commitPercent = () => {
    control.percent = normalizePercentInput(percentInput.value);
    control.percentText = `${control.percent}%`;
    renderDashboardItem(item);
  };
  percentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      percentInput.blur();
    }
  });
  percentInput.addEventListener('blur', commitPercent);

  wrapper.appendChild(slider);
  wrapper.appendChild(percentInput);
  return wrapper;
}

function createPortfolioPriceInput(item, row, control) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'portfolio-actions-price-input';
  input.value = control.priceText || '';
  input.placeholder = row.priceStep ? `Inc. ${formatPriceForInput(row.priceStep, row.priceStep)}` : 'Precio';
  input.setAttribute('aria-label', `Precio de venta para ${row.symbol}`);

  const commitPrice = () => {
    const normalized = normalizePriceToStep(input.value, row.priceStep);
    control.normalizedPrice = normalized;
    control.priceText = normalized === null ? '' : formatPriceForInput(normalized, row.priceStep);
    control.sellError = row.priceStep ? '' : 'Incremento no disponible; precio sin normalizar.';
    renderDashboardItem(item);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
  });
  input.addEventListener('blur', commitPrice);
  return input;
}

async function handlePortfolioSellClick(item, row) {
  if (!canSubmitSellOrder()) {
    setStatus('Venta no disponible: todavía no hay flujo de órdenes configurado.', 'error');
    return;
  }

  const control = getPortfolioControl(item, row);
  if (control.selling) {
    return;
  }

  const quantity = calculateSellQuantity(row.quantity, control.percent);
  const price = normalizePriceToStep(control.priceText, row.priceStep);

  if (quantity <= 0) {
    control.sellError = 'Cantidad inválida.';
  } else if (!price || price <= 0) {
    control.sellError = 'Indicá un precio válido.';
  } else if (!row.market) {
    control.sellError = 'Sin mercado para operar.';
  } else {
    control.sellError = '';
  }

  if (control.sellError) {
    renderDashboardItem(item);
    return;
  }

  const normalizedPrice = row.priceStep ? normalizePriceToStep(price, row.priceStep) : price;
  const formattedPrice = formatPriceForInput(normalizedPrice, row.priceStep);
  const plazo = row.plazo || 't2';
  const confirmed = await showDashboardConfirmDialog({
    title: 'Confirmar Venta',
    message: `Vender ${row.symbol} x${quantity} a ${formattedPrice}`,
    details: `${row.market} · ${plazo}`,
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar'
  });

  if (!confirmed) {
    return;
  }

  control.selling = true;
  control.sellError = '';
  renderDashboardItem(item);

  try {
    const response = await window.apiBroker.sellOrder({
      mercado: row.market,
      simbolo: row.symbol,
      tipoOrden: 'precioLimite',
      cantidad: quantity,
      precio: normalizedPrice,
      plazo,
    });

    if (!response || response.estado !== 'ok') {
      throw new Error(response?.mensaje || 'No se pudo enviar la orden.');
    }

    control.sellError = '';
    setStatus(`Orden de venta enviada: ${row.symbol} x${quantity}.`, 'ok');
    invalidateDashboardCache('portfolio');
    invalidateDashboardCache('operations');
    cancelDashboardRequestsByType('portfolioActions');
    cancelDashboardRequestsByType('summary');
    loadPortfolioActionsItem(item.id, { source: 'manual', force: true });
  } catch (error) {
    control.sellError = error.message || 'No se pudo enviar la orden.';
  } finally {
    control.selling = false;
    renderDashboardItem(item);
  }
}

function createPortfolioActionsRow(item, row) {
  const control = getPortfolioControl(item, row);
  const quantityToSell = calculateSellQuantity(row.quantity, control.percent);

  const tr = document.createElement('tr');

  const symbolCell = document.createElement('td');
  const symbolWrap = document.createElement('div');
  symbolWrap.className = 'portfolio-actions-symbol';

  const symbol = document.createElement('strong');
  symbol.textContent = row.symbol;
  symbolWrap.appendChild(symbol);
  symbolWrap.appendChild(createPortfolioPercentControl(item, row, control));
  if (control.sellError || row.priceStepError) {
    const error = document.createElement('span');
    error.className = control.sellError ? 'portfolio-actions-row-error' : 'portfolio-actions-row-note';
    error.textContent = control.sellError || row.priceStepError;
    symbolWrap.appendChild(error);
  }
  symbolCell.appendChild(symbolWrap);

  const quantityCell = document.createElement('td');
  quantityCell.textContent = formatOptionalNumber(row.quantity);

  const ppcCell = document.createElement('td');
  ppcCell.textContent = formatOptionalNumber(row.ppc);

  const upCell = document.createElement('td');
  upCell.textContent = formatOptionalNumber(row.up);

  const sellCell = document.createElement('td');
  const sellControls = document.createElement('div');
  sellControls.className = 'portfolio-actions-sell-controls';
  sellControls.appendChild(createPortfolioPriceInput(item, row, control));

  const quantityPreview = document.createElement('span');
  quantityPreview.className = 'portfolio-actions-quantity';
  quantityPreview.textContent = `x${quantityToSell}`;
  sellControls.appendChild(quantityPreview);

  const sellButton = document.createElement('button');
  sellButton.className = 'portfolio-actions-sell-btn';
  sellButton.type = 'button';
  sellButton.textContent = control.selling ? 'Enviando' : 'Vender';
  sellButton.disabled = !canSubmitSellOrder() || control.selling || !row.market || quantityToSell <= 0 || !control.priceText;
  if (!canSubmitSellOrder()) {
    sellButton.title = 'Venta no disponible: falta configurar el flujo de órdenes.';
  } else if (!row.market) {
    sellButton.title = 'Sin mercado para operar.';
  } else if (quantityToSell <= 0) {
    sellButton.title = 'Cantidad inválida.';
  } else if (!control.priceText) {
    sellButton.title = 'Indicá un precio.';
  } else {
    sellButton.title = 'Enviar orden de venta';
  }
  if (!sellButton.disabled) {
    sellButton.addEventListener('click', () => {
      handlePortfolioSellClick(item, row);
    });
  }
  sellControls.appendChild(sellButton);
  sellCell.appendChild(sellControls);

  tr.appendChild(symbolCell);
  tr.appendChild(quantityCell);
  tr.appendChild(ppcCell);
  tr.appendChild(upCell);
  tr.appendChild(sellCell);
  return tr;
}

function renderPortfolioActionsContent(container, item) {
  if (item.loading && item.portfolioRows.length === 0) {
    container.appendChild(createStateNode('Cargando portafolio...'));
    return;
  }
  if (item.error && item.portfolioRows.length === 0) {
    container.appendChild(createStateNode(item.error, 'error'));
    return;
  }
  if (item.portfolioRows.length === 0) {
    container.appendChild(createStateNode('No hay activos en el portafolio.'));
    return;
  }

  if (item.loading || item.stepsLoading) {
    container.appendChild(createUpdatingIndicator(item.loading ? 'Actualizando portafolio' : 'Detectando incrementos'));
  }
  if (item.error) {
    container.appendChild(createStateNode(item.error, 'error'));
  }

  const table = document.createElement('table');
  table.className = 'portfolio-actions-table';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const title of ['Símbolo', 'Cantidad', 'PPC', 'UP', '']) {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of item.portfolioRows) {
    tbody.appendChild(createPortfolioActionsRow(item, row));
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderPortfolioActionsObject(item, root) {
  root.appendChild(createObjectHeader(item, 'Acciones de portafolio', {
    showLastUpdated: true,
    showInterval: true,
    showRefreshControls: true,
    titleText: 'Acciones de portafolio'
  }));

  const body = document.createElement('div');
  body.className = 'dashboard-object-body portfolio-actions-body';

  const content = document.createElement('div');
  content.className = 'portfolio-actions-content';
  renderPortfolioActionsContent(content, item);

  body.appendChild(content);
  root.appendChild(body);
}

function renderDashboardItem(item) {
  const element = ensureDashboardObjectElement(item);
  updateItemFrame(item);

  const inner = element.querySelector('[data-dashboard-object-inner]');
  clearNode(inner);

  if (item.type === 'summary') {
    renderSummaryObject(item, inner);
  } else if (item.type === 'tradingview') {
    renderTradingViewObject(item, inner);
  } else if (item.type === 'flags') {
    renderFlagsObject(item, inner);
  } else if (item.type === 'portfolioActions') {
    renderPortfolioActionsObject(item, inner);
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
    portfolioRows: [],
    portfolioControls: {},
    stepsLoading: false,
    mode: 'compra',
    pendingExpanded: false,
    pendingCanceling: {},
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

function startDashboardItemDataLoad(item, options = {}) {
  if (!item || !activeUsername) {
    return;
  }

  if (item.type === 'summary') {
    loadSummaryItem(item.id, options);
    return;
  }
  if (item.type === 'flags') {
    loadFlagsStockOptions(item.id, options);
    return;
  }
  if (item.type === 'portfolioActions') {
    configurePortfolioActionsTimer(item);
    loadPortfolioActionsItem(item.id, options);
  }
}

function scheduleDashboardItemsDataLoad(items, options = {}) {
  const itemIds = items.map((item) => item.id);
  const loadItems = () => {
    for (const itemId of itemIds) {
      const item = getItemById(itemId);
      if (item) {
        startDashboardItemDataLoad(item, options);
      }
    }
  };

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(loadItems);
  } else {
    window.setTimeout(loadItems, 0);
  }
}

function addDashboardItem(type, position = null) {
  const item = buildDashboardItem(type, position);
  if (!item) {
    return;
  }

  dashboardItems.push(item);
  renderDashboardItem(item);
  syncEmptyState();

  scheduleDashboardItemsDataLoad([item], { source: 'manual' });
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

function configurePortfolioActionsTimer(item) {
  clearSummaryTimer(item);
  if (item.type !== 'portfolioActions' || !activeUsername || item.refreshPaused) {
    return;
  }

  item.timerId = setInterval(() => {
    loadPortfolioActionsItem(item.id, { source: 'auto' });
  }, item.refreshIntervalSec * 1000);
}

function cancelDashboardItemRequests(item) {
  if (!item) {
    return;
  }
  item.requestId += 1;
  item.sourcesRequestId += 1;
  item.loading = false;
  item.sourcesLoading = false;
  item.stepsLoading = false;
  item.tradingViewRenderToken = (item.tradingViewRenderToken || 0) + 1;
}

function cancelDashboardRequestsByType(type) {
  for (const item of dashboardItems) {
    if (item.type === type) {
      cancelDashboardItemRequests(item);
    }
  }
}

function removeDashboardItem(itemId) {
  const item = getItemById(itemId);
  if (item) {
    clearSummaryTimer(item);
    cancelDashboardItemRequests(item);
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
    cancelDashboardItemRequests(item);
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
    dashboardItems.push(item);
    renderDashboardItem(item);
  }

  dashboardLayerCounter = Math.max(dashboardLayerCounter, maxLayer);
  syncEmptyState();

  if (!activeUsername) {
    return;
  }

  scheduleDashboardItemsDataLoad(dashboardItems, { source: 'startup' });
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
    lastDashboardLayoutName = name;
    layoutNameInput.value = '';
    await refreshDashboardLayoutList(name);
    setStatus(`Diseño guardado: ${name}.`, 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo guardar el diseño.', 'error');
  } finally {
    saveLayoutButton.disabled = false;
  }
}

function renderDashboardLayoutOptions(layouts, selectedName = '') {
  clearNode(layoutSelect);
  layoutSelect.appendChild(createSelectOption('', layouts.length ? 'Diseños guardados' : 'Sin diseños'));
  for (const layout of layouts) {
    const option = createSelectOption(layout.name, layout.name);
    layoutSelect.appendChild(option);
  }
  layoutSelect.value = selectedName || '';
  layoutSelect.disabled = layouts.length === 0;
  if (deleteLayoutButton) {
    deleteLayoutButton.disabled = layouts.length === 0;
  }
}

async function refreshDashboardLayoutList(selectedName = '', options = {}) {
  try {
    const response = await window.apiBroker.listDashboardLayouts({
      includeLastLayout: Boolean(options.includeLastLayout)
    });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudieron cargar diseños.');
    }
    lastDashboardLayoutName = safeText(response.lastLayoutName, '').trim();
    renderDashboardLayoutOptions(
      Array.isArray(response.layouts) ? response.layouts : [],
      selectedName || lastDashboardLayoutName
    );
    return response;
  } catch (error) {
    renderDashboardLayoutOptions([]);
    setStatus(error.message || 'No se pudieron cargar diseños.', 'error');
    return null;
  }
}

async function loadDashboardLayoutByName(name, options = {}) {
  if (!name) {
    return;
  }

  if (!options.silent) {
    loadLayoutButton.disabled = true;
  }
  try {
    const response = await window.apiBroker.loadDashboardLayout({ name });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo cargar el diseño.');
    }
    applyDashboardLayout(response.layout);
    lastDashboardLayoutName = name;
    if (layoutSelect) {
      layoutSelect.value = name;
    }
    if (!options.silent) {
      setStatus(`Diseño cargado: ${name}.`, 'ok');
    }
  } catch (error) {
    if (!options.silent) {
      setStatus(error.message || 'No se pudo cargar el diseño.', 'error');
    }
  } finally {
    if (!options.silent) {
      loadLayoutButton.disabled = false;
    }
  }
}

async function loadDashboardLayout() {
  if (!layoutSelect.value) {
    await refreshDashboardLayoutList();
  }
  const name = safeText(layoutSelect.value, '').trim();
  if (!name) {
    setStatus(layoutSelect.disabled ? 'No hay diseños guardados.' : 'Elegí un diseño guardado.', 'error');
    layoutSelect?.focus();
    return;
  }

  await loadDashboardLayoutByName(name);
}

async function deleteDashboardLayout() {
  if (!layoutSelect.value) {
    await refreshDashboardLayoutList();
  }

  const name = safeText(layoutSelect.value, '').trim();
  if (!name) {
    setStatus(layoutSelect.disabled ? 'No hay diseños guardados.' : 'Elegí un diseño guardado.', 'error');
    layoutSelect?.focus();
    return;
  }

  const confirmed = await showDashboardConfirmDialog({
    title: 'Borrar Diseño',
    message: `Borrar ${name}?`,
    confirmLabel: 'Confirmar',
    cancelLabel: 'Cancelar'
  });
  if (!confirmed) {
    return;
  }

  deleteLayoutButton.disabled = true;
  try {
    const response = await window.apiBroker.deleteDashboardLayout({ name });
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo borrar el diseño.');
    }
    if (lastDashboardLayoutName === name) {
      lastDashboardLayoutName = safeText(response.lastLayoutName, '').trim();
    }
    if (layoutNameInput && layoutNameInput.value.trim() === name) {
      layoutNameInput.value = '';
    }
    await refreshDashboardLayoutList(lastDashboardLayoutName);
    setStatus(`Diseño borrado: ${name}.`, 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo borrar el diseño.', 'error');
  } finally {
    deleteLayoutButton.disabled = layoutSelect.disabled;
  }
}

function resetSummaryItemData(item) {
  item.operations = [];
  item.error = '';
  item.lastUpdatedAt = null;
  item.loading = false;
  item.pendingExpanded = false;
  item.pendingCanceling = {};
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
  if (!item || !isRefreshableItem(item)) {
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
  } else if (item.type === 'flags') {
    lastFlagsRefreshInterval = intervalSeconds;
    configureFlagsTimer(item);
  } else {
    lastPortfolioRefreshInterval = intervalSeconds;
    configurePortfolioActionsTimer(item);
  }
  renderDashboardItem(item);

  if (item.refreshPaused) {
    return;
  }

  if (item.type === 'summary' && item.selectedSymbol) {
    loadSummaryItem(item.id, { source: 'manual', force: true });
  } else if (item.type === 'flags' && item.selectedStock) {
    loadFlagsForItem(item.id, { source: 'manual', force: true });
  } else if (item.type === 'portfolioActions') {
    loadPortfolioActionsItem(item.id, { source: 'manual', force: true });
  }
}

function applySharedOperationsData(operations, refreshedAt, options = {}) {
  syncSummaryOperationsData(operations, refreshedAt);
  for (const summaryItem of dashboardItems) {
    if (summaryItem.type !== 'summary') {
      continue;
    }
    summaryItem.operations = summaryItem.selectedSymbol
      ? (operationsBySymbol.get(summaryItem.selectedSymbol) || [])
      : [];
    summaryItem.lastUpdatedAt = summaryItem.selectedSymbol ? refreshedAt : null;
    if (options.clearErrors) {
      summaryItem.error = '';
    }
  }

  if (options.renderSummaries) {
    renderSummaryDashboardItems();
  }
}

async function loadFlagsStockOptions(itemId, options = {}) {
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
    const [portfolioData, operationsData] = await Promise.all([
      getDashboardPortfolio({ force: Boolean(options.force) }),
      getDashboardOperations({ force: Boolean(options.force) }),
    ]);

    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.sourcesRequestId !== requestId) {
      return;
    }

    const portfolioResponse = portfolioData.response;
    const operationsResponse = operationsData.response;
    if (!Array.isArray(portfolioResponse.activos)) {
      throw new Error(portfolioResponse.mensaje || 'No se pudo cargar el portafolio.');
    }
    if (!Array.isArray(operationsResponse.operaciones)) {
      throw new Error(operationsResponse.mensaje || 'No se pudieron cargar operaciones recientes.');
    }
    applySharedOperationsData(operationsResponse.operaciones, operationsData.refreshedAt, { clearErrors: false });

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
  if (options.source !== 'auto' || !item.flags) {
    renderDashboardItem(item);
  }

  try {
    const quoteData = await getDashboardQuoteFlags({
      mercado: item.selectedStock.market,
      simbolo: item.selectedStock.symbol,
    }, {
      force: Boolean(options.force)
    });
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }

    const response = quoteData.response;
    if (response.estado !== 'ok' || !response.cotizacion) {
      throw new Error(response.mensaje || 'No se pudieron consultar puntas.');
    }

    latestItem.flags = response.cotizacion;
    latestItem.lastUpdatedAt = quoteData.refreshedAt;
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

async function loadPortfolioPriceSteps(itemId, requestId) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'portfolioActions' || item.requestId !== requestId) {
    return;
  }

  let cachedStepApplied = false;
  const rowsNeedingStep = item.portfolioRows.filter((row) => {
    if (!row.market) {
      return false;
    }
    if (applyCachedPriceStepToRow(row)) {
      cachedStepApplied = true;
      return false;
    }
    return true;
  });
  if (rowsNeedingStep.length === 0) {
    if (cachedStepApplied) {
      renderDashboardItem(item);
    }
    return;
  }

  item.stepsLoading = true;
  renderDashboardItem(item);

  await runWithConcurrency(rowsNeedingStep, DASHBOARD_PRICE_STEP_CONCURRENCY, async (row) => {
    try {
      const quoteData = await getDashboardQuoteFlags({
        mercado: row.market,
        simbolo: row.symbol,
      });
      const latestItem = getItemById(itemId);
      if (!latestItem || latestItem.requestId !== requestId) {
        return;
      }
      const latestRow = latestItem.portfolioRows.find((candidate) => candidate.key === row.key);
      if (!latestRow) {
        return;
      }
      const response = quoteData.response;
      if (response.estado !== 'ok' || !response.cotizacion) {
        throw new Error(response.mensaje || 'No se pudo detectar incremento.');
      }
      const step = derivePriceStepFromPrices(collectQuotePrices(response.cotizacion));
      latestRow.priceStep = step;
      latestRow.priceStepError = step ? '' : 'Incremento no disponible';
      writePortfolioPriceStepCache(latestRow.market, latestRow.symbol, step, latestRow.priceStepError);
      const control = getPortfolioControl(latestItem, latestRow);
      if (control.priceText) {
        const normalized = normalizePriceToStep(control.priceText, step);
        control.normalizedPrice = normalized;
        control.priceText = normalized === null ? '' : formatPriceForInput(normalized, step);
      }
    } catch (error) {
      const latestItem = getItemById(itemId);
      if (!latestItem || latestItem.requestId !== requestId) {
        return;
      }
      const latestRow = latestItem.portfolioRows.find((candidate) => candidate.key === row.key);
      if (latestRow) {
        latestRow.priceStep = null;
        latestRow.priceStepError = error.message || 'Incremento no disponible';
        writePortfolioPriceStepCache(latestRow.market, latestRow.symbol, null, latestRow.priceStepError);
      }
    }
  });

  const latestItem = getItemById(itemId);
  if (!latestItem || latestItem.requestId !== requestId) {
    return;
  }
  latestItem.stepsLoading = false;
  renderDashboardItem(latestItem);
}

async function loadPortfolioActionsItem(itemId, options = {}) {
  const item = getItemById(itemId);
  if (!item || item.type !== 'portfolioActions' || !activeUsername || item.loading) {
    return;
  }

  const requestId = item.requestId + 1;
  item.requestId = requestId;
  item.loading = true;
  item.error = '';
  if (options.source !== 'auto' || item.portfolioRows.length === 0) {
    renderDashboardItem(item);
  }

  try {
    const portfolioData = await getDashboardPortfolio({ force: Boolean(options.force) });
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }

    const response = portfolioData.response;
    if (!Array.isArray(response.activos)) {
      throw new Error(response.mensaje || 'No se pudo cargar el portafolio.');
    }

    const previousControls = latestItem.portfolioControls || {};
    const rows = normalizePortfolioActionRows(response);
    for (const row of rows) {
      applyCachedPriceStepToRow(row);
    }
    latestItem.portfolioRows = rows;
    latestItem.portfolioControls = {};
    for (const row of rows) {
      latestItem.portfolioControls[row.key] = previousControls[row.key] || undefined;
      getPortfolioControl(latestItem, row);
    }
    latestItem.lastUpdatedAt = portfolioData.refreshedAt;
    latestItem.error = '';
    latestItem.loading = false;
    renderDashboardItem(latestItem);
    loadPortfolioPriceSteps(itemId, requestId);

    if (options.source !== 'auto') {
      setStatus('Acciones de portafolio actualizadas.', 'ok');
    }
  } catch (error) {
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }
    latestItem.error = error.message || 'No se pudo cargar el portafolio.';
    latestItem.loading = false;
    latestItem.stepsLoading = false;
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
  if (options.source !== 'auto' || item.operations.length === 0) {
    renderDashboardItem(item);
  }

  try {
    const operationsData = await getDashboardOperations({ force: Boolean(options.force) });
    const latestItem = getItemById(itemId);
    if (!latestItem || latestItem.requestId !== requestId) {
      return;
    }

    const response = operationsData.response;
    if (!Array.isArray(response.operaciones)) {
      throw new Error(response.mensaje || 'Error al consultar operaciones.');
    }

    const refreshedAt = operationsData.refreshedAt;
    applySharedOperationsData(response.operaciones, refreshedAt, { clearErrors: false });
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
}

function renderAccountDependentItems() {
  for (const item of dashboardItems) {
    if (item.type !== 'tradingview') {
      renderDashboardItem(item);
    }
  }
  syncEmptyState();
}

async function refreshActiveAccount(options = {}) {
  const refreshRequestId = activeAccountRefreshRequestId + 1;
  activeAccountRefreshRequestId = refreshRequestId;
  try {
    const response = await window.apiBroker.listAccounts();
    if (refreshRequestId !== activeAccountRefreshRequestId) {
      return;
    }
    if (response.estado !== 'ok') {
      throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
    }

    const nextUsername = safeText(response.active_username, '').trim();
    const changed = nextUsername !== activeUsername;
    activeUsername = nextUsername;
    setPaletteEnabled(Boolean(activeUsername));

    if (!activeUsername) {
      invalidateDashboardCache('operations');
      invalidateDashboardCache('portfolio');
      invalidateDashboardCache('quoteFlags');
      portfolioPriceStepCache.clear();
      for (const item of dashboardItems) {
        if (isRefreshableItem(item)) {
          clearSummaryTimer(item);
        }
        cancelDashboardItemRequests(item);
      }
      renderAccountDependentItems();
      setStatus('No hay cuenta activa.', 'error');
      return;
    }

    if (changed) {
      invalidateDashboardCache('operations');
      invalidateDashboardCache('portfolio');
      invalidateDashboardCache('quoteFlags');
      portfolioPriceStepCache.clear();
      for (const item of dashboardItems) {
        if (item.type === 'summary') {
          resetSummaryItemData(item);
          configureSummaryTimer(item);
        } else if (item.type === 'flags') {
          clearSummaryTimer(item);
          cancelDashboardItemRequests(item);
          item.stockOptions = [];
          item.selectedStockKey = '';
          item.selectedStock = null;
          item.sourcesError = '';
          item.flags = null;
          item.error = '';
          item.lastUpdatedAt = null;
        } else if (item.type === 'portfolioActions') {
          clearSummaryTimer(item);
          cancelDashboardItemRequests(item);
          item.portfolioRows = [];
          item.portfolioControls = {};
          item.error = '';
          item.loading = false;
          item.stepsLoading = false;
          item.lastUpdatedAt = null;
        }
      }
      renderAccountDependentItems();
      scheduleDashboardItemsDataLoad(dashboardItems, {
        source: options.initial ? 'startup' : 'manual',
        force: Boolean(options.force)
      });
    }
  } catch (error) {
    if (refreshRequestId !== activeAccountRefreshRequestId) {
      return;
    }
    activeUsername = '';
    setPaletteEnabled(false);
    invalidateDashboardCache('operations');
    invalidateDashboardCache('portfolio');
    invalidateDashboardCache('quoteFlags');
    portfolioPriceStepCache.clear();
    for (const item of dashboardItems) {
      if (isRefreshableItem(item)) {
        clearSummaryTimer(item);
        cancelDashboardItemRequests(item);
      }
    }
    renderAccountDependentItems();
    setStatus(error.message || 'No se pudo cargar la cuenta activa.', 'error');
  }
}

function handleWindowResize() {
  for (const item of dashboardItems) {
    updateItemFrame(item);
  }
}

async function initialize() {
  const perf = startDashboardPerf('startup');
  syncEmptyState();
  setPaletteEnabled(false);

  const layoutListPromise = refreshDashboardLayoutList('', { includeLastLayout: true });
  const accountPromise = refreshActiveAccount({ initial: true });

  const layoutResponse = await layoutListPromise;
  if (layoutResponse?.lastLayoutName && !autoLoadedLastLayout) {
    autoLoadedLastLayout = true;
    if (layoutResponse.lastLayout) {
      applyDashboardLayout(layoutResponse.lastLayout);
      lastDashboardLayoutName = safeText(layoutResponse.lastLayoutName, '').trim();
      if (layoutSelect) {
        layoutSelect.value = lastDashboardLayoutName;
      }
    } else {
      await loadDashboardLayoutByName(layoutResponse.lastLayoutName, { silent: true });
    }
  }

  await accountPromise;
  setPaletteEnabled(Boolean(activeUsername));
  finishDashboardPerf(perf, {
    items: dashboardItems.length,
    hasAccount: Boolean(activeUsername),
    lastLayout: lastDashboardLayoutName || ''
  });
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
deleteLayoutButton.addEventListener('click', deleteDashboardLayout);
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
    if (isRefreshableItem(item)) {
      clearSummaryTimer(item);
    }
    cancelDashboardItemRequests(item);
  }
});

initialize();
