import base64
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
