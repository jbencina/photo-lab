import { Check, CircleAlert, Plus, Search, Sparkles, Tag, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api, isAbort } from '../lib/api'
import { cn, formatDuration, formatNumber, labelCase } from '../lib/format'
import type { Propagation } from '../lib/propagation'
import type { AddTagResponse, LabelSuggestion, SuggestResponse } from '../lib/types'
import { ProgressBar, RateEta } from './progress'
import { Button, Spinner } from './ui'

const DEBOUNCE_MS = 150

type Row = { kind: 'label'; s: LabelSuggestion } | { kind: 'create'; label: string }

/** First row Enter should pick: a real text match if there is one, otherwise "Create", otherwise anything enabled. */
function defaultIndex(rows: Row[]): number {
  const enabled = (r: Row) => r.kind === 'create' || !r.s.on_image
  const text = rows.findIndex((r) => r.kind === 'label' && !r.s.on_image && r.s.match !== 'similar' && r.s.match !== 'image')
  if (text >= 0) return text
  const create = rows.findIndex((r) => r.kind === 'create')
  if (create >= 0) return create
  return rows.findIndex(enabled)
}

/**
 * "Add tag" combobox: suggests EXISTING tags while typing (text matches first, then embedding-similar ones)
 * so a near-duplicate isn't created by accident, and offers `Create "xyz"` only when no exact match exists.
 * The list is in normal flow below the input (not a floating popover), so it can't be clipped by the panel
 * or hidden behind a phone keyboard; on focus the input scrolls to the top of its scroll container.
 */
export function AddTag({ imageId, onAdded, onError }: { imageId: string; onAdded: (r: AddTagResponse) => void; onError: (message: string) => void }) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [res, setRes] = useState<SuggestResponse | null>(null)
  const [resFor, setResFor] = useState<string | null>(null) // the query text `res` answers
  const [pending, setPending] = useState(false)
  const [active, setActive] = useState(-1)
  const [saving, setSaving] = useState<string | null>(null)

  // Reset when the lightbox moves to another photo.
  useEffect(() => {
    setQ('')
    setRes(null)
    setOpen(false)
  }, [imageId])

  // Debounced suggestions (an empty query returns likely labels for this photo).
  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    setPending(true)
    const t = window.setTimeout(
      () => {
        api.labels
          .suggest(q, imageId, ctrl.signal)
          .then((r) => {
            setRes(r)
            setResFor(q)
            setPending(false)
          })
          .catch((err) => {
            if (isAbort(err)) return
            setPending(false)
            setRes(null)
          })
      },
      q.trim() ? DEBOUNCE_MS : 0,
    )
    return () => {
      window.clearTimeout(t)
      ctrl.abort()
    }
  }, [q, imageId, open])

  const typed = q.trim()
  const fresh = res != null && resFor === q
  const rows: Row[] = []
  if (res && fresh) {
    for (const s of res.items) rows.push({ kind: 'label', s })
    const canCreate = res.can_create ?? (!res.exact_exists && res.normalized !== '')
    if (typed && canCreate) rows.push({ kind: 'create', label: res.normalized })
  }
  const rowsKey = rows.map((r) => (r.kind === 'create' ? `+${r.label}` : r.s.label)).join('|')
  useEffect(() => {
    setActive(defaultIndex(rows))
  }, [rowsKey]) // only when the list itself changes, not on every render's new `rows` array

  // Close when focus/taps leave the control.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const pick = async (row: Row) => {
    if (saving) return
    if (row.kind === 'label' && row.s.on_image) return
    const label = row.kind === 'create' ? row.label : row.s.label
    setSaving(label)
    try {
      const r = await api.addTag(imageId, label)
      setQ('')
      setRes(null)
      setOpen(false)
      inputRef.current?.blur()
      onAdded(r)
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const move = (delta: 1 | -1) => {
    if (rows.length === 0) return
    let i = active
    for (let n = 0; n < rows.length; n++) {
      i = (i + delta + rows.length) % rows.length
      const r = rows[i]
      if (r.kind === 'create' || !r.s.on_image) break
    }
    setActive(i)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active]
      if (open && row && !pending) pick(row)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      if (open) setOpen(false)
      else inputRef.current?.blur()
    }
  }

  // Phones / tablets (the details live in a bottom sheet): while the list is open, reserve room below the
  // input and scroll it to the top of the sheet, so the options sit between the input and the on-screen
  // keyboard instead of below the fold.
  const [narrow, setNarrow] = useState(false)
  const onFocus = () => {
    setNarrow(window.matchMedia('(max-width: 1023px)').matches)
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open || !narrow) return
    const el = wrapRef.current
    let scroller = el?.parentElement ?? null
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!el || !scroller) return
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8
    scroller.scrollTo({ top }) // instant: a smooth scroll is cancelled by the keyboard / first keystroke
  }, [open, narrow])

  const heading = fresh && typed === '' && rows.length > 0 ? 'Suggested for this photo' : null

  return (
    <div ref={wrapRef} style={open && narrow ? { minHeight: 'min(72dvh, 34rem)' } : undefined}>
      <div className="relative">
        <Tag className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          placeholder="Add a tag…"
          maxLength={60}
          role="combobox"
          aria-label="Add a tag"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="field pr-9 pl-9 text-base md:text-sm"
        />
        {(pending && open) || saving ? (
          <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
        ) : q ? (
          <button
            type="button"
            onClick={() => {
              setQ('')
              inputRef.current?.focus()
            }}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Clear"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {open && fresh && (rows.length > 0 || typed !== '') && (
        <div className="mt-1.5 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
          {heading && (
            <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase dark:text-zinc-500">{heading}</div>
          )}
          <ul id={listId} role="listbox" aria-label="Tag suggestions" className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((row, i) => {
              const isActive = i === active
              if (row.kind === 'create')
                return (
                  <li
                    key="__create"
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={isActive}
                    onPointerMove={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(row)}
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-2.5 px-3 text-sm',
                      isActive ? 'bg-accent-50 dark:bg-accent-950/50' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
                    )}
                  >
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-600 text-white dark:bg-accent-500 dark:text-zinc-950">
                      <Plus className="size-3.5" strokeWidth={3} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-900 dark:text-zinc-100">
                      Create <span className="font-semibold">“{row.label}”</span>
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">new tag</span>
                  </li>
                )
              const s = row.s
              return (
                <li
                  key={s.label}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={s.on_image}
                  onPointerMove={() => !s.on_image && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(row)}
                  title={
                    s.on_image
                      ? 'Already on this photo'
                      : s.match === 'similar'
                        ? `Similar meaning to “${res?.normalized}” (EmbeddingGemma ${s.similarity?.toFixed(2)})`
                        : undefined
                  }
                  className={cn(
                    'flex min-h-11 items-center gap-2.5 px-3 text-sm',
                    s.on_image
                      ? 'cursor-default text-zinc-400 dark:text-zinc-500'
                      : cn('cursor-pointer text-zinc-800 dark:text-zinc-200', isActive ? 'bg-accent-50 dark:bg-accent-950/50' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'),
                  )}
                >
                  <span className="grid size-5 shrink-0 place-items-center text-zinc-400 dark:text-zinc-500">
                    {s.on_image ? <Check className="size-4" /> : s.match === 'similar' ? <Sparkles className="size-4" /> : <Tag className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{labelCase(s.label)}</span>
                  {s.on_image ? (
                    <span className="shrink-0 text-xs">on this photo</span>
                  ) : (
                    <>
                      {s.match === 'similar' && (
                        <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 uppercase dark:bg-violet-950/70 dark:text-violet-300">
                          similar
                        </span>
                      )}
                      {s.source === 'user' && s.match !== 'similar' && <span className="shrink-0 text-[11px] text-zinc-400">yours</span>}
                      <span className="w-9 shrink-0 text-right text-xs text-zinc-400 tabular" title={`${s.count} photo${s.count === 1 ? '' : 's'}`}>
                        {formatNumber(s.count)}
                      </span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          {res?.reason ? (
            <div className="flex items-start gap-2 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              <span>Can't create this tag: {res.reason}.</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2.5 text-xs text-zinc-500 dark:text-zinc-400">No matching tags.</div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Inline prompt after a NEW tag is created, then compact progress / result of the library search. */
export function PropagationStatus({ p }: { p: Propagation }) {
  const { offer, job } = p
  const box = 'rounded-xl border px-3.5 py-3 text-sm'
  if (job) {
    const label = job.labels?.join(', ') ?? 'tag'
    const total = job.total ?? 0
    const done = job.done ?? 0
    const added = job.propagate_added ?? 0
    if (job.running) {
      const loading = total === 0 || done === 0
      return (
        <div className={cn(box, 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40')} role="status" data-testid="propagation-progress">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-100">Looking for “{label}”…</span>
            <span className="shrink-0 text-xs text-zinc-500 tabular dark:text-zinc-400">
              {total > 0 ? `${formatNumber(done)} / ${formatNumber(total)}` : ''}
            </span>
          </div>
          <ProgressBar className="mt-2" pct={total > 0 ? (done / total) * 100 : 0} indeterminate={loading && !job.rate} />
          <div className="mt-1.5 flex items-baseline justify-between gap-3 text-xs text-zinc-500 tabular dark:text-zinc-400">
            <span className="min-w-0 truncate">{done > 0 ? <RateEta rate={job.rate} eta={job.eta_seconds} /> : (job.current ?? 'Starting…')}</span>
            <span className="shrink-0">{formatNumber(added)} found</span>
          </div>
        </div>
      )
    }
    return (
      <div
        className={cn(
          box,
          'flex items-start gap-2.5',
          job.error
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
            : 'border-accent-200 bg-accent-50/70 text-accent-900 dark:border-accent-900/70 dark:bg-accent-950/40 dark:text-accent-100',
        )}
        role="status"
        data-testid="propagation-result"
      >
        {job.error ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Check className="mt-0.5 size-4 shrink-0" />}
        <div className="min-w-0 flex-1 leading-5">
          {job.error ? (
            <span className="break-words">{job.error}</span>
          ) : (
            <>
              <span className="font-medium">
                {added > 0 ? `Added “${label}” to ${formatNumber(added)} more photo${added === 1 ? '' : 's'}` : `“${label}” wasn't found in other photos`}
              </span>
              <span className="block text-xs opacity-75 tabular">
                d1 checked {formatNumber(total)} candidate{total === 1 ? '' : 's'}
                {job.propagate_seconds ? ` in ${formatDuration(job.propagate_seconds)}` : ''}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={p.dismiss}
          className="relative -my-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-md opacity-70 after:absolute after:-inset-1.5 hover:opacity-100"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }
  if (!offer) return null
  const none = offer.candidates === 0
  return (
    <div className={cn(box, 'border-accent-200 bg-accent-50/70 dark:border-accent-900/70 dark:bg-accent-950/40')} data-testid="propagation-offer">
      <div className="flex items-start gap-2.5">
        <Search className="mt-0.5 size-4 shrink-0 text-accent-700 dark:text-accent-300" />
        <div className="min-w-0 flex-1">
          <div className="leading-5 font-medium [overflow-wrap:anywhere] text-zinc-900 dark:text-zinc-50">
            {none ? `Created “${offer.label}”` : `Look for “${offer.label}” in your other photos?`}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-zinc-600 tabular dark:text-zinc-300">
            {none
              ? 'No other photos look like candidates, so there is nothing to search.'
              : offer.candidates < 0
                ? 'EmbeddingGemma shortlists candidate photos and the d1 tagger confirms each one.'
                : `${formatNumber(offer.candidates)} candidate photo${offer.candidates === 1 ? '' : 's'} · about ${formatDuration(Math.max(1, offer.est_seconds))} · d1 confirms each one`}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={p.dismiss} disabled={p.starting}>
          {none ? 'OK' : 'Not now'}
        </Button>
        {!none && (
          <Button size="sm" variant="primary" onClick={() => p.run(offer.label)} loading={p.starting}>
            Run
          </Button>
        )}
      </div>
    </div>
  )
}
