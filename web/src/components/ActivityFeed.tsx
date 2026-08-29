import { motion } from 'framer-motion'
import { BrainCircuit, Calculator, FileText, PackageCheck, Search, ShieldCheck } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { FeedEvent, FeedKind, FeedVerdict } from '../lib/types'
import { EASE } from '../lib/motion'

const KIND_ICON: Record<FeedKind, typeof Search> = {
  search: Search,
  read: FileText,
  compute: Calculator,
  draft: BrainCircuit,
  audit: ShieldCheck,
  deliver: PackageCheck,
}

const VERDICT_META: Record<FeedVerdict, { label: string; cls: string }> = {
  ADOPTED: { label: '采纳', cls: 'border-supported/30 bg-supported/[0.08] text-supported' },
  PASSED: { label: '通过', cls: 'border-supported/30 bg-supported/[0.08] text-supported' },
  CONFLICT_KEPT: { label: '冲突保留', cls: 'border-conflict/35 bg-conflict/[0.08] text-conflict' },
  DOWNGRADED: { label: '降级', cls: 'border-conflict/35 bg-conflict/[0.08] text-conflict' },
  REPAIRED: { label: '已修复', cls: 'border-accent/30 bg-accent/[0.08] text-accent' },
  REJECTED: { label: '否定', cls: 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient' },
  BLOCKED: { label: '阻断', cls: 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient' },
}

/* 研究活动流：AI 的查找、生成、校验与裁决逐条可见。
   被否定的草稿同样留痕——可证伪是这个产品的核心叙事。 */
export default function ActivityFeed({ feed, running }: { feed: FeedEvent[]; running: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [feed.length])

  if (feed.length === 0 && !running) return null

  return (
    <div className="mt-8 border-t hairline pt-6">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="eyebrow">研究活动流</span>
        <span className="readout text-ink-faint" aria-live="polite">
          {running ? '实时' : '已完成'} · {feed.length} 条
        </span>
      </div>
      <div ref={scrollRef} className="max-h-[28rem] space-y-1 overflow-y-auto pr-2" aria-live="polite">
        {feed.map((ev, i) => {
          const Icon = KIND_ICON[ev.kind]
          const verdict = ev.verdict ? VERDICT_META[ev.verdict] : null
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: EASE }}
              className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-white/40"
            >
              <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ink/[0.05]">
                <Icon size={12.5} strokeWidth={1.8} className={
                  ev.verdict === 'REJECTED' || ev.verdict === 'BLOCKED'
                    ? 'text-insufficient'
                    : ev.verdict === 'ADOPTED' || ev.verdict === 'PASSED'
                      ? 'text-supported'
                      : ev.verdict === 'CONFLICT_KEPT' || ev.verdict === 'DOWNGRADED'
                        ? 'text-conflict'
                        : ev.verdict === 'REPAIRED'
                          ? 'text-accent'
                          : 'text-ink-soft'
                } />
              </span>
              <span className={`flex-1 text-xs leading-6 ${
                ev.verdict === 'REJECTED' ? 'text-ink-soft line-through decoration-insufficient/40' : 'text-ink-soft'
              }`}>
                <span className="readout mr-2 text-ink-faint">{ev.step}</span>
                {ev.text}
              </span>
              {verdict && (
                <span className={`chip mt-1 flex-none ${verdict.cls}`}>{verdict.label}</span>
              )}
            </motion.div>
          )
        })}
        {running && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-ink-faint">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-accent" />
            正在继续…
          </div>
        )}
      </div>
    </div>
  )
}
