import json
import os
import sys
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

BASE_URL = os.getenv("IOL_API_BASE_URL", "https://api.invertironline.com")
PORTFOLIO_COUNTRY = os.getenv("IOL_PORTFOLIO_COUNTRY", "argentina")
REQUEST_TIMEOUT = float(os.getenv("IOL_REQUEST_TIMEOUT_SECONDS", "10"))
TOKEN_REFRESH_MARGIN_SECONDS = int(os.getenv("IOL_TOKEN_REFRESH_MARGIN_SECONDS", "10"))
DEFAULT_BEARER_EXPIRATION_SECONDS = int(os.getenv("IOL_DEFAULT_BEARER_EXPIRATION_SECONDS", "900"))
MAX_STORED_ACCOUNTS = int(os.getenv("IOL_MAX_STORED_ACCOUNTS", "2"))
SYMBOL_SEARCH_MARKETS = ("bCBA", "nYSE", "nASDAQ", "aMEX", "bCS", "rOFX")
SYMBOL_SEARCH_COUNTRIES = ("argentina", "estados_Unidos")
SYMBOL_SEARCH_MARKET_COUNTRY_HINTS = {
    "bCBA": ("argentina",),
    "rOFX": ("argentina",),
    "nYSE": ("estados_Unidos",),
    "nASDAQ": ("estados_Unidos",),
    "aMEX": ("estados_Unidos",),
}
SYMBOL_SEARCH_MARKET_RESPONSE_ALIASES = {
    "bCBA": ("bcba", "1"),
    "nYSE": ("nyse", "2"),
    "nASDAQ": ("nasdaq", "3"),
    "aMEX": ("amex", "4"),
    "bCS": ("bcs",),
    "rOFX": ("rofx",),
}
SYMBOL_SEARCH_REQUEST_TIMEOUT = float(
    os.getenv("IOL_SYMBOL_SEARCH_TIMEOUT_SECONDS", str(REQUEST_TIMEOUT))
)
SYMBOL_SEARCH_MAX_WORKERS = max(1, int(os.getenv("IOL_SYMBOL_SEARCH_MAX_WORKERS", "6")))
SYMBOL_SEARCH_DEFAULT_INSTRUMENT = os.getenv("IOL_SYMBOL_SEARCH_DEFAULT_INSTRUMENT", "Acciones")
SYMBOL_SEARCH_ALL_INSTRUMENTS_VALUE = "todos"

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def get_data_dir():
    configured = os.getenv("BROKERAPP_DATA_DIR")
    if configured:
        return Path(configured).expanduser()

    if getattr(sys, "frozen", False):
        return Path.home() / ".brokerapp"

    return PROJECT_ROOT


DATA_DIR = get_data_dir()
TOKEN_FILE = DATA_DIR / "token.json"
CREDENTIALS_FILE = DATA_DIR / "credentials.json"
DASHBOARD_LAYOUTS_FILE = DATA_DIR / "dashboard-layouts.json"
DASHBOARD_LAYOUT_OBJECT_TYPES = {"summary", "tradingview", "flags", "portfolioActions"}
SELL_ORDER_TYPES = {"precioLimite", "precioMercado"}
SELL_ORDER_PLAZOS = {"t0", "t1", "t2"}


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
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def normalize_dashboard_layout_name(value):
    name = str(value or "").strip()
    if not name:
        raise RuntimeError("Debes indicar un nombre de diseño.")
    if len(name) > 80:
        raise RuntimeError("El nombre del diseño no puede superar 80 caracteres.")
    return name


def normalize_dashboard_layout_number(value, fallback=0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):
        return fallback
    return number


def normalize_positive_number(value, field_name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{field_name} debe ser numérico.")
    if number <= 0:
        raise RuntimeError(f"{field_name} debe ser mayor a 0.")
    return number


def normalize_positive_integer(value, field_name):
    number = normalize_positive_number(value, field_name)
    rounded = int(round(number))
    if rounded <= 0:
        raise RuntimeError(f"{field_name} debe ser mayor a 0.")
    return rounded


def normalize_operation_number(value):
    if isinstance(value, int):
        if value <= 0:
            raise RuntimeError("Número de operación inválido.")
        return str(value)
    if isinstance(value, float):
        if value <= 0 or not value.is_integer():
            raise RuntimeError("Número de operación inválido.")
        return str(int(value))

    text = str(value or "").strip()
    if not text or not text.isdigit() or int(text) <= 0:
        raise RuntimeError("Número de operación inválido.")
    return text


def normalize_sell_order_type(value):
    order_type = str(value or "precioLimite").strip()
    if order_type not in SELL_ORDER_TYPES:
        raise RuntimeError("tipoOrden inválido para venta.")
    return order_type


def normalize_sell_order_plazo(value):
    plazo = str(value or "t2").strip().lower()
    if plazo not in SELL_ORDER_PLAZOS:
        raise RuntimeError("Plazo inválido para venta.")
    return plazo


def format_default_order_validity(now_local=None):
    now_local = now_local or datetime.now()
    validity = now_local.replace(hour=23, minute=59, second=59, microsecond=0)
    return validity.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def normalize_sell_order_payload(payload, now_local=None):
    if not isinstance(payload, dict):
        raise RuntimeError("La orden de venta debe ser un objeto.")

    raw_market = normalize_symbol_search_text(payload.get("mercado"))
    if not raw_market:
        raise RuntimeError("Debes indicar un mercado para vender.")
    market = normalize_symbol_search_market(resolve_symbol_market(raw_market))
    symbol = normalize_symbol_search_text(payload.get("simbolo")).upper()
    if not symbol:
        raise RuntimeError("Debes indicar un símbolo para vender.")

    order_type = normalize_sell_order_type(payload.get("tipoOrden"))
    quantity = normalize_positive_integer(payload.get("cantidad"), "cantidad")
    if order_type == "precioLimite":
        price = normalize_positive_number(payload.get("precio"), "precio")
    else:
        try:
            price = float(payload.get("precio") or 0)
        except (TypeError, ValueError):
            raise RuntimeError("precio debe ser numérico.")
        if price < 0:
            raise RuntimeError("precio no puede ser negativo.")

    validity = normalize_symbol_search_text(payload.get("validez")) or format_default_order_validity(now_local)

    return {
        "mercado": market,
        "simbolo": symbol,
        "tipoOrden": order_type,
        "cantidad": quantity,
        "precio": price,
        "plazo": normalize_sell_order_plazo(payload.get("plazo")),
        "validez": validity,
    }


def normalize_dashboard_layout_item(item):
    if not isinstance(item, dict):
        return None

    item_type = str(item.get("type") or "").strip()
    if item_type not in DASHBOARD_LAYOUT_OBJECT_TYPES:
        return None

    return {
        "type": item_type,
        "x": max(0, normalize_dashboard_layout_number(item.get("x"))),
        "y": max(0, normalize_dashboard_layout_number(item.get("y"))),
        "width": max(1, normalize_dashboard_layout_number(item.get("width"), 1)),
        "height": max(1, normalize_dashboard_layout_number(item.get("height"), 1)),
        "zIndex": max(1, normalize_dashboard_layout_number(item.get("zIndex"), 1)),
    }


def normalize_dashboard_layout_payload(payload):
    raw_items = payload.get("items")
    if raw_items is None and isinstance(payload.get("layout"), dict):
        raw_items = payload["layout"].get("items")
    if not isinstance(raw_items, list):
        raise RuntimeError("El diseño debe incluir una lista de objetos.")

    return {
        "version": 1,
        "items": [
            normalized
            for normalized in (normalize_dashboard_layout_item(item) for item in raw_items)
            if normalized is not None
        ],
    }


def load_dashboard_layout_store():
    raw = load_json_file(DASHBOARD_LAYOUTS_FILE)
    layouts = raw.get("layouts") if isinstance(raw, dict) else {}
    if not isinstance(layouts, dict):
        layouts = {}
    last_layout_name = str(raw.get("last_layout_name") or "").strip() if isinstance(raw, dict) else ""
    if last_layout_name not in layouts:
        last_layout_name = ""
    return {"layouts": layouts, "last_layout_name": last_layout_name}


def save_dashboard_layout(name, layout):
    normalized_layout = normalize_dashboard_layout_payload(layout)
    store = load_dashboard_layout_store()
    stored_layout = {
        "name": name,
        "version": normalized_layout.get("version", 1),
        "items": normalized_layout.get("items", []),
    }
    store["layouts"][name] = stored_layout
    store["last_layout_name"] = name
    save_json_file(DASHBOARD_LAYOUTS_FILE, store)
    return stored_layout


def mark_dashboard_layout_used(name):
    normalized_name = normalize_dashboard_layout_name(name)
    store = load_dashboard_layout_store()
    if normalized_name not in store["layouts"]:
        raise RuntimeError(f"No existe un diseño guardado con el nombre '{normalized_name}'.")
    store["last_layout_name"] = normalized_name
    save_json_file(DASHBOARD_LAYOUTS_FILE, store)


def delete_dashboard_layout(name):
    normalized_name = normalize_dashboard_layout_name(name)
    store = load_dashboard_layout_store()
    if normalized_name not in store["layouts"]:
        raise RuntimeError(f"No existe un diseño guardado con el nombre '{normalized_name}'.")
    del store["layouts"][normalized_name]
    if store.get("last_layout_name") == normalized_name:
        store["last_layout_name"] = ""
    save_json_file(DASHBOARD_LAYOUTS_FILE, store)
    return normalized_name


def get_dashboard_layout(name):
    store = load_dashboard_layout_store()
    layout = store["layouts"].get(name)
    if not isinstance(layout, dict):
        raise RuntimeError(f"No existe un diseño guardado con el nombre '{name}'.")
    return normalize_dashboard_layout_payload(layout)


def list_dashboard_layouts():
    store = load_dashboard_layout_store()
    layouts = []
    for name, layout in store["layouts"].items():
        if not isinstance(layout, dict):
            continue
        layouts.append(
            {
                "name": str(layout.get("name") or name),
                "objectCount": len(layout.get("items") or []),
            }
        )
    return sorted(layouts, key=lambda item: item["name"].lower())


def get_last_dashboard_layout_name():
    return load_dashboard_layout_store().get("last_layout_name") or ""


def normalize_username(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def looks_like_token_payload(value):
    if not isinstance(value, dict):
        return False
    token_keys = {"access_token", "refresh_token", ".issued", ".expires", ".refreshexpires", "expires_in"}
    return any(key in value for key in token_keys)


def normalize_credentials_store(raw):
    store = {"active_username": None, "accounts": []}
    if not isinstance(raw, dict):
        return store

    raw_accounts = []
    if isinstance(raw.get("accounts"), list):
        raw_accounts = raw["accounts"]
    elif raw.get("username") and raw.get("password"):
        raw_accounts = [{"username": raw.get("username"), "password": raw.get("password")}]

    seen = set()
    accounts = []
    for item in raw_accounts:
        if not isinstance(item, dict):
            continue
        username = normalize_username(item.get("username"))
        password = item.get("password")
        if not username or password is None:
            continue
        if username in seen:
            continue
        seen.add(username)
        accounts.append({"username": username, "password": str(password)})
        if len(accounts) >= MAX_STORED_ACCOUNTS:
            break

    active_username = normalize_username(raw.get("active_username"))

    store["active_username"] = active_username
    store["accounts"] = accounts
    return store


def normalize_token_store(raw):
    store = {"active_username": None, "accounts": {}}
    if not isinstance(raw, dict):
        return store

    raw_accounts = raw.get("accounts")
    if isinstance(raw_accounts, dict):
        accounts = {}
        for raw_username, token_payload in raw_accounts.items():
            username = normalize_username(raw_username)
            if not username or not isinstance(token_payload, dict):
                continue
            if username in accounts:
                continue
            accounts[username] = dict(token_payload)
            if len(accounts) >= MAX_STORED_ACCOUNTS:
                break

        active_username = normalize_username(raw.get("active_username"))

        store["active_username"] = active_username
        store["accounts"] = accounts
        return store

    if looks_like_token_payload(raw):
        store["legacy_token"] = dict(raw)
    return store


def load_credentials_store():
    return normalize_credentials_store(load_json_file(CREDENTIALS_FILE))


def save_credentials_store(store):
    normalized = normalize_credentials_store(store)
    payload = {
        "active_username": normalized["active_username"],
        "accounts": normalized["accounts"],
    }
    save_json_file(CREDENTIALS_FILE, payload)


def load_token_store():
    return normalize_token_store(load_json_file(TOKEN_FILE))


def save_token_store(store):
    accounts = {}
    for raw_username, token_payload in (store.get("accounts") or {}).items():
        username = normalize_username(raw_username)
        if not username or not isinstance(token_payload, dict):
            continue
        if username in accounts:
            continue
        accounts[username] = dict(token_payload)
        if len(accounts) >= MAX_STORED_ACCOUNTS:
            break

    active_username = normalize_username(store.get("active_username"))

    payload = {
        "active_username": active_username,
        "accounts": accounts,
    }
    save_json_file(TOKEN_FILE, payload)


def list_saved_accounts(credentials_store=None, token_store=None):
    credentials_store = credentials_store or load_credentials_store()
    token_store = token_store or load_token_store()

    usernames = []
    for account in credentials_store["accounts"]:
        username = account["username"]
        if username not in usernames:
            usernames.append(username)

    for username in token_store["accounts"].keys():
        if username not in usernames:
            usernames.append(username)

    active_username = resolve_active_username(credentials_store, token_store)
    credential_usernames = {account["username"] for account in credentials_store["accounts"]}
    token_usernames = set(token_store["accounts"].keys())

    accounts = []
    for username in usernames:
        accounts.append(
            {
                "username": username,
                "has_credentials": username in credential_usernames,
                "has_token": username in token_usernames,
                "is_active": username == active_username,
            }
        )

    return {
        "active_username": active_username,
        "accounts": accounts,
    }


def resolve_active_username(credentials_store=None, token_store=None):
    env_username = normalize_username(os.getenv("IOL_USERNAME"))
    if env_username:
        return env_username

    credentials_store = credentials_store or load_credentials_store()
    token_store = token_store or load_token_store()

    token_active = normalize_username(token_store.get("active_username"))
    if token_active:
        return token_active

    credentials_active = normalize_username(credentials_store.get("active_username"))
    if credentials_active:
        return credentials_active

    return None


def clear_active_username():
    credentials_store = load_credentials_store()
    token_store = load_token_store()

    credentials_store["active_username"] = None
    token_store["active_username"] = None

    save_credentials_store(credentials_store)
    save_token_store(token_store)


def set_active_username(username, require_existing=False):
    normalized = normalize_username(username)
    if not normalized:
        raise RuntimeError("Usuario inválido.")

    credentials_store = load_credentials_store()
    token_store = load_token_store()
    existing = list_saved_accounts(credentials_store, token_store)
    known_users = {account["username"] for account in existing["accounts"]}

    if require_existing and normalized not in known_users:
        raise RuntimeError(f"La cuenta '{normalized}' no está guardada.")

    current_credentials_active = normalize_username(credentials_store.get("active_username"))
    current_token_active = normalize_username(token_store.get("active_username"))
    if current_credentials_active == normalized and current_token_active == normalized:
        return normalized

    credentials_store["active_username"] = normalized
    token_store["active_username"] = normalized
    save_credentials_store(credentials_store)
    save_token_store(token_store)
    return normalized


def read_credentials(username=None, credentials_store=None):
    requested_username = normalize_username(username)
    env_username = normalize_username(os.getenv("IOL_USERNAME"))
    env_password = os.getenv("IOL_PASSWORD")

    if env_username and env_password and (not requested_username or requested_username == env_username):
        return {"username": env_username, "password": env_password}

    credentials_store = credentials_store or load_credentials_store()
    if not requested_username:
        requested_username = resolve_active_username(credentials_store, load_token_store())

    if not requested_username:
        return None

    for account in credentials_store["accounts"]:
        if account["username"] == requested_username:
            return {"username": account["username"], "password": account["password"]}

    return None


def upsert_credentials_account(store, username, password):
    normalized_username = normalize_username(username)
    if not normalized_username:
        raise RuntimeError("El usuario es obligatorio.")
    if password is None or str(password).strip() == "":
        raise RuntimeError("La contraseña es obligatoria.")

    normalized_store = normalize_credentials_store(store)
    accounts = list(normalized_store["accounts"])

    for account in accounts:
        if account["username"] == normalized_username:
            account["password"] = str(password)
            normalized_store["accounts"] = accounts
            normalized_store["active_username"] = normalized_username
            return normalized_store

    if len(accounts) >= MAX_STORED_ACCOUNTS:
        raise RuntimeError(f"Solo se permiten {MAX_STORED_ACCOUNTS} cuentas guardadas.")

    accounts.append({"username": normalized_username, "password": str(password)})
    normalized_store["accounts"] = accounts
    normalized_store["active_username"] = normalized_username
    return normalized_store


def get_token_data_for_user(username, token_store=None):
    normalized_username = normalize_username(username)
    if not normalized_username:
        return {}

    token_store = token_store or load_token_store()
    stored = token_store["accounts"].get(normalized_username)
    if isinstance(stored, dict):
        return dict(stored)

    legacy_token = token_store.get("legacy_token")
    if isinstance(legacy_token, dict):
        if (
            normalized_username not in token_store["accounts"]
            and len(token_store["accounts"]) >= MAX_STORED_ACCOUNTS
        ):
            raise RuntimeError(f"No se pudo migrar token legado: máximo {MAX_STORED_ACCOUNTS} cuentas.")
        token_store["accounts"][normalized_username] = dict(legacy_token)
        token_store["active_username"] = normalized_username
        token_store.pop("legacy_token", None)
        save_token_store(token_store)
        return dict(token_store["accounts"][normalized_username])

    return {}


def parse_http_datetime(value):
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def to_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def decode_jwt_payload(token):
    if not token or not isinstance(token, str):
        return {}

    parts = token.split(".")
    if len(parts) < 2:
        return {}

    payload_segment = parts[1]
    if not payload_segment:
        return {}

    padding = "=" * ((4 - len(payload_segment) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload_segment + padding)
        payload = json.loads(decoded.decode("utf-8"))
    except (ValueError, TypeError, json.JSONDecodeError):
        return {}

    return payload if isinstance(payload, dict) else {}


def get_jwt_datetime_claim(token, claim_name):
    payload = decode_jwt_payload(token)
    claim_value = to_int(payload.get(claim_name), 0)
    if claim_value <= 0:
        return None
    try:
        return datetime.fromtimestamp(claim_value, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def format_http_datetime(value):
    return value.astimezone(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def parse_date_value(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise RuntimeError(f"Fecha inválida: {value}") from exc


def parse_time_value(value, fallback):
    if not value:
        return fallback

    accepted_formats = ("%H:%M:%S", "%H:%M")
    for time_format in accepted_formats:
        try:
            return datetime.strptime(value, time_format).time()
        except ValueError:
            continue

    raise RuntimeError(f"Hora inválida: {value}")


def get_bearer_expiration(token_data):
    jwt_expiration = get_jwt_datetime_claim(token_data.get("access_token"), "exp")
    if jwt_expiration:
        return jwt_expiration

    issued_at = parse_http_datetime(token_data.get(".issued"))
    expires_in = to_int(token_data.get("expires_in"), DEFAULT_BEARER_EXPIRATION_SECONDS)
    if issued_at and expires_in > 0:
        return issued_at + timedelta(seconds=expires_in)

    return parse_http_datetime(token_data.get(".expires"))


def get_refresh_expiration(token_data):
    jwt_expiration = get_jwt_datetime_claim(token_data.get("refresh_token"), "exp")
    if jwt_expiration:
        return jwt_expiration

    refresh_expires = parse_http_datetime(token_data.get(".refreshexpires"))
    if refresh_expires:
        return refresh_expires

    issued_at = parse_http_datetime(token_data.get(".issued"))
    refresh_expires_in = to_int(token_data.get("refresh_token_expires_in"), 0)
    if issued_at and refresh_expires_in > 0:
        return issued_at + timedelta(seconds=refresh_expires_in)

    return None


def is_future_timestamp(value):
    if value is None:
        return False
    threshold = datetime.now(timezone.utc) + timedelta(seconds=TOKEN_REFRESH_MARGIN_SECONDS)
    return value > threshold


def token_is_still_valid(token_data):
    access_token = token_data.get("access_token")
    if not access_token:
        return False

    bearer_expires_at = get_bearer_expiration(token_data)
    return is_future_timestamp(bearer_expires_at)


def refresh_token_is_still_valid(token_data):
    refresh_token = token_data.get("refresh_token")
    if not refresh_token:
        return False

    refresh_expires_at = get_refresh_expiration(token_data)
    if refresh_expires_at is None:
        return True
    return is_future_timestamp(refresh_expires_at)


def request_token(grant_payload):
    response = requests.post(
        f"{BASE_URL}/token",
        data=grant_payload,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def persist_token_for_user(username, previous_token_data, new_token_data):
    normalized_username = normalize_username(username)
    if not normalized_username:
        raise RuntimeError("Usuario inválido para persistir token.")

    now_utc = datetime.now(timezone.utc)
    persisted = dict(new_token_data)

    issued_at = (
        parse_http_datetime(persisted.get(".issued"))
        or get_jwt_datetime_claim(persisted.get("access_token"), "iat")
        or now_utc
    )
    expires_in = to_int(persisted.get("expires_in"), DEFAULT_BEARER_EXPIRATION_SECONDS)
    bearer_expires_at = get_jwt_datetime_claim(persisted.get("access_token"), "exp")
    if bearer_expires_at is None:
        bearer_expires_at = issued_at + timedelta(seconds=max(expires_in, 0))

    persisted[".issued"] = format_http_datetime(issued_at)
    persisted[".expires"] = format_http_datetime(bearer_expires_at)

    if "refresh_token" not in persisted and previous_token_data.get("refresh_token"):
        persisted["refresh_token"] = previous_token_data["refresh_token"]

    refresh_expiration = get_jwt_datetime_claim(persisted.get("refresh_token"), "exp")
    if refresh_expiration is None:
        refresh_expires_in = to_int(persisted.get("refresh_token_expires_in"), 0)
        if refresh_expires_in > 0:
            refresh_expiration = issued_at + timedelta(seconds=refresh_expires_in)
        elif previous_token_data.get(".refreshexpires"):
            refresh_expiration = parse_http_datetime(previous_token_data.get(".refreshexpires"))
        elif persisted.get(".refreshexpires"):
            refresh_expiration = parse_http_datetime(persisted.get(".refreshexpires"))

    if refresh_expiration:
        persisted[".refreshexpires"] = format_http_datetime(refresh_expiration)

    token_store = load_token_store()
    accounts = token_store["accounts"]
    if normalized_username not in accounts and len(accounts) >= MAX_STORED_ACCOUNTS:
        raise RuntimeError(f"Solo se permiten {MAX_STORED_ACCOUNTS} cuentas con token.")

    accounts[normalized_username] = persisted
    token_store["active_username"] = normalized_username
    token_store.pop("legacy_token", None)
    save_token_store(token_store)
    return persisted


def refresh_or_create_token(token_data, username):
    normalized_username = normalize_username(username)
    credentials = read_credentials(normalized_username)
    refresh_token = token_data.get("refresh_token")
    refresh_errors = []

    can_refresh = refresh_token and refresh_token_is_still_valid(token_data)
    if refresh_token and not can_refresh:
        refresh_errors.append("refresh_token vencido")

    if can_refresh:
        try:
            refreshed = request_token(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
            )
            return persist_token_for_user(normalized_username, token_data, refreshed), "refresh_token"
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
            return persist_token_for_user(normalized_username, token_data, created), "password_grant"
        except requests.exceptions.RequestException as exc:
            refresh_errors.append(f"password grant falló: {exc}")

    if refresh_errors:
        raise RuntimeError(" | ".join(refresh_errors))
    raise RuntimeError("No hay credenciales ni refresh_token disponibles para la cuenta seleccionada.")


def get_access_token(username=None):
    env_access_token = os.getenv("IOL_ACCESS_TOKEN")
    if env_access_token:
        return env_access_token, "env"

    credentials_store = load_credentials_store()
    token_store = load_token_store()
    current_active_username = resolve_active_username(credentials_store, token_store)
    target_username = normalize_username(username) or current_active_username
    if not target_username:
        raise RuntimeError("No hay cuenta seleccionada. Ingresá con usuario y contraseña.")

    token_data = get_token_data_for_user(target_username, token_store)
    if token_is_still_valid(token_data):
        if current_active_username != target_username:
            set_active_username(target_username, require_existing=False)
        return token_data["access_token"], "cache"

    renewed, source = refresh_or_create_token(token_data, target_username)
    if current_active_username != target_username:
        set_active_username(target_username, require_existing=False)
    return renewed["access_token"], source


def get_portfolio(access_token):
    response = requests.get(
        f"{BASE_URL}/api/v2/portafolio/{PORTFOLIO_COUNTRY}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def build_operations_filters(payload, now_local=None):
    now_local = (now_local or datetime.now()).replace(microsecond=0)
    default_from_date = (now_local - timedelta(days=1)).date()
    default_to_date = now_local.date()

    fecha_desde = parse_date_value(payload.get("fechaDesde")) or default_from_date
    fecha_hasta = parse_date_value(payload.get("fechaHasta")) or default_to_date

    hora_desde = parse_time_value(payload.get("horaDesde"), datetime.strptime("00:00:00", "%H:%M:%S").time())
    hora_hasta = parse_time_value(payload.get("horaHasta"), now_local.time())

    fecha_hora_desde = datetime.combine(fecha_desde, hora_desde)
    fecha_hora_hasta = datetime.combine(fecha_hasta, hora_hasta)

    if fecha_hora_desde > fecha_hora_hasta:
        raise RuntimeError("fechaDesde/horaDesde no puede ser mayor a fechaHasta/horaHasta.")

    return {
        "fechaDesde": fecha_hora_desde.strftime("%Y-%m-%d %H:%M:%S"),
        "fechaHasta": fecha_hora_hasta.strftime("%Y-%m-%d %H:%M:%S"),
    }


def normalize_operation_type(tipo):
    value = str(tipo or "").strip().lower()
    if value.startswith("compra"):
        return "compra"
    if value.startswith("venta"):
        return "venta"
    return "otro"


def normalize_operation_state(estado):
    value = str(estado or "").strip().lower()
    if "cancel" in value:
        return "canceladas"
    if "terminad" in value:
        return "terminadas"
    if "pend" in value or "proceso" in value or "iniciad" in value:
        return "pendientes"
    return "otras"


def normalize_operations(payload):
    if not isinstance(payload, list):
        return []

    normalized = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row["tipoFiltro"] = normalize_operation_type(item.get("tipo"))
        row["estadoFiltro"] = normalize_operation_state(item.get("estado"))
        normalized.append(row)
    return normalized


def get_operations(access_token, filters):
    params = {
        "filtro.estado": "todas",
        "filtro.fechaDesde": filters["fechaDesde"],
        "filtro.fechaHasta": filters["fechaHasta"],
        "api_key": access_token,
    }
    response = requests.get(
        f"{BASE_URL}/api/v2/operaciones",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return normalize_operations(response.json())


def normalize_quote_flag_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    text = str(value).strip()
    if not text:
        return None
    return value


def normalize_quote_flags_payload(payload, market="", symbol=""):
    if not isinstance(payload, dict):
        return {
            "simbolo": normalize_symbol_search_text(symbol).upper(),
            "mercado": normalize_symbol_search_market(market),
            "puntas": [],
        }

    normalized_symbol = normalize_symbol_search_text(payload.get("simbolo") or symbol).upper()
    normalized_market = resolve_symbol_market(payload.get("mercado") or market)
    raw_flags = payload.get("puntas")
    if isinstance(raw_flags, dict):
        raw_flags = [raw_flags]
    if not isinstance(raw_flags, list):
        raw_flags = []

    flags = []
    for item in raw_flags:
        if not isinstance(item, dict):
            continue
        flags.append(
            {
                "cantidadCompra": normalize_quote_flag_number(item.get("cantidadCompra")),
                "precioCompra": normalize_quote_flag_number(item.get("precioCompra")),
                "precioVenta": normalize_quote_flag_number(item.get("precioVenta")),
                "cantidadVenta": normalize_quote_flag_number(item.get("cantidadVenta")),
            }
        )

    return {
        "simbolo": normalized_symbol,
        "mercado": normalized_market,
        "descripcionTitulo": normalize_symbol_search_text(payload.get("descripcionTitulo")),
        "ultimoPrecio": payload.get("ultimoPrecio"),
        "variacion": payload.get("variacion"),
        "tendencia": normalize_symbol_search_text(payload.get("tendencia")),
        "fechaHora": payload.get("fechaHora"),
        "moneda": normalize_symbol_currency(payload.get("moneda")),
        "operableCompra": payload.get("operableCompra"),
        "operableVenta": payload.get("operableVenta"),
        "visible": payload.get("visible"),
        "puntas": flags,
    }


def get_quote_flags(access_token, market, symbol):
    normalized_market = normalize_symbol_search_market(market)
    normalized_symbol = normalize_symbol_search_text(symbol).upper()
    if not normalized_symbol:
        raise RuntimeError("Debes indicar un símbolo para consultar puntas.")

    response = requests.get(
        f"{BASE_URL}/api/v2/{normalized_market}/Titulos/{normalized_symbol}/CotizacionDetalle",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return normalize_quote_flags_payload(response.json(), normalized_market, normalized_symbol)


def post_sell_order(access_token, order_payload):
    order = normalize_sell_order_payload(order_payload)
    response = requests.post(
        f"{BASE_URL}/api/v2/operar/Vender",
        headers={"Authorization": f"Bearer {access_token}"},
        json=order,
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    try:
        return response.json()
    except ValueError:
        return {"raw": response.text}


def delete_operation(access_token, operation_number):
    normalized_number = normalize_operation_number(operation_number)
    response = requests.delete(
        f"{BASE_URL}/api/v2/operaciones/{normalized_number}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    try:
        return response.json()
    except ValueError:
        return {"raw": response.text}


def map_currency_symbol(moneda):
    currency = str(moneda or "").strip().lower()
    if "peso" in currency and "argent" in currency:
        return "AR$"
    if "dolar" in currency or "dólar" in currency:
        return "USD"
    return ""


def normalize_account_status(payload):
    cuentas = payload.get("cuentas") if isinstance(payload, dict) else None
    if not isinstance(cuentas, list):
        return {"cuentas": []}

    normalized = []
    for cuenta in cuentas:
        if not isinstance(cuenta, dict):
            continue

        moneda = cuenta.get("moneda")
        normalized.append(
            {
                "moneda": moneda,
                "simboloMoneda": map_currency_symbol(moneda),
                "disponible": cuenta.get("disponible", 0),
                "comprometido": cuenta.get("comprometido", 0),
                "saldo": cuenta.get("saldo", 0),
                "titulosValorizados": cuenta.get("titulosValorizados", 0),
                "total": cuenta.get("total", 0),
            }
        )

    return {"cuentas": normalized}


def get_account_status(access_token):
    response = requests.get(
        f"{BASE_URL}/api/v2/estadocuenta",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return normalize_account_status(response.json())


def get_symbol_search_config():
    return {
        "estado": "ok",
        "mercado_default": SYMBOL_SEARCH_MARKETS[0],
        "mercados": [{"codigo": market, "nombre": market} for market in SYMBOL_SEARCH_MARKETS],
        "paises_consultados": list(SYMBOL_SEARCH_COUNTRIES),
    }


def normalize_symbol_search_market(value):
    requested = str(value or "").strip()
    if not requested:
        return SYMBOL_SEARCH_MARKETS[0]

    for market in SYMBOL_SEARCH_MARKETS:
        if requested.lower() == market.lower():
            return market

    supported = ", ".join(SYMBOL_SEARCH_MARKETS)
    raise RuntimeError(f"Mercado inválido: {requested}. Valores soportados: {supported}.")


def get_symbol_search_countries_for_market(market):
    normalized_market = normalize_symbol_search_market(market)
    preferred = SYMBOL_SEARCH_MARKET_COUNTRY_HINTS.get(normalized_market, ())
    return tuple(preferred) + tuple(country for country in SYMBOL_SEARCH_COUNTRIES if country not in preferred)


def resolve_symbol_market(value):
    raw = normalize_symbol_search_text(value)
    if not raw:
        return ""
    normalized = raw.lower()

    for market, aliases in SYMBOL_SEARCH_MARKET_RESPONSE_ALIASES.items():
        if normalized in aliases:
            return market

    try:
        return normalize_symbol_search_market(raw)
    except RuntimeError:
        return raw


def normalize_symbol_currency(value):
    raw = normalize_symbol_search_text(value)
    normalized = raw.lower()
    if normalized in {"1", "peso_argentino", "pesos", "ars", "ar$"}:
        return "AR$"
    if normalized in {"2", "dolar_estadounidense", "dólar_estadounidense", "dolar", "dólar", "usd"}:
        return "USD"
    return raw


def normalize_symbol_search_text(value):
    if value is None:
        return ""
    return str(value).strip()


def normalize_symbol_search_instrument(value):
    text = normalize_symbol_search_text(value)
    if not text:
        return SYMBOL_SEARCH_DEFAULT_INSTRUMENT
    if text.lower() == SYMBOL_SEARCH_ALL_INSTRUMENTS_VALUE:
        return SYMBOL_SEARCH_ALL_INSTRUMENTS_VALUE
    return text


def instrument_matches(requested, candidate):
    requested_text = normalize_symbol_search_text(requested).lower()
    candidate_text = normalize_symbol_search_text(candidate).lower()
    return bool(requested_text and candidate_text and requested_text == candidate_text)


def first_non_empty(item, keys):
    for key in keys:
        value = normalize_symbol_search_text(item.get(key))
        if value:
            return value
    return ""


def normalize_symbol_quote(item, country, instrument):
    if not isinstance(item, dict):
        return None

    symbol = normalize_symbol_search_text(item.get("simbolo")).upper()
    if not symbol:
        return None

    raw_market = normalize_symbol_search_text(item.get("mercado"))
    market = resolve_symbol_market(raw_market)
    description = first_non_empty(item, ["descripcion", "descripcionTitulo"])
    quote_type = first_non_empty(item, ["tipo", "tipoOpcion"]) or normalize_symbol_search_text(instrument)
    puntas = item.get("puntas") if isinstance(item.get("puntas"), dict) else {}

    return {
        "simbolo": symbol,
        "descripcion": description,
        "mercado": market,
        "mercadoCodigo": raw_market,
        "pais": normalize_symbol_search_text(item.get("pais")) or country,
        "instrumento": normalize_symbol_search_text(instrument),
        "tipo": quote_type,
        "moneda": normalize_symbol_currency(item.get("moneda")),
        "monedaCodigo": normalize_symbol_search_text(item.get("moneda")),
        "plazo": normalize_symbol_search_text(item.get("plazo")),
        "ultimoPrecio": item.get("ultimoPrecio"),
        "variacionPorcentual": item.get("variacionPorcentual"),
        "apertura": item.get("apertura"),
        "maximo": item.get("maximo"),
        "minimo": item.get("minimo"),
        "ultimoCierre": item.get("ultimoCierre"),
        "volumen": item.get("volumen"),
        "cantidadOperaciones": item.get("cantidadOperaciones"),
        "fecha": item.get("fecha"),
        "laminaMinima": item.get("laminaMinima"),
        "lote": item.get("lote"),
        "puntas": {
            "cantidadCompra": puntas.get("cantidadCompra"),
            "precioCompra": puntas.get("precioCompra"),
            "precioVenta": puntas.get("precioVenta"),
            "cantidadVenta": puntas.get("cantidadVenta"),
        },
    }


def normalize_symbol_quotes_payload(payload, country, instrument):
    raw_symbols = []
    if isinstance(payload, dict):
        raw_symbols = payload.get("titulos") or []
    elif isinstance(payload, list):
        raw_symbols = payload

    if not isinstance(raw_symbols, list):
        return []

    normalized = []
    for item in raw_symbols:
        symbol = normalize_symbol_quote(item, country, instrument)
        if symbol:
            normalized.append(symbol)
    return normalized


def symbol_search_key(symbol):
    return "::".join(
        [
            normalize_symbol_search_text(symbol.get("mercado")).lower(),
            normalize_symbol_search_text(symbol.get("simbolo")).lower(),
            normalize_symbol_search_text(symbol.get("plazo")).lower(),
            normalize_symbol_search_text(symbol.get("moneda")).lower(),
            normalize_symbol_search_text(symbol.get("instrumento")).lower(),
        ]
    )


def filter_symbols_by_market(symbols, market):
    target_market = normalize_symbol_search_market(market).lower()
    filtered = []
    seen = set()

    for symbol in symbols:
        symbol_market = resolve_symbol_market(symbol.get("mercado")).lower()
        if symbol_market != target_market:
            continue

        key = symbol_search_key(symbol)
        if key in seen:
            continue
        seen.add(key)
        filtered.append(symbol)

    return sorted(
        filtered,
        key=lambda item: (
            normalize_symbol_search_text(item.get("simbolo")),
            normalize_symbol_search_text(item.get("plazo")),
            normalize_symbol_search_text(item.get("moneda")),
        ),
    )


def get_quote_instruments(access_token, country):
    response = requests.get(
        f"{BASE_URL}/api/v2/{country}/Titulos/Cotizacion/Instrumentos",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=SYMBOL_SEARCH_REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        return []

    instruments = []
    seen = set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        instrument = normalize_symbol_search_text(item.get("instrumento"))
        if not instrument:
            continue
        key = instrument.lower()
        if key in seen:
            continue
        seen.add(key)
        instruments.append(instrument)

    return instruments


def get_quote_symbols(access_token, country, instrument):
    response = requests.get(
        f"{BASE_URL}/api/v2/Cotizaciones/{instrument}/{country}/Todos",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=SYMBOL_SEARCH_REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return normalize_symbol_quotes_payload(response.json(), country, instrument)


def get_symbols_for_countries(access_token, countries, instrument_filter):
    all_symbols = []
    errors = []
    attempted_quote_requests = 0
    successful_quote_requests = 0
    consulted_countries = []
    quote_requests = []
    available_instruments = []

    for country in countries:
        try:
            instruments = get_quote_instruments(access_token, country)
        except requests.exceptions.RequestException as exc:
            errors.append(f"{country}: instrumentos: {exc}")
            continue

        consulted_countries.append(country)
        for instrument in instruments:
            if instrument not in available_instruments:
                available_instruments.append(instrument)

        selected_instruments = instruments
        if instrument_filter != SYMBOL_SEARCH_ALL_INSTRUMENTS_VALUE:
            selected_instruments = [
                instrument for instrument in instruments if instrument_matches(instrument_filter, instrument)
            ]
            if not selected_instruments:
                errors.append(f"{country}: instrumento no disponible: {instrument_filter}")

        for instrument in selected_instruments:
            quote_requests.append((country, instrument))

    attempted_quote_requests = len(quote_requests)
    if quote_requests:
        worker_count = min(SYMBOL_SEARCH_MAX_WORKERS, len(quote_requests))
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            future_map = {
                executor.submit(get_quote_symbols, access_token, country, instrument): (country, instrument)
                for country, instrument in quote_requests
            }
            for future in as_completed(future_map):
                country, instrument = future_map[future]
                try:
                    all_symbols.extend(future.result())
                    successful_quote_requests += 1
                except requests.exceptions.RequestException as exc:
                    errors.append(f"{country}/{instrument}: {exc}")
                except Exception as exc:
                    errors.append(f"{country}/{instrument}: {exc}")

    return {
        "symbols": all_symbols,
        "errors": errors,
        "consulted_countries": consulted_countries,
        "available_instruments": available_instruments,
        "attempted_quote_requests": attempted_quote_requests,
        "successful_quote_requests": successful_quote_requests,
    }


def get_symbols_for_market(access_token, market, instrument=None):
    normalized_market = normalize_symbol_search_market(market)
    instrument_filter = normalize_symbol_search_instrument(instrument)
    countries = get_symbol_search_countries_for_market(normalized_market)
    all_symbols = []
    errors = []
    consulted_countries = []
    available_instruments = []
    attempted_quote_requests = 0
    successful_quote_requests = 0

    for country in countries:
        batch = get_symbols_for_countries(access_token, (country,), instrument_filter)
        all_symbols.extend(batch["symbols"])
        errors.extend(batch["errors"])
        consulted_countries.extend(batch["consulted_countries"])
        for available_instrument in batch["available_instruments"]:
            if available_instrument not in available_instruments:
                available_instruments.append(available_instrument)
        attempted_quote_requests += batch["attempted_quote_requests"]
        successful_quote_requests += batch["successful_quote_requests"]

        filtered_symbols = filter_symbols_by_market(all_symbols, normalized_market)
        if filtered_symbols:
            return {
                "mercado": normalized_market,
                "instrumento": instrument_filter,
                "instrumentosDisponibles": available_instruments,
                "simbolos": filtered_symbols,
                "consultas": {
                    "paises": consulted_countries,
                    "instrumentos": attempted_quote_requests,
                    "exitosas": successful_quote_requests,
                },
                "errores": errors[:8],
            }

    if attempted_quote_requests == 0 and errors:
        detail = " | ".join(errors[:4])
        raise RuntimeError(f"No se pudieron consultar instrumentos para {normalized_market}: {detail}")

    if attempted_quote_requests > 0 and successful_quote_requests == 0:
        detail = " | ".join(errors[:4]) or "sin detalle"
        raise RuntimeError(f"No se pudieron consultar símbolos para {normalized_market}: {detail}")

    return {
        "mercado": normalized_market,
        "instrumento": instrument_filter,
        "instrumentosDisponibles": available_instruments,
        "simbolos": filter_symbols_by_market(all_symbols, normalized_market),
        "consultas": {
            "paises": consulted_countries,
            "instrumentos": attempted_quote_requests,
            "exitosas": successful_quote_requests,
        },
        "errores": errors[:8],
    }


def get_current_token_data():
    token_store = load_token_store()
    active_username = resolve_active_username(load_credentials_store(), token_store)
    if not active_username:
        return active_username, {}
    return active_username, token_store["accounts"].get(active_username, {})


def check_token(payload=None):
    payload = payload or {}
    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
        active_username, current_token_data = get_current_token_data()
        bearer_expiration = get_bearer_expiration(current_token_data)
        refresh_expiration = get_refresh_expiration(current_token_data)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    refresh_state = "desconocido"
    if current_token_data.get("refresh_token"):
        refresh_state = "vigente" if refresh_token_is_still_valid(current_token_data) else "vencido"

    emit(
        {
            "estado": "conectado",
            "mensaje": f"Token listo (origen: {source}).",
            "username": active_username,
            "token": {
                "source": source,
                "bearer_expires_at": format_http_datetime(bearer_expiration) if bearer_expiration else None,
                "refresh_expires_at": format_http_datetime(refresh_expiration) if refresh_expiration else None,
                "refresh_state": refresh_state,
                "has_access_token": bool(access_token),
            },
        }
    )


def fetch_portfolio(payload=None):
    payload = payload or {}
    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
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


def fetch_account_status(payload=None):
    payload = payload or {}
    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        account_status = get_account_status(access_token)
        if isinstance(account_status, dict):
            account_status.setdefault("token_source", source)
        emit(account_status)
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al consultar estado de cuenta: {exc}",
            }
        )


def fetch_symbol_search_config(_payload=None):
    emit(get_symbol_search_config())


def fetch_symbols(payload=None):
    payload = payload or {}
    try:
        market = normalize_symbol_search_market(payload.get("mercado"))
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc), "config": get_symbol_search_config()})
        return

    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        data = get_symbols_for_market(access_token, market, payload.get("instrumento"))
        emit(
            {
                "estado": "ok",
                "token_source": source,
                **data,
            }
        )
    except RuntimeError as exc:
        emit(
            {
                "estado": "error",
                "mensaje": str(exc),
                "mercado": market,
            }
        )


def fetch_operations(payload):
    try:
        filters = build_operations_filters(payload)
    except RuntimeError as exc:
        emit(
            {
                "estado": "error",
                "mensaje": str(exc),
            }
        )
        return

    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        operations = get_operations(access_token, filters)
        emit(
            {
                "operaciones": operations,
                "filtrosAplicados": filters,
                "token_source": source,
            }
        )
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al consultar operaciones: {exc}",
            }
        )


def fetch_quote_flags(payload):
    payload = payload or {}
    market = payload.get("mercado")
    symbol = payload.get("simbolo")

    try:
        normalized_market = normalize_symbol_search_market(market)
        normalized_symbol = normalize_symbol_search_text(symbol).upper()
        if not normalized_symbol:
            raise RuntimeError("Debes indicar un símbolo para consultar puntas.")
    except RuntimeError as exc:
        emit(
            {
                "estado": "error",
                "mensaje": str(exc),
            }
        )
        return

    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        quote_flags = get_quote_flags(access_token, normalized_market, normalized_symbol)
        emit(
            {
                "estado": "ok",
                "token_source": source,
                "cotizacion": quote_flags,
            }
        )
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al consultar puntas: {exc}",
                "mercado": normalized_market,
                "simbolo": normalized_symbol,
            }
        )
    except RuntimeError as exc:
        emit(
            {
                "estado": "error",
                "mensaje": str(exc),
                "mercado": normalized_market,
                "simbolo": normalized_symbol,
            }
        )


def fetch_sell_order(payload):
    payload = payload or {}
    try:
        order_payload = normalize_sell_order_payload(payload)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        response = post_sell_order(access_token, order_payload)
        emit(
            {
                "estado": "ok",
                "mensaje": "Orden de venta enviada.",
                "token_source": source,
                "orden": response,
            }
        )
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al enviar orden de venta: {exc}",
            }
        )


def fetch_cancel_operation(payload):
    payload = payload or {}
    try:
        operation_number = normalize_operation_number(payload.get("numeroOperacion") or payload.get("numero"))
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    target_username = normalize_username(payload.get("username"))
    try:
        access_token, source = get_access_token(target_username)
    except Exception as exc:
        emit(
            {
                "estado": "desconectado",
                "mensaje": f"No se pudo obtener un token válido: {exc}",
            }
        )
        return

    try:
        response = delete_operation(access_token, operation_number)
        emit(
            {
                "estado": "ok",
                "mensaje": "Operación cancelada.",
                "token_source": source,
                "numeroOperacion": operation_number,
                "operacion": response,
            }
        )
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
    except requests.exceptions.RequestException as exc:
        emit(
            {
                "estado": "error",
                "mensaje": f"Error al cancelar operación: {exc}",
                "numeroOperacion": operation_number,
            }
        )


def fetch_save_dashboard_layout(payload):
    payload = payload or {}
    try:
        name = normalize_dashboard_layout_name(payload.get("name"))
        layout = normalize_dashboard_layout_payload(payload)
        stored_layout = save_dashboard_layout(name, layout)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    emit(
        {
            "estado": "ok",
            "mensaje": f"Diseño guardado: {name}.",
            "layout": stored_layout,
        }
    )


def fetch_load_dashboard_layout(payload):
    payload = payload or {}
    try:
        name = normalize_dashboard_layout_name(payload.get("name"))
        layout = get_dashboard_layout(name)
        mark_dashboard_layout_used(name)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    emit(
        {
            "estado": "ok",
            "name": name,
            "layout": layout,
        }
    )


def fetch_list_dashboard_layouts(payload=None):
    payload = payload or {}
    last_layout_name = get_last_dashboard_layout_name()
    response = {
        "estado": "ok",
        "layouts": list_dashboard_layouts(),
        "lastLayoutName": last_layout_name,
    }

    if payload.get("includeLastLayout") and last_layout_name:
        try:
            response["lastLayout"] = get_dashboard_layout(last_layout_name)
        except RuntimeError:
            response["lastLayout"] = None

    emit(response)


def fetch_delete_dashboard_layout(payload):
    payload = payload or {}
    try:
        name = delete_dashboard_layout(payload.get("name"))
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    emit(
        {
            "estado": "ok",
            "mensaje": f"Diseño borrado: {name}.",
            "name": name,
            "layouts": list_dashboard_layouts(),
            "lastLayoutName": get_last_dashboard_layout_name(),
        }
    )


def list_accounts():
    data = list_saved_accounts()
    emit(
        {
            "estado": "ok",
            "active_username": data["active_username"],
            "accounts": data["accounts"],
        }
    )


def login(payload):
    username = normalize_username(payload.get("username"))
    password = payload.get("password")

    if not username:
        emit({"estado": "error", "mensaje": "El usuario es obligatorio."})
        return
    if password is None or str(password).strip() == "":
        emit({"estado": "error", "mensaje": "La contraseña es obligatoria."})
        return

    credentials_store = load_credentials_store()
    known_accounts = {account["username"] for account in credentials_store["accounts"]}
    if username not in known_accounts and len(known_accounts) >= MAX_STORED_ACCOUNTS:
        emit(
            {
                "estado": "error",
                "mensaje": f"Máximo de cuentas alcanzado ({MAX_STORED_ACCOUNTS}).",
            }
        )
        return

    try:
        created = request_token(
            {
                "grant_type": "password",
                "username": username,
                "password": password,
            }
        )
    except requests.exceptions.RequestException as exc:
        emit({"estado": "error", "mensaje": f"Login falló: {exc}"})
        return

    try:
        updated_store = upsert_credentials_account(credentials_store, username, password)
        save_credentials_store(updated_store)
        persisted_token = persist_token_for_user(username, {}, created)
        set_active_username(username, require_existing=False)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    accounts_data = list_saved_accounts()
    emit(
        {
            "estado": "conectado",
            "mensaje": "Sesión iniciada correctamente.",
            "username": username,
            "active_username": accounts_data["active_username"],
            "accounts": accounts_data["accounts"],
            "token": {
                "source": "password_grant",
                "bearer_expires_at": format_http_datetime(get_bearer_expiration(persisted_token))
                if get_bearer_expiration(persisted_token)
                else None,
                "refresh_expires_at": format_http_datetime(get_refresh_expiration(persisted_token))
                if get_refresh_expiration(persisted_token)
                else None,
                "refresh_state": "vigente" if refresh_token_is_still_valid(persisted_token) else "vencido",
                "has_access_token": bool(persisted_token.get("access_token")),
            },
        }
    )


def select_account(payload):
    username = normalize_username(payload.get("username"))
    if not username:
        emit({"estado": "error", "mensaje": "Debes indicar un usuario para seleccionar."})
        return

    try:
        set_active_username(username, require_existing=True)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    accounts_data = list_saved_accounts()
    emit(
        {
            "estado": "ok",
            "mensaje": f"Cuenta activa: {username}.",
            "active_username": accounts_data["active_username"],
            "accounts": accounts_data["accounts"],
        }
    )


def remove_saved_account(username):
    normalized = normalize_username(username)
    if not normalized:
        raise RuntimeError("Debes indicar un usuario para eliminar.")

    credentials_store = load_credentials_store()
    token_store = load_token_store()

    previous_credentials_count = len(credentials_store["accounts"])
    credentials_store["accounts"] = [
        account for account in credentials_store["accounts"] if account["username"] != normalized
    ]
    removed_from_credentials = len(credentials_store["accounts"]) != previous_credentials_count

    token_accounts = dict(token_store["accounts"])
    removed_from_tokens = token_accounts.pop(normalized, None) is not None
    token_store["accounts"] = token_accounts

    if not removed_from_credentials and not removed_from_tokens:
        raise RuntimeError(f"La cuenta '{normalized}' no está guardada.")

    if normalize_username(credentials_store.get("active_username")) == normalized:
        credentials_store["active_username"] = None
    if normalize_username(token_store.get("active_username")) == normalized:
        token_store["active_username"] = None

    save_credentials_store(credentials_store)
    save_token_store(token_store)
    return list_saved_accounts(credentials_store, token_store)


def delete_account(payload):
    username = normalize_username(payload.get("username"))
    try:
        accounts_data = remove_saved_account(username)
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    emit(
        {
            "estado": "ok",
            "mensaje": f"Cuenta eliminada: {username}.",
            "active_username": accounts_data["active_username"],
            "accounts": accounts_data["accounts"],
        }
    )


def logout():
    clear_active_username()
    accounts_data = list_saved_accounts()
    emit(
        {
            "estado": "ok",
            "mensaje": "Sesión cerrada.",
            "active_username": accounts_data["active_username"],
            "accounts": accounts_data["accounts"],
        }
    )


def parse_command_payload():
    if len(sys.argv) < 3:
        return {}

    raw_payload = sys.argv[2]
    try:
        parsed = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Payload inválido: {raw_payload}") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("El payload debe ser un objeto JSON.")
    return parsed


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "portfolio"
    payload = {}
    try:
        payload = parse_command_payload()
    except RuntimeError as exc:
        emit({"estado": "error", "mensaje": str(exc)})
        return

    if command == "check-token":
        check_token(payload)
        return
    if command == "portfolio":
        fetch_portfolio(payload)
        return
    if command == "account-status":
        fetch_account_status(payload)
        return
    if command == "symbol-search-config":
        fetch_symbol_search_config(payload)
        return
    if command == "symbols":
        fetch_symbols(payload)
        return
    if command == "operations":
        fetch_operations(payload)
        return
    if command == "quote-flags":
        fetch_quote_flags(payload)
        return
    if command == "sell-order":
        fetch_sell_order(payload)
        return
    if command == "cancel-operation":
        fetch_cancel_operation(payload)
        return
    if command == "save-dashboard-layout":
        fetch_save_dashboard_layout(payload)
        return
    if command == "load-dashboard-layout":
        fetch_load_dashboard_layout(payload)
        return
    if command == "list-dashboard-layouts":
        fetch_list_dashboard_layouts(payload)
        return
    if command == "delete-dashboard-layout":
        fetch_delete_dashboard_layout(payload)
        return
    if command == "list-accounts":
        list_accounts()
        return
    if command == "login":
        login(payload)
        return
    if command == "select-account":
        select_account(payload)
        return
    if command == "delete-account":
        delete_account(payload)
        return
    if command == "logout":
        logout()
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
