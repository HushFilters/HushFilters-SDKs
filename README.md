# HushClient SDKs

Python and Node.js/TypeScript clients for the containerized **HushClient / HushFilter API**. Both SDKs cover all 15 JSON operations in API version `1.0.0`, have no runtime dependencies, and include credential hashing, typed responses, TLS configuration, error handling, and background-sync polling.

| SDK | Requirements | Documentation |
| --- | --- | --- |
| [Python](python/) | Python 3.11+ | [Python README and examples](python/README.md) |
| [Node.js / TypeScript](typescript/) | Node.js 22+; ESM | [TypeScript README and examples](typescript/README.md) |

These packages are provided in this repository; the installation commands below use local paths. They have not been published to PyPI or npm.

## Quick start

Start HushClient separately and make sure filters are loaded. Its Swagger UI is normally at [https://localhost/docs](https://localhost/docs), and the public API base URL is `https://localhost` (without `/docs`). SDK requests go through nginx; its internal connection to the API handles mTLS. No internal client certificate or nWebbed storage key belongs in SDK configuration. Custom headers are supported if your own gateway requires authentication.

From this repository root:

```powershell
# Python
python -m pip install ./python
$env:HUSHCLIENT_CA_FILE = 'C:\HushClient\tls\public\fullchain.pem'
python python/examples/basic.py

# Node.js / TypeScript (build and run the included example)
cd typescript
npm ci
npm run example
```

Replace the certificate path above with the location of your HushClient public certificate. The examples also read `HUSHCLIENT_BASE_URL` to select another API URL.

## HTTPS certificate trust and HUSHCLIENT_CA_FILE

HTTPS verifies the server's identity as well as encrypting traffic. Before sending an API request, Python or Node.js checks that the server's certificate is valid for the requested hostname and can be traced to a certificate authority (CA) that the runtime trusts.

HushClient's default local deployment generates a **self-signed certificate**. It is signed by itself, rather than by an authority already trusted by Python or Node.js. Connecting to `localhost` does not bypass that check. `HUSHCLIENT_CA_FILE` tells the included examples and integration tests which public certificate or CA bundle to trust explicitly. For the default local deployment, use `HushClient/tls/public/fullchain.pem`.

**If you omit this value with the default self-signed setup and have not configured trust another way, the TLS handshake fails.** The SDK raises `TransportError` before sending the HTTP API request; even `health()` fails. Supplying the certificate keeps certificate and hostname verification enabled. It is a public certificate, not a private key, API key, or client-authentication credential.

| Deployment/configuration | Is `HUSHCLIENT_CA_FILE` needed? | Why? |
| --- | --- | --- |
| Default self-signed HushClient HTTPS deployment | Yes, for the included examples/tests, unless trust is configured another way | The runtime does not trust that certificate by default. |
| HTTPS certificate issued by a CA already trusted by the runtime | No | The runtime can verify the server using its existing trust configuration. The server must still provide a valid certificate chain for the requested hostname. |
| Organization/private CA | Only if that CA is not already trusted by the runtime | Provide the organization's CA bundle, or configure the runtime to trust it. Trust in a browser or the operating system does not necessarily mean both runtimes use that same trust configuration. |
| Your application supplies Python `ca_file` or TypeScript `ca` directly | No environment variable is needed | The certificate is supplied through SDK constructor options instead. |
| Explicit local-development bypass (`HUSHCLIENT_INSECURE=1`) | No; unset the CA-file variable | Verification is disabled, so the server's identity is not checked. Use this only for local development. |

The SDK constructors **do not read `HUSHCLIENT_CA_FILE` themselves**. The example/test code reads it and passes the file path to Python's `ca_file`, or reads the file and passes its PEM contents to TypeScript's `ca`. Your application can supply those options directly, as shown in the [Python README](python/README.md#https-certificate-trust) and [TypeScript README](typescript/README.md#https-certificate-trust). This changes trust for that SDK client only, not your computer's system-wide trust settings.

For an already trusted HTTPS deployment, leave `HUSHCLIENT_CA_FILE` unset and omit `ca_file`/`ca`. Verification remains enabled. To clear a previously set example variable in PowerShell:

```powershell
Remove-Item Env:HUSHCLIENT_CA_FILE -ErrorAction SilentlyContinue
Remove-Item Env:HUSHCLIENT_INSECURE -ErrorAction SilentlyContinue
```

For a local-development bypass, clear the CA-file variable and explicitly set `$env:HUSHCLIENT_INSECURE = '1'`. The SDK rejects combining a CA file with disabled verification.

## Supported API

Responses keep the API's original `snake_case` JSON field names in both languages. Python returns typed dictionaries; TypeScript returns typed objects in promises. Input validation errors come from the server, including HTTP 400 for malformed hashes and HTTP 422 for malformed request shapes or invalid schedule settings.

| API operation | Python | TypeScript |
| --- | --- | --- |
| `GET /endpoints` | `info()` | `info()` |
| `GET /health` | `health()` | `health()` |
| `GET /stats` | `stats()` | `stats()` |
| `POST /check` | `check(username, password="")` | `check(username, password="")` |
| `GET /check` | `check_get(username, password="")` | `checkGet(username, password="")` |
| `POST /check/batch` | `check_batch(credentials)` | `checkBatch(credentials)` |
| `POST /checkhash` | `check_hash(digest)` | `checkHash(digest)` |
| `POST /checkhash/batch` | `check_hash_batch(hashes)` | `checkHashBatch(hashes)` |
| `POST /sync/apply` | `sync_apply()` | `syncApply()` |
| `POST /sync/filters` | `sync_filters()` | `syncFilters()` |
| `POST /sync/manifest` | `update_manifest()` | `updateManifest()` |
| `POST /sync/reload` | `reload_filters()` | `reloadFilters()` |
| `GET /sync/status` | `sync_status()` | `syncStatus()` |
| `GET /sync/auto-update` | `auto_update_status()` | `autoUpdateStatus()` |
| `PUT /sync/auto-update` | `configure_auto_update(enabled, hour=None)` | `configureAutoUpdate(enabled, hour=null)` |

HTML pages (`/`, `/docs`, `/ui-check`, `/ui-sync`) and static assets are browser interfaces, not SDK methods. `info()` uses the JSON directory at `/endpoints`; servers predating that route must be upgraded. The `RootResponse` type name is retained for source compatibility.

## API behavior to know

- Local hashing is exactly `SHA256(UTF8(username + "nWebbed" + password))`, returning lowercase hexadecimal. It preserves case, whitespace, and Unicode. Use `credential_hash` / `credentialHash` and the hash endpoints to avoid sending raw credentials. Hashes are still sensitive data.
- `check()` uses POST. The explicit GET method places credentials in the URL, where servers and proxies may log them.
- Membership uses Bloom filters: `found=true` is a possible match, not proof of compromise. Results depend on the filters loaded by your server. `test_mode` is returned by the service.
- Credential batches return only distinct matching usernames; hash batches return distinct matching input strings. `total` counts all inputs, including duplicates. Empty batches are supported. Results are not per-input boolean arrays. Batches are sent in one request; the default nginx deployment limits request bodies to 10 MB, so split large inputs yourself.
- `sync_apply()` / `syncApply()` returns when the server accepts the operation (`202`), before the work finishes. Poll with `wait_for_sync()` / `waitForSync()`. The status endpoint is global and has no job IDs; another caller or scheduled update can replace the latest status. Polling does not cancel server work. Avoid overlapping administrative workflows.
- Sync and manifest/reload methods change server state; filter synchronization can download tens of GB. Synchronous sync calls may require a longer timeout. A `409` means another filter operation is active.
- Automatic-update hours are `0`–`23` in the **container's timezone**, shown in the status response. Enabling requires an hour. Settings are persisted by the server; disabling with no hour clears the configured hour.
- TLS verification defaults to on. Neither SDK follows redirects, retries requests, nor uses environment HTTP proxy settings. Configure the final HTTPS endpoint directly. HTTP is supported for an explicitly configured trusted local test server.
- Types describe the captured API contract, with optional fields preserved from OpenAPI. Clients require a JSON object on success but do not perform full runtime schema validation. Future response fields are retained.

## Tests and builds

Offline unit tests use real loopback HTTP servers and shared contract fixtures. They cover all JSON operations, serialization, URL prefixes and encoding, Unicode hashing, API errors, redirects, malformed responses, connection errors, timeouts, and sync polling. TypeScript also tests cancellation.

From the repository root (PowerShell):

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e './python[dev]'
.\.venv\Scripts\python -m unittest discover -s python/tests -p test_client.py -v
Push-Location python
..\.venv\Scripts\python -m mypy
..\.venv\Scripts\python -m build
Pop-Location
python scripts/generate_models.py --check

Push-Location typescript
npm ci
npm test
npm run typecheck
npm pack
Pop-Location
```

Live tests are opt-in and require loaded filters containing the four documented positive test credentials:

```powershell
$env:HUSHCLIENT_INTEGRATION = '1'
$env:HUSHCLIENT_BASE_URL = 'https://localhost'
$env:HUSHCLIENT_CA_FILE = 'C:\HushClient\tls\public\fullchain.pem'
.\.venv\Scripts\python -m unittest discover -s python/tests -p test_integration.py -v
Push-Location typescript
npm run test:integration
Pop-Location
```

Live tests exercise information/health/stats, all four positive credentials and their hashes, GET checks, empty passwords, batches, duplicate handling, uppercase hashes, empty inputs, sync status, scheduler status, and real 400/422 responses. The schedule validation test sends an invalid hour, which the server rejects before changing state. Successful administrative writes are exercised only against the test servers; live tests do not trigger downloads, reload filters, or change the schedule.

See [TESTING.md](TESTING.md) for the validation performed for this implementation. CI runs offline tests and build/type checks; it does not require a HushClient deployment.

For OpenAPI provenance, model generation, and updating the SDKs when the API changes, see [CONTRACT_MAINTENANCE.md](CONTRACT_MAINTENANCE.md).
