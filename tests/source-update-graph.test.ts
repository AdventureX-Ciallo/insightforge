import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applySourceUpdate, computeResearchSnapshotId, researchRunSchema, runGoldenCase, scoreSourceConfidence, type ResearchRun } from "../src/index.js";
import { hashValue } from "../src/hash.js";
import { DomainError } from "../src/domain-error.js";

const GOLDEN_QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

function installLiveModelStub() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = body.messages.some((message) => message.content.startsWith("BEGIN_UNTRUSTED_PLAN_JSON"))
      ? JSON.stringify({ steps: [
        { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
        { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
        { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
      ] })
      : JSON.stringify({ conclusions: [
        {
          text: "模型候选：market 表中的 charger growth 字段在来源更新后应重新审查。",
          evidenceIds: ["evidence-market-csv"],
          assumptions: [],
          missingEvidence: [],
        },
        {
          text: "模型候选：该结构化市场表可以辅助判断，但仍缺少区域交叉验证。",
          evidenceIds: ["evidence-market-csv"],
          assumptions: [],
          missingEvidence: ["区域口径的交叉验证"],
        },
        {
          text: "模型候选：公共充电点同比增长 31.3%，但该增速不能代表实际利用率。",
          evidenceIds: ["evidence-market-csv", "evidence-source-web-charging"],
          assumptions: [],
          missingEvidence: [],
        },
        {
          text: "模型候选：盈利能力仍缺少运营商收入、成本和利用率数据。",
          evidenceIds: ["evidence-pdf-page-2"],
          assumptions: [],
          missingEvidence: ["运营商收入与成本数据"],
        },
      ] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

function renameGraphIds(run: ResearchRun, replacements: Readonly<Record<string, string>>) {
  let serialized = JSON.stringify(run);
  for (const [from, to] of Object.entries(replacements)) {
    serialized = serialized.replaceAll(JSON.stringify(from), JSON.stringify(to));
  }
  const renamed = JSON.parse(serialized) as ResearchRun;
  const synthesizeIndex = renamed.steps.findIndex((step) => step.state === "SYNTHESIZE");
  renamed.steps[synthesizeIndex]!.outputId = hashValue(renamed.synthesisOutput);
  renamed.steps[synthesizeIndex + 1]!.consumedOutputIds = [renamed.steps[synthesizeIndex]!.outputId];
  renamed.researchSnapshotId = computeResearchSnapshotId(renamed);
  const currentArtifactVersion = renamed.artifactVersions.find((item) => item.status === "CURRENT");
  if (currentArtifactVersion) currentArtifactVersion.researchSnapshotId = renamed.researchSnapshotId;
  return researchRunSchema.parse(renamed);
}

function refreshSnapshot(run: ResearchRun) {
  run.researchSnapshotId = computeResearchSnapshotId(run);
  run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
  return researchRunSchema.parse(run);
}

test("live source update preserves each conclusion's evidence semantics and only invalidates changed dependencies", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-graph-"));
  const restoreFetch = installLiveModelStub();
  let run;
  try {
    run = await runGoldenCase({
      researchQuestion: GOLDEN_QUESTION,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir,
      llmMode: "auto",
      llmConfig: { baseUrl: "https://model.example.invalid/v1", model: "fixture-model", apiKey: "fixture-key" },
    });
  } finally {
    restoreFetch();
  }

  const supported = run.conclusions.find((item) => item.originalAiText.includes("来源更新后"));
  const insufficient = run.conclusions.find((item) => item.originalAiText.includes("区域交叉验证"));
  const charging = run.conclusions.find((item) => item.originalAiText.includes("实际利用率"));
  const profitability = run.conclusions.find((item) => item.originalAiText.includes("盈利能力"));
  assert.ok(supported && insufficient && charging && profitability);
  assert.equal(supported.normalizedEvidenceStatus, "SUPPORTED");
  assert.equal(insufficient.normalizedEvidenceStatus, "INSUFFICIENT_EVIDENCE");
  assert.ok(insufficient.evidenceGapIds.length > 0);

  const unaffectedBefore = new Map([charging, profitability].map((item) => [item.id, structuredClone(item)]));
  const updated = await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir });
  const supportedAfter = updated.conclusions.find((item) => item.id === supported.id)!;
  const insufficientAfter = updated.conclusions.find((item) => item.id === insufficient.id)!;

  assert.equal(supportedAfter.evidenceStatus, "STALE");
  assert.equal(supportedAfter.normalizedEvidenceStatus, "SUPPORTED", "freshness invalidation must not invent a source conflict");
  assert.equal(insufficientAfter.evidenceStatus, "STALE");
  assert.equal(insufficientAfter.normalizedEvidenceStatus, "INSUFFICIENT_EVIDENCE", "a source update must not erase an existing evidence gap");
  assert.deepEqual(insufficientAfter.evidenceGapIds, insufficient.evidenceGapIds);

  for (const conclusion of [supportedAfter, insufficientAfter]) {
    const claim = updated.claims.find((item) => conclusion.claimIds.includes(item.id))!;
    assert.doesNotMatch(claim.text, /47\.6/u, "updated text may only mention facts present in that claim's evidence path");
    assert.ok(updated.affectedObjectIds.includes(claim.id));
    assert.ok(updated.affectedObjectIds.includes(conclusion.id));
  }

  for (const [id, before] of unaffectedBefore) {
    const after = updated.conclusions.find((item) => item.id === id)!;
    assert.deepEqual(after, before, `unrelated conclusion ${id} must remain byte-for-byte unchanged`);
    assert.equal(updated.affectedObjectIds.includes(id), false);
  }
});

test("source update follows a fully renamed valid dependency graph without reintroducing fixture IDs", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-renamed-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const renamed = renameGraphIds(run, {
    "source-market-csv": "source-random-market",
    "source-web-association": "source-random-association",
    "source-web-charging": "source-random-charging",
    "source-version-market-csv-v1": "source-version-random-v1",
    "evidence-market-csv": "evidence-random-market",
    "datum-penetration": "datum-random-penetration",
    "claim-penetration": "claim-random-penetration",
    "conclusion-penetration": "conclusion-random-penetration",
    "revision-penetration": "revision-random-penetration",
  });

  const updated = await applySourceUpdate(renamed, { fixtureDir: resolve("fixtures/golden"), workspaceDir });
  const v2 = updated.sourceVersions.find((item) => item.sourceId === "source-random-market" && item.version === "v2");
  assert.ok(v2);
  assert.deepEqual(v2.upstreamSourceIds, ["source-random-association", "source-random-charging"]);
  assert.ok(updated.affectedObjectIds.includes("datum-random-penetration"));
  assert.ok(updated.affectedObjectIds.includes("claim-random-penetration"));
  assert.ok(updated.affectedObjectIds.includes("conclusion-random-penetration"));
  researchRunSchema.parse(updated);
});

test("source update rejects a forged revision-owner graph before writing a partial artifact version", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-preflight-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const penetrationDatum = run.data.find((item) => item.formula === "nev_sales_million / total_auto_sales_million * 100")!;
  const affectedClaim = run.claims.find((item) => item.datumIds.includes(penetrationDatum.id))!;
  const affected = run.conclusions.find((item) => item.claimIds.includes(affectedClaim.id))!;
  const unrelated = run.conclusions.find((item) => item.id !== affected.id)!;
  affected.currentRevisionId = unrelated.currentRevisionId;
  run.researchSnapshotId = computeResearchSnapshotId(run);
  run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;

  let observed: unknown;
  try {
    await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir });
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof DomainError);
  assert.equal(observed.statusCode, 422);
  await assert.rejects(access(join(workspaceDir, run.id, "artifacts", "v2")));
});

test("source update avoids existing version IDs and leaves unrelated confidence metadata byte-stable", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-collision-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const target = run.sources.find((item) => item.locator.fileName === "market_v1.csv")!;
  const unrelatedVersion = run.sourceVersions.find((item) => item.sourceId !== target.id)!;
  const reservedV2Id = `source-version-${target.id}-v2`;
  run.sourceVersions.push({ ...structuredClone(unrelatedVersion), id: reservedV2Id, version: "snapshot", isCurrent: false });
  target.locator.url = "https://unclassified.example.test/market-v1";
  target.confidence = scoreSourceConfidence(target);
  const penetrationDatum = run.data.find((item) => item.formula === "nev_sales_million / total_auto_sales_million * 100")!;
  const penetrationClaim = run.claims.find((item) => item.datumIds.includes(penetrationDatum.id))!;
  const unrelatedConclusion = run.conclusions.find((item) => item.sourceIds.includes(target.id) && !item.claimIds.includes(penetrationClaim.id))!;
  const unrelatedBefore = structuredClone(unrelatedConclusion);
  run.researchSnapshotId = computeResearchSnapshotId(run);
  run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
  researchRunSchema.parse(run);

  const updated = await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir });
  const currentV2 = updated.sourceVersions.find((item) => item.sourceId === target.id && item.version === "v2" && item.isCurrent);
  assert.ok(currentV2);
  assert.notEqual(currentV2.id, reservedV2Id);
  assert.deepEqual(updated.conclusions.find((item) => item.id === unrelatedConclusion.id), unrelatedBefore);
});

test("source update rejects every schema-valid golden graph without an applicable target dependency", async () => {
  const baseline = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: await mkdtemp(join(tmpdir(), "insightforge-source-update-inapplicable-base-")),
  });
  const marketSource = baseline.sources.find((item) => item.locator.fileName === "market_v1.csv")!;
  const marketEvidenceIds = new Set(baseline.evidence.filter((item) => item.sourceId === marketSource.id).map((item) => item.id));
  const penetrationDatum = baseline.data.find((item) => marketEvidenceIds.has(item.evidenceId)
    && item.formula === "nev_sales_million / total_auto_sales_million * 100"
    && item.period === "2024")!;
  const penetrationClaimIds = new Set(baseline.claims.filter((item) => item.datumIds.includes(penetrationDatum.id)).map((item) => item.id));
  const fallbackSource = baseline.sources.find((item) => item.id !== marketSource.id)!;
  const fallbackClaim = baseline.claims.find((item) => !penetrationClaimIds.has(item.id))!;

  const cases: Array<[string, (run: ResearchRun) => void]> = [
    ["target source", (run) => { run.sources.find((item) => item.id === marketSource.id)!.locator.fileName = "renamed-market.csv"; }],
    ["linked evidence", (run) => {
      for (const evidence of run.evidence.filter((item) => item.sourceId === marketSource.id)) evidence.sourceId = fallbackSource.id;
    }],
    ["penetration datum", (run) => { run.data.find((item) => item.id === penetrationDatum.id)!.formula = "different_formula"; }],
    ["affected claim", (run) => {
      for (const claim of run.claims) {
        claim.datumIds = claim.datumIds.filter((id) => id !== penetrationDatum.id);
        claim.evidenceIds = claim.evidenceIds.filter((id) => !marketEvidenceIds.has(id));
      }
    }],
    ["affected conclusion", (run) => {
      for (const conclusion of run.conclusions) {
        conclusion.claimIds = conclusion.claimIds.filter((id) => !penetrationClaimIds.has(id));
        if (conclusion.claimIds.length === 0) conclusion.claimIds = [fallbackClaim.id];
      }
    }],
  ];

  for (const [label, mutate] of cases) {
    const run = structuredClone(baseline);
    mutate(run);
    refreshSnapshot(run);
    const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-inapplicable-"));
    await assert.rejects(
      applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir }),
      (error: unknown) => error instanceof DomainError
        && error.statusCode === 422
        && error.code === "SOURCE_UPDATE_NOT_APPLICABLE",
      label,
    );
  }
});

test("source update rejects an ambiguous semantic target before creating v2 artifacts", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-ambiguous-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const penetrationDatum = run.data.find((item) => item.formula === "nev_sales_million / total_auto_sales_million * 100" && item.period === "2024")!;
  run.data.push({ ...structuredClone(penetrationDatum), id: "datum-ambiguous-penetration" });
  refreshSnapshot(run);

  await assert.rejects(
    applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir }),
    (error: unknown) => error instanceof DomainError
      && error.statusCode === 422
      && error.code === "SOURCE_UPDATE_GRAPH_INVALID",
  );
  await assert.rejects(access(join(workspaceDir, run.id, "artifacts", "v2")));
});

test("source update rejects two complete applicable source roots before creating v2 artifacts", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-source-update-two-roots-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
  });
  const source = run.sources.find((item) => item.locator.fileName === "market_v1.csv")!;
  const version = run.sourceVersions.find((item) => item.id === source.sourceVersionId)!;
  const evidence = run.evidence.find((item) => item.sourceId === source.id)!;
  const datum = run.data.find((item) => item.evidenceId === evidence.id && item.formula === "nev_sales_million / total_auto_sales_million * 100")!;
  const claim = run.claims.find((item) => item.datumIds.includes(datum.id))!;
  const conclusion = run.conclusions.find((item) => item.claimIds.includes(claim.id))!;
  const revision = run.candidateRevisions.find((item) => item.id === conclusion.currentRevisionId)!;
  const ids = {
    source: "source-second-market",
    version: "source-version-second-market-v1",
    evidence: "evidence-second-market",
    datum: "datum-second-penetration",
    claim: "claim-second-penetration",
    conclusion: "conclusion-second-penetration",
    revision: "revision-second-penetration",
  };
  run.sources.push({ ...structuredClone(source), id: ids.source, sourceVersionId: ids.version });
  run.sourceVersions.push({ ...structuredClone(version), id: ids.version, sourceId: ids.source });
  run.evidence.push({ ...structuredClone(evidence), id: ids.evidence, sourceId: ids.source, datumIds: [ids.datum] });
  run.data.push({ ...structuredClone(datum), id: ids.datum, evidenceId: ids.evidence, sourceIds: [ids.source] });
  run.claims.push({ ...structuredClone(claim), id: ids.claim, evidenceIds: [ids.evidence], datumIds: [ids.datum] });
  run.conclusions.push({
    ...structuredClone(conclusion),
    id: ids.conclusion,
    claimIds: [ids.claim],
    evidenceIds: [ids.evidence],
    sourceIds: [ids.source],
    currentRevisionId: ids.revision,
    confidenceDiscounts: [],
  });
  run.candidateRevisions.push({ ...structuredClone(revision), id: ids.revision, conclusionId: ids.conclusion, parentRevisionId: null });
  refreshSnapshot(run);

  await assert.rejects(
    applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir }),
    (error: unknown) => error instanceof DomainError
      && error.statusCode === 422
      && error.code === "SOURCE_UPDATE_GRAPH_INVALID",
  );
  await assert.rejects(access(join(workspaceDir, run.id, "artifacts", "v2")));
});
