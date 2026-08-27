import { createHash } from "node:crypto";

const MAX_RESPONSE_BYTES = 512 * 1024;
const AUTHORITY_SOURCES = [
  {
    title: "中汽协 2024 中国汽车市场预测",
    url: "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html",
  },
  {
    title: "国务院客户端转载：2024 年中国汽车产销量",
    url: "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html",
  },
  {
    title: "中国汽车流通协会：2024 年 12 月乘用车市场分析",
    url: "https://www.cada.cn/Trends/info_91_10118.html",
  },
  {
    title: "中国充电联盟：2024 年全国充换电基础设施运行情况",
    url: "https://www.evcipa.org.cn/newsinfo/8137834.html",
  },
] as const;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function readLimited(response: Response) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("Response exceeds safety limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Response exceeds safety limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function checkLiveSources(fetcher: Fetcher = fetch) {
  const checkedAt = new Date().toISOString();
  const allowedHosts = new Set(AUTHORITY_SOURCES.map((source) => new URL(source.url).hostname));
  const results = await Promise.all(AUTHORITY_SOURCES.map(async (source) => {
    try {
      const response = await fetcher(source.url, {
        method: "GET",
        redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url && !allowedHosts.has(new URL(response.url).hostname)) throw new Error("Redirect left the authority allowlist");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("text/html")) throw new Error("Unexpected content type");
      const bytes = await readLimited(response);
      if (bytes.byteLength < 64) throw new Error("Authority response is unexpectedly short");
      return {
        title: source.title,
        url: source.url,
        status: "verified" as const,
        checkedAt,
        httpStatus: response.status,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        error: null,
      };
    } catch {
      return {
        title: source.title,
        url: source.url,
        status: "failed" as const,
        checkedAt,
        httpStatus: null,
        sizeBytes: 0,
        sha256: "",
        error: "Network request failed",
      };
    }
  }));
  return { mode: "live-authority-check" as const, checkedAt, results };
}
