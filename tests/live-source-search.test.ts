import assert from "node:assert/strict";
import test from "node:test";

import { searchLiveSingleProvider } from "../src/tools/live-source-search.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("single-provider live search is host-locked, schema-validated, and returns unverified candidates", async () => {
  let requested = "";
  const result = await searchLiveSingleProvider("新能源汽车 充电基础设施", async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({ query: { search: [{ pageid: 123, title: "新能源汽车", snippet: "<span>候选资料</span>", timestamp: "2026-01-01T00:00:00Z" }] } }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }, publicResolver);
  const requestedUrl = new URL(requested);
  assert.equal(requestedUrl.hostname, "zh.wikipedia.org");
  assert.equal(requestedUrl.searchParams.get("srsearch"), "新能源汽车 充电基础设施");
  assert.equal(result.mode, "live-single-provider");
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.results[0]?.materialRole, "CANDIDATE_SOURCE");
  assert.equal(result.results[0]?.authorityVerified, false);
  assert.equal(result.results[0]?.excerpt, "候选资料");
});

test("live search fails closed on wrong content type or malformed provider payload", async () => {
  await assert.rejects(
    searchLiveSingleProvider("新能源", async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }), publicResolver),
    /unexpected content type/i,
  );
  await assert.rejects(
    searchLiveSingleProvider("新能源", async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } }), publicResolver),
  );
});
