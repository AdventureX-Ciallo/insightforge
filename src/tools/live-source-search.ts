import { createHash } from "node:crypto";

import { z } from "zod";
import { MAX_SOURCES, truncateSources } from "../source-limit.js";
import { validatePublicHttpUrl, type SearchResolver } from "./search-engines.js";

const PROVIDER = "https://zh.wikipedia.org/w/api.php";
const MAX_RESPONSE_BYTES = 512 * 1024;

const responseSchema = z.object({
  query: z.object({
    search: z.array(z.object({
      pageid: z.number().int().positive(),
      title: z.string().min(1),
      snippet: z.string(),
      timestamp: z.string().optional(),
    }).passthrough()).max(100),
  }).passthrough(),
}).passthrough();

export type LiveSearchFetcher = (input: string, init?: RequestInit) => Promise<Response>;

function stripMarkup(value: string) {
  return value.replace(/<[^>]+>/gu, " ").replace(/&quot;/gu, '"').replace(/&#039;/gu, "'").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
}

async function limitedBytes(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Search response exceeds safety limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Search response exceeds safety limit");
  return bytes;
}

/**
 * 单一固定提供方的真实信源发现。结果只标记为候选信源，不自动成为权威证据；
 * URL 由 pageid 构造，响应经过大小、Content-Type、Schema 和主机约束。
 */
export async function searchLiveSingleProvider(query: string, fetcher: LiveSearchFetcher = fetch, resolver?: SearchResolver) {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 160) throw new Error("Live search query must contain 2–160 characters");
  const url = new URL(PROVIDER);
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", normalized);
  url.searchParams.set("srlimit", "5");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  await validatePublicHttpUrl(url.toString(), ["zh.wikipedia.org"], resolver);
  const response = await fetcher(url.toString(), { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Live search provider returned HTTP ${response.status}`);
  if (response.url && new URL(response.url).hostname !== "zh.wikipedia.org") throw new Error("Live search response left the fixed provider host");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) throw new Error("Live search provider returned an unexpected content type");
  const bytes = await limitedBytes(response);
  const payload = responseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  const capturedAt = new Date().toISOString();
  const discovered = payload.query.search.map((item) => ({
    id: `live-wikipedia-${item.pageid}`,
    title: item.title,
    url: `https://zh.wikipedia.org/?curid=${item.pageid}`,
    excerpt: stripMarkup(item.snippet),
    publishedAt: item.timestamp ?? null,
    materialRole: "CANDIDATE_SOURCE" as const,
    authorityVerified: false,
  }));
  const limited = truncateSources(discovered, MAX_SOURCES);
  return {
    mode: "live-single-provider" as const,
    provider: "Chinese Wikipedia MediaWiki API",
    providerUrl: PROVIDER,
    query: normalized,
    capturedAt,
    responseSha256: createHash("sha256").update(bytes).digest("hex"),
    results: limited.items,
    sourceLimitTrace: limited.trace,
  };
}
