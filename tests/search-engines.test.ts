import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createInsightForgeServer } from "../src/server.js";
import { isBlockedIpAddress, searchSelectedEngine, validateOutboundSearchUrl, type SearchEngine } from "../src/tools/search-engines.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("Bing, Google, and Baidu selection requests one allowlisted host and returns unverified candidates", async () => {
  const fixtures: Record<SearchEngine, { host: string; html: string; expectedUrl: string }> = {
    bing: { host: "www.bing.com", html: '<a href="https://example.com/bing-report"><b>Bing</b> report</a>', expectedUrl: "https://example.com/bing-report" },
    google: { host: "www.google.com", html: '<a href="/url?q=https%3A%2F%2Fexample.com%2Fgoogle-report&sa=U">Google report</a>', expectedUrl: "https://example.com/google-report" },
    baidu: { host: "www.baidu.com", html: '<a href="https://example.com/baidu-report">百度报告</a>', expectedUrl: "https://example.com/baidu-report" },
  };
  for (const engine of ["bing", "google", "baidu"] as const) {
    let requested = "";
    const result = await searchSelectedEngine(engine, "新能源汽车 充电", async (input) => {
      requested = input;
      return new Response(fixtures[engine].html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }, publicResolver);
    assert.equal(new URL(requested).hostname, fixtures[engine].host);
    assert.equal(result.engine, engine);
    assert.equal(result.candidates[0]?.url, fixtures[engine].expectedUrl);
    assert.equal(result.candidates[0]?.engine, engine);
    assert.equal(result.candidates[0]?.materialRole, "CANDIDATE_SOURCE");
    assert.equal(result.candidates[0]?.authorityVerified, false);
  }
});

test("search validates protocol, host, and every DNS address before fetch", async () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.2", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "ff02::1"]) {
    assert.equal(isBlockedIpAddress(address), true, `${address} is blocked`);
  }
  assert.equal(isBlockedIpAddress("93.184.216.34"), false);
  assert.equal(isBlockedIpAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
  await assert.rejects(validateOutboundSearchUrl("ftp://www.bing.com/file", "bing", publicResolver), /protocol/i);
  await assert.rejects(validateOutboundSearchUrl("http://127.0.0.1/search", "bing", publicResolver), /private|reserved|loopback/i);
  await assert.rejects(validateOutboundSearchUrl("https://evil.example/search", "bing", publicResolver), /allowlist/i);

  let fetchCalls = 0;
  await assert.rejects(
    searchSelectedEngine("bing", "新能源", async () => {
      fetchCalls += 1;
      return new Response("never");
    }, async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]),
    /private|reserved|loopback/i,
  );
  assert.equal(fetchCalls, 0, "a mixed public/private DNS answer is rejected before fetch");
});

test("POST /api/sources/search rejects invalid engines and exposes candidates, not evidence", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-search-api-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    searchResolver: publicResolver,
    searchFetcher: async () => new Response('<a href="https://example.com/candidate">候选结果</a>', { status: 200, headers: { "content-type": "text/html" } }),
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const invalid = await fetch(`${baseUrl}/api/sources/search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "internal", query: "新能源" }),
    });
    assert.equal(invalid.status, 400);
    const response = await fetch(`${baseUrl}/api/sources/search`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "bing", query: "新能源" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { candidates: Array<{ engine: string; materialRole: string; authorityVerified: boolean }> };
    assert.deepEqual(body.candidates, [{
      title: "候选结果",
      url: "https://example.com/candidate",
      engine: "bing",
      materialRole: "CANDIDATE_SOURCE",
      authorityVerified: false,
    }]);
  } finally {
    await app.stop();
  }
});
