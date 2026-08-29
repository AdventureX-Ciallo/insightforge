import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createInsightForgeServer } from "../../src/server.js";
import { invariant, suiteSeed } from "./harness.js";
import { SeededPrng } from "./prng.js";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const ENDPOINTS = [
  ["GET", "/api/health"],
  ["GET", "/api/presets"],
  ["GET", "/api/current"],
  ["GET", "/api/settings/llm"],
  ["POST", "/api/settings/llm"],
  ["POST", "/api/uploads"],
  ["GET", `/api/uploads/${MISSING_ID}`],
  ["POST", "/api/sources/live-check"],
  ["POST", "/api/sources/live-search"],
  ["POST", "/api/sources/search"],
  ["POST", "/api/runs"],
  ["GET", "/api/runs/missing"],
  ["GET", "/api/runs/missing/events"],
  ["POST", "/api/runs/missing/decisions"],
  ["POST", "/api/runs/missing/source-update"],
  ["GET", "/api/runs/missing/boundary-questions"],
  ["GET", "/api/runs/missing/artifact-versions"],
  ["GET", "/api/runs/missing/artifact-versions/1"],
  ["GET", "/api/runs/missing/artifacts/PPTX"],
  ["GET", "/"],
] as const;

function fuzzPath(rng: SeededPrng, path: string) {
  const variant = rng.int(5);
  if (variant === 0) return path;
  if (variant === 1) return `${path}/${encodeURIComponent(rng.token(80))}`;
  if (variant === 2) return `${path}?fuzz=${encodeURIComponent(`${rng.token(40)}\u0000${rng.token(40)}`)}`;
  if (variant === 3) return `/api/${"x".repeat(8_000 + rng.int(2_000))}`;
  return `/api/%00/${rng.token(80)}`;
}

function bodyFor(path: string, rng: SeededPrng) {
  if (path === "/api/sources/live-search") return { query: rng.pick([null, 1, "x", "x".repeat(161)]) };
  if (path === "/api/sources/search") return { engine: rng.pick([null, "shell", "bing"]), query: rng.pick([1, "x", "x".repeat(161)]) };
  if (path === "/api/runs") return { researchQuestion: rng.pick([null, "短", "问".repeat(241)]), uploadIds: rng.pick([null, "bad", [1]]) };
  if (path.endsWith("/decisions")) return { conclusionId: rng.pick([null, 1, rng.token()]), action: rng.pick(["DROP", null, 1]) };
  return rng.pick([{}, { fuzz: rng.token() }, { value: null }]);
}

export async function runApiFuzz(rng: SeededPrng, cases: number) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-fuzz-api-"));
  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
    searchResolver: async () => [{ address: "93.184.216.34", family: 4 }],
    searchFetcher: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    legacySearchFetcher: async () => new Response(JSON.stringify({ query: { search: [] } }), { status: 200, headers: { "content-type": "application/json" } }),
    authorityFetcher: async () => new Response("新能源汽车 1150 1286.6 40.9% 47.6% 1,089.9 357.9 272.6 authoritative source body", { status: 200, headers: { "content-type": "text/html" } }),
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  let nextCase = 0;
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
  try {
    const workers = Array.from({ length: 32 }, async () => {
      while (true) {
        const index = nextCase;
        nextCase += 1;
        if (index >= cases) return;
        const caseRng = new SeededPrng(suiteSeed(rng.seed, `http-api-case-${index}`));
        const [expectedMethod, endpoint] = ENDPOINTS[index % ENDPOINTS.length]!;
        const method = index < ENDPOINTS.length ? expectedMethod : caseRng.pick(methods);
        const path = index < ENDPOINTS.length ? endpoint : fuzzPath(caseRng, endpoint);
        const headers: Record<string, string> = { "content-type": "application/json" };
        let body: string | undefined;
        if (method !== "GET" && method !== "OPTIONS") {
          if (endpoint === "/api/uploads") {
            headers["x-insightforge-file-name"] = encodeURIComponent(`${caseRng.token()}.txt`);
            body = String.fromCharCode(...caseRng.bytes(64, 1));
          } else {
            body = caseRng.int(10) === 0 ? "{" : JSON.stringify(bodyFor(endpoint, caseRng));
          }
        }
        const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(5_000) });
        invariant(response.status < 500, `case=${index}: ${method} ${path.slice(0, 180)} returned ${response.status}`);
        await response.arrayBuffer();
      }
    });
    await Promise.all(workers);
    const health = await fetch(`${baseUrl}/api/health`);
    invariant(health.status === 200, "API fuzz left the server process unhealthy");
  } finally {
    await app.stop();
    await rm(workspaceDir, { recursive: true, force: true });
  }
  return { cases, value: undefined };
}
