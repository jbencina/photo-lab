import {
  Check,
  CircleAlert,
  Cpu,
  Database,
  FolderOpen,
  Heart,
  Images,
  RefreshCw,
  ScanEye,
  Search,
  Sparkles,
  Tag,
  Tags,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ProgressBar, RateEta } from '../components/progress'
import { useToast } from '../components/Toast'
import { TopBar } from '../components/TopBar'
import { Button, Card } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { cn, formatBytes, formatDuration, formatNumber, labelCase } from '../lib/format'
import type { AdminConfig, IndexingState, LabelInfo, ModelMode, PropagatePreview, Status } from '../lib/types'

/** Per-photo d1 cost used for estimates when the server doesn't report one (reference GPU, full resolution). */
const TAG_SECONDS_DEFAULT = 0.3

function StatCard({ icon, label, value, sub, loading }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; loading?: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
        {label}
      </div>
      {loading ? (
        <div className="mt-2.5 h-7 w-16 animate-pulse rounded-md bg-zinc-200/80 dark:bg-zinc-800" />
      ) : (
        <div className="mt-1.5 truncate text-2xl font-semibold tracking-tight text-zinc-900 tabular dark:text-zinc-50">{value}</div>
      )}
      {sub && <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </Card>
  )
}

function elapsed(since: string | null | undefined): string | null {
  if (!since) return null
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000))
  if (!Number.isFinite(s)) return null
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  return m ? `${m}m ${s % 60}s` : `${s}s`
}

export function runSummary(s: IndexingState): string | null {
  if (s.added == null) return null
  if (s.mode === 'propagate') {
    const added = s.propagate_added ?? 0
    const name = s.labels?.length ? `“${s.labels.join(', ')}”` : 'tag'
    return `${name} added to ${formatNumber(added)} photo${added === 1 ? '' : 's'} · ${formatNumber(s.total)} candidate${s.total === 1 ? '' : 's'} checked`
  }
  const parts: string[] = []
  const tagged = Math.max(0, (s.tag_done ?? 0) - (s.tag_failed ?? 0))
  if (s.mode === 'tag' || s.mode === 'retag') {
    parts.push(`${formatNumber(tagged)} ${s.mode === 'retag' ? 're-tagged' : 'tagged'}`)
  } else {
    parts.push(`${formatNumber(s.added)} new`, `${formatNumber(s.skipped ?? 0)} already indexed`)
    if (s.skip_tags) parts.push('tagging skipped')
    else if (s.tag_done != null) parts.push(`${formatNumber(tagged)} tagged`)
  }
  if (s.failed) parts.push(`${formatNumber(s.failed)} failed`)
  if (s.tag_failed) parts.push(`${formatNumber(s.tag_failed)} failed to tag`)
  if (s.missing) parts.push(`${formatNumber(s.missing)} missing on disk`)
  if (s.pruned) parts.push(`${formatNumber(s.pruned)} pruned`)
  return parts.join(' · ')
}

type StepState = 'idle' | 'pending' | 'active' | 'done' | 'skipped' | 'failed'

function stepStates(s: IndexingState): { embed: StepState | null; tag: StepState } {
  const mode = s.mode ?? 'refresh'
  const phase = s.phase ?? null
  const early = phase === 'scanning' || phase === 'embedding'
  const embed: StepState | null =
    mode !== 'refresh' ? null : phase == null ? 'idle' : s.running ? (early ? 'active' : 'done') : s.error && early ? 'failed' : 'done'
  let tag: StepState
  if (phase == null) tag = 'idle'
  else if (mode === 'refresh' && s.skip_tags) tag = 'skipped'
  else if (s.running) tag = early ? 'pending' : 'active'
  else if (s.error) tag = phase === 'tagging' ? 'failed' : 'pending'
  else tag = 'done'
  return { embed, tag }
}

function StepIcon({ state, index }: { state: StepState; index: number }) {
  if (state === 'done')
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-600 text-white dark:bg-accent-500 dark:text-zinc-950">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    )
  if (state === 'failed')
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/60 dark:text-red-400">
        <TriangleAlert className="size-3.5" />
      </span>
    )
  return (
    <span
      className={cn(
        'relative grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular',
        state === 'active'
          ? 'bg-accent-100 text-accent-800 ring-2 ring-accent-500 dark:bg-accent-950 dark:text-accent-200'
          : 'bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
      )}
    >
      {index}
    </span>
  )
}

function Step({
  index,
  state,
  title,
  hint,
  done,
  total,
  right,
  meta,
  indeterminate,
  last,
}: {
  index: number
  state: StepState
  title: string
  hint: string
  done: number
  total: number
  right?: ReactNode
  meta?: ReactNode
  indeterminate?: boolean
  last?: boolean
}) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : state === 'done' ? 100 : 0
  const showBar = state === 'active' || ((state === 'done' || state === 'failed') && total > 0)
  return (
    <li className="relative flex gap-3">
      {!last && <span aria-hidden className="absolute top-7 bottom-0 left-3 w-px -translate-x-1/2 bg-zinc-200 dark:bg-zinc-800" />}
      <StepIcon state={state} index={index} />
      <div className={cn('min-w-0 flex-1', !last && 'pb-4')}>
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 truncate">
            <span className={cn('text-sm font-medium', state === 'pending' || state === 'idle' || state === 'skipped' ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100')}>
              {title}
            </span>
            <span className="ml-2 hidden text-xs text-zinc-400 sm:inline dark:text-zinc-500" title={hint}>
              {hint}
            </span>
          </div>
          <span className="shrink-0 text-xs text-zinc-500 tabular dark:text-zinc-400">{right}</span>
        </div>
        {showBar && <ProgressBar className="mt-2" pct={pct} tone={state === 'failed' ? 'failed' : state === 'active' ? 'active' : 'done'} indeterminate={indeterminate} />}
        {meta && <div className="mt-1.5 text-xs text-zinc-500 tabular dark:text-zinc-400">{meta}</div>}
      </div>
    </li>
  )
}

function Progress({ state, status }: { state: IndexingState; status: Status | null }) {
  const { embed, tag } = stepStates(state)
  const secPer = status?.tagger?.seconds_per_image ?? TAG_SECONDS_DEFAULT
  const finished = !state.running && state.phase != null
  const summary = finished ? runSummary(state) : null
  const phase = state.phase
  const embedTotal = state.embed_total ?? 0
  const embedDone = state.embed_done ?? 0
  const tagTotal = state.tag_total ?? 0
  const tagDone = state.tag_done ?? 0
  // While embedding, the tag pass will cover what's untagged now plus what is still being embedded.
  const pendingTags = (state.untagged ?? status?.untagged_count ?? 0) + Math.max(0, embedTotal - embedDone)
  const overallEta =
    state.running && state.eta_seconds != null
      ? state.eta_seconds + (phase === 'embedding' && tag === 'pending' ? pendingTags * secPer : 0)
      : null
  const propagating = state.mode === 'propagate'
  const propLabel = state.labels?.length ? `“${state.labels.join(', ')}”` : 'tag'
  const propState: StepState = state.running ? 'active' : state.error ? 'failed' : 'done'
  const title = propagating
    ? state.running
      ? `Looking for ${propLabel}…`
      : state.interrupted
        ? 'Interrupted'
        : state.error
          ? 'Last run failed'
          : 'Last run complete'
    : state.running
    ? phase === 'tagging'
      ? state.mode === 'retag'
        ? 'Re-tagging subjects…'
        : 'Tagging subjects…'
      : phase === 'embedding'
        ? 'Embedding new photos…'
        : 'Scanning…'
    : state.interrupted
      ? 'Interrupted'
      : state.error
        ? 'Last run failed'
        : finished
          ? 'Last run complete'
          : 'Idle'

  let step = 1
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium whitespace-nowrap text-zinc-900 dark:text-zinc-100">{title}</span>
        <span className="min-w-0 truncate text-xs text-zinc-500 tabular dark:text-zinc-400">
          {state.running
            ? (
                <>
                  {overallEta != null && `~${formatDuration(overallEta)} left`}
                  <span className="hidden sm:inline">
                    {overallEta != null && ' · '}
                    {elapsed(state.started_at)}
                  </span>
                </>
              )
            : finished && state.finished_at
              ? new Date(state.finished_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
              : ''}
        </span>
      </div>
      <div className="mt-1 min-h-4 truncate text-xs text-zinc-500 dark:text-zinc-400">
        {state.running ? (
          <span className="font-mono" title={state.current ?? undefined}>
            {state.current ?? ''}
          </span>
        ) : (
          <span className="tabular">{summary ?? (status ? `${formatNumber(status.image_count)} photos indexed this catalog` : '')}</span>
        )}
      </div>

      {propagating ? (
        <ol className="mt-4">
          <Step
            index={1}
            last
            state={propState}
            title={`Find ${propLabel} in the library`}
            hint="EG shortlists · d1-3B confirms"
            done={state.done}
            total={state.total}
            indeterminate={state.running && state.total === 0}
            right={
              state.total > 0
                ? `${formatNumber(state.done)} / ${formatNumber(state.total)}`
                : state.running
                  ? 'Finding candidates…'
                  : 'No candidates'
            }
            meta={
              state.running ? (
                state.done > 0 ? (
                  <>
                    <RateEta rate={state.rate} eta={state.eta_seconds} /> · {formatNumber(state.propagate_added ?? 0)} found
                  </>
                ) : (
                  'Loading models…'
                )
              ) : state.total > 0 && state.propagate_seconds ? (
                `${formatNumber(state.propagate_added ?? 0)} confirmed of ${formatNumber(state.total)} in ${formatDuration(state.propagate_seconds)} (incl. model load)`
              ) : null
            }
          />
        </ol>
      ) : (
      <ol className="mt-4">
        {embed && (
          <Step
            index={step++}
            state={embed}
            title="Embed new photos"
            hint="EXIF · colors · EmbeddingGemma"
            done={embedDone}
            total={embedTotal}
            indeterminate={embed === 'active' && phase === 'scanning'}
            right={
              embed === 'active'
                ? phase === 'scanning'
                  ? 'Scanning folder…'
                  : `${formatNumber(embedDone)} / ${formatNumber(embedTotal)}`
                : embed === 'idle'
                  ? status
                    ? `${formatNumber(status.image_count)} indexed`
                    : ''
                  : embedTotal > 0
                    ? `${formatNumber(state.added ?? embedDone)} new`
                    : 'Nothing new'
            }
            meta={
              embed === 'active' && phase === 'embedding' ? (
                <RateEta rate={state.rate} eta={state.eta_seconds} />
              ) : embed === 'done' && embedTotal > 0 && state.embed_seconds ? (
                `${formatNumber(embedTotal)} in ${formatDuration(state.embed_seconds)} (${(embedTotal / state.embed_seconds).toFixed(1)} photos/s incl. model load)`
              ) : null
            }
          />
        )}
        <Step
          index={step++}
          last
          state={tag}
          title={state.mode === 'retag' ? 'Re-tag subjects' : 'Tag subjects'}
          hint="EG proposes · d1-3B confirms"
          done={tagDone}
          total={tagTotal}
          right={
            tag === 'active'
              ? `${formatNumber(tagDone)} / ${formatNumber(tagTotal)}`
              : tag === 'pending'
                ? state.running
                  ? 'Waiting'
                  : 'Not started'
                : tag === 'skipped'
                  ? 'Skipped'
                  : tag === 'idle'
                    ? status
                      ? `${formatNumber(status.tagged_count ?? 0)} tagged`
                      : ''
                    : tagTotal > 0
                      ? `${formatNumber(Math.max(0, tagDone - (state.tag_failed ?? 0)))} tagged`
                      : 'Nothing to tag'
          }
          meta={
            tag === 'active' ? (
              <RateEta rate={state.rate} eta={state.eta_seconds} />
            ) : tag === 'pending' && state.running ? (
              pendingTags > 0 ? `Starts after embedding · ~${formatDuration(pendingTags * secPer)} for ${formatNumber(pendingTags)} photos` : 'Starts after embedding'
            ) : tag === 'idle' && status ? (
              (status.untagged_count ?? 0) > 0 ? `${formatNumber(status.untagged_count)} untagged${status.tagger?.available === false || status.model.available === false ? '' : ' — Refresh tags them'}` : 'All photos tagged'
            ) : tag === 'done' && tagTotal > 0 && state.tag_seconds ? (
              `${formatNumber(tagDone)} in ${formatDuration(state.tag_seconds)} (${(tagDone / state.tag_seconds).toFixed(1)} photos/s incl. model load)`
            ) : null
          }
        />
      </ol>
      )}

      {state.error && (
        <div
          className={cn(
            'mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
            state.interrupted
              ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
              : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
          )}
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{state.error}</span>
        </div>
      )}
    </div>
  )
}

function ModelCard({ icon, name, detail, loaded, idleLabel, info }: { icon: ReactNode; name: string; detail: string; loaded?: boolean; idleLabel: string; info?: { available?: boolean; mode?: ModelMode } }) {
  const off = info?.available === false
  const remote = info?.mode === 'remote'
  if (off || remote) loaded = remote
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{name}</div>
        <div className="text-xs text-zinc-500 sm:truncate dark:text-zinc-400">{detail}</div>
      </div>
      {loaded !== undefined && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
            loaded
              ? 'bg-accent-50 text-accent-800 dark:bg-accent-950/60 dark:text-accent-200'
              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
          )}
        >
          <span className={cn('size-1.5 rounded-full', loaded ? 'bg-accent-500' : 'bg-zinc-400')} />
          {off ? 'Not available' : remote ? 'Remote' : loaded ? 'Loaded' : idleLabel}
        </span>
      )}
    </Card>
  )
}

function doneToast(p: IndexingState): string {
  if (p.mode === 'propagate') return runSummary(p) ?? 'Search complete'
  const what = p.mode === 'retag' ? 'Re-tagging' : p.mode === 'tag' ? 'Tagging' : 'Indexing'
  return `${what} complete — ${runSummary(p) ?? `${formatNumber(p.done)} processed`}`
}

export default function Admin() {
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [progress, setProgress] = useState<IndexingState | null>(null)
  const [dir, setDir] = useState('')
  const [prune, setPrune] = useState(false)
  const [confirm, setConfirm] = useState<'switch' | 'purge' | 'retag' | 'propagate' | null>(null)
  const [busy, setBusy] = useState<'switch' | 'purge' | 'refresh' | 'retag' | 'propagate' | null>(null)
  const [labels, setLabels] = useState<LabelInfo[] | null>(null)
  const [find, setFind] = useState<{ label: string; preview: PropagatePreview | null } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rebuild, setRebuild] = useState<string | null>(null)
  const wasRunning = useRef(false)

  const load = useCallback(async () => {
    // Config never touches the DB, so it loads even when the index needs a rebuild (409 from /status).
    const [s, c] = await Promise.allSettled([api.status(), api.admin.config()])
    const cfg = c.status === 'fulfilled' ? c.value : null
    if (cfg) setConfig(cfg)
    if (s.status === 'fulfilled') {
      api.labels
        .list()
        .then((r) => setLabels(r.items.filter((l) => l.source === 'user')))
        .catch(() => setLabels([]))
      setStatus(s.value)
      setProgress(s.value.indexing)
      setLoadError(null)
      setRebuild(null)
      return { s: s.value, c: cfg }
    }
    const err = s.reason as Error
    if (err instanceof ApiError && err.status === 409) {
      setRebuild(err.message)
      setLoadError(null)
      setStatus(null)
      setProgress(null)
    } else {
      setLoadError(err.message)
    }
    return { s: null, c: cfg }
  }, [])

  useEffect(() => {
    load().then((r) => setDir(r.c?.catalog_dir ?? ''))
  }, [load])

  // Poll progress every second while indexing runs; refresh status when it finishes.
  const running = !!progress?.running
  useEffect(() => {
    if (!running) return
    wasRunning.current = true
    const t = window.setInterval(async () => {
      try {
        const p = await api.admin.progress()
        setProgress(p)
        if (!p.running) {
          window.clearInterval(t)
          await load()
          if (p.error) toast.error(`${p.mode === 'refresh' ? 'Indexing' : p.mode === 'propagate' ? 'Looking for the tag' : 'Tagging'} failed: ${p.error}`)
          else toast.success(doneToast(p))
        } else if (p.done % 5 === 0) {
          api.status().then(setStatus).catch(() => {})
        }
      } catch {
        /* transient; keep polling */
      }
    }, 1000)
    return () => window.clearInterval(t)
  }, [running, load, toast])

  const refresh = async () => {
    setBusy('refresh')
    try {
      const r = await api.admin.refresh(prune)
      if (r.already_running) toast.info('A refresh is already running')
      const p = await api.admin.progress()
      setProgress(p)
      // Nothing new to do finishes before the first poll; report it right away.
      if (!p.running && !r.already_running) {
        await load()
        if (p.error) toast.error(`Indexing failed: ${p.error}`)
        else toast.success(`Index is up to date — ${runSummary(p) ?? 'no changes'}`)
      }
    } catch (err) {
      toast.error((err as Error).message)
      if (err instanceof ApiError && err.status === 409) load()
    } finally {
      setBusy(null)
    }
  }

  const retag = async () => {
    setBusy('retag')
    try {
      const r = await api.admin.retag()
      setConfirm(null)
      if (r.already_running) toast.info('Indexing is already running')
      else toast.success('Re-tagging started')
      setProgress(await api.admin.progress())
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const askFind = async (label: string) => {
    setFind({ label, preview: null })
    setConfirm('propagate')
    try {
      const preview = await api.labels.propagatePreview(label)
      setFind((f) => (f?.label === label ? { label, preview } : f))
    } catch (err) {
      toast.error((err as Error).message)
      setConfirm(null)
    }
  }

  const propagate = async () => {
    if (!find) return
    setBusy('propagate')
    try {
      const r = await api.labels.propagate(find.label)
      setConfirm(null)
      if (!r.started) toast.info(`No candidate photos for “${find.label}”`)
      else toast.success(`Looking for “${find.label}” in ${formatNumber(r.candidates)} photos`)
      setProgress(await api.admin.progress())
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const switchCatalog = async () => {
    setBusy('switch')
    try {
      await api.admin.setCatalog(dir.trim() || current, isRebuild)
      setConfirm(null)
      toast.success(isRebuild ? 'Rebuilding the catalog' : 'Catalog switched — indexing new photos')
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const purge = async () => {
    setBusy('purge')
    try {
      await api.admin.purge()
      setConfirm(null)
      toast.success('Library data purged')
      const r = await load()
      setDir(r.c?.catalog_dir ?? '')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const current = config?.catalog_dir ?? ''
  const dirChanged = dir.trim() !== '' && dir.trim() !== current
  // Same folder again = rebuild its index from scratch; another folder = switch (nothing is deleted).
  const isRebuild = !!current && !dirChanged
  const loading = !status && !loadError && !rebuild
  const photos = status?.image_count ?? 0
  const secPer = status?.tagger?.seconds_per_image ?? TAG_SECONDS_DEFAULT
  const untagged = status?.untagged_count ?? 0
  // Which models the server was started with (--embedding-model / --decision-model); undefined = older server.
  const canEmbed = status?.model.available !== false
  const canDecide = status?.tagger?.available !== false
  const canTag = canEmbed && canDecide
  const dash = rebuild ? '—' : undefined

  return (
    <div className="min-h-dvh">
      <TopBar page="admin" />
      <main className="mx-auto max-w-5xl px-4 pt-6 pb-20 md:px-6 md:pt-10">
        <div className="mb-6 md:mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Manage the catalog folder, indexing, subject tags and stored data.</p>
        </div>

        {loadError && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Couldn't reach the server</div>
              <div className="mt-0.5 opacity-80">{loadError}</div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => load()}>
              Retry
            </Button>
          </div>
        )}

        {rebuild && (
          <div className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-start dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <TriangleAlert className="mt-0.5 hidden size-4 shrink-0 sm:block" />
            <div className="flex-1">
              <div className="font-medium">The index needs a rebuild</div>
              <div className="mt-0.5 opacity-80">{rebuild}</div>
            </div>
            <Button size="sm" variant="primary" disabled={!current} onClick={() => setConfirm('switch')}>
              Rebuild catalog
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard icon={<Images className="size-3.5" />} label="Photos" value={dash ?? formatNumber(status?.image_count)} loading={loading} />
          <StatCard
            icon={<Tag className="size-3.5" />}
            label="Tagged"
            value={dash ?? formatNumber(status?.tagged_count)}
            sub={status && photos > 0 ? `${Math.round(((status.tagged_count ?? 0) / photos) * 100)}% of photos` : undefined}
            loading={loading}
          />
          <StatCard
            icon={<ScanEye className="size-3.5" />}
            label="Untagged"
            value={dash ?? formatNumber(status?.untagged_count)}
            sub={status ? (untagged > 0 ? `~${formatDuration(untagged * secPer)} to tag` : 'all tagged') : undefined}
            loading={loading}
          />
          <StatCard icon={<Heart className="size-3.5" />} label="Liked" value={dash ?? formatNumber(status?.liked_count)} loading={loading} />
          <StatCard icon={<Tags className="size-3.5" />} label="Subjects" value={dash ?? formatNumber(status?.subject_count)} sub={status?.tagger?.labels ? `of ${status.tagger.labels} labels` : undefined} loading={loading} />
          <StatCard icon={<Database className="size-3.5" />} label="Database" value={dash ?? formatBytes(status?.db_size_bytes)} loading={loading} />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <ModelCard
            icon={<Cpu className="size-5" />}
            name={status?.model.name ?? 'Embedding model'}
            detail={
              !status
                ? '—'
                : !canEmbed
                  ? 'No --embedding-model · search and indexing off'
                  : `${status.model.mode === 'remote' ? status.model.endpoint : (status.model.device ?? 'device unknown')} · ${status.model.dim}-d embeddings · search`
            }
            info={status?.model}
            loaded={status?.model.loaded}
            idleLabel="Loads on first use"
          />
          <ModelCard
            icon={<Sparkles className="size-5" />}
            name={status?.tagger?.name ?? 'Subject tagger'}
            detail={
              !status?.tagger
                ? '—'
                : !canDecide
                  ? 'No --decision-model · tagging off'
                  : `${status.tagger.mode === 'remote' ? status.tagger.endpoint : (status.tagger.device ?? 'device unknown')} · ${status.tagger.labels ?? '?'} labels · keep P ≥ ${status.tagger.threshold ?? 0.8}`
            }
            info={status?.tagger}
            loaded={status?.tagger?.loaded}
            idleLabel="Loads while tagging"
          />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          <section className="min-w-0 lg:col-span-3">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Catalog</h2>
            <Card className="p-4 md:p-5">
              <label htmlFor="catalog-dir" className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                Photo folder
              </label>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <FolderOpen className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="catalog-dir"
                    value={dir}
                    onChange={(e) => setDir(e.target.value)}
                    placeholder="/path/to/photos"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    className="field pl-9 font-mono text-[13px] md:h-10"
                  />
                </div>
                <Button variant="primary" disabled={!dir.trim() || running || !canEmbed} title={canEmbed ? undefined : 'Needs the embedding model'} onClick={() => setConfirm('switch')}>
                  {isRebuild ? 'Rebuild catalog' : 'Switch catalog'}
                </Button>
              </div>
              <dl className="mt-4 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-zinc-500 dark:text-zinc-400">Current</dt>
                <dd className="truncate font-mono text-zinc-800 dark:text-zinc-200">{current || <span className="text-zinc-400">not set</span>}</dd>
                <dt className="text-zinc-500 dark:text-zinc-400">Data directory</dt>
                <dd className="truncate font-mono text-zinc-800 dark:text-zinc-200">{config?.index_dir ?? config?.data_dir ?? '—'}</dd>
              </dl>

              <div className="mt-5 space-y-4 border-t border-zinc-200/70 pt-5 dark:border-zinc-800/70">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Refresh index</div>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {!canEmbed
                        ? 'Not available: this server runs without the embedding model.'
                        : !canDecide
                          ? 'Index new JPEGs. Existing photos are skipped. New photos stay untagged: no decision model.'
                          : 'Index new JPEGs, then tag untagged ones. Existing photos are skipped.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm whitespace-nowrap text-zinc-700 select-none md:min-h-0 dark:text-zinc-300">
                      <input
                        type="checkbox"
                        checked={prune}
                        onChange={(e) => setPrune(e.target.checked)}
                        className="size-4 rounded border-zinc-300 accent-accent-600 dark:border-zinc-700"
                      />
                      Prune missing
                    </label>
                    <Button onClick={refresh} loading={busy === 'refresh'} disabled={running || !current || !!rebuild || !canEmbed} variant="secondary">
                      {busy !== 'refresh' && <RefreshCw className={cn('size-4', running && progress?.mode === 'refresh' && 'animate-spin')} />}
                      Refresh
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Subject tags</div>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {canTag ? 'Re-run d1-3B over every photo, e.g. after editing the labels.' : 'Not available: tagging needs both the embedding and the decision model.'}
                    </p>
                  </div>
                  <Button
                    onClick={() => setConfirm('retag')}
                    loading={busy === 'retag'}
                    disabled={running || !current || !photos || !!rebuild || !canTag}
                    variant="secondary"
                    className="shrink-0"
                  >
                    {busy !== 'retag' && <Tags className="size-4" />}
                    Retag all
                  </Button>
                </div>
                <div className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-950/50">
                  {progress ? (
                    <Progress state={progress} status={status} />
                  ) : rebuild ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">Rebuild the catalog to start indexing.</p>
                  ) : (
                    <div className="h-24 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800" />
                  )}
                </div>
              </div>
            </Card>
          </section>

          <section className="min-w-0 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Your labels</h2>
            <Card className="mb-6 p-4 md:p-5">
              <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                Tags you created in the photo viewer. They join the {status?.tagger?.labels ? `${status.tagger.labels}-label ` : ''}vocabulary, so new
                and re-tagged photos are checked for them too.
              </p>
              {labels === null && !rebuild ? (
                <div className="mt-3 h-16 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800" />
              ) : !labels || labels.length === 0 ? (
                <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-3 text-sm text-zinc-500 dark:bg-zinc-950/50 dark:text-zinc-400">
                  None yet. Open a photo and use <span className="font-medium text-zinc-700 dark:text-zinc-200">Add a tag</span> to create one.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800/70" data-testid="user-labels">
                  {labels.map((l) => (
                    <li key={l.label} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={l.question ?? undefined}>
                          {labelCase(l.label)}
                        </div>
                        <div className="text-xs text-zinc-500 tabular dark:text-zinc-400">
                          {formatNumber(l.count)} photo{l.count === 1 ? '' : 's'}
                          {l.manual_count > 0 && l.manual_count < l.count ? ` · ${formatNumber(l.manual_count)} by hand` : ''}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => askFind(l.label)}
                        disabled={running || !current || !photos || !canTag}
                        title={canTag ? `Look for “${l.label}” in the photos that don't have it yet` : 'Needs both the embedding and the decision model'}
                      >
                        <Search className={cn('size-4', running && progress?.mode === 'propagate' && progress.labels?.includes(l.label) && 'animate-pulse')} />
                        Find in library
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Danger zone</h2>
            <Card className="border-red-200/80 p-4 md:p-5 dark:border-red-900/40">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Purge library data</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                Deletes this catalog's database, thumbnails, likes and tags. Other catalogs and your original photos are never touched.
              </p>
              <Button variant="danger-soft" className="mt-4 w-full sm:w-auto" onClick={() => setConfirm('purge')} disabled={running}>
                <Trash2 className="size-4" />
                Purge everything
              </Button>
            </Card>
          </section>
        </div>
      </main>

      <ConfirmDialog
        open={confirm === 'switch'}
        title={isRebuild ? 'Rebuild the catalog from scratch?' : 'Switch catalog?'}
        confirmLabel={isRebuild ? 'Purge & rebuild' : 'Switch catalog'}
        danger={isRebuild}
        loading={busy === 'switch'}
        onConfirm={switchCatalog}
        onClose={() => setConfirm(null)}
      >
        {isRebuild ? (
          <>
            <p>
              Re-indexing{' '}
              <span className="font-mono font-medium [overflow-wrap:anywhere] text-zinc-900 dark:text-zinc-100">{dir.trim() || current}</span>{' '}
              will <strong className="font-semibold text-red-600 dark:text-red-400">permanently delete everything</strong> photo-lib has
              stored for this catalog:
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              <li>the database, all embeddings and subject tags</li>
              <li>all thumbnails</li>
              <li>
                all likes{status?.liked_count ? ` (${formatNumber(status.liked_count)})` : ''}
              </li>
            </ul>
            <p className="mt-2">
              The folder will then be indexed and tagged from scratch
              {photos > 0 ? ` (tagging ${formatNumber(photos)} photos takes ~${formatDuration(photos * secPer)})` : ''}. Original photos are
              not modified.
            </p>
          </>
        ) : (
          <p>
            photo-lib will show{' '}
            <span className="font-mono font-medium [overflow-wrap:anywhere] text-zinc-900 dark:text-zinc-100">{dir.trim()}</span> and index
            the photos in it that are new. Nothing is deleted: every catalog keeps its own index, likes and tags, so you can switch back
            at any time.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'retag'}
        danger={false}
        title={`Retag all ${formatNumber(photos)} photos?`}
        confirmLabel="Retag all"
        loading={busy === 'retag'}
        onConfirm={retag}
        onClose={() => setConfirm(null)}
      >
        <p>
          This re-runs the <span className="font-medium text-zinc-900 dark:text-zinc-100">d1-3B</span> tagger over every photo: EmbeddingGemma
          proposes {status?.tagger?.labels ? 'the 20 most likely of ' + status.tagger.labels + ' labels' : '20 candidate labels'} per photo and
          d1 keeps the ones it confirms. Use it after editing <span className="font-mono text-[13px]">photolib/labels.py</span>. Tags you added by hand are kept.
        </p>
        <div className="mt-3 rounded-lg bg-zinc-100 px-3 py-2.5 dark:bg-zinc-800/70">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">Estimated time</div>
          <div className="text-base font-semibold text-zinc-900 tabular dark:text-zinc-50">~{formatDuration(Math.max(1, photos * secPer))}</div>
          <div className="text-xs text-zinc-500 tabular dark:text-zinc-400">
            {formatNumber(photos)} photos × {secPer} s on the reference GPU, plus model loading
          </div>
        </div>
        <p className="mt-3">
          Current subjects stay visible until each photo is re-tagged and search keeps working. Refresh and catalog changes wait until it
          finishes. The tagger uses ~6 GB of GPU memory while it runs and is unloaded afterwards.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'propagate'}
        danger={false}
        title={`Look for “${find?.label ?? ''}” in the library?`}
        confirmLabel={find?.preview && find.preview.candidates === 0 ? 'Nothing to check' : 'Find in library'}
        loading={busy === 'propagate'}
        confirmDisabled={!find?.preview}
        onConfirm={() => (find?.preview && find.preview.candidates === 0 ? setConfirm(null) : propagate())}
        onClose={() => setConfirm(null)}
      >
        <p>
          EmbeddingGemma shortlists the photos where <span className="font-medium text-zinc-900 dark:text-zinc-100">{find?.label}</span> is one
          of the 20 most likely labels and that don't have it yet; the <span className="font-medium text-zinc-900 dark:text-zinc-100">d1-3B</span>{' '}
          tagger then answers that one question per photo and the tag is added where it says yes. Other tags are not touched.
        </p>
        <div className="mt-3 rounded-lg bg-zinc-100 px-3 py-2.5 dark:bg-zinc-800/70">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">Candidates</div>
          {find?.preview ? (
            <>
              <div className="text-base font-semibold text-zinc-900 tabular dark:text-zinc-50">
                {formatNumber(find.preview.candidates)} photo{find.preview.candidates === 1 ? '' : 's'}
                {find.preview.candidates > 0 && <span className="font-normal text-zinc-500 dark:text-zinc-400"> · ~{formatDuration(Math.max(1, find.preview.est_seconds))}</span>}
              </div>
              <div className="text-xs text-zinc-500 tabular dark:text-zinc-400">
                {find.preview.candidates > 0 ? `of ${formatNumber(photos)} photos, ${secPer} s each plus model loading` : 'every likely photo already has this tag'}
              </div>
            </>
          ) : (
            <div className="mt-1 h-6 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'purge'}
        title="Purge all library data?"
        confirmLabel="Purge everything"
        confirmText="purge"
        loading={busy === 'purge'}
        onConfirm={purge}
        onClose={() => setConfirm(null)}
      >
        <p>
          This permanently deletes this catalog's database, embeddings, thumbnails, {status?.liked_count ? `${formatNumber(status.liked_count)} likes` : 'likes'} and
          tags. Other catalogs and the original photos are not touched. This can't be undone.
        </p>
      </ConfirmDialog>
    </div>
  )
}
