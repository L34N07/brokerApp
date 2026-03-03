# Gemini Code Assistant Context

## Project Overview

This project is a desktop application named "brokerapp" built with Electron. Its purpose is to serve as a trading panel for "IOL Broker", displaying real-time data.

The application is architected as follows:
- A main Electron process (`main.js`) manages the application lifecycle and windowing.
- A Python script (`script.py`) is executed on-demand by the main process for specific commands (`check-token`, `portfolio`).
- The main process receives Python JSON output and exposes request/response IPC handlers.
- A renderer process (`renderer.js`) calls the IPC API to validate token on startup and load portfolio only when the user clicks a button.
- A preload script (`preload.js`) securely exposes the IPC channel to the renderer process.

## Building and Running

### Prerequisites
- Node.js and npm
- Python 3

### Installation
To install the dependencies, run:
```bash
npm install
pip install -r requirements.txt
```

### Running the Application
To start the application, run:
```bash
npm start
```
This will launch the Electron window. The app checks token state on startup and only queries portfolio when requested from the UI button.

## Secrets and Auth

- Do not commit local credentials or tokens. Files `credentials.json` and `token.json` are ignored by `.gitignore`.
- You can bootstrap local files from:
  - `credentials.example.json`
  - `token.example.json`
- Environment variables supported by `script.py`:
  - `IOL_USERNAME`
  - `IOL_PASSWORD`
  - `IOL_ACCESS_TOKEN`
  - `IOL_API_BASE_URL` (default: `https://api.invertironline.com`)
  - `IOL_PORTFOLIO_COUNTRY` (default: `argentina`)
  - `IOL_REQUEST_TIMEOUT_SECONDS` (default: `10`)

The script now attempts token reuse, refresh with `refresh_token`, and fallback login with username/password.

## Development Conventions

- The main process is written in JavaScript (CommonJS).
- The frontend is a simple HTML page with a vanilla JavaScript renderer script.
- The backend is a Python script that communicates with the Node.js environment by printing JSON data to `stdout`.
- Communication between the main and renderer processes is handled via Electron's IPC mechanism, with a preload script for security.
