import { AnimatePresence } from 'framer-motion'
import {
  CircleAlert,
  FolderOpen,
  Heart,
  Images,
  LoaderCircle,
  Palette,
  ScanSearch,
  SearchX,
  Sparkles,
  Tag,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Dock } from '../components/Dock'
import { EmptyState } from '../components/EmptyState'
import { Lightbox } from '../components/Lightbox'
import { PhotoGrid, type Density } from '../components/PhotoGrid'
import { SearchBar } from '../components/SearchBar'
import { useToast } from '../components/Toast'
import { TopBar } from '../components/TopBar'
import { Button } from '../components/ui'
import { ApiError, api, isAbort } from '../lib/api'
import { cn, formatAperture, formatNumber, labelCase, readableOn } from '../lib/format'
import { useLocalStorage, useMediaQuery } from '../lib/hooks'
import { PRESET_GROUPS, dateRangeLabel, presetActive } from '../lib/presets'
import {
  CLEARED_FILTERS,
  activeFilterCount,
  filterParams,
  resultKey,
  resultKind,
  useSearchState,
  type RangeKey,
  type ResultKind,
  type SearchPatch,
  type SearchState,
} from '../lib/search'
import type { Facets, ImageDetail, ImageSummary, Status, SubjectCount, SubjectScore } from '../lib/types'

const PAGE = 60

interface Results {
  key: string
  items: ImageSummary[]
  total: number | null
  hasMore: boolean
}

async function fetchResults(s: SearchState, offset: number, limit: number, signal: AbortSignal) {
  const filters = filterParams(s)
  const kind = resultKind(s)
  if (kind === 'browse' || kind === 'meta') {
    const r = await api.images(
      {
        ...filters,
        q_meta: kind === 'meta' ? s.q : undefined,
        sort: s.sort,
        order: s.order,
        seed: s.sort === 'random' ? s.seed : undefined,
        limit,
        offset,
      },
      signal,
    )
    return { items: r.items, total: r.total }
  }
  // Ranked endpoints have no total; they page with offset like /images.
  const r =
    kind === 'query'
      ? await api.searchQuery({ ...filters, q: s.q, limit, offset }, signal)
      : kind === 'similar'
        ? await api.searchSimilar(s.similar!, { ...filters, limit, offset }, signal)
        : await api.searchColor({ ...filters, hex: s.color!, limit, offset }, signal)
  return { items: r.items, total: null }
}

function SkeletonGrid() {
  const ratios = [1.5, 0.67, 1.33, 1, 0.8, 1.5, 1.78, 0.67, 1.5, 1.33, 0.75, 1.5]
  return (
    <div className="columns-2 gap-1.5 sm:columns-3 sm:gap-3 lg:columns-4 xl:columns-5">
      {ratios.map((r, i) => (
        <div
          key={i}
          className="mb-1.5 animate-pulse break-inside-avoid rounded-lg bg-zinc-200/80 sm:mb-3 md:rounded-xl dark:bg-zinc-800/70"
          style={{ aspectRatio: String(r), animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  )
}

function Chip({ children, onRemove, swatch }: { children: ReactNode; onRemove: () => void; swatch?: string }) {
  return (
    <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-white pr-1 pl-2.5 text-[13px] font-medium text-zinc-700 shadow-xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
      {swatch && <span className="size-3.5 rounded-full ring-1 ring-black/10 dark:ring-white/20" style={{ backgroundColor: swatch }} />}
      <span className="max-w-[16rem] truncate">{children}</span>
      <button
        type="button"
        onClick={onRemove}
        className="relative grid size-6 place-items-center rounded-full text-zinc-400 after:absolute after:-inset-2.5 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label="Remove filter"
      >
        <X className="size-3.5" />
      </button>
    </span>
  )
}

function rangeLabel(lo: string, hi: string, fmt: (v: string) => string): string {
  if (lo && hi) return `${fmt(lo)} – ${fmt(hi)}`
  if (lo) return `≥ ${fmt(lo)}`
  return `≤ ${fmt(hi)}`
}

function ActiveFilters({ state, update }: { state: SearchState; update: (p: SearchPatch) => void }) {
  const chips: ReactNode[] = []
  const clearRange = (a: RangeKey, b: RangeKey) => update({ ranges: { [a]: '', [b]: '' } })
  if (state.liked)
    chips.push(
      <Chip key="liked" onRemove={() => update({ liked: false })}>
        <Heart className="mr-1 inline size-3.5 fill-rose-500 align-[-2px] text-rose-500" />
        Liked
      </Chip>,
    )
  for (const s of state.subjects)
    chips.push(
      <Chip key={`s-${s}`} onRemove={() => update({ subjects: state.subjects.filter((x) => x !== s) })}>
        {labelCase(s)}
      </Chip>,
    )
  if (state.make) chips.push(<Chip key="make" onRemove={() => update({ make: '' })}>{state.make}</Chip>)
  if (state.model) chips.push(<Chip key="model" onRemove={() => update({ model: '' })}>{state.model}</Chip>)
  if (state.lens) chips.push(<Chip key="lens" onRemove={() => update({ lens: '' })}>{state.lens}</Chip>)
  const r = state.ranges
  for (const g of PRESET_GROUPS) {
    const p = g.presets.find((x) => presetActive(state, g, x))
    if (p)
      chips.push(
        <Chip key={g.minKey} onRemove={() => clearRange(g.minKey, g.maxKey)}>
          {p.label}
        </Chip>,
      )
  }
  const preset = (a: RangeKey) => PRESET_GROUPS.some((g) => g.minKey === a && g.presets.some((x) => presetActive(state, g, x)))
  if ((r.iso_min || r.iso_max) && !preset('iso_min'))
    chips.push(
      <Chip key="iso" onRemove={() => clearRange('iso_min', 'iso_max')}>
        ISO {rangeLabel(r.iso_min, r.iso_max, (v) => v)}
      </Chip>,
    )
  if ((r.f_min || r.f_max) && !preset('f_min'))
    chips.push(
      <Chip key="f" onRemove={() => clearRange('f_min', 'f_max')}>
        {rangeLabel(r.f_min, r.f_max, (v) => formatAperture(Number(v)) ?? v)}
      </Chip>,
    )
  if ((r.focal_min || r.focal_max) && !preset('focal_min'))
    chips.push(
      <Chip key="focal" onRemove={() => clearRange('focal_min', 'focal_max')}>
        {rangeLabel(r.focal_min, r.focal_max, (v) => `${v}mm`)}
      </Chip>,
    )
  if (r.date_from || r.date_to)
    chips.push(
      <Chip key="date" onRemove={() => clearRange('date_from', 'date_to')}>
        {dateRangeLabel(r.date_from, r.date_to)}
      </Chip>,
    )
  if (!chips.length) return null
  return (
    <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
      {chips}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => update({ ...CLEARED_FILTERS, color: state.color })}
          className="h-8 shrink-0 rounded-full px-3 text-[13px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

function ResultTitle({ kind, state, similarSource }: { kind: ResultKind; state: SearchState; similarSource: ImageDetail | null }) {
  const pill = (icon: ReactNode, label: string) => (
    <span className="inline-flex h-6 items-center gap-1 rounded-md bg-zinc-200/60 px-1.5 text-[11px] font-semibold tracking-wide text-zinc-600 uppercase dark:bg-zinc-800 dark:text-zinc-300">
      {icon}
      {label}
    </span>
  )
  switch (kind) {
    case 'query':
      return (
        <div className="flex min-w-0 items-center gap-2">
          {pill(<Sparkles className="size-3 text-accent-600 dark:text-accent-400" />, 'Query')}
          <h1 className="truncate text-base font-semibold md:text-lg">“{state.q}”</h1>
        </div>
      )
    case 'meta':
      return (
        <div className="flex min-w-0 items-center gap-2">
          {pill(<Tag className="size-3" />, 'Metadata')}
          <h1 className="truncate text-base font-semibold md:text-lg">“{state.q}”</h1>
        </div>
      )
    case 'similar':
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          {pill(<ScanSearch className="size-3" />, 'Similar')}
          {similarSource && (
            <img
              src={similarSource.thumb_url}
              alt=""
              className="size-7 shrink-0 rounded-md object-cover ring-1 ring-black/5 dark:ring-white/10"
              style={{ backgroundColor: similarSource.colors[0]?.hex }}
            />
          )}
          <h1 className="truncate text-base font-semibold md:text-lg">{similarSource?.file_name ?? state.similar}</h1>
        </div>
      )
    case 'color':
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          {pill(<Palette className="size-3" />, 'Color')}
          <span
            className="grid h-7 place-items-center rounded-md px-2 font-mono text-xs font-medium ring-1 ring-black/10 ring-inset dark:ring-white/15"
            style={{ backgroundColor: state.color!, color: readableOn(state.color!) }}
          >
            {state.color}
          </span>
        </div>
      )
    default:
      return <h1 className="text-base font-semibold md:text-lg">{state.liked ? 'Liked photos' : 'All photos'}</h1>
  }
}

export default function Library() {
  const { state, update } = useSearchState()
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [subjects, setSubjects] = useState<SubjectCount[] | null>(null)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsRebuild, setNeedsRebuild] = useState(false)
  const [similarSource, setSimilarSource] = useState<ImageDetail | null>(null)
  const [density, setDensity] = useLocalStorage<Density>('photolib:density', 'compact')
  const [tick, setTick] = useState(0)
  const [subjectsTick, setSubjectsTick] = useState(0) // bumped when tags change in the lightbox
  const kind = resultKind(state)
  const key = resultKey(state)
  const stateRef = useRef(state)
  stateRef.current = state

  // ---- side data: status, subjects, facets ----
  // Without an embedding model on the server there is no semantic search: the search box works on metadata only.
  const canQuery = status?.model.available !== false
  useEffect(() => {
    if (!canQuery && state.mode === 'query') update({ mode: 'meta' }, { replace: true })
  }, [canQuery, state.mode, update])
  const imageCount = status?.image_count
  const taggedCount = status?.tagged_count
  useEffect(() => {
    const ctrl = new AbortController()
    api.status(ctrl.signal).then(setStatus).catch((e) => !isAbort(e) && setStatus(null))
    return () => ctrl.abort()
  }, [])
  useEffect(() => {
    if (imageCount === undefined) return // wait for status; refetch when the image count changes
    const ctrl = new AbortController()
    api.facets(ctrl.signal).then(setFacets).catch(() => {})
    return () => ctrl.abort()
  }, [imageCount])
  useEffect(() => {
    if (imageCount === undefined) return // subjects also change while the tag pass runs
    const ctrl = new AbortController()
    api
      .subjects(ctrl.signal)
      .then((r) => setSubjects(r.items))
      .catch((e) => !isAbort(e) && setSubjects([]))
    return () => ctrl.abort()
  }, [imageCount, taggedCount, subjectsTick])

  // While indexing runs, poll status and refresh the grid as photos arrive.
  const running = status?.indexing.running
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => {
      api
        .status()
        .then((s) => {
          setStatus((prev) => {
            if (prev && prev.image_count !== s.image_count) setTick((n) => n + 1)
            return s
          })
        })
        .catch(() => {})
    }, 2000)
    return () => window.clearInterval(t)
  }, [running])

  // ---- main results ----
  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    const s = stateRef.current
    fetchResults(s, 0, PAGE, ctrl.signal)
      .then((r) => {
        setResults({
          key,
          items: r.items,
          total: r.total,
          hasMore: r.total != null ? r.items.length < r.total : r.items.length >= PAGE,
        })
      })
      .catch((err) => {
        if (isAbort(err)) return
        setError((err as Error).message)
        setNeedsRebuild(err instanceof ApiError && err.status === 409)
        setResults({ key, items: [], total: 0, hasMore: false })
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false))
    return () => ctrl.abort()
  }, [key, tick])

  useEffect(() => {
    if (!state.similar) return setSimilarSource(null)
    const ctrl = new AbortController()
    api.image(state.similar, ctrl.signal).then(setSimilarSource).catch(() => {})
    return () => ctrl.abort()
  }, [state.similar])

  // Scroll to top whenever the result set changes (but not on load more / like).
  const firstKey = useRef(key)
  useEffect(() => {
    if (firstKey.current === key) return
    firstKey.current = key
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [key])

  const loadingMoreRef = useRef(false)
  const loadMore = async () => {
    if (!results || loadingMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const ctrl = new AbortController()
    try {
      const r = await fetchResults(state, results.items.length, PAGE, ctrl.signal)
      setResults((prev) => {
        if (!prev || prev.key !== key) return prev
        const seen = new Set(prev.items.map((i) => i.id))
        const items = [...prev.items, ...r.items.filter((i) => !seen.has(i.id))]
        const hasMore =
          r.total != null ? items.length < r.total && r.items.length > 0 : r.items.length >= PAGE
        return { ...prev, items, total: r.total, hasMore }
      })
    } catch (err) {
      if (!isAbort(err)) {
        toast.error((err as Error).message)
        setAutoLoad(false) // don't hammer a failing server; the Load more button stays as the fallback
      }
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  // ---- infinite scroll: load the next page when the sentinel nears the viewport ----
  // "Load more" stays visible as the fallback, and is the only trigger with prefers-reduced-motion.
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [autoLoad, setAutoLoad] = useState(true)
  useEffect(() => setAutoLoad(true), [key])
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore
  const canAutoLoad = autoLoad && !reducedMotion && !!results?.hasMore && !loading && results.key === key
  const loadedCount = results?.items.length ?? 0
  useEffect(() => {
    const el = sentinelRef.current
    if (!canAutoLoad || !el || typeof IntersectionObserver === 'undefined') return
    // Re-created after every page, so a sentinel that is still on screen triggers the next one.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current()
      },
      { rootMargin: '0px 0px 1200px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [canAutoLoad, loadedCount])

  // ---- likes (optimistic) ----
  const setLiked = useCallback((id: string, liked: boolean) => {
    setResults((prev) => prev && { ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, liked } : i)) })
  }, [])
  const onLike = useCallback(
    (image: ImageSummary, liked: boolean) => {
      setLiked(image.id, liked)
      api
        .like(image.id, liked)
        .then((r) => {
          if (r.liked !== liked) setLiked(image.id, r.liked)
          setStatus((s) => s && { ...s, liked_count: Math.max(0, s.liked_count + (r.liked ? 1 : -1)) })
        })
        .catch((err) => {
          setLiked(image.id, !liked)
          toast.error(`Couldn't update like: ${(err as Error).message}`)
        })
    },
    [setLiked, toast],
  )

  // ---- tags edited in the lightbox: keep the grid's summaries and the subject chips in sync ----
  const onSubjectsChanged = useCallback((id?: string, subs?: SubjectScore[]) => {
    if (id && subs) {
      const top = subs.slice(0, 5).map(({ label, score, source }) => ({ label, score, source }))
      setResults((prev) => prev && { ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, subjects: top } : i)) })
    }
    setSubjectsTick((n) => n + 1)
    api.status().then(setStatus).catch(() => {})
  }, [])

  // ---- lightbox wiring (lives in the URL so back closes it) ----
  const items = results?.items ?? []
  const itemsRef = useRef(items)
  itemsRef.current = items
  const openAt = useCallback(
    (index: number) => {
      const img = itemsRef.current[index]
      if (img) update({ view: img.id }, { state: { lightbox: true } })
    },
    [update],
  )
  const closeLightbox = useCallback(() => {
    if ((location.state as { lightbox?: boolean } | null)?.lightbox) navigate(-1)
    else update({ view: null }, { replace: true })
  }, [location.state, navigate, update])
  const navigateLightbox = useCallback(
    (id: string) => update({ view: id }, { replace: true, state: location.state }),
    [update, location.state],
  )

  const filterCount = activeFilterCount(state)
  const clearAll = () => update({ ...CLEARED_FILTERS, q: '', similar: null })
  const isFiltered = kind !== 'browse' || filterCount > 0
  const stale = loading && results != null && results.key !== key

  const countLabel = useMemo(() => {
    if (!results || (error && !results.items.length)) return null
    if (results.total != null) return `${formatNumber(results.total)} photo${results.total === 1 ? '' : 's'}`
    const n = results.items.length
    return `${n}${results.hasMore ? '+' : ''} photo${n === 1 ? '' : 's'} · best match first`
  }, [results, error])

  const noCatalog = !!status && !status.catalog_dir && !isFiltered
  let body: ReactNode
  if (noCatalog) {
    body = (
      <EmptyState
        icon={<FolderOpen className="size-6" />}
        title="No catalog configured"
        action={
          <Link to="/admin">
            <Button variant="primary">Set up a catalog</Button>
          </Link>
        }
      >
        Point photo-lib at a folder of JPEGs and it will index them for search, colors and subjects.
      </EmptyState>
    )
  } else if (error && needsRebuild && !items.length) {
    body = (
      <EmptyState
        icon={<CircleAlert className="size-6 text-amber-500" />}
        title="The index needs a rebuild"
        action={
          <Link to="/admin">
            <Button variant="primary">Open admin</Button>
          </Link>
        }
      >
        {error}
      </EmptyState>
    )
  } else if (error && !items.length) {
    body = (
      <EmptyState
        icon={<CircleAlert className="size-6 text-red-500" />}
        title="Something went wrong"
        action={
          <Button onClick={() => setTick((t) => t + 1)} variant="secondary">
            Try again
          </Button>
        }
      >
        {error}
      </EmptyState>
    )
  } else if (!results || (loading && !items.length)) {
    body = <SkeletonGrid />
  } else if (!items.length) {
    body =
      status && status.image_count === 0 && !isFiltered ? (
        <EmptyState
          icon={status.indexing.running ? <LoaderCircle className="size-6 animate-spin" /> : <Images className="size-6" />}
          title={status.indexing.running ? 'Indexing your photos…' : 'Your catalog is empty'}
          action={
            <Link to="/admin">
              <Button variant="secondary">Open admin</Button>
            </Link>
          }
        >
          {status.indexing.running
            ? `${status.indexing.done} of ${status.indexing.total} processed. Photos will appear here as they're indexed.`
            : 'Run a refresh from the admin page to index photos in your catalog folder.'}
        </EmptyState>
      ) : (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="No matching photos"
          action={
            <Button onClick={clearAll} variant="secondary">
              Clear search & filters
            </Button>
          }
        >
          Try a different search, or loosen some filters.
        </EmptyState>
      )
  } else {
    body = (
      <>
        <div className={cn('transition-opacity duration-200', stale && 'opacity-50')}>
          <PhotoGrid items={items} density={density} onOpen={openAt} onLike={onLike} />
        </div>
        {results.hasMore && (
          <div ref={sentinelRef} className="flex justify-center py-10">
            <Button onClick={loadMore} loading={loadingMore} variant="secondary" className="min-w-40">
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
        {!results.hasMore && items.length > 12 && (
          <p className="py-10 text-center text-xs text-zinc-400 dark:text-zinc-500">That's everything.</p>
        )}
      </>
    )
  }

  return (
    <div className="min-h-dvh">
      <TopBar
        page="library"
        search={
          <SearchBar
            value={state.q}
            mode={state.mode}
            onSubmit={(q) => update({ q, similar: null, color: q ? null : state.color })}
            onModeChange={(mode) => update({ mode }, { replace: true })}
            queryAvailable={canQuery}
            state={state}
            subjects={subjects}
            facets={facets}
            onFilter={update}
            onLiveChange={(q) => {
              if (q !== state.q) update({ q, similar: null, color: null }, { replace: true })
            }}
          />
        }
      />

      <div className="mx-auto max-w-[1800px]">
        <main className="px-4 pt-4 pb-32 md:px-6 md:pt-5">
          <div className={cn('mb-4 flex flex-col gap-2 md:gap-3', noCatalog && 'hidden')}>
            <div className="flex min-h-9 min-w-0 items-center">
              <ResultTitle kind={kind} state={state} similarSource={similarSource} />
            </div>
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="tabular">{countLabel ?? ' '}</span>
              {loading && results && <LoaderCircle className="size-3.5 animate-spin" />}
              {isFiltered && (
                <>
                  <span className="text-zinc-300 dark:text-zinc-700">·</span>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-300 dark:hover:text-zinc-100"
                  >
                    Clear
                  </button>
                </>
              )}
              {status?.indexing.running && (
                <Link
                  to="/admin"
                  className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-800 dark:bg-accent-950/60 dark:text-accent-200"
                >
                  <LoaderCircle className="size-3 animate-spin" />
                  {status.indexing.phase === 'tagging' ? 'Tagging' : 'Indexing'}{' '}
                  {status.indexing.total > 0 ? `${formatNumber(status.indexing.done)}/${formatNumber(status.indexing.total)}` : '…'}
                </Link>
              )}
            </div>
            <ActiveFilters state={state} update={update} />
          </div>

          {body}
        </main>
      </div>

      {!noCatalog && (
        <Dock
          state={state}
          update={update}
          subjects={subjects}
          facets={facets}
          sortable={kind === 'browse' || kind === 'meta'}
          density={density}
          onDensity={setDensity}
          countLabel={countLabel}
          hidden={!!state.view}
        />
      )}

      <AnimatePresence>
        {state.view && (
          <Lightbox
            key="lightbox"
            id={state.view}
            items={items}
            onClose={closeLightbox}
            onNavigate={navigateLightbox}
            onLike={onLike}
            onSimilar={(id) => update({ similar: id, q: '', color: null, view: null }, { replace: true })}
            onColor={(hex) => update({ color: hex, similar: null, q: '', view: null }, { replace: true })}
            onSubject={(label) => update({ subjects: [label], similar: null, color: null, q: '', view: null }, { replace: true })}
            onSubjectsChanged={onSubjectsChanged}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
