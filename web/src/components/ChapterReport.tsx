import { motion } from 'framer-motion'
import { useState } from 'react'
import { useApp } from '../lib/engine'
import { staggerParent } from '../lib/motion'
import type { DraftVerdict } from '../lib/types'
import ActivityFeed from './ActivityFeed'
import ConclusionCard, { type DialogMode } from './ConclusionCard'
import SectionHeading from './SectionHeading'

const VERDICT_META: Record<DraftVerdict, { label: string; cls: string }> = {
  ADOPTED: { label: '采纳', cls: 'border-supported/30 bg-supported/[0.08] text-supported' },
  CONFLICT_KEPT: { label: '冲突保留', cls: 'border-conflict/35 bg-conflict/[0.08] text-conflict' },
  DOWNGRADED: { label: '降级', cls: 'border-conflict/35 bg-conflict/[0.08] text-conflict' },
  REJECTED: { label: '否定', cls: 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient' },
}

/* 生成与筛选：AI 提出的全部草稿及程序裁决，被否定的也留痕 */
function DraftTriage() {
  const { view } = useApp()
  const { drafts } = view
  const [open, setOpen] = useState(false)

  const count = (v: DraftVerdict) => drafts.filter((d) => d.verdict === v).length
  const adopted = count('ADOPTED') + count('CONFLICT_KEPT') + count('DOWNGRADED')

  return (
    <div className="mb-8 rounded-card border hairline bg-white/35 p-5">
      <button
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="eyebrow">生成与筛选</span>
        <span className="text-xs text-ink-soft">
          草稿 <b className="text-ink">{drafts.length}</b> → 入选 <b className="text-supported">{adopted}</b>
          {count('CONFLICT_KEPT') > 0 && <> · 冲突保留 <b className="text-conflict">{count('CONFLICT_KEPT')}</b></>}
          {count('DOWNGRADED') > 0 && <> · 降级 <b className="text-conflict">{count('DOWNGRADED')}</b></>}
          {count('REJECTED') > 0 && <> · 否定 <b className="text-insufficient">{count('REJECTED')}</b></>}
        </span>
        <span className="ml-auto text-xs text-accent underline decoration-accent/40 underline-offset-4">
          {open ? '收起裁决明细' : '展开裁决明细'}
        </span>
      </button>
      {open && (
        <motion.ul
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mt-4 space-y-2 border-t hairline pt-4"
        >
          {drafts.map((d) => (
            <li key={d.draftId} className={`rounded-cover p-3 text-xs leading-6 ${
              d.verdict === 'REJECTED' ? 'bg-insufficient/[0.04]' : 'bg-paper-alt/60'
            }`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="readout text-ink-faint">草稿 {d.draftId}</span>
                <span className={`chip ${VERDICT_META[d.verdict].cls}`}>{VERDICT_META[d.verdict].label}</span>
                {d.mapsTo && <span className="readout text-ink-faint">→ {d.mapsTo}</span>}
              </div>
              <p className={`mt-1 ${d.verdict === 'REJECTED' ? 'text-ink-soft line-through decoration-insufficient/40' : 'text-ink'}`}>
                {d.text}
              </p>
              <p className="mt-0.5 text-ink-soft">裁决理由：{d.reason}</p>
            </li>
          ))}
        </motion.ul>
      )}
    </div>
  )
}

export default function ChapterReport({
  onViewEvidence,
  onOpenDialog,
}: {
  onViewEvidence: (id: string) => void
  onOpenDialog: (id: string, mode: DialogMode) => void
}) {
  const { phase, conclusions, feed, view } = useApp()
  if (phase !== 'done') return null
  const { auditFindings } = view

  const conflict = conclusions.filter((c) => c.evidenceStatus === 'CONFLICT').length
  const insufficient = conclusions.filter((c) => c.evidenceStatus === 'INSUFFICIENT_EVIDENCE').length
  const confirmed = conclusions.filter((c) => c.reviewStatus === 'HUMAN_CONFIRMED').length
  const stale = conclusions.filter((c) => c.freshness === 'STALE').length

  return (
    <section id="chapter-report" className="mx-auto max-w-6xl px-6 pb-24 pt-14">
      <SectionHeading
        title="每条结论都能说出“凭什么”"
        desc={`${conclusions.length} 条候选 · ${confirmed} 条已确认 · ${conflict} 条口径冲突 · ${insufficient} 条证据不足${stale ? ` · ${stale} 条因来源更新失效` : ''}。模型提出，程序校验，你负责最终判断。`}
      />

      <DraftTriage />

      {/* 研究过程回放：AI 的查找与否决在报告章也可回看 */}
      <details className="group mb-8 rounded-card border hairline bg-white/35 open:bg-white/45">
        <summary className="flex cursor-pointer select-none items-center gap-3 px-5 py-4">
          <span className="eyebrow">研究过程回放</span>
          <span className="readout text-ink-faint">{feed.length} 条 · 查找 / 裁决 / 修复全程留痕</span>
        </summary>
        <div className="px-5 pb-5">
          <ActivityFeed feed={feed} running={false} />
        </div>
      </details>

      <motion.div
        variants={staggerParent}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-8%' }}
        className="space-y-6"
      >
        {conclusions.map((c) => (
          <ConclusionCard key={c.conclusionId} conclusion={c} onViewEvidence={onViewEvidence} onOpenDialog={onOpenDialog} />
        ))}
      </motion.div>

      {/* 审查修正：确定性规则审查，不显示“自检通过”式空话 */}
      <div className="mt-16">
        <div className="mb-6 flex flex-wrap items-baseline gap-3">
          <h3 className="font-serif text-2xl font-bold">审查修正</h3>
          <span className="readout text-ink-faint">确定性规则审查 · 修复 1 次 / 上限 1</span>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {auditFindings.map((f) => (
            <motion.div
              key={f.findingId}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-10%' }}
              transition={{ duration: 0.5 }}
              className="rounded-card bg-white/45 p-5 shadow-card"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`chip ${
                  f.severity === 'HIGH'
                    ? 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient'
                    : 'border-conflict/35 bg-conflict/[0.08] text-conflict'
                }`}>
                  {f.category}
                </span>
                <span className={`chip ${
                  f.status === 'REPAIRED'
                    ? 'border-supported/30 bg-supported/[0.08] text-supported'
                    : 'border-conflict/35 bg-conflict/[0.08] text-conflict'
                }`}>
                  {f.status === 'REPAIRED' ? '已修复' : '需人工处理'}
                </span>
              </div>
              <div className="readout mt-3 text-ink-faint">{f.target} · {f.severity}</div>
              <p className="mt-2 text-sm font-medium leading-6">{f.message}</p>
              <p className="mt-1 text-xs leading-5 text-ink-soft">{f.action}</p>
              <div className="mt-3 space-y-2 border-t hairline pt-3 text-[11px] leading-5">
                <div>
                  <span className="readout mr-2 text-insufficient">before</span>
                  <span className="text-ink-soft">{f.before}</span>
                </div>
                <div>
                  <span className="readout mr-2 text-supported">after&nbsp;&nbsp;</span>
                  <span className="text-ink-soft">{f.after}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
