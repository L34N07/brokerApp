import json
import os
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

BASE_URL = os.getenv("IOL_API_BASE_URL", "https://api.invertironline.com")
PORTFOLIO_COUNTRY = os.getenv("IOL_PORTFOLIO_COUNTRY", "argentina")
REQUEST_TIMEOUT = float(os.getenv("IOL_REQUEST_TIMEOUT_SECONDS", "10"))
TOKEN_REFRESH_MARGIN_SECONDS = int(os.getenv("IOL_TOKEN_REFRESH_MARGIN_SECONDS", "60"))

PROJECT_DIR = Path(__file__).resolve().parent
TOKEN_FILE = PROJECT_DIR / "token.json"
CREDENTIALS_FILE = PROJECT_DIR / "credentials.json"


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def load_json_file(path):
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError):
        return {}


def save_json_file(path, payload):
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def parse_token_expiration(token_data):
    expires_raw = token_data.get(".expires")
    if not expires_raw:
        return None

    try:
        expires_at = parsedate_to_datetime(expires_raw)
    except (TypeError, ValueError):
        return None

    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at.astimezone(timezone.utc)


def token_is_still_valid(token_data):
    access_token = token_data.get("access_token")
    if not access_token:
        return False

    expires_at = parse_token_expiration(token_data)
    if expires_at is None:
        return True

    threshold = datetime.now(timezone.utc) + timedelta(seconds=TOKEN_REFRESH_MARGIN_SECONDS)
    return expires_at > threshold


def read_credentials():
    username = os.getenv("IOL_USERNAME")
    password = os.getenv("IOL_PASSWORD")
    if username and password:
        return {"username": username, "password": password}

    credentials_data = load_json_file(CREDENTIALS_FILE)
    username = credentials_data.get("username")
    password = credentials_data.get("password")
    if username and password:
        return {"username": username, "password": password}

    return None


def request_token(grant_payload):
    response = requests.post(
        f"{BASE_URL}/token",
        data=grant_payload,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def persist_token(previous_token_data, new_token_data):
    now_utc = datetime.now(timezone.utc)
    expires_in = int(new_token_data.get("expires_in", 0))
    expires_utc = now_utc + timedelta(seconds=expires_in)

    persisted = dict(new_token_data)
    persisted[".issued"] = now_utc.strftime("%a, %d %b %Y %H:%M:%S GMT")
    persisted[".expires"] = expires_utc.strftime("%a, %d %b %Y %H:%M:%S GMT")

    if "refresh_token" not in persisted and previous_token_data.get("refresh_token"):
        persisted["refresh_token"] = previous_token_data["refresh_token"]

    save_json_file(TOKEN_FILE, persisted)
    return persisted


def refresh_or_create_token(token_data):
    refresh_token = token_data.get("refresh_token")
    credentials = read_credentials()
    refresh_errors = []

    if refresh_token:
        try:
            refreshed = request_token(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
            )
            return persist_token(token_data, refreshed), "refresh_token"
        except requests.exceptions.RequestException as exc:
            refresh_errors.append(f"refresh_token falló: {exc}")

    if credentials:
        try:
            created = request_token(
                {
                    "grant_type": "password",
                    "username": credentials["username"],
                    "password": credentials["password"],
                }
            )
            return persist_token(token_data, created), "password_grant"
        except requests.exceptions.RequestException as exc:
            refresh_errors.append(f"password grant falló: {exc}")

    if refresh_errors:
        raise RuntimeError(" | ".join(refresh_errors))
    raise RuntimeError("No hay credenciales ni refresh_token disponibles.")


def get_access_token():
    token_data = load_json_file(TOKEN_FILE)
    env_access_token = os.getenv("IOL_ACCESS_TOKEN")
    if env_access_token:
        return env_access_token, "env"

    if token_is_still_valid(token_data):
        return token_data["access_token"], "cache"

    renewed, source = refresh_or_create_token(token_data)
    return renewed["access_token"], source


def get_portfolio(access_token):
    response = requests.get(
        f"{BASE_URL}/api/v2/portafolio/{PORTFOLIO_COUNTRY}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def check_token():
    try:
        _, source = get_access_token()
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    emit(
        {
            "estado": "conectado",
            "mensaje": f"Token listo (origen: {source}).",
        }
    )


def fetch_portfolio():
    try:
        access_token, source = get_access_token()
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        portfolio = get_portfolio(access_token)
        if isinstance(portfolio, dict):
            portfolio.setdefault("token_source", source)
        emit(portfolio)
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al conectar con la API de IOL: {exc}",
            }
        )


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "portfolio"
    if command == "check-token":
        check_token()
        return
    if command == "portfolio":
        fetch_portfolio()
        return

    emit(
        {
            "estado": "error",
            "mensaje": f"Comando no soportado: {command}",
        }
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
