import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer, enforceBrowserRequestBoundary, isAllowedLoopbackOrigin } from "../src/server.js";

function request(method: string | undefined, headers: IncomingMessage["headers"] = {}) {
  return { method, headers } as IncomingMessage;
}

test("loopback origin and browser metadata validation fail closed for every parsed and duplicated-header branch", () => {
  assert.equal(isAllowedLoopbackOrigin("http://127.0.0.1:4399"), true);
  assert.equal(isAllowedLoopbackOrigin("http://localhost"), false);
  assert.equal(isAllowedLoopbackOrigin("http://[::1]:4399"), true);
  for (const origin of [
    "not a URL",
    "http://localhost:4399",
    "https://localhost:4399",
    "http://example.com:4399",
    "http://user@localhost:4399",
    "http://:password@localhost:4399",
    "http://localhost:4399/path",
    "http://localhost:4399/?query=1",
    "http://localhost:4399/#fragment",
  ]) assert.equal(isAllowedLoopbackOrigin(origin), false, origin);

  assert.doesNotThrow(() => enforceBrowserRequestBoundary(request(undefined), "key", false));
  assert.doesNotThrow(() => enforceBrowserRequestBoundary(request("HEAD"), "key", false));
  assert.doesNotThrow(() => enforceBrowserRequestBoundary(request("OPTIONS", { "sec-fetch-site": "none" }), "key", false));
  assert.doesNotThrow(() => enforceBrowserRequestBoundary(request("POST", { "x-insightforge-request-key": "key" }), "key", false));
  assert.doesNotThrow(() => enforceBrowserRequestBoundary(request("POST", { origin: "http://localhost:4399", "x-insightforge-request-key": "key" }), "key", true));
  assert.throws(() => enforceBrowserRequestBoundary(request("POST", { origin: ["http://localhost:4399", "http://127.0.0.1:4399"], "x-insightforge-request-key": "key" } as unknown as IncomingMessage["headers"]), "key", false), /Cross-origin/u);
  assert.throws(() => enforceBrowserRequestBoundary(request("POST", { "sec-fetch-site": ["same-origin", "none"], "x-insightforge-request-key": "key" } as unknown as IncomingMessage["headers"]), "key", false), /Cross-site/u);
  assert.throws(() => enforceBrowserRequestBoundary(request("POST", { "x-insightforge-request-key": ["key", "key"] } as unknown as IncomingMessage["headers"]), "key", false), /request key/u);
});

test("loopback API rejects cross-site and keyless writes while the nonce-bootstrapped UI can obtain a request key", async () => {
  const priorDisable = process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY;
  delete process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY;
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-csrf-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const indexResponse = await fetch(`${baseUrl}/`);
    const index = await indexResponse.text();
    const nonce = indexResponse.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/u)?.[1];
    assert.ok(nonce);
    assert.match(index, new RegExp(`<script nonce="${nonce}"`, "u"));
    const moduleScriptIndex = index.search(/<script[^>]+type="module"[^>]+src="/u);
    assert.ok(moduleScriptIndex > 0, "the React entrypoint must contain a module script");
    assert.ok(index.indexOf("x-insightforge-request-key") < moduleScriptIndex);
    assert.ok(!index.includes("offlineModeLabel"), "the server bootstrap must not mutate legacy UI elements");
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");

    const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
    assert.equal(csrfResponse.status, 200);
    assert.deepEqual(await csrfResponse.json(), { token: null, required: false });
    const keyResponse = await fetch(`${baseUrl}/api/request-key`);
    assert.equal(keyResponse.status, 200);
    assert.equal(keyResponse.headers.get("cache-control"), "no-store");
    const { requestKey } = await keyResponse.json() as { requestKey: string };
    assert.match(requestKey, /^[0-9a-f-]{36}$/u);
    const csrfWrongMethod = await fetch(`${baseUrl}/api/csrf`, { method: "POST", headers: { "x-insightforge-request-key": requestKey } });
    assert.equal(csrfWrongMethod.status, 405);
    assert.equal(csrfWrongMethod.headers.get("allow"), "GET");

    const crossSite = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "x-insightforge-request-key": requestKey,
      },
      body: JSON.stringify({ baseUrl: "https://attacker.example/v1", model: "steal", apiKey: "not-a-real-key" }),
    });
    assert.equal(crossSite.status, 403);

    const keyless = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ baseUrl: "https://llm.example/v1", model: "safe", apiKey: "not-a-real-key" }),
    });
    assert.equal(keyless.status, 403);

    const wrongFetchSite = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-site": "same-site",
        "x-insightforge-request-key": requestKey,
      },
      body: JSON.stringify({ baseUrl: "https://llm.example/v1", model: "safe", apiKey: "not-a-real-key" }),
    });
    assert.equal(wrongFetchSite.status, 403);

    const wrongContentType = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "x-insightforge-request-key": requestKey,
      },
      body: JSON.stringify({ baseUrl: "https://llm.example/v1", model: "safe", apiKey: "not-a-real-key" }),
    });
    assert.equal(wrongContentType.status, 415);

    const allowed = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-site": "same-origin",
        "x-insightforge-request-key": requestKey,
      },
      body: JSON.stringify({ baseUrl: "https://llm.example/v1", model: "safe", apiKey: "not-a-real-key" }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    await app.stop();
    if (priorDisable === undefined) delete process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY;
    else process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY = priorDisable;
  }
});

test("request-key protection can only be disabled through its explicit development environment flag", async () => {
  const priorDisable = process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY;
  process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY = "1";
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-csrf-disabled-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const response = await fetch(`${baseUrl}/api/settings/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://llm.example/v1", model: "dev", apiKey: "not-a-real-key" }),
    });
    assert.equal(response.status, 200);
  } finally {
    await app.stop();
    if (priorDisable === undefined) delete process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY;
    else process.env.INSIGHTFORGE_DISABLE_REQUEST_KEY = priorDisable;
  }
});
