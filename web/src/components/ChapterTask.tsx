import { AnimatePresence, motion } from 'framer-motion'
import {
  BrainCircuit,
  Check,
  ClipboardList,
  Database,
  PackageCheck,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { resetAll, startRun, useApp } from '../lib/engine'
import { EASE, fadeUp, staggerParent } from '../lib/motion'
import type { StepKey, StepStatus } from '../lib/types'
import ActivityFeed from './ActivityFeed'
import { ModeChip } from './Chips'
import SectionHeading from './SectionHeading'

const STEP_META: { key: StepKey; label: string; icon: typeof ClipboardList }[] = [
  { key: 'PLAN', label: '规划', icon: ClipboardList },
  { key: 'COLLECT', label: '收集', icon: Database },
  { key: 'SYNTHESIZE', label: '综合', icon: BrainCircuit },
  { key: 'AUDIT', label: '审查', icon: ShieldCheck },
  { key: 'DELIVER', label: '交付', icon: PackageCheck },
]

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: '等待',
  running: '进行中',
  success: '完成',
  failed: '失败',
}

function StepNode({ label, icon: Icon, status, index }: { label: string; icon: typeof ClipboardList; status: StepStatus; index: number }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <motion.div
        layout
        className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors duration-500 ${
          status === 'success'
            ? 'border-supported/40 bg-supported/10 text-supported'
            : status === 'running'
              ? 'animate-breathe border-accent/50 bg-accent/10 text-accent'
              : status === 'failed'
                ? 'border-insufficient/40 bg-insufficient/10 text-insufficient'
                : 'border-ink/15 bg-paper text-ink-faint'
        }`}
        animate={status === 'success' ? { scale: [0.92, 1.04, 1] } : {}}
        transition={{ duration: 0.5, ease: EASE }}
      >
        {status === 'success' ? <Check size={17} strokeWidth={2.2} /> : status === 'failed' ? <X size={17} /> : <Icon size={17} strokeWidth={1.8} />}
      </motion.div>
      <div className="text-center">
        <div className="text-xs font-semibold">{label}</div>
        <div className={`readout mt-0.5 ${status === 'running' ? 'text-accent' : status === 'success' ? 'text-supported' : status === 'failed' ? 'text-insufficient' : 'text-ink-faint'}`}>
          {STATUS_TEXT[status]}
        </div>
      </div>
      <span className="sr-only">{`步骤 ${index + 1} ${label}：${STATUS_TEXT[status]}`}</span>
    </div>
  )
}

function Stepper() {
  const { steps } = useApp()
  const doneCount = STEP_META.filter((s) => steps[s.key] === 'success').length
  return (
    <div className="flex items-start justify-between" role="list" aria-label="研究任务五状态">
      {STEP_META.map((s, i) => (
        <div key={s.key} className="flex flex-1 items-start last:flex-none" role="listitem">
          <StepNode label={s.label} icon={s.icon} status={steps[s.key]} index={i} />
          {i < STEP_META.length - 1 && (
            <div className="relative mx-2 mt-5 h-px flex-1 bg-ink/10">
              <motion.div
                className="absolute inset-y-0 left-0 bg-supported/60"
                initial={false}
                animate={{ width: steps[STEP_META[i + 1].key] !== 'pending' || doneCount > i ? '100%' : '0%' }}
                transition={{ duration: 0.7, ease: EASE }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export default function ChapterTask() {
  const state = useApp()
  const { phase, terminal, startedAt, feed, backend } = state
  const caseData = state.view
  const [showEvents, setShowEvents] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (phase === 'running') workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [phase])

  const running = phase === 'running'
  const adopted = caseData.drafts.filter((d) => d.verdict !== 'REJECTED').length
  const canRun = backend === 'online' && caseData.question.length > 0

  return (
    <section id="chapter-task" className="mx-auto max-w-6xl px-6 pb-24 pt-14">
      <SectionHeading title={<span className="max-w-3xl block">{caseData.question}</span>} desc={caseData.scope} />

      <motion.div variants={staggerParent} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-10%' }}>
        <motion.div variants={fadeUp} className="flex flex-wrap items-center gap-4">
          <button className="btn-primary" disabled={running || !canRun} onClick={() => void startRun()}>
            {running ? '研究进行中…' : phase === 'done' ? '重新运行研究' : '开始研究'}
          </button>
          {phase !== 'idle' && (
            <button className="btn-ghost" disabled={running} onClick={resetAll}>
              重置工作台
            </button>
          )}
          {backend === 'offline' && (
            <span className="text-xs text-insufficient" role="alert">后端未连接 · 请先启动后端服务</span>
          )}
          {terminal === 'FAILED' && state.updateError && (
            <span className="text-xs text-insufficient" role="alert">{state.updateError}</span>
          )}
        </motion.div>

        <div aria-live="polite" className="sr-only">
          {running ? '研究任务进行中' : phase === 'done' ? `任务已交付，终态 ${terminal}` : '等待运行'}
        </div>

        <AnimatePresence>
          {phase !== 'idle' && (
            <motion.div
              ref={workspaceRef}
              initial={{ opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: EASE }}
              className="mt-12 rounded-card bg-white/45 p-8 shadow-card"
            >
              <div className="mb-8 flex flex-wrap items-baseline justify-between gap-2">
                <span className="eyebrow">任务进度</span>
                <span className="readout text-ink-faint">
                  {startedAt ? `开始 ${startedAt}` : ''}
                  {terminal ? ` · 终态 ${terminal}` : ''}
                </span>
              </div>

              {/* 模式标签：快照 / 实时 / 未运行逐项可见，不混称 */}
              <div className="mb-8 flex flex-wrap gap-2">
                <ModeChip label="来源发现" value={state.modes.sourceDiscovery} />
                <ModeChip label="来源核验" value={state.modes.authorityVerification} />
                <ModeChip label="候选生成" value={state.modes.synthesis} />
              </div>

              <Stepper />

              <ActivityFeed feed={feed} running={running} />

              <AnimatePresence>
                {phase === 'done' && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}
                    className="mt-10 border-t hairline pt-8"
                  >
                    <div className="mb-4 flex items-baseline gap-3">
                      <span className="eyebrow">信源</span>
                      <span className="readout text-ink-faint">{caseData.sources.length} 条 · 全部可定位 · 权重分级</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      {caseData.sources.map((s) => (
                        <div key={s.sourceId} className="flex items-start gap-3 rounded-cover bg-paper-alt/60 p-4">
                          <span className={`chip mt-0.5 flex-none ${
                            s.weight === 'HIGH'
                              ? 'border-supported/30 bg-supported/[0.08] text-supported'
                              : s.weight === 'MEDIUM'
                                ? 'border-conflict/35 bg-conflict/[0.08] text-conflict'
                                : 'border-ink/15 bg-ink/[0.04] text-ink-faint'
                          }`}>
                            {s.weightLabel} · {s.weight === 'HIGH' ? '权重高' : s.weight === 'MEDIUM' ? '权重中' : '权重低'}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold leading-5">{s.title}</div>
                            <div className="mt-0.5 text-xs text-ink-soft">{s.publisher} · {s.date}</div>
                            <div className="readout mt-1 break-all text-ink-faint">{s.sourceId} · {s.scopeNote}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-soft">
                      <span>信源 <b className="text-ink">{caseData.sources.length}</b></span>
                      <span>工具调用 <b className="text-ink">{caseData.toolEvents.length}</b></span>
                      <span>草稿 <b className="text-ink">{caseData.drafts.length}</b> → 入选 <b className="text-ink">{adopted}</b></span>
                      <span>自动修复 <b className="text-ink">1</b> / 上限 1</span>
                      <button
                        className="ml-auto text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
                        onClick={() => setShowEvents((v) => !v)}
                        aria-expanded={showEvents}
                      >
                        {showEvents ? '收起核验详情' : '展开核验详情（七字段工具事件）'}
                      </button>
                    </div>

                    <AnimatePresence>
                      {showEvents && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.45, ease: EASE }}
                          className="overflow-hidden"
                        >
                          <div className="mt-4 overflow-x-auto rounded-cover border hairline">
                            <table className="w-full text-left text-xs">
                              <thead>
                                <tr className="border-b hairline bg-paper-alt/60 readout text-ink-faint">
                                  {['toolName', 'inputSummary', 'startedAt', 'status', 'outputId', 'duration', 'error'].map((h) => (
                                    <th key={h} className="px-3 py-2 font-medium">{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="font-mono text-[11px] text-ink-soft">
                                {caseData.toolEvents.map((e, i) => (
                                  <tr key={i} className="border-b hairline last:border-0">
                                    <td className="px-3 py-2">{e.toolName}</td>
                                    <td className="px-3 py-2">{e.inputSummary}</td>
                                    <td className="px-3 py-2">{e.startedAt}</td>
                                    <td className="px-3 py-2 text-supported">{e.status}</td>
                                    <td className="px-3 py-2">{e.outputId}</td>
                                    <td className="px-3 py-2">{e.duration}</td>
                                    <td className="px-3 py-2">{e.error ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </section>
  )
}
