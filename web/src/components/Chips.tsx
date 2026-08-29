import type { EvidenceStatus, Freshness, ReviewStatus } from '../lib/types'

type Tone = 'supported' | 'conflict' | 'insufficient' | 'pending' | 'stale' | 'accent' | 'neutral'

const toneClass: Record<Tone, string> = {
  supported: 'border-supported/30 bg-supported/[0.08] text-supported',
  conflict: 'border-conflict/35 bg-conflict/[0.08] text-conflict',
  insufficient: 'border-insufficient/35 bg-insufficient/[0.08] text-insufficient',
  pending: 'border-pending/30 bg-pending/[0.08] text-pending',
  stale: 'border-stale/35 bg-stale/[0.10] text-stale',
  accent: 'border-accent/30 bg-accent/[0.08] text-accent',
  neutral: 'border-ink/15 bg-ink/[0.04] text-ink-soft',
}

export function Chip({ tone = 'neutral', label, pulse }: { tone?: Tone; label: string; pulse?: boolean }) {
  return (
    <span className={`chip ${toneClass[tone]}`}>
      <span className={`chip-dot ${pulse ? 'animate-pulse-dot' : ''}`} />
      {label}
    </span>
  )
}

export const evidenceTone = (s: EvidenceStatus): Tone =>
  s === 'SUPPORTED' ? 'supported' : s === 'CONFLICT' ? 'conflict' : 'insufficient'

export const reviewTone = (s: ReviewStatus): Tone =>
  s === 'HUMAN_CONFIRMED'
    ? 'supported'
    : s === 'HUMAN_REJECTED'
      ? 'insufficient'
      : s === 'NEEDS_REVIEW'
        ? 'conflict'
        : 'pending'

export const freshTone = (f: Freshness): Tone => (f === 'STALE' ? 'stale' : 'neutral')

/* 顶栏模式标签：缓存 / 实时 / 未运行 三种诚实状态 */
export function ModeChip({ label, value }: { label: string; value: string }) {
  const live = value.startsWith('LIVE')
  const notRun = value === 'NOT_RUN'
  return (
    <span
      className={`chip ${
        notRun
          ? 'border-dashed border-ink/20 text-ink-faint'
          : live
            ? 'border-accent/40 bg-accent/[0.10] text-accent'
            : 'border-accent/25 bg-accent/[0.05] text-ink-soft'
      }`}
      title={`${label}: ${value}`}
    >
      <span className={`chip-dot ${live ? 'animate-pulse-dot' : ''}`} />
      <span className="text-ink-faint">{label}</span>
      <span className="font-mono">{notRun ? '未运行' : live ? '实时' : '快照'}</span>
    </span>
  )
}
