# HushClient Python SDK

A typed, synchronous Python 3.11+ client for the HushClient API. No runtime dependencies. Responses are ordinary dictionaries with `TypedDict` annotations in `hushclient.models`; the package includes a `py.typed` marker.

## Install

From the parent repository:

```sh
python -m pip install ./python
```

For development, use `python -m pip install -e './python[dev]'` in a virtual environment. The package name is `hushclient-sdk`, and the import is `hushclient`. This repository has not published a PyPI release.

## Check credentials and hashes

```python
from hushclient import HushClient, credential_hash

client = HushClient(
    "https://localhost",
    ca_file=r"C:\HushClient\tls\public\fullchain.pem",
)

print(client.health())

# Hash locally before sending the request.
digest = credential_hash("testusername1@nwebbed.com", "testpassword1")
result = client.check_hash(digest)
print(result["found"], result["matching_filters"])

# JSON POST with raw credentials, when that is appropriate for your deployment.
result = client.check("testusername1@nwebbed.com", "testpassword1")

batch = client.check_batch([
    {"username": "testusername1@nwebbed.com", "password": "testpassword1"},
    {"username": "another-user"},  # password defaults to the empty string
])
print(batch["total"], batch["found_usernames"])
print(client.check_hash_batch([digest])["found_hashes"])
```

Hashing is SHA-256 of UTF-8 `username + "nWebbed" + password`, with no trimming, case conversion, or Unicode normalization. Batch responses contain distinct matching values, not one boolean per input. A Bloom-filter match can be a false positive.

## Configuration

| Constructor argument | Default | Meaning |
| --- | --- | --- |
| `base_url` | `https://localhost` | Public API URL; optional path prefix, no `/docs` suffix |
| `timeout` | `30` | Positive socket-operation timeout, in seconds |
| `verify_tls` | `True` | Validate certificate trust and hostname |
| `ca_file` | `None` | Path to a trusted PEM CA bundle or the local self-signed public certificate |
| `headers` | `None` | Extra headers, such as authorization for a custom gateway |

The SDK connects directly and ignores environment proxy settings. It does not need the container's internal mTLS keys or nWebbed storage API key.

Each request closes its connection; there is no session to close and no context-manager requirement. Methods block until their HTTP response arrives. In an asynchronous application, call through `asyncio.to_thread` if needed. Timeouts apply to blocking network operations rather than a strict total wall-clock deadline. A timed-out administrative request may still be executing on the server.

## HTTPS certificate trust

HushClient's default local HTTPS certificate is self-signed, so Python does not trust it by default. HTTPS checks certificate trust and the requested hostname before sending an API request. If you omit explicit trust for this self-signed certificate, the TLS handshake fails and the SDK raises `TransportError`, including for `health()`.

The included examples/tests use `HUSHCLIENT_CA_FILE` to specify the public certificate or CA bundle. They pass its file path to the SDK's `ca_file` constructor option. **The SDK itself does not read the environment variable.** Your application can configure trust directly:

```python
# Explicit trust for the default local self-signed certificate; no env var needed.
client = HushClient(
    "https://localhost",
    ca_file=r"C:\HushClient\tls\public\fullchain.pem",
)

# If the HTTPS certificate's CA is already trusted by Python, omit ca_file.
client = HushClient("https://hushclient.example.com")
```

For a valid certificate issued by a CA already trusted by Python, neither `ca_file` nor `HUSHCLIENT_CA_FILE` is needed: Python verifies the server using its existing trust configuration. For an organization/private CA, provide its CA bundle unless Python already trusts it. Browser trust alone does not establish Python's trust.

The file contains a **public certificate**, not a private key. Supplying it keeps certificate and hostname verification enabled and affects only this SDK client, not system-wide trust settings.

Local development can explicitly use `HushClient(verify_tls=False)`, or `HUSHCLIENT_INSECURE=1` when running the examples. This disables the server-identity check; it does not make the certificate trusted. Omit `ca_file` and unset `HUSHCLIENT_CA_FILE` when using this bypass, because the SDK rejects combining the two settings. For trusted HTTPS, leave the insecure flag unset so verification remains enabled.

## Methods

| Method | Returns |
| --- | --- |
| `info()` | `models.RootResponse` |
| `health()` | `models.HealthResponse` |
| `stats()` | `models.StatsResponse` |
| `check(username, password="")` | `models.CheckResponse` |
| `check_get(username, password="")` | `models.CheckResponse` (GET; credentials appear in URL) |
| `check_batch(credentials)` | `models.BatchCheckResponse` |
| `check_hash(digest)` | `models.CheckResponse` |
| `check_hash_batch(hashes)` | `models.BatchHashCheckResponse` |
| `sync_apply()` | `models.SyncApplyStartResponse` (202 accepted) |
| `sync_filters()` | `models.SyncFiltersResponse` |
| `update_manifest()` | `models.ManifestUpdateResponse` |
| `reload_filters()` | `models.ReloadFiltersResponse` |
| `sync_status()` | `models.SyncStatusResponse` |
| `auto_update_status()` | `models.AutoUpdateStatusResponse` |
| `configure_auto_update(enabled, hour=None)` | `models.AutoUpdateStatusResponse` |
| `wait_for_sync(timeout=3600, poll_interval=2)` | `models.SyncStatusResponse` |

`check_batch` takes a sequence of `models.CheckRequest` dictionaries. `check_hash_batch` takes a sequence of hex strings. Arguments for `wait_for_sync` are keyword-only and measured in seconds. The SDK sends each batch as one request; split large batches to fit your server's request-size limit (10 MB in the default nginx configuration).

## Administrative operations

```python
# Explicitly start a refresh. This can download large filter files.
started = client.sync_apply()
if started["started"]:
    final = client.wait_for_sync(timeout=7200, poll_interval=2)
    print(final.get("filter_count"), final.get("logs", []))

# Inspect scheduler timezone before choosing the daily hour.
print(client.auto_update_status()["timezone"])
client.configure_auto_update(True, hour=23)
client.configure_auto_update(False)
```

`sync_apply` returns immediately after acceptance. Polling observes the global current/latest operation; the API has no job IDs and concurrent callers can replace that status. An inactive status with `success=None` is returned as-is. `success=False` raises `SyncFailedError` with `.status`. A polling deadline raises `SyncTimeoutError`; a failed network poll raises a transport error. Neither stops server work. Each poll's network timeout is capped to the remaining polling budget, subject to the socket-operation timeout semantics above.

Standalone `sync_filters`, `update_manifest`, and `reload_filters` wait for their HTTP response. Use a separate `HushClient(timeout=600, ...)` when these operations take longer. They may return HTTP 409 while another operation is active. Automatic-update configuration is persisted on the server; the hour uses the container timezone, and enabling requires `0`–`23`.

## Errors

```python
from hushclient import APIError, HushClientError, RequestTimeoutError

try:
    client.check_hash("invalid")
except APIError as exc:
    print(exc.status_code)  # 400 for an invalid hash
    # exc.detail: FastAPI detail string/list, if present
    # exc.body: entire decoded JSON payload or non-JSON response text
    # exc.headers, exc.method, exc.path: response/request metadata
except RequestTimeoutError:
    print("Request timed out")
except HushClientError:
    print("Connection or response failed")
```

All SDK errors derive from `HushClientError`. `TransportError` covers connection/TLS/response-read failures, `RequestTimeoutError` specializes it, and `ProtocolError` indicates a 2xx response that is not a JSON object. Input configuration errors use `ValueError`. HTTP failures include redirects, 400, 409, 422, and 5xx responses. Requests are not automatically retried or redirected.

Error messages exclude input credentials, query strings, and response bodies. Explicit `.body`, `.detail`, and sync `.status` data may contain inputs echoed by the server; redact them before logging. Responses retain server fields without full runtime schema validation.

## Runnable examples and tests

From the repository root:

```powershell
$env:HUSHCLIENT_CA_FILE = 'C:\HushClient\tls\public\fullchain.pem'
python python/examples/basic.py
python python/examples/sync.py         # reads status only
python python/examples/sync.py --apply # explicitly starts a refresh

python -m unittest discover -s python/tests -p test_client.py -v
$env:HUSHCLIENT_INTEGRATION = '1'
python -m unittest discover -s python/tests -p test_integration.py -v
```

Examples and integration tests read `HUSHCLIENT_BASE_URL`, `HUSHCLIENT_CA_FILE`, and `HUSHCLIENT_INSECURE=1` (local development only). Those variables are conveniences in example/test code, not implicit SDK configuration. Integration tests never start a sync or persist scheduler changes. See the [parent README](../README.md) for build, type-check, and API semantics, and [CONTRACT_MAINTENANCE.md](../CONTRACT_MAINTENANCE.md) for contract-maintenance instructions.
