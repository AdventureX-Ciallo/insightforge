import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

test("final human decisions reject replay and cross-terminal flips until an EDIT reopens review", async () => {
  const { run } = await makeRun();
  const conclusionId = "conclusion-charging-growth";

  const confirmed = applyHumanDecision(run, { conclusionId, action: "CONFIRM" });
  const confirmedDecisionCount = confirmed.humanDecisions.length;
  const confirmedAt = confirmed.conclusions.find((item) => item.id === conclusionId)?.confirmedAt;
  assert.throws(
    () => applyHumanDecision(confirmed, { conclusionId, action: "CONFIRM" }),
    /already has a final human decision.*EDIT/u,
  );
  assert.throws(
    () => applyHumanDecision(confirmed, { conclusionId, action: "REJECT" }),
    /already has a final human decision.*EDIT/u,
  );
  assert.equal(confirmed.humanDecisions.length, confirmedDecisionCount);
  assert.equal(confirmed.conclusions.find((item) => item.id === conclusionId)?.confirmedAt, confirmedAt);

  const rejected = applyHumanDecision(run, { conclusionId, action: "REJECT" });
  const rejectedDecisionCount = rejected.humanDecisions.length;
  assert.throws(
    () => applyHumanDecision(rejected, { conclusionId, action: "REJECT" }),
    /already has a final human decision.*EDIT/u,
  );
  assert.throws(
    () => applyHumanDecision(rejected, { conclusionId, action: "CONFIRM" }),
    /already has a final human decision.*EDIT/u,
  );
  assert.equal(rejected.humanDecisions.length, rejectedDecisionCount);

  const reopened = applyHumanDecision(confirmed, {
    conclusionId,
    action: "EDIT",
    text: "人工修订后重新进入待审。",
    reason: "新证据要求重写判断",
  });
  assert.equal(reopened.conclusions.find((item) => item.id === conclusionId)?.normalizedReviewStatus, "PENDING_REVIEW");
  const reconsidered = applyHumanDecision(reopened, { conclusionId, action: "REJECT" });
  assert.equal(reconsidered.conclusions.find((item) => item.id === conclusionId)?.normalizedReviewStatus, "HUMAN_REJECTED");
  assert.equal(reconsidered.humanDecisions.length, confirmedDecisionCount + 2);
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

  const v2Csv = await readFile(resolve("fixtures/golden/market_v2.csv"), "utf8");
  const v2Fields = v2Csv.trim().split("\n").find((line) => line.startsWith("2024,"))!.split(",").map(Number);
  const v2Version = updated.sourceVersions.find((item) => item.sourceId === "source-market-csv" && item.version === "v2");

  assert.equal(updated.sourceVersion, "v2");
  assert.ok(v2Version);
  for (const requiredId of ["claim-penetration", "conclusion-penetration", "datum-penetration", "evidence-market-csv", "source-market-csv", "source-version-market-csv-v1", v2Version.id]) {
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
  assert.equal(updated.sources.find((item) => item.id === "source-market-csv")?.excerpt, v2Csv);
  assert.deepEqual(
    updated.data.find((item) => item.id === "datum-penetration")?.inputs.map((input) => input.value),
    [v2Fields[1], v2Fields[2]],
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
