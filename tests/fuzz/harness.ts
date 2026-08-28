import { SeededPrng } from "./prng.js";

export interface FuzzSuiteResult {
  name: string;
  seed: number;
  cases: number;
  durationMs: number;
  invariants: string[];
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function suiteSeed(rootSeed: number, name: string) {
  let value = rootSeed >>> 0;
  for (const character of name) value = Math.imul(value ^ character.codePointAt(0)!, 16_777_619) >>> 0;
  return value || 1;
}

export async function runSuite<T>(rootSeed: number, name: string, execute: (rng: SeededPrng) => Promise<{ cases: number; value: T }>, invariants: string[]) {
  const seed = suiteSeed(rootSeed, name);
  const started = performance.now();
  try {
    const output = await execute(new SeededPrng(seed));
    return {
      result: { name, seed, cases: output.cases, durationMs: Math.round(performance.now() - started), invariants } satisfies FuzzSuiteResult,
      value: output.value,
    };
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`FUZZ FAILURE suite=${name} seed=${seed}\n${text}`);
  }
}
