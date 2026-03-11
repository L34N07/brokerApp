# Desktop build (Electron + bundled Python backend)

## Current layout

- `src/electron/`: Electron main/preload entry points.
- `src/renderer/`: HTML views plus `scripts/` for renderer logic.
- `src/backend/script.py`: Python backend used in development and for PyInstaller builds.
- `docs/`: project documentation.
- `examples/`: sample credential/token payloads for local setup.

This app now runs Python in two modes:

- Development: runs `src/backend/script.py` with your local Python (`PYTHON_BIN` or `python3`).
- Packaged app: runs a bundled backend binary from Electron resources (`broker-backend.exe` on Windows).

## 1) Install dependencies (PEP 668-safe)

```sh
npm install
npm run setup:python
```

## 2) Build desktop app

```sh
npm run build:desktop
```

That command does:

1. `pyinstaller --onefile` for `src/backend/script.py` (`dist/broker-backend.exe` on Windows).
2. `electron-builder --win` to create the installer in `dist/`.

## Notes

- To generate a Windows installer (`.exe`), run the build on Windows.
- `credentials.json` and `token.json` are excluded from packaged files.
- Example local payloads live in `examples/`.
- If `.venv` does not exist, run `npm run setup:python` first.

## Run on Linux (development)

```sh
PYTHON_BIN=./.venv/bin/python npm start
```

## Build Linux app with icon/double-click

```sh
npm run build:linux
chmod +x dist/*.AppImage
```

Then open the generated `dist/*.AppImage` by double click.

## Build Windows executable installer (recommended on Windows)

From PowerShell in project root:

```powershell
npm install
npm run setup:python:win
npm run build:desktop:win
```

Output installer:

- `dist\BrokerApp Setup <version>.exe` (NSIS installer)

Runtime data location on Windows:

- `%APPDATA%\BrokerApp\token.json`
- `%APPDATA%\BrokerApp\credentials.json`
