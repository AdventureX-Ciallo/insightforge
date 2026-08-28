import assert from "node:assert/strict";
import test from "node:test";

import { resolveDnsChain } from "../src/tools/dns-chain.js";

function dohResponse(answers: Array<{ type: number; data: string }>, status = 0) {
  return new Response(JSON.stringify({ Status: status, Answer: answers }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

test("DoH answers are parsed first and prefer A/AAAA records (#5)", async () => {
  const seenUrls: string[] = [];
  const addresses = await resolveDnsChain("www.bing.com", {
    env: {},
    dohFetcher: async (url) => {
      seenUrls.push(url);
      return dohResponse([
        { type: 5, data: "cname.example" },
        { type: 1, data: "204.79.197.200" },
        { type: 28, data: "2620:1ec:468::200" },
      ]);
    },
  });
  assert.deepEqual(addresses, [
    { address: "204.79.197.200", family: 4 },
    { address: "2620:1ec:468::200", family: 6 },
  ]);
  assert.equal(seenUrls.length, 1);
  assert.ok(seenUrls[0]!.startsWith("https://223.5.5.5/resolve?name=www.bing.com"));
});

test("each hop can be disabled independently via env (#5)", async () => {
  let dohCalled = false;
  // DoH 关闭 → 直接落系统解析器（example.com 公网解析或链路失败都证明未走 DoH）。
  try {
    await resolveDnsChain("example.com", {
      env: { INSIGHTFORGE_DNS_DOH: "0" },
      dohFetcher: async () => { dohCalled = true; return dohResponse([]); },
    });
  } catch {
    // 离线环境下系统解析失败是预期；关键是 DoH 从未被调用。
  }
  assert.equal(dohCalled, false);

  // 全部关闭 → 链耗尽并抛错，错误信息包含各跳状态。
  await assert.rejects(
    () => resolveDnsChain("example.com", {
      env: { INSIGHTFORGE_DNS_DOH: "0", INSIGHTFORGE_DNS_SYSTEM: "0", INSIGHTFORGE_DNS_LEGACY: "0" },
      dohFetcher: async () => dohResponse([]),
    }),
    /DNS chain exhausted/u,
  );
});

test("DoH failures fall through to the next hop (#5)", async () => {
  let dohCalls = 0;
  const addresses = await resolveDnsChain("localhost", {
    env: { INSIGHTFORGE_DNS_LEGACY: "0" },
    dohFetcher: async () => { dohCalls += 1; return new Response("bad gateway", { status: 502 }); },
  });
  assert.equal(dohCalls, 1);
  assert.ok(addresses.length > 0);
  assert.ok(addresses.every((item) => item.family === 4 || item.family === 6));
});

test("policy-violating DoH/legacy endpoints are rejected before use (#5)", async () => {
  await assert.rejects(
    () => resolveDnsChain("example.com", {
      env: { INSIGHTFORGE_DNS_DOH_URL: "http://223.5.5.5/resolve", INSIGHTFORGE_DNS_LEGACY: "0", INSIGHTFORGE_DNS_SYSTEM: "0" },
      dohFetcher: async () => dohResponse([{ type: 1, data: "93.184.216.34" }]),
    }),
    /DNS chain exhausted/u,
  );
  await assert.rejects(
    () => resolveDnsChain("example.com", {
      env: { INSIGHTFORGE_DNS_LEGACY_SERVER: "127.0.0.1", INSIGHTFORGE_DNS_SYSTEM: "0" },
      dohFetcher: async () => new Response("down", { status: 500 }),
    }),
    /DNS chain exhausted/u,
  );
});
