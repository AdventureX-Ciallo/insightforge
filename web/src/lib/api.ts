/* InsightForge 后端 API 客户端 — 契约见后端 src/server.ts 与 src/domain.ts */

export interface BackendStep {
  state: 'PLAN' | 'COLLECT' | 'SYNTHESIZE' | 'AUDIT' | 'DELIVER'
  status: 'pending' | 'running' | 'success' | 'failed'
  outputId: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  summary: string
}

export interface BackendToolEvent {
  id: string
  toolName: string
  inputSummary: string
  startedAt: string
  status: 'success' | 'failed'
  outputId: string
  duration: number
  error: string | null
}

/* ResearchRun 的完整形状见后端 src/domain.ts；前端只声明消费到的字段（松散类型） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResearchRun = any

export interface RunJob {
  runId: string
  researchQuestion: string | null
  createdAt: string | null
  status: 'running' | 'completed' | 'failed'
  steps: BackendStep[]
  error: string | null
}

const BASE = '/api'

/* 边界凭据：CSRF token（可选开启）+ request-key（上游默认强制） */
let csrfToken: string | null = null
let requestKey: string | null = null

async function ensureBoundary(): Promise<void> {
  if (csrfToken !== null && requestKey !== null) return
  try {
    const [csrfRes, keyRes] = await Promise.all([
      fetch(`${BASE}/csrf`).then((r) => r.json() as Promise<{ token: string | null; required: boolean }>).catch(() => null),
      fetch(`${BASE}/request-key`).then((r) => r.json() as Promise<{ requestKey: string }>).catch(() => null),
    ])
    csrfToken = csrfRes ? (csrfRes.required ? csrfRes.token : '') : ''
    requestKey = keyRes?.requestKey ?? ''
  } catch {
    csrfToken = ''
    requestKey = ''
  }
}

function boundaryHeaders(headers: Headers): Headers {
  if (csrfToken) headers.set('x-insightforge-csrf', csrfToken)
  if (requestKey) headers.set('x-insightforge-request-key', requestKey)
  return headers
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== 'GET') await ensureBoundary()
  const headers = boundaryHeaders(new Headers(init?.headers))
  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    let message = `${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const api = {
  health: () => req<{ ok: boolean; offlineDemo: boolean; defaultSynthesisMode: string }>('/health'),

  current: () => req<{ run: ResearchRun | null; job: RunJob | null }>('/current'),

  presets: () => req<{ id: string; question: string; kind: 'golden' | 'boundary'; description: string }[]>('/presets'),

  createRun: (researchQuestion: string, uploadIds: string[] = [], idempotencyKey = crypto.randomUUID()) =>
    req<{ runId: string; statusUrl: string }>('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-insightforge-idempotency-key': idempotencyKey },
      body: JSON.stringify({ researchQuestion, uploadIds }),
    }),

  getRun: (runId: string) => req<{ job: RunJob; run?: ResearchRun }>(`/runs/${runId}`),

  cancelRun: (runId: string) => req<{ job: RunJob }>(`/runs/${runId}/cancel`, { method: 'POST' }),

  decide: (runId: string, body: { conclusionId: string; action: 'CONFIRM' | 'REJECT' | 'EDIT'; text?: string; reason?: string; scopeNote?: string }) =>
    req<{ run: ResearchRun }>(`/runs/${runId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  sourceUpdate: (runId: string) =>
    req<{ run: ResearchRun }>(`/runs/${runId}/source-update`, { method: 'POST' }),

  revalidate: (runId: string, conclusionId: string) =>
    req<{ run: ResearchRun }>(`/runs/${runId}/conclusions/${conclusionId}/revalidate`, { method: 'POST' }),

  artifactVersions: (runId: string) => req<unknown[]>(`/runs/${runId}/artifact-versions`),

  artifactUrl: (runId: string, kind: string, version?: number) =>
    `${BASE}/runs/${runId}/artifacts/${kind}${version ? `?version=${version}` : ''}`,

  liveSearch: async (query: string, engine: 'bing' | 'google' | 'baidu') => {
    const response = await req<{
      engine: 'bing' | 'google' | 'baidu'
      query: string
      capturedAt: string
      candidates: { title: string; url: string; engine: 'bing' | 'google' | 'baidu' }[]
    }>('/sources/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine, query }),
    })
    return { provider: response.engine, query: response.query, capturedAt: response.capturedAt, results: response.candidates }
  },

  liveCheck: () =>
    req<{ mode: string; checkedAt: string; results: { title: string; url: string; status: string; httpStatus: number | null; sizeBytes: number | null; sha256: string | null; error: string | null }[] }>(
      '/sources/live-check',
      { method: 'POST' },
    ),

  upload: async (file: File): Promise<{ upload: { id: string; originalFileName: string; sanitizedFileName: string; sizeBytes: number; sha256: string; verificationUrl: string } }> => {
    await ensureBoundary()
    const headers: Record<string, string> = {
      'content-type': file.type || 'application/octet-stream',
      'x-insightforge-file-name': encodeURIComponent(file.name),
    }
    if (csrfToken) headers['x-insightforge-csrf'] = csrfToken
    if (requestKey) headers['x-insightforge-request-key'] = requestKey
    const res = await fetch(`${BASE}/uploads`, { method: 'POST', headers, body: file })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, (body as { error?: string }).error ?? `${res.status}`)
    }
    return res.json() as Promise<{ upload: { id: string; originalFileName: string; sanitizedFileName: string; sizeBytes: number; sha256: string; verificationUrl: string } }>
  },

  verifyUpload: (verificationUrl: string) =>
    req<{ upload: { sha256: string; hashMatches: boolean } }>(verificationUrl.replace(/^\/api/, '')),
}

/* SSE：/api/runs/:id/events — step / tool / terminal 三类事件 */
export interface SseHandlers {
  onStep: (steps: BackendStep[]) => void
  onTool: (event: BackendToolEvent) => void
  onTerminal: (status: 'completed' | 'failed', error: string | null) => void
  onError: () => void
}

export function subscribeRunEvents(runId: string, handlers: SseHandlers): () => void {
  const source = new EventSource(`${BASE}/runs/${runId}/events`)
  source.addEventListener('step', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { steps: BackendStep[] }
      handlers.onStep(data.steps)
    } catch {
      /* 忽略坏帧 */
    }
  })
  source.addEventListener('tool', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { event: BackendToolEvent }
      handlers.onTool(data.event)
    } catch {
      /* 忽略坏帧 */
    }
  })
  source.addEventListener('terminal', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { status: 'completed' | 'failed'; error: string | null }
      handlers.onTerminal(data.status, data.error)
    } catch {
      handlers.onError()
    }
    source.close()
  })
  source.addEventListener('stream-end', () => {
    handlers.onError()
    source.close()
  })
  source.onerror = () => {
    handlers.onError()
    source.close()
  }
  return () => source.close()
}
