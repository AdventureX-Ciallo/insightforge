import { Resolver, lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isBlockedIpAddress } from "./search-engines.js";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface DohFetcher {
  (url: string, init?: RequestInit): Promise<Response>;
}

const DEFAULT_DOH_BASE = "https://223.5.5.5/resolve";
const DEFAULT_LEGACY_SERVER = "223.5.5.5";

function hopEnabled(env: NodeJS.ProcessEnv, flag: string): boolean {
  return env[flag] !== "0";
}

async function resolveViaDoh(hostname: string, env: NodeJS.ProcessEnv, fetcher: DohFetcher): Promise<ResolvedAddress[]> {
  const base = env.INSIGHTFORGE_DNS_DOH_URL?.trim() || DEFAULT_DOH_BASE;
  const endpoint = new URL(base);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("DoH endpoint must be a bare HTTPS URL");
  if (isBlockedIpAddress(endpoint.hostname)) throw new Error("DoH endpoint resolves policy-violating address");
  endpoint.searchParams.set("name", hostname);
  const response = await fetcher(endpoint.toString(), { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error(`DoH endpoint returned ${response.status}`);
  const payload = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  if (payload.Status !== 0) throw new Error(`DoH resolution status ${payload.Status ?? "unknown"}`);
  const addresses: ResolvedAddress[] = [];
  for (const record of payload.Answer ?? []) {
    const family = isIP(record.data ?? "");
    if (family === 4 || family === 6) addresses.push({ address: record.data!, family });
  }
  return addresses;
}

async function resolveViaSystem(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function resolveViaLegacy(hostname: string, env: NodeJS.ProcessEnv): Promise<ResolvedAddress[]> {
  const server = env.INSIGHTFORGE_DNS_LEGACY_SERVER?.trim() || DEFAULT_LEGACY_SERVER;
  if (isIP(server) === 0) throw new Error("Legacy DNS server must be an IP literal");
  if (isBlockedIpAddress(server)) throw new Error("Legacy DNS server address is policy-violating");
  const resolver = new Resolver();
  resolver.setServers([server]);
  const [v4, v6] = await Promise.all([
    resolver.resolve4(hostname).catch(() => [] as string[]),
    resolver.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [
    ...v4.map((address) => ({ address, family: 4 })),
    ...v6.map((address) => ({ address, family: 6 })),
  ];
}

/**
 * 出站解析回退链（#5）：DoH → 系统解析器 → 传统 53 端口，逐跳可用环境变量关闭
 * （INSIGHTFORGE_DNS_DOH / _SYSTEM / _LEGACY = 0；INSIGHTFORGE_DNS_DOH_URL 与
 * INSIGHTFORGE_DNS_LEGACY_SERVER 可配置）。无论哪一跳应答，结果仍要经过调用方的
 * SSRF IP 黑名单校验——本链只让解析可观察、降低单解析器脆弱性，不消除 TOCTOU。
 */
export async function resolveDnsChain(
  hostname: string,
  options: { env?: NodeJS.ProcessEnv; dohFetcher?: DohFetcher } = {},
): Promise<ResolvedAddress[]> {
  const env = options.env ?? process.env;
  const hops: Array<{ name: string; run: () => Promise<ResolvedAddress[]> }> = [
    { name: "doh", run: () => resolveViaDoh(hostname, env, options.dohFetcher ?? fetch) },
    { name: "system", run: () => resolveViaSystem(hostname) },
    { name: "legacy", run: () => resolveViaLegacy(hostname, env) },
  ];
  const errors: string[] = [];
  for (const hop of hops) {
    if (!hopEnabled(env, `INSIGHTFORGE_DNS_${hop.name.toUpperCase()}`)) continue;
    try {
      const addresses = await hop.run();
      if (addresses.length > 0) return addresses;
      errors.push(`${hop.name}: empty answer`);
    } catch (error) {
      errors.push(`${hop.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`DNS chain exhausted for ${hostname} (${errors.join("; ")})`);
}
