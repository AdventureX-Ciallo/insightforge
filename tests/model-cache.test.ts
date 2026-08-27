import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { GOLDEN_RESEARCH_QUESTION, loadCachedModelPlan, loadCachedModelSynthesis, toLlmDrafts } from "../src/model-cache.js";

const cacheFiles = ["model-cache-manifest.json", "model-plan-cache.json", "model-plan-prompt.txt", "model-synthesis-cache.json", "model-synthesis-prompt.txt"];

async function copiedFixture() {
  const fixtureDir = resolve("fixtures/golden");
  const copied = await mkdtemp(join(tmpdir(), "insightforge-model-cache-"));
  for (const name of cacheFiles) await cp(join(fixtureDir, name), join(copied, name));
  return copied;
}

async function writeAuthorizedJson(directory: string, fileName: string, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(join(directory, fileName), bytes);
  const manifestPath = join(directory, "model-cache-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, string> };
  manifest.files[fileName] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("authenticated model caches are digest-checked and scoped to one exact research question", async () => {
  const fixtureDir = resolve("fixtures/golden");
  const plan = await loadCachedModelPlan(fixtureDir, GOLDEN_RESEARCH_QUESTION);
  assert.ok(plan.steps.length >= 3);
  await assert.rejects(loadCachedModelPlan(fixtureDir, "另一个研究问题，不能复用缓存"), /scoped to the golden research question/i);

  const copied = await copiedFixture();
  const synthesisPath = join(copied, "model-synthesis-cache.json");
  await writeFile(synthesisPath, `${await readFile(synthesisPath, "utf8")} `, "utf8");
  await assert.rejects(
    loadCachedModelSynthesis(copied, GOLDEN_RESEARCH_QUESTION, ["evidence-source-web-association", "evidence-market-csv", "evidence-source-web-charging", "evidence-pdf-page-1", "evidence-pdf-page-2"], ["assumption-utilization-gap"]),
    /digest mismatch/i,
  );
});

test("model cache rejects unauthorized files, prompt changes, and contract-invalid plans", async () => {
  const unauthorized = await copiedFixture();
  const manifestPath = join(unauthorized, "model-cache-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, string> };
  delete manifest.files["model-plan-cache.json"];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await assert.rejects(loadCachedModelPlan(unauthorized, GOLDEN_RESEARCH_QUESTION), /does not authorize/u);

  const promptChanged = await copiedFixture();
  await writeFile(join(promptChanged, "model-plan-prompt.txt"), "changed prompt", "utf8");
  await assert.rejects(loadCachedModelPlan(promptChanged, GOLDEN_RESEARCH_QUESTION), /prompt digest mismatch/u);

  const invalidPlan = await copiedFixture();
  const planPath = join(invalidPlan, "model-plan-cache.json");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as { steps: Array<{ toolName: string }> };
  plan.steps.find((step) => step.toolName === "deterministic-audit")!.toolName = "shell";
  await writeAuthorizedJson(invalidPlan, "model-plan-cache.json", plan);
  await assert.rejects(loadCachedModelPlan(invalidPlan, GOLDEN_RESEARCH_QUESTION), /tool-plan contract/u);
});

test("cached synthesis rejects duplicate roles, unknown graph references, and missing gap metadata", async () => {
  const fixtureDir = resolve("fixtures/golden");
  const knownEvidence = ["evidence-source-web-association", "evidence-market-csv", "evidence-source-web-charging", "evidence-pdf-page-1", "evidence-pdf-page-2"];
  const knownAssumptions = ["assumption-utilization-gap"];
  const valid = await loadCachedModelSynthesis(fixtureDir, GOLDEN_RESEARCH_QUESTION, knownEvidence, knownAssumptions);
  assert.equal(valid.drafts.length, 4);
  assert.deepEqual(toLlmDrafts(valid.drafts)[0], {
    text: valid.drafts[0]!.text,
    evidenceIds: valid.drafts[0]!.evidenceIds,
    assumptions: valid.drafts[0]!.assumptionIds,
    missingEvidence: valid.drafts[0]!.missingEvidence,
  });

  async function rejected(mutator: (cache: { conclusions: Array<{ role: string; evidenceIds: string[]; assumptionIds: string[]; evidenceStatus: string; missingEvidence: string[] }> }) => void, pattern: RegExp) {
    const directory = await copiedFixture();
    const path = join(directory, "model-synthesis-cache.json");
    const cache = JSON.parse(await readFile(path, "utf8")) as { conclusions: Array<{ role: string; evidenceIds: string[]; assumptionIds: string[]; evidenceStatus: string; missingEvidence: string[] }> };
    mutator(cache);
    await writeAuthorizedJson(directory, "model-synthesis-cache.json", cache);
    await assert.rejects(loadCachedModelSynthesis(directory, GOLDEN_RESEARCH_QUESTION, knownEvidence, knownAssumptions), pattern);
  }

  await rejected((cache) => { cache.conclusions[1]!.role = cache.conclusions[0]!.role; }, /duplicate semantic roles/u);
  await rejected((cache) => { cache.conclusions[0]!.evidenceIds.push("evidence-forged"); }, /unknown evidence ID/u);
  await rejected((cache) => { cache.conclusions[0]!.assumptionIds.push("assumption-forged"); }, /unknown assumption ID/u);
  await rejected((cache) => {
    const draft = cache.conclusions.find((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE")!;
    draft.missingEvidence = [];
  }, /no machine-readable gap/u);
});
