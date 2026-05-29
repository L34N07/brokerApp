# BrokerApp

BrokerApp is an Electron desktop app for IOL Broker. The desktop shell is JavaScript and HTML, while broker/API work is handled by a Python command backend.

## Project Structure

```text
backend/
  broker_backend.py        Python CLI backend used by Electron
  __init__.py
src/
  electron/
    main.js                Electron main process, windows, IPC, Python runner
    preload.js             Safe renderer IPC bridge
  renderer/
    login.html             Login and saved-account screen
    index.html             Main portfolio/account-status screen
    operaciones.html       Operations screen
    simbolos.html          Symbol search screen
    scripts/               Renderer JavaScript
    styles/                Renderer CSS
  backend/
    script.py              Python CLI backend used by Electron
docs/
  DESKTOP_BUILD.md         Packaging notes
examples/
  credentials.example.json Example saved credentials payload
  token.example.json       Example saved token payload
tests/
  test_script.py           Python backend unit tests
requirements.txt           Python runtime dependencies
requirements-dev.txt       Runtime plus build/development dependencies
package.json               Electron scripts and packaging config
```

`.venv`, `node_modules`, `build`, `dist`, local credentials, and local tokens are generated/local files and are ignored by Git.

## How It Works

Electron starts at `src/electron/main.js` and opens the login window first. Renderer pages call `window.apiBroker`, which is exposed by `src/electron/preload.js`.

The main process handles those IPC calls by spawning the Python backend:

```text
src/backend/script.py <command> <json-payload>
```

The Python backend prints one JSON response to stdout. The main process parses that response and returns it to the renderer.

Supported backend commands are visible in `src/backend/script.py` and include:

- `list-accounts`
- `login`
- `select-account`
- `delete-account`
- `logout`
- `check-token`
- `portfolio`
- `account-status`
- `symbol-search-config`
- `symbols`
- `operations`

In development, Electron chooses Python in this order:

1. `PYTHON_BIN`, if set.
2. `.venv/bin/python` on Linux/macOS or `.venv\Scripts\python.exe` on Windows, if executable.
3. `python3` on Linux/macOS or `python` on Windows.

In a packaged app, Electron runs the bundled `broker-backend` binary from its resources instead of a local Python interpreter.

## Setup

Install Node dependencies and create the Python virtual environment:

```sh
npm run setup
```

That runs `npm install` and then:

```sh
python3 -m venv --clear .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-dev.txt
```

After npm installs JavaScript dependencies, `postinstall` runs `scripts/ensure-electron.js` to verify that the native Electron binary for the current platform exists and is executable. This matters for restored backups because `node_modules` can contain stale Windows Electron files or non-executable launchers.

On Windows, use:

```powershell
npm install
npm run setup:python:win
```

`requirements.txt` contains runtime Python dependencies. `requirements-dev.txt` includes runtime dependencies plus PyInstaller for desktop backend builds.

## Run The App

After setup:

```sh
npm start
```

The start script launches Electron with `ELECTRON_RUN_AS_NODE` unset, which avoids a Linux shell environment variable that can make Electron behave like Node instead of opening the desktop app.

Electron will use `.venv` automatically. To force a specific Python interpreter:

```sh
PYTHON_BIN=/path/to/python npm start
```

The login screen lets you add/select/delete saved IOL accounts. The app stores account/token data outside the app source when launched through Electron by setting `BROKERAPP_DATA_DIR` to Electron's user-data directory.

## Symbol Search Window

The main screen includes a **Símbolos** navigation entry. It opens a separate Electron window, matching the existing **Operaciones** window behavior. The window lets you select a documented IOL market and search the symbols returned for that market.

The symbol search flow is:

1. The renderer asks `symbol-search-config` for the supported market values from the local API documentation: `bCBA`, `nYSE`, `nASDAQ`, `aMEX`, `bCS`, and `rOFX`.
2. When a market and instrument are selected, the renderer calls the `symbols` backend command.
3. The backend gets a valid IOL token using the same token/refresh logic as the rest of the app.
4. The backend discovers available instruments for the documented country values `argentina` and `estados_Unidos` through:

```text
GET /api/v2/{pais}/Titulos/Cotizacion/Instrumentos
```

5. By default, it loads stocks with the `Acciones` instrument through:

```text
GET /api/v2/Cotizaciones/{Instrumento}/{Pais}/Todos
```

6. The backend filters the returned `titulos` by the selected `mercado` field and returns normalized symbol rows to the renderer. The IOL quote-list response can return numeric market codes, so the backend maps those codes back to the documented market names before filtering.

To keep the window responsive, symbol lookup uses a shorter per-request timeout than the rest of the API by default, runs instrument quote requests in parallel, and starts with the most likely country for the selected market before falling back to the other documented country.

Search filtering is client-side after the market symbols are loaded. It matches useful fields from the API response, including symbol, description, market, country, instrument/type, currency, and term. Results are displayed as compact rows: symbol and description on the left, currency and last price on the right. The instrument selector defaults to `Acciones` so stock searches such as `YPFD` are not mixed with option contracts.

Selecting a row marks it as the active symbol and loads a TradingView Advanced Chart widget for that symbol. TradingView symbols use `{exchange}:{symbol}` format, so the renderer maps IOL markets before embedding the chart:

| IOL market | TradingView exchange |
| --- | --- |
| `bCBA` | `BCBA` |
| `nYSE` | `NYSE` |
| `nASDAQ` | `NASDAQ` |
| `aMEX` | `AMEX` |
| `bCS` | `BCS` |
| `rOFX` | `ROFX` |

The embedded chart is intended for `Acciones`. If the selected row has no known TradingView exchange format or is not a stock instrument, the chart area shows a non-crashing unsupported-state message while search remains usable.

No additional setup or configuration is required for this window.

## Backend CLI

You can run backend commands directly for quick checks:

```sh
./.venv/bin/python src/backend/script.py list-accounts
```

## Tests

Run the Python tests with the virtual environment:

```sh
npm test
```

On Windows:

```powershell
npm run test:win
```

## Configuration

The backend reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROKERAPP_DATA_DIR` | Electron user-data dir in app flow, project root for direct dev CLI, `~/.brokerapp` for frozen direct runs | Directory for `credentials.json` and `token.json` |
| `PYTHON_BIN` | unset | Overrides the Python interpreter Electron uses in development |
| `IOL_USERNAME` | unset | Optional username override |
| `IOL_PASSWORD` | unset | Optional password override |
| `IOL_ACCESS_TOKEN` | unset | Optional access-token override |
| `IOL_API_BASE_URL` | `https://api.invertironline.com` | IOL API base URL |
| `IOL_PORTFOLIO_COUNTRY` | `argentina` | Country segment for portfolio requests |
| `IOL_REQUEST_TIMEOUT_SECONDS` | `10` | HTTP request timeout |
| `IOL_SYMBOL_SEARCH_TIMEOUT_SECONDS` | `IOL_REQUEST_TIMEOUT_SECONDS` | Per-request timeout for symbol search instrument/quote calls |
| `IOL_SYMBOL_SEARCH_MAX_WORKERS` | `6` | Maximum parallel quote requests for symbol search |
| `IOL_SYMBOL_SEARCH_DEFAULT_INSTRUMENT` | `Acciones` | Default instrument loaded in the symbol search window |
| `BROKERAPP_SYMBOL_SEARCH_TIMEOUT_MS` | `45000` | Electron-side timeout for the full `symbols` backend command |
| `IOL_TOKEN_REFRESH_MARGIN_SECONDS` | `10` | Token refresh safety margin |
| `IOL_DEFAULT_BEARER_EXPIRATION_SECONDS` | `900` | Fallback bearer token lifetime |
| `IOL_MAX_STORED_ACCOUNTS` | `2` | Maximum saved accounts |

Local `credentials.json` and `token.json` are not committed. Example formats live in `examples/`.

## Build

Build the Python backend and package the app:

```sh
npm run build:linux
```

For Windows installers, run on Windows:

```powershell
npm install
npm run setup:python:win
npm run build:desktop:win
```

More packaging notes are in `docs/DESKTOP_BUILD.md`.
