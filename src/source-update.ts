import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { evidencePackageSchema, type ArtifactRecord, type ResearchRun } from "./domain.js";
import { hashFile, hashValue } from "./hash.js";
import { calculateMarketMetrics } from "./tools/csv-calculator.js";
import { writePptx } from "./tools/pptx-export.js";

export interface SourceUpdateOptions {
  fixtureDir: string;
  workspaceDir: string;
}

function assertInsideWorkspace(path: string, workspaceDir: string) {
  const resolvedWorkspace = resolve(workspaceDir);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedWorkspace, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact path is outside the allowed workspace");
}

async function refreshArtifact(path: string, kind: ArtifactRecord["kind"]): Promise<ArtifactRecord> {
  const digest = await hashFile(path);
  const info = await stat(path);
  return { id: hashValue({ fileName: basename(path), digest }), kind, path, sha256: digest, sizeBytes: info.size };
}

function evidencePackage(run: ResearchRun) {
  return evidencePackageSchema.parse({
    schemaVersion: run.schemaVersion,
    researchQuestion: run.researchQuestion,
    synthesisMode: run.synthesisMode,
    sources: run.sources,
    evidence: run.evidence,
    data: run.data,
    claims: run.claims,
    conclusions: run.conclusions,
    auditFindings: run.auditFindings,
    humanDecisions: run.humanDecisions,
    artifacts: run.artifacts.map((item) => ({ kind: item.kind, fileName: basename(item.path) })),
  });
}

export async function applySourceUpdate(current: ResearchRun, options: SourceUpdateOptions): Promise<ResearchRun> {
  if (current.sourceVersion !== "v1") throw new Error("The golden source update can only be applied once");
  const run = structuredClone(current);
  const csvPath = resolve(options.fixtureDir, "market_v2.csv");
  const metrics = await calculateMarketMetrics(csvPath);
  const now = new Date().toISOString();

  const source = run.sources.find((item) => item.id === "source-market-csv");
  const evidence = run.evidence.find((item) => item.id === "evidence-market-csv");
  const datum = run.data.find((item) => item.id === "datum-penetration");
  const claim = run.claims.find((item) => item.id === "claim-penetration");
  const conclusion = run.conclusions.find((item) => item.id === "conclusion-penetration");
  if (!source || !evidence || !datum || !claim || !conclusion) throw new Error("Source dependency chain is incomplete");

  source.version = "v2";
  source.title = "Official NEV/charging structured extract — 2024 final";
  source.locator.fileName = "market_v2.csv";
  source.locator.url = "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html";
  source.excerpt = await readFile(csvPath, "utf8");
  source.capturedAt = now;
  evidence.locator.fileName = "market_v2.csv";
  evidence.locator.url = "https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html";
  evidence.locator.columns = ["nev_sales_million", "total_auto_sales_million", "public_chargers_million"];
  evidence.excerpt = `2024 penetration = ${metrics.penetration.toFixed(4)}%; charger growth = ${metrics.chargerGrowth.toFixed(4)}%`;
  datum.value = metrics.penetration;
  datum.inputs = [
    { label: "新能源汽车最终销量", value: 12.866, unit: "百万辆" },
    { label: "汽车最终总销量", value: 31.436, unit: "百万辆" },
  ];
  claim.text = `来源 v2 将 2024 渗透率重算为 ${metrics.penetration.toFixed(1)}%；原判断需要重新审查。`;
  claim.evidenceStatus = "STALE";
  conclusion.evidenceStatus = "STALE";
  conclusion.reviewStatus = "NEEDS_REVIEW";

  if (conclusion.type === "HUMAN_CONFIRMED" || conclusion.confirmedAt) {
    run.humanDecisions.push({
      id: hashValue({ conclusionId: conclusion.id, now, action: "REVOKE_ON_SOURCE_UPDATE" }),
      conclusionId: conclusion.id,
      action: "REVOKE_ON_SOURCE_UPDATE",
      decidedAt: now,
      previousText: conclusion.confirmedText ?? conclusion.text,
      resultingText: conclusion.text,
    });
  }
  conclusion.type = "AI_JUDGMENT";
  conclusion.confirmedAt = null;
  conclusion.confirmedText = null;
  run.sourceVersion = "v2";
  run.terminalStatus = "NEEDS_REVIEW";
  run.affectedObjectIds = ["source-market-csv", "evidence-market-csv", "datum-penetration", "claim-penetration", "conclusion-penetration"];
  run.updatedAt = now;

  const pptx = run.artifacts.find((item) => item.kind === "PPTX");
  const evidenceJson = run.artifacts.find((item) => item.kind === "EVIDENCE_JSON");
  if (!pptx || !evidenceJson) throw new Error("Run does not contain required export artifacts");
  assertInsideWorkspace(pptx.path, options.workspaceDir);
  assertInsideWorkspace(evidenceJson.path, options.workspaceDir);
  await writePptx(run, pptx.path);
  await writeFile(evidenceJson.path, `${JSON.stringify(evidencePackage(run), null, 2)}\n`, "utf8");
  run.artifacts = [await refreshArtifact(pptx.path, "PPTX"), await refreshArtifact(evidenceJson.path, "EVIDENCE_JSON")];
  await writeFile(resolve(dirname(dirname(pptx.path)), "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return run;
}
