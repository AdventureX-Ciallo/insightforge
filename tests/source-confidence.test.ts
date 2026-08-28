import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applySourceConfidence, runGoldenCase, scoreSourceConfidence, type ResearchSource } from "../src/index.js";

function source(url: string, publisher = "测试发布者"): ResearchSource {
  return {
    id: "source-test",
    kind: "WEB",
    title: "测试信源",
    publisher,
    version: "snapshot",
    locator: { url },
    capturedAt: new Date().toISOString(),
    excerpt: "测试",
    isOfflineSnapshot: false,
    sourceVersionId: "source-version-test",
    materialRole: "CANDIDATE_SOURCE",
    freshness: "CURRENT",
  };
}

test("static domain weights rank official and authoritative-event sources above community content", () => {
  const government = scoreSourceConfidence(source("https://app.www.gov.cn/report"));
  const association = scoreSourceConfidence(source("https://www.caam.org.cn/report"));
  const event = scoreSourceConfidence(source("https://devpost.com/software/insightforge"));
  const zhihuSpoof = scoreSourceConfidence(source("https://www.zhihu.com/question/1", "国务院权威发布"));
  const xiaohongshu = scoreSourceConfidence(source("https://www.xiaohongshu.com/explore/1"));
  assert.equal(government.category, "GOVERNMENT");
  assert.equal(association.category, "ASSOCIATION");
  assert.equal(event.category, "AUTHORITATIVE_EVENT");
  assert.equal(zhihuSpoof.category, "COMMUNITY");
  assert.ok(government.overall > zhihuSpoof.overall && association.overall > xiaohongshu.overall && event.overall > xiaohongshu.overall);
  assert.ok(zhihuSpoof.discountNote?.includes(zhihuSpoof.overall.toFixed(2)));
});

test("golden sources carry three dimensions and low-confidence support is disclosed on conclusions", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-confidence-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  assert.ok(run.sources.every((item) => item.confidence
    && item.confidence.authority >= 0 && item.confidence.freshness >= 0
    && item.confidence.completeness >= 0 && item.confidence.overall >= 0));
  const lowSourceIds = new Set(run.sources.filter((item) => (item.confidence?.overall ?? 1) < 0.7).map((item) => item.id));
  assert.ok(lowSourceIds.size > 0);
  assert.ok(run.conclusions.some((conclusion) => conclusion.confidenceDiscounts?.some((discount) => lowSourceIds.has(discount.sourceId)
    && discount.explanation.includes("低置信度"))));
});

test("confidence scoring covers uploads, synthetic material, official candidates, stale and unlocatable sources", () => {
  const upload = source("");
  upload.materialRole = "USER_UPLOAD";
  upload.locator = { fileName: "upload.txt" };
  const synthetic = source("not a valid URL");
  synthetic.materialRole = "SYNTHETIC_DEMO_MATERIAL";
  synthetic.locator = {};
  synthetic.freshness = "STALE";
  const official = source("https://research.example.test/report");
  official.materialRole = "AUTHORITY_SOURCE";
  official.locator.page = 3;
  const other = source("https://other.example.test/report");
  other.locator = {};
  const invalidUrl = source("not a valid URL");

  assert.equal(scoreSourceConfidence(upload).category, "USER_UPLOAD");
  assert.equal(scoreSourceConfidence(synthetic).category, "SYNTHETIC");
  assert.equal(scoreSourceConfidence(synthetic).freshness, 0.25);
  assert.equal(scoreSourceConfidence(synthetic).completeness, 0.4);
  assert.equal(scoreSourceConfidence(official).category, "OFFICIAL");
  assert.equal(scoreSourceConfidence(official).completeness, 0.95);
  assert.equal(scoreSourceConfidence(other).category, "OTHER");
  assert.equal(scoreSourceConfidence(invalidUrl).category, "OTHER");

  const conclusions = [{ sourceIds: [upload.id, "missing-source"] }] as never;
  applySourceConfidence([upload], conclusions);
  assert.equal((conclusions as Array<{ confidenceDiscounts: unknown[] }>)[0]!.confidenceDiscounts.length, 1);
});

test("an OTHER source remains explicitly discounted even when its locator is complete", () => {
  const unknown = source("https://unknown.example.test/report");
  unknown.locator = { url: "https://unknown.example.test/report", page: 7 };
  const confidence = scoreSourceConfidence(unknown);
  assert.equal(confidence.category, "OTHER");
  assert.equal(confidence.overall, 0.72);
  assert.match(confidence.discountNote ?? "", /未验证.*OTHER.*定位完整度不等于权威性/u);

  const conclusions = [{ sourceIds: [unknown.id] }] as never;
  applySourceConfidence([unknown], conclusions);
  const discounts = (conclusions as Array<{ confidenceDiscounts: Array<{ sourceId: string; weight: number; explanation: string }> }>)[0]!.confidenceDiscounts;
  assert.deepEqual(discounts.map((item) => ({ sourceId: item.sourceId, weight: item.weight })), [{ sourceId: unknown.id, weight: 0.72 }]);
  assert.match(discounts[0]!.explanation, /未验证/u);
});
