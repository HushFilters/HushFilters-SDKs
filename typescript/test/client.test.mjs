import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  APIError, HushClient, ProtocolError, RequestAbortedError, RequestTimeoutError,
  SyncFailedError, SyncTimeoutError, TransportError, credentialHash,
} from "../dist/index.js";

const cases = JSON.parse(readFileSync(new URL("../../testdata/contract.json", import.meta.url), "utf8"));
async function setup(t) {
  const state = { requests: [], replies: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    state.requests.push({ method: req.method, url: new URL(req.url, "http://localhost"),
      body: raw ? JSON.parse(raw) : undefined, headers: req.headers });
    const reply = state.routes
      ? state.routes[new URL(req.url, "http://localhost").pathname] ?? { status: 404 }
      : state.replies.shift() ?? { body: { active: true } };
    if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  state.baseUrl = `http://127.0.0.1:${server.address().port}/prefix/`;
  state.client = new HushClient({ baseUrl: state.baseUrl, headers: { "X-Test": "sdk" } });
  return state;
}

test("fixtures cover all JSON operations in the OpenAPI snapshot", () => {
  const schema = JSON.parse(readFileSync(new URL("../../api/openapi.json", import.meta.url), "utf8"));
  const operations = Object.entries(schema.paths)
    .filter(([p]) => !p.startsWith("/ui-"))
    .flatMap(([p, methods]) => Object.entries(methods)
      .filter(([, operation]) => Object.entries(operation.responses ?? {})
        .some(([status, response]) => status.startsWith("2") && response.content?.["application/json"]))
      .map(([m]) => `${m.toUpperCase()} ${p}`)).sort();
  assert.deepEqual(cases.map(c => `${c.method} ${c.path}`).sort(), operations);
});

test("info uses the JSON directory when home is HTML", async t => {
  const s = await setup(t);
  const expected = { name: "HushFilter API", version: "1.0.0",
    endpoints: { home: "/", endpoints: "/endpoints" }, test_mode: false };
  s.routes = {
    "/prefix/": { raw: "<html>Hushfilters home</html>" },
    "/prefix/endpoints": { body: expected },
  };
  assert.deepEqual(await s.client.info(), expected);
  assert.deepEqual(s.requests.map(r => r.url.pathname), ["/prefix/endpoints"]);
});

for (const c of cases) {
  test(`${c.method} ${c.path} serializes and returns the API contract`, async t => {
    const s = await setup(t);
    s.replies.push({ status: c.status, body: c.response });
    assert.deepEqual(await s.client[c.typescript](...c.args), c.response);
    assert.equal(s.requests.length, 1);
    const req = s.requests[0];
    assert.equal(req.method, c.method);
    assert.equal(req.url.pathname, `/prefix${c.path}`);
    assert.deepEqual(Object.fromEntries(req.url.searchParams), c.query ?? {});
    assert.deepEqual(req.body, c.body);
    assert.equal(req.headers["x-test"], "sdk");
    assert.equal(req.headers.accept, "application/json");
    if (c.body) assert.equal(req.headers["content-type"], "application/json");
  });
}

test("default password, empty batch, and disabling schedule", async t => {
  const s = await setup(t);
  await s.client.check("username");
  await s.client.checkBatch([]);
  await s.client.configureAutoUpdate(false);
  assert.deepEqual(s.requests.map(r => r.body), [
    { username: "username", password: "" }, { credentials: [] }, { enabled: false, hour: null },
  ]);
});

test("HTTP errors preserve bodies and headers without retrying or leaking inputs in messages", async t => {
  const s = await setup(t);
  for (const status of [400, 409, 422, 500, 503]) {
    const body = { detail: [{ input: "secret-password", msg: "invalid" }], test_mode: false, logs: ["failed"] };
    s.replies.push({ status, body, headers: { "retry-after": "5" } });
    const before = s.requests.length;
    await assert.rejects(s.client.checkGet("private-user", "secret-password"), error => {
      assert.ok(error instanceof APIError);
      assert.equal(error.statusCode, status);
      assert.deepEqual(error.body, body);
      assert.deepEqual(error.detail, body.detail);
      assert.equal(error.headers["retry-after"], "5");
      assert.doesNotMatch(error.message, /private-user|secret-password/);
      return true;
    });
    assert.equal(s.requests.length, before + 1);
  }
});

test("HTML proxy errors and redirects", async t => {
  const s = await setup(t);
  for (const status of [502, 302, 307]) {
    s.replies.push({ status, raw: "<html>gateway</html>", headers: { location: s.baseUrl } });
    const before = s.requests.length;
    await assert.rejects(s.client.health(), error => {
      assert.ok(error instanceof APIError);
      assert.equal(error.body, "<html>gateway</html>");
      return true;
    });
    assert.equal(s.requests.length, before + 1);
  }
});

test("malformed successful responses", async t => {
  const s = await setup(t);
  for (const raw of ["bad json", "[]", "null", '"string"', ""]) {
    s.replies.push({ raw });
    await assert.rejects(s.client.health(), ProtocolError);
  }
});

test("request deadline and per-request timeout override", async t => {
  const s = await setup(t);
  s.replies.push({ delay: 200 });
  await assert.rejects(s.client.health({ timeoutMs: 30 }), RequestTimeoutError);
});

test("abort before and during requests", async t => {
  const s = await setup(t);
  const aborted = AbortSignal.abort();
  await assert.rejects(s.client.health({ signal: aborted }), RequestAbortedError);
  assert.equal(s.requests.length, 0);
  s.replies.push({ delay: 200 });
  const controller = new AbortController();
  const request = s.client.health({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, RequestAbortedError);
});

test("connection failure", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(new HushClient({ baseUrl: `http://127.0.0.1:${port}` }).health(), TransportError);
});

test("poll active, success, failure, and never-started status", async t => {
  const s = await setup(t);
  const complete = { active: false, success: true, filter_count: 2 };
  s.replies.push({ body: { active: true } }, { body: complete });
  assert.deepEqual(await s.client.waitForSync({ pollIntervalMs: 1 }), complete);
  const failed = { active: false, success: false, detail: "sync failed", logs: ["failure"] };
  s.replies.push({ body: failed });
  await assert.rejects(s.client.waitForSync(), error => {
    assert.ok(error instanceof SyncFailedError);
    assert.deepEqual(error.status, failed);
    return true;
  });
  s.replies.push({ body: { active: false, success: null } });
  assert.equal((await s.client.waitForSync()).success, null);
});

test("poll timeout and abort during sleep", async t => {
  const s = await setup(t);
  await assert.rejects(s.client.waitForSync({ timeoutMs: 40, pollIntervalMs: 1000 }), SyncTimeoutError);
  const controller = new AbortController();
  const waiting = s.client.waitForSync({ pollIntervalMs: 1000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(waiting, RequestAbortedError);
});

test("configuration validation", async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    assert.throws(() => new HushClient({ timeoutMs }), RangeError);
    await assert.rejects(new HushClient().waitForSync({ pollIntervalMs: timeoutMs }), RangeError);
  }
  for (const baseUrl of ["localhost", "ftp://localhost", "https://u:p@localhost", "https://localhost?q=1", "https://localhost#x"]) {
    assert.throws(() => new HushClient({ baseUrl }), TypeError);
  }
  assert.throws(() => new HushClient({ verifyTls: false, ca: "unused" }), TypeError);
});

test("hash vectors match Python, including unicode and whitespace", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../testdata/hashes.json", import.meta.url), "utf8"));
  for (const v of vectors) assert.equal(credentialHash(v.username, v.password), v.hash);
  assert.equal(credentialHash("testusername1@nwebbed.com", "testpassword1"),
    "29f33573df6d1c7aac289e5c75e0bce5e4939e69c0499fb7e2540b7f371c59d9");
});
