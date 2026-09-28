# HushClient Node.js / TypeScript SDK

A promise-based, typed **Node.js 22+ ESM** client for the HushClient API. No runtime dependencies. The package includes compiled JavaScript and TypeScript declarations. It uses Node's HTTP/HTTPS and crypto modules; it is not a browser SDK.

## Build and install

Build from this folder:

```sh
npm ci
npm run build
npm pack
```

Install the resulting archive into another application:

```sh
npm install /path/to/HushClient-SDKs/typescript/hushclient-sdk-0.1.0.tgz
```

The repository has not published an npm release. In TypeScript, use a Node-compatible module configuration such as `module: "NodeNext"` and `moduleResolution: "NodeNext"`. ESM applications can import the package directly; CommonJS callers can use `await import("hushclient-sdk")` inside an async function.

## Check credentials and hashes

```typescript
import { readFileSync } from "node:fs";
import { HushClient, credentialHash } from "hushclient-sdk";

const client = new HushClient({
  baseUrl: "https://localhost",
  ca: readFileSync("C:/HushClient/tls/public/fullchain.pem"),
});

console.log(await client.health());

// Hash locally before sending the request.
const digest = credentialHash("testusername1@nwebbed.com", "testpassword1");
const result = await client.checkHash(digest);
console.log(result.found, result.matching_filters);

// JSON POST with raw credentials, if appropriate for your deployment.
await client.check("testusername1@nwebbed.com", "testpassword1");

const batch = await client.checkBatch([
  { username: "testusername1@nwebbed.com", password: "testpassword1" },
  { username: "another-user" }, // password defaults to empty on the server
]);
console.log(batch.total, batch.found_usernames);
console.log((await client.checkHashBatch([digest])).found_hashes);
```

Hashing is SHA-256 of UTF-8 `username + "nWebbed" + password`, without normalization. Response fields retain their API `snake_case` names. Batch results contain distinct matching values, not a boolean for each input. A Bloom-filter match can be a false positive.

## Configuration

| Constructor option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://localhost` | Public API URL; supports a path prefix; omit `/docs` |
| `timeoutMs` | `30000` | Total request deadline in milliseconds |
| `verifyTls` | `true` | Verify server certificate and hostname |
| `ca` | system/default trust | PEM contents as string/Buffer, or an array; **not a path** |
| `headers` | none | Custom headers, such as gateway authorization |

The SDK connects directly and ignores environment HTTP proxy settings. Requests use individual connections with no client cleanup required.

Every endpoint method takes optional `RequestOptions` as its last argument:

```typescript
const controller = new AbortController();
const request = client.checkHash(digest, {
  timeoutMs: 5000,
  signal: controller.signal,
});
// controller.abort(); // rejects the promise with RequestAbortedError
await request;
```

For `check`/`checkGet`, supply the password argument (use `""` for empty) before options. Durations must be positive finite numbers no greater than `2147483647` milliseconds. Aborting or timing out stops the client request, not work already accepted by the server.

## HTTPS certificate trust

HushClient's default local HTTPS certificate is self-signed, so Node.js does not trust it by default. HTTPS checks certificate trust and the requested hostname before sending an API request. Without explicit trust for this self-signed certificate, the TLS handshake fails and the SDK rejects the request with `TransportError`, including for `health()`.

The included examples/tests read the file named by `HUSHCLIENT_CA_FILE` and pass its PEM contents to the SDK's `ca` constructor option. **The SDK itself does not read the environment variable.** Your application can configure trust directly:

```typescript
// Explicit trust for the default local self-signed certificate; no env var needed.
const localClient = new HushClient({
  baseUrl: "https://localhost",
  ca: readFileSync("C:/HushClient/tls/public/fullchain.pem"),
});

// If the HTTPS certificate's CA is already trusted by Node.js, omit ca.
const trustedClient = new HushClient({ baseUrl: "https://hushclient.example.com" });
```

`ca` takes **file contents**, not a file path. For a valid certificate issued by a CA already trusted by Node.js, neither `ca` nor `HUSHCLIENT_CA_FILE` is needed: Node.js verifies the server using its existing trust configuration. For an organization/private CA, supply its CA bundle unless Node.js already trusts it. Browser or operating-system trust alone does not guarantee that Node.js uses the same trust configuration.

The file contains a **public certificate**, not a private key. Supplying it keeps certificate and hostname verification enabled and affects only this SDK client, not system-wide trust settings.

Local development can explicitly use `verifyTls: false`, or `HUSHCLIENT_INSECURE=1` when running the examples. This disables the server-identity check; it does not make the certificate trusted. Omit `ca` and unset `HUSHCLIENT_CA_FILE` when using this bypass, because the SDK rejects combining the two settings. For trusted HTTPS, leave the insecure flag unset so verification remains enabled.

## Methods

| Method | Promise result type |
| --- | --- |
| `info()` (GET `/endpoints`) | `RootResponse` |
| `health()` | `HealthResponse` |
| `stats()` | `StatsResponse` |
| `check(username, password="")` | `CheckResponse` |
| `checkGet(username, password="")` | `CheckResponse` (GET; credentials in URL) |
| `checkBatch(credentials)` | `BatchCheckResponse` |
| `checkHash(digest)` | `CheckResponse` |
| `checkHashBatch(hashes)` | `BatchHashCheckResponse` |
| `syncApply()` | `SyncApplyStartResponse` (202 accepted) |
| `syncFilters()` | `SyncFiltersResponse` |
| `updateManifest()` | `ManifestUpdateResponse` |
| `reloadFilters()` | `ReloadFiltersResponse` |
| `syncStatus()` | `SyncStatusResponse` |
| `autoUpdateStatus()` | `AutoUpdateStatusResponse` |
| `configureAutoUpdate(enabled, hour=null)` | `AutoUpdateStatusResponse` |
| `waitForSync(options?)` | `SyncStatusResponse` |

All response and request interfaces are exported from `hushclient-sdk`. `checkBatch` accepts `ReadonlyArray<CheckRequest>` and `checkHashBatch` accepts `ReadonlyArray<string>`. A batch is one HTTP request; split large inputs to fit the server's body limit (10 MB in the default nginx configuration). Server input errors are preserved, including HTTP 400 for malformed hashes and 422 for invalid request types/settings.

## Synchronization and daily updates

```typescript
// Explicitly starts a refresh and may download large filter files.
const started = await client.syncApply();
if (started.started) {
  const final = await client.waitForSync({
    timeoutMs: 7_200_000,
    pollIntervalMs: 2000,
  });
  console.log(final.filter_count, final.logs);
}

console.log((await client.autoUpdateStatus()).timezone);
await client.configureAutoUpdate(true, 23); // container-local hour
await client.configureAutoUpdate(false);
```

`waitForSync` defaults to a one-hour deadline and two-second polling interval; it also accepts an `AbortSignal`. It polls global current/latest status, not an identified job. Other callers or scheduled updates can replace that status. An inactive status with `success: null` is returned unchanged. A completed failure raises `SyncFailedError` with `.status`. A polling deadline raises `SyncTimeoutError`; a failed network poll raises a transport error. No polling error cancels the server operation.

Standalone sync/manifest/reload methods wait for their HTTP response. For example, `client.syncFilters({timeoutMs: 600_000})` allows a longer request. Administrative calls can return HTTP 409 while another operation is active. Schedule changes are persisted by the server, and enabling requires an hour from `0` to `23` in the container timezone.

## Errors

```typescript
import { APIError, HushClientError, RequestTimeoutError } from "hushclient-sdk";

try {
  await client.checkHash("invalid");
} catch (error) {
  if (error instanceof APIError) {
    console.log(error.statusCode); // 400
    // error.detail: server's detail field, if present
    // error.body: decoded JSON payload or non-JSON text
    // error.headers, error.method, error.path: metadata
  } else if (error instanceof RequestTimeoutError) {
    console.log("Request timed out");
  } else if (error instanceof HushClientError) {
    console.log("Connection or response failed");
  } else {
    throw error;
  }
}
```

All SDK errors derive from `HushClientError`. `TransportError` covers connection/TLS/interrupted-response errors; `RequestTimeoutError` and `RequestAbortedError` specialize it. `ProtocolError` means a 2xx response was not a JSON object. Configuration errors use `TypeError`/`RangeError`. Redirects are errors; the SDK never follows them or automatically retries requests.

Error messages omit credentials, query strings, and server payloads. Explicit `.body`, `.detail`, and `.status` properties can contain sensitive inputs echoed by the server; redact before logging. Types are static declarations, not full runtime response validation. Additional server fields are retained.

## Examples and testing

From this directory:

```powershell
$env:HUSHCLIENT_CA_FILE = 'C:\HushClient\tls\public\fullchain.pem'
npm run example
npm run example:sync             # status only
npm run example:sync -- --apply  # explicitly starts a refresh

npm test
npm run typecheck
$env:HUSHCLIENT_INTEGRATION = '1'
npm run test:integration
```

Examples/tests read `HUSHCLIENT_BASE_URL`, `HUSHCLIENT_CA_FILE`, and optional `HUSHCLIENT_INSECURE=1` (local development only). These are example/test conveniences; constructors do not implicitly read them. Live tests do not start downloads or persist schedule changes. See the [parent README](../README.md) for API behavior, build instructions, and validation coverage, and [CONTRACT_MAINTENANCE.md](../CONTRACT_MAINTENANCE.md) for maintaining the shared API contract.
