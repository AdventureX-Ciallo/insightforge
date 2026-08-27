import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { persistRun, writeArtifactVersion } from "./artifacts.js";
import { researchRunSchema, type ResearchRun } from "./domain.js";
import { hashFile, hashValue } from "./hash.js";
import { applySourceConfidence } from "./source-confidence.js";
import { calculateMarketMetrics } from "./tools/csv-calculator.js";

export interface SourceUpdateOptions {
  fixtureDir: string;
  workspaceDir: string;
}

/** 内置确定性 v1→v2：保留旧 SourceVersion/ArtifactVersion，只让依赖链上的对象失效。 */
export async function applySourceUpdate(current: ResearchRun, options: SourceUpdateOptions): Promise<ResearchRun> {
  if (current.sourceVersion !== "v1") throw new Error("The golden source update can only be applied once");
  const run = structuredClone(current);
  const csvPath = resolve(options.fixtureDir, "market_v2.csv");
  const metrics = await calculateMarketMetrics(csvPath);
  const now = new Date().toISOString();
  const updateId = `source-update-${randomUUID()}`;

  const source = run.sources.find((item) => item.id === "source-market-csv");
  const evidence = run.evidence.find((item) => item.id === "evidence-market-csv");
  const datum = run.data.find((item) => item.id === "datum-penetration");
  const claim = run.claims.find((item) => item.id === "claim-penetration");
  const conclusion = run.conclusions.find((item) => item.id === "conclusion-penetration");
  if (!source || !evidence || !datum || !claim || !conclusion) throw new Error("Source dependency chain is incomplete");

  const oldVersion = run.sourceVersions.find((item) => item.id === source.sourceVersionId);
  if (oldVersion) oldVersion.isCurrent = false;
  const v2VersionId = "source-version-market-csv-v2";
  run.sourceVersions.push({
    id: v2VersionId,
    sourceId: source.id,
    version: "v2",
    capturedAt: now,
    sha256: await hashFile(csvPath),
    locator: { url: "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html", fileName: "market_v2.csv", columns: ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"], rows: [2, 3] },
    knowledgeType: "FACT",
    upstreamSourceIds: ["source-web-association", "source-web-charging"],
    isCurrent: true,
  });
  source.version = "v2";
  source.sourceVersionId = v2VersionId;
  source.locator = run.sourceVersions.at(-1)!.locator;
  source.capturedAt = now;
  source.excerpt = "2023,9.495,30.094,2.726\n2024,12.866,31.436,3.579";
  source.freshness = "CURRENT";

  evidence.excerpt = `2024 penetration = ${metrics.penetration.toFixed(4)}%; charger growth = ${metrics.chargerGrowth.toFixed(4)}%`;
  evidence.locator = source.locator;
  evidence.freshness = "CURRENT";
  datum.value = metrics.penetration;
  datum.metric = "2024 新能源汽车新车销量占比（最终输入重算）";
  datum.inputs = [{ label: "新能源汽车最终销量", value: 12.866, unit: "百万辆" }, { label: "汽车最终总销量", value: 31.436, unit: "百万辆" }];
  datum.freshness = "CURRENT";

  claim.text = `来源更新：全汽车最终销量口径重算为 ${metrics.penetration.toFixed(1)}%，原预测输入对应判断已失效；与乘用车国内零售 47.6% 仍属不同口径。`;
  claim.originalText = claim.originalText;
  claim.evidenceStatus = "STALE";
  claim.freshness = "STALE";

  const previousRevision = run.candidateRevisions.find((item) => item.id === conclusion.currentRevisionId);
  if (!previousRevision) throw new Error("Source dependency chain is incomplete");
  previousRevision.isCurrent = false;
  const revisionId = `revision-source-update-${randomUUID()}`;
  const previousConclusionText = conclusion.text;
  conclusion.text = `来源已更新：2024 全汽车销量份额由预测输入重算值 37.1% 变为最终输入重算值 ${metrics.penetration.toFixed(1)}%；旧候选判断和人工确认均已失效，需重新审查口径冲突。`;
  conclusion.currentRevisionId = revisionId;
  conclusion.originType = "DETERMINISTIC";
  conclusion.evidenceStatus = "STALE";
  conclusion.normalizedEvidenceStatus = "CONFLICT";
  conclusion.reviewStatus = "NEEDS_REVIEW";
  conclusion.normalizedReviewStatus = "NEEDS_REVIEW";
  conclusion.freshness = "STALE";
  conclusion.type = "AI_JUDGMENT";
  conclusion.confirmedAt = null;
  conclusion.confirmedText = null;
  run.candidateRevisions.push({
    id: revisionId,
    conclusionId: conclusion.id,
    parentRevisionId: previousRevision.id,
    authorType: "SYSTEM",
    originType: "DETERMINISTIC",
    text: conclusion.text,
    changeReason: "来源 v1→v2 触发确定性重算；该文本只说明失效与数值变化，不是新行业判断",
    createdAt: now,
    auditStatus: "NEEDS_REVIEW",
    auditFindingIds: [],
    sourceSnapshotId: hashValue(run.sourceVersions.filter((item) => item.isCurrent)),
    isCurrent: true,
  });

  const invalidated = run.humanDecisions.filter((item) => item.conclusionId === conclusion.id && item.action === "CONFIRM" && !item.invalidatedAt);
  for (const decision of invalidated) {
    decision.invalidatedAt = now;
    decision.invalidationReason = "支撑该结论的 source-market-csv 从 v1 更新到 v2";
    decision.sourceUpdateId = updateId;
  }
  if (invalidated.length > 0) {
    run.humanDecisions.push({
      id: randomUUID(),
      conclusionId: conclusion.id,
      action: "REVOKE_ON_SOURCE_UPDATE",
      decidedAt: now,
      previousText: previousConclusionText,
      resultingText: conclusion.text,
      candidateRevisionId: revisionId,
      decisionReason: "来源版本变化使原确认依据失效",
      scopeNote: null,
      invalidatedAt: now,
      invalidationReason: "source-market-csv v1→v2",
      sourceUpdateId: updateId,
    });
  }

  run.sourceVersion = "v2";
  run.terminalStatus = "NEEDS_REVIEW";
  run.updatedAt = now;
  run.affectedObjectIds = [source.id, oldVersion?.id, v2VersionId, evidence.id, datum.id, claim.id, conclusion.id, revisionId].filter((id): id is string => Boolean(id));
  applySourceConfidence(run.sources, run.conclusions);
  await writeArtifactVersion(run, options.workspaceDir, "SOURCE_UPDATE", {
    triggerRef: updateId,
    adjustmentNote: `来源 ${source.id} 从 v1 更新到 v2；依赖对象已重算，既有确认按依赖关系撤销`,
  });
  researchRunSchema.parse(run);
  await persistRun(run, options.workspaceDir);
  return run;
}
