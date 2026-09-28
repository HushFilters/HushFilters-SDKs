import json
import math
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from hushclient import (
    APIError, HushClient, ProtocolError, RequestTimeoutError, SyncFailedError,
    SyncTimeoutError, TransportError, credential_hash,
)

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "testdata/contract.json").read_text(encoding="utf-8"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        size = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(size)
        self.server.received.append({
            "method": self.command, "url": urlsplit(self.path),
            "body": json.loads(raw) if raw else None, "headers": self.headers,
        })
        reply = self.server.replies.pop(0) if self.server.replies else {"body": {"active": True}}
        if hasattr(self.server, "routes"):
            reply = self.server.routes.get(urlsplit(self.path).path, {"status": 404})
        time.sleep(reply.get("delay", 0))
        data = reply.get("raw", json.dumps(reply.get("body", {}))).encode("utf-8")
        try:
            self.send_response(reply.get("status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for key, value in reply.get("headers", {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    do_POST = do_GET
    do_PUT = do_GET


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.received = []
        self.server.replies = []
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/prefix/"
        self.client = HushClient(self.base_url, headers={"X-Test": "sdk"})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_contract_covers_every_json_operation(self):
        schema = json.loads((ROOT / "api/openapi.json").read_text(encoding="utf-8"))
        operations = {(m.upper(), p) for p, methods in schema["paths"].items()
                      if not p.startswith("/ui-") for m, operation in methods.items()
                      if any("application/json" in response.get("content", {})
                             for status, response in operation.get("responses", {}).items()
                             if status.startswith("2"))}
        self.assertEqual(operations, {(c["method"], c["path"]) for c in CASES})

    def test_info_uses_json_directory_when_home_is_html(self):
        expected = {"name": "HushFilter API", "version": "1.0.0",
                    "endpoints": {"home": "/", "endpoints": "/endpoints"}, "test_mode": False}
        self.server.routes = {
            "/prefix/": {"raw": "<html>Hushfilters home</html>"},
            "/prefix/endpoints": {"body": expected},
        }
        self.assertEqual(self.client.info(), expected)
        self.assertEqual([r["url"].path for r in self.server.received], ["/prefix/endpoints"])

    def test_optional_password_and_empty_batches(self):
        self.server.replies = [{"body": {}}] * 4
        self.client.check("username")
        self.client.check_batch([])
        self.client.check_hash_batch([])
        self.client.configure_auto_update(False)
        self.assertEqual([r["body"] for r in self.server.received], [
            {"username": "username", "password": ""}, {"credentials": []},
            {"hashes": []}, {"enabled": False, "hour": None},
        ])

    def test_http_errors_preserve_json_detail_and_headers_without_retry(self):
        for code in (400, 409, 422, 500, 503):
            with self.subTest(code=code):
                body = {"detail": [{"msg": "invalid", "input": "secret-password"}], "test_mode": False, "logs": ["failure"]}
                self.server.replies = [{"status": code, "body": body, "headers": {"Retry-After": "5"}}]
                before = len(self.server.received)
                with self.assertRaises(APIError) as caught:
                    self.client.check_get("private-user", "secret-password")
                error = caught.exception
                self.assertEqual(error.status_code, code)
                self.assertEqual(error.body, body)
                self.assertEqual(error.detail, body["detail"])
                self.assertEqual(error.headers["Retry-After"], "5")
                self.assertNotIn("secret-password", str(error))
                self.assertNotIn("private-user", str(error))
                self.assertEqual(len(self.server.received), before + 1)

    def test_html_error_and_redirect_are_not_followed(self):
        for code in (502, 302, 307):
            self.server.replies = [{"status": code, "raw": "<html>gateway</html>", "headers": {"Location": self.base_url}}]
            before = len(self.server.received)
            with self.assertRaises(APIError) as caught:
                self.client.health()
            self.assertEqual(caught.exception.body, "<html>gateway</html>")
            self.assertEqual(len(self.server.received), before + 1)

    def test_malformed_success_responses(self):
        for raw in ("bad json", "[]", "null", '"string"', ""):
            self.server.replies = [{"raw": raw}]
            with self.assertRaises(ProtocolError):
                self.client.health()

    def test_timeout(self):
        self.server.replies = [{"delay": 0.2}]
        with self.assertRaises(RequestTimeoutError):
            HushClient(self.base_url, timeout=0.03).health()

    def test_connection_refused(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_port
        server.server_close()
        with self.assertRaises(TransportError):
            HushClient(f"http://127.0.0.1:{port}", timeout=0.1).health()

    def test_poll_active_then_complete(self):
        complete = {"active": False, "success": True, "filter_count": 2}
        self.server.replies = [{"body": {"active": True}}, {"body": complete}]
        self.assertEqual(self.client.wait_for_sync(poll_interval=0.001), complete)

    def test_poll_failure_and_idle(self):
        failed = {"active": False, "success": False, "detail": "sync failed", "logs": ["failure"]}
        self.server.replies = [{"body": failed}]
        with self.assertRaises(SyncFailedError) as caught:
            self.client.wait_for_sync()
        self.assertEqual(caught.exception.status, failed)
        self.server.replies = [{"body": {"active": False, "success": None}}]
        self.assertIsNone(self.client.wait_for_sync()["success"])

    def test_poll_deadline_and_invalid_durations(self):
        with self.assertRaises(SyncTimeoutError):
            self.client.wait_for_sync(timeout=0.03, poll_interval=1)
        for value in (0, -1, math.nan, math.inf, True):
            with self.assertRaises(ValueError):
                HushClient(timeout=value)
            with self.assertRaises(ValueError):
                self.client.wait_for_sync(poll_interval=value)

    def test_invalid_base_urls_and_tls_options(self):
        for url in ("localhost", "ftp://localhost", "https://user:password@localhost", "https://localhost/?q=x", "https://localhost/#f", "https://localhost:bad"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                HushClient(url)
        with self.assertRaises(ValueError):
            HushClient(verify_tls=False, ca_file="unused")

    def test_hash_known_vector_and_unicode(self):
        self.assertEqual(credential_hash("testusername1@nwebbed.com", "testpassword1"),
                         "29f33573df6d1c7aac289e5c75e0bce5e4939e69c0499fb7e2540b7f371c59d9")
        vectors = json.loads((ROOT / "testdata/hashes.json").read_text(encoding="utf-8"))
        for v in vectors:
            self.assertEqual(credential_hash(v["username"], v["password"]), v["hash"])


def route_test(case):
    def test(self):
        self.server.replies = [{"status": case.get("status", 200), "body": case["response"]}]
        result = getattr(self.client, case["python"])(*case["args"])
        self.assertEqual(result, case["response"])
        self.assertEqual(len(self.server.received), 1)
        request = self.server.received[0]
        self.assertEqual(request["method"], case["method"])
        self.assertEqual(request["url"].path, "/prefix" + case["path"])
        self.assertEqual(parse_qs(request["url"].query, keep_blank_values=True),
                         {k: [v] for k, v in case.get("query", {}).items()})
        self.assertEqual(request["body"], case.get("body"))
        self.assertEqual(request["headers"]["X-Test"], "sdk")
        self.assertEqual(request["headers"]["Accept"], "application/json")
        if "body" in case:
            self.assertEqual(request["headers"]["Content-Type"], "application/json")
    return test


for case in CASES:
    setattr(ClientTests, "test_route_" + case["python"], route_test(case))


if __name__ == "__main__":
    unittest.main()
