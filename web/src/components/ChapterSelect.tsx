import { motion } from 'framer-motion'
import { FlaskConical, Star } from 'lucide-react'
import { selectPreset, useApp } from '../lib/engine'
import { fadeUp, staggerParent } from '../lib/motion'
import SectionHeading from './SectionHeading'

/* 选题：一个全功能研究案例 + 边界验证选题（后端 /api/presets 驱动）。
   边界验证诚实标注：运行返回证据缺口，不产出结论。 */
export default function ChapterSelect({ onSelect }: { onSelect: () => void }) {
  const { backend, presets, phase } = useApp()
  const running = phase === 'running'

  if (backend === 'offline') {
    return (
      <section className="mx-auto max-w-6xl px-6 pb-24 pt-14">
        <SectionHeading title="选择一个研究选题" />
        <div className="rounded-card border border-insufficient/25 bg-insufficient/[0.05] p-8 text-sm leading-7 text-ink-soft" role="alert">
          <p className="font-semibold text-insufficient">后端未连接</p>
          <p className="mt-2">请在项目根目录启动后端服务：<code className="font-mono text-xs">npm run dev</code>（默认 127.0.0.1:4399），然后刷新本页。</p>
        </div>
      </section>
    )
  }

  const golden = presets.filter((p) => p.kind === 'golden')
  const boundary = presets.filter((p) => p.kind === 'boundary')

  return (
    <section id="chapter-select" className="mx-auto max-w-6xl px-6 pb-24 pt-14">
      <SectionHeading
        title="选择一个研究选题"
        desc="全功能案例走完整五阶段任务链；边界验证选题用于检验系统对资料不匹配问题的诚实应答。"
      />

      <motion.div variants={staggerParent} initial="hidden" animate="show" className="space-y-5">
        {golden.map((p) => (
          <motion.button
            key={p.id}
            variants={fadeUp}
            disabled={running}
            onClick={() => {
              selectPreset(p)
              onSelect()
            }}
            className={`w-full rounded-card bg-white/60 p-7 text-left shadow-card transition-all duration-500 ease-apple hover:-translate-y-1 hover:shadow-card-hover ${running ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Star size={15} className="text-accent" aria-hidden />
              <span className="eyebrow text-accent">全功能研究案例</span>
            </div>
            <p className="mt-3 max-w-3xl font-serif text-xl font-bold leading-8">{p.question}</p>
            <p className="mt-2 text-xs leading-6 text-ink-soft">{p.description}</p>
          </motion.button>
        ))}

        <div className="grid gap-5 md:grid-cols-2">
          {boundary.map((p) => (
            <motion.button
              key={p.id}
              variants={fadeUp}
              disabled={running}
              onClick={() => {
                selectPreset(p)
                onSelect()
              }}
              className={`rounded-card border border-dashed border-ink/15 bg-white/30 p-6 text-left transition-all duration-500 ease-apple hover:-translate-y-1 hover:bg-white/45 hover:shadow-card ${running ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <div className="flex items-center gap-2">
                <FlaskConical size={14} className="text-conflict" aria-hidden />
                <span className="eyebrow text-conflict">边界验证 · 运行返回证据缺口</span>
              </div>
              <p className="mt-3 font-serif text-base font-bold leading-7">{p.question}</p>
              <p className="mt-2 text-xs leading-6 text-ink-soft">{p.description}</p>
            </motion.button>
          ))}
        </div>
      </motion.div>
    </section>
  )
}
