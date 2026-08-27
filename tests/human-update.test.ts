import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyHumanDecision, applyHumanDecisionAndPersist, applySourceUpdate, runGoldenCase } from "../src/index.js";

async function makeRun() {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-review-"));
  const run = await runGoldenCase({
    researchQuestion: "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？",
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  return { run, workspaceDir };
}

test("human decisions preserve the AI original and block unsupported confirmation", async () => {
  const { run } = await makeRun();
  const before = run.conclusions.find((item) => item.id === "conclusion-charging-growth");
  assert.ok(before);

  const edited = applyHumanDecision(run, {
    conclusionId: before.id,
    action: "EDIT",
    text: "人工修订：名义供给增长不能替代区域利用率验证。",
  });
  const after = edited.conclusions.find((item) => item.id === before.id);
  assert.equal(after?.text, "人工修订：名义供给增长不能替代区域利用率验证。");
  assert.equal(after?.originalAiText, before.originalAiText);
  assert.equal(after?.reviewStatus, "PENDING_REVIEW");
  assert.equal(after?.normalizedReviewStatus, "PENDING_REVIEW");
  assert.equal(after?.type, "AI_JUDGMENT");
  assert.equal(after?.originType, "HUMAN_EDITED");
  assert.equal(after?.confirmedAt, null);
  assert.equal(edited.humanDecisions.at(-1)?.action, "EDIT");
  assert.equal(edited.candidateRevisions.find((item) => item.id === after?.currentRevisionId)?.authorType, "HUMAN");

  const confirmedEdit = applyHumanDecision(edited, { conclusionId: before.id, action: "CONFIRM" });
  const confirmedAfterEdit = confirmedEdit.conclusions.find((item) => item.id === before.id);
  assert.equal(confirmedAfterEdit?.reviewStatus, "CONFIRMED");
  assert.equal(confirmedAfterEdit?.type, "HUMAN_CONFIRMED");
  assert.ok(confirmedAfterEdit?.confirmedAt);

  const unsupportedEdit = applyHumanDecision(confirmedEdit, {
    conclusionId: "conclusion-causality-gap",
    action: "EDIT",
    text: "人工修订：现有资料仍不足以判断全行业盈利改善。",
  });
  const unsupported = unsupportedEdit.conclusions.find((item) => item.id === "conclusion-causality-gap");
  assert.equal(unsupported?.text, "人工修订：现有资料仍不足以判断全行业盈利改善。");
  assert.equal(unsupported?.type, "AI_JUDGMENT");
  assert.equal(unsupported?.reviewStatus, "PENDING_REVIEW");
  assert.equal(unsupported?.confirmedAt, null);
  assert.throws(
    () => applyHumanDecision(unsupportedEdit, { conclusionId: "conclusion-causality-gap", action: "CONFIRM" }),
    /INSUFFICIENT_EVIDENCE/,
  );
});

test("source v2 selectively invalidates confirmation, recalculates, and refreshes exports", async () => {
  const { run, workspaceDir } = await makeRun();
  const confirmed = await applyHumanDecisionAndPersist(run, {
    conclusionId: "conclusion-penetration",
    action: "CONFIRM",
    reason: "两个数字对应不同统计口径，确认的只是冲突及边界，不选择其中一个为真值。",
    scopeNote: "仅适用于 2024 年中国市场及当前列明的乘用车零售/全汽车销量口径。",
  }, workspaceDir);
  const unrelatedBefore = confirmed.conclusions.find((item) => item.id === "conclusion-charging-growth");
  const pptxBefore = confirmed.artifacts.find((item) => item.kind === "PPTX");
  assert.ok(pptxBefore);

  const updated = await applySourceUpdate(confirmed, {
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });

  assert.equal(updated.sourceVersion, "v2");
  for (const requiredId of ["claim-penetration", "conclusion-penetration", "datum-penetration", "evidence-market-csv", "source-market-csv", "source-version-market-csv-v1", "source-version-market-csv-v2"]) {
    assert.ok(updated.affectedObjectIds.includes(requiredId), `affected objects include ${requiredId}`);
  }
  const affected = updated.conclusions.find((item) => item.id === "conclusion-penetration");
  assert.equal(affected?.evidenceStatus, "STALE");
  assert.equal(affected?.reviewStatus, "NEEDS_REVIEW");
  assert.equal(affected?.type, "AI_JUDGMENT");
  assert.equal(affected?.confirmedAt, null);
  assert.equal(updated.claims.find((item) => item.id === "claim-penetration")?.evidenceStatus, "STALE");
  assert.notEqual(
    updated.data.find((item) => item.id === "datum-penetration")?.value,
    confirmed.data.find((item) => item.id === "datum-penetration")?.value,
  );
  assert.deepEqual(
    updated.conclusions.find((item) => item.id === "conclusion-charging-growth"),
    unrelatedBefore,
  );
  assert.equal(updated.humanDecisions.at(-1)?.action, "REVOKE_ON_SOURCE_UPDATE");
  assert.ok(updated.humanDecisions.find((item) => item.action === "CONFIRM")?.invalidatedAt);
  assert.equal(updated.sourceVersions.filter((item) => item.sourceId === "source-market-csv" && item.isCurrent).length, 1);
  assert.equal(updated.artifactVersions.length, 3);
  assert.ok(updated.artifactVersions.slice(0, 2).every((item) => item.status === "SUPERSEDED"));
  assert.equal(updated.artifactVersions[2]?.status, "CURRENT");
  assert.equal(updated.artifactHistory.length, 8);
  assert.notEqual(updated.artifacts.find((item) => item.kind === "PPTX")?.sha256, pptxBefore.sha256);
});
