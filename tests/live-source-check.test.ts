import assert from "node:assert/strict";
import test from "node:test";

import { checkLiveSources } from "../src/tools/live-source-check.js";

test("live source check only requests the fixed authority allowlist and hashes returned bytes", async () => {
  const requested: string[] = [];
  const result = await checkLiveSources(async (input) => {
    const url = String(input);
    requested.push(url);
    return new Response(`<html><title>official</title><body>${url}</body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  assert.equal(result.mode, "live-authority-check");
  assert.equal(result.results.length, 4);
  assert.ok(result.results.every((item) => item.status === "verified"));
  assert.ok(result.results.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.deepEqual(
    new Set(requested.map((value) => new URL(value).hostname)),
    new Set(["www.caam.org.cn", "app.www.gov.cn", "www.cada.cn", "www.evcipa.org.cn"]),
  );
});

test("live source check reports network failure without inventing verification", async () => {
  const result = await checkLiveSources(async () => { throw new Error("offline"); });
  assert.ok(result.results.every((item) => item.status === "failed"));
  assert.ok(result.results.every((item) => item.httpStatus === null && item.sha256 === ""));
  assert.ok(result.results.every((item) => item.error === "Network request failed"));
});
