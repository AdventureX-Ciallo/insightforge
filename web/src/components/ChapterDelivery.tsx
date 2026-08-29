import { Download, FileJson, FileText, MonitorCheck } from 'lucide-react'
import { useApp } from '../lib/engine'
import SectionHeading from './SectionHeading'

const TRIGGER_TEXT: Record<string, string> = {
  INITIAL_DELIVER: '首次交付',
  HUMAN_DECISION: '人工决定',
  HUMAN_EDIT: '人工编辑',
  SOURCE_UPDATE: '来源更新',
}

const KIND_META: Record<string, { title: string; note: string; icon: typeof FileText }> = {
  PPTX: { title: 'PPTX · 可编辑五页模板', note: 'ZIP 签名 · 真实文件', icon: FileText },
  EVIDENCE_JSON: { title: '证据 JSON · 完整证据链', note: '结构化运行对象', icon: FileJson },
  REPORT_MD: { title: '研究报告 · Markdown', note: '纯文本报告', icon: FileText },
  REPORT_PDF: { title: '研究报告 · PDF', note: '打印版报告', icon: FileText },
}

/* 交付：成果卡与版本历史全部来自后端真实记录，
   卡片显示的大小与哈希等于下载文件的真实值 */
export default function ChapterDelivery() {
  const state = useApp()
  const { phase, artifacts, sourceUpdate, apiFiles, evictedCount } = state
  if (phase !== 'done') return null

  const current = artifacts.find((a) => a.status === 'CURRENT')

  return (
    <section id="chapter-delivery" className="mx-auto max-w-6xl px-6 pb-28 pt-14">
      <SectionHeading
        title="成果交付"
        desc="交互报告与可下载成果共享同一研究快照；每次人工决定与来源更新都生成新版本，旧版本保留可审计。"
      />

      {/* 软提示而非硬锁：未应用更新也能交付当前快照 */}
      {!sourceUpdate.applied && state.isGolden && (
        <div className="mb-6 rounded-cover border border-conflict/25 bg-conflict/[0.05] px-4 py-3 text-xs leading-6 text-ink-soft">
          尚未应用来源更新 · 当前成果基于 v1 快照交付；到「变化」页应用 v2 后将自动生成新版本。
        </div>
      )}

      <div>
        <div className="mb-6 flex flex-wrap items-baseline gap-3">
          <span className="readout text-ink-faint">
            {current ? `v${current.version} · ${TRIGGER_TEXT[current.trigger]} · ${current.createdAt}` : ''}
          </span>
          <span className="text-xs text-conflict">成果已生成，含待审候选 · DELIVERED ≠ 全部结论已确认</span>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <div className="rounded-card border-2 border-accent/25 bg-white/50 p-6 shadow-card">
            <MonitorCheck size={20} className="text-accent" aria-hidden />
            <div className="mt-3 font-semibold">交互报告</div>
            <p className="mt-1 text-xs leading-5 text-ink-soft">当前页面 · 与可下载成果共享同一研究快照</p>
            <span className="chip mt-4 border-accent/30 bg-accent/[0.08] text-accent">当前页面</span>
          </div>

          {apiFiles.map((f) => {
            const meta = KIND_META[f.kind] ?? { title: f.kind, note: '', icon: FileText }
            const Icon = meta.icon
            return (
              <div key={f.kind} className="rounded-card bg-white/50 p-6 shadow-card">
                <Icon size={20} className="text-ink-soft" aria-hidden />
                <div className="mt-3 font-semibold">{meta.title}</div>
                <p className="mt-1 break-all font-mono text-[10px] leading-5 text-ink-faint">
                  {f.fileName}
                  <br />
                  {f.size} · SHA-256 {f.sha256}
                </p>
                <a className="btn-ghost mt-4" href={f.url} download>
                  <Download size={14} /> 下载
                </a>
              </div>
            )
          })}
        </div>

        {/* 版本历史：每个版本说明改了什么（后端 adjustmentNote 原文） */}
        {artifacts.length > 0 && (
          <div className="mt-6 rounded-cover border hairline p-4">
            <div className="readout mb-2 text-ink-faint">版本历史 · 旧版本保留可审计</div>
            {evictedCount > 0 && (
              <p className="mb-2 text-[11px] text-stale">服务端最多保留 5 个版本 · 已有 {evictedCount} 个更早版本被驱逐</p>
            )}
            <ul className="space-y-3 text-xs text-ink-soft">
              {artifacts.map((a) => (
                <li key={a.artifactVersionId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`chip ${a.status === 'CURRENT' ? 'border-supported/30 bg-supported/[0.08] text-supported' : 'border-ink/15 bg-ink/[0.04] text-ink-faint'}`}>
                      v{a.version} {a.status}
                    </span>
                    <span className="text-ink-faint">{TRIGGER_TEXT[a.trigger]} · {a.createdAt}</span>
                  </div>
                  <p className="mt-1 leading-5">{a.summary}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
