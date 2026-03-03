import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import script


class ScriptTokenTests(unittest.TestCase):
    def test_parse_token_expiration_valid_rfc1123(self):
        token_data = {".expires": "Tue, 03 Mar 2026 20:28:57 GMT"}
        expires_at = script.parse_token_expiration(token_data)

        self.assertIsNotNone(expires_at)
        self.assertEqual(expires_at.tzinfo, timezone.utc)
        self.assertEqual(expires_at.year, 2026)

    def test_token_is_still_valid_false_without_access_token(self):
        self.assertFalse(script.token_is_still_valid({}))

    def test_token_is_still_valid_false_when_expired(self):
        expired = datetime.now(timezone.utc) - timedelta(seconds=5)
        token_data = {".expires": expired.strftime("%a, %d %b %Y %H:%M:%S GMT"), "access_token": "abc"}
        self.assertFalse(script.token_is_still_valid(token_data))

    @patch("script.load_json_file")
    @patch("script.token_is_still_valid")
    def test_get_access_token_uses_cache_when_valid(self, mock_is_valid, mock_load):
        mock_is_valid.return_value = True
        mock_load.return_value = {"access_token": "cached-token"}

        token, source = script.get_access_token()
        self.assertEqual(token, "cached-token")
        self.assertEqual(source, "cache")

    @patch("script.refresh_or_create_token")
    @patch("script.load_json_file")
    @patch("script.token_is_still_valid")
    def test_get_access_token_uses_refresh_when_expired(self, mock_is_valid, mock_load, mock_refresh):
        mock_is_valid.return_value = False
        mock_load.return_value = {"access_token": "old", "refresh_token": "r1"}
        mock_refresh.return_value = ({"access_token": "new-token"}, "refresh_token")

        token, source = script.get_access_token()
        self.assertEqual(token, "new-token")
        self.assertEqual(source, "refresh_token")

    @patch("script.read_credentials")
    @patch("script.request_token")
    def test_refresh_or_create_token_fallback_to_password_grant(self, mock_request_token, mock_read_credentials):
        mock_read_credentials.return_value = {"username": "user", "password": "pass"}
        mock_request_token.return_value = {"access_token": "new", "expires_in": 1200, "refresh_token": "rt"}

        with patch("script.save_json_file") as mock_save:
            token, source = script.refresh_or_create_token({})
            self.assertEqual(token["access_token"], "new")
            self.assertEqual(source, "password_grant")
            self.assertTrue(mock_save.called)


if __name__ == "__main__":
    unittest.main()
