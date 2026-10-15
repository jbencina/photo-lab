import { motion } from 'framer-motion'
import { cn, formatDuration } from '../lib/format'

export type BarTone = 'active' | 'done' | 'failed'

/** Thin progress bar shared by the admin indexing steps and the compact "find tag in library" progress. */
export function ProgressBar({ pct, tone = 'active', indeterminate, className }: { pct: number; tone?: BarTone; indeterminate?: boolean; className?: string }) {
  return (
    <div className={cn('relative h-1.5 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800', className)}>
      {indeterminate ? (
        <motion.div
          className="absolute inset-y-0 w-1/3 rounded-full bg-accent-500"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      ) : (
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700 ease-out',
            tone === 'failed' ? 'bg-red-500' : tone === 'active' ? 'bg-accent-500' : 'bg-accent-600/70 dark:bg-accent-500/70',
          )}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      )}
    </div>
  )
}

export function RateEta({ rate, eta }: { rate?: number | null; eta?: number | null }) {
  if (!rate) return <span>Measuring speed…</span>
  return (
    <span>
      <span className="font-medium text-zinc-700 dark:text-zinc-200">{rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)} photos/s</span>
      {eta != null && <> · {formatDuration(eta)} left</>}
    </span>
  )
}
