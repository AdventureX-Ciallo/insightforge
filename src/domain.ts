import { z } from "zod";
import { hashValue } from "./hash.js";

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

export const knowledgeTypes = ["FACT", "SOURCE_OPINION", "CALCULATION", "ESTIMATE", "FORECAST"] as const;
export const originTypes = ["SOURCE_EXTRACTED", "DETERMINISTIC", "AI_JUDGMENT", "HUMAN_EDITED"] as const;
export const normalizedEvidenceStatuses = ["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE"] as const;
export const normalizedReviewStatuses = ["PENDING_REVIEW", "HUMAN_CONFIRMED", "HUMAN_REJECTED", "NEEDS_REVIEW"] as const;
export const freshnessStatuses = ["CURRENT", "STALE"] as const;
export const sourceDiscoveryModes = ["OFFLINE_SNAPSHOT", "LIVE_SINGLE_PROVIDER"] as const;
export const authorityVerificationModes = ["NOT_RUN", "LIVE_ALLOWLIST"] as const;
export const synthesisModes = ["CACHED_MODEL_OUTPUT", "LIVE_SINGLE_ENDPOINT", "DETERMINISTIC_GOLDEN_RULES", "DETERMINISTIC_MISMATCH_BLOCK"] as const;
export const offlineModeLabels = ["使用缓存快照", "在线模型生成 · 信源使用缓存快照"] as const;
export const llmDraftDropReasons = [
  "UNKNOWN_EVIDENCE_ID",
  "TEXT_TOO_SHORT",
  "TEXT_TOO_LONG",
  "NO_EVIDENCE",
  "EVIDENCE_LIMIT_EXCEEDED",
  "AUXILIARY_LIMIT_EXCEEDED",
  "PROMPT_INJECTION_ECHO",
  "DUPLICATE",
  "OVER_LIMIT",
] as const;
export const MAX_REJECTED_DRAFTS = 100 as const;
export const MAX_REJECTED_DRAFT_TEXT_LENGTH = 500 as const;
export const MAX_REJECTED_DRAFT_EVIDENCE_IDS = 20 as const;
export const MAX_REJECTED_DRAFT_EVIDENCE_ID_LENGTH = 500 as const;

export type WorkflowState = (typeof workflowStates)[number];
export type TerminalStatus = (typeof terminalStatuses)[number];
export type ContentType = (typeof contentTypes)[number];
export type KnowledgeType = (typeof knowledgeTypes)[number];
export type OriginType = (typeof originTypes)[number];
export type NormalizedEvidenceStatus = (typeof normalizedEvidenceStatuses)[number];
export type NormalizedReviewStatus = (typeof normalizedReviewStatuses)[number];
export type FreshnessStatus = (typeof freshnessStatuses)[number];
export type StepStatus = "pending" | "running" | "success" | "failed";
export type ReviewStatus = "PENDING_REVIEW" | "CONFIRMED" | "REJECTED" | "NEEDS_REVIEW";
export type EvidenceStatus = "SUPPORTED" | "CONFLICT" | "INSUFFICIENT_EVIDENCE" | "STALE";
export type SourceDiscoveryMode = (typeof sourceDiscoveryModes)[number];
export type AuthorityVerificationMode = (typeof authorityVerificationModes)[number];
export type SynthesisMode = (typeof synthesisModes)[number];
export type OfflineModeLabel = (typeof offlineModeLabels)[number];
export type LlmDraftDropReason = (typeof llmDraftDropReasons)[number];

export interface RejectedDraft {
  draftIndex: number;
  text: string;
  textTruncated: boolean;
  evidenceIds: string[];
  evidenceIdsTruncated: boolean;
  dropReason: LlmDraftDropReason;
  droppedAt: string;
  draftSha256: string;
}

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
  toolName:
    | "snapshot-search"
    | "live-source-search"
    | "authority-source-check"
    | "pdf-reader"
    | "local-file-reader"
    | "csv-calculator"
    | "cached-model-planner"
    | "cached-model-synthesizer"
    | "llm-planner"
    | "llm-synthesizer"
    | "pptx-generator";
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

export interface SourceConfidence {
  category: "GOVERNMENT" | "ASSOCIATION" | "OFFICIAL" | "AUTHORITATIVE_EVENT" | "COMMUNITY" | "USER_UPLOAD" | "SYNTHETIC" | "OTHER";
  authority: number;
  freshness: number;
  completeness: number;
  overall: number;
  rationale: string;
  discountNote: string | null;
}

export interface CustomWhitelistSource {
  uploadId: string;
  originalFileName: string;
  sha256: string;
  parsedKind: "PDF" | "CSV" | "XLSX" | "TXT";
  status: "PARSED";
}

export interface ResearchSource {
  id: string;
  kind: "WEB" | "PDF" | "CSV" | "XLSX" | "TXT";
  title: string;
  publisher: string;
  version: "v1" | "v2" | "snapshot" | "upload";
  locator: SourceLocator;
  capturedAt: string;
  excerpt: string;
  isOfflineSnapshot: boolean;
  sourceVersionId: string;
  materialRole: "AUTHORITY_SOURCE" | "CANDIDATE_SOURCE" | "SYNTHETIC_DEMO_MATERIAL" | "USER_UPLOAD";
  freshness: FreshnessStatus;
  confidence?: SourceConfidence;
  customWhitelist?: CustomWhitelistSource | null;
}

export interface SourceVersion {
  id: string;
  sourceId: string;
  version: "v1" | "v2" | "snapshot" | "upload";
  capturedAt: string;
  sha256: string;
  locator: SourceLocator;
  knowledgeType: KnowledgeType;
  upstreamSourceIds: string[];
  isCurrent: boolean;
}

export interface Evidence {
  id: string;
  sourceId: string;
  type: ContentType;
  excerpt: string;
  locator: SourceLocator;
  datumIds: string[];
  knowledgeType: KnowledgeType;
  originType: OriginType;
  freshness: FreshnessStatus;
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
  knowledgeType: KnowledgeType;
  originType: OriginType;
  freshness: FreshnessStatus;
  assumptionIds: string[];
  sourceIds: string[];
  roundingRule: string | null;
}

export interface Assumption {
  id: string;
  text: string;
  value: number | null;
  unit: string | null;
  range: string | null;
  owner: "AI" | "HUMAN" | "DEMO_PARAMETER";
  evidenceStatus: NormalizedEvidenceStatus;
  sourceIds: string[];
  freshness: FreshnessStatus;
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
  knowledgeType: KnowledgeType;
  originType: OriginType;
  freshness: FreshnessStatus;
  assumptionIds: string[];
  evidenceGapId: string | null;
}

export interface EvidenceGap {
  id: string;
  claimId: string;
  existingEvidenceIds: string[];
  existingDatumIds: string[];
  missingItems: Array<{
    kind: "SOURCE" | "METRIC" | "SCOPE" | "METHOD" | "CROSS_CHECK" | "ASSUMPTION";
    description: string;
    requiredScope: string | null;
  }>;
  blockingReason: string;
  blockedAction: "CONFIRM";
  createdAt: string;
  resolvedAt: string | null;
  resolutionEvidenceIds: string[];
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
  originType: OriginType;
  normalizedEvidenceStatus: NormalizedEvidenceStatus;
  normalizedReviewStatus: NormalizedReviewStatus;
  freshness: FreshnessStatus;
  currentRevisionId: string;
  evidenceGapIds: string[];
  confidenceDiscounts?: Array<{ sourceId: string; weight: number; explanation: string }>;
}

export interface CandidateRevision {
  id: string;
  conclusionId: string;
  parentRevisionId: string | null;
  authorType: "AI" | "HUMAN" | "SYSTEM";
  originType: "AI_JUDGMENT" | "HUMAN_EDITED" | "DETERMINISTIC";
  text: string;
  changeReason: string;
  createdAt: string;
  auditStatus: "PENDING" | "PASSED" | "NEEDS_REVIEW";
  auditFindingIds: string[];
  sourceSnapshotId: string;
  isCurrent: boolean;
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
  status: "PASSED" | "OPEN" | "REPAIRED" | "NEEDS_HUMAN";
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
  candidateRevisionId: string;
  decisionReason: string | null;
  scopeNote: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  sourceUpdateId: string | null;
}

export interface ArtifactRecord {
  id: string;
  kind: "PPTX" | "EVIDENCE_JSON" | "REPORT_MD" | "REPORT_PDF";
  path: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  version: number;
}

export interface ArtifactVersion {
  id: string;
  researchSnapshotId: string;
  version: number;
  createdAt: string;
  trigger: "INITIAL_DELIVER" | "HUMAN_DECISION" | "HUMAN_EDIT" | "SOURCE_UPDATE" | "REVALIDATION";
  triggerRef: string;
  adjustmentNote: string;
  artifactIds: string[];
  sources: ResearchSource[];
  evidence: Evidence[];
  conclusions: Conclusion[];
  rejectedDrafts: RejectedDraft[];
  rejectedDraftOverflowCount: number;
  status: "CURRENT" | "SUPERSEDED";
  supersedesId: string | null;
}

export const MAX_ARTIFACT_VERSIONS = 5 as const;
export interface ModelProvenance {
  planSource: SynthesisMode;
  synthesisSource: SynthesisMode;
  provider: string;
  model: string;
  generatedAt: string;
  promptSha256: string;
  planPromptSha256?: string | undefined;
  synthesisPromptSha256?: string | undefined;
  planMaxTokens?: number | undefined;
  synthesisMaxTokens?: number | undefined;
  outputSha256: string;
  cacheFile: string | null;
  routingNotice?: string | undefined;
  dataDisclosure?: {
    externalTransfer: boolean;
    stages: Array<"PLAN" | "SYNTHESIZE">;
    sentFields: string[];
    omittedFields: string[];
    limits: { researchQuestionChars: number; sourceTitleChars: number; evidenceExcerptChars: number; formulaChars: number };
  } | undefined;
}

export interface SourceLimitTrace {
  maxSources: number;
  discoveredCount: number;
  retainedCount: number;
  truncatedCount: number;
  truncated: boolean;
  reason: "MAX_SOURCES" | null;
}

export interface SynthesisStepOutput {
  synthesis: {
    data: Datum[];
    assumptions: Assumption[];
    claims: Claim[];
    evidenceGaps: EvidenceGap[];
    conclusions: Conclusion[];
    candidateRevisions: CandidateRevision[];
  };
  synthesisMode: SynthesisMode;
  evidenceFit: number;
  sourceSnapshotId: string;
  rejectedDrafts?: RejectedDraft[] | undefined;
  rejectedDraftOverflowCount?: number | undefined;
}

export interface ResearchRun {
  schemaVersion: "1.0";
  id: string;
  researchQuestion: string;
  createdAt: string;
  updatedAt: string;
  terminalStatus: TerminalStatus;
  synthesisMode: SynthesisMode;
  sourceDiscoveryMode: SourceDiscoveryMode;
  authorityVerificationMode: AuthorityVerificationMode;
  offlineMode: boolean;
  offlineModeLabel: OfflineModeLabel;
  repairAttempts: number;
  sourceVersion: "v1" | "v2";
  plan: ResearchPlan;
  steps: RunStep[];
  events: ToolCallEvent[];
  sourceLimitTrace: SourceLimitTrace;
  synthesisOutput: SynthesisStepOutput;
  sources: ResearchSource[];
  sourceVersions: SourceVersion[];
  evidence: Evidence[];
  data: Datum[];
  assumptions: Assumption[];
  claims: Claim[];
  evidenceGaps: EvidenceGap[];
  conclusions: Conclusion[];
  candidateRevisions: CandidateRevision[];
  rejectedDrafts: RejectedDraft[];
  rejectedDraftOverflowCount: number;
  conflicts: SourceConflict[];
  auditFindings: AuditFinding[];
  humanDecisions: HumanDecision[];
  artifacts: ArtifactRecord[];
  artifactHistory: ArtifactRecord[];
  artifactVersions: ArtifactVersion[];
  evictedArtifactVersionCount: number;
  affectedObjectIds: string[];
  researchSnapshotId: string;
  uploadedFileIds: string[];
  modelProvenance: ModelProvenance;
}

export function computeResearchSnapshotId(run: ResearchRun): string {
  // Snapshot the research graph, not the mutable human-review ledger. A CONFIRM/REJECT
  // creates a new ArtifactVersion but does not rewrite the underlying research snapshot;
  // a HUMAN EDIT still changes text/currentRevisionId and therefore changes this hash.
  const researchConclusions = run.conclusions.map((conclusion) => ({
    id: conclusion.id,
    text: conclusion.text,
    originalAiText: conclusion.originalAiText,
    claimIds: conclusion.claimIds,
    evidenceIds: conclusion.evidenceIds,
    sourceIds: conclusion.sourceIds,
    evidenceStatus: conclusion.evidenceStatus,
    missingEvidence: conclusion.missingEvidence,
    originType: conclusion.originType,
    normalizedEvidenceStatus: conclusion.normalizedEvidenceStatus,
    freshness: conclusion.freshness,
    currentRevisionId: conclusion.currentRevisionId,
    evidenceGapIds: conclusion.evidenceGapIds,
    confidenceDiscounts: conclusion.confidenceDiscounts ?? [],
  }));
  return hashValue({
    researchQuestion: run.researchQuestion,
    sourceVersions: run.sourceVersions,
    evidence: run.evidence,
    data: run.data,
    assumptions: run.assumptions,
    claims: run.claims,
    evidenceGaps: run.evidenceGaps,
    conclusions: researchConclusions,
    candidateRevisions: run.candidateRevisions,
    auditFindings: run.auditFindings,
  });
}

export const sourceLocatorSchema = z.object({
  url: z.string().url().optional(),
  fileName: z.string().min(1).optional(),
  page: z.number().int().positive().optional(),
  sheet: z.string().min(1).optional(),
  cellRange: z.string().min(1).optional(),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.number().int().positive()).optional(),
}).strict();

export const sourceConfidenceSchema = z.object({
  category: z.enum(["GOVERNMENT", "ASSOCIATION", "OFFICIAL", "AUTHORITATIVE_EVENT", "COMMUNITY", "USER_UPLOAD", "SYNTHETIC", "OTHER"]),
  authority: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
  rationale: z.string().min(1),
  discountNote: z.string().min(1).nullable(),
}).strict();

export const customWhitelistSourceSchema = z.object({
  uploadId: z.string().min(1),
  originalFileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  parsedKind: z.enum(["PDF", "CSV", "XLSX", "TXT"]),
  status: z.literal("PARSED"),
}).strict();

export const sourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["WEB", "PDF", "CSV", "XLSX", "TXT"]),
  title: z.string().min(1),
  publisher: z.string().min(1),
  version: z.enum(["v1", "v2", "snapshot", "upload"]),
  locator: sourceLocatorSchema,
  capturedAt: z.string().min(1),
  excerpt: z.string(),
  isOfflineSnapshot: z.boolean(),
  sourceVersionId: z.string().min(1),
  materialRole: z.enum(["AUTHORITY_SOURCE", "CANDIDATE_SOURCE", "SYNTHETIC_DEMO_MATERIAL", "USER_UPLOAD"]),
  freshness: z.enum(freshnessStatuses),
  confidence: sourceConfidenceSchema,
  customWhitelist: customWhitelistSourceSchema.nullable(),
}).strict();

export const sourceVersionSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  version: z.enum(["v1", "v2", "snapshot", "upload"]),
  capturedAt: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: sourceLocatorSchema,
  knowledgeType: z.enum(knowledgeTypes),
  upstreamSourceIds: z.array(z.string()),
  isCurrent: z.boolean(),
}).strict();

export const evidenceSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  type: z.enum(contentTypes),
  excerpt: z.string(),
  locator: sourceLocatorSchema,
  datumIds: z.array(z.string()),
  knowledgeType: z.enum(knowledgeTypes),
  originType: z.enum(originTypes),
  freshness: z.enum(freshnessStatuses),
}).strict();

export const datumSchema = z.object({
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
  knowledgeType: z.enum(knowledgeTypes),
  originType: z.enum(originTypes),
  freshness: z.enum(freshnessStatuses),
  assumptionIds: z.array(z.string()),
  sourceIds: z.array(z.string()),
  roundingRule: z.string().nullable(),
}).strict();

export const assumptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  value: z.number().finite().nullable(),
  unit: z.string().nullable(),
  range: z.string().nullable(),
  owner: z.enum(["AI", "HUMAN", "DEMO_PARAMETER"]),
  evidenceStatus: z.enum(normalizedEvidenceStatuses),
  sourceIds: z.array(z.string()),
  freshness: z.enum(freshnessStatuses),
}).strict();

export const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  originalText: z.string().min(1),
  type: z.enum(contentTypes),
  evidenceIds: z.array(z.string()),
  datumIds: z.array(z.string()),
  evidenceStatus: z.enum(["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE", "STALE"]),
  assumptions: z.array(z.string()),
  knowledgeType: z.enum(knowledgeTypes),
  originType: z.enum(originTypes),
  freshness: z.enum(freshnessStatuses),
  assumptionIds: z.array(z.string()),
  evidenceGapId: z.string().nullable(),
}).strict();

export const evidenceGapSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  existingEvidenceIds: z.array(z.string()),
  existingDatumIds: z.array(z.string()),
  missingItems: z.array(z.object({
    kind: z.enum(["SOURCE", "METRIC", "SCOPE", "METHOD", "CROSS_CHECK", "ASSUMPTION"]),
    description: z.string().min(1),
    requiredScope: z.string().nullable(),
  }).strict()).min(1),
  blockingReason: z.string().min(1),
  blockedAction: z.literal("CONFIRM"),
  createdAt: z.string().min(1),
  resolvedAt: z.string().nullable(),
  resolutionEvidenceIds: z.array(z.string()),
}).strict();

export const conclusionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  originalAiText: z.string().min(1),
  type: z.enum(["AI_JUDGMENT", "HUMAN_CONFIRMED"]),
  claimIds: z.array(z.string()).min(1),
  evidenceIds: z.array(z.string()),
  sourceIds: z.array(z.string()),
  evidenceStatus: z.enum(["SUPPORTED", "CONFLICT", "INSUFFICIENT_EVIDENCE", "STALE"]),
  reviewStatus: z.enum(["PENDING_REVIEW", "CONFIRMED", "REJECTED", "NEEDS_REVIEW"]),
  missingEvidence: z.array(z.string()),
  confirmedAt: z.string().nullable(),
  confirmedText: z.string().nullable(),
  originType: z.enum(originTypes),
  normalizedEvidenceStatus: z.enum(normalizedEvidenceStatuses),
  normalizedReviewStatus: z.enum(normalizedReviewStatuses),
  freshness: z.enum(freshnessStatuses),
  currentRevisionId: z.string().min(1),
  evidenceGapIds: z.array(z.string()),
  confidenceDiscounts: z.array(z.object({
    sourceId: z.string().min(1),
    weight: z.number().min(0).max(1),
    explanation: z.string().min(1),
  }).strict()),
}).strict();

export const candidateRevisionSchema = z.object({
  id: z.string().min(1),
  conclusionId: z.string().min(1),
  parentRevisionId: z.string().nullable(),
  authorType: z.enum(["AI", "HUMAN", "SYSTEM"]),
  originType: z.enum(["AI_JUDGMENT", "HUMAN_EDITED", "DETERMINISTIC"]),
  text: z.string().min(1),
  changeReason: z.string().min(1),
  createdAt: z.string().min(1),
  auditStatus: z.enum(["PENDING", "PASSED", "NEEDS_REVIEW"]),
  auditFindingIds: z.array(z.string()),
  sourceSnapshotId: z.string().min(1),
  isCurrent: z.boolean(),
}).strict();

const auditFindingSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["MISSING_CITATION", "UNSUPPORTED_CLAIM", "SOURCE_CONFLICT", "TYPE_MISMATCH", "MISSING_ASSUMPTION", "SCOPE_OVERREACH"]),
  severity: z.enum(["info", "warning", "critical"]),
  targetId: z.string().min(1),
  status: z.enum(["PASSED", "OPEN", "REPAIRED", "NEEDS_HUMAN"]),
  message: z.string().min(1),
  action: z.string().min(1),
  before: z.string(),
  after: z.string(),
});

export const humanDecisionSchema = z.object({
  id: z.string().min(1),
  conclusionId: z.string().min(1),
  action: z.enum(["CONFIRM", "REJECT", "EDIT", "REVOKE_ON_SOURCE_UPDATE"]),
  decidedAt: z.string().min(1),
  previousText: z.string(),
  resultingText: z.string(),
  candidateRevisionId: z.string().min(1),
  decisionReason: z.string().nullable(),
  scopeNote: z.string().nullable(),
  invalidatedAt: z.string().nullable(),
  invalidationReason: z.string().nullable(),
  sourceUpdateId: z.string().nullable(),
}).strict();

export const rejectedDraftSchema = z.object({
  draftIndex: z.number().int().nonnegative(),
  text: z.string().max(MAX_REJECTED_DRAFT_TEXT_LENGTH),
  textTruncated: z.boolean(),
  evidenceIds: z.array(z.string().max(MAX_REJECTED_DRAFT_EVIDENCE_ID_LENGTH)).max(MAX_REJECTED_DRAFT_EVIDENCE_IDS),
  evidenceIdsTruncated: z.boolean(),
  dropReason: z.enum(llmDraftDropReasons),
  droppedAt: z.string().datetime(),
  draftSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const runStepSchema = z.object({
  state: z.enum(workflowStates),
  status: z.enum(["pending", "running", "success", "failed"]),
  outputId: z.string(),
  consumedOutputIds: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.string(),
}).strict();

export const toolCallEventSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("TOOL_CALL"),
  toolName: z.enum(["snapshot-search", "live-source-search", "authority-source-check", "pdf-reader", "local-file-reader", "csv-calculator", "cached-model-planner", "cached-model-synthesizer", "llm-planner", "llm-synthesizer", "pptx-generator"]),
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
    toolName: z.enum(["snapshot-search", "live-source-search", "authority-source-check", "pdf-reader", "local-file-reader", "csv-calculator", "cached-model-planner", "cached-model-synthesizer", "llm-planner", "llm-synthesizer", "pptx-generator", "deterministic-audit"]),
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

export const artifactRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["PPTX", "EVIDENCE_JSON", "REPORT_MD", "REPORT_PDF"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  fileName: z.string().min(1),
  version: z.number().int().positive(),
}).strict();

export const artifactVersionSchema = z.object({
  id: z.string().min(1),
  researchSnapshotId: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  trigger: z.enum(["INITIAL_DELIVER", "HUMAN_DECISION", "HUMAN_EDIT", "SOURCE_UPDATE", "REVALIDATION"]),
  triggerRef: z.string().min(1),
  adjustmentNote: z.string().min(1),
  artifactIds: z.array(z.string()).min(1),
  sources: z.array(sourceSchema).min(1).max(10),
  evidence: z.array(evidenceSchema).min(1),
  conclusions: z.array(conclusionSchema).min(3).max(5),
  rejectedDrafts: z.array(rejectedDraftSchema).max(MAX_REJECTED_DRAFTS).default([]),
  rejectedDraftOverflowCount: z.number().int().nonnegative().default(0),
  status: z.enum(["CURRENT", "SUPERSEDED"]),
  supersedesId: z.string().nullable(),
}).strict();

export const modelProvenanceSchema = z.object({
  planSource: z.enum(synthesisModes),
  synthesisSource: z.enum(synthesisModes),
  provider: z.string().min(1),
  model: z.string().min(1),
  generatedAt: z.string().min(1),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  planPromptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  synthesisPromptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  planMaxTokens: z.number().int().min(256).max(32768).optional(),
  synthesisMaxTokens: z.number().int().min(256).max(32768).optional(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cacheFile: z.string().nullable(),
  routingNotice: z.string().min(1).optional(),
  dataDisclosure: z.object({
    externalTransfer: z.boolean(),
    stages: z.array(z.enum(["PLAN", "SYNTHESIZE"])),
    sentFields: z.array(z.string().min(1)),
    omittedFields: z.array(z.string().min(1)),
    limits: z.object({
      researchQuestionChars: z.number().int().positive(),
      sourceTitleChars: z.number().int().positive(),
      evidenceExcerptChars: z.number().int().positive(),
      formulaChars: z.number().int().positive(),
    }).strict(),
  }).strict().optional(),
}).strict();

export function modePresentation(synthesisMode: SynthesisMode): { offlineMode: boolean; offlineModeLabel: OfflineModeLabel } {
  return synthesisMode === "LIVE_SINGLE_ENDPOINT"
    ? { offlineMode: false, offlineModeLabel: "在线模型生成 · 信源使用缓存快照" }
    : { offlineMode: true, offlineModeLabel: "使用缓存快照" };
}

export const evidencePackageSchema = z.object({
  schemaVersion: z.literal("1.0"),
  researchQuestion: z.string().min(3),
  synthesisMode: z.enum(synthesisModes),
  sourceDiscoveryMode: z.enum(sourceDiscoveryModes),
  authorityVerificationMode: z.enum(authorityVerificationModes),
  offlineMode: z.boolean(),
  offlineModeLabel: z.enum(offlineModeLabels),
  sourceLimitTrace: z.object({
    maxSources: z.literal(10),
    discoveredCount: z.number().int().nonnegative(),
    retainedCount: z.number().int().min(1).max(10),
    truncatedCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    reason: z.literal("MAX_SOURCES").nullable(),
  }).strict(),
  sources: z.array(sourceSchema).min(1).max(10),
  sourceVersions: z.array(sourceVersionSchema).min(1),
  evidence: z.array(evidenceSchema).min(1),
  data: z.array(datumSchema).min(1),
  assumptions: z.array(assumptionSchema),
  claims: z.array(claimSchema).min(1),
  evidenceGaps: z.array(evidenceGapSchema),
  conclusions: z.array(conclusionSchema).min(3).max(5),
  candidateRevisions: z.array(candidateRevisionSchema).min(3),
  rejectedDrafts: z.array(rejectedDraftSchema).max(MAX_REJECTED_DRAFTS).default([]),
  rejectedDraftOverflowCount: z.number().int().nonnegative().default(0),
  auditFindings: z.array(auditFindingSchema),
  humanDecisions: z.array(humanDecisionSchema),
  artifactVersions: z.array(artifactVersionSchema).max(MAX_ARTIFACT_VERSIONS),
  researchSnapshotId: z.string().min(1),
  modelProvenance: modelProvenanceSchema,
  artifacts: z.array(z.object({
    kind: z.enum(["PPTX", "EVIDENCE_JSON", "REPORT_MD", "REPORT_PDF"]),
    fileName: z.string().min(1),
  })),
}).strict();

const researchRunObjectSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  researchQuestion: z.string().min(3),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  terminalStatus: z.enum(terminalStatuses),
  synthesisMode: z.enum(synthesisModes),
  sourceDiscoveryMode: z.enum(sourceDiscoveryModes),
  authorityVerificationMode: z.enum(authorityVerificationModes),
  offlineMode: z.boolean(),
  offlineModeLabel: z.enum(offlineModeLabels),
  repairAttempts: z.number().int().min(0).max(1),
  sourceVersion: z.enum(["v1", "v2"]),
  plan: researchPlanSchema,
  steps: z.array(runStepSchema).length(5),
  events: z.array(toolCallEventSchema),
  sourceLimitTrace: z.object({
    maxSources: z.literal(10),
    discoveredCount: z.number().int().nonnegative(),
    retainedCount: z.number().int().min(1).max(10),
    truncatedCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    reason: z.literal("MAX_SOURCES").nullable(),
  }).strict(),
  synthesisOutput: z.object({
    synthesis: z.object({
      data: z.array(datumSchema).min(1),
      assumptions: z.array(assumptionSchema),
      claims: z.array(claimSchema).min(1),
      evidenceGaps: z.array(evidenceGapSchema),
      conclusions: z.array(conclusionSchema).min(3).max(5),
      candidateRevisions: z.array(candidateRevisionSchema).min(3),
    }).strict(),
    synthesisMode: z.enum(synthesisModes),
    evidenceFit: z.number().min(0).max(1),
    sourceSnapshotId: z.string().min(1),
    rejectedDrafts: z.array(rejectedDraftSchema).max(MAX_REJECTED_DRAFTS).optional(),
    rejectedDraftOverflowCount: z.number().int().nonnegative().optional(),
  }).strict(),
  sources: z.array(sourceSchema).min(1).max(10),
  sourceVersions: z.array(sourceVersionSchema).min(1),
  evidence: z.array(evidenceSchema).min(1),
  data: z.array(datumSchema).min(1),
  assumptions: z.array(assumptionSchema),
  claims: z.array(claimSchema).min(1),
  evidenceGaps: z.array(evidenceGapSchema),
  conclusions: z.array(conclusionSchema).min(3).max(5),
  candidateRevisions: z.array(candidateRevisionSchema).min(3),
  rejectedDrafts: z.array(rejectedDraftSchema).max(MAX_REJECTED_DRAFTS).default([]),
  rejectedDraftOverflowCount: z.number().int().nonnegative().default(0),
  conflicts: z.array(sourceConflictSchema),
  auditFindings: z.array(auditFindingSchema),
  humanDecisions: z.array(humanDecisionSchema),
  artifacts: z.array(artifactRecordSchema),
  artifactHistory: z.array(artifactRecordSchema),
  artifactVersions: z.array(artifactVersionSchema).max(MAX_ARTIFACT_VERSIONS),
  evictedArtifactVersionCount: z.number().int().nonnegative().default(0),
  affectedObjectIds: z.array(z.string()),
  researchSnapshotId: z.string().min(1),
  uploadedFileIds: z.array(z.string()),
  modelProvenance: modelProvenanceSchema,
}).strict();

function ids<T extends { id: string }>(items: T[]) {
  return new Set(items.map((item) => item.id));
}

function locatorCovers(source: SourceLocator, version: SourceLocator) {
  return Object.entries(version).every(([key, value]) => JSON.stringify(source[key as keyof SourceLocator]) === JSON.stringify(value));
}

function graphIssue(ctx: z.RefinementCtx, path: Array<string | number>, message: string) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

const normalizedReviewByLegacy: Record<ReviewStatus, NormalizedReviewStatus> = {
  PENDING_REVIEW: "PENDING_REVIEW",
  CONFIRMED: "HUMAN_CONFIRMED",
  REJECTED: "HUMAN_REJECTED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
};

/** Schema 锁不只验证字段形状，也验证证据图引用、人工边界与当前版本唯一性。 */
type ArtifactVersionSchemaInput = Omit<ArtifactVersion, "rejectedDrafts" | "rejectedDraftOverflowCount"> & {
  rejectedDrafts?: RejectedDraft[] | undefined;
  rejectedDraftOverflowCount?: number | undefined;
};
type ResearchRunSchemaInput = Omit<ResearchRun, "artifactVersions" | "evictedArtifactVersionCount" | "rejectedDrafts" | "rejectedDraftOverflowCount"> & {
  artifactVersions: ArtifactVersionSchemaInput[];
  evictedArtifactVersionCount?: number | undefined;
  rejectedDrafts?: RejectedDraft[] | undefined;
  rejectedDraftOverflowCount?: number | undefined;
};
export const researchRunSchema: z.ZodType<ResearchRun, z.ZodTypeDef, ResearchRunSchemaInput> = researchRunObjectSchema.superRefine((run, ctx) => {
  const presentation = modePresentation(run.synthesisMode);
  if (run.offlineMode !== presentation.offlineMode) graphIssue(ctx, ["offlineMode"], "offlineMode does not match synthesisMode");
  if (run.offlineModeLabel !== presentation.offlineModeLabel) graphIssue(ctx, ["offlineModeLabel"], "offlineModeLabel does not match synthesisMode");
  const liveStages = [run.modelProvenance.planSource, run.modelProvenance.synthesisSource].includes("LIVE_SINGLE_ENDPOINT");
  if (liveStages && (!run.modelProvenance.dataDisclosure?.externalTransfer || run.modelProvenance.dataDisclosure.stages.length === 0)) {
    graphIssue(ctx, ["modelProvenance", "dataDisclosure"], "Live model use requires a per-run external data disclosure");
  }
  if (run.synthesisOutput.synthesisMode !== run.synthesisMode) graphIssue(ctx, ["synthesisOutput", "synthesisMode"], "SYNTHESIZE snapshot mode does not match run mode");
  if (hashValue(run.synthesisOutput.rejectedDrafts ?? []) !== hashValue(run.rejectedDrafts)
    || (run.synthesisOutput.rejectedDraftOverflowCount ?? 0) !== run.rejectedDraftOverflowCount) {
    graphIssue(ctx, ["rejectedDrafts"], "Rejected draft trace must match the immutable SYNTHESIZE snapshot");
  }
  const synthesizeStep = run.steps.find((step) => step.state === "SYNTHESIZE");
  if (!synthesizeStep) graphIssue(ctx, ["steps"], "Run must contain a SYNTHESIZE step");
  else if (synthesizeStep.outputId !== hashValue(run.synthesisOutput)) {
    graphIssue(ctx, ["synthesisOutput"], "SYNTHESIZE outputId does not match its persisted immutable snapshot");
  }
  run.steps.forEach((step, index) => {
    if (step.state !== workflowStates[index]) graphIssue(ctx, ["steps", index, "state"], `Step ${index} must be ${workflowStates[index]}`);
    if (step.status === "success" && !/^[a-f0-9]{64}$/u.test(step.outputId)) graphIssue(ctx, ["steps", index, "outputId"], "Successful step must have a SHA-256 outputId");
    if (index === 0) {
      if (step.consumedOutputIds.length > 0) graphIssue(ctx, ["steps", index, "consumedOutputIds"], "PLAN must not consume a predecessor output");
      return;
    }
    if (step.status === "pending") {
      if (step.consumedOutputIds.length > 0) graphIssue(ctx, ["steps", index, "consumedOutputIds"], "Pending step must not claim consumed outputs");
      return;
    }
    const previous = run.steps[index - 1]!;
    if (previous.status !== "success") graphIssue(ctx, ["steps", index, "consumedOutputIds"], "Started step requires a successful predecessor");
    if (step.consumedOutputIds.length !== 1 || step.consumedOutputIds[0] !== previous.outputId) {
      graphIssue(ctx, ["steps", index, "consumedOutputIds"], "Step must consume exactly its predecessor outputId");
    }
  });
  if (run.terminalStatus !== "FAILED" && run.steps.some((step) => step.status !== "success")) {
    graphIssue(ctx, ["steps"], "Delivered or reviewable run requires five successful steps");
  }
  const collections: Array<[string, Array<{ id: string }>]> = [
    ["sources", run.sources], ["sourceVersions", run.sourceVersions], ["evidence", run.evidence], ["data", run.data],
    ["assumptions", run.assumptions], ["claims", run.claims], ["evidenceGaps", run.evidenceGaps],
    ["conclusions", run.conclusions], ["candidateRevisions", run.candidateRevisions], ["artifacts", [...run.artifacts, ...run.artifactHistory]],
    ["artifactVersions", run.artifactVersions], ["auditFindings", run.auditFindings], ["humanDecisions", run.humanDecisions], ["conflicts", run.conflicts],
  ];
  for (const [name, items] of collections) {
    if (ids(items).size !== items.length) graphIssue(ctx, [name], `${name} contains duplicate IDs`);
  }
  const sourceIds = ids(run.sources);
  const sourceVersionIds = ids(run.sourceVersions);
  const evidenceIds = ids(run.evidence);
  const datumIds = ids(run.data);
  const assumptionIds = ids(run.assumptions);
  const claimIds = ids(run.claims);
  const gapIds = ids(run.evidenceGaps);
  const conclusionIds = ids(run.conclusions);
  const revisionIds = ids(run.candidateRevisions);
  const artifactIds = ids([...run.artifacts, ...run.artifactHistory]);
  const sourceVersionsById = new Map(run.sourceVersions.map((version) => [version.id, version]));
  const revisionsById = new Map(run.candidateRevisions.map((revision) => [revision.id, revision]));

  run.sources.forEach((source, index) => {
    if (!sourceVersionIds.has(source.sourceVersionId)) graphIssue(ctx, ["sources", index, "sourceVersionId"], "Source points to an unknown SourceVersion");
    const currentVersion = sourceVersionsById.get(source.sourceVersionId);
    if (currentVersion && (currentVersion.sourceId !== source.id || !currentVersion.isCurrent)) {
      graphIssue(ctx, ["sources", index, "sourceVersionId"], "Source must point to its own current SourceVersion");
    }
    if (currentVersion && currentVersion.version !== source.version) {
      graphIssue(ctx, ["sources", index, "version"], "Source version label must match its current SourceVersion");
    }
    if (currentVersion && currentVersion.capturedAt !== source.capturedAt) {
      graphIssue(ctx, ["sources", index, "capturedAt"], "Source capture time must match its current SourceVersion");
    }
    if (currentVersion && !locatorCovers(source.locator, currentVersion.locator)) {
      graphIssue(ctx, ["sources", index, "locator"], "Source locator must match its current SourceVersion");
    }
  });
  run.sourceVersions.forEach((version, index) => {
    if (!sourceIds.has(version.sourceId)) graphIssue(ctx, ["sourceVersions", index, "sourceId"], "SourceVersion points to an unknown Source");
    for (const id of version.upstreamSourceIds) {
      if (!sourceIds.has(id)) graphIssue(ctx, ["sourceVersions", index, "upstreamSourceIds"], `SourceVersion points to unknown upstream Source ${id}`);
    }
  });
  for (const source of run.sources) {
    if (run.sourceVersions.filter((version) => version.sourceId === source.id && version.isCurrent).length !== 1) {
      graphIssue(ctx, ["sourceVersions"], `Source ${source.id} must have exactly one current version`);
    }
  }
  run.evidence.forEach((item, index) => {
    if (!sourceIds.has(item.sourceId)) graphIssue(ctx, ["evidence", index, "sourceId"], "Evidence points to an unknown Source");
    for (const id of item.datumIds) if (!datumIds.has(id)) graphIssue(ctx, ["evidence", index, "datumIds"], `Evidence points to unknown Datum ${id}`);
  });
  run.data.forEach((datum, index) => {
    if (!evidenceIds.has(datum.evidenceId)) graphIssue(ctx, ["data", index, "evidenceId"], "Datum points to unknown Evidence");
    for (const id of datum.assumptionIds) if (!assumptionIds.has(id)) graphIssue(ctx, ["data", index, "assumptionIds"], `Datum points to unknown Assumption ${id}`);
    for (const id of datum.sourceIds) if (!sourceIds.has(id)) graphIssue(ctx, ["data", index, "sourceIds"], `Datum points to unknown Source ${id}`);
  });
  run.claims.forEach((claim, index) => {
    for (const id of claim.evidenceIds) if (!evidenceIds.has(id)) graphIssue(ctx, ["claims", index, "evidenceIds"], `Claim points to unknown Evidence ${id}`);
    for (const id of claim.datumIds) if (!datumIds.has(id)) graphIssue(ctx, ["claims", index, "datumIds"], `Claim points to unknown Datum ${id}`);
    for (const id of claim.assumptionIds) if (!assumptionIds.has(id)) graphIssue(ctx, ["claims", index, "assumptionIds"], `Claim points to unknown Assumption ${id}`);
    if (claim.evidenceGapId && !gapIds.has(claim.evidenceGapId)) graphIssue(ctx, ["claims", index, "evidenceGapId"], "Claim points to unknown EvidenceGap");
    if (claim.evidenceStatus === "INSUFFICIENT_EVIDENCE" && !claim.evidenceGapId) graphIssue(ctx, ["claims", index, "evidenceGapId"], "Insufficient claim requires an EvidenceGap");
    if ((claim.evidenceStatus === "STALE") !== (claim.freshness === "STALE")) graphIssue(ctx, ["claims", index, "freshness"], "Claim STALE evidence and freshness axes must agree");
  });
  run.evidenceGaps.forEach((gap, index) => {
    if (!claimIds.has(gap.claimId)) graphIssue(ctx, ["evidenceGaps", index, "claimId"], "EvidenceGap points to unknown Claim");
    for (const id of gap.existingEvidenceIds) if (!evidenceIds.has(id)) graphIssue(ctx, ["evidenceGaps", index, "existingEvidenceIds"], `EvidenceGap points to unknown Evidence ${id}`);
    for (const id of gap.existingDatumIds) if (!datumIds.has(id)) graphIssue(ctx, ["evidenceGaps", index, "existingDatumIds"], `EvidenceGap points to unknown Datum ${id}`);
  });
  run.conclusions.forEach((conclusion, index) => {
    for (const id of conclusion.claimIds) if (!claimIds.has(id)) graphIssue(ctx, ["conclusions", index, "claimIds"], `Conclusion points to unknown Claim ${id}`);
    for (const id of conclusion.evidenceIds) if (!evidenceIds.has(id)) graphIssue(ctx, ["conclusions", index, "evidenceIds"], `Conclusion points to unknown Evidence ${id}`);
    for (const id of conclusion.sourceIds) if (!sourceIds.has(id)) graphIssue(ctx, ["conclusions", index, "sourceIds"], `Conclusion points to unknown Source ${id}`);
    for (const id of conclusion.evidenceGapIds) if (!gapIds.has(id)) graphIssue(ctx, ["conclusions", index, "evidenceGapIds"], `Conclusion points to unknown EvidenceGap ${id}`);
    for (const discount of conclusion.confidenceDiscounts as NonNullable<typeof conclusion.confidenceDiscounts>) {
      if (!conclusion.sourceIds.includes(discount.sourceId)) graphIssue(ctx, ["conclusions", index, "confidenceDiscounts"], `Confidence discount points to unrelated Source ${discount.sourceId}`);
    }
    if (!revisionIds.has(conclusion.currentRevisionId)) graphIssue(ctx, ["conclusions", index, "currentRevisionId"], "Conclusion points to unknown CandidateRevision");
    const currentRevision = revisionsById.get(conclusion.currentRevisionId);
    if (currentRevision && (currentRevision.conclusionId !== conclusion.id || !currentRevision.isCurrent)) {
      graphIssue(ctx, ["conclusions", index, "currentRevisionId"], "Conclusion must point to its own current CandidateRevision");
    }
    if (conclusion.normalizedReviewStatus !== normalizedReviewByLegacy[conclusion.reviewStatus]) graphIssue(ctx, ["conclusions", index, "normalizedReviewStatus"], "Raw and normalized review statuses disagree");
    if (conclusion.evidenceStatus === "STALE") {
      if (conclusion.freshness !== "STALE") graphIssue(ctx, ["conclusions", index, "freshness"], "STALE evidence requires STALE freshness");
    } else {
      if (conclusion.normalizedEvidenceStatus !== conclusion.evidenceStatus) graphIssue(ctx, ["conclusions", index, "normalizedEvidenceStatus"], "Raw and normalized evidence statuses disagree");
      if (conclusion.freshness === "STALE") graphIssue(ctx, ["conclusions", index, "evidenceStatus"], "STALE freshness requires STALE evidence status");
    }
    if (conclusion.normalizedEvidenceStatus === "INSUFFICIENT_EVIDENCE" && conclusion.evidenceGapIds.length === 0) graphIssue(ctx, ["conclusions", index, "evidenceGapIds"], "Insufficient conclusion requires an EvidenceGap");
    if (conclusion.normalizedEvidenceStatus === "INSUFFICIENT_EVIDENCE" && conclusion.normalizedReviewStatus === "HUMAN_CONFIRMED") graphIssue(ctx, ["conclusions", index], "Insufficient conclusion cannot be human-confirmed");
    if (conclusion.normalizedReviewStatus === "HUMAN_CONFIRMED" && (conclusion.type !== "HUMAN_CONFIRMED" || !conclusion.confirmedAt || !conclusion.confirmedText)) graphIssue(ctx, ["conclusions", index], "Confirmed conclusion lacks confirmation metadata");
  });
  run.candidateRevisions.forEach((revision, index) => {
    if (!conclusionIds.has(revision.conclusionId)) graphIssue(ctx, ["candidateRevisions", index, "conclusionId"], "CandidateRevision points to unknown Conclusion");
    if (revision.parentRevisionId && !revisionIds.has(revision.parentRevisionId)) graphIssue(ctx, ["candidateRevisions", index, "parentRevisionId"], "CandidateRevision points to unknown parent");
    const parent = revision.parentRevisionId ? revisionsById.get(revision.parentRevisionId) : undefined;
    if (parent && parent.conclusionId !== revision.conclusionId) graphIssue(ctx, ["candidateRevisions", index, "parentRevisionId"], "CandidateRevision parent belongs to another Conclusion");
    const seen = new Set<string>();
    let cursor: CandidateRevision | undefined = revision;
    while (cursor) {
      if (seen.has(cursor.id)) {
        graphIssue(ctx, ["candidateRevisions", index, "parentRevisionId"], "CandidateRevision parent chain contains a cycle");
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentRevisionId ? revisionsById.get(cursor.parentRevisionId) : undefined;
    }
  });
  for (const conclusion of run.conclusions) {
    if (run.candidateRevisions.filter((revision) => revision.conclusionId === conclusion.id && revision.isCurrent).length !== 1) graphIssue(ctx, ["candidateRevisions"], `Conclusion ${conclusion.id} must have exactly one current revision`);
  }
  run.humanDecisions.forEach((decision, index) => {
    if (!conclusionIds.has(decision.conclusionId)) graphIssue(ctx, ["humanDecisions", index, "conclusionId"], "HumanDecision points to unknown Conclusion");
    if (!revisionIds.has(decision.candidateRevisionId)) graphIssue(ctx, ["humanDecisions", index, "candidateRevisionId"], "HumanDecision points to unknown CandidateRevision");
    const revision = revisionsById.get(decision.candidateRevisionId);
    if (revision && revision.conclusionId !== decision.conclusionId) graphIssue(ctx, ["humanDecisions", index, "candidateRevisionId"], "HumanDecision revision belongs to another Conclusion");
  });
  run.artifactVersions.forEach((version, index) => {
    for (const id of version.artifactIds) if (!artifactIds.has(id)) graphIssue(ctx, ["artifactVersions", index, "artifactIds"], `ArtifactVersion points to unknown Artifact ${id}`);
    if (version.status === "CURRENT" && version.researchSnapshotId !== run.researchSnapshotId) graphIssue(ctx, ["artifactVersions", index, "researchSnapshotId"], "Current ArtifactVersion must match the current research snapshot");
    if (hashValue(version.rejectedDrafts) !== hashValue(run.rejectedDrafts)
      || version.rejectedDraftOverflowCount !== run.rejectedDraftOverflowCount) {
      graphIssue(ctx, ["artifactVersions", index, "rejectedDrafts"], "ArtifactVersion must preserve the immutable rejected draft trace");
    }
  });
  if (run.artifactVersions.length > 0 && run.artifactVersions.filter((item) => item.status === "CURRENT").length !== 1) graphIssue(ctx, ["artifactVersions"], "Exactly one ArtifactVersion must be current");
  if (run.researchSnapshotId !== computeResearchSnapshotId(run)) graphIssue(ctx, ["researchSnapshotId"], "Research snapshot ID does not match the current evidence graph");
});
