import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runGoldenCase } from "../src/index.js";

const EV_QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";
const PV_QUESTION = "中国光伏组件出口价格在 2025-2026 年会受到哪些结构性因素影响？";

async function runWith(question: string) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-generalize-"));
  return runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    llmMode: "off",
  });
}

test("a question outside the fixture domain must not produce canned EV conclusions", async () => {
  const run = await runWith(PV_QUESTION);

  for (const conclusion of run.conclusions) {
    assert.ok(
      !/渗透率|充电|乘用车/.test(conclusion.text),
      `conclusion leaked EV content for an unrelated question: ${conclusion.text}`,
    );
  }

  assert.ok(run.conclusions.length >= 3 && run.conclusions.length <= 5);
  assert.ok(
    run.conclusions.every((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE" && item.missingEvidence.length > 0),
    "an unmatched question should honestly report insufficient evidence instead of fabricating domain conclusions",
  );
  assert.ok(run.conclusions.every((item) => item.reviewStatus !== "CONFIRMED"));

  assert.deepEqual(run.data.map((item) => item.id), ["datum-question-evidence-fit"]);
  assert.doesNotMatch(JSON.stringify(run.data), /datum-(?:reported-penetration|penetration|charger-growth|adequacy-estimate)|新能源|乘用车|充电|渗透率/u);
  const evidenceArtifact = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON");
  assert.ok(evidenceArtifact);
  const evidencePackage = JSON.parse(await readFile(evidenceArtifact.path, "utf8")) as { data: Array<{ id: string }> };
  assert.deepEqual(evidencePackage.data.map((item) => item.id), ["datum-question-evidence-fit"]);
  assert.doesNotMatch(JSON.stringify(evidencePackage.data), /datum-(?:reported-penetration|penetration|charger-growth|adequacy-estimate)|新能源|乘用车|充电|渗透率/u);
});

test("plan scope must follow the question instead of a hardcoded domain", async () => {
  const run = await runWith(PV_QUESTION);
  assert.ok(run.plan.scope.includes("光伏"), `scope should mention the question domain: ${run.plan.scope}`);
  assert.ok(
    !run.plan.scope.includes("范围限定为中国乘用车与公共充电设施"),
    `scope must not pin the golden-case domain for unrelated questions: ${run.plan.scope}`,
  );

  const evRun = await runWith(EV_QUESTION);
  assert.ok(/乘用车|充电/.test(evRun.plan.scope), `golden question scope should keep its domain: ${evRun.plan.scope}`);
});

test("the golden question still produces the full evidence-backed case", async () => {
  const run = await runWith(EV_QUESTION);
  assert.equal(run.terminalStatus, "NEEDS_REVIEW");
  assert.ok(run.conclusions.some((item) => item.evidenceStatus === "CONFLICT"));
  assert.ok(run.conclusions.some((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE"));
  assert.ok(run.data.some((item) => item.type === "CALCULATION" && item.formula));
  assert.ok(run.data.some((item) => item.type === "ESTIMATE" && item.assumptions.length > 0));
});
