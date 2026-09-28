# Contract maintenance

The [OpenAPI snapshot](api/openapi.json) was captured from the running local API on 2026-09-20. Source and behavior were checked against HushClient commit `3b51e564fa5b963b88f9636517fbc6f0d4d40a8e`, its README, `api.py`, `core/hash.py`, nginx configuration, and Postman collection. The server's version string alone does not identify schema changes.

On 2026-09-29, the information routes in the snapshot were reconciled against HushClient commit `3b9288802d856f49ed875b39927c185994a4b1e6`: `/` serves HTML and `/endpoints` returns the API directory. This was a targeted source-verified update, not a new full API capture; newer log/alert operations are outside the SDK's captured scope. Both `info()` methods now use `/endpoints`. `RootResponse` remains the public type name for compatibility.

Python and TypeScript model files are generated from that snapshot. Run these commands from the repository root:

```sh
python scripts/generate_models.py
python scripts/generate_models.py --check
```

When the API changes, refresh `api/openapi.json`, regenerate models, then update client methods, shared `testdata/contract.json` fixtures, tests, and docs together. Information-directory and health response schemas are empty in OpenAPI; the generator contains their source-verified definitions. Generated optional properties follow OpenAPI, even where the current server supplies defaults. Contract coverage checks select operations with successful JSON responses and exclude `/ui-` routes (the original capture incorrectly advertises JSON for those browser routes).

See the [parent README](README.md#tests-and-builds) for validation commands and [TESTING.md](TESTING.md) for the recorded test coverage.
