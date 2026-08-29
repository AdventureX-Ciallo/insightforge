import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { confirmConclusion, editConclusion, rejectConclusion, useApp } from '../lib/engine'
import { dialogVariants, overlayVariants } from '../lib/motion'
import type { DialogMode } from './ConclusionCard'

/* 人工决定弹窗：确认 / 驳回 / 编辑 是三个不同动作；
   编辑保留原模型文本且不自动确认；冲突与估算的确认强制理由与适用范围 */
export default function DecideDialog({
  target,
  onClose,
}: {
  target: { id: string; mode: DialogMode } | null
  onClose: () => void
}) {
  const { conclusions } = useApp()
  const c = conclusions.find((x) => x.conclusionId === target?.id)

  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (c) {
      setText(c.text)
      setReason('')
      setScope('')
      setError(null)
    }
  }, [target?.id, target?.mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!target || !c) return <AnimatePresence />

  const needsReasonScope =
    target.mode === 'confirm' &&
    (c.evidenceStatus === 'CONFLICT' || c.knowledgeType === 'ESTIMATE' || c.knowledgeType === 'FORECAST')

  const canSubmit =
    target.mode === 'edit'
      ? text.trim().length >= 8
      : target.mode === 'confirm'
        ? !needsReasonScope || (reason.trim().length > 0 && scope.trim().length > 0)
        : true

  const submit = async () => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      if (target.mode === 'confirm') await confirmConclusion(c.conclusionId, reason.trim() || undefined, scope.trim() || undefined)
      else if (target.mode === 'reject') await rejectConclusion(c.conclusionId, reason.trim() || undefined)
      else await editConclusion(c.conclusionId, text.trim())
      onClose()
    } catch (e) {
      /* 后端业务拒绝（如确认证据不足/缺少理由）原样呈现 */
      setError(e instanceof Error ? e.message : '操作被拒绝')
    } finally {
      setBusy(false)
    }
  }

  const title = target.mode === 'confirm' ? '确认结论' : target.mode === 'reject' ? '驳回结论' : '编辑候选文本'

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6"
        variants={overlayVariants}
        initial="hidden"
        animate="show"
        exit="exit"
        onClick={onClose}
      >
        <motion.div
          className="glass w-full max-w-lg rounded-card p-7"
          variants={dialogVariants}
          role="dialog"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="eyebrow mb-1">{c.conclusionId} · {c.role}</div>
          <h3 className="font-serif text-xl font-bold">{title}</h3>

          {target.mode === 'edit' ? (
            <>
              <p className="mt-3 rounded-cover bg-accent/[0.07] p-3 text-xs leading-6 text-ink-soft">
                保存只产生新的人工编辑版本，原模型文本保留为历史；编辑后仍需重新审查并由你显式确认。
              </p>
              <textarea
                className="mt-4 h-32 w-full resize-none rounded-cover border hairline bg-white/60 p-3 text-sm leading-7 focus:border-accent/50 focus:outline-none"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="候选文本"
              />
              <details className="mt-3 text-xs text-ink-faint">
                <summary className="cursor-pointer select-none">查看原模型文本</summary>
                <p className="mt-2 rounded-cover bg-paper-alt/70 p-3 leading-6">{c.originalAiText}</p>
              </details>
            </>
          ) : (
            <>
              <p className="mt-3 font-serif text-sm leading-7">{c.text}</p>
              {needsReasonScope && (
                <p className="mt-2 text-xs text-conflict">
                  确认{c.evidenceStatus === 'CONFLICT' ? '冲突' : '估算/预测'}类结论必须填写理由与适用范围。
                </p>
              )}
              <div className="mt-4 space-y-3">
                <input
                  className="w-full rounded-cover border hairline bg-white/60 px-3 py-2 text-sm focus:border-accent/50 focus:outline-none"
                  placeholder={needsReasonScope ? '决定理由（必填）' : '决定理由（可选）'}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="决定理由"
                />
                {target.mode === 'confirm' && (
                  <input
                    className="w-full rounded-cover border hairline bg-white/60 px-3 py-2 text-sm focus:border-accent/50 focus:outline-none"
                    placeholder={needsReasonScope ? '适用范围（必填）' : '适用范围（可选）'}
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    aria-label="适用范围"
                  />
                )}
              </div>
            </>
          )}

          <div className="mt-6 flex items-center justify-end gap-2.5">
            {error && (
              <span className="mr-auto text-xs leading-5 text-insufficient" role="alert">{error}</span>
            )}
            <button className="btn-ghost" onClick={onClose}>取消</button>
            <button className="btn-primary !px-5 !py-2 text-sm" disabled={!canSubmit || busy} onClick={() => void submit()}>
              {busy ? '提交中…' : target.mode === 'confirm' ? '显式确认' : target.mode === 'reject' ? '确认驳回' : '保存编辑（仍待确认）'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
