"""Errors retain response data without including credentials in their messages."""
from __future__ import annotations

from typing import Any, Mapping


class HushClientError(Exception):
    """Base SDK error."""


class APIError(HushClientError):
    """A non-2xx HTTP response, including 409 conflicts and 422 validation errors."""

    def __init__(self, status_code: int, method: str, path: str, body: Any,
                 headers: Mapping[str, str]) -> None:
        super().__init__(f"HushClient returned HTTP {status_code} for {method} {path}")
        self.status_code = status_code
        self.method = method
        self.path = path
        self.body = body
        self.headers = dict(headers)
        self.detail = body.get("detail") if isinstance(body, dict) else None


class TransportError(HushClientError):
    """Connection, TLS, timeout, or interrupted-response failure."""


class RequestTimeoutError(TransportError):
    """A network operation exceeded the configured timeout."""


class ProtocolError(HushClientError):
    """The server returned a successful response that is not a JSON object."""


class SyncFailedError(HushClientError):
    """A completed background sync reported success=false."""

    def __init__(self, status: Mapping[str, Any]) -> None:
        super().__init__("HushClient background sync failed; inspect status for details")
        self.status = status


class SyncTimeoutError(HushClientError):
    """Polling timed out; the server-side sync may still be running."""

