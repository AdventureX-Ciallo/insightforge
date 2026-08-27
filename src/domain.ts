import { z } from "zod";

export const workflowStates = ["PLAN", "COLLECT", "SYNTHESIZE", "AUDIT", "DELIVER"] as const;
export const terminalStatuses = ["DELIVERED", "NEEDS_REVIEW", "FAILED"] as const;
export const contentTypes = [
  "FACT",
  "SOURCE_OPINION",
  "CALCULATION",
  "ESTIMATE",
  "FORECAST",
  "AI_JUDGMENT",
  "HUMAN_CONFIRMED",
] as const;

export type WorkflowState = (typeof workflowStates)[number];
export type TerminalStatus = (typeof terminalStatuses)[number];
export type ContentType = (typeof contentTypes)[number];
export type StepStatus = "pending" | "running" | "success" | "failed";
export type ReviewStatus = "PENDING_REVIEW" | "CONFIRMED" | "REJECTED" | "NEEDS_REVIEW";
export type EvidenceStatus = "SUPPORTED" | "CONFLICT" | "INSUFFICIENT_EVIDENCE" | "STALE";
export type SynthesisMode = "deterministic" | "deterministic-mismatch" | "llm-assisted";

export interface RunStep {
  state: WorkflowState;
  status: StepStatus;
  outputId: string;
  consumedOutputIds: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  summary: string;
}

export interface ToolCallEvent {
  id: string;
  kind: "TOOL_CALL";
  toolName: "snapshot-search" | "pdf-reader" | "csv-calculator" | "llm-planner" | "llm-synthesizer" | "pptx-generator";
  inputSummary: string;
  startedAt: string;
  status: "success" | "failed";
  outputId: string;
  duration: number;
  error: string | null;
}

export interface ResearchPlan {
  id: string;
  researchQuestion: string;
  scope: string;
  steps: Array<{
    id: string;
    objective: string;
    toolName: ToolCallEvent["toolName"] | "deterministic-audit";
    expectedOutput: string;
  }>;
}

export interface SourceLocator {
  url?: string | undefined;
  fileName?: string | undefined;
  page?: number | undefined;
  sheet?: string | undefined;
  cellRange?: string | undefined;
  columns?: string[] | undefined;
  rows?: number[] | undefined;
}

export interface ResearchSource {
  id: string;
  kind: "WEB" | "PDF" | "CSV";
  title: string;
  publisher: string;
  version: "v1" | "v2" | "snapshot";
  locator: SourceLocator;
  capturedAt: string;
  excerpt: string;
  isOfflineSnapshot: boolean;
}

export interface Evidence {
  id: string;
  sourceId: string;
  type: ContentType;
  excerpt: string;
  locator: SourceLocator;
  datumIds: string[];
}

export interface Datum {
  id: string;
  evidenceId: string;
  metric: string;
  value: number;
  unit: string;
  period: string;
  type: "FACT" | "CALCULATION" | "ESTIMATE";
  formula: string | null;
  inputs: Array<{ label: string; value: number; unit: string }>;
  assumptions: string[];
}

export interface Claim {
  id: string;
  text: string;
  originalText: string;
  type: ContentType;
  evidenceIds: string[];
  datumIds: string[];
  evidenceStatus: EvidenceStatus;
  assumptions: string[];
}

export interface Conclusion {
  id: string;
  text: string;
  originalAiText: string;
  type: "AI_JUDGMENT" | "HUMAN_CONFIRMED";
  claimIds: string[];
  evidenceIds: string[];
  sourceIds: string[];
  evidenceStatus: EvidenceStatus;
  reviewStatus: ReviewStatus;
  missingEvidence: string[];
  confirmedAt: string | null;
  confirmedText: string | null;
}

export interface SourceConflict {
  id: string;
  metric: string;
  datumIds: string[];
  explanation: string;
  explanationStatus: "CANDIDATE_EXPLANATION";
}

export type AuditCategory =
  | "MISSING_CITATION"
  | "UNSUPPORTED_CLAIM"
  | "SOURCE_CONFLICT"
  | "TYPE_MISMATCH"
  | "MISSING_ASSUMPTION"
  | "SCOPE_OVERREACH";

export interface AuditFinding {
  id: string;
  category: AuditCategory;
  severity: "info" | "warning" | "critical";
  targetId: string;
  status: "OPEN" | "REPAIRED" | "NEEDS_HUMAN";
  message: string;
  action: string;
  before: string;
  after: string;
}

export interface HumanDecision {
  id: string;
  conclusionId: string;
  action: "CONFIRM" | "REJECT" | "EDIT" | "REVOKE_ON_SOURCE_UPDATE";
  decidedAt: string;
  previousText: string;
  resultingText: string;
}

export interface ArtifactRecord {
  id: string;
  kind: "PPTX" | "EVIDENCE_JSON" | "REPORT";
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ResearchRun {
  schemaVersion: "1.0";
  id: string;
  researchQuestion: string;
  createdAt: string;
  updatedAt: string;
  terminalStatus: TerminalStatus;
  synthesisMode: SynthesisMode;
  offlineMode: true;
  offlineModeLabel: "使用缓存快照";
  repairAttempts: number;
  sourceVersion: "v1" | "v2";
  plan: ResearchPlan;
  steps: RunStep[];
  events: ToolCallEvent[];
  sources: ResearchSource[];
  evidence: Evidence[];
  data: Datum[];
  claims: Claim[];
  conclusions: Conclusion[];
  conflicts: SourceConflict[];
  auditFindings: AuditFinding[];
  humanDecisions: HumanDecision[];
  artifacts: ArtifactRecord[];
  affectedObjectIds: string[];
}

const sourceLocatorSchema = z.object({
  url: z.string().url().optional(),
  fileName: z.string().min(1).optional(),
  page: z.number().int().positive().optional(),
  sheet: z.string().min(1).optional(),
  cellRange: z.string().min(1).optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.number().int().positive()).optional(),
});

const sourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["WEB", "PDF", "CSV"]),
  title: z.string().min(1),
  publisher: z.string().min(1),
  version: z.enum(["v1", "v2", "snapshot"]),
  locator: sourceLocatorSchema,
  capturedAt: z.string().min(1),
  excerpt: z.string(),
  isOfflineSnapshot: z.boolean(),
});

const evidenceSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  type: z.enum(contentTypes),
  excerpt: z.string(),
  locator: sourceLocatorSchema,
  datumIds: z.array(z.string()),
});

const datumSchema = z.object({
  id: z.string().min(1),
  evidenceId: z.string().min(1),
  metric: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  period: z.string().min(1),
  type: z.enum(["FACT", "CALCULATION", "ESTIMATE"]),
  formula: z.string().nullable(),
  inputs: z.array(z.object({ label: z.string(), value: z.number().finite(), unit: z.string() })),
  assumptions: z.array(z.string()),
});

const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  originalText: z.string().min(1),
  type: z.enum(contentTypes),
  evidenceIds: z.array(z.string()),
  datumIds: z.array(z.string()),
  evidenceStatus: z.enum(["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE", "STALE"]),
  assumptions: z.array(z.string()),
});

const conclusionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  originalAiText: z.string().min(1),
  type: z.enum(["AI_JUDGMENT", "HUMAN_CONFIRMED"]),
  claimIds: z.array(z.string()).min(1),
  evidenceIds: z.array(z.string()).min(1),
  sourceIds: z.array(z.string()).min(1),
  evidenceStatus: z.enum(["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE", "STALE"]),
  reviewStatus: z.enum(["PENDING_REVIEW", "CONFIRMED", "REJECTED", "NEEDS_REVIEW"]),
  missingEvidence: z.array(z.string()),
  confirmedAt: z.string().nullable(),
  confirmedText: z.string().nullable(),
});

const auditFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["MISSING_CITATION", "UNSUPPORTED_CLAIM", "SOURCE_CONFLICT", "TYPE_MISMATCH", "MISSING_ASSUMPTION", "SCOPE_OVERREACH"]),
  severity: z.enum(["info", "warning", "critical"]),
  targetId: z.string().min(1),
  status: z.enum(["OPEN", "REPAIRED", "NEEDS_HUMAN"]),
  message: z.string().min(1),
  action: z.string().min(1),
  before: z.string(),
  after: z.string(),
});

const humanDecisionSchema = z.object({
  id: z.string().min(1),
  conclusionId: z.string().min(1),
  action: z.enum(["CONFIRM", "REJECT", "EDIT", "REVOKE_ON_SOURCE_UPDATE"]),
  decidedAt: z.string().min(1),
  previousText: z.string(),
  resultingText: z.string(),
});

const runStepSchema = z.object({
  state: z.enum(workflowStates),
  status: z.enum(["pending", "running", "success", "failed"]),
  outputId: z.string(),
  consumedOutputIds: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string(),
}).strict();

const toolCallEventSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("TOOL_CALL"),
  toolName: z.enum(["snapshot-search", "pdf-reader", "csv-calculator", "llm-planner", "llm-synthesizer", "pptx-generator"]),
  inputSummary: z.string().min(1),
  startedAt: z.string().min(1),
  status: z.enum(["success", "failed"]),
  outputId: z.string(),
  duration: z.number().nonnegative(),
  error: z.string().nullable(),
}).strict();

const researchPlanSchema = z.object({
  id: z.string().min(1),
  researchQuestion: z.string().min(3),
  scope: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().min(1),
    objective: z.string().min(1),
    toolName: z.enum(["snapshot-search", "pdf-reader", "csv-calculator", "llm-synthesizer", "pptx-generator", "deterministic-audit"]),
    expectedOutput: z.string().min(1),
  }).strict()).min(1),
}).strict();

const sourceConflictSchema = z.object({
  id: z.string().min(1),
  metric: z.string().min(1),
  datumIds: z.array(z.string()).min(2),
  explanation: z.string().min(1),
  explanationStatus: z.literal("CANDIDATE_EXPLANATION"),
}).strict();

const artifactRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["PPTX", "EVIDENCE_JSON", "REPORT"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
}).strict();

export const evidencePackageSchema = z.object({
  schemaVersion: z.literal("1.0"),
  researchQuestion: z.string().min(3),
  synthesisMode: z.enum(["deterministic", "deterministic-mismatch", "llm-assisted"]),
  sources: z.array(sourceSchema).min(1),
  evidence: z.array(evidenceSchema).min(1),
  data: z.array(datumSchema).min(1),
  claims: z.array(claimSchema).min(1),
  conclusions: z.array(conclusionSchema).min(3).max(5),
  auditFindings: z.array(auditFindingSchema),
  humanDecisions: z.array(humanDecisionSchema),
  artifacts: z.array(z.object({
    kind: z.enum(["PPTX", "EVIDENCE_JSON", "REPORT"]),
    fileName: z.string().min(1),
  })),
});

export const researchRunSchema: z.ZodType<ResearchRun> = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  researchQuestion: z.string().min(3),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  terminalStatus: z.enum(terminalStatuses),
  synthesisMode: z.enum(["deterministic", "deterministic-mismatch", "llm-assisted"]),
  offlineMode: z.literal(true),
  offlineModeLabel: z.literal("使用缓存快照"),
  repairAttempts: z.number().int().min(0).max(1),
  sourceVersion: z.enum(["v1", "v2"]),
  plan: researchPlanSchema,
  steps: z.array(runStepSchema).length(5),
  events: z.array(toolCallEventSchema),
  sources: z.array(sourceSchema).min(1),
  evidence: z.array(evidenceSchema).min(1),
  data: z.array(datumSchema).min(1),
  claims: z.array(claimSchema).min(1),
  conclusions: z.array(conclusionSchema).min(3).max(5),
  conflicts: z.array(sourceConflictSchema),
  auditFindings: z.array(auditFindingSchema),
  humanDecisions: z.array(humanDecisionSchema),
  artifacts: z.array(artifactRecordSchema),
  affectedObjectIds: z.array(z.string()),
}).strict();
