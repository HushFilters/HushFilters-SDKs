"""Dependency-free synchronous HTTP client for HushClient."""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import ssl
import time
from collections.abc import Mapping, Sequence
from typing import Any, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener

from . import models
from .errors import (APIError, ProtocolError, RequestTimeoutError, SyncFailedError,
                     SyncTimeoutError, TransportError)


def credential_hash(username: str, password: str = "") -> str:
    """SHA256(UTF8(username + 'nWebbed' + password)), with no normalization."""
    return hashlib.sha256((username + "nWebbed" + password).encode("utf-8")).hexdigest()


def _positive(value: float, name: str) -> None:
    if isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


class HushClient:
    """Connect to the public API (normally nginx on https://localhost).

    TLS is verified by default. Pass ca_file for a private/self-signed CA, or
    verify_tls=False explicitly for local development. Each call closes its
    connection. Redirects, proxies, and automatic retries are disabled.
    """

    def __init__(self, base_url: str = "https://localhost", *, timeout: float = 30,
                 verify_tls: bool = True, ca_file: str | None = None,
                 headers: Mapping[str, str] | None = None) -> None:
        parsed = urlsplit(base_url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment):
            raise ValueError("base_url must be an HTTP(S) URL without credentials, query, or fragment")
        _ = parsed.port  # Validate malformed ports at construction time.
        _positive(timeout, "timeout")
        if not verify_tls and ca_file is not None:
            raise ValueError("ca_file cannot be combined with verify_tls=False")
        context = ssl.create_default_context(cafile=ca_file)
        if not verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {"accept": "application/json", "user-agent": "hushclient-python/0.1.0"}
        self._headers.update({k.lower(): v for k, v in (headers or {}).items()})
        self._opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), _NoRedirects())

    def _request(self, method: str, path: str, *, body: Any = None,
                 query: Mapping[str, str] | None = None, timeout: float | None = None) -> Any:
        url = self.base_url + path
        if query is not None:
            url += "?" + urlencode(query)
        headers = dict(self._headers)
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["content-type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)
        try:
            try:
                response = self._opener.open(request, timeout=self.timeout if timeout is None else timeout)
            except HTTPError as exc:
                response = exc
            with response:
                status = response.code
                response_headers = dict(response.headers.items())
                raw = response.read()
        except (URLError, OSError, http.client.HTTPException) as exc:
            reason = exc.reason if isinstance(exc, URLError) else exc
            if isinstance(reason, TimeoutError):
                raise RequestTimeoutError(f"HushClient request timed out for {method} {path}") from None
            raise TransportError(f"HushClient connection failed for {method} {path}") from None
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            payload = raw.decode("utf-8", errors="replace")
        if not 200 <= status < 300:
            raise APIError(status, method, path, payload, response_headers)
        if not isinstance(payload, dict):
            raise ProtocolError(f"Expected a JSON object for {method} {path}")
        return payload

    def info(self) -> models.RootResponse:
        return cast(models.RootResponse, self._request("GET", "/"))

    def health(self) -> models.HealthResponse:
        return cast(models.HealthResponse, self._request("GET", "/health"))

    def stats(self) -> models.StatsResponse:
        return cast(models.StatsResponse, self._request("GET", "/stats"))

    def check(self, username: str, password: str = "") -> models.CheckResponse:
        """Check credentials using a JSON POST. Use check_hash to hash locally."""
        return cast(models.CheckResponse, self._request("POST", "/check", body={"username": username, "password": password}))

    def check_get(self, username: str, password: str = "") -> models.CheckResponse:
        """GET compatibility endpoint; credentials can appear in access logs."""
        return cast(models.CheckResponse, self._request("GET", "/check", query={"username": username, "password": password}))

    def check_batch(self, credentials: Sequence[models.CheckRequest]) -> models.BatchCheckResponse:
        return cast(models.BatchCheckResponse, self._request("POST", "/check/batch", body={"credentials": list(credentials)}))

    def check_hash(self, digest: str) -> models.CheckResponse:
        return cast(models.CheckResponse, self._request("POST", "/checkhash", body={"hash": digest}))

    def check_hash_batch(self, hashes: Sequence[str]) -> models.BatchHashCheckResponse:
        return cast(models.BatchHashCheckResponse, self._request("POST", "/checkhash/batch", body={"hashes": list(hashes)}))

    def sync_apply(self) -> models.SyncApplyStartResponse:
        """Start a background refresh (HTTP 202); use wait_for_sync to wait."""
        return cast(models.SyncApplyStartResponse, self._request("POST", "/sync/apply"))

    def sync_filters(self) -> models.SyncFiltersResponse:
        """Download/verify filters synchronously; may need a longer timeout."""
        return cast(models.SyncFiltersResponse, self._request("POST", "/sync/filters"))

    def update_manifest(self) -> models.ManifestUpdateResponse:
        return cast(models.ManifestUpdateResponse, self._request("POST", "/sync/manifest"))

    def reload_filters(self) -> models.ReloadFiltersResponse:
        return cast(models.ReloadFiltersResponse, self._request("POST", "/sync/reload"))

    def sync_status(self) -> models.SyncStatusResponse:
        return cast(models.SyncStatusResponse, self._request("GET", "/sync/status"))

    def auto_update_status(self) -> models.AutoUpdateStatusResponse:
        return cast(models.AutoUpdateStatusResponse, self._request("GET", "/sync/auto-update"))

    def configure_auto_update(self, enabled: bool, hour: int | None = None) -> models.AutoUpdateStatusResponse:
        """Persist the daily schedule; hour uses the container's local timezone."""
        return cast(models.AutoUpdateStatusResponse, self._request("PUT", "/sync/auto-update", body={"enabled": enabled, "hour": hour}))

    def wait_for_sync(self, *, timeout: float = 3600, poll_interval: float = 2) -> models.SyncStatusResponse:
        """Poll global sync status. Does not start or cancel an operation.

        The API has no job IDs, so this observes the current/latest operation.
        An inactive server with success=None is returned unchanged.
        """
        _positive(timeout, "timeout")
        _positive(poll_interval, "poll_interval")
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SyncTimeoutError("Timed out waiting for sync; the server operation was not cancelled")
            status = cast(models.SyncStatusResponse, self._request("GET", "/sync/status", timeout=min(self.timeout, remaining)))
            if not status["active"]:
                if status.get("success") is False:
                    raise SyncFailedError(status)
                return status
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))

