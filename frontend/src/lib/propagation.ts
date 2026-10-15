import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from './api'
import type { IndexingState, PropagatePreview } from './types'

export interface PropagationOffer extends PropagatePreview {
  label: string
}

export interface Propagation {
  /** "Look for 'xyz' in your other photos?" prompt for a label that was just created. */
  offer: PropagationOffer | null
  /** The running (or just finished) propagate job; null when there is nothing to show. */
  job: IndexingState | null
  starting: boolean
  propose: (label: string, preview: PropagatePreview | null | undefined) => void
  run: (label: string) => Promise<void>
  dismiss: () => void
}

/**
 * State for "apply a new tag to the rest of the library": the offer shown after a tag is created, starting
 * the background job, and polling its progress (the same PROGRESS object the admin page shows). `onDone`
 * fires once when a job finishes so the caller can refresh subjects.
 */
export function usePropagation(opts: { onDone?: (job: IndexingState) => void; onError?: (message: string) => void; onInfo?: (message: string) => void }): Propagation {
  const [offer, setOffer] = useState<PropagationOffer | null>(null)
  const [job, setJob] = useState<IndexingState | null>(null)
  const [starting, setStarting] = useState(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  // Pick up a propagation that is already running (started earlier, or from the admin page).
  useEffect(() => {
    const ctrl = new AbortController()
    api.admin
      .progress(ctrl.signal)
      .then((p) => {
        if (p.running && p.mode === 'propagate') setJob(p)
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [])

  const running = !!job?.running
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(async () => {
      try {
        const p = await api.admin.progress()
        if (p.mode !== 'propagate') {
          // another job took over the progress slot; ours is long finished
          setJob(null)
          return
        }
        setJob(p)
        if (!p.running) {
          if (p.error) optsRef.current.onError?.(`Looking for the tag failed: ${p.error}`)
          optsRef.current.onDone?.(p)
        }
      } catch {
        /* transient; keep polling */
      }
    }, 1000)
    return () => window.clearInterval(t)
  }, [running])

  const propose = useCallback((label: string, preview: PropagatePreview | null | undefined) => {
    setJob((j) => (j?.running ? j : null))
    setOffer({ label, candidates: preview?.candidates ?? -1, est_seconds: preview?.est_seconds ?? 0 })
  }, [])

  const run = useCallback(async (label: string) => {
    setStarting(true)
    try {
      const r = await api.labels.propagate(label)
      setOffer(null)
      if (!r.started) {
        optsRef.current.onInfo?.(`No other photos look like candidates for “${label}”`)
        return
      }
      setJob(await api.admin.progress())
    } catch (err) {
      const busy = err instanceof ApiError && err.status === 409
      optsRef.current.onError?.(busy ? 'Indexing or tagging is running — try again when it finishes (Admin shows progress)' : (err as Error).message)
    } finally {
      setStarting(false)
    }
  }, [])

  const dismiss = useCallback(() => {
    setOffer(null)
    setJob((j) => (j?.running ? j : null))
  }, [])

  return { offer, job, starting, propose, run, dismiss }
}
