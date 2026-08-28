import assert from "node:assert/strict";
import test from "node:test";

import { checkLiveSources } from "../src/tools/live-source-check.js";

test("live source check only requests the fixed authority allowlist and hashes returned bytes", async () => {
  const requested: string[] = [];
  const result = await checkLiveSources(async (input) => {
    const url = String(input);
    requested.push(url);
    return new Response(`<html><title>official</title><body>${url} 新能源汽车 1150 1286.6 40.9% 47.6% 1,089.9 357.9 272.6</body></html>`, {
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
  assert.ok(result.results.every((item) => item.error === "offline"));
});

test("HTTP 200 challenge pages are not misreported as verified authority content", async () => {
  const result = await checkLiveSources(async () => new Response("<html><title>429 Too Many Requests</title><body>challenge</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  assert.ok(result.results.every((item) => item.status === "failed"));
  assert.ok(result.results.every((item) => item.error === "Authority host returned a challenge or error page"));
});

function withUrl(response: Response, url: string) {
  Object.defineProperty(response, "url", { value: url });
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}

test("authority checks fail closed for every HTTP envelope, size, redirect, marker, and non-Error failure", async () => {
  const cases: Array<{ response: () => Promise<Response>; pattern: RegExp }> = [
    { response: async () => new Response("down", { status: 503 }), pattern: /HTTP 503/u },
    { response: async () => new Response("down", { status: 302 }), pattern: /HTTP 302/u },
    { response: async () => withUrl(new Response("body", { headers: { "content-type": "text/html" } }), "https://authority.example/final"), pattern: /unexpected redirect/iu },
    { response: async () => new Response("body", { headers: { "content-type": "application/json" } }), pattern: /content type/u },
    { response: async () => new Response("", { headers: { "content-type": "text/html", "content-length": String(512 * 1024 + 1) } }), pattern: /safety limit/u },
    { response: async () => new Response(Buffer.alloc(512 * 1024 + 1), { headers: { "content-type": "text/html" } }), pattern: /safety limit/u },
    { response: async () => new Response(null, { headers: { "content-type": "text/html" } }), pattern: /unexpectedly short/u },
    { response: async () => new Response(null), pattern: /unexpectedly short/u },
    { response: async () => new Response("short", { headers: { "content-type": "text/html" } }), pattern: /unexpectedly short/u },
    { response: async () => new Response("x".repeat(80), { headers: { "content-type": "text/html" } }), pattern: /missing expected content markers/u },
  ];
  for (const item of cases) {
    const checked = await checkLiveSources(item.response);
    assert.ok(checked.results.every((result) => result.status === "failed" && item.pattern.test(result.error ?? "")));
  }

  const thrown = await checkLiveSources(async () => { throw "socket closed"; });
  assert.ok(thrown.results.every((result) => result.error === "Network request failed"));

  const markers = "新能源汽车 1150 1286.6 40.9% 47.6% 1,089.9 357.9 272.6";
  const valid = await checkLiveSources(async () => new Response(markers.repeat(2), {
    headers: { "content-type": "text/html", "content-length": "not-a-number" },
  }));
  assert.ok(valid.results.every((result) => result.status === "verified"));
});

test("outbound authority requests are configured to fail closed on redirects before any hop is followed (#1)", async () => {
  const seenInits: Array<RequestInit | undefined> = [];
  await checkLiveSources(async (_input, init) => {
    seenInits.push(init);
    throw new Error("offline");
  });
  assert.ok(seenInits.length > 0);
  for (const init of seenInits) {
    assert.equal(init?.redirect, "error", "authority fetch must never follow redirects");
  }
});
