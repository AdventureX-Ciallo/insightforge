import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { PLAN_TOOL_ALLOWLIST, validatePlanSteps, type LlmDraft, type PlanStepDraft } from "./llm.js";

export const GOLDEN_RESEARCH_QUESTION = "中国新能源乘用车渗透率增长是否受到公共充电基础设施约束？";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const manifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  files: z.record(z.string(), sha256),
}).strict();

const cacheMetadataSchema = z.object({
  schemaVersion: z.literal("1.0"),
  researchQuestion: z.string().min(8),
  generatedAt: z.string().datetime(),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptSha256: sha256,
});

const planCacheSchema = cacheMetadataSchema.extend({
  kind: z.literal("PLAN"),
  steps: z.array(z.object({
    objective: z.string().min(8),
    toolName: z.string().min(1),
    expectedOutput: z.string().min(2),
  }).strict()).min(3).max(8),
}).strict();

const synthesisRoleSchema = z.enum([
  "PENETRATION_CONFLICT",
  "CHARGING_GROWTH",
  "ADEQUACY_ESTIMATE",
  "CAUSALITY_GAP",
]);

const synthesisCacheSchema = cacheMetadataSchema.extend({
  kind: z.literal("SYNTHESIS"),
  conclusions: z.array(z.object({
    role: synthesisRoleSchema,
    text: z.string().min(20),
    evidenceIds: z.array(z.string().min(1)),
    assumptionIds: z.array(z.string().min(1)),
    evidenceStatus: z.enum(["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE"]),
    missingEvidence: z.array(z.string().min(1)),
  }).strict()).length(4),
}).strict();

export type CachedSynthesisDraft = z.infer<typeof synthesisCacheSchema>["conclusions"][number];

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readVerifiedCache(fixtureDir: string, fileName: string) {
  const manifestBytes = await readFile(join(fixtureDir, "model-cache-manifest.json"));
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const expected = manifest.files[fileName];
  if (!expected) throw new Error(`Model cache manifest does not authorize ${fileName}`);
  const bytes = await readFile(join(fixtureDir, fileName));
  const outputSha256 = digest(bytes);
  if (outputSha256 !== expected) throw new Error(`Model cache digest mismatch for ${fileName}`);
  return { bytes, outputSha256 };
}

async function verifyPrompt(fixtureDir: string, fileName: string, expectedSha256: string) {
  const promptSha256 = digest(await readFile(join(fixtureDir, fileName)));
  if (promptSha256 !== expectedSha256) throw new Error(`Model prompt digest mismatch for ${fileName}`);
}

function assertQuestion(cacheQuestion: string, requestedQuestion: string) {
  if (cacheQuestion !== requestedQuestion) {
    throw new Error("Cached model output is scoped to the golden research question and cannot answer a modified question");
  }
}

export async function loadCachedModelPlan(fixtureDir: string, researchQuestion: string) {
  const { bytes, outputSha256 } = await readVerifiedCache(fixtureDir, "model-plan-cache.json");
  const cache = planCacheSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  assertQuestion(cache.researchQuestion, researchQuestion);
  await verifyPrompt(fixtureDir, "model-plan-prompt.txt", cache.promptSha256);
  const steps = validatePlanSteps(cache.steps as PlanStepDraft[], PLAN_TOOL_ALLOWLIST);
  if (!steps) throw new Error("Cached model plan failed the deterministic tool-plan contract");
  return {
    steps,
    provenance: {
      provider: cache.provider,
      model: cache.model,
      generatedAt: cache.generatedAt,
      promptSha256: cache.promptSha256,
      outputSha256,
      cacheFile: "model-plan-cache.json",
    },
  };
}

export async function loadCachedModelSynthesis(
  fixtureDir: string,
  researchQuestion: string,
  knownEvidenceIds: string[],
  knownAssumptionIds: string[],
) {
  const { bytes, outputSha256 } = await readVerifiedCache(fixtureDir, "model-synthesis-cache.json");
  const cache = synthesisCacheSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  assertQuestion(cache.researchQuestion, researchQuestion);
  await verifyPrompt(fixtureDir, "model-synthesis-prompt.txt", cache.promptSha256);
  const allowedEvidence = new Set(knownEvidenceIds);
  const allowedAssumptions = new Set(knownAssumptionIds);
  if (new Set(cache.conclusions.map((draft) => draft.role)).size !== cache.conclusions.length) {
    throw new Error("Cached model synthesis contains duplicate semantic roles");
  }
  for (const draft of cache.conclusions) {
    if (draft.evidenceIds.some((id) => !allowedEvidence.has(id))) {
      throw new Error(`Cached model synthesis contains an unknown evidence ID in ${draft.role}`);
    }
    if (draft.assumptionIds.some((id) => !allowedAssumptions.has(id))) {
      throw new Error(`Cached model synthesis contains an unknown assumption ID in ${draft.role}`);
    }
    if (draft.evidenceStatus === "INSUFFICIENT_EVIDENCE" && draft.missingEvidence.length === 0) {
      throw new Error(`Cached insufficient-evidence draft ${draft.role} has no machine-readable gap`);
    }
  }
  return {
    drafts: cache.conclusions,
    provenance: {
      provider: cache.provider,
      model: cache.model,
      generatedAt: cache.generatedAt,
      promptSha256: cache.promptSha256,
      outputSha256,
      cacheFile: "model-synthesis-cache.json",
    },
  };
}

export function toLlmDrafts(drafts: CachedSynthesisDraft[]): LlmDraft[] {
  return drafts.map((draft) => ({
    text: draft.text,
    evidenceIds: draft.evidenceIds,
    assumptions: draft.assumptionIds,
    missingEvidence: draft.missingEvidence,
  }));
}
