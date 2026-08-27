import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyHumanDecision, applySourceUpdate, runGoldenCase } from "../src/index.js";

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
  const before = run.conclusions.find((item) => item.id === "conclusion-charging");
  assert.ok(before);

  const edited = applyHumanDecision(run, {
    conclusionId: before.id,
    action: "EDIT",
    text: "人工修订：名义供给增长不能替代区域利用率验证。",
  });
  const after = edited.conclusions.find((item) => item.id === before.id);
  assert.equal(after?.text, "人工修订：名义供给增长不能替代区域利用率验证。");
  assert.equal(after?.originalAiText, before.originalAiText);
  assert.equal(after?.reviewStatus, "CONFIRMED");
  assert.equal(after?.type, "HUMAN_CONFIRMED");
  assert.ok(after?.confirmedAt);
  assert.equal(edited.humanDecisions.at(-1)?.action, "EDIT");

  const unsupportedEdit = applyHumanDecision(edited, {
    conclusionId: "conclusion-profitability",
    action: "EDIT",
    text: "人工修订：现有资料仍不足以判断全行业盈利改善。",
  });
  const unsupported = unsupportedEdit.conclusions.find((item) => item.id === "conclusion-profitability");
  assert.equal(unsupported?.text, "人工修订：现有资料仍不足以判断全行业盈利改善。");
  assert.equal(unsupported?.type, "AI_JUDGMENT");
  assert.equal(unsupported?.reviewStatus, "PENDING_REVIEW");
  assert.equal(unsupported?.confirmedAt, null);
  assert.throws(
    () => applyHumanDecision(unsupportedEdit, { conclusionId: "conclusion-profitability", action: "CONFIRM" }),
    /INSUFFICIENT_EVIDENCE/,
  );
});

test("source v2 selectively invalidates confirmation, recalculates, and refreshes exports", async () => {
  const { run, workspaceDir } = await makeRun();
  const confirmed = applyHumanDecision(run, {
    conclusionId: "conclusion-penetration",
    action: "CONFIRM",
  });
  const unrelatedBefore = confirmed.conclusions.find((item) => item.id === "conclusion-charging");
  const pptxBefore = confirmed.artifacts.find((item) => item.kind === "PPTX");
  assert.ok(pptxBefore);

  const updated = await applySourceUpdate(confirmed, {
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });

  assert.equal(updated.sourceVersion, "v2");
  assert.deepEqual(updated.affectedObjectIds.sort(), [
    "claim-penetration",
    "conclusion-penetration",
    "datum-penetration",
    "evidence-market-csv",
    "source-market-csv",
  ]);
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
    updated.conclusions.find((item) => item.id === "conclusion-charging"),
    unrelatedBefore,
  );
  assert.equal(updated.humanDecisions.at(-1)?.action, "REVOKE_ON_SOURCE_UPDATE");
  assert.notEqual(updated.artifacts.find((item) => item.kind === "PPTX")?.sha256, pptxBefore.sha256);
});
