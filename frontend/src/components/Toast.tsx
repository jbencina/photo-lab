import { AnimatePresence, motion } from 'framer-motion'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastKind = 'error' | 'success' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  error: (message: string) => void
  success: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

const ICONS = { error: CircleAlert, success: CircleCheck, info: Info }
const TONE = {
  error: 'text-red-500 dark:text-red-400',
  success: 'text-accent-600 dark:text-accent-400',
  info: 'text-zinc-500 dark:text-zinc-400',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      setToasts((t) => {
        // Collapse duplicates so a flaky network doesn't stack identical errors.
        if (t.some((x) => x.message === message)) return t
        const id = nextId.current++
        window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500)
        return [...t.slice(-2), { id, kind, message }]
      })
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      error: (m) => push('error', m),
      success: (m) => push('success', m),
      info: (m) => push('info', m),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = ICONS[t.kind]
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                role={t.kind === 'error' ? 'alert' : 'status'}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-zinc-200 bg-white/95 py-3 pr-2 pl-3.5 text-sm shadow-lg shadow-zinc-900/10 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95 dark:shadow-black/40"
              >
                <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[t.kind]}`} />
                <p className="flex-1 leading-5 text-zinc-700 dark:text-zinc-200">{t.message}</p>
                <button
                  onClick={() => dismiss(t.id)}
                  className="relative -my-1 grid size-7 shrink-0 after:absolute after:-inset-2 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label="Dismiss"
                >
                  <X className="size-4" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
