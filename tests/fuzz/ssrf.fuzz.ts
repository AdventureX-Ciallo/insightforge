import { resolveHostnameWithFallback, searchSelectedEngine, validatePublicHttpUrl, type SearchEngine } from "../../src/tools/search-engines.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

function reservedAddress(rng: SeededPrng) {
  return rng.pick([
    `0.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`,
    `10.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`,
    `100.${64 + rng.int(64)}.${rng.int(256)}.${rng.int(256)}`,
    `127.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`,
    `169.254.${rng.int(256)}.${rng.int(256)}`,
    `172.${16 + rng.int(16)}.${rng.int(256)}.${rng.int(256)}`,
    `192.168.${rng.int(256)}.${rng.int(256)}`,
    `192.0.2.${rng.int(256)}`,
    `198.51.100.${rng.int(256)}`,
    `203.0.113.${rng.int(256)}`,
    `224.${rng.int(256)}.${rng.int(256)}.${rng.int(256)}`,
    "::1",
    `fc00::${rng.int(65_536).toString(16)}`,
    `fe80::${rng.int(65_536).toString(16)}`,
    `2001:db8::${rng.int(65_536).toString(16)}`,
    `ff00::${rng.int(65_536).toString(16)}`,
    "not-an-ip-address",
  ]);
}

export async function runSsrfFuzz(rng: SeededPrng, cases: number) {
  let fetchCalls = 0;
  const fetcher = async () => {
    fetchCalls += 1;
    return new Response("unexpected fetch");
  };
  const malformedTargets = [
    "file:///etc/passwd",
    "ftp://www.google.com/search",
    "https://user:pass@www.google.com/search",
    "https://www.google.com:444/search",
    "https://www.google.com.evil.test/search",
    "http://[::1]/search",
    "http://127.0.0.1/search",
    "http://%zz/search",
    "not a url",
  ] as const;
  const engines: readonly SearchEngine[] = ["bing", "google", "baidu"];
  for (let index = 0; index < cases; index += 1) {
    const before = fetchCalls;
    let fallbackCalls = 0;
    let expectedFallbackCalls: number | null = null;
    try {
      const variant = rng.int(12);
      if (variant < 8) {
        await searchSelectedEngine(rng.pick(engines), `安全查询-${rng.token()}`, fetcher, async () => [{ address: reservedAddress(rng), family: rng.bool() ? 4 : 6 }]);
      } else if (variant < 10) {
        await validatePublicHttpUrl(rng.pick(malformedTargets), ["www.google.com"], async () => [{ address: reservedAddress(rng), family: 4 }]);
      } else {
        const dangerousHop = rng.int(3);
        expectedFallbackCalls = dangerousHop + 1;
        const resolver = (hop: number) => async () => {
          fallbackCalls += 1;
          if (hop < dangerousHop) throw new Error("fuzz resolver unavailable");
          if (hop === dangerousHop) return [{ address: reservedAddress(rng), family: rng.bool() ? 4 : 6 }];
          return [{ address: "93.184.216.34", family: 4 }];
        };
        await resolveHostnameWithFallback("www.google.com", {
          env: { INSIGHTFORGE_DNS_DOH: "1", INSIGHTFORGE_DNS_SYSTEM: "1", INSIGHTFORGE_DNS_UDP53: "1" },
          dohResolver: resolver(0),
          systemResolver: resolver(1),
          traditionalResolver: resolver(2),
        });
      }
      throw new Error(`case=${index}: SSRF target was accepted`);
    } catch (error) {
      invariant(!String(error).includes("SSRF target was accepted"), String(error));
      invariant(fetchCalls === before, `case=${index}: SSRF input reached fetch before rejection`);
      if (expectedFallbackCalls !== null) invariant(fallbackCalls === expectedFallbackCalls, `case=${index}: dangerous DNS answer did not stop the fallback chain`);
    }
  }
  invariant(fetchCalls === 0, "SSRF fuzz made at least one outbound fetch attempt");
  return { cases, value: undefined };
}
