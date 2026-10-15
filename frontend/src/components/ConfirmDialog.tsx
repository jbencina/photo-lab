import { AnimatePresence, motion } from 'framer-motion'
import { TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useBodyScrollLock } from '../lib/hooks'
import { Button } from './ui'

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmText,
  danger = true,
  loading,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  /** When set, the user must type this text to enable the confirm button. */
  confirmText?: string
  danger?: boolean
  loading?: boolean
  /** Block the confirm button (e.g. while the details it confirms are still loading); Cancel stays usable. */
  confirmDisabled?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const [typed, setTyped] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) return
    setTyped('')
    const t = window.setTimeout(() => cancelRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const blocked = confirmText ? typed.trim() !== confirmText : false

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px] dark:bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative w-full max-w-md rounded-t-2xl border border-zinc-200 bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:p-6 dark:border-zinc-800 dark:bg-zinc-900"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex gap-4">
              {danger && (
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400">
                  <TriangleAlert className="size-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                  {title}
                </h2>
                <div className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{children}</div>
                {confirmText && (
                  <label className="mt-4 block text-sm text-zinc-600 dark:text-zinc-300">
                    Type <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">{confirmText}</span> to
                    confirm
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      className="field mt-1.5 font-mono"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                )}
              </div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={blocked || confirmDisabled} loading={loading}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
