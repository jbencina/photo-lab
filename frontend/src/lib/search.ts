import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import type { Params } from './api'
import type { SortKey, SortOrder } from './types'

export type SearchMode = 'query' | 'meta'
export type ResultKind = 'browse' | 'meta' | 'query' | 'similar' | 'color'

export const RANGE_KEYS = ['iso_min', 'iso_max', 'f_min', 'f_max', 'focal_min', 'focal_max', 'date_from', 'date_to'] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export interface SearchState {
  q: string
  mode: SearchMode
  similar: string | null
  color: string | null
  liked: boolean
  subjects: string[]
  make: string
  model: string
  lens: string
  ranges: Record<RangeKey, string>
  sort: SortKey
  order: SortOrder
  /** Shuffle for the random sort; a new one per page load unless the URL pins it. */
  seed: number
  view: string | null
}

export type SearchPatch = Partial<Omit<SearchState, 'ranges'>> & { ranges?: Partial<Record<RangeKey, string>> }
/** `update` from `useSearchState`, as the filter components receive it. */
export type Update = (patch: SearchPatch, opts?: { replace?: boolean }) => void

const SORTS: SortKey[] = ['random', 'taken_at', 'file_name', 'indexed_at', 'liked_at']
export const DEFAULT_SORT: SortKey = 'random'

/** Reloading the page reshuffles; paging, filters and the lightbox keep the same order. */
export const SESSION_SEED = Math.floor(Math.random() * 1e9)
export const newSeed = () => Math.floor(Math.random() * 1e9)

export function parseSearch(sp: URLSearchParams): SearchState {
  const ranges = Object.fromEntries(RANGE_KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<RangeKey, string>
  const sort = sp.get('sort') as SortKey | null
  return {
    q: sp.get('q') ?? '',
    mode: sp.get('mode') === 'meta' ? 'meta' : 'query',
    similar: sp.get('similar'),
    color: sp.get('color'),
    liked: sp.get('liked') === '1',
    subjects: sp.getAll('subject'),
    make: sp.get('make') ?? '',
    model: sp.get('model') ?? '',
    lens: sp.get('lens') ?? '',
    ranges,
    sort: sort && SORTS.includes(sort) ? sort : DEFAULT_SORT,
    order: sp.get('order') === 'asc' ? 'asc' : 'desc',
    seed: Number(sp.get('seed')) || SESSION_SEED,
    view: sp.get('view'),
  }
}

export function serializeSearch(s: SearchState): URLSearchParams {
  const sp = new URLSearchParams()
  if (s.q) sp.set('q', s.q)
  if (s.mode === 'meta') sp.set('mode', 'meta')
  if (s.similar) sp.set('similar', s.similar)
  if (s.color) sp.set('color', s.color)
  if (s.liked) sp.set('liked', '1')
  for (const subj of s.subjects) sp.append('subject', subj)
  if (s.make) sp.set('make', s.make)
  if (s.model) sp.set('model', s.model)
  if (s.lens) sp.set('lens', s.lens)
  for (const k of RANGE_KEYS) if (s.ranges[k]) sp.set(k, s.ranges[k])
  if (s.sort !== DEFAULT_SORT) sp.set('sort', s.sort)
  if (s.sort !== 'random' && s.order !== 'desc') sp.set('order', s.order)
  if (s.sort === 'random' && s.seed !== SESSION_SEED) sp.set('seed', String(s.seed))
  if (s.view) sp.set('view', s.view)
  return sp
}

export function resultKind(s: SearchState): ResultKind {
  if (s.similar) return 'similar'
  if (s.color) return 'color'
  if (s.q && s.mode === 'query') return 'query'
  if (s.q && s.mode === 'meta') return 'meta'
  return 'browse'
}

/** Filters shared by /images and the search endpoints. */
export function filterParams(s: SearchState): Params {
  return {
    liked: s.liked,
    subject: s.subjects,
    make: s.make,
    model: s.model,
    lens: s.lens,
    ...s.ranges,
  }
}

export function activeFilterCount(s: SearchState): number {
  return (
    (s.liked ? 1 : 0) +
    s.subjects.length +
    (s.make ? 1 : 0) +
    (s.model ? 1 : 0) +
    (s.lens ? 1 : 0) +
    RANGE_KEYS.filter((k) => s.ranges[k]).length +
    (s.color ? 1 : 0)
  )
}

/** Stable key for everything that affects the result set (excludes the open lightbox). */
export function resultKey(s: SearchState): string {
  const sp = serializeSearch({ ...s, view: null })
  sp.sort()
  return sp.toString()
}

export function useSearchState() {
  const [sp, setSp] = useSearchParams()
  const state = useMemo(() => parseSearch(sp), [sp])

  const update = useCallback(
    (p: SearchPatch, opts: { replace?: boolean; state?: unknown } = {}) => {
      setSp(
        (prev) => {
          const cur = parseSearch(prev)
          const next: SearchState = { ...cur, ...p, ranges: { ...cur.ranges, ...(p.ranges ?? {}) } }
          return serializeSearch(next)
        },
        { replace: opts.replace, state: opts.state },
      )
    },
    [setSp],
  )

  return { state, update }
}

export const EMPTY_RANGES: Record<RangeKey, string> = Object.fromEntries(RANGE_KEYS.map((k) => [k, ''])) as Record<
  RangeKey,
  string
>

export const CLEARED_FILTERS: SearchPatch = {
  liked: false,
  subjects: [],
  make: '',
  model: '',
  lens: '',
  ranges: EMPTY_RANGES,
  color: null,
}
