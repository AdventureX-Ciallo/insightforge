/* 后端 ResearchRun → 前端视图模型（CaseData 形状）适配层
   后端契约见 src/domain.ts；证据链 path 沿 claim → evidence/datum/assumption → source 图构建 */

import type { ResearchRun } from './api'
import type {
  ArtifactFile,
  ArtifactVersion,
  AuditFinding,
  CaseData,
  Conclusion,
  Draft,
  FeedEvent,
  HumanDecision,
  PathNode,
  PlanStep,
  Source,
  SourceWeight,
  ToolEvent,
} from './types'

const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

const fmtVal = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

const CATEGORY_LABEL: Record<string, string> = {
  GOVERNMENT: '官方发布',
  OFFICIAL: '官方发布',
  ASSOCIATION: '行业协会',
  AUTHORITATIVE_EVENT: '权威信源',
  COMMUNITY: '社交平台',
  USER_UPLOAD: '用户上传',
  SYNTHETIC: '内部资料',
  OTHER: '其他',
}

function mapWeight(confidence?: { overall: number; category: string }): { weight: SourceWeight; weightLabel: string } {
  const label = CATEGORY_LABEL[confidence?.category ?? 'OTHER'] ?? '其他'
  if (!confidence) return { weight: 'MEDIUM', weightLabel: label }
  const weight: SourceWeight = confidence.overall >= 0.75 ? 'HIGH' : confidence.overall >= 0.5 ? 'MEDIUM' : 'LOW'
  return { weight, weightLabel: label }
}

function locatorText(loc: { url?: string; fileName?: string; page?: number; sheet?: string; cellRange?: string; rows?: number[] }): string {
  const parts: string[] = []
  if (loc.url) parts.push(loc.url)
  if (loc.fileName) parts.push(loc.fileName)
  if (loc.page != null) parts.push(`第 ${loc.page} 页`)
  if (loc.sheet) parts.push(`工作表 ${loc.sheet}`)
  if (loc.cellRange) parts.push(`单元格 ${loc.cellRange}`)
  if (loc.rows?.length) parts.push(`行 ${loc.rows.join(',')}`)
  return parts.join(' · ') || '—'
}

function mapSource(s: {
  id: string; publisher: string; title: string; capturedAt: string; excerpt: string
  locator: { url?: string; fileName?: string; page?: number; sheet?: string; cellRange?: string; rows?: number[] }
  materialRole: string; confidence?: { overall: number; category: string; rationale?: string }
}): Source {
  const { weight, weightLabel } = mapWeight(s.confidence)
  const detail = locatorText(s.locator)
  return {
    sourceId: s.id,
    publisher: s.publisher,
    title: s.title,
    date: s.capturedAt.slice(0, 10),
    url: s.locator.url,
    fileName: s.locator.fileName,
    scopeNote: s.confidence?.rationale ?? (s.materialRole === 'SYNTHETIC_DEMO_MATERIAL' ? '内部整理资料 · 仅作参考材料' : s.materialRole),
    weight,
    weightLabel,
    synthetic: s.materialRole === 'SYNTHETIC_DEMO_MATERIAL' || s.materialRole === 'USER_UPLOAD',
    locators: [
      {
        kind: s.locator.url ? 'WEB_ANCHOR' : s.locator.page != null ? 'PDF_PAGE' : 'CSV_CELL',
        label: '定位',
        detail,
      },
    ],
  }
}

const ROLE_BY_STATUS: Record<string, string> = {
  CONFLICT: '口径冲突判断',
  INSUFFICIENT_EVIDENCE: '不能下结论项',
}
const ROLE_BY_TYPE: Record<string, string> = {
  CALCULATION: '计算判断',
  ESTIMATE: '带假设估算',
  FORECAST: '预测判断',
  SOURCE_OPINION: '来源观点',
  FACT: '事实判断',
}

function gapBody(g: { existingEvidenceIds: string[]; existingDatumIds: string[]; missingItems: { kind: string; description: string }[]; blockingReason: string }): string {
  const missing = g.missingItems.map((m, i) => `${'①②③④⑤'[i] ?? ''} ${m.description}（${m.kind}）`).join('\n')
  return `已有材料：${g.existingEvidenceIds.length} 条 Evidence · ${g.existingDatumIds.length} 个 Datum。\n缺少：\n${missing}\n为何不能确认：${g.blockingReason}，blockedAction = CONFIRM。`
}

function buildPath(run: ResearchRun, c: { claimIds: string[]; sourceIds: string[]; normalizedEvidenceStatus: string }): PathNode[] {
  const nodes: PathNode[] = []
  for (const claimId of c.claimIds) {
    const claim = run.claims.find((x: { id: string }) => x.id === claimId)
    if (!claim) continue
    nodes.push({
      kind: 'Claim',
      title: trim(claim.text, 56),
      body: `${claim.id} · 消费 ${claim.evidenceIds.length} 条 Evidence · ${claim.datumIds.length} 个 Datum`,
    })
    for (const aid of claim.assumptionIds ?? []) {
      const a = run.assumptions.find((x: { id: string }) => x.id === aid)
      if (a) nodes.push({ kind: 'Assumption', title: trim(a.text, 56), body: a.value != null ? `取值 ${a.value}${a.unit ?? ''}` : undefined, meta: a.owner })
    }
    for (const eid of claim.evidenceIds ?? []) {
      const e = run.evidence.find((x: { id: string }) => x.id === eid)
      if (e) nodes.push({ kind: 'Evidence', title: trim(e.excerpt, 56), body: e.excerpt, meta: `${e.sourceId} · ${e.knowledgeType}` })
    }
    for (const did of claim.datumIds ?? []) {
      const d = run.data.find((x: { id: string }) => x.id === did)
      if (d)
        nodes.push({
          kind: 'Datum',
          title: `${d.metric} = ${fmtVal(d.value)}${d.unit}`,
          body: d.formula ? `公式 ${d.formula} · 期间 ${d.period}` : `期间 ${d.period}`,
          meta: d.originType,
        })
    }
    if (claim.evidenceGapId) {
      const g = run.evidenceGaps.find((x: { id: string }) => x.id === claim.evidenceGapId)
      if (g) nodes.push({ kind: 'EvidenceGap', title: `证据缺口 · ${g.id}`, body: gapBody(g), meta: 'blockedAction: CONFIRM' })
    }
  }
  const srcs = c.sourceIds
    .map((id) => run.sources.find((s: { id: string }) => s.id === id))
    .filter(Boolean)
  if (srcs.length > 0) {
    nodes.push({
      kind: 'Source',
      title: srcs.map((s: { id: string }) => s.id).join(' / '),
      body: srcs.map((s: { publisher: string; title: string }) => `${s.publisher}《${trim(s.title, 30)}》`).join('；'),
    })
    nodes.push({
      kind: 'Locator',
      title: '定位',
      body: srcs.map((s: { id: string; locator: Parameters<typeof locatorText>[0] }) => `${s.id}：${locatorText(s.locator)}`).join('\n'),
    })
  }
  return nodes
}

function mapDecision(d: {
  id: string; action: string; decidedAt: string; resultingText: string
  decisionReason: string | null; scopeNote: string | null
  invalidatedAt: string | null; invalidationReason: string | null; sourceUpdateId: string | null
}): HumanDecision | null {
  if (d.action !== 'CONFIRM' && d.action !== 'REJECT') return null
  return {
    decisionId: d.id,
    action: d.action,
    decidedAt: d.decidedAt,
    decidedText: d.resultingText,
    decisionReason: d.decisionReason ?? undefined,
    scopeNote: d.scopeNote ?? undefined,
    invalidatedAt: d.invalidatedAt ?? undefined,
    invalidationReason: d.invalidationReason ?? undefined,
    sourceUpdateId: d.sourceUpdateId ?? undefined,
  }
}

function mapConclusion(run: ResearchRun, c: {
  id: string; text: string; originalAiText: string; claimIds: string[]; sourceIds: string[]
  originType: Conclusion['originType']; normalizedEvidenceStatus: Conclusion['evidenceStatus']
  normalizedReviewStatus: Conclusion['reviewStatus']; freshness: Conclusion['freshness']
}, index: number): Conclusion {
  const decisions = (run.humanDecisions as Parameters<typeof mapDecision>[0][])
    .filter((d) => (d as unknown as { conclusionId: string }).conclusionId === c.id)
    .map(mapDecision)
    .filter((d): d is HumanDecision => d !== null)
  const current = decisions.find((d) => !d.invalidatedAt) ?? null
  const history = decisions.filter((d) => d !== current)

  const claim = run.claims.find((x: { id: string }) => x.id === c.claimIds[0])
  const knowledgeType = claim?.knowledgeType ?? 'FACT'
  const role = ROLE_BY_STATUS[c.normalizedEvidenceStatus] ?? ROLE_BY_TYPE[knowledgeType] ?? '事实判断'

  /* 冲突双值：从 run.conflicts 的 datum 解析 */
  let conflictValues: Conclusion['conflictValues']
  let conflictExplanation: string | undefined
  if (c.normalizedEvidenceStatus === 'CONFLICT') {
    const conflict = run.conflicts.find((cf: { datumIds: string[] }) =>
      cf.datumIds.some((did) => claim?.datumIds?.includes(did) || run.data.find((d: { id: string }) => d.id === did)),
    )
    if (conflict) {
      conflictValues = conflict.datumIds
        .map((did: string) => run.data.find((d: { id: string }) => d.id === did))
        .filter(Boolean)
        .map((d: { value: number; unit: string; metric: string; period: string; sourceIds: string[] }) => ({
          value: `${fmtVal(d.value)}${d.unit}`,
          scope: `${d.metric} · ${d.period}`,
          sourceId: d.sourceIds[0] ?? '',
        }))
      conflictExplanation = `候选解释：${conflict.explanation} 解释仍为候选，不能自动认定为唯一原因。`
    }
  }

  return {
    conclusionId: c.id,
    displayId: `C${index + 1}`,
    role,
    knowledgeType,
    originType: c.originType,
    evidenceStatus: c.normalizedEvidenceStatus,
    reviewStatus: c.normalizedReviewStatus,
    freshness: c.freshness,
    candidateSource: run.modelProvenance?.synthesisSource === 'LIVE_SINGLE_ENDPOINT' ? 'LIVE_SINGLE_ENDPOINT' : 'CACHED_MODEL_OUTPUT',
    sourceIds: c.sourceIds,
    text: c.text,
    originalAiText: c.originalAiText,
    conflictValues,
    conflictExplanation,
    confirmBlockReason: c.normalizedEvidenceStatus === 'INSUFFICIENT_EVIDENCE' ? '证据不足 · EvidenceGap 未解决前禁止确认' : undefined,
    path: buildPath(run, c),
    decision: current ?? undefined,
    decisionHistory: history.length > 0 ? history : undefined,
    revisions: (run.candidateRevisions as { id: string; conclusionId: string; authorType: 'AI' | 'HUMAN' | 'SYSTEM'; originType: string; text: string; createdAt: string; isCurrent: boolean }[])
      .filter((r) => r.conclusionId === c.id)
      .map((r) => ({
        revisionId: r.id,
        authorType: r.authorType === 'HUMAN' ? ('HUMAN' as const) : ('AI' as const),
        originType: (r.originType === 'HUMAN_EDITED' ? 'HUMAN_EDITED' : 'AI_JUDGMENT') as Conclusion['originType'],
        text: r.text,
        createdAt: r.createdAt,
        isCurrent: r.isCurrent,
      })),
    dependsOnSourceA: false, // 由调用方依据 affectedObjectIds / sourceVersions 回填
  }
}

const TOOL_STEP: Record<string, FeedEvent['step']> = {
  'cached-model-planner': 'PLAN',
  'llm-planner': 'PLAN',
  'snapshot-search': 'COLLECT',
  'live-source-search': 'COLLECT',
  'authority-source-check': 'COLLECT',
  'pdf-reader': 'COLLECT',
  'local-file-reader': 'COLLECT',
  'csv-calculator': 'COLLECT',
  'cached-model-synthesizer': 'SYNTHESIZE',
  'llm-synthesizer': 'SYNTHESIZE',
  'pptx-generator': 'DELIVER',
}
const TOOL_KIND: Record<string, FeedEvent['kind']> = {
  'snapshot-search': 'search',
  'live-source-search': 'search',
  'authority-source-check': 'search',
  'pdf-reader': 'read',
  'local-file-reader': 'read',
  'csv-calculator': 'compute',
  'cached-model-planner': 'draft',
  'llm-planner': 'draft',
  'cached-model-synthesizer': 'draft',
  'llm-synthesizer': 'draft',
  'pptx-generator': 'deliver',
}

const TOOL_LABEL: Record<string, string> = {
  'snapshot-search': '快照检索',
  'live-source-search': '实时信源检索',
  'authority-source-check': '白名单权威核验',
  'pdf-reader': 'PDF 逐页读取',
  'local-file-reader': '本地文件读取',
  'csv-calculator': '表格确定性计算',
  'cached-model-planner': '计划快照校验',
  'cached-model-synthesizer': '综合快照校验',
  'llm-planner': '模型提出计划',
  'llm-synthesizer': '模型提出候选',
  'pptx-generator': '生成五页 PPTX',
}

export function toolEventToFeed(e: { toolName: string; inputSummary: string; outputId: string; status: string }): FeedEvent {
  return {
    step: TOOL_STEP[e.toolName] ?? 'COLLECT',
    kind: TOOL_KIND[e.toolName] ?? 'read',
    text: `${TOOL_LABEL[e.toolName] ?? e.toolName} · ${e.inputSummary} → ${e.outputId}${e.status === 'failed' ? '（失败）' : ''}`,
  }
}

/* 机器 ID → 用户可读标签：结论映射到 C 编号，其余按对象类型命名 */
export function displayNameFor(id: string, conclusions: Conclusion[]): string {
  const c = conclusions.find((x) => x.conclusionId === id)
  if (c) return c.displayId
  if (id.startsWith('source-version')) return '来源版本'
  if (id.startsWith('source-')) return '来源'
  if (id.startsWith('evidence-')) return '证据'
  if (id.startsWith('datum-')) return '数据项'
  if (id.startsWith('claim-')) return '主张'
  if (id.startsWith('revision-')) return '修订版本'
  if (id === 'run') return '整体运行'
  return id
}

const SEVERITY_MAP: Record<string, AuditFinding['severity']> = { critical: 'HIGH', warning: 'MEDIUM', info: 'LOW' }

const AUDIT_LABEL: Record<string, string> = {
  MISSING_CITATION: '引用缺失检查',
  UNSUPPORTED_CLAIM: '无支撑候选检查',
  SOURCE_CONFLICT: '来源冲突检查',
  TYPE_MISMATCH: '类型不匹配检查',
  MISSING_ASSUMPTION: '假设缺失检查',
  SCOPE_OVERREACH: '范围越界检查',
}

/* 运行完成后从结论与审查结果合成 SYNTHESIZE / AUDIT 段的活动流 */
export function completionFeed(run: ResearchRun): FeedEvent[] {
  const draftEvents: FeedEvent[] = (run.conclusions as { id: string; text: string; normalizedEvidenceStatus: string }[]).map((c, i) => ({
    step: 'SYNTHESIZE' as const,
    kind: 'draft' as const,
    text: `候选草稿 #${i + 1} 「${trim(c.text, 30)}」`,
    verdict:
      c.normalizedEvidenceStatus === 'CONFLICT'
        ? ('CONFLICT_KEPT' as const)
        : c.normalizedEvidenceStatus === 'INSUFFICIENT_EVIDENCE'
          ? ('DOWNGRADED' as const)
          : ('ADOPTED' as const),
  }))
  const auditEvents: FeedEvent[] = (run.auditFindings as { category: string; targetId: string; status: string; message: string }[]).map((f) => ({
    step: 'AUDIT' as const,
    kind: 'audit' as const,
    text: `${AUDIT_LABEL[f.category] ?? f.category} · ${f.message}`,
    verdict:
      f.status === 'PASSED'
        ? ('PASSED' as const)
        : f.status === 'REPAIRED'
          ? ('REPAIRED' as const)
          : ('BLOCKED' as const),
  }))
  return [...draftEvents, ...auditEvents]
}

const fmtSize = (n: number) => `${(n / 1024).toFixed(1)} KB`
const shortSha = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s)

const KIND_MAP: Record<string, ArtifactFile['kind']> = {
  PPTX: 'PPTX',
  EVIDENCE_JSON: 'JSON',
  REPORT_MD: 'REPORT',
  REPORT_PDF: 'REPORT',
}

export interface AdaptedArtifacts {
  versions: ArtifactVersion[]
  currentByKind: { kind: string; fileName: string; size: string; sha256: string; url: string }[]
  evictedCount: number
}

export function adaptArtifacts(run: ResearchRun): AdaptedArtifacts {
  const records = (run.artifacts ?? []) as { id: string; kind: string; fileName: string; sizeBytes: number; sha256: string; version: number }[]
  const byId = new Map(records.map((r) => [r.id, r]))
  const versions: ArtifactVersion[] = ((run.artifactVersions ?? []) as {
    id: string; version: number; createdAt: string; trigger: ArtifactVersion['trigger']
    adjustmentNote: string; status: 'CURRENT' | 'SUPERSEDED'; artifactIds: string[]
  }[]).map((av) => {
    return {
      artifactVersionId: av.id,
      reportNo: '',
      version: av.version,
      createdAt: av.createdAt,
      trigger: av.trigger,
      summary: av.adjustmentNote,
      status: av.status,
      artifacts: av.artifactIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((r) => ({
          kind: KIND_MAP[r!.kind] ?? 'REPORT',
          fileName: r!.fileName,
          size: fmtSize(r!.sizeBytes),
          sha256: shortSha(r!.sha256),
          note: '',
          url: `/api/runs/${run.id}/artifacts/${r!.kind}?version=${av.version}`,
        })),
    }
  })
  const current = versions.find((v) => v.status === 'CURRENT') ?? versions[0]
  const currentRaw = ((run.artifactVersions ?? []) as { id: string; status: string; artifactIds: string[] }[]).find(
    (av) => av.id === current?.artifactVersionId,
  )
  const currentByKind = (currentRaw?.artifactIds ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({
      kind: r!.kind,
      fileName: r!.fileName,
      size: fmtSize(r!.sizeBytes),
      sha256: shortSha(r!.sha256),
      url: `/api/runs/${run.id}/artifacts/${r!.kind}?version=${r!.version}`,
    }))
  return { versions, currentByKind, evictedCount: run.evictedArtifactVersionCount ?? 0 }
}

/* 主入口：ResearchRun → CaseData 形状的视图模型 */
export function adaptRun(run: ResearchRun, isGolden: boolean): CaseData & { isGolden: boolean; sourceUpdateSupported: boolean } {
  const sources = (run.sources as Parameters<typeof mapSource>[0][]).map(mapSource)
  const planSteps: PlanStep[] = (run.plan?.steps ?? []).map(
    (s: { id: string; objective: string; toolName: string; expectedOutput: string }, i: number) => ({
      step: i + 1,
      name: s.objective,
      tool: s.toolName,
      summary: s.expectedOutput,
    }),
  )
  const toolEvents: ToolEvent[] = (run.events ?? []).map((e: { toolName: string; inputSummary: string; startedAt: string; status: 'success' | 'failed'; outputId: string; duration: number; error: string | null }) => ({
    toolName: e.toolName,
    inputSummary: e.inputSummary,
    startedAt: e.startedAt,
    status: e.status,
    outputId: e.outputId,
    duration: `${e.duration.toFixed(2)}s`,
    error: e.error,
  }))
  const conclusions = (run.conclusions as Parameters<typeof mapConclusion>[1][]).map((c, i) => mapConclusion(run, c, i))

  /* 来源 A 依赖与版本链：从 sourceVersions 派生，不写死文案 */
  const versionedIds = new Set(
    (run.sourceVersions ?? [])
      .filter((sv: { version: string }) => sv.version === 'v1' || sv.version === 'v2')
      .map((sv: { sourceId: string }) => sv.sourceId),
  )
  for (const c of conclusions) {
    c.dependsOnSourceA = c.sourceIds.some((id) => versionedIds.has(id)) || (run.affectedObjectIds ?? []).includes(c.conclusionId)
  }

  const svList = (run.sourceVersions ?? []) as { sourceId: string; version: string; knowledgeType: string; capturedAt: string; sha256: string }[]
  const aSourceId = [...versionedIds][0]
  const sv1 = svList.find((sv) => sv.sourceId === aSourceId && sv.version === 'v1')
  const sv2 = svList.find((sv) => sv.sourceId === aSourceId && sv.version === 'v2')
  const firstAffected = conclusions.find((c) => c.dependsOnSourceA)?.conclusionId ?? '—'
  const update: CaseData['update'] = {
    label: aSourceId ? `来源 ${aSourceId} · 版本链` : '来源版本链',
    v1Body: sv1 ? `v1 · ${sv1.knowledgeType} 输入 · ${sv1.capturedAt.slice(0, 10)}` : 'v1 · 旧版输入',
    v1Note: sv1 ? `SHA-256 ${shortSha(sv1.sha256)}` : '',
    v2Body: sv2 ? `v2 · ${sv2.knowledgeType} 终值 · ${sv2.capturedAt.slice(0, 10)}` : 'v2 · 新版 / 终值',
    v2Note: sv2 ? `SHA-256 ${shortSha(sv2.sha256)}` : '',
    effectText: '依赖来源 A 的旧版输入被新版替换 → STALE / NEEDS_REVIEW',
    unaffectedNote: '',
    recompute: {
      objectId: firstAffected,
      beforeText: sv1 ? `v1 ${sv1.knowledgeType} 输入` : 'v1 旧版输入',
      afterText: sv2 ? `v2 ${sv2.knowledgeType} 终值` : 'v2 新版终值',
    },
  }

  const drafts: Draft[] = conclusions.map((c, i) => ({
    draftId: `#${i + 1}`,
    text: c.text,
    verdict:
      c.evidenceStatus === 'CONFLICT' ? 'CONFLICT_KEPT' : c.evidenceStatus === 'INSUFFICIENT_EVIDENCE' ? 'DOWNGRADED' : 'ADOPTED',
    reason:
      c.evidenceStatus === 'CONFLICT'
        ? '两条 Evidence 口径不同 → 保留为冲突，双值并列'
        : c.evidenceStatus === 'INSUFFICIENT_EVIDENCE'
          ? '越过证据范围 → 降级为证据不足'
          : '证据链完整 → 采纳',
    mapsTo: c.displayId,
  }))

  /* 后端真实否决留痕（#46）：被程序校验否决的草稿与丢弃原因 */
  const DROP_REASON_LABEL: Record<string, string> = {
    UNKNOWN_EVIDENCE_ID: '引用了不存在的证据 ID，无法定位 → 否决',
    TEXT_TOO_SHORT: '文本过短，不构成有效判断 → 否决',
    TEXT_TOO_LONG: '文本超出长度上限 → 否决',
    NO_EVIDENCE: '未引用任何证据 → 否决',
    EVIDENCE_LIMIT_EXCEEDED: '引用数量超限 → 否决',
    AUXILIARY_LIMIT_EXCEEDED: '辅助字段超限 → 否决',
    PROMPT_INJECTION_ECHO: '复述了来源中的注入诱饵 → 否决',
    DUPLICATE: '与已有候选实质重复 → 否决',
  }
  for (const rd of (run.rejectedDrafts ?? []) as { draftIndex: number; text: string; evidenceIds: string[]; dropReason: string }[]) {
    drafts.push({
      draftId: `#${rd.draftIndex + 1}`,
      text: rd.text,
      verdict: 'REJECTED',
      reason: DROP_REASON_LABEL[rd.dropReason] ?? `程序校验否决（${rd.dropReason}）`,
    })
  }

  const auditFindings: AuditFinding[] = (run.auditFindings ?? []).map(
    (f: { id: string; category: AuditFinding['category']; severity: string; targetId: string; status: string; message: string; action: string; before: string; after: string }) => ({
      findingId: f.id,
      category: f.category,
      severity: SEVERITY_MAP[f.severity] ?? 'LOW',
      target: displayNameFor(f.targetId, conclusions),
      status: f.status === 'REPAIRED' ? 'REPAIRED' : 'NEEDS_REVIEW',
      message: f.message,
      action: f.action,
      before: f.before,
      after: f.after,
    }),
  )

  return {
    caseId: 'api-run',
    title: '研究运行',
    question: run.researchQuestion,
    scope: run.plan?.scope ?? '',
    tags: ['口径冲突', '确定性计算', '情景估算', '证据缺口'],
    sources,
    planSteps,
    toolEvents,
    conclusions,
    auditFindings,
    drafts,
    feed: [],
    update,
    artifactBase: 'insightforge-report',
    isGolden,
    /* 后端 #45 已修复：source-update 按依赖图解析，黄金问题的运行均可执行 */
    sourceUpdateSupported: isGolden,
  }
}
