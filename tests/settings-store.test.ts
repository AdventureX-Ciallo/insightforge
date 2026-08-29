import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadApiLlmSettings, publicLlmSettings, saveApiLlmSettings, SettingsStoreError } from "../src/settings-store.js";

const valid = { baseUrl: "https://models.example.test/v1/", model: "judge-model", apiKey: "secret-key-1234" };

async function rejectsInput(input: Record<string, unknown>, pattern: RegExp) {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-settings-input-"));
  await assert.rejects(saveApiLlmSettings(directory, input), (error: unknown) => error instanceof SettingsStoreError && error.statusCode === 400 && pattern.test(error.message));
}

test("settings validation rejects absent, malformed, credentialed, or unsafe endpoint configuration", async () => {
  await rejectsInput({ ...valid, baseUrl: 7 }, /required/u);
  await rejectsInput({ ...valid, model: 7 }, /required/u);
  await rejectsInput({ ...valid, apiKey: 7 }, /required/u);
  await rejectsInput({ ...valid, model: "x".repeat(201) }, /required/u);
  await rejectsInput({ ...valid, apiKey: "short" }, /required/u);
  await rejectsInput({ ...valid, apiKey: "x".repeat(8193) }, /required/u);
  await rejectsInput({ ...valid, apiKey: "valid-key\nforged" }, /required/u);
  await rejectsInput({ ...valid, baseUrl: "not a URL" }, /valid HTTPS URL/u);
  await rejectsInput({ ...valid, baseUrl: "http://models.example.test/v1" }, /must use HTTPS/u);
  await rejectsInput({ ...valid, baseUrl: "https://user@models.example.test/v1" }, /embedded credentials/u);
  await rejectsInput({ ...valid, baseUrl: "https://:password@models.example.test/v1" }, /embedded credentials/u);
});

test("API settings persist validated optional PLAN and SYNTHESIZE token budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "insightforge-settings-budgets-"));
  const saved = await saveApiLlmSettings(directory, {
    ...valid,
    planMaxTokens: 4096,
    synthesisMaxTokens: 8192,
  });
  assert.deepEqual(saved, {
    baseUrl: "https://models.example.test/v1",
    model: valid.model,
    apiKey: valid.apiKey,
    planMaxTokens: 4096,
    synthesisMaxTokens: 8192,
  });
  assert.deepEqual(await loadApiLlmSettings(directory), saved);
  assert.deepEqual(publicLlmSettings(saved, Object.create(null) as NodeJS.ProcessEnv), {
    configured: true,
    source: "api",
    baseUrlMasked: "https://m••••t",
    modelMasked: "j••••l",
    apiKeyMasked: "••••1234",
    planMaxTokens: 4096,
    synthesisMaxTokens: 8192,
  });
  await rejectsInput({ ...valid, planMaxTokens: 255 }, /token budgets/u);
  await rejectsInput({ ...valid, synthesisMaxTokens: 32769 }, /token budgets/u);
  await rejectsInput({ ...valid, planMaxTokens: "4096" }, /token budgets/u);
});

test("settings load fails closed for unreadable, malformed, and semantically invalid stored state", async () => {
  const missing = await mkdtemp(join(tmpdir(), "insightforge-settings-missing-"));
  assert.equal(await loadApiLlmSettings(missing), null);

  const unreadable = await mkdtemp(join(tmpdir(), "insightforge-settings-unreadable-"));
  await mkdir(join(unreadable, "settings.json"));
  await assert.rejects(loadApiLlmSettings(unreadable), (error: unknown) => error instanceof SettingsStoreError && error.statusCode === 500 && /could not be read/u.test(error.message));

  const malformed = await mkdtemp(join(tmpdir(), "insightforge-settings-malformed-"));
  await writeFile(join(malformed, "settings.json"), "{bad json", "utf8");
  await assert.rejects(loadApiLlmSettings(malformed), /Stored LLM settings are invalid/u);

  const invalidStored = await mkdtemp(join(tmpdir(), "insightforge-settings-semantic-"));
  await writeFile(join(invalidStored, "settings.json"), JSON.stringify({
    schemaVersion: "1.0",
    llm: { ...valid, baseUrl: "http://models.example.test", updatedAt: new Date().toISOString() },
  }), "utf8");
  await assert.rejects(loadApiLlmSettings(invalidStored), /Stored LLM settings are invalid/u);

  await chmod(malformed, 0o700);
});

test("public settings expose only masks and preserve API over environment priority", () => {
  const emptyEnv = Object.create(null) as NodeJS.ProcessEnv;
  assert.deepEqual(publicLlmSettings(null, emptyEnv), {
    configured: false, source: "none", baseUrlMasked: null, modelMasked: null, apiKeyMasked: null,
  });
  const env = {
    INSIGHTFORGE_LLM_BASE_URL: "https://env.example.test/v1",
    INSIGHTFORGE_LLM_MODEL: "env-model",
    INSIGHTFORGE_LLM_API_KEY: "environment-secret",
  };
  assert.deepEqual(publicLlmSettings(null, env), {
    configured: true,
    source: "environment",
    baseUrlMasked: "https://e••••t",
    modelMasked: "e••••l",
    apiKeyMasked: "••••cret",
    planMaxTokens: 8192,
    synthesisMaxTokens: 16384,
  });
  assert.deepEqual(publicLlmSettings(valid, env), {
    configured: true,
    source: "api",
    baseUrlMasked: "https://m••••t",
    modelMasked: "j••••l",
    apiKeyMasked: "••••1234",
    planMaxTokens: 8192,
    synthesisMaxTokens: 16384,
  });
  assert.deepEqual(publicLlmSettings({ baseUrl: "https://x", model: "xy", apiKey: "12345678" }, emptyEnv), {
    configured: true,
    source: "api",
    baseUrlMasked: "https://••••",
    modelMasked: "••••",
    apiKeyMasked: "••••5678",
    planMaxTokens: 8192,
    synthesisMaxTokens: 16384,
  });
});
