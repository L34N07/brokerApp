const marketSelect = document.getElementById('symbol-market');
const instrumentSelect = document.getElementById('symbol-instrument');
const searchInput = document.getElementById('symbol-search');
const reloadButton = document.getElementById('btn-reload-symbols');
const refreshText = document.getElementById('symbols-refresh-text');
const resultsList = document.getElementById('symbol-results-list');
const emptyState = document.getElementById('symbols-empty');
const resultsCountText = document.getElementById('symbol-results-count');
const activeSymbolTitle = document.getElementById('active-symbol-title');
const activeSymbolMeta = document.getElementById('active-symbol-meta');
const tradingViewChart = document.getElementById('tradingview-chart');

let activeUsername = '';
let markets = [];
let activeMarket = '';
let activeInstrument = 'Acciones';
let availableInstruments = ['Acciones'];
let allSymbols = [];
let activeSymbol = null;
let isLoading = false;
let loadRequestId = 0;
let resultsErrorMessage = '';
let toastNode = null;
let toastTimeoutId = null;
const DEFAULT_INSTRUMENT = 'Acciones';
const ALL_INSTRUMENTS_VALUE = 'todos';
const TRADINGVIEW_EXCHANGE_BY_MARKET = {
  bCBA: 'BCBA',
  nYSE: 'NYSE',
  nASDAQ: 'NASDAQ',
  aMEX: 'AMEX',
  bCS: 'BCS',
  rOFX: 'ROFX'
};
const TRADINGVIEW_WIDGET_SCRIPT_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

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

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, decimals = 2) {
  const number = toNumber(value);
  if (number === null) {
    return '-';
  }

  const rounded = Number(number.toFixed(decimals));
  if (Number.isInteger(rounded)) {
    return integerNumberFormatter.format(rounded);
  }
  return decimalNumberFormatter.format(rounded);
}

function formatPrice(value) {
  const number = toNumber(value);
  if (number === null) {
    return '-';
  }
  return decimalNumberFormatter.format(number);
}

function formatPercent(value) {
  const number = toNumber(value);
  if (number === null) {
    return '-';
  }
  return `${formatNumber(number)}%`;
}

function movementClass(value) {
  const number = toNumber(value);
  if (number === null || number === 0) {
    return '';
  }
  return number < 0 ? 'loss' : 'profit';
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
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

function setControlsEnabled() {
  const hasMarkets = markets.length > 0;
  marketSelect.disabled = isLoading || !activeUsername || !hasMarkets;
  instrumentSelect.disabled = isLoading || !activeUsername || availableInstruments.length === 0;
  searchInput.disabled = isLoading || !activeUsername || allSymbols.length === 0;
  reloadButton.disabled = isLoading || !activeUsername || !activeMarket;
}

function setRefreshText(detail = '') {
  const market = activeMarket || '--';
  const instrument = activeInstrument || DEFAULT_INSTRUMENT;
  refreshText.textContent = detail
    ? `Mercado: ${market} · ${instrument} · ${detail}`
    : `Mercado: ${market} · ${instrument}`;
}

function getSymbolKey(symbol) {
  return [
    safeText(symbol.mercado, '').toLowerCase(),
    safeText(symbol.simbolo, '').toLowerCase(),
    safeText(symbol.plazo, '').toLowerCase(),
    safeText(symbol.moneda, '').toLowerCase(),
    safeText(symbol.instrumento, '').toLowerCase()
  ].join('::');
}

function buildSearchText(symbol) {
  return [
    symbol.simbolo,
    symbol.descripcion,
    symbol.mercado,
    symbol.pais,
    symbol.instrumento,
    symbol.tipo,
    symbol.moneda,
    symbol.plazo
  ].map((value) => safeText(value, '').toLowerCase()).join(' ');
}

function getDescription(symbol) {
  return safeText(symbol.descripcion, safeText(symbol.tipo, safeText(symbol.instrumento, 'Sin descripción')));
}

function resolveTradingViewSymbol(symbol) {
  if (!symbol) {
    return null;
  }
  if (safeText(symbol.instrumento, '').toLowerCase() !== DEFAULT_INSTRUMENT.toLowerCase()) {
    return null;
  }

  const market = safeText(symbol.mercado, '');
  const exchange = TRADINGVIEW_EXCHANGE_BY_MARKET[market];
  const rawSymbol = safeText(symbol.simbolo, '').toUpperCase();
  if (!exchange || !rawSymbol) {
    return null;
  }
  return `${exchange}:${rawSymbol}`;
}

function renderChartState(message, tone = 'neutral') {
  clearNode(tradingViewChart);
  const state = document.createElement('p');
  state.className = tone === 'error' ? 'empty-state error' : 'empty-state';
  state.textContent = message;
  tradingViewChart.appendChild(state);
}

function renderTradingViewChart(symbol) {
  activeSymbolTitle.textContent = symbol ? safeText(symbol.simbolo, 'Gráfico') : 'Gráfico';
  activeSymbolMeta.textContent = symbol
    ? `${getDescription(symbol)} · ${safeText(symbol.mercado)} · ${safeText(symbol.moneda)}`
    : 'Sin símbolo seleccionado';

  const tradingViewSymbol = resolveTradingViewSymbol(symbol);
  if (!symbol) {
    renderChartState('Seleccioná un símbolo para ver el gráfico.');
    return;
  }
  if (!tradingViewSymbol) {
    renderChartState('No hay formato de TradingView disponible para este símbolo.', 'error');
    return;
  }

  clearNode(tradingViewChart);

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
    symbol: tradingViewSymbol,
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
  script.addEventListener('error', () => {
    renderChartState('No se pudo cargar el gráfico de TradingView.', 'error');
  });

  container.appendChild(widget);
  container.appendChild(script);
  tradingViewChart.appendChild(container);
}

function selectSymbol(symbol, options = {}) {
  activeSymbol = symbol || null;
  renderResults();
  renderTradingViewChart(activeSymbol);

  if (activeSymbol && !options.silent) {
    setStatus(`Símbolo seleccionado: ${safeText(activeSymbol.simbolo)}.`, 'ok');
  }
}

function buildSymbolResultRow(symbol) {
  const key = getSymbolKey(symbol);
  const activeKey = activeSymbol ? getSymbolKey(activeSymbol) : '';
  const isActive = key === activeKey;

  const row = document.createElement('button');
  row.type = 'button';
  row.className = `symbol-result-row ${isActive ? 'active' : ''}`.trim();
  row.setAttribute('aria-pressed', String(isActive));
  row.addEventListener('click', () => {
    selectSymbol(symbol);
  });

  const title = document.createElement('span');
  title.className = 'symbol-result-title';

  const symbolTitle = document.createElement('span');
  symbolTitle.className = 'symbol-result-symbol';
  symbolTitle.textContent = safeText(symbol.simbolo);

  const description = document.createElement('p');
  description.className = 'symbol-result-desc';
  description.textContent = getDescription(symbol);

  title.appendChild(symbolTitle);
  title.appendChild(description);

  const quote = document.createElement('span');
  quote.className = 'symbol-result-quote';

  const currency = document.createElement('span');
  currency.className = 'symbol-result-currency';
  currency.textContent = safeText(symbol.moneda);

  const price = document.createElement('span');
  price.className = 'symbol-result-price';
  price.textContent = formatPrice(symbol.ultimoPrecio);

  quote.appendChild(currency);
  quote.appendChild(price);

  row.appendChild(title);
  row.appendChild(quote);
  return row;
}

function getFilteredSymbols() {
  const query = safeText(searchInput.value, '').toLowerCase();
  if (!query) {
    return allSymbols;
  }
  return allSymbols.filter((symbol) => buildSearchText(symbol).includes(query));
}

function showEmptyState(message, tone = 'neutral') {
  clearNode(resultsList);
  emptyState.hidden = false;
  emptyState.textContent = message;
  emptyState.className = tone === 'error' ? 'empty-state error' : 'empty-state';
}

function renderResults() {
  if (isLoading) {
    resultsCountText.textContent = '0';
    showEmptyState('Cargando símbolos...');
    return;
  }

  const filteredSymbols = getFilteredSymbols();
  resultsCountText.textContent = allSymbols.length === filteredSymbols.length
    ? String(filteredSymbols.length)
    : `${filteredSymbols.length}/${allSymbols.length}`;

  clearNode(resultsList);
  emptyState.hidden = true;

  if (resultsErrorMessage) {
    resultsCountText.textContent = '0';
    showEmptyState(resultsErrorMessage, 'error');
    return;
  }

  if (allSymbols.length === 0) {
    showEmptyState('No hay símbolos disponibles para este mercado.');
    return;
  }

  if (filteredSymbols.length === 0) {
    showEmptyState('No hay símbolos para la búsqueda actual.');
    return;
  }

  for (const symbol of filteredSymbols) {
    resultsList.appendChild(buildSymbolResultRow(symbol));
  }
}

function renderMarketOptions(defaultMarket) {
  clearNode(marketSelect);

  for (const market of markets) {
    const code = typeof market === 'string' ? market : market.codigo;
    const name = typeof market === 'string' ? market : market.nombre || market.codigo;
    if (!code) {
      continue;
    }
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name || code;
    marketSelect.appendChild(option);
  }

  const fallbackMarket = defaultMarket || markets[0]?.codigo || markets[0] || '';
  if (fallbackMarket) {
    marketSelect.value = fallbackMarket;
  }
}

function renderInstrumentOptions(selectedInstrument = activeInstrument) {
  clearNode(instrumentSelect);

  const normalizedSelected = safeText(selectedInstrument, DEFAULT_INSTRUMENT);
  const instruments = [];
  for (const instrument of availableInstruments) {
    const text = safeText(instrument, '');
    if (text && !instruments.some((item) => item.toLowerCase() === text.toLowerCase())) {
      instruments.push(text);
    }
  }

  if (!instruments.some((item) => item.toLowerCase() === DEFAULT_INSTRUMENT.toLowerCase())) {
    instruments.unshift(DEFAULT_INSTRUMENT);
  }

  for (const instrument of instruments) {
    const option = document.createElement('option');
    option.value = instrument;
    option.textContent = instrument;
    instrumentSelect.appendChild(option);
  }

  const allOption = document.createElement('option');
  allOption.value = ALL_INSTRUMENTS_VALUE;
  allOption.textContent = 'Todos';
  instrumentSelect.appendChild(allOption);

  const canPreserveSelection = Array.from(instrumentSelect.options).some(
    (option) => option.value.toLowerCase() === normalizedSelected.toLowerCase()
  );
  instrumentSelect.value = canPreserveSelection ? normalizedSelected : DEFAULT_INSTRUMENT;
}

function syncActiveSymbolWithLatestData() {
  if (!activeSymbol) {
    return;
  }
  const activeKey = getSymbolKey(activeSymbol);
  for (const symbol of allSymbols) {
    const key = getSymbolKey(symbol);
    if (key === activeKey) {
      activeSymbol = symbol;
      return;
    }
  }
}

async function loadSymbolsForMarket(market, instrument = instrumentSelect.value || DEFAULT_INSTRUMENT) {
  const nextMarket = safeText(market, '');
  if (!nextMarket || !activeUsername) {
    return;
  }
  const nextInstrument = safeText(instrument, DEFAULT_INSTRUMENT);

  const requestId = loadRequestId + 1;
  loadRequestId = requestId;
  isLoading = true;
  activeMarket = nextMarket;
  activeInstrument = nextInstrument;
  allSymbols = [];
  resultsErrorMessage = '';
  setRefreshText('cargando');
  setControlsEnabled();
  renderResults();
  setStatus(`Consultando ${nextInstrument} ${nextMarket} (${activeUsername})...`, 'neutral');

  try {
    const response = await window.apiBroker.getSymbols({ mercado: nextMarket, instrumento: nextInstrument });
    if (requestId !== loadRequestId) {
      return;
    }

    if (response.estado !== 'ok' || !Array.isArray(response.simbolos)) {
      throw new Error(response.mensaje || 'Respuesta inesperada al consultar símbolos.');
    }

    activeMarket = safeText(response.mercado, nextMarket);
    activeInstrument = safeText(response.instrumento, nextInstrument);
    if (Array.isArray(response.instrumentosDisponibles) && response.instrumentosDisponibles.length > 0) {
      availableInstruments = response.instrumentosDisponibles;
      renderInstrumentOptions(activeInstrument);
    }
    allSymbols = response.simbolos;
    syncActiveSymbolWithLatestData();
    if (!activeSymbol && allSymbols.length > 0) {
      activeSymbol = allSymbols[0];
    }
    if (activeSymbol) {
      renderTradingViewChart(activeSymbol);
    } else {
      renderTradingViewChart(null);
    }
    setRefreshText(`${allSymbols.length} símbolos`);
    setStatus(`${activeInstrument} cargados: ${allSymbols.length}.`, response.errores?.length ? 'neutral' : 'ok');
  } catch (error) {
    if (requestId !== loadRequestId) {
      return;
    }
    allSymbols = [];
    resultsErrorMessage = error.message || 'Error al cargar símbolos.';
    setRefreshText('error');
    setStatus(resultsErrorMessage, 'error');
  } finally {
    if (requestId === loadRequestId) {
      isLoading = false;
      setControlsEnabled();
      renderResults();
    }
  }
}

async function loadConfig() {
  const response = await window.apiBroker.getSymbolSearchConfig();
  if (response.estado !== 'ok' || !Array.isArray(response.mercados)) {
    throw new Error(response.mensaje || 'No se pudo cargar la configuración de mercados.');
  }
  if (response.mercados.length === 0) {
    throw new Error('No hay mercados disponibles para buscar símbolos.');
  }

  markets = response.mercados;
  renderMarketOptions(response.mercado_default);
  renderInstrumentOptions(DEFAULT_INSTRUMENT);
  activeMarket = marketSelect.value;
  activeInstrument = instrumentSelect.value;
}

async function refreshActiveAccount() {
  const response = await window.apiBroker.listAccounts();
  if (response.estado !== 'ok') {
    throw new Error(response.mensaje || 'No se pudo cargar la cuenta activa.');
  }

  activeUsername = safeText(response.active_username, '').trim();
  if (!activeUsername) {
    throw new Error('No hay cuenta activa. Iniciá sesión.');
  }
}

async function initialize() {
  renderTradingViewChart(null);
  setControlsEnabled();
  showEmptyState('Cargando símbolos...');

  try {
    await refreshActiveAccount();
    await loadConfig();
    setControlsEnabled();
    await loadSymbolsForMarket(activeMarket);
  } catch (error) {
    activeUsername = '';
    allSymbols = [];
    isLoading = false;
    resultsErrorMessage = error.message || 'No se pudo iniciar el buscador.';
    setRefreshText('error');
    setControlsEnabled();
    showEmptyState(resultsErrorMessage, 'error');
    setStatus(resultsErrorMessage, 'error');
  }
}

marketSelect.addEventListener('change', () => {
  searchInput.value = '';
  activeInstrument = DEFAULT_INSTRUMENT;
  activeSymbol = null;
  renderTradingViewChart(null);
  instrumentSelect.value = DEFAULT_INSTRUMENT;
  loadSymbolsForMarket(marketSelect.value, DEFAULT_INSTRUMENT);
});

instrumentSelect.addEventListener('change', () => {
  searchInput.value = '';
  activeSymbol = null;
  renderTradingViewChart(null);
  loadSymbolsForMarket(marketSelect.value, instrumentSelect.value);
});

searchInput.addEventListener('input', () => {
  renderResults();
});

reloadButton.addEventListener('click', () => {
  loadSymbolsForMarket(marketSelect.value, instrumentSelect.value);
});

window.addEventListener('focus', () => {
  refreshActiveAccount().catch(() => {});
});

initialize();
