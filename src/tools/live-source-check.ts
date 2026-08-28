import { createHash } from "node:crypto";
import { readResponseBytesLimited } from "./limited-response.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
const AUTHORITY_SOURCES = [
  {
    title: "中汽协 2024 中国汽车市场预测",
    url: "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html",
    expectedMarkers: ["1150", "新能源汽车"],
  },
  {
    title: "国务院客户端转载：2024 年中国汽车产销量",
    url: "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html",
    expectedMarkers: ["1286.6", "40.9%"],
  },
  {
    title: "中国汽车流通协会：2024 年 12 月乘用车市场分析",
    url: "https://www.cada.cn/Trends/info_91_10118.html",
    expectedMarkers: ["47.6%", "1,089.9"],
  },
  {
    title: "中国充电联盟：2024 年全国充换电基础设施运行情况",
    url: "https://www.evcipa.org.cn/newsinfo/8137834.html",
    expectedMarkers: ["357.9", "272.6"],
  },
] as const;

export type AuthorityFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkLiveSources(fetcher: AuthorityFetcher = fetch) {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(AUTHORITY_SOURCES.map(async (source) => {
    try {
      // redirect:"error" 在建立任何中间连接之前 fail-closed：undici 的 "follow" 会先对每个
      // 重定向目标建立真实 TCP/TLS 连接，事后校验 response.url 属于盲 SSRF（#1）。
      const response = await fetcher(source.url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.redirected) throw new Error("Unexpected redirect");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType && !contentType.includes("text/html")) throw new Error("Unexpected content type");
      const bytes = await readResponseBytesLimited(response, MAX_RESPONSE_BYTES, "Response exceeds safety limit");
      if (bytes.byteLength < 64) throw new Error("Authority response is unexpectedly short");
      const text = new TextDecoder().decode(bytes);
      if (/too many requests|captcha|访问验证|access denied|<title>\s*(?:error|错误)/iu.test(text)) {
        throw new Error("Authority host returned a challenge or error page");
      }
      if (!source.expectedMarkers.every((marker) => text.includes(marker))) {
        throw new Error("Authority page is missing expected content markers");
      }
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
    } catch (error) {
      return {
        title: source.title,
        url: source.url,
        status: "failed" as const,
        checkedAt,
        httpStatus: null,
        sizeBytes: 0,
        sha256: "",
        error: error instanceof Error ? error.message : "Network request failed",
      };
    }
  }));
  return { mode: "live-authority-check" as const, checkedAt, results };
}
