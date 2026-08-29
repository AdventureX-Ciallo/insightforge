import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect } from 'react'
import type { Conclusion, PathNode, Source } from '../lib/types'
import { drawerVariants, overlayVariants, pathNode } from '../lib/motion'

const KIND_COLOR: Record<PathNode['kind'], string> = {
  Conclusion: 'text-ink',
  Claim: 'text-accent',
  Evidence: 'text-supported',
  Datum: 'text-supported',
  Assumption: 'text-conflict',
  Source: 'text-ink-soft',
  Locator: 'text-ink-faint',
  EvidenceGap: 'text-insufficient',
}

/* 证据抽屉：一次点击，沿 Conclusion → … → Locator 的瀑布看到原始依据 */
export default function EvidenceDrawer({
  conclusion,
  sources,
  onClose,
}: {
  conclusion: Conclusion | null
  sources: Source[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <AnimatePresence>
      {conclusion && (
        <>
          <motion.div
            className="fixed inset-0 z-50 bg-ink/20"
            variants={overlayVariants}
            initial="hidden"
            animate="show"
            exit="exit"
            onClick={onClose}
          />
          <motion.aside
            className="glass-strong fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col"
            variants={drawerVariants}
            initial="hidden"
            animate="show"
            exit="exit"
            role="dialog"
            aria-label={`${conclusion.conclusionId} 证据路径`}
          >
            <div className="flex items-start justify-between gap-4 border-b hairline px-7 py-5">
              <div>
                <div className="eyebrow mb-1">证据路径</div>
                <h3 className="font-serif text-xl font-bold leading-7">{conclusion.role}</h3>
                <span className="readout text-ink-faint">{conclusion.displayId}</span>
              </div>
              <button className="btn-ghost !p-2" onClick={onClose} aria-label="关闭证据抽屉" autoFocus>
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-7 py-6">
              <ol className="relative">
                {conclusion.path.map((node, i) => (
                  <motion.li
                    key={i}
                    custom={i}
                    variants={pathNode}
                    initial="hidden"
                    animate="show"
                    className="relative pb-6 pl-8 last:pb-0"
                  >
                    {/* 纵向引导线：视线沿证据链向下 */}
                    {i < conclusion.path.length - 1 && (
                      <span className="absolute left-[7px] top-5 h-full w-px bg-ink/10" aria-hidden />
                    )}
                    <span
                      className={`absolute left-0 top-1.5 h-[15px] w-[15px] rounded-full border-2 border-current bg-paper ${KIND_COLOR[node.kind]}`}
                      aria-hidden
                    />
                    <div className={`readout ${KIND_COLOR[node.kind]}`}>{node.kind}</div>
                    <div className="mt-1 text-sm font-semibold leading-6">{node.title}</div>
                    {node.body && (
                      <p className={`mt-1 whitespace-pre-line text-xs leading-6 ${node.kind === 'EvidenceGap' ? 'text-insufficient/90' : 'text-ink-soft'}`}>
                        {node.body}
                      </p>
                    )}
                    {node.meta && <div className="readout mt-1.5 text-ink-faint">{node.meta}</div>}
                  </motion.li>
                ))}
              </ol>

              {conclusion.sourceIds.length > 0 && (
                <div className="mt-8 border-t hairline pt-5">
                  <div className="eyebrow mb-3">来源</div>
                  <div className="space-y-3">
                    {conclusion.sourceIds.map((id) => {
                      const s = sources.find((x) => x.sourceId === id)
                      if (!s) return null
                      return (
                        <div key={id} className="rounded-cover bg-white/50 p-4 text-xs leading-6">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="readout text-accent">{s.sourceId}</span>
                            <span className={`chip ${
                              s.weight === 'HIGH'
                                ? 'border-supported/30 bg-supported/[0.08] text-supported'
                                : s.weight === 'MEDIUM'
                                  ? 'border-conflict/35 bg-conflict/[0.08] text-conflict'
                                  : 'border-ink/15 bg-ink/[0.04] text-ink-faint'
                            }`}>
                              {s.weightLabel} · 权重{s.weight === 'HIGH' ? '高' : s.weight === 'MEDIUM' ? '中' : '低'}
                            </span>
                            {s.synthetic && (
                              <span className="chip border-conflict/30 bg-conflict/[0.08] text-conflict">内部资料</span>
                            )}
                          </div>
                          <div className="mt-1 font-semibold">{s.title}</div>
                          <div className="text-ink-soft">{s.publisher} · {s.date}</div>
                          <div className="text-ink-faint">{s.scopeNote}</div>
                          {s.url && (
                            <div className="mt-1 break-all font-mono text-[10px] text-ink-faint">{s.url}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
