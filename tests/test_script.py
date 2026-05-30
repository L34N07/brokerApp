import base64
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

TESTS_DIR = os.path.dirname(__file__)
PROJECT_ROOT = os.path.dirname(TESTS_DIR)
BACKEND_DIR = os.path.join(PROJECT_ROOT, "src", "backend")

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import script


def fmt(dt):
    return dt.strftime("%a, %d %b %Y %H:%M:%S GMT")


def make_jwt(claims):
    def _encode(payload):
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

    header = {"alg": "none", "typ": "JWT"}
    return f"{_encode(header)}.{_encode(claims)}."


class ScriptTokenTests(unittest.TestCase):
    def test_get_bearer_expiration_prefers_access_token_exp_claim(self):
        issued = datetime(2026, 3, 3, 20, 0, 0, tzinfo=timezone.utc)
        access_exp = issued + timedelta(seconds=900)
        token_data = {
            "access_token": make_jwt({"iat": int(issued.timestamp()), "exp": int(access_exp.timestamp())}),
            ".issued": fmt(issued),
            "expires_in": 1200,
        }

        expiration = script.get_bearer_expiration(token_data)
        self.assertEqual(expiration, access_exp)

    def test_get_bearer_expiration_prefers_issued_plus_expires_in(self):
        issued = datetime(2026, 3, 3, 20, 0, 0, tzinfo=timezone.utc)
        token_data = {
            ".issued": fmt(issued),
            "expires_in": 1200,
            ".expires": fmt(issued + timedelta(seconds=9999)),
        }

        expiration = script.get_bearer_expiration(token_data)
        self.assertEqual(expiration, issued + timedelta(seconds=1200))

    def test_token_is_still_valid_false_without_access_token(self):
        self.assertFalse(script.token_is_still_valid({}))

    def test_token_is_still_valid_false_when_issued_plus_1200_expired(self):
        issued = datetime.now(timezone.utc) - timedelta(seconds=1300)
        token_data = {
            "access_token": "abc",
            ".issued": fmt(issued),
            "expires_in": 1200,
        }
        self.assertFalse(script.token_is_still_valid(token_data))

    def test_refresh_token_is_still_valid_false_when_refreshexpires_passed(self):
        refresh_expired = datetime.now(timezone.utc) - timedelta(seconds=1)
        token_data = {
            "refresh_token": "r1",
            ".refreshexpires": fmt(refresh_expired),
        }
        self.assertFalse(script.refresh_token_is_still_valid(token_data))

    def test_get_refresh_expiration_prefers_refresh_token_exp_claim(self):
        issued = datetime(2026, 3, 3, 20, 0, 0, tzinfo=timezone.utc)
        refresh_exp = issued + timedelta(seconds=1200)
        token_data = {
            "refresh_token": make_jwt({"iat": int(issued.timestamp()), "exp": int(refresh_exp.timestamp())}),
            ".refreshexpires": fmt(issued + timedelta(seconds=60)),
        }

        expiration = script.get_refresh_expiration(token_data)
        self.assertEqual(expiration, refresh_exp)

    @patch("script.save_token_store")
    @patch("script.load_token_store")
    def test_persist_token_for_user_prefers_jwt_claims_for_expirations(
        self, mock_load_token_store, _mock_save_token_store
    ):
        issued = datetime(2026, 3, 3, 20, 0, 0, tzinfo=timezone.utc)
        access_exp = issued + timedelta(seconds=900)
        refresh_exp = issued + timedelta(seconds=1200)
        mock_load_token_store.return_value = {"active_username": None, "accounts": {}}

        persisted = script.persist_token_for_user(
            "u1",
            {},
            {
                "access_token": make_jwt({"iat": int(issued.timestamp()), "exp": int(access_exp.timestamp())}),
                "refresh_token": make_jwt({"iat": int(issued.timestamp()), "exp": int(refresh_exp.timestamp())}),
                "expires_in": 1200,
            },
        )

        self.assertEqual(persisted[".issued"], fmt(issued))
        self.assertEqual(persisted[".expires"], fmt(access_exp))
        self.assertEqual(persisted[".refreshexpires"], fmt(refresh_exp))

    @patch.dict(os.environ, {}, clear=True)
    @patch("script.set_active_username")
    @patch("script.token_is_still_valid")
    @patch("script.get_token_data_for_user")
    @patch("script.resolve_active_username")
    @patch("script.load_token_store")
    @patch("script.load_credentials_store")
    def test_get_access_token_uses_cache_when_valid(
        self,
        mock_load_credentials_store,
        mock_load_token_store,
        mock_resolve_active_username,
        mock_get_token_data_for_user,
        mock_token_is_still_valid,
        mock_set_active_username,
    ):
        mock_load_credentials_store.return_value = {"active_username": "user1", "accounts": []}
        mock_load_token_store.return_value = {"active_username": "user1", "accounts": {}}
        mock_resolve_active_username.return_value = "user1"
        mock_get_token_data_for_user.return_value = {"access_token": "cached-token"}
        mock_token_is_still_valid.return_value = True

        token, source = script.get_access_token()
        self.assertEqual(token, "cached-token")
        self.assertEqual(source, "cache")
        mock_set_active_username.assert_not_called()

    @patch.dict(os.environ, {}, clear=True)
    @patch("script.set_active_username")
    @patch("script.refresh_or_create_token")
    @patch("script.token_is_still_valid")
    @patch("script.get_token_data_for_user")
    @patch("script.resolve_active_username")
    @patch("script.load_token_store")
    @patch("script.load_credentials_store")
    def test_get_access_token_uses_refresh_when_expired(
        self,
        mock_load_credentials_store,
        mock_load_token_store,
        mock_resolve_active_username,
        mock_get_token_data_for_user,
        mock_token_is_still_valid,
        mock_refresh_or_create_token,
        mock_set_active_username,
    ):
        mock_load_credentials_store.return_value = {"active_username": "user1", "accounts": []}
        mock_load_token_store.return_value = {"active_username": "user1", "accounts": {}}
        mock_resolve_active_username.return_value = "user1"
        mock_get_token_data_for_user.return_value = {"access_token": "old", "refresh_token": "r1"}
        mock_token_is_still_valid.return_value = False
        mock_refresh_or_create_token.return_value = ({"access_token": "new-token"}, "refresh_token")

        token, source = script.get_access_token()
        self.assertEqual(token, "new-token")
        self.assertEqual(source, "refresh_token")
        mock_refresh_or_create_token.assert_called_once()
        mock_set_active_username.assert_not_called()

    @patch("script.read_credentials")
    @patch("script.request_token")
    def test_refresh_or_create_token_fallback_to_password_grant_when_refresh_expired(
        self, mock_request_token, mock_read_credentials
    ):
        issued = datetime.now(timezone.utc) - timedelta(seconds=1300)
        refresh_expired = datetime.now(timezone.utc) - timedelta(seconds=10)

        token_data = {
            "refresh_token": "old-refresh",
            ".issued": fmt(issued),
            "expires_in": 1200,
            ".refreshexpires": fmt(refresh_expired),
        }

        mock_read_credentials.return_value = {"username": "user", "password": "pass"}
        mock_request_token.return_value = {"access_token": "new", "expires_in": 1200, "refresh_token": "rt"}

        with patch("script.persist_token_for_user") as mock_persist:
            mock_persist.return_value = {"access_token": "new"}
            token, source = script.refresh_or_create_token(token_data, "user")
            self.assertEqual(token["access_token"], "new")
            self.assertEqual(source, "password_grant")
            self.assertTrue(mock_persist.called)
            called_payload = mock_request_token.call_args[0][0]
            self.assertEqual(called_payload["grant_type"], "password")

    def test_normalize_credentials_store_supports_legacy_payload(self):
        store = script.normalize_credentials_store({"username": "u1", "password": "p1"})
        self.assertIsNone(store["active_username"])
        self.assertEqual(len(store["accounts"]), 1)
        self.assertEqual(store["accounts"][0]["username"], "u1")

    @patch("script.save_token_store")
    @patch("script.save_credentials_store")
    @patch("script.load_token_store")
    @patch("script.load_credentials_store")
    def test_clear_active_username_sets_both_stores_to_none(
        self,
        mock_load_credentials_store,
        mock_load_token_store,
        mock_save_credentials_store,
        mock_save_token_store,
    ):
        mock_load_credentials_store.return_value = {
            "active_username": "u1",
            "accounts": [{"username": "u1", "password": "p1"}],
        }
        mock_load_token_store.return_value = {
            "active_username": "u1",
            "accounts": {"u1": {"access_token": "abc"}},
        }

        script.clear_active_username()

        saved_credentials_payload = mock_save_credentials_store.call_args[0][0]
        saved_token_payload = mock_save_token_store.call_args[0][0]
        self.assertIsNone(saved_credentials_payload["active_username"])
        self.assertIsNone(saved_token_payload["active_username"])

    @patch("script.save_token_store")
    @patch("script.save_credentials_store")
    @patch("script.load_token_store")
    @patch("script.load_credentials_store")
    def test_remove_saved_account_deletes_user_from_credentials_and_tokens(
        self,
        mock_load_credentials_store,
        mock_load_token_store,
        mock_save_credentials_store,
        mock_save_token_store,
    ):
        mock_load_credentials_store.return_value = {
            "active_username": "u1",
            "accounts": [
                {"username": "u1", "password": "p1"},
                {"username": "u2", "password": "p2"},
            ],
        }
        mock_load_token_store.return_value = {
            "active_username": "u1",
            "accounts": {
                "u1": {"access_token": "abc"},
                "u2": {"access_token": "def"},
            },
        }

        result = script.remove_saved_account("u1")

        saved_credentials_payload = mock_save_credentials_store.call_args[0][0]
        saved_token_payload = mock_save_token_store.call_args[0][0]
        self.assertEqual([a["username"] for a in saved_credentials_payload["accounts"]], ["u2"])
        self.assertEqual(set(saved_token_payload["accounts"].keys()), {"u2"})
        self.assertIsNone(saved_credentials_payload["active_username"])
        self.assertIsNone(saved_token_payload["active_username"])
        self.assertEqual(result["active_username"], None)
        self.assertEqual([a["username"] for a in result["accounts"]], ["u2"])

    def test_upsert_credentials_account_rejects_third_account(self):
        base_store = {
            "active_username": "u1",
            "accounts": [
                {"username": "u1", "password": "p1"},
                {"username": "u2", "password": "p2"},
            ],
        }
        with self.assertRaises(RuntimeError):
            script.upsert_credentials_account(base_store, "u3", "p3")

    def test_get_token_data_for_user_migrates_legacy_token(self):
        token_store = {
            "active_username": None,
            "accounts": {},
            "legacy_token": {"access_token": "abc", "refresh_token": "r1"},
        }
        with patch("script.save_token_store") as mock_save:
            token = script.get_token_data_for_user("u1", token_store)
            self.assertEqual(token["access_token"], "abc")
            self.assertIn("u1", token_store["accounts"])
            self.assertTrue(mock_save.called)

    def test_map_currency_symbol(self):
        self.assertEqual(script.map_currency_symbol("peso_Argentino"), "AR$")
        self.assertEqual(script.map_currency_symbol("dolar_estadounidense"), "USD")

    def test_build_operations_filters_with_defaults(self):
        fixed_now = datetime(2026, 3, 3, 18, 4, 5)
        filters = script.build_operations_filters({}, now_local=fixed_now)
        self.assertEqual(filters["fechaDesde"], "2026-03-02 00:00:00")
        self.assertEqual(filters["fechaHasta"], "2026-03-03 18:04:05")

    def test_build_operations_filters_rejects_inverted_range(self):
        with self.assertRaises(RuntimeError):
            script.build_operations_filters(
                {
                    "fechaDesde": "2026-03-03",
                    "horaDesde": "20:00:00",
                    "fechaHasta": "2026-03-03",
                    "horaHasta": "10:00:00",
                }
            )

    def test_normalize_operation_state(self):
        self.assertEqual(script.normalize_operation_state("cancelada_Por_Vencimiento_Validez"), "canceladas")
        self.assertEqual(script.normalize_operation_state("terminada"), "terminadas")
        self.assertEqual(script.normalize_operation_state("pendiente"), "pendientes")
        self.assertEqual(script.normalize_operation_state("en_proceso"), "pendientes")
        self.assertEqual(script.normalize_operation_state("iniciada"), "pendientes")


class ScriptSymbolSearchTests(unittest.TestCase):
    def test_normalize_symbol_search_market_defaults_and_preserves_documented_casing(self):
        self.assertEqual(script.normalize_symbol_search_market(""), "bCBA")
        self.assertEqual(script.normalize_symbol_search_market("nyse"), "nYSE")
        with self.assertRaises(RuntimeError):
            script.normalize_symbol_search_market("INVALID")

    def test_get_symbol_search_countries_for_market_prefers_likely_country_then_falls_back(self):
        self.assertEqual(script.get_symbol_search_countries_for_market("bCBA")[0], "argentina")
        self.assertEqual(script.get_symbol_search_countries_for_market("nasdaq")[0], "estados_Unidos")
        self.assertEqual(set(script.get_symbol_search_countries_for_market("bCS")), set(script.SYMBOL_SEARCH_COUNTRIES))

    def test_resolve_symbol_market_supports_numeric_response_codes(self):
        self.assertEqual(script.resolve_symbol_market("1"), "bCBA")
        self.assertEqual(script.resolve_symbol_market("2"), "nYSE")
        self.assertEqual(script.resolve_symbol_market("3"), "nASDAQ")
        self.assertEqual(script.resolve_symbol_market("4"), "aMEX")

    def test_normalize_symbol_currency_supports_numeric_response_codes(self):
        self.assertEqual(script.normalize_symbol_currency("1"), "AR$")
        self.assertEqual(script.normalize_symbol_currency("2"), "USD")

    def test_normalize_symbol_quotes_payload_uses_useful_fields(self):
        payload = {
            "titulos": [
                {
                    "simbolo": " alua ",
                    "descripcion": "Aluar",
                    "mercado": "1",
                    "ultimoPrecio": 100,
                    "variacionPorcentual": 1.5,
                    "moneda": "1",
                    "puntas": {
                        "cantidadCompra": 10,
                        "precioCompra": 99,
                        "precioVenta": 101,
                        "cantidadVenta": 12,
                    },
                },
                {"descripcion": "sin simbolo"},
                "invalid",
            ]
        }

        result = script.normalize_symbol_quotes_payload(payload, "argentina", "acciones")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["simbolo"], "ALUA")
        self.assertEqual(result[0]["descripcion"], "Aluar")
        self.assertEqual(result[0]["mercado"], "bCBA")
        self.assertEqual(result[0]["mercadoCodigo"], "1")
        self.assertEqual(result[0]["moneda"], "AR$")
        self.assertEqual(result[0]["instrumento"], "acciones")
        self.assertEqual(result[0]["puntas"]["precioCompra"], 99)

    def test_filter_symbols_by_market_deduplicates_and_sorts(self):
        rows = [
            {"simbolo": "YPFD", "mercado": "bCBA", "plazo": "t0", "moneda": "peso_Argentino", "instrumento": "acciones"},
            {"simbolo": "ALUA", "mercado": "bCBA", "plazo": "t0", "moneda": "peso_Argentino", "instrumento": "acciones"},
            {"simbolo": "ALUA", "mercado": "bCBA", "plazo": "t0", "moneda": "peso_Argentino", "instrumento": "acciones"},
            {"simbolo": "AAPL", "mercado": "nASDAQ", "plazo": "", "moneda": "dolar", "instrumento": "acciones"},
        ]

        result = script.filter_symbols_by_market(rows, "bcba")

        self.assertEqual([item["simbolo"] for item in result], ["ALUA", "YPFD"])

    def test_normalize_quote_flags_payload_uses_documented_puntas_shape(self):
        payload = {
            "simbolo": " alua ",
            "mercado": "1",
            "descripcionTitulo": "Aluar",
            "ultimoPrecio": 100,
            "moneda": "peso_Argentino",
            "operableCompra": True,
            "operableVenta": False,
            "puntas": [
                {
                    "cantidadCompra": 10,
                    "precioCompra": 99,
                    "precioVenta": 101,
                    "cantidadVenta": 12,
                }
            ],
        }

        result = script.normalize_quote_flags_payload(payload, "bCBA", "ALUA")

        self.assertEqual(result["simbolo"], "ALUA")
        self.assertEqual(result["mercado"], "bCBA")
        self.assertEqual(result["descripcionTitulo"], "Aluar")
        self.assertEqual(result["moneda"], "AR$")
        self.assertTrue(result["operableCompra"])
        self.assertFalse(result["operableVenta"])
        self.assertEqual(result["puntas"][0]["precioCompra"], 99)

    @patch("script.requests.get")
    def test_get_quote_flags_calls_cotizacion_detalle_endpoint(self, mock_get):
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "simbolo": "ALUA",
                    "mercado": "bCBA",
                    "puntas": [{"precioCompra": 99, "precioVenta": 101}],
                }

        mock_get.return_value = Response()

        result = script.get_quote_flags("token", "bcba", "alua")

        self.assertEqual(result["simbolo"], "ALUA")
        self.assertEqual(result["puntas"][0]["precioVenta"], 101)
        mock_get.assert_called_once()
        self.assertIn("/api/v2/bCBA/Titulos/ALUA/CotizacionDetalle", mock_get.call_args.args[0])
        self.assertEqual(mock_get.call_args.kwargs["headers"]["Authorization"], "Bearer token")

    def test_normalize_sell_order_payload_uses_limit_order_shape(self):
        result = script.normalize_sell_order_payload(
            {
                "mercado": "1",
                "simbolo": " alua ",
                "cantidad": 7.6,
                "precio": "107",
            },
            now_local=datetime(2026, 5, 29, 10, 12, 0),
        )

        self.assertEqual(
            result,
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 8,
                "precio": 107.0,
                "plazo": "t2",
                "validez": "2026-05-29T23:59:59.000Z",
            },
        )

    def test_normalize_sell_order_payload_requires_market(self):
        with self.assertRaises(RuntimeError):
            script.normalize_sell_order_payload(
                {
                    "simbolo": "ALUA",
                    "cantidad": 1,
                    "precio": 100,
                }
            )

    def test_normalize_buy_order_payload_uses_documented_shape(self):
        result = script.normalize_buy_order_payload(
            {
                "mercado": "1",
                "simbolo": " alua ",
                "cantidad": 3,
                "precio": "105",
            },
            now_local=datetime(2026, 5, 29, 10, 12, 0),
        )

        self.assertEqual(
            result,
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 3,
                "precio": 105.0,
                "plazo": "t2",
                "validez": "2026-05-29T23:59:59.000Z",
                "monto": 315.0,
            },
        )

    def test_normalize_buy_order_payload_can_derive_quantity_from_amount(self):
        result = script.normalize_buy_order_payload(
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "precio": 100,
                "monto": 350,
            },
            now_local=datetime(2026, 5, 29, 10, 12, 0),
        )

        self.assertEqual(result["cantidad"], 3)
        self.assertEqual(result["monto"], 300.0)

    def test_normalize_operation_number_rejects_non_numeric_values(self):
        self.assertEqual(script.normalize_operation_number("00123"), "00123")
        self.assertEqual(script.normalize_operation_number(123), "123")
        with self.assertRaises(RuntimeError):
            script.normalize_operation_number("ABC123")

    @patch("script.requests.post")
    def test_post_sell_order_calls_operar_vender_endpoint(self, mock_post):
        class Response:
            text = ""

            def raise_for_status(self):
                return None

            def json(self):
                return {"numeroOperacion": 123}

        mock_post.return_value = Response()

        result = script.post_sell_order(
            "token",
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 4,
                "precio": 110,
                "plazo": "t0",
                "validez": "2026-05-29T23:59:59.000Z",
            },
        )

        self.assertEqual(result["numeroOperacion"], 123)
        mock_post.assert_called_once()
        self.assertIn("/api/v2/operar/Vender", mock_post.call_args.args[0])
        self.assertEqual(mock_post.call_args.kwargs["headers"]["Authorization"], "Bearer token")
        self.assertEqual(
            mock_post.call_args.kwargs["json"],
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 4,
                "precio": 110.0,
                "plazo": "t0",
                "validez": "2026-05-29T23:59:59.000Z",
            },
        )

    @patch("script.requests.post")
    def test_post_buy_order_calls_operar_comprar_endpoint(self, mock_post):
        class Response:
            text = ""

            def raise_for_status(self):
                return None

            def json(self):
                return {"numeroOperacion": 456}

        mock_post.return_value = Response()

        result = script.post_buy_order(
            "token",
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 4,
                "precio": 110,
                "monto": 440,
                "plazo": "t0",
                "validez": "2026-05-29T23:59:59.000Z",
            },
        )

        self.assertEqual(result["numeroOperacion"], 456)
        mock_post.assert_called_once()
        self.assertIn("/api/v2/operar/Comprar", mock_post.call_args.args[0])
        self.assertEqual(mock_post.call_args.kwargs["headers"]["Authorization"], "Bearer token")
        self.assertEqual(
            mock_post.call_args.kwargs["json"],
            {
                "mercado": "bCBA",
                "simbolo": "ALUA",
                "tipoOrden": "precioLimite",
                "cantidad": 4,
                "precio": 110.0,
                "plazo": "t0",
                "validez": "2026-05-29T23:59:59.000Z",
                "monto": 440.0,
            },
        )

    @patch("script.requests.delete")
    def test_delete_operation_calls_operaciones_endpoint(self, mock_delete):
        class Response:
            text = ""

            def raise_for_status(self):
                return None

            def json(self):
                return {"estado": "cancelada"}

        mock_delete.return_value = Response()

        result = script.delete_operation("token", "123456")

        self.assertEqual(result["estado"], "cancelada")
        mock_delete.assert_called_once()
        self.assertIn("/api/v2/operaciones/123456", mock_delete.call_args.args[0])
        self.assertEqual(mock_delete.call_args.kwargs["headers"]["Authorization"], "Bearer token")

    def test_normalize_dashboard_layout_payload_keeps_only_layout_fields(self):
        result = script.normalize_dashboard_layout_payload(
            {
                "items": [
                    {
                        "type": "summary",
                        "x": 12,
                        "y": 18,
                        "width": 320,
                        "height": 180,
                        "zIndex": 4,
                        "selectedSymbol": "NVDA",
                        "operations": [{"simbolo": "NVDA"}],
                    },
                    {"type": "unsupported", "x": 1},
                    {"type": "portfolioActions", "x": 2, "y": 3, "width": 520, "height": 220, "selectedStock": "ALUA"},
                    {"type": "buyOrder", "x": 6, "y": 7, "width": 380, "height": 250, "selectedBuySymbol": "YPFD"},
                ]
            }
        )

        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(result["items"][0]["type"], "summary")
        self.assertEqual(result["items"][0]["x"], 12)
        self.assertEqual(result["items"][0]["zIndex"], 4)
        self.assertNotIn("selectedSymbol", result["items"][0])
        self.assertNotIn("operations", result["items"][0])
        self.assertEqual(result["items"][1]["type"], "portfolioActions")
        self.assertNotIn("selectedStock", result["items"][1])
        self.assertEqual(result["items"][2]["type"], "buyOrder")
        self.assertNotIn("selectedBuySymbol", result["items"][2])

    def test_save_and_load_dashboard_layout_uses_layout_file(self):
        previous_file = script.DASHBOARD_LAYOUTS_FILE
        with tempfile.TemporaryDirectory() as temp_dir:
            script.DASHBOARD_LAYOUTS_FILE = Path(temp_dir) / "dashboard-layouts.json"
            try:
                script.save_dashboard_layout(
                    "Mesa",
                    {
                        "version": 1,
                        "items": [
                            {
                                "type": "flags",
                                "x": 20,
                                "y": 30,
                                "width": 360,
                                "height": 250,
                                "zIndex": 9,
                            }
                        ],
                    },
                )

                loaded = script.get_dashboard_layout("Mesa")
                last_layout_name = script.get_last_dashboard_layout_name()
            finally:
                script.DASHBOARD_LAYOUTS_FILE = previous_file

        self.assertEqual(loaded["items"][0]["type"], "flags")
        self.assertEqual(loaded["items"][0]["width"], 360)
        self.assertEqual(loaded["items"][0]["zIndex"], 9)
        self.assertEqual(last_layout_name, "Mesa")

    def test_mark_dashboard_layout_used_tracks_last_loaded_layout(self):
        previous_file = script.DASHBOARD_LAYOUTS_FILE
        with tempfile.TemporaryDirectory() as temp_dir:
            script.DASHBOARD_LAYOUTS_FILE = Path(temp_dir) / "dashboard-layouts.json"
            try:
                script.save_dashboard_layout("Mesa A", {"items": [{"type": "summary"}]})
                script.save_dashboard_layout("Mesa B", {"items": [{"type": "flags"}]})
                script.mark_dashboard_layout_used("Mesa A")
                last_layout_name = script.get_last_dashboard_layout_name()
            finally:
                script.DASHBOARD_LAYOUTS_FILE = previous_file

        self.assertEqual(last_layout_name, "Mesa A")

    def test_delete_dashboard_layout_removes_saved_layout_and_last_used(self):
        previous_file = script.DASHBOARD_LAYOUTS_FILE
        with tempfile.TemporaryDirectory() as temp_dir:
            script.DASHBOARD_LAYOUTS_FILE = Path(temp_dir) / "dashboard-layouts.json"
            try:
                script.save_dashboard_layout("Mesa A", {"items": [{"type": "summary"}]})
                script.save_dashboard_layout("Mesa B", {"items": [{"type": "flags"}]})
                deleted_name = script.delete_dashboard_layout("Mesa B")
                layouts = script.list_dashboard_layouts()
                last_layout_name = script.get_last_dashboard_layout_name()
            finally:
                script.DASHBOARD_LAYOUTS_FILE = previous_file

        self.assertEqual(deleted_name, "Mesa B")
        self.assertEqual([layout["name"] for layout in layouts], ["Mesa A"])
        self.assertEqual(last_layout_name, "")

    def test_list_dashboard_layouts_sorts_and_counts_items(self):
        previous_file = script.DASHBOARD_LAYOUTS_FILE
        with tempfile.TemporaryDirectory() as temp_dir:
            script.DASHBOARD_LAYOUTS_FILE = Path(temp_dir) / "dashboard-layouts.json"
            try:
                script.save_dashboard_layout("B", {"items": [{"type": "summary"}]})
                script.save_dashboard_layout(
                    "A",
                    {"items": [{"type": "flags"}, {"type": "portfolioActions"}]},
                )
                layouts = script.list_dashboard_layouts()
            finally:
                script.DASHBOARD_LAYOUTS_FILE = previous_file

        self.assertEqual([layout["name"] for layout in layouts], ["A", "B"])
        self.assertEqual(layouts[0]["objectCount"], 2)

    def test_fetch_list_dashboard_layouts_can_include_last_layout_payload(self):
        previous_file = script.DASHBOARD_LAYOUTS_FILE
        with tempfile.TemporaryDirectory() as temp_dir:
            script.DASHBOARD_LAYOUTS_FILE = Path(temp_dir) / "dashboard-layouts.json"
            try:
                script.save_dashboard_layout(
                    "Mesa",
                    {"items": [{"type": "portfolioActions", "x": 10, "y": 20, "width": 520, "height": 190}]},
                )
                with patch("script.emit") as mock_emit:
                    script.fetch_list_dashboard_layouts({"includeLastLayout": True})
            finally:
                script.DASHBOARD_LAYOUTS_FILE = previous_file

        payload = mock_emit.call_args.args[0]
        self.assertEqual(payload["lastLayoutName"], "Mesa")
        self.assertEqual(payload["lastLayout"]["items"][0]["type"], "portfolioActions")

    @patch("script.get_quote_symbols")
    @patch("script.get_quote_instruments")
    def test_get_symbols_for_market_discovers_instruments_and_filters_response(
        self, mock_get_quote_instruments, mock_get_quote_symbols
    ):
        mock_get_quote_instruments.return_value = ["acciones"]

        def quote_symbols(_token, country, _instrument):
            if country == "estados_Unidos":
                return [
                    {"simbolo": "AAPL", "mercado": "3", "plazo": "", "moneda": "2", "instrumento": "acciones"},
                    {"simbolo": "MSFT", "mercado": "nASDAQ", "plazo": "", "moneda": "USD", "instrumento": "acciones"},
                ]
            return [
                {"simbolo": "ALUA", "mercado": "1", "plazo": "t0", "moneda": "1", "instrumento": "acciones"},
            ]

        mock_get_quote_symbols.side_effect = quote_symbols

        result = script.get_symbols_for_market("token", "nASDAQ")

        self.assertEqual([item["simbolo"] for item in result["simbolos"]], ["AAPL", "MSFT"])
        self.assertEqual(result["consultas"]["paises"], ["estados_Unidos"])
        self.assertEqual(result["consultas"]["instrumentos"], 1)
        self.assertEqual(result["consultas"]["exitosas"], 1)

    @patch("script.get_quote_symbols")
    @patch("script.get_quote_instruments")
    def test_get_symbols_for_market_falls_back_to_next_country_when_preferred_has_no_matches(
        self, mock_get_quote_instruments, mock_get_quote_symbols
    ):
        mock_get_quote_instruments.return_value = ["acciones"]

        def quote_symbols(_token, country, _instrument):
            if country == "estados_Unidos":
                return [
                    {"simbolo": "ALUA", "mercado": "bCBA", "plazo": "t0", "moneda": "peso_Argentino", "instrumento": "acciones"},
                ]
            return [
                {"simbolo": "IBM", "mercado": "nYSE", "plazo": "", "moneda": "dolar", "instrumento": "acciones"},
            ]

        mock_get_quote_symbols.side_effect = quote_symbols

        result = script.get_symbols_for_market("token", "nYSE")

        self.assertEqual([item["simbolo"] for item in result["simbolos"]], ["IBM"])
        self.assertEqual(result["consultas"]["paises"], ["estados_Unidos", "argentina"])


if __name__ == "__main__":
    unittest.main()
