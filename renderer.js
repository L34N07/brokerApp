const statusText = document.getElementById('status-text');
const fetchButton = document.getElementById('btn-load-portfolio');
const portfolioContainer = document.getElementById('portfolio');

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

function setStatus(message, tone = 'neutral') {
  statusText.textContent = message;
  statusText.className = `status-text ${tone}`;
}

function clearPortfolio() {
  while (portfolioContainer.firstChild) {
    portfolioContainer.removeChild(portfolioContainer.firstChild);
  }
}

function renderError(message) {
  clearPortfolio();
  const block = document.createElement('div');
  block.className = 'response-block';
  block.textContent = safeText(message, 'Ocurrió un error inesperado.');
  portfolioContainer.appendChild(block);
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

function renderPortfolio(data) {
  clearPortfolio();

  const header = document.createElement('div');
  header.className = 'portfolio-header';
  header.textContent = `Portafolio ${safeText(data.pais, '')}`.trim();
  portfolioContainer.appendChild(header);

  const table = document.createElement('table');
  table.className = 'portfolio-table';

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
  for (const activo of data.activos) {
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

async function checkTokenOnStartup() {
  setStatus('Verificando token...', 'neutral');
  const response = await window.apiBroker.checkToken();

  if (response.estado === 'conectado') {
    setStatus(response.mensaje || 'Token válido.', 'ok');
    return true;
  }

  setStatus(response.mensaje || 'No se pudo validar el token.', 'error');
  return false;
}

async function loadPortfolio() {
  fetchButton.disabled = true;
  setStatus('Consultando portafolio...', 'neutral');

  try {
    const response = await window.apiBroker.getPortfolio();

    if (Array.isArray(response.activos)) {
      renderPortfolio(response);
      setStatus('Portafolio actualizado.', 'ok');
      return;
    }

    if (response.estado === 'desconectado' || response.estado === 'error') {
      renderError(response.mensaje);
      setStatus(response.mensaje || 'Error al consultar portafolio.', 'error');
      return;
    }

    renderError(JSON.stringify(response, null, 2));
    setStatus('Respuesta inesperada del backend.', 'error');
  } catch (error) {
    renderError(error.message);
    setStatus(error.message, 'error');
  } finally {
    fetchButton.disabled = false;
  }
}

fetchButton.addEventListener('click', () => {
  loadPortfolio();
});

checkTokenOnStartup();
