import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";

import { evidencePackageSchema, researchRunSchema, runGoldenCase, type RunStep } from "../src/index.js";

async function golden(question = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？") {
  return runGoldenCase({
    researchQuestion: question,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-acceptance-")),
  });
}

test("every conclusion traces to locatable evidence and typed, reproducible data", async () => {
  const run = await golden();
  const authorityHosts = new Set(["www.caam.org.cn", "www.cada.cn", "www.evcipa.org.cn", "app.www.gov.cn"]);
  for (const source of run.sources) {
    if (!source.locator.url) continue;
    assert.ok(authorityHosts.has(new URL(source.locator.url).hostname), `${source.id} uses an authority URL`);
    assert.doesNotMatch(source.locator.url, /example\.org/);
  }
  const reportedPenetration = run.data.find((datum) => datum.id === "datum-reported-penetration");
  assert.equal(reportedPenetration?.value, 47.6);
  assert.equal(reportedPenetration?.type, "FACT");
  const forecastExtract = run.sources.find((source) => source.id === "source-market-csv");
  assert.equal(forecastExtract?.version, "v1");
  assert.equal(forecastExtract?.locator.url, "https://www.caam.org.cn/chn/1/cate_3/con_5236311.html");
  assert.ok(run.conclusions.length >= 3 && run.conclusions.length <= 5);
  for (const conclusion of run.conclusions) {
    assert.ok(conclusion.claimIds.length > 0);
    assert.ok(conclusion.evidenceIds.length > 0);
    for (const evidenceId of conclusion.evidenceIds) {
      const evidence = run.evidence.find((item) => item.id === evidenceId);
      assert.ok(evidence, `${conclusion.id} references ${evidenceId}`);
      assert.ok(evidence.locator.url || evidence.locator.fileName, `${evidenceId} has a precise locator`);
      assert.ok(run.sources.some((source) => source.id === evidence.sourceId));
    }
  }

  const representedTypes = new Set([...run.evidence.map((item) => item.type), ...run.data.map((item) => item.type)]);
  for (const required of ["FACT", "SOURCE_OPINION", "CALCULATION", "ESTIMATE"] as const) assert.ok(representedTypes.has(required));
  const calculation = run.data.find((datum) => datum.id === "datum-penetration");
  assert.ok(calculation?.formula);
  const [numerator, denominator] = calculation.inputs;
  assert.ok(numerator && denominator);
  assert.equal(Number(((numerator.value / denominator.value) * 100).toFixed(10)), Number(calculation.value.toFixed(10)));
  const estimate = run.data.find((datum) => datum.id === "datum-adequacy-estimate");
  assert.ok(estimate?.assumptions.length);
  assert.ok(run.conclusions.find((item) => item.id === "conclusion-penetration")?.text.includes(calculation.value.toFixed(1)));
  assert.ok(run.conclusions.find((item) => item.id === "conclusion-adequacy-estimate")?.text.includes(estimate.value.toFixed(2)));
  assert.equal(run.conflicts[0]?.datumIds.length, 2);
  assert.ok(run.conclusions.some((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE" && item.missingEvidence.length > 0));
});

test("audit covers all six gates, repairs once, and exports editable PPTX plus evidence JSON", async () => {
  const run = await golden();
  assert.equal(run.repairAttempts, 1);
  assert.deepEqual(new Set(run.auditFindings.map((item) => item.category)), new Set([
    "MISSING_CITATION",
    "UNSUPPORTED_CLAIM",
    "SOURCE_CONFLICT",
    "TYPE_MISMATCH",
    "MISSING_ASSUMPTION",
    "SCOPE_OVERREACH",
  ]));
  assert.ok(run.auditFindings.some((item) => item.status === "REPAIRED" && item.before !== item.after));

  const pptx = run.artifacts.find((item) => item.kind === "PPTX");
  const evidenceJson = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON");
  assert.ok(pptx && evidenceJson);
  const zip = await JSZip.loadAsync(await readFile(pptx.path));
  const slideFiles = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, 5);
  const slideXml = (await Promise.all(slideFiles.map((name) => zip.file(name)?.async("text")))).join("\n");
  assert.match(slideXml, /<a:t>/);
  assert.match(slideXml, /PROOF OF INSIGHT/);
  assert.match(slideXml, /INSUFFICIENT_EVIDENCE/);
  for (const requiredPart of ["ppt/presProps.xml", "ppt/viewProps.xml", "ppt/tableStyles.xml"]) {
    assert.ok(zip.file(requiredPart), `PowerPoint package contains ${requiredPart}`);
  }
  const masterXml = await zip.file("ppt/slideMasters/slideMaster1.xml")?.async("text");
  assert.match(masterXml ?? "", /p:clrMap bg1="lt1" tx1="dk1"/);
  assert.match(masterXml ?? "", /p:sldLayoutId id="2147483649"/);

  const machinePackage = JSON.parse(await readFile(evidenceJson.path, "utf8")) as Record<string, unknown>;
  evidencePackageSchema.parse(machinePackage);
  for (const key of ["researchQuestion", "sources", "evidence", "claims", "conclusions", "auditFindings", "humanDecisions", "artifacts"]) {
    assert.ok(key in machinePackage, `evidence package contains ${key}`);
  }
});

test("question changes alter the plan and synthesis, while a failed step cannot report success", async () => {
  const first = await golden("中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？");
  const second = await golden("二线城市公共充电设施利用率是否会拖累运营商盈利？");
  assert.notEqual(first.plan.id, second.plan.id);
  assert.notEqual(first.plan.scope, second.plan.scope);
  assert.notEqual(first.conclusions[0]?.text, second.conclusions[0]?.text);

  let lastProgress: RunStep[] = [];
  await assert.rejects(
    runGoldenCase({
      researchQuestion: "验证失败传播是否为 fail-closed",
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-failure-")),
      failAt: "COLLECT",
      onProgress: (steps) => { lastProgress = steps; },
    }),
    /Injected COLLECT failure/,
  );
  assert.equal(lastProgress.find((step) => step.state === "COLLECT")?.status, "failed");
  assert.equal(lastProgress.find((step) => step.state === "DELIVER")?.status, "pending");
  assert.ok(!lastProgress.every((step) => step.status === "success"));
});

test("schema lock rejects a well-shaped run with a forged cross-object reference", async () => {
  const run = await golden();
  const forged = structuredClone(run);
  forged.conclusions[0]!.evidenceIds = ["unknown-evidence-id"];
  assert.throws(() => researchRunSchema.parse(forged), /unknown Evidence/);
});
