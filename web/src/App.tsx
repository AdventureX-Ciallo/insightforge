import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import Background from './components/Background'
import ChapterDelivery from './components/ChapterDelivery'
import ChapterReport from './components/ChapterReport'
import ChapterSelect from './components/ChapterSelect'
import ChapterTask from './components/ChapterTask'
import ChapterUpdate from './components/ChapterUpdate'
import DecideDialog from './components/DecideDialog'
import EvidenceDrawer from './components/EvidenceDrawer'
import SecondaryZone from './components/SecondaryZone'
import type { DialogMode } from './components/ConclusionCard'
import { resumeRun, useApp } from './lib/engine'
import { EASE } from './lib/motion'

const STEP_LABELS = ['选题', '任务', '研究报告', '变化', '交付']

/* 分步门禁：研究完成才进报告；报告做过决定才进变化；
   交付在完成后即可查看（未应用更新时给出软提示，不硬锁） */
const LOCK_REASONS = [
  '',
  '',
  '完成研究任务后解锁',
  '在研究报告中完成至少一条人工决定后解锁',
  '完成研究任务后解锁',
]

function StepNav({
  step,
  unlocked,
  onChange,
}: {
  step: number
  unlocked: boolean[]
  onChange: (s: number) => void
}) {
  return (
    <nav aria-label="章节导航" className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
      <div className="glass flex items-center gap-1 !rounded-full p-1.5">
        <button
          className="btn-ghost !border-0"
          disabled={step === 0}
          onClick={() => onChange(step - 1)}
          aria-label="上一步"
        >
          <ChevronLeft size={15} /> 上一步
        </button>
        {STEP_LABELS.map((label, i) => {
          const locked = !unlocked[i]
          const active = i === step
          return (
            <button
              key={label}
              disabled={locked}
              onClick={() => onChange(i)}
              title={locked ? LOCK_REASONS[i] : label}
              aria-current={active ? 'step' : undefined}
              aria-label={`第 ${i + 1} 步 · ${label}${locked ? '（未解锁）' : ''}`}
              className={`relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-300 ${
                locked ? 'cursor-not-allowed text-ink-faint/50' : active ? 'text-white' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-full bg-ink"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className={`readout relative z-10 ${active ? 'text-white/70' : ''}`}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {locked && <Lock size={10} className="relative z-10" />}
              {/* 只有当前步骤展开名称；标签始终挂载，宽度平滑过渡，不抢布局 */}
              <motion.span
                initial={false}
                animate={{ width: active ? 'auto' : 0, opacity: active ? 1 : 0 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="relative z-10 overflow-hidden whitespace-nowrap"
              >
                {label}
              </motion.span>
            </button>
          )
        })}
        <button
          className="btn-ghost !border-0"
          disabled={step + 1 >= STEP_LABELS.length || !unlocked[step + 1]}
          onClick={() => onChange(step + 1)}
          aria-label="下一步"
          title={step + 1 < STEP_LABELS.length && !unlocked[step + 1] ? LOCK_REASONS[step + 1] : undefined}
        >
          下一步 <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  )
}

export default function App() {
  const { phase, conclusions, view, runId } = useApp()
  const [step, setStep] = useState(0)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ id: string; mode: DialogMode } | null>(null)

  /* 刷新后从持久状态恢复：运行中的任务从断点继续 */
  useEffect(() => {
    void resumeRun()
  }, [])

  /* 门禁：任务交付 → 至少一条人工决定才进变化；交付完成即可查看 */
  const decided = conclusions.some((c) => c.decision || c.originType === 'HUMAN_EDITED')
  const unlocked = [true, true, phase === 'done', decided, phase === 'done']

  useEffect(() => {
    if (!unlocked[step]) {
      setStep(unlocked.lastIndexOf(true))
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
  }, [unlocked, step])

  const go = (s: number) => {
    setStep(s)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const drawerConclusion = conclusions.find((c) => c.conclusionId === drawerId) ?? null

  return (
    <>
      <Background />
      <main className="pb-32">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${runId ?? view.question}-${step}`}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            {step === 0 && <ChapterSelect onSelect={() => go(1)} />}
            {step === 1 && (
              <>
                <ChapterTask />
                <SecondaryZone />
              </>
            )}
            {step === 2 && (
              <ChapterReport
                onViewEvidence={setDrawerId}
                onOpenDialog={(id, mode) => setDialog({ id, mode })}
              />
            )}
            {step === 3 && <ChapterUpdate onGoReport={() => go(2)} />}
            {step === 4 && <ChapterDelivery />}
          </motion.div>
        </AnimatePresence>
      </main>

      <StepNav step={step} unlocked={unlocked} onChange={go} />

      <EvidenceDrawer conclusion={drawerConclusion} sources={view.sources} onClose={() => setDrawerId(null)} />
      <DecideDialog target={dialog} onClose={() => setDialog(null)} />
    </>
  )
}
