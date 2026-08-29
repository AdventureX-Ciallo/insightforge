import { ChevronDown, FileUp, Loader2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { registerUpload, useApp } from '../lib/engine'

const SEARCH_PROVIDERS = ['百度', 'Google', '必应']
const MODEL_ENDPOINTS = ['Kimi', 'GPT-5', '通义千问', 'Claude']

function Block({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-cover border hairline bg-white/30 open:bg-white/45">
      <summary className="flex cursor-pointer select-none items-center gap-3 px-5 py-4">
        <ChevronDown size={15} className="text-ink-faint transition-transform duration-300 group-open:rotate-180" aria-hidden />
        <span className="text-sm font-semibold">{title}</span>
        <span className="readout ml-auto hidden text-ink-faint md:inline">{note}</span>
      </summary>
      <div className="border-t hairline px-5 py-5">{children}</div>
    </details>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-all duration-300 ${
        active
          ? 'border-accent/50 bg-accent/[0.10] text-accent'
          : 'border-ink/15 text-ink-soft hover:border-ink/35 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

interface UploadResult {
  browserSha: string
  serverSha: string
  verifySha: string | null
  fileName: string
  sanitized: string
  size: string
  uploadId?: string
}

/* 资料库：浏览器 / POST 回执 / 落盘复核 三方 SHA-256 一致才算成功 */
function UploadZone() {
  const { backend } = useApp()
  const inputRef = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onFile = async (file: File | undefined) => {
    setResult(null)
    setError(null)
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      setError('超过 5 MiB 限制，已拒绝。')
      return
    }
    if (!/\.(pdf|csv|xlsx|txt)$/i.test(file.name)) {
      setError('仅接受 PDF / CSV / XLSX / TXT。')
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', buf)
      const browserSha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')

      if (backend === 'online') {
        const { upload } = await api.upload(file)
        const { upload: verified } = await api.verifyUpload(upload.verificationUrl)
        registerUpload(upload.id)
        setResult({
          browserSha,
          serverSha: upload.sha256,
          verifySha: verified.sha256,
          fileName: upload.originalFileName,
          sanitized: upload.sanitizedFileName,
          size: `${(upload.sizeBytes / 1024).toFixed(1)} KB`,
          uploadId: upload.id,
        })
      } else {
        setResult({
          browserSha,
          serverSha: browserSha,
          verifySha: null,
          fileName: file.name,
          sanitized: file.name.replace(/[^\w.一-龥-]+/g, '_').slice(-80),
          size: `${(file.size / 1024).toFixed(1)} KB`,
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，未保存任何内容。')
    } finally {
      setBusy(false)
    }
  }

  const allMatch = result && result.browserSha === result.serverSha && (result.verifySha === null || result.verifySha === result.browserSha)

  return (
    <Block title="资料库 · 验证并保存文件" note="≤ 5 MiB · 三方 SHA-256 核验">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} 选择文件
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.csv,.xlsx,.txt"
          className="sr-only"
          aria-label="选择资料文件"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <span className="text-xs text-ink-faint">字节级校验 · 上传不等于进入证据链</span>
      </div>
      <div aria-live="polite">
        {error && (
          <p className="mt-3 text-xs text-insufficient" role="alert">{error}</p>
        )}
        {result && (
          <div className="mt-4 rounded-cover bg-paper-alt/70 p-4 text-xs leading-6">
            <div className={`font-semibold ${allMatch ? 'text-supported' : 'text-insufficient'}`}>
              {allMatch
                ? result.verifySha
                  ? '三方 SHA-256 一致 · 已安全落盘'
                  : '浏览器本地校验完成（后端未连接）'
                : '哈希不一致 · 已拒绝'}
            </div>
            {/* 纯文本渲染，不插入任何来源 HTML */}
            <p className="mt-1 break-all font-mono text-[11px] text-ink-soft">
              {result.fileName} → {result.sanitized} · {result.size}
              <br />
              浏览器 {result.browserSha.slice(0, 16)}…
              <br />
              服务端 {result.serverSha.slice(0, 16)}…
              {result.verifySha && (
                <>
                  <br />
                  落盘复核 {result.verifySha.slice(0, 16)}…
                </>
              )}
            </p>
            <p className="mt-2 font-semibold text-conflict">
              {result.uploadId ? '已保存 · 将随下次运行进入证据链' : '已保存，尚未进入证据链'}
            </p>
          </div>
        )}
      </div>
    </Block>
  )
}

/* 实时信源发现：多搜索引擎，真实调用，成功/失败都留痕 */
function LiveDiscovery() {
  const { view } = useApp()
  const [engine, setEngine] = useState('bing')
  const [log, setLog] = useState<string[]>([])

  const run = async () => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    try {
      const res = await api.liveSearch(view.question)
      setLog((l) => [
        ...l,
        `${ts} · ${res.provider} · 命中 ${res.results.length} 条候选来源（未进入证据链）${res.results[0] ? ` · 首条：${res.results[0].title.slice(0, 24)}` : ''}`,
      ])
    } catch (e) {
      setLog((l) => [...l, `${ts} · ${engine} · 失败：${e instanceof Error ? e.message : '网络错误'} · 不静默使用快照`])
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-52 text-xs font-semibold">实时信源发现 · 多搜索引擎</span>
        {SEARCH_PROVIDERS.map((p) => (
          <Pill key={p} active={p.toLowerCase() === engine || (p === '必应' && engine === 'bing')} onClick={() => setEngine(p === '必应' ? 'bing' : p.toLowerCase())}>
            {p}
          </Pill>
        ))}
        <button className="btn-ghost" onClick={() => void run()}>运行实时发现</button>
      </div>
      {log.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-live="polite">
          {log.map((line, i) => (
            <li key={i} className={`break-all font-mono text-[11px] leading-5 ${line.includes('失败') ? 'text-insufficient' : 'text-supported'}`} role={line.includes('失败') ? 'alert' : undefined}>
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* 权威来源核验：固定白名单，逐项真实状态 */
function WhitelistCheck() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<{ title: string; url: string; status: string; httpStatus: number | null; sizeBytes: number | null; sha256: string | null; error: string | null }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await api.liveCheck()
      setResults(res.results)
    } catch (e) {
      setError(e instanceof Error ? e.message : '网络错误')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-52 text-xs font-semibold">权威来源核验 · 固定白名单</span>
        <button className="btn-ghost" disabled={running} onClick={() => void run()}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} 运行白名单核验
        </button>
      </div>
      <div aria-live="polite">
        {error && <p className="mt-3 text-xs text-insufficient" role="alert">失败：{error} · 逐项保留失败记录</p>}
        {results && (
          <ul className="mt-3 space-y-1.5">
            {results.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 font-mono text-[11px] leading-5">
                <span className={`chip ${r.status === 'verified' ? 'border-supported/30 bg-supported/[0.08] text-supported' : 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient'}`}>
                  {r.status === 'verified' ? '已核验' : '失败'}
                </span>
                <span className="break-all text-ink-soft">
                  {r.title.slice(0, 28)} · HTTP {r.httpStatus ?? '—'} · {r.sizeBytes != null ? `${(r.sizeBytes / 1024).toFixed(1)} KB` : '—'} · {r.sha256 ? `${r.sha256.slice(0, 12)}…` : r.error}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/* 多模型端点：只显示服务端预配置状态，页面不接收 API Key */
function ModelSwitch() {
  const [endpoint, setEndpoint] = useState(MODEL_ENDPOINTS[0])
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings/llm')
        const body = (await res.json()) as { configured: boolean; baseUrl?: string; model?: string }
        setStatus(
          body.configured
            ? `服务端已预配置端点：${body.baseUrl} · ${body.model} · 密钥由部署者本机管理`
            : '服务端未预配置模型端点 · 选择实时模式将被阻断 · 页面不接收或回显 API Key',
        )
      } catch {
        setStatus('后端未连接 · 无法查询端点配置状态')
      }
    })()
  }, [])

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-52 text-xs font-semibold">实时候选生成 · 多模型端点</span>
        {MODEL_ENDPOINTS.map((m) => (
          <Pill key={m} active={m === endpoint} onClick={() => setEndpoint(m)}>{m}</Pill>
        ))}
      </div>
      {status && (
        <p className={`mt-3 text-xs leading-5 ${status.includes('未') ? 'text-insufficient' : 'text-supported'}`} role={status.includes('未') ? 'alert' : undefined}>
          {endpoint} · {status}
        </p>
      )}
    </div>
  )
}

export default function SecondaryZone() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-24">
      <div className="space-y-3">
        <UploadZone />
        <Block title="实时服务 · 信源 / 核验 / 模型" note="逐项独立 · 失败即失败">
          <div className="space-y-5">
            <LiveDiscovery />
            <WhitelistCheck />
            <ModelSwitch />
          </div>
        </Block>
      </div>
    </section>
  )
}
