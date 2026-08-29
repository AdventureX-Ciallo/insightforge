import { motion } from 'framer-motion'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { applySourceUpdate, useApp } from '../lib/engine'
import { EASE } from '../lib/motion'
import SectionHeading from './SectionHeading'

/* 变化：来源 v1→v2 的精确影响链，重算结果落到内容层 */
export default function ChapterUpdate({ onGoReport }: { onGoReport: () => void }) {
  const state = useApp()
  const { phase, sourceUpdate, sourceUpdateSupported, updateError } = state
  if (phase !== 'done') return null

  const { update } = state.view
  const updateSupported = sourceUpdateSupported

  return (
    <section id="chapter-update" className="mx-auto max-w-6xl px-6 pb-28 pt-14">
      <SectionHeading
        title="来源更新，精确影响成果"
        desc="预测输入被终值替换时，只有依赖它的判断失效并保留历史；无关结论保持不变。"
      />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-10%' }}
        transition={{ duration: 0.6, ease: EASE }}
        className="rounded-card bg-white/50 p-7 shadow-card"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">{update.label}</span>
          <span className="readout text-ink-faint">{sourceUpdate.applied ? 'v2 已应用' : '当前 v1'}</span>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-center">
          <div className={`rounded-cover border p-5 transition-colors duration-700 ${sourceUpdate.applied ? 'border-stale/30 bg-stale/[0.06]' : 'border-transparent bg-paper-alt/60'}`}>
            <div className="readout text-ink-faint">v1 · 旧版输入</div>
            <p className="mt-2 font-serif text-sm leading-7"><b>{update.v1Body}</b></p>
            <p className="text-xs text-ink-soft">{update.v1Note}</p>
          </div>
          <ArrowRight className="mx-auto text-ink-faint" size={20} aria-hidden />
          <div className={`rounded-cover border p-5 transition-colors duration-700 ${sourceUpdate.applied ? 'border-supported/30 bg-supported/[0.06]' : 'border-dashed border-ink/15'}`}>
            <div className="readout text-ink-faint">v2 · 新版 / 终值</div>
            <p className="mt-2 font-serif text-sm leading-7"><b>{update.v2Body}</b></p>
            <p className="text-xs text-ink-soft">{update.v2Note}</p>
          </div>
        </div>

        {!sourceUpdate.applied ? (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            {updateSupported ? (
              <>
                <button className="btn-primary !px-6 !py-2.5 text-sm" onClick={() => void applySourceUpdate()}>
                  <RefreshCw size={15} /> 检查来源更新
                </button>
                <span className="text-xs text-ink-faint">载入来源 A 的最新版本并比对差异</span>
              </>
            ) : (
              <span className="text-xs text-ink-faint">来源更新仅适用于内置新能源案例的 v1→v2 版本链</span>
            )}
            {updateError && (
              <span className="text-xs text-insufficient" role="alert">{updateError}</span>
            )}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="mt-6 border-t hairline pt-5"
            aria-live="polite"
          >
            <div className="readout mb-3 text-stale">受影响对象 · {sourceUpdate.affected.length}</div>
            <ul className="space-y-2 text-xs leading-6">
              {sourceUpdate.affected.map((a) => (
                <li key={a.objectId} className="flex flex-wrap gap-2">
                  <span className="chip border-stale/35 bg-stale/[0.10] text-stale">{a.objectId} STALE</span>
                  <span className="text-ink-soft">{a.effect}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-supported">{sourceUpdate.unaffectedNote}</p>

            {/* 重算结果落到内容层：引用值如何变化 */}
            <div className="mt-5 rounded-cover bg-paper-alt/60 p-4">
              <div className="readout mb-2 text-ink-faint">重算结果 · {update.recompute.objectId} 引用值</div>
              <div className="grid gap-3 text-xs leading-6 md:grid-cols-[1fr_auto_1fr] md:items-center">
                <span className="text-stale line-through decoration-stale/50">{update.recompute.beforeText}</span>
                <ArrowRight size={14} className="hidden text-ink-faint md:block" aria-hidden />
                <span className="font-semibold text-supported">{update.recompute.afterText}</span>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button className="btn-primary !px-6 !py-2.5 text-sm" onClick={onGoReport}>
                前往研究报告复核受影响结论
              </button>
              <span className="text-xs text-ink-faint">复核后结论恢复 CURRENT，可重新人工决定</span>
            </div>
          </motion.div>
        )}
      </motion.div>
    </section>
  )
}
