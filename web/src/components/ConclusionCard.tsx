import { motion } from 'framer-motion'
import { Check, FileSearch, History, Pencil, RefreshCw, X } from 'lucide-react'
import type { Conclusion } from '../lib/types'
import { revalidateConclusion } from '../lib/engine'
import { fadeUp } from '../lib/motion'
import { Chip, evidenceTone, freshTone, reviewTone } from './Chips'

export type DialogMode = 'confirm' | 'reject' | 'edit'

interface Props {
  conclusion: Conclusion
  onViewEvidence: (id: string) => void
  onOpenDialog: (id: string, mode: DialogMode) => void
}

/* 候选结论卡：状态永远带文字；冲突双值视觉平等；确认被阻断时给出原因 */
export default function ConclusionCard({ conclusion: c, onViewEvidence, onOpenDialog }: Props) {
  const confirmBlocked = c.evidenceStatus === 'INSUFFICIENT_EVIDENCE' || c.freshness === 'STALE'
  const blockReason =
    c.freshness === 'STALE'
      ? '来源已更新，先基于 v2 复核再决定'
      : c.confirmBlockReason

  return (
    <motion.article
      variants={fadeUp}
      layout
      className="group relative overflow-hidden rounded-card bg-white/50 shadow-card transition-shadow duration-500 ease-apple hover:shadow-card-hover"
    >
      <div className="p-7">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="readout text-ink-faint">{c.displayId} · {c.role}</span>
          <span className="readout text-ink-faint/70">
            {c.originType} · {c.candidateSource === 'CACHED_MODEL_OUTPUT' ? '模型快照' : '实时模型'}
          </span>
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Chip label={c.knowledgeType} />
            <Chip label={c.evidenceStatus} tone={evidenceTone(c.evidenceStatus)} />
            <Chip label={c.reviewStatus} tone={reviewTone(c.reviewStatus)} />
            {c.freshness === 'STALE' && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.9 }}>
                <Chip label="STALE" tone={freshTone(c.freshness)} />
              </motion.span>
            )}
          </span>
        </div>

        <p className="font-serif text-lg leading-8 tracking-tight">{c.text}</p>

        {c.originType === 'HUMAN_EDITED' && (
          <p className="mt-2 text-xs text-accent">人工编辑版本 · 原模型文本已保留为历史版本 · 仍需显式确认</p>
        )}

        {/* 冲突双值：等大、等重，视觉平等 */}
        {c.conflictValues && (
          <div className="mt-5 flex flex-wrap items-stretch gap-4 rounded-cover bg-paper-alt/60 p-5">
            {c.conflictValues.map((v, i) => (
              <div key={i} className="flex-1 min-w-[180px]">
                <div className="font-serif text-4xl font-black tracking-tight">{v.value}</div>
                <div className="mt-1 text-xs text-ink-soft">{v.scope}</div>
                <div className="readout mt-1 text-ink-faint">来源 {v.sourceId}</div>
              </div>
            ))}
            <div className="hidden w-px border-l border-dashed border-ink/20 md:block" aria-hidden />
            <p className="basis-full text-xs leading-6 text-ink-soft md:basis-0 md:flex-[2]">
              {c.conflictExplanation}
            </p>
          </div>
        )}

        {/* 人工决定记录：时间、文本、理由、失效信息全部保留 */}
        {c.decision && (
          <div className={`mt-5 rounded-cover border p-4 text-xs leading-6 ${
            c.decision.invalidatedAt ? 'border-stale/30 bg-stale/[0.07]' : 'border-supported/25 bg-supported/[0.06]'
          }`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`font-semibold ${c.decision.invalidatedAt ? 'text-stale' : 'text-supported'}`}>
                {c.decision.action === 'CONFIRM' ? '已确认' : '已驳回'} · {c.decision.decidedAt}
              </span>
              {c.decision.invalidatedAt && (
                <span className="text-stale">
                  已于 {c.decision.invalidatedAt} 失效 · {c.decision.invalidationReason} · {c.decision.sourceUpdateId}
                </span>
              )}
            </div>
            {c.decision.decisionReason && <p className="mt-1 text-ink-soft">理由：{c.decision.decisionReason}</p>}
            {c.decision.scopeNote && <p className="text-ink-soft">适用范围：{c.decision.scopeNote}</p>}
          </div>
        )}

        {/* 历史决定：被替换或失效的旧记录不删除 */}
        {c.decisionHistory && c.decisionHistory.length > 0 && (
          <div className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-ink-faint">
            <History size={12} className="mt-0.5 flex-none" />
            <div>
              {c.decisionHistory.map((d) => (
                <p key={d.decisionId}>
                  历史决定 · {d.action === 'CONFIRM' ? '确认' : '驳回'} {d.decidedAt}
                  {d.invalidatedAt ? ` · 已于 ${d.invalidatedAt} 失效` : ''}
                  {d.decisionReason ? ` · ${d.decisionReason}` : ''}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <button className="btn-ghost" onClick={() => onViewEvidence(c.conclusionId)}>
            <FileSearch size={14} /> 查看依据
          </button>
          {c.freshness === 'STALE' ? (
            <button
              className="btn-ghost !border-accent/40 !text-accent hover:!border-accent"
              onClick={() => void revalidateConclusion(c.conclusionId).catch(() => onOpenDialog(c.conclusionId, 'edit'))}
            >
              <RefreshCw size={14} /> 基于 v2 复核
            </button>
          ) : (
            <>
              <span className="relative" title={confirmBlocked ? blockReason : undefined}>
                <button
                  className="btn-ghost"
                  disabled={confirmBlocked}
                  onClick={() => onOpenDialog(c.conclusionId, 'confirm')}
                >
                  <Check size={14} /> 确认
                </button>
              </span>
              <button className="btn-ghost" onClick={() => onOpenDialog(c.conclusionId, 'reject')}>
                <X size={14} /> 驳回
              </button>
            </>
          )}
          <button className="btn-ghost" onClick={() => onOpenDialog(c.conclusionId, 'edit')}>
            <Pencil size={14} /> 编辑
          </button>
          {confirmBlocked && c.freshness !== 'STALE' && (
            <span className="text-xs text-insufficient">{blockReason}</span>
          )}
        </div>
      </div>
    </motion.article>
  )
}
