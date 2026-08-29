/* InsightForge 领域模型 — 与 docs/RESEARCH-OBJECT-MODEL.md 对齐 */

export type KnowledgeType = 'FACT' | 'SOURCE_OPINION' | 'CALCULATION' | 'ESTIMATE' | 'FORECAST'
export type OriginType = 'SOURCE_EXTRACTED' | 'DETERMINISTIC' | 'AI_JUDGMENT' | 'HUMAN_EDITED'
export type EvidenceStatus = 'SUPPORTED' | 'CONFLICT' | 'INSUFFICIENT_EVIDENCE'
export type ReviewStatus = 'PENDING_REVIEW' | 'HUMAN_CONFIRMED' | 'HUMAN_REJECTED' | 'NEEDS_REVIEW'
export type Freshness = 'CURRENT' | 'STALE'
export type StepStatus = 'pending' | 'running' | 'success' | 'failed'
export type RunTerminal = 'DELIVERED' | 'NEEDS_REVIEW' | 'FAILED'

export type SourceDiscoveryMode = 'OFFLINE_SNAPSHOT' | 'LIVE_SINGLE_PROVIDER'
export type AuthorityVerificationMode = 'NOT_RUN' | 'LIVE_ALLOWLIST'
export type SynthesisMode = 'CACHED_MODEL_OUTPUT' | 'LIVE_SINGLE_ENDPOINT' | 'DETERMINISTIC_MISMATCH_BLOCK'

export interface Modes {
  sourceDiscovery: SourceDiscoveryMode
  authorityVerification: AuthorityVerificationMode
  synthesis: SynthesisMode
}

export interface Locator {
  kind: 'WEB_ANCHOR' | 'PDF_PAGE' | 'CSV_CELL' | 'FORMULA'
  label: string
  detail: string
}

/* 信源权重：官方发布 / 行业协会为高，媒体转述为中，社交平台为低 */
export type SourceWeight = 'HIGH' | 'MEDIUM' | 'LOW'

export interface Source {
  sourceId: string
  publisher: string
  title: string
  date: string
  url?: string
  fileName?: string
  scopeNote: string
  weight: SourceWeight
  weightLabel: string
  synthetic?: boolean
  locators: Locator[]
}

export interface Evidence {
  evidenceId: string
  sourceId: string
  excerpt: string
  knowledgeType: KnowledgeType
}

export interface Datum {
  datumId: string
  label: string
  value: string
  unit: string
  period: string
  knowledgeType: KnowledgeType
  sourceId: string
  sourceVersionId: string
  formula?: string
  inputs?: string[]
}

export interface Assumption {
  assumptionId: string
  text: string
  value: string
  supportStatus: 'SCENARIO' | 'SOURCED'
}

export interface EvidenceGapItem {
  kind: 'SOURCE' | 'METRIC' | 'SCOPE' | 'METHOD' | 'CROSS_CHECK' | 'ASSUMPTION'
  description: string
}

export interface EvidenceGap {
  gapId: string
  existingMaterial: string[]
  missingItems: EvidenceGapItem[]
  blockingReason: string
  blockedAction: 'CONFIRM'
}

export interface PathNode {
  kind: 'Conclusion' | 'Claim' | 'Evidence' | 'Datum' | 'Assumption' | 'Source' | 'Locator' | 'EvidenceGap'
  title: string
  body?: string
  meta?: string
}

export interface ConflictValue {
  value: string
  scope: string
  sourceId: string
}

export interface HumanDecision {
  decisionId: string
  action: 'CONFIRM' | 'REJECT'
  decidedAt: string
  decidedText: string
  decisionReason?: string
  scopeNote?: string
  invalidatedAt?: string
  invalidationReason?: string
  sourceUpdateId?: string
}

export interface Revision {
  revisionId: string
  authorType: 'AI' | 'HUMAN'
  originType: OriginType
  text: string
  createdAt: string
  isCurrent: boolean
}

export interface Conclusion {
  conclusionId: string
  displayId: string
  role: string
  knowledgeType: KnowledgeType
  originType: OriginType
  evidenceStatus: EvidenceStatus
  reviewStatus: ReviewStatus
  freshness: Freshness
  candidateSource: 'CACHED_MODEL_OUTPUT' | 'LIVE_SINGLE_ENDPOINT'
  sourceIds: string[]
  text: string
  originalAiText: string
  conflictValues?: ConflictValue[]
  conflictExplanation?: string
  confirmBlockReason?: string
  path: PathNode[]
  decision?: HumanDecision
  decisionHistory?: HumanDecision[]
  revisions: Revision[]
  dependsOnSourceA: boolean
}

export interface AuditFinding {
  findingId: string
  category: 'MISSING_CITATION' | 'UNSUPPORTED_CLAIM' | 'SOURCE_CONFLICT' | 'TYPE_MISMATCH' | 'MISSING_ASSUMPTION' | 'SCOPE_OVERREACH'
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  target: string
  status: 'REPAIRED' | 'NEEDS_REVIEW'
  message: string
  action: string
  before: string
  after: string
}

export interface ArtifactFile {
  kind: 'REPORT' | 'PPTX' | 'JSON'
  fileName: string
  size: string
  sha256: string
  note: string
  url?: string
}

export interface ArtifactVersion {
  artifactVersionId: string
  reportNo: string
  version: number
  createdAt: string
  trigger: 'INITIAL_DELIVER' | 'HUMAN_DECISION' | 'HUMAN_EDIT' | 'SOURCE_UPDATE' | 'REVALIDATION'
  summary: string
  status: 'CURRENT' | 'SUPERSEDED'
  artifacts: ArtifactFile[]
}

export interface ToolEvent {
  toolName: string
  inputSummary: string
  startedAt: string
  status: 'success' | 'failed'
  outputId: string
  duration: string
  error: string | null
}

export interface PlanStep {
  step: number
  name: string
  tool: string
  summary: string
}

export type StepKey = 'PLAN' | 'COLLECT' | 'SYNTHESIZE' | 'AUDIT' | 'DELIVER'

export interface SourceUpdate {
  applied: boolean
  updateId: string
  affected: { objectId: string; kind: string; effect: string }[]
  unaffectedNote: string
}

/* ─── 候选草稿与裁决：AI 提出，程序校验，被否定的也留痕 ─────────── */
export type DraftVerdict = 'ADOPTED' | 'CONFLICT_KEPT' | 'DOWNGRADED' | 'REJECTED'

export interface Draft {
  draftId: string
  text: string
  verdict: DraftVerdict
  reason: string
  mapsTo?: string
}

/* ─── 研究活动流：运行过程中逐条可见的查找 / 校验动作 ──────────── */
export type FeedKind = 'search' | 'read' | 'compute' | 'draft' | 'audit' | 'deliver'
export type FeedVerdict = 'ADOPTED' | 'CONFLICT_KEPT' | 'DOWNGRADED' | 'REJECTED' | 'REPAIRED' | 'PASSED' | 'BLOCKED'

export interface FeedEvent {
  step: StepKey
  kind: FeedKind
  text: string
  verdict?: FeedVerdict
}

/* ─── 研究案例 ─────────────────────────────────────────────────── */
export interface CaseUpdate {
  label: string
  v1Body: string
  v1Note: string
  v2Body: string
  v2Note: string
  effectText: string
  unaffectedNote: string
  recompute: { objectId: string; beforeText: string; afterText: string }
}

export interface CaseData {
  caseId: string
  title: string
  question: string
  scope: string
  tags: string[]
  sources: Source[]
  planSteps: PlanStep[]
  toolEvents: ToolEvent[]
  conclusions: Conclusion[]
  auditFindings: AuditFinding[]
  drafts: Draft[]
  feed: FeedEvent[]
  update: CaseUpdate
  artifactBase: string
}

export interface BoundaryPreset {
  presetId: string
  question: string
  gaps: { kind: 'SOURCE' | 'METRIC' | 'SCOPE' | 'METHOD' | 'CROSS_CHECK' | 'ASSUMPTION'; description: string }[]
}
