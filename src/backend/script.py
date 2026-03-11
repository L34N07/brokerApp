import json
import os
import sys
import base64
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
    if command == "operations":
        fetch_operations(payload)
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
