"""Opt-in, non-mutating tests against a running HushClient instance."""
import os
import unittest

from hushclient import APIError, HushClient, credential_hash


@unittest.skipUnless(os.getenv("HUSHCLIENT_INTEGRATION") == "1", "Set HUSHCLIENT_INTEGRATION=1 to test localhost")
class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = HushClient(
            os.getenv("HUSHCLIENT_BASE_URL", "https://localhost"),
            ca_file=os.getenv("HUSHCLIENT_CA_FILE"),
            verify_tls=os.getenv("HUSHCLIENT_INSECURE") != "1",
        )

    def test_health_stats_and_info(self):
        self.assertEqual(self.client.info()["name"], "HushFilter API")
        health, stats = self.client.health(), self.client.stats()
        self.assertEqual(health["status"], "healthy")
        self.assertGreater(health["filters_loaded"], 0)
        self.assertEqual(stats["filter_count"], len(stats["filters"]))
        self.assertIsInstance(health["test_mode"], bool)

    def test_four_documented_positive_credentials_and_hashes(self):
        for i in range(1, 5):
            username, password = f"testusername{i}@nwebbed.com", f"testpassword{i}"
            with self.subTest(i=i):
                credential = self.client.check(username, password)
                hashed = self.client.check_hash(credential_hash(username, password))
                self.assertTrue(credential["found"])
                self.assertTrue(credential["matching_filters"])
                self.assertEqual(credential, hashed)

    def test_get_and_empty_password(self):
        self.assertTrue(self.client.check_get("testusername1@nwebbed.com", "testpassword1")["found"])
        self.assertEqual(self.client.check("sdk-test+unicode-密碼"),
                         self.client.check_hash(credential_hash("sdk-test+unicode-密碼")))

    def test_batches_duplicates_empty_and_hash_case(self):
        username, password = "testusername1@nwebbed.com", "testpassword1"
        digest = credential_hash(username, password)
        batch = self.client.check_batch([{"username": username, "password": password}] * 2)
        self.assertEqual(batch["total"], 2)
        self.assertEqual(batch["found_usernames"], [username])
        hashes = self.client.check_hash_batch([digest, digest, digest.upper()])
        self.assertEqual(hashes["total"], 3)
        self.assertEqual(hashes["found_hashes"], [digest, digest.upper()])
        self.assertEqual(self.client.check_batch([])["found_usernames"], [])
        self.assertEqual(self.client.check_hash_batch([])["found_hashes"], [])

    def test_read_only_sync_metadata(self):
        self.assertIsInstance(self.client.sync_status()["active"], bool)
        schedule = self.client.auto_update_status()
        self.assertIsInstance(schedule["enabled"], bool)
        self.assertIsInstance(schedule["timezone"], str)

    def test_server_validation(self):
        for call, code in ((lambda: self.client.check_hash("invalid"), 400),
                           (lambda: self.client.check_hash_batch(["invalid"]), 400),
                           (lambda: self.client.configure_auto_update(True, 24), 422)):
            with self.assertRaises(APIError) as caught:
                call()
            self.assertEqual(caught.exception.status_code, code)
            self.assertIsNotNone(caught.exception.detail)


if __name__ == "__main__":
    unittest.main()

