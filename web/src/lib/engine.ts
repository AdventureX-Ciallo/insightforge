import { useSyncExternalStore } from 'react'
import type {
  ArtifactVersion,
  CaseData,
  Conclusion,
  FeedEvent,
  Modes,
  RunTerminal,
  SourceUpdate,
  StepKey,
  StepStatus,
} from './types'
import { adaptArtifacts, adaptRun, completionFeed, displayNameFor, toolEventToFeed } from './adapter'
import { api, subscribeRunEvents } from './api'

export interface ApiFile {
  kind: string
  fileName: string
  size: string
  sha256: string
  url: string
}

export interface Preset {
  id: string
  question: string
  kind: 'golden' | 'boundary'
  description: string
}

export interface AppState {
  backend: 'unknown' | 'online' | 'offline'
  runId: string | null
  isGolden: boolean
  sourceUpdateSupported: boolean
  phase: 'idle' | 'running' | 'done'
  steps: Record<StepKey, StepStatus>
  terminal: RunTerminal | null
  modes: Modes
  view: CaseData
  conclusions: Conclusion[]
  feed: FeedEvent[]
  artifacts: ArtifactVersion[]
  apiFiles: ApiFile[]
  evictedCount: number
  sourceUpdate: SourceUpdate
  updateError: string | null
  startedAt: string | null
  presets: Preset[]
  uploadedIds: string[]
}

const initialSteps = (): Record<StepKey, StepStatus> => ({
  PLAN: 'pending',
  COLLECT: 'pending',
  SYNTHESIZE: 'pending',
  AUDIT: 'pending',
  DELIVER: 'pending',
})

const emptyUpdate: CaseData['update'] = {
  label: '来源版本链',
  v1Body: '—',
  v1Note: '',
  v2Body: '—',
  v2Note: '',
  effectText: '',
  unaffectedNote: '',
  recompute: { objectId: '—', beforeText: '—', afterText: '—' },
}

const idleView = (question = ''): CaseData => ({
  caseId: 'idle',
  title: '',
  question,
  scope: '',
  tags: [],
  sources: [],
  planSteps: [],
  toolEvents: [],
  conclusions: [],
  auditFindings: [],
  drafts: [],
  feed: [],
  update: emptyUpdate,
  artifactBase: 'insightforge-report',
})

const freshState = (question = '', isGolden = false): AppState => ({
  backend: 'unknown',
  runId: null,
  isGolden,
  sourceUpdateSupported: false,
  phase: 'idle',
  steps: initialSteps(),
  terminal: null,
  modes: {
    sourceDiscovery: 'OFFLINE_SNAPSHOT',
    authorityVerification: 'NOT_RUN',
    synthesis: 'CACHED_MODEL_OUTPUT',
  },
  view: idleView(question),
  conclusions: [],
  feed: [],
  artifacts: [],
  apiFiles: [],
  evictedCount: 0,
  sourceUpdate: { applied: false, updateId: 'srcA-v2', affected: [], unaffectedNote: '' },
  updateError: null,
  startedAt: null,
  presets: [],
  uploadedIds: [],
})

let state: AppState = freshState()
const listeners = new Set<() => void>()

/* 本地视图重置后，恢复时跳过被用户放弃的运行 */
const dismissed = new Set<string>()

function setState(patch: Partial<AppState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useApp(): AppState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}

const now = () =>
  new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

let runToken = 0
let closeSse: (() => void) | null = null

/* ─── 后端探测、presets 与恢复 ─────────────────────────────────── */
export async function detectBackend() {
  try {
    await api.health()
    const presets = await api.presets().catch(() => [] as Preset[])
    setState({ backend: 'online', presets })
    await restoreFromBackend(presets)
  } catch {
    setState({ backend: 'offline' })
  }
}

async function restoreFromBackend(presets: Preset[]) {
  try {
    const { run, job } = await api.current()
    if (job?.status === 'running' && job.researchQuestion && !dismissed.has(job.runId)) {
      const token = ++runToken
      const isGolden = isGoldenQuestion(presets, job.researchQuestion)
      const steps = initialSteps()
      for (const step of job.steps) steps[step.state] = step.status
      setState({
        ...freshState(job.researchQuestion, isGolden),
        backend: 'online',
        presets,
        runId: job.runId,
        phase: 'running',
        steps,
        startedAt: job.createdAt,
      })
      followRun(job.runId, token, isGolden)
      return
    }
    if (job?.status === 'failed' && job.researchQuestion && (!run || job.runId !== run.id) && !dismissed.has(job.runId)) {
      const steps = initialSteps()
      for (const step of job.steps) steps[step.state] = step.status
      setState({
        ...freshState(job.researchQuestion, isGoldenQuestion(presets, job.researchQuestion)),
        backend: 'online',
        presets,
        runId: job.runId,
        phase: 'done',
        steps,
        terminal: 'FAILED',
        updateError: job.error ?? '上次运行未完成',
        startedAt: job.createdAt,
      })
      return
    }
    if (!run || dismissed.has(run.id)) return
    applyRun(run, isGoldenQuestion(presets, run.researchQuestion))
  } catch {
    /* 404 = 没有运行记录 */
  }
}

function followRun(runId: string, token: number, isGolden: boolean) {
  closeSse = subscribeRunEvents(runId, {
    onStep: (backendSteps) => {
      const steps = initialSteps()
      for (const step of backendSteps) steps[step.state] = step.status
      setState({ steps })
    },
    onTool: (event) => {
      setState({ feed: [...state.feed, toolEventToFeed(event)] })
    },
    onTerminal: (status) => {
      if (status === 'completed') void finishFromApi(runId, token, isGolden)
      else setState({ phase: 'done', terminal: 'FAILED', updateError: '研究运行失败，请查看步骤状态后重试' })
    },
    onError: () => {
      void pollRun(runId, token, isGolden)
    },
  })
}

const isGoldenQuestion = (presets: Preset[], question: string) =>
  presets.some((p) => p.kind === 'golden' && p.question === question)

function applyRun(run: Parameters<typeof adaptRun>[0], isGolden: boolean) {
  const view = adaptRun(run, isGolden)
  const { versions, currentByKind, evictedCount } = adaptArtifacts(run)
  const sourceUpdateSupported = view.sourceUpdateSupported
  const steps = initialSteps()
  for (const s of run.steps ?? []) steps[s.state as StepKey] = s.status
  setState({
    runId: run.id,
    isGolden,
    sourceUpdateSupported,
    phase: 'done',
    steps,
    terminal: run.terminalStatus,
    modes: {
      sourceDiscovery: run.sourceDiscoveryMode,
      authorityVerification: run.authorityVerificationMode,
      synthesis: run.synthesisMode,
    },
    view,
    conclusions: view.conclusions,
    feed: [...(run.events ?? []).map(toolEventToFeed), ...completionFeed(run)],
    artifacts: versions,
    apiFiles: currentByKind,
    evictedCount,
    sourceUpdate: {
      applied: run.sourceVersion === 'v2',
      updateId: 'srcA-v2',
      affected: (run.affectedObjectIds ?? []).map((id: string) => ({
        objectId: displayNameFor(id, view.conclusions),
        kind: 'Conclusion',
        effect: view.update.effectText,
      })),
      unaffectedNote: '',
    },
    startedAt: run.createdAt,
  })
}

/* ─── 选题与启动 ───────────────────────────────────────────────── */
export function selectPreset(preset: Preset) {
  const abandonedRunId = state.phase === 'running' ? state.runId : null
  runToken++
  closeSse?.()
  if (abandonedRunId) void api.cancelRun(abandonedRunId).catch(() => undefined)
  setState({ ...freshState(preset.question, preset.kind === 'golden'), backend: state.backend, presets: state.presets, uploadedIds: state.uploadedIds })
}

export async function startRun() {
  if (state.backend !== 'online') return
  const abandonedRunId = state.phase === 'running' ? state.runId : null
  const token = ++runToken
  closeSse?.()
  if (abandonedRunId) void api.cancelRun(abandonedRunId).catch(() => undefined)
  const { question } = state.view
  const { isGolden, presets } = state
  const uploadIds = state.uploadedIds
  setState({ ...freshState(question, isGolden), backend: 'online', presets, phase: 'running', startedAt: now() })
  try {
    const { runId } = await api.createRun(question, uploadIds)
    if (token !== runToken) return
    setState({ runId, uploadedIds: [] })
    followRun(runId, token, isGolden)
  } catch (e) {
    setState({ phase: 'done', terminal: 'FAILED', updateError: e instanceof Error ? e.message : '创建运行失败' })
  }
}

async function pollRun(runId: string, token: number, isGolden: boolean) {
  for (let i = 0; i < 60; i++) {
    if (token !== runToken) return
    try {
      const { job, run } = await api.getRun(runId)
      const steps = initialSteps()
      for (const s of job.steps) steps[s.state] = s.status
      setState({ steps })
      if (job.status === 'completed' && run) {
        applyRun(run, isGolden)
        return
      }
      if (job.status === 'failed') {
        setState({ phase: 'done', terminal: 'FAILED' })
        return
      }
    } catch {
      /* 继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (token === runToken) setState({ phase: 'done', terminal: 'FAILED', updateError: '无法确认任务最终状态，请检查后端连接后重试' })
}

async function finishFromApi(runId: string, token: number, isGolden: boolean) {
  if (token !== runToken) return
  try {
    const { run } = await api.getRun(runId)
    if (run) applyRun(run, isGolden)
  } catch {
    setState({ phase: 'done', terminal: 'FAILED' })
  }
}

export async function resumeRun() {
  if (state.backend === 'unknown') await detectBackend()
}

/* ─── 人工决定 ─────────────────────────────────────────────────── */
export async function confirmConclusion(id: string, reason?: string, scope?: string) {
  if (!state.runId) return
  const { run } = await api.decide(state.runId, { conclusionId: id, action: 'CONFIRM', reason, scopeNote: scope })
  applyRun(run, state.isGolden)
}

export async function rejectConclusion(id: string, reason?: string) {
  if (!state.runId) return
  const { run } = await api.decide(state.runId, { conclusionId: id, action: 'REJECT', reason })
  applyRun(run, state.isGolden)
}

/** 编辑只产生 HUMAN_EDITED 新候选版本，不自动确认 */
export async function editConclusion(id: string, text: string) {
  if (!state.runId) return
  const { run } = await api.decide(state.runId, { conclusionId: id, action: 'EDIT', text })
  applyRun(run, state.isGolden)
}

/** 载入来源 A 最新版本：精确失效依赖它的对象，负对照不变 */
export async function applySourceUpdate() {
  if (state.sourceUpdate.applied || state.phase !== 'done' || !state.runId) return
  try {
    const { run } = await api.sourceUpdate(state.runId)
    applyRun(run, state.isGolden)
  } catch (e) {
    const raw = e instanceof Error ? e.message : ''
    const friendly = raw.includes('Source dependency chain is incomplete')
      ? '本次运行由实时模型生成，内置 v1→v2 更新链仅适用于缓存快照模式下的新能源案例'
      : raw || '来源更新失败'
    setState({ updateError: friendly })
  }
}

/* ─── 上传入链 ─────────────────────────────────────────────────── */
export function registerUpload(id: string) {
  if (state.uploadedIds.includes(id)) return
  if (state.uploadedIds.length >= 5) throw new Error('每次研究最多选择 5 个上传资料')
  setState({ uploadedIds: [...state.uploadedIds, id] })
}

export function removeUpload(id: string) {
  setState({ uploadedIds: state.uploadedIds.filter((candidate) => candidate !== id) })
}

/** 基于当前来源复核 STALE 结论（后端 #47 端点） */
export async function revalidateConclusion(id: string) {
  if (!state.runId) return
  const { run } = await api.revalidate(state.runId, id)
  applyRun(run, state.isGolden)
}

export function resetAll() {
  const abandonedRunId = state.phase === 'running' ? state.runId : null
  runToken++
  closeSse?.()
  if (abandonedRunId) void api.cancelRun(abandonedRunId).catch(() => undefined)
  if (state.runId) dismissed.add(state.runId)
  setState({ ...freshState(), backend: state.backend, presets: state.presets })
}
