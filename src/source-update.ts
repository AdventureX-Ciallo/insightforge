import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { persistRun, writeArtifactVersion } from "./artifacts.js";
import { computeResearchSnapshotId, researchRunSchema, type ResearchRun } from "./domain.js";
import { DomainError } from "./domain-error.js";
import { hashFile, hashValue } from "./hash.js";
import { GOLDEN_RESEARCH_QUESTION } from "./model-cache.js";
import { applySourceConfidence } from "./source-confidence.js";
import { calculateMarketMetrics } from "./tools/csv-calculator.js";

export interface SourceUpdateOptions {
  fixtureDir: string;
  workspaceDir: string;
}

function notApplicable() {
  return new DomainError(422, "SOURCE_UPDATE_NOT_APPLICABLE", "来源更新仅适用于内置黄金案例的 v1→v2 演示");
}

function invalidGraph() {
  return new DomainError(422, "SOURCE_UPDATE_GRAPH_INVALID", "来源更新所需依赖图无效，已 fail-closed 且未生成新成果");
}

function nextAvailableId(prefix: string, existingIds: ReadonlySet<string>) {
  let candidate = prefix;
  for (let suffix = 1; existingIds.has(candidate); suffix += 1) candidate = `${prefix}-${suffix}`;
  return candidate;
}

function validateCandidateBeforeArtifacts(run: ResearchRun) {
  const candidate = structuredClone(run);
  candidate.artifacts = [];
  candidate.artifactHistory = [];
  candidate.artifactVersions = [];
  candidate.researchSnapshotId = computeResearchSnapshotId(candidate);
  // This is a defensive internal invariant: validated input plus the deterministic
  // transformation below must always produce a schema-valid pre-artifact graph.
  /* c8 ignore next */
  if (!researchRunSchema.safeParse(candidate).success) throw invalidGraph();
}

/** 内置确定性 v1→v2：保留旧 SourceVersion/ArtifactVersion，只让依赖链上的对象失效。 */
export async function applySourceUpdate(current: ResearchRun, options: SourceUpdateOptions): Promise<ResearchRun> {
  const validated = researchRunSchema.safeParse(current);
  if (!validated.success) throw invalidGraph();
  if (validated.data.sourceVersion !== "v1") {
    throw new DomainError(409, "SOURCE_ALREADY_V2", "来源已在 v2；同一任务的 v1→v2 更新只能执行一次");
  }
  if (validated.data.researchQuestion !== GOLDEN_RESEARCH_QUESTION) throw notApplicable();
  const run = structuredClone(validated.data);
  const sources = run.sources.filter((item) => item.version === "v1" && item.locator.fileName === "market_v1.csv");
  if (sources.length > 1) throw invalidGraph();
  const source = sources[0];
  if (!source) throw notApplicable();
  const linkedEvidence = run.evidence.filter((item) => item.sourceId === source.id);
  const linkedEvidenceIds = new Set(linkedEvidence.map((item) => item.id));
  const penetrationData = run.data.filter((item) => linkedEvidenceIds.has(item.evidenceId)
    && item.formula === "nev_sales_million / total_auto_sales_million * 100"
    && item.period === "2024");
  if (penetrationData.length > 1) throw invalidGraph();
  const penetrationDatum = penetrationData[0];
  const oldVersion = run.sourceVersions.find((item) => item.id === source.sourceVersionId)!;
  if (linkedEvidence.length === 0) throw notApplicable();
  if (!penetrationDatum) throw notApplicable();

  const dataById = new Map(run.data.map((item) => [item.id, item]));
  const affectedClaims = run.claims.filter((claim) => {
    if (claim.datumIds.includes(penetrationDatum.id)) return true;
    if (!claim.evidenceIds.some((id) => linkedEvidenceIds.has(id))) return false;
    // A direct evidence citation with no datum derived from that evidence is still a real
    // dependency. Conversely, a claim linked only to an unchanged datum from the same CSV
    // (for example charger growth) remains current.
    return !claim.datumIds.some((id) => {
      const datum = dataById.get(id)!;
      return linkedEvidenceIds.has(datum.evidenceId);
    });
  });
  const affectedClaimIds = new Set(affectedClaims.map((item) => item.id));
  const affectedConclusions = run.conclusions.filter((item) => item.claimIds.some((id) => affectedClaimIds.has(id)));
  const previousRevisions = new Map(affectedConclusions.map((conclusion) => [
    conclusion.id,
    run.candidateRevisions.find((item) => item.id === conclusion.currentRevisionId)!,
  ]));
  if (affectedClaims.length === 0 || affectedConclusions.length === 0) throw notApplicable();

  const csvPath = resolve(options.fixtureDir, "market_v2.csv");
  const csvText = await readFile(csvPath, "utf8");
  const metrics = await calculateMarketMetrics(csvPath);
  const currentRow = metrics.rows.find((row) => row.year === 2024)!;
  const previousPenetration = penetrationDatum.value;
  const now = new Date().toISOString();
  const updateId = `source-update-${randomUUID()}`;
  oldVersion.isCurrent = false;
  const v2VersionId = nextAvailableId(`source-version-${source.id}-v2`, new Set(run.sourceVersions.map((item) => item.id)));
  run.sourceVersions.push({
    id: v2VersionId,
    sourceId: source.id,
    version: "v2",
    capturedAt: now,
    sha256: await hashFile(csvPath),
    locator: { url: "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html", fileName: "market_v2.csv", columns: ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"], rows: [2, 3] },
    knowledgeType: "FACT",
    upstreamSourceIds: [...oldVersion.upstreamSourceIds],
    isCurrent: true,
  });
  source.version = "v2";
  source.sourceVersionId = v2VersionId;
  source.locator = run.sourceVersions.at(-1)!.locator;
  source.capturedAt = now;
  source.excerpt = csvText;
  source.freshness = "CURRENT";

  for (const evidence of linkedEvidence) {
    evidence.excerpt = `2024 penetration = ${metrics.penetration.toFixed(4)}%; charger growth = ${metrics.chargerGrowth.toFixed(4)}%`;
    evidence.locator = source.locator;
    evidence.freshness = "CURRENT";
  }
  penetrationDatum.value = metrics.penetration;
  penetrationDatum.metric = "2024 新能源汽车新车销量占比（最终输入重算）";
  penetrationDatum.inputs = [{ label: "新能源汽车最终销量", value: currentRow.nevSales, unit: "百万辆" }, { label: "汽车最终总销量", value: currentRow.totalSales, unit: "百万辆" }];
  penetrationDatum.freshness = "CURRENT";

  for (const claim of affectedClaims) {
    claim.text = `来源更新：2024 全汽车销量份额由 v1 的 ${previousPenetration.toFixed(1)}% 重算为 v2 的 ${metrics.penetration.toFixed(1)}%；原候选判断已失效，需结合其既有证据重新审查。`;
    claim.evidenceStatus = "STALE";
    claim.freshness = "STALE";
  }

  const sourceSnapshotId = hashValue(run.sourceVersions.filter((item) => item.isCurrent));
  const revisionIds: string[] = [];
  const usedRevisionIds = new Set(run.candidateRevisions.map((item) => item.id));
  const usedDecisionIds = new Set(run.humanDecisions.map((item) => item.id));
  for (const conclusion of affectedConclusions) {
    const previousRevision = previousRevisions.get(conclusion.id)!;
    previousRevision.isCurrent = false;
    const revisionId = nextAvailableId(`revision-${updateId}-${conclusion.id}`, usedRevisionIds);
    usedRevisionIds.add(revisionId);
    revisionIds.push(revisionId);
    const previousConclusionText = conclusion.text;
    conclusion.text = `来源已更新：2024 全汽车销量份额由 v1 的 ${previousPenetration.toFixed(1)}% 变为 v2 的 ${metrics.penetration.toFixed(1)}%；旧候选判断和人工确认均已失效，需结合原证据路径重新审查。`;
    conclusion.currentRevisionId = revisionId;
    conclusion.originType = "DETERMINISTIC";
    conclusion.evidenceStatus = "STALE";
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
      sourceSnapshotId,
      isCurrent: true,
    });

    const invalidated = run.humanDecisions.filter((item) => item.conclusionId === conclusion.id && item.action === "CONFIRM" && !item.invalidatedAt);
    for (const decision of invalidated) {
      decision.invalidatedAt = now;
      decision.invalidationReason = `支撑该结论的 ${source.id} 从 v1 更新到 v2`;
      decision.sourceUpdateId = updateId;
    }
    if (invalidated.length > 0) {
      run.humanDecisions.push({
        id: nextAvailableId(`decision-${updateId}-${conclusion.id}`, usedDecisionIds),
        conclusionId: conclusion.id,
        action: "REVOKE_ON_SOURCE_UPDATE",
        decidedAt: now,
        previousText: previousConclusionText,
        resultingText: conclusion.text,
        candidateRevisionId: revisionId,
        decisionReason: "来源版本变化使原确认依据失效",
        scopeNote: null,
        invalidatedAt: now,
        invalidationReason: `${source.id} v1→v2`,
        sourceUpdateId: updateId,
      });
    }
  }

  run.sourceVersion = "v2";
  run.terminalStatus = "NEEDS_REVIEW";
  run.updatedAt = now;
  run.affectedObjectIds = [...new Set([
    source.id,
    oldVersion.id,
    v2VersionId,
    ...linkedEvidence.map((item) => item.id),
    penetrationDatum.id,
    ...affectedClaims.map((item) => item.id),
    ...affectedConclusions.map((item) => item.id),
    ...revisionIds,
  ])];
  applySourceConfidence(run.sources, affectedConclusions);
  validateCandidateBeforeArtifacts(run);
  await writeArtifactVersion(run, options.workspaceDir, "SOURCE_UPDATE", {
    triggerRef: updateId,
    adjustmentNote: `来源 ${source.id} 从 v1 更新到 v2；依赖对象已重算，既有确认按依赖关系撤销`,
  });
  researchRunSchema.parse(run);
  await persistRun(run, options.workspaceDir);
  return run;
}
