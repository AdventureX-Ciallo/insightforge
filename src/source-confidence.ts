import type { Conclusion, ResearchSource, SourceConfidence } from "./domain.js";

const ASSOCIATION_DOMAINS = ["caam.org.cn", "cada.cn", "evcipa.org.cn"];
const EVENT_DOMAINS = ["devpost.com", "adventure-x.org"];
const COMMUNITY_DOMAINS = ["zhihu.com", "xiaohongshu.com"];

function matchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hostnameFor(source: ResearchSource) {
  if (!source.locator.url) return "";
  try {
    return new URL(source.locator.url).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return "";
  }
}

function rounded(value: number) {
  return Number(value.toFixed(2));
}

/** 域名优先于发布者自述，防止社区页面用“权威发布”等文本抬高自身权重。 */
export function scoreSourceConfidence(source: ResearchSource): SourceConfidence {
  const hostname = hostnameFor(source);
  let category: SourceConfidence["category"];
  let authority: number;
  let rationale: string;
  if (hostname === "gov.cn" || hostname.endsWith(".gov.cn")) {
    category = "GOVERNMENT";
    authority = 0.97;
    rationale = "政府域名静态白名单";
  } else if (ASSOCIATION_DOMAINS.some((domain) => matchesDomain(hostname, domain))) {
    category = "ASSOCIATION";
    authority = 0.92;
    rationale = "行业协会域名静态白名单";
  } else if (EVENT_DOMAINS.some((domain) => matchesDomain(hostname, domain))) {
    category = "AUTHORITATIVE_EVENT";
    authority = 0.88;
    rationale = "权威赛事与项目平台域名静态白名单";
  } else if (COMMUNITY_DOMAINS.some((domain) => matchesDomain(hostname, domain))) {
    category = "COMMUNITY";
    authority = 0.3;
    rationale = "社区内容平台，仅作为低权重候选材料";
  } else if (source.materialRole === "USER_UPLOAD") {
    category = "USER_UPLOAD";
    authority = 0.45;
    rationale = "用户上传材料尚未完成外部权威性核验";
  } else if (source.materialRole === "SYNTHETIC_DEMO_MATERIAL") {
    category = "SYNTHETIC";
    authority = 0.35;
    rationale = "合成演示材料不能替代权威原始信源";
  } else if (source.materialRole === "AUTHORITY_SOURCE") {
    category = "OFFICIAL";
    authority = 0.82;
    rationale = "已登记的官方候选来源，仍保留域名级核验边界";
  } else {
    category = "OTHER";
    authority = 0.55;
    rationale = "未命中静态高低权重域名表";
  }
  const freshness = source.freshness === "CURRENT" ? 0.9 : 0.25;
  const locator = source.locator;
  const completeness = locator.page || locator.sheet || locator.cellRange || locator.rows?.length
    ? 0.95
    : locator.url || locator.fileName
      ? 0.78
      : 0.4;
  const overall = rounded(authority * 0.55 + freshness * 0.2 + completeness * 0.25);
  const discountNote = category === "OTHER"
    ? `未验证 OTHER 类别信源（综合权重 ${overall.toFixed(2)}）：${rationale}；定位完整度不等于权威性，结论必须保留来源折扣。`
    : overall < 0.7
      ? `低置信度信源（综合权重 ${overall.toFixed(2)}）：${rationale}，结论不得按高权重证据呈现。`
      : null;
  return {
    category,
    authority: rounded(authority),
    freshness: rounded(freshness),
    completeness: rounded(completeness),
    overall,
    rationale,
    discountNote,
  };
}

export function applySourceConfidence(sources: ResearchSource[], conclusions: Conclusion[]) {
  for (const source of sources) source.confidence = scoreSourceConfidence(source);
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const conclusion of conclusions) {
    conclusion.confidenceDiscounts = conclusion.sourceIds.flatMap((sourceId) => {
      const source = byId.get(sourceId);
      const confidence = source?.confidence;
      return confidence?.discountNote
        ? [{ sourceId, weight: confidence.overall, explanation: confidence.discountNote }]
        : [];
    });
  }
}
