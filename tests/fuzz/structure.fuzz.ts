import { researchRunSchema, type ResearchRun } from "../../src/domain.js";
import { invariant } from "./harness.js";
import type { SeededPrng } from "./prng.js";

function randomJson(rng: SeededPrng, depth: number): unknown {
  const primitives: unknown[] = [null, rng.bool(), rng.nextUint32(), rng.token(), `\u0000${rng.token()}`];
  if (depth === 0 || rng.int(4) === 0) return rng.pick(primitives);
  if (rng.bool()) return Array.from({ length: rng.int(3) }, () => randomJson(rng, depth - 1));
  return {
    [rng.pick(["value", "__proto__", "constructor", "researchQuestion", "terminalStatus"])]: randomJson(rng, depth - 1),
    child: randomJson(rng, depth - 1),
  };
}

type GraphMutation = {
  label: string;
  apply(run: ResearchRun): void;
};

const graphMutations: readonly GraphMutation[] = [
  { label: "source.sourceVersionId -> missing", apply: (run) => { run.sources[0]!.sourceVersionId = "missing-source-version"; } },
  { label: "sourceVersion.sourceId -> missing", apply: (run) => { run.sourceVersions[0]!.sourceId = "missing-source"; } },
  { label: "sourceVersion current flag removed", apply: (run) => { run.sourceVersions.find((item) => item.sourceId === run.sources[0]!.id)!.isCurrent = false; } },
  { label: "evidence.sourceId -> missing", apply: (run) => { run.evidence[0]!.sourceId = "missing-source"; } },
  { label: "evidence.datumIds -> missing", apply: (run) => { run.evidence[0]!.datumIds.push("missing-datum"); } },
  { label: "datum.evidenceId -> missing", apply: (run) => { run.data[0]!.evidenceId = "missing-evidence"; } },
  { label: "datum.assumptionIds -> missing", apply: (run) => { run.data[0]!.assumptionIds.push("missing-assumption"); } },
  { label: "datum.sourceIds -> missing", apply: (run) => { run.data[0]!.sourceIds.push("missing-source"); } },
  { label: "claim.evidenceIds -> missing", apply: (run) => { run.claims[0]!.evidenceIds.push("missing-evidence"); } },
  { label: "claim.datumIds -> missing", apply: (run) => { run.claims[0]!.datumIds.push("missing-datum"); } },
  { label: "claim.assumptionIds -> missing", apply: (run) => { run.claims[0]!.assumptionIds.push("missing-assumption"); } },
  { label: "evidenceGap.claimId -> missing", apply: (run) => { run.evidenceGaps[0]!.claimId = "missing-claim"; } },
  { label: "conclusion.claimIds -> missing", apply: (run) => { run.conclusions[0]!.claimIds.push("missing-claim"); } },
  { label: "conclusion.currentRevisionId -> missing", apply: (run) => { run.conclusions[0]!.currentRevisionId = "missing-revision"; } },
  { label: "candidateRevision.conclusionId -> missing", apply: (run) => { run.candidateRevisions[0]!.conclusionId = "missing-conclusion"; } },
  { label: "artifactVersion.artifactIds -> missing", apply: (run) => { run.artifactVersions[0]!.artifactIds.push("missing-artifact"); } },
  { label: "duplicate source id", apply: (run) => { run.sources[1]!.id = run.sources[0]!.id; } },
] as const;

export async function runStructureFuzz(rng: SeededPrng, cases: number, baseline: ResearchRun) {
  for (let index = 0; index < cases; index += 1) {
    if (index % 1_500 === 0) {
      const valid = structuredClone(baseline);
      valid.id = `fuzz-valid-${index}-${rng.token()}`;
      valid.researchQuestion = `随机合法研究问题 ${rng.token(32)}`;
      valid.updatedAt = new Date(1_700_000_000_000 + rng.int(1_000_000)).toISOString();
      invariant(researchRunSchema.safeParse(valid).success, `case=${index}: generated legal ResearchRun was rejected`);
      continue;
    }
    if (index % 25 === 1) {
      const mutated = structuredClone(baseline);
      const mutation = rng.pick(graphMutations);
      mutation.apply(mutated);
      invariant(
        !researchRunSchema.safeParse(mutated).success,
        `case=${index}: one-edge valid-graph mutation passed; minimalInput=${JSON.stringify({ mutation: mutation.label })}`,
      );
      continue;
    }
    const malformed = {
      schemaVersion: rng.pick(["1.0", "2.0", 1, null]),
      id: randomJson(rng, rng.int(10)),
      researchQuestion: randomJson(rng, rng.int(10)),
      terminalStatus: rng.pick(["DELIVERED", "NEEDS_REVIEW", "FAILED", "SUCCESS", 1, null]),
      polluted: randomJson(rng, rng.int(12)),
    };
    invariant(!researchRunSchema.safeParse(malformed).success, `case=${index}: malformed/type-polluted ResearchRun passed the schema`);
  }
  return { cases, value: undefined };
}
