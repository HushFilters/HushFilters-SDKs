import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APIError, HushClient, credentialHash } from "../dist/index.js";

const integration = (name, fn) => test(name, { skip: process.env.HUSHCLIENT_INTEGRATION !== "1" }, fn);
function client() {
  return new HushClient({
    baseUrl: process.env.HUSHCLIENT_BASE_URL ?? "https://localhost",
    verifyTls: process.env.HUSHCLIENT_INSECURE !== "1",
    ca: process.env.HUSHCLIENT_CA_FILE ? readFileSync(process.env.HUSHCLIENT_CA_FILE) : undefined,
  });
}

integration("health, stats and API information", async () => {
  const c = client();
  assert.equal((await c.info()).name, "HushFilter API");
  const health = await c.health();
  const stats = await c.stats();
  assert.equal(health.status, "healthy");
  assert.ok(health.filters_loaded > 0);
  assert.equal(stats.filter_count, stats.filters.length);
  assert.equal(typeof health.test_mode, "boolean");
});

integration("four documented credentials match locally computed hashes", async () => {
  const c = client();
  for (let i = 1; i <= 4; i++) {
    const username = `testusername${i}@nwebbed.com`, password = `testpassword${i}`;
    const credential = await c.check(username, password);
    assert.equal(credential.found, true);
    assert.ok(credential.matching_filters.length > 0);
    assert.deepEqual(await c.checkHash(credentialHash(username, password)), credential);
  }
});

integration("GET compatibility and empty passwords", async () => {
  const c = client();
  assert.equal((await c.checkGet("testusername1@nwebbed.com", "testpassword1")).found, true);
  assert.deepEqual(await c.check("sdk-test+unicode-密碼"), await c.checkHash(credentialHash("sdk-test+unicode-密碼")));
});

integration("batches, duplicates, hash case and empty inputs", async () => {
  const c = client();
  const username = "testusername1@nwebbed.com", password = "testpassword1";
  const digest = credentialHash(username, password);
  const batch = await c.checkBatch([{ username, password }, { username, password }]);
  assert.equal(batch.total, 2);
  assert.deepEqual(batch.found_usernames, [username]);
  const hashes = await c.checkHashBatch([digest, digest, digest.toUpperCase()]);
  assert.equal(hashes.total, 3);
  assert.deepEqual(hashes.found_hashes, [digest, digest.toUpperCase()]);
  assert.deepEqual((await c.checkBatch([])).found_usernames, []);
  assert.deepEqual((await c.checkHashBatch([])).found_hashes, []);
});

integration("read-only synchronization status", async () => {
  const c = client();
  assert.equal(typeof (await c.syncStatus()).active, "boolean");
  const schedule = await c.autoUpdateStatus();
  assert.equal(typeof schedule.enabled, "boolean");
  assert.equal(typeof schedule.timezone, "string");
});

integration("real 400 and 422 errors without changing server state", async () => {
  const c = client();
  for (const [call, code] of [
    [() => c.checkHash("invalid"), 400], [() => c.checkHashBatch(["invalid"]), 400],
    [() => c.configureAutoUpdate(true, 24), 422],
  ]) {
    await assert.rejects(call(), error => {
      assert.ok(error instanceof APIError);
      assert.equal(error.statusCode, code);
      assert.ok(error.detail);
      return true;
    });
  }
});
