import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { resolveLlmConfig, type LlmConfig } from "./llm.js";

const storedSettingsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  llm: z.object({
    baseUrl: z.string().min(1),
    model: z.string().min(1),
    apiKey: z.string().min(8),
    updatedAt: z.string().datetime(),
  }).strict(),
}).strict();

export class SettingsStoreError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function normalizedConfig(input: Record<string, unknown>): LlmConfig {
  const rawBaseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/u, "") : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!rawBaseUrl || !model || model.length > 200 || apiKey.length < 8 || apiKey.length > 8192 || /[\r\n]/u.test(apiKey)) {
    throw new SettingsStoreError(400, "baseUrl, model, and apiKey are required and must be valid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawBaseUrl);
  } catch {
    throw new SettingsStoreError(400, "LLM baseUrl must be a valid HTTPS URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !endpoint.hostname) {
    throw new SettingsStoreError(400, "LLM baseUrl must use HTTPS without embedded credentials");
  }
  return { baseUrl: rawBaseUrl, model, apiKey };
}

export function maskApiKey(apiKey: string) {
  return `••••${apiKey.slice(-4)}`;
}

function maskSetting(value: string) {
  return value.length < 3 ? "••••" : `${value[0]}••••${value.at(-1)}`;
}

function maskBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${maskSetting(url.hostname)}`;
}

export async function loadApiLlmSettings(workspaceDir: string): Promise<LlmConfig | null> {
  const path = join(resolve(workspaceDir), "settings.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SettingsStoreError(500, "LLM settings could not be read");
  }
  try {
    const stored = storedSettingsSchema.parse(JSON.parse(raw) as unknown);
    return normalizedConfig(stored.llm);
  } catch (error) {
    if (error instanceof SettingsStoreError) throw new SettingsStoreError(500, "Stored LLM settings are invalid");
    throw new SettingsStoreError(500, "Stored LLM settings are invalid");
  }
}

export async function saveApiLlmSettings(workspaceDir: string, input: Record<string, unknown>): Promise<LlmConfig> {
  const config = normalizedConfig(input);
  const root = resolve(workspaceDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "settings.json");
  const temporaryPath = join(root, `.settings-${randomUUID()}.tmp`);
  const value = { schemaVersion: "1.0", llm: { ...config, updatedAt: new Date().toISOString() } };
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return config;
}

export function publicLlmSettings(apiConfig: LlmConfig | null, env: NodeJS.ProcessEnv = process.env) {
  const envConfig = resolveLlmConfig(env);
  const effective = apiConfig ?? envConfig;
  return effective
    ? { configured: true, source: apiConfig ? "api" : "environment", baseUrlMasked: maskBaseUrl(effective.baseUrl), modelMasked: maskSetting(effective.model), apiKeyMasked: maskApiKey(effective.apiKey) }
    : { configured: false, source: "none", baseUrlMasked: null, modelMasked: null, apiKeyMasked: null };
}
