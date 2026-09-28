# Validation record

## Information endpoint compatibility fix — 2026-09-29

Both SDKs now request `GET /endpoints` for `info()`, matching HushClient source commit `3b9288802d856f49ed875b39927c185994a4b1e6`. The public `RootResponse` type remains unchanged. A regression test in each language serves HTML at the home route and JSON at the information route, including a base-URL prefix.

Validated on Windows with Python 3.13.5 and Node.js 22.17.1:

- Python offline tests: 28 passed.
- Node.js offline tests: 28 passed.
- Python strict mypy, generated-model freshness, and TypeScript/example type checks: passed.
- Python source distribution and wheel built successfully in an isolated build environment; npm archive built successfully.
- Live integration validation was attempted but could not complete: no service accepted connections at `https://localhost:443`, including a connection check outside the sandbox. No service was started and no filters or schedules were changed.

The earlier live results below describe the original implementation, not a live revalidation of this fix.

## Original validation — 2026-09-20

Validated on **2026-09-20** on Windows using Python **3.13.5**, Node.js **22.17.1**, TypeScript **5.9.3**, and mypy **1.20.2**.

The live target was `https://localhost`, API version `1.0.0`, with **512 filters loaded** and `test_mode=false`. Both SDKs used `HushClient/tls/public/fullchain.pem` as explicit trust material, with certificate and hostname verification enabled. No private keys or certificates are stored in this repository.

| Check | Result |
| --- | --- |
| Python offline HTTP/contract tests | 27 passed |
| Node.js offline HTTP/contract tests | 27 passed |
| Python live integration tests | 6 passed |
| Node.js live integration tests | 6 passed |
| Python strict mypy check | Passed; all 4 SDK source modules |
| TypeScript strict compilation and example type checking | Passed |
| Model generation freshness (`--check`) | Passed |
| Python wheel and source distribution | Built successfully; wheel built from the source distribution |
| npm archive | Built successfully; includes JavaScript and declarations |
| Installed Python wheel | Imported from an isolated target; typing marker, HTTPS health, and positive hash check passed |
| Installed npm archive | ESM import, HTTPS health, and positive hash check passed; CommonJS dynamic import passed |
| Basic examples and status-only sync examples | Both languages ran successfully against localhost |
| TLS defaults | Both clients rejected the local self-signed certificate without explicit trust |
| Explicit local TLS bypass | Both clients connected when verification was explicitly disabled |

## Coverage

The shared [contract fixtures](testdata/contract.json) exercise every JSON operation listed in the captured [OpenAPI document](api/openapi.json). Tests check methods, paths, request bodies, optional passwords, empty arrays, Unicode, URL prefixes, query escaping, headers, response payloads, and `202` acceptance. A contract coverage assertion fails if a new JSON operation appears in the snapshot without a fixture.

Failure tests cover HTTP 400/409/422/500/503, HTML gateway errors, refused redirects, invalid success payloads, connection refusal, network timeouts, failed background syncs, idle status, and polling deadlines. Node.js also exercises cancellation before/during a request and during polling sleep. Shared hash vectors cover the documented positive credential, empty inputs, whitespace, mixed case, Unicode, a combining character, and control characters.

Live tests verify all four documented positive credentials using both raw POST checks and locally computed SHA-256 hashes, GET checks, empty-password/hash equivalence, credential/hash batches, duplicates, uppercase hashes, empty arrays, service metadata, sync/scheduler status, malformed-hash errors, and invalid scheduler-hour validation.

## Boundaries

Live validation did **not** trigger filter downloads, rebuild manifests, reload filters, or change the scheduler configuration. Successful administrative writes, the `202` start response, `409` conflicts, and polling transitions were tested against loopback HTTP test servers. The invalid-hour live request was rejected with `422` before any state change.

The tests do not assert that arbitrary credentials must be absent: Bloom filters can produce false positives. The documented positive samples must be included in the filters for live tests to pass.

CI is configured for Python 3.11/3.13 and Node.js 22/24 on Linux. Those additional CI combinations have not been executed locally. No packages have been published to registries.

See the [parent README](README.md#tests-and-builds) for reproducible commands, including the environment variables needed to opt into live tests.
