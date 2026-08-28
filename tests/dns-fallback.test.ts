import assert from "node:assert/strict";
import test from "node:test";

import {
  TRADITIONAL_DNS_SERVER,
  resolveHostnameWithFallback,
  resolveWithDoh,
  resolveWithTraditionalDns,
  validateOutboundSearchUrl,
  validatePublicHttpUrlWithTrace,
  type SearchResolver,
  type TraditionalDnsClient,
} from "../src/tools/search-engines.js";

const publicAnswer = [{ address: "93.184.216.34", family: 4 }];

function responseWithUrl(response: Response, url: string) {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function dnsJson(payload: unknown, headers: Record<string, string> = { "content-type": "application/dns-json" }) {
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

test("DNS fallback uses DoH, then system DNS, then fixed UDP/53 and records every attempt", async () => {
  const calls: string[] = [];
  const failed = (name: string): SearchResolver => async () => {
    calls.push(name);
    throw new Error(`${name} unavailable`);
  };
  const result = await resolveHostnameWithFallback("www.bing.com", {
    env: {
      INSIGHTFORGE_DNS_DOH: "1",
      INSIGHTFORGE_DNS_SYSTEM: "1",
      INSIGHTFORGE_DNS_UDP53: "1",
    },
    dohResolver: failed("doh"),
    systemResolver: failed("system"),
    traditionalResolver: async () => {
      calls.push("udp53");
      return publicAnswer;
    },
  });

  assert.deepEqual(calls, ["doh", "system", "udp53"]);
  assert.deepEqual(result.addresses, publicAnswer);
  assert.deepEqual(result.trace, {
    resolver: "udp53",
    attempts: [
      { resolver: "doh", status: "failed", error: "doh unavailable" },
      { resolver: "system", status: "failed", error: "system unavailable" },
      { resolver: "udp53", status: "success", error: null },
    ],
    addressCount: 1,
  });
});

test("each DNS hop can be disabled independently and invalid or all-disabled configuration fails closed", async () => {
  const calls: string[] = [];
  const result = await resolveHostnameWithFallback("www.google.com", {
    env: {
      INSIGHTFORGE_DNS_DOH: "0",
      INSIGHTFORGE_DNS_SYSTEM: "1",
      INSIGHTFORGE_DNS_UDP53: "0",
    },
    dohResolver: async () => { calls.push("doh"); return publicAnswer; },
    systemResolver: async () => { calls.push("system"); return publicAnswer; },
    traditionalResolver: async () => { calls.push("udp53"); return publicAnswer; },
  });
  assert.deepEqual(calls, ["system"]);
  assert.equal(result.trace.resolver, "system");

  await assert.rejects(resolveHostnameWithFallback("www.google.com", {
    env: { INSIGHTFORGE_DNS_DOH: "sometimes" },
  }), /INSIGHTFORGE_DNS_DOH must be 0 or 1/u);
  await assert.rejects(resolveHostnameWithFallback("www.google.com", {
    env: {
      INSIGHTFORGE_DNS_DOH: "0",
      INSIGHTFORGE_DNS_SYSTEM: "0",
      INSIGHTFORGE_DNS_UDP53: "0",
    },
  }), /At least one DNS resolver/u);
});

test("a dangerous answer from any enabled DNS hop stops the chain before later resolvers or fetch", async () => {
  let systemCalls = 0;
  let traditionalCalls = 0;
  const chain: SearchResolver = async (hostname) => (await resolveHostnameWithFallback(hostname, {
    env: {
      INSIGHTFORGE_DNS_DOH: "1",
      INSIGHTFORGE_DNS_SYSTEM: "1",
      INSIGHTFORGE_DNS_UDP53: "1",
    },
    dohResolver: async () => [{ address: "127.0.0.1", family: 4 }],
    systemResolver: async () => { systemCalls += 1; return publicAnswer; },
    traditionalResolver: async () => { traditionalCalls += 1; return publicAnswer; },
  })).addresses;

  await assert.rejects(
    validatePublicHttpUrlWithTrace("https://www.bing.com/search", ["www.bing.com"], chain),
    /private, reserved, or loopback/u,
  );
  assert.equal(systemCalls, 0);
  assert.equal(traditionalCalls, 0);

  await assert.rejects(resolveHostnameWithFallback("www.bing.com", {
    env: { INSIGHTFORGE_DNS_DOH: "1", INSIGHTFORGE_DNS_SYSTEM: "0", INSIGHTFORGE_DNS_UDP53: "0" },
    dohResolver: async () => [{ address: "198.18.1.2", family: 4 }],
  }), /fake-IP/u);
});

test("DoH resolver parses bounded A and AAAA JSON through the fixed HTTPS endpoint", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(init ? { url, init } : { url });
    const type = url.searchParams.get("type");
    const payload = type === "A"
      ? { Status: 0, Answer: [{ type: 5, data: "alias.example" }, { type: 1, data: "93.184.216.34" }] }
      : { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] };
    const response = dnsJson(payload, { "content-type": type === "A" ? "application/dns-json" : "application/json", "content-length": "not-a-number" });
    return responseWithUrl(response, url.toString());
  };
  const addresses = await resolveWithDoh("example.com", fetcher);
  assert.deepEqual(addresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  assert.deepEqual(requests.map((item) => item.url.origin), ["https://1.1.1.1", "https://1.1.1.1"]);
  assert.deepEqual(requests.map((item) => item.url.searchParams.get("name")), ["example.com", "example.com"]);
  assert.ok(requests.every((item) => item.init?.redirect === "error" && (item.init?.headers as Record<string, string>).accept === "application/dns-json"));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    assert.equal((await resolveWithDoh("example.com")).length, 2, "the default fetch adapter remains usable");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const noData = await resolveWithDoh("missing.example", async () => new Response(
    new TextEncoder().encode(JSON.stringify({ Status: 3 })),
    { headers: { "content-length": "not-a-number" } },
  ));
  assert.deepEqual(noData, []);
});

test("DoH resolver fails closed for every transport, envelope, size, JSON, and answer-shape violation", async () => {
  const tooLarge = JSON.stringify({ Status: 0, padding: "x".repeat(65 * 1024) });
  const cases: Array<{ label: string; response: () => Response; pattern: RegExp }> = [
    { label: "HTTP status", response: () => new Response("down", { status: 503 }), pattern: /HTTP 503/u },
    { label: "redirect", response: () => responseWithUrl(dnsJson({ Status: 0 }), "https://evil.example/dns-query"), pattern: /fixed resolver host/u },
    { label: "content type", response: () => dnsJson({ Status: 0 }, { "content-type": "text/html" }), pattern: /content type/u },
    { label: "declared size", response: () => dnsJson({ Status: 0 }, { "content-type": "application/json", "content-length": String(64 * 1024 + 1) }), pattern: /size limit/u },
    { label: "actual size", response: () => new Response(tooLarge, { headers: { "content-type": "application/json" } }), pattern: /size limit/u },
    { label: "invalid JSON", response: () => new Response("{", { headers: { "content-type": "application/json" } }), pattern: /JSON|position|end/u },
    { label: "null payload", response: () => dnsJson(null), pattern: /malformed JSON/u },
    { label: "array payload", response: () => dnsJson([]), pattern: /malformed JSON/u },
    { label: "primitive payload", response: () => dnsJson("bad"), pattern: /malformed JSON/u },
    { label: "bad status", response: () => dnsJson({ Status: 2 }), pattern: /unsuccessful status/u },
    { label: "answer object", response: () => dnsJson({ Status: 0, Answer: {} }), pattern: /malformed answers/u },
    { label: "null answer", response: () => dnsJson({ Status: 0, Answer: [null] }), pattern: /malformed answer/u },
    { label: "array answer", response: () => dnsJson({ Status: 0, Answer: [[]] }), pattern: /malformed answer/u },
    { label: "primitive answer", response: () => dnsJson({ Status: 0, Answer: ["bad"] }), pattern: /malformed answer/u },
    { label: "non-string address", response: () => dnsJson({ Status: 0, Answer: [{ type: 1, data: 7 }] }), pattern: /invalid IP/u },
    { label: "wrong-family address", response: () => dnsJson({ Status: 0, Answer: [{ type: 1, data: "::1" }] }), pattern: /invalid IP/u },
    { label: "invalid UTF-8", response: () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), pattern: /encoded data|UTF-8/u },
  ];
  for (const item of cases) {
    await assert.rejects(resolveWithDoh("example.com", async () => item.response()), item.pattern, item.label);
  }
});

function traditionalClient(ipv4: Promise<string[]>, ipv6: Promise<string[]>, servers: string[]): TraditionalDnsClient {
  return {
    setServers(value) { servers.push(...value); },
    resolve4: async () => ipv4,
    resolve6: async () => ipv6,
  };
}

test("traditional DNS core pins 1.1.1.1:53 and combines partial A/AAAA success without hiding total failure", async () => {
  const servers: string[] = [];
  assert.deepEqual(await resolveWithTraditionalDns("example.com", traditionalClient(
    Promise.resolve(["93.184.216.34"]),
    Promise.resolve(["2606:2800:220:1:248:1893:25c8:1946"]),
    servers,
  )), [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  assert.deepEqual(servers, [TRADITIONAL_DNS_SERVER]);

  assert.deepEqual(await resolveWithTraditionalDns("v6.example", traditionalClient(
    Promise.reject(new Error("no A")), Promise.resolve(["2606:4700:4700::1111"]), [],
  )), [{ address: "2606:4700:4700::1111", family: 6 }]);
  assert.deepEqual(await resolveWithTraditionalDns("v4.example", traditionalClient(
    Promise.resolve(["1.1.1.1"]), Promise.reject(new Error("no AAAA")), [],
  )), [{ address: "1.1.1.1", family: 4 }]);
  await assert.rejects(resolveWithTraditionalDns("missing.example", traditionalClient(
    Promise.reject(new Error("A failed")), Promise.reject(new Error("AAAA failed")), [],
  )), /A failed/u);
});

test("fallback covers empty/non-Error failures, the safe system adapter, process env, and traced default-chain validation", async () => {
  await assert.rejects(resolveHostnameWithFallback("example.com", {
    env: { INSIGHTFORGE_DNS_DOH: "1", INSIGHTFORGE_DNS_SYSTEM: "1", INSIGHTFORGE_DNS_UDP53: "1" },
    dohResolver: async () => [],
    systemResolver: async () => { throw "system unavailable"; },
    traditionalResolver: async () => { throw new Error("udp unavailable"); },
  }), /doh -> system -> udp53/u);

  await assert.rejects(resolveHostnameWithFallback("localhost", {
    env: { INSIGHTFORGE_DNS_DOH: "0", INSIGHTFORGE_DNS_SYSTEM: "1", INSIGHTFORGE_DNS_UDP53: "0" },
  }), /private, reserved, or loopback/u);

  const traced = await validatePublicHttpUrlWithTrace("https://www.bing.com/search", ["www.bing.com"], undefined, {
    env: { INSIGHTFORGE_DNS_DOH: "1", INSIGHTFORGE_DNS_SYSTEM: "0", INSIGHTFORGE_DNS_UDP53: "0" },
    dohResolver: async () => publicAnswer,
  });
  assert.equal(traced.dnsResolution.resolver, "doh");

  const originalFetch = globalThis.fetch;
  const priorResolverEnv = {
    doh: process.env.INSIGHTFORGE_DNS_DOH,
    system: process.env.INSIGHTFORGE_DNS_SYSTEM,
    udp53: process.env.INSIGHTFORGE_DNS_UDP53,
  };
  process.env.INSIGHTFORGE_DNS_DOH = "1";
  process.env.INSIGHTFORGE_DNS_SYSTEM = "0";
  process.env.INSIGHTFORGE_DNS_UDP53 = "0";
  globalThis.fetch = async (input) => {
    const family = new URL(String(input)).searchParams.get("type") === "A" ? 4 : 6;
    return dnsJson({ Status: 0, Answer: [{ type: family === 4 ? 1 : 28, data: family === 4 ? "93.184.216.34" : "2606:2800:220:1:248:1893:25c8:1946" }] });
  };
  try {
    assert.equal((await validateOutboundSearchUrl("https://www.bing.com/search", "bing")).hostname, "www.bing.com");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      INSIGHTFORGE_DNS_DOH: priorResolverEnv.doh,
      INSIGHTFORGE_DNS_SYSTEM: priorResolverEnv.system,
      INSIGHTFORGE_DNS_UDP53: priorResolverEnv.udp53,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const prior = {
    doh: process.env.INSIGHTFORGE_DNS_DOH,
    system: process.env.INSIGHTFORGE_DNS_SYSTEM,
    udp53: process.env.INSIGHTFORGE_DNS_UDP53,
  };
  process.env.INSIGHTFORGE_DNS_DOH = "0";
  process.env.INSIGHTFORGE_DNS_SYSTEM = "0";
  process.env.INSIGHTFORGE_DNS_UDP53 = "0";
  try {
    await assert.rejects(resolveHostnameWithFallback("example.com"), /At least one DNS resolver/u);
  } finally {
    for (const [name, value] of Object.entries({
      INSIGHTFORGE_DNS_DOH: prior.doh,
      INSIGHTFORGE_DNS_SYSTEM: prior.system,
      INSIGHTFORGE_DNS_UDP53: prior.udp53,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
