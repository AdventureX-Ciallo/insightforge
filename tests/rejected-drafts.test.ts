import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MAX_REJECTED_DRAFTS,
  MAX_REJECTED_DRAFT_EVIDENCE_ID_LENGTH,
  MAX_REJECTED_DRAFT_EVIDENCE_IDS,
  MAX_REJECTED_DRAFT_TEXT_LENGTH,
  researchRunSchema,
} from "../src/domain.js";
import { runGoldenCase } from "../src/index.js";
import { persistRun } from "../src/artifacts.js";
import { hashValue } from "../src/hash.js";
import { computeResearchSnapshotId } from "../src/domain.js";
import { triageLlmDrafts, type LlmDraft } from "../src/llm.js";
import { createInsightForgeServer } from "../src/server.js";

const GOLDEN_QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

test("a successful live run persists rejected draft decisions in its immutable synthesis trace and evidence package", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-rejected-drafts-"));
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const isPlan = body.messages.some((message) => message.content.startsWith("BEGIN_UNTRUSTED_PLAN_JSON"));
    const content = isPlan
      ? JSON.stringify({ steps: [
          { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
          { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
          { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
        ] })
      : JSON.stringify({ conclusions: [
          { text: "短", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] },
          { text: "该候选没有提供任何证据引用。", evidenceIds: [], assumptions: [], missingEvidence: [] },
          { text: "该候选引用模型编造的证据标识。", evidenceIds: ["evidence-invented"], assumptions: [], missingEvidence: [] },
          ...Array.from({ length: 6 }, (_, index) => ({
            text: `第 ${index + 1} 条证据约束候选判断，必须由人复核后确认。`,
            evidenceIds: ["evidence-market-csv"],
            assumptions: [],
            missingEvidence: [],
          })),
        ] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const run = await runGoldenCase({
      researchQuestion: GOLDEN_QUESTION,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir,
      llmMode: "auto",
      llmConfig: { baseUrl: "https://model.example.invalid/v1", model: "fixture-model", apiKey: "fixture-only" },
    });
    assert.equal(run.conclusions.length, 5);
    assert.deepEqual(run.rejectedDrafts.map((item) => item.dropReason), [
      "TEXT_TOO_SHORT",
      "NO_EVIDENCE",
      "UNKNOWN_EVIDENCE_ID",
      "OVER_LIMIT",
    ]);
    assert.ok(run.rejectedDrafts.every((item) => /^\d{4}-\d{2}-\d{2}T/u.test(item.droppedAt)));
    assert.deepEqual(run.synthesisOutput.rejectedDrafts, run.rejectedDrafts);
    const acceptedGraph = JSON.stringify({
      claims: run.claims,
      conclusions: run.conclusions,
      candidateRevisions: run.candidateRevisions,
      auditFindings: run.auditFindings,
    });
    for (const rejected of run.rejectedDrafts) assert.equal(acceptedGraph.includes(rejected.text), false);
    assert.equal(acceptedGraph.includes("evidence-invented"), false);

    const persisted = JSON.parse(await readFile(join(workspaceDir, run.id, "run.json"), "utf8")) as { rejectedDrafts: unknown[] };
    assert.deepEqual(persisted.rejectedDrafts, run.rejectedDrafts);
    const evidenceArtifact = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON")!;
    const evidencePackage = JSON.parse(await readFile(evidenceArtifact.path, "utf8")) as { rejectedDrafts: unknown[] };
    assert.deepEqual(evidencePackage.rejectedDrafts, run.rejectedDrafts);

    globalThis.fetch = originalFetch;
    const app = createInsightForgeServer({
      fixtureDir: resolve("fixtures/golden"),
      publicDir: resolve("public"),
      workspaceDir,
      stepDelayMs: 0,
    });
    const baseUrl = await app.start(0, "127.0.0.1");
    try {
      const current = await (await fetch(`${baseUrl}/api/current`)).json() as { run: typeof run };
      const byId = await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json() as { run: typeof run };
      const versions = await (await fetch(`${baseUrl}/api/runs/${run.id}/artifact-versions`)).json() as Array<{
        rejectedDrafts: unknown[];
        rejectedDraftOverflowCount: number;
      }>;
      assert.deepEqual(current.run.rejectedDrafts, run.rejectedDrafts);
      assert.deepEqual(byId.run.rejectedDrafts, run.rejectedDrafts);
      assert.deepEqual(versions[0]!.rejectedDrafts, run.rejectedDrafts);
      assert.equal(versions[0]!.rejectedDraftOverflowCount, 0);

      const decision = await fetch(`${baseUrl}/api/runs/${run.id}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conclusionId: run.conclusions[0]!.id, action: "REJECT", reason: "验证被否决草稿留痕不会被人工决定改写" }),
      });
      assert.equal(decision.status, 200);
      const decided = await decision.json() as { run: typeof run };
      assert.deepEqual(decided.run.rejectedDrafts, run.rejectedDrafts);

      const update = await fetch(`${baseUrl}/api/runs/${run.id}/source-update`, { method: "POST" });
      assert.equal(update.status, 200);
      const updated = await update.json() as { run: typeof run };
      assert.deepEqual(updated.run.rejectedDrafts, run.rejectedDrafts);

      const updatedVersions = await (await fetch(`${baseUrl}/api/runs/${run.id}/artifact-versions`)).json() as Array<{
        version: number;
        rejectedDrafts: unknown[];
        rejectedDraftOverflowCount: number;
      }>;
      assert.ok(updatedVersions.every((version) => JSON.stringify(version.rejectedDrafts) === JSON.stringify(run.rejectedDrafts)));
      for (const version of updatedVersions) {
        const artifact = await fetch(`${baseUrl}/api/runs/${run.id}/artifacts/EVIDENCE_JSON?version=${version.version}`);
        assert.equal(artifact.status, 200);
        const versionPackage = await artifact.json() as { rejectedDrafts: unknown[] };
        assert.deepEqual(versionPackage.rejectedDrafts, run.rejectedDrafts);
      }
    } finally {
      await app.stop();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cached synthesis exposes an explicit empty rejected-draft trace in every durable surface", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-cached-rejected-drafts-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    llmMode: "cached",
  });

  assert.deepEqual(run.rejectedDrafts, []);
  assert.equal(run.rejectedDraftOverflowCount, 0);
  assert.deepEqual(run.synthesisOutput.rejectedDrafts, []);
  assert.equal(run.synthesisOutput.rejectedDraftOverflowCount, 0);
  assert.deepEqual(run.artifactVersions[0]!.rejectedDrafts, []);
  assert.equal(run.artifactVersions[0]!.rejectedDraftOverflowCount, 0);
  const persisted = JSON.parse(await readFile(join(workspaceDir, run.id, "run.json"), "utf8")) as typeof run;
  assert.deepEqual(persisted.rejectedDrafts, []);
  const evidenceArtifact = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON")!;
  const evidencePackage = JSON.parse(await readFile(evidenceArtifact.path, "utf8")) as typeof run;
  assert.deepEqual(evidencePackage.rejectedDrafts, []);
  assert.equal(evidencePackage.rejectedDraftOverflowCount, 0);
});

test("rejected-draft retention is bounded while exact overflow and stable digests remain auditable", () => {
  const hostileDrafts: LlmDraft[] = Array.from({ length: MAX_REJECTED_DRAFTS + 50 }, (_, index) => ({
    text: `${index}-`.padEnd(MAX_REJECTED_DRAFT_TEXT_LENGTH + 2_000, "拒"),
    evidenceIds: Array.from({ length: MAX_REJECTED_DRAFT_EVIDENCE_IDS + 30 }, (__, evidenceIndex) => `${index}-${evidenceIndex}-`.padEnd(MAX_REJECTED_DRAFT_EVIDENCE_ID_LENGTH + 2_000, "证")),
    assumptions: [],
    missingEvidence: [],
  }));
  const result = triageLlmDrafts(hostileDrafts, [], "2026-08-29T01:02:03.000Z");

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, MAX_REJECTED_DRAFTS);
  assert.equal(result.rejectedOverflowCount, 50);
  assert.ok(result.rejected.every((item) => item.text.length <= MAX_REJECTED_DRAFT_TEXT_LENGTH));
  assert.ok(result.rejected.every((item) => item.evidenceIds.length <= MAX_REJECTED_DRAFT_EVIDENCE_IDS));
  assert.ok(result.rejected.every((item) => item.evidenceIds.every((id) => id.length <= MAX_REJECTED_DRAFT_EVIDENCE_ID_LENGTH)));
  assert.ok(result.rejected.every((item) => item.textTruncated && item.evidenceIdsTruncated));
  assert.ok(result.rejected.every((item) => /^[a-f0-9]{64}$/u.test(item.draftSha256)));

  const reordered = {
    missingEvidence: hostileDrafts[0]!.missingEvidence,
    assumptions: hostileDrafts[0]!.assumptions,
    evidenceIds: hostileDrafts[0]!.evidenceIds,
    text: hostileDrafts[0]!.text,
  };
  const reorderedResult = triageLlmDrafts([reordered], [], "2026-08-29T01:02:03.000Z");
  assert.equal(reorderedResult.rejected[0]!.draftSha256, result.rejected[0]!.draftSha256);
});

test("persisted runs created before rejected-draft fields existed recover without changing legacy hashes", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-legacy-rejected-drafts-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    llmMode: "cached",
  });
  const legacy = JSON.parse(await readFile(join(workspaceDir, run.id, "run.json"), "utf8")) as Record<string, any>;
  delete legacy.rejectedDrafts;
  delete legacy.rejectedDraftOverflowCount;
  delete legacy.synthesisOutput.rejectedDrafts;
  delete legacy.synthesisOutput.rejectedDraftOverflowCount;
  for (const version of legacy.artifactVersions as Array<Record<string, unknown>>) {
    delete version.rejectedDrafts;
    delete version.rejectedDraftOverflowCount;
  }
  const synthesize = (legacy.steps as Array<Record<string, any>>).find((step) => step.state === "SYNTHESIZE")!;
  synthesize.outputId = hashValue(legacy.synthesisOutput);
  const audit = (legacy.steps as Array<Record<string, any>>).find((step) => step.state === "AUDIT")!;
  audit.consumedOutputIds = [synthesize.outputId];
  const serializedLegacy = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(join(workspaceDir, run.id, "run.json"), serializedLegacy, "utf8");
  await writeFile(join(workspaceDir, "current.json"), serializedLegacy, "utf8");

  const app = createInsightForgeServer({
    fixtureDir: resolve("fixtures/golden"),
    publicDir: resolve("public"),
    workspaceDir,
    stepDelayMs: 0,
  });
  const baseUrl = await app.start(0, "127.0.0.1");
  try {
    const response = await fetch(`${baseUrl}/api/current`);
    assert.equal(response.status, 200);
    const recovered = await response.json() as { run: typeof run };
    assert.equal(recovered.run.id, run.id);
    assert.deepEqual(recovered.run.rejectedDrafts, []);
    assert.equal(recovered.run.rejectedDraftOverflowCount, 0);
    assert.deepEqual(recovered.run.artifactVersions[0]!.rejectedDrafts, []);
    assert.equal(recovered.run.researchSnapshotId, run.researchSnapshotId);
  } finally {
    await app.stop();
  }
});

test("schema integrity rejects independent tampering of run, synthesis, and artifact-version triage", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-rejected-draft-integrity-"));
  const valid = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir,
    llmMode: "cached",
  });
  const rejected = {
    draftIndex: 0,
    text: "被程序拒绝且不得进入证据图的候选。",
    textTruncated: false,
    evidenceIds: ["evidence-invented"],
    evidenceIdsTruncated: false,
    dropReason: "UNKNOWN_EVIDENCE_ID" as const,
    droppedAt: "2026-08-29T01:02:03.000Z",
    draftSha256: "a".repeat(64),
  };

  const rootOnly = structuredClone(valid);
  rootOnly.rejectedDrafts = [rejected];
  assert.equal(computeResearchSnapshotId(rootOnly), computeResearchSnapshotId(valid), "rejected metadata must not redefine the accepted research graph identity");
  assert.equal(researchRunSchema.safeParse(rootOnly).success, false);

  const synthesisOnly = structuredClone(valid);
  synthesisOnly.synthesisOutput.rejectedDrafts = [rejected];
  assert.equal(researchRunSchema.safeParse(synthesisOnly).success, false);

  const versionOnly = structuredClone(valid);
  versionOnly.artifactVersions[0]!.rejectedDrafts = [rejected];
  assert.equal(researchRunSchema.safeParse(versionOnly).success, false);

});

test("live synthesis records bounded overflow without hiding a successful accepted set", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-rejected-overflow-"));
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const isPlan = body.messages.some((message) => message.content.startsWith("BEGIN_UNTRUSTED_PLAN_JSON"));
    const content = isPlan
      ? JSON.stringify({ steps: [
          { objective: "检索与问题直接相关的公开信源", toolName: "snapshot-search", expectedOutput: "候选信源" },
          { objective: "执行确定性的六类证据审查", toolName: "deterministic-audit", expectedOutput: "审查结果" },
          { objective: "生成版本化的研究交付成果", toolName: "pptx-generator", expectedOutput: "交付文件" },
        ] })
      : JSON.stringify({ conclusions: [
          ...Array.from({ length: MAX_REJECTED_DRAFTS + 1 }, () => ({ text: "短", evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] })),
          ...Array.from({ length: 3 }, (_, index) => ({ text: `第 ${index + 1} 条有效证据候选判断等待人工复核。`, evidenceIds: ["evidence-market-csv"], assumptions: [], missingEvidence: [] })),
        ] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const run = await runGoldenCase({
      researchQuestion: GOLDEN_QUESTION,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir,
      llmMode: "auto",
      llmConfig: { baseUrl: "https://model.example.invalid/v1", model: "fixture-model", apiKey: "fixture-only" },
    });
    assert.equal(run.rejectedDrafts.length, MAX_REJECTED_DRAFTS);
    assert.equal(run.rejectedDraftOverflowCount, 1);
    assert.match(run.steps.find((step) => step.state === "SYNTHESIZE")!.summary, /另有 1 条仅计数/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistRun tolerates a missing artifact directory but fails closed on an invalid artifact path type", async () => {
  const sourceWorkspace = await mkdtemp(join(tmpdir(), "insightforge-persist-source-"));
  const run = await runGoldenCase({
    researchQuestion: GOLDEN_QUESTION,
    fixtureDir: resolve("fixtures/golden"),
    workspaceDir: sourceWorkspace,
    llmMode: "cached",
  });
  const noArtifactsWorkspace = await mkdtemp(join(tmpdir(), "insightforge-persist-no-artifacts-"));
  await persistRun(run, noArtifactsWorkspace, false);
  assert.equal(JSON.parse(await readFile(join(noArtifactsWorkspace, run.id, "run.json"), "utf8")).id, run.id);

  const invalidArtifactsWorkspace = await mkdtemp(join(tmpdir(), "insightforge-persist-invalid-artifacts-"));
  const runDir = join(invalidArtifactsWorkspace, run.id);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "artifacts"), "not a directory", "utf8");
  await assert.rejects(persistRun(run, invalidArtifactsWorkspace, false), /ENOTDIR|not a directory/iu);
});
