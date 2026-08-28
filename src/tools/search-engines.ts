import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { MAX_SOURCES, truncateSources } from "../source-limit.js";
export { MAX_SOURCES } from "../source-limit.js";
export const searchEngines = ["bing", "google", "baidu"] as const;
export type SearchEngine = (typeof searchEngines)[number];
export type SearchFetcher = (input: string, init?: RequestInit) => Promise<Response>;
export type SearchResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ENGINE_CONFIG: Record<SearchEngine, { endpoint: string; queryParameter: string; allowedHosts: readonly string[] }> = {
  bing: { endpoint: "https://www.bing.com/search", queryParameter: "q", allowedHosts: ["www.bing.com"] },
  google: { endpoint: "https://www.google.com/search", queryParameter: "q", allowedHosts: ["www.google.com"] },
  baidu: { endpoint: "https://www.baidu.com/s", queryParameter: "wd", allowedHosts: ["www.baidu.com"] },
};
const blockedAddresses = new BlockList();
const fakeIpProxyAddresses = new BlockList();
fakeIpProxyAddresses.addSubnet("198.18.0.0", 15, "ipv4");
export const FAKE_IP_PROXY_ERROR = "本机 DNS 返回 fake-IP 代理保留段，实时搜索需直连网络或调整代理模式，已 fail-closed 未发出请求";
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:10::", 28], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");
function bareAddress(value: string) {
  return value.replace(/^\[|\]$/gu, "").split("%")[0]!;
}
export function isBlockedIpAddress(value: string) {
  const address = bareAddress(value);
  const family = isIP(address);
  if (family === 0) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}
export function isFakeIpProxyAddress(value: string) {
  const address = bareAddress(value);
  return isIP(address) === 4 && fakeIpProxyAddresses.check(address, "ipv4");
}
const defaultResolver: SearchResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });
/** 请求前校验 URL、引擎主机和当次 DNS 地址；默认 fetch 可能再次解析，因此这不是完整的 pinned-IP/DNS-rebinding 防御。 */
export async function validatePublicHttpUrl(input: string, allowedHosts: readonly string[], resolver: SearchResolver = defaultResolver) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Search target must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Search target protocol must be HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Search target must not contain credentials");
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) throw new Error("Search target uses a non-standard port");
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const literalAddress = bareAddress(hostname);
  if (isIP(literalAddress) !== 0 && isBlockedIpAddress(literalAddress)) {
    throw new Error("Search target resolves to a private, reserved, or loopback address");
  }
  if (!allowedHosts.includes(hostname)) throw new Error("Search target host is outside the selected engine allowlist");
  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new Error("Search target host could not be resolved safely");
  }
  if (addresses.length === 0) throw new Error("Search target host returned no addresses");
  if (addresses.some((item) => isFakeIpProxyAddress(item.address))) {
    throw new Error(FAKE_IP_PROXY_ERROR);
  }
  if (addresses.some((item) => isBlockedIpAddress(item.address))) {
    throw new Error("Search target resolves to a private, reserved, or loopback address");
  }
  return url;
}
export async function validateOutboundSearchUrl(input: string, engine: SearchEngine, resolver: SearchResolver = defaultResolver) {
  return validatePublicHttpUrl(input, ENGINE_CONFIG[engine].allowedHosts, resolver);
}

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&#0*39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function plainText(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function candidateUrl(hrefValue: string, requestUrl: URL) {
  let href = decodeHtml(hrefValue.trim());
  if (href.startsWith("/url?")) href = new URL(href, requestUrl).searchParams.get("q") ?? "";
  if (href.startsWith("//")) href = `https:${href}`;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const address = bareAddress(url.hostname);
  if (isIP(address) !== 0 && isBlockedIpAddress(address)) return null;
  return url.toString();
}

export function parseSearchCandidates(html: string, engine: SearchEngine, requestUrl: URL) {
  return parseSearchCandidatesWithTrace(html, engine, requestUrl).candidates;
}

function parseSearchCandidatesWithTrace(html: string, engine: SearchEngine, requestUrl: URL) {
  const candidates: Array<{ title: string; url: string; engine: SearchEngine; materialRole: "CANDIDATE_SOURCE"; authorityVerified: false }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu)) {
    const url = candidateUrl(match[2]!, requestUrl);
    const title = plainText(match[3]!);
    if (!url || !title || seen.has(url) || new URL(url).hostname === requestUrl.hostname) continue;
    seen.add(url);
    candidates.push({ title, url, engine, materialRole: "CANDIDATE_SOURCE", authorityVerified: false });
  }
  const limited = truncateSources(candidates, MAX_SOURCES);
  return { candidates: limited.items, sourceLimitTrace: limited.trace };
}

async function responseText(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Search response exceeds the size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Search response exceeds the size limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function searchSelectedEngine(
  engine: SearchEngine,
  query: string,
  fetcher: SearchFetcher = fetch,
  resolver: SearchResolver = defaultResolver,
) {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 160) throw new Error("Search query must contain 2–160 characters");
  const config = ENGINE_CONFIG[engine];
  const requestUrl = new URL(config.endpoint);
  requestUrl.searchParams.set(config.queryParameter, normalized);
  const validatedUrl = await validateOutboundSearchUrl(requestUrl.toString(), engine, resolver);
  const response = await fetcher(validatedUrl.toString(), {
    method: "GET",
    redirect: "error",
    headers: { accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Search engine returned HTTP ${response.status}`);
  if (response.url && new URL(response.url).origin !== validatedUrl.origin) throw new Error("Search response left the selected engine allowlist");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("text/html")) throw new Error("Search engine returned an unexpected content type");
  const html = await responseText(response);
  return { engine, query: normalized, capturedAt: new Date().toISOString(), ...parseSearchCandidatesWithTrace(html, engine, validatedUrl) };
}
