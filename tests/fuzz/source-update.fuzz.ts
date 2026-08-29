import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  applyHumanDecision,
  applySourceUpdate,
  computeResearchSnapshotId,
  researchRunSchema,
  runGoldenCase,
  type ResearchRun,
} from "../../src/index.js";
import { DomainError } from "../../src/domain-error.js";
import { hashValue } from "../../src/hash.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

const GOLDEN = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

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

function dynamicRun(baseline: ResearchRun, rng: SeededPrng, index: number) {
  const idFragment = `${index}-${rng.token(18)}`;
  const ids = {
    targetSource: `source-market-${idFragment}`,
    associationSource: `source-association-${idFragment}`,
    chargingSource: `source-charging-${idFragment}`,
    sourceVersion: `source-version-market-${idFragment}`,
    evidence: `evidence-market-${idFragment}`,
    datum: `datum-penetration-${idFragment}`,
    claim: `claim-penetration-${idFragment}`,
    conclusion: `conclusion-penetration-${idFragment}`,
    revision: `revision-penetration-${idFragment}`,
  };
  const run = renameGraphIds(baseline, {
    "source-market-csv": ids.targetSource,
    "source-web-association": ids.associationSource,
    "source-web-charging": ids.chargingSource,
    "source-version-market-csv-v1": ids.sourceVersion,
    "evidence-market-csv": ids.evidence,
    "datum-penetration": ids.datum,
    "claim-penetration": ids.claim,
    "conclusion-penetration": ids.conclusion,
    "revision-penetration": ids.revision,
  });
  return { run, ids };
}

function typedStatus(error: unknown, expected: number) {
  invariant(error instanceof DomainError, `expected DomainError ${expected}, got ${String(error)}`);
  invariant(error.statusCode === expected, `expected status ${expected}, got ${error.statusCode}`);
}

export async function runSourceUpdateFuzz(rng: SeededPrng, cases: number) {
  const workspaceDir = await mkdtemp(join(tmpdir(), "insightforge-fuzz-source-update-"));
  try {
    const baseline = await runGoldenCase({
      researchQuestion: GOLDEN,
      fixtureDir: resolve("fixtures/golden"),
      workspaceDir,
      runId: "fuzz-source-update-baseline",
    });

    for (let index = 0; index < cases; index += 1) {
      const { run: initial, ids } = dynamicRun(baseline, rng, index);
      const caseWorkspaceDir = join(workspaceDir, `case-${index}`);
      let run = initial;
      const scenario = index % 14;
      if (scenario === 1) run.researchQuestion = `非黄金问题-${rng.token(100)}`;
      else if (scenario === 2) run.sourceVersion = "v2";
      else if (scenario === 3) run.sources = run.sources.filter((item) => item.id !== ids.targetSource);
      else if (scenario === 4) run.evidence = run.evidence.filter((item) => item.id !== ids.evidence);
      else if (scenario === 5) run.data = run.data.filter((item) => item.id !== ids.datum);
      else if (scenario === 6) run.sourceVersions = run.sourceVersions.filter((item) => item.id !== ids.sourceVersion);
      else if (scenario === 7) run.candidateRevisions = run.candidateRevisions.filter((item) => item.id !== ids.revision);
      else if (scenario === 9) {
        run = applyHumanDecision(run, {
          conclusionId: ids.conclusion,
          action: "CONFIRM",
          reason: "随机测试确认后验证来源变化撤销",
          scopeNote: "仅限当前黄金案例口径",
        });
      } else if (scenario === 10) {
        run.sourceVersions.find((item) => item.id === ids.sourceVersion)!.version = "snapshot";
        run.researchSnapshotId = computeResearchSnapshotId(run);
        run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
      } else if (scenario === 11) {
        run.candidateRevisions.find((item) => item.id === ids.revision)!.parentRevisionId = ids.revision;
        run.researchSnapshotId = computeResearchSnapshotId(run);
        run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
      } else if (scenario === 12) {
        const datum = run.data.find((item) => item.id === ids.datum)!;
        run.data.push({ ...structuredClone(datum), id: `datum-duplicate-${index}-${rng.token(12)}` });
        run.researchSnapshotId = computeResearchSnapshotId(run);
        run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
      } else if (scenario === 13) {
        const source = run.sources.find((item) => item.id === ids.targetSource)!;
        const version = run.sourceVersions.find((item) => item.id === ids.sourceVersion)!;
        const secondSourceId = `source-second-market-${index}-${rng.token(12)}`;
        const secondVersionId = `source-version-second-market-${index}-${rng.token(12)}`;
        run.sources.push({ ...structuredClone(source), id: secondSourceId, sourceVersionId: secondVersionId });
        run.sourceVersions.push({ ...structuredClone(version), id: secondVersionId, sourceId: secondSourceId });
        run.researchSnapshotId = computeResearchSnapshotId(run);
        run.artifactVersions.find((item) => item.status === "CURRENT")!.researchSnapshotId = run.researchSnapshotId;
      }

      const before = JSON.stringify(run);
      if ((scenario >= 1 && scenario <= 7) || scenario >= 10) {
        let observed: unknown;
        try {
          await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir: caseWorkspaceDir });
        } catch (error) {
          observed = error;
        }
        typedStatus(observed, scenario === 2 ? 409 : 422);
        invariant(JSON.stringify(run) === before, `case=${index}: rejected source update mutated caller state`);
        continue;
      }

      const oldVersion = run.sourceVersions.find((item) => item.id === ids.sourceVersion)!;
      const unaffected = run.conclusions.find((item) => !item.sourceIds.includes(ids.targetSource))!;
      const unaffectedBefore = structuredClone(unaffected);
      const updated = await applySourceUpdate(run, { fixtureDir: resolve("fixtures/golden"), workspaceDir: caseWorkspaceDir });
      const v2 = updated.sourceVersions.find((item) => item.sourceId === ids.targetSource && item.version === "v2");
      invariant(v2, `case=${index}: dynamic target source did not receive v2`);
      invariant(JSON.stringify(v2.upstreamSourceIds) === JSON.stringify(oldVersion.upstreamSourceIds), `case=${index}: upstream provenance changed to fixture IDs`);
      invariant(updated.sourceVersions.find((item) => item.id === ids.sourceVersion)?.isCurrent === false, `case=${index}: v1 remained current`);
      invariant(updated.sourceVersions.filter((item) => item.sourceId === ids.targetSource && item.isCurrent).length === 1, `case=${index}: target source lacks exactly one current version`);
      invariant(updated.affectedObjectIds.includes(ids.datum), `case=${index}: dynamic datum was not marked affected`);
      invariant(updated.affectedObjectIds.includes(ids.claim), `case=${index}: dynamic claim was not marked affected`);
      invariant(updated.affectedObjectIds.includes(ids.conclusion), `case=${index}: dynamic conclusion was not marked affected`);
      invariant(updated.conclusions.find((item) => item.id === ids.conclusion)?.evidenceStatus === "STALE", `case=${index}: affected conclusion did not become stale`);
      invariant(JSON.stringify(updated.conclusions.find((item) => item.id === unaffected.id)) === JSON.stringify(unaffectedBefore), `case=${index}: unrelated conclusion changed`);
      invariant(researchRunSchema.safeParse(updated).success, `case=${index}: updated graph failed schema lock`);

      if (scenario === 9) {
        const confirmation = updated.humanDecisions.find((item) => item.conclusionId === ids.conclusion && item.action === "CONFIRM");
        invariant(Boolean(confirmation?.invalidatedAt), `case=${index}: confirmation was not invalidated`);
        invariant(updated.humanDecisions.some((item) => item.conclusionId === ids.conclusion && item.action === "REVOKE_ON_SOURCE_UPDATE"), `case=${index}: invalidation audit record missing`);
      }
      if (scenario === 8) {
        let observed: unknown;
        try {
          await applySourceUpdate(updated, { fixtureDir: resolve("fixtures/golden"), workspaceDir: caseWorkspaceDir });
        } catch (error) {
          observed = error;
        }
        typedStatus(observed, 409);
      }
    }
    return { cases, value: undefined };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
