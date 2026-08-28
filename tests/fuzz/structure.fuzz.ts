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
