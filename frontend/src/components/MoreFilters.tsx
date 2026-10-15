import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronRight, Grid2x2, Grid3x3 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn, formatNumber } from '../lib/format'
import { useDebouncedCallback } from '../lib/hooks'
import { PRESET_GROUPS, dateRangeLabel, monthSeries, presetActive, presetCount, type PresetGroup } from '../lib/presets'
import type { RangeKey, SearchState, Update } from '../lib/search'
import type { Facets, SortKey } from '../lib/types'
import type { Density } from './PhotoGrid'
import { Select } from './ui'


export const SORT_LABELS: Record<SortKey, string> = {
  random: 'Random',
  taken_at: 'Date taken',
  indexed_at: 'Date added',
  file_name: 'File name',
  liked_at: 'Date liked',
}

function Title({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-5 items-baseline justify-between gap-2">
      <h3 className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{children}</h3>
      {aside}
    </div>
  )
}

function Option({ on, onClick, label, hint, count }: { on: boolean; onClick: () => void; label: string; hint?: string; count?: number | null }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex min-h-12 min-w-0 flex-col items-start justify-center rounded-xl border px-3 py-1.5 text-left transition-colors',
        on
          ? 'border-accent-600 bg-accent-50 text-accent-800 dark:border-accent-400 dark:bg-accent-950/50 dark:text-accent-200'
          : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-800',
      )}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        {count != null && (
          <span className={cn('text-[11px] tabular', on ? 'text-accent-700 dark:text-accent-300' : 'text-zinc-400')}>{formatNumber(count)}</span>
        )}
      </span>
      {hint && (
        <span className={cn('w-full truncate text-[11px]', on ? 'text-accent-700/80 dark:text-accent-300/80' : 'text-zinc-500 dark:text-zinc-400')}>
          {hint}
        </span>
      )}
    </button>
  )
}

function Presets({ g, state, update, facets }: { g: PresetGroup; state: SearchState; update: Update; facets: Facets | null }) {
  return (
    <section>
      <Title>{g.title}</Title>
      <div className={cn('grid gap-1.5', g.presets.length === 4 ? 'grid-cols-2' : 'grid-cols-3')}>
        {g.presets.map((p) => {
          const on = presetActive(state, g, p)
          return (
            <Option
              key={p.id}
              on={on}
              onClick={() => update({ ranges: { [g.minKey]: on ? '' : p.min, [g.maxKey]: on ? '' : p.max } })}
              label={p.label}
              hint={p.hint}
              count={presetCount(facets?.[g.facet], p)}
            />
          )
        })}
      </div>
    </section>
  )
}

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

/**
 * Date histogram. A library that spans more than ~1.5 years shows one bar per year (only years with photos);
 * tapping a year selects it and zooms into its months. In the month view a tap picks a month and a second tap
 * on another month makes it a range.
 */
function DateHistogram({ state, update, facets }: { state: SearchState; update: Update; facets: Facets | null }) {
  const from = state.ranges.date_from
  const to = state.ranges.date_to
  const series = useMemo(() => monthSeries(facets?.months), [facets])
  const years = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of facets?.months ?? []) m.set(x.value.slice(0, 4), (m.get(x.value.slice(0, 4)) ?? 0) + x.count)
    return [...m].map(([value, count]) => ({ value, count }))
  }, [facets])
  const selYear = from && to && from.slice(0, 4) === to.slice(0, 4) ? from.slice(0, 4) : ''
  const [zoom, setZoom] = useState(selYear)
  useEffect(() => {
    if (selYear) setZoom(selYear)
  }, [selYear])
  const byYear = series.length > 18
  const showYears = byYear && !zoom

  const bars = showYears
    ? years
    : byYear
      ? Array.from({ length: 12 }, (_, i) => {
          const key = `${zoom}-${String(i + 1).padStart(2, '0')}`
          return { value: key, count: facets?.months.find((m) => m.value === key)?.count ?? 0 }
        })
      : series
  const max = Math.max(1, ...bars.map((m) => m.count))
  const clear = () => update({ ranges: { date_from: '', date_to: '' } })
  const lit = (v: string) => {
    if (!from && !to) return false
    if (v.length === 4) return (!from || v >= from.slice(0, 4)) && (!to || v <= to.slice(0, 4))
    return (!from || v >= from.slice(0, 7)) && (!to || v <= to.slice(0, 7)) && !(from.length === 4 && to === from && v.slice(0, 4) !== from)
  }
  const pick = (v: string) => {
    if (v.length === 4) {
      setZoom(v)
      return update({ ranges: { date_from: v, date_to: v } })
    }
    if (from === v && to === v) return byYear ? update({ ranges: { date_from: v.slice(0, 4), date_to: v.slice(0, 4) } }) : clear()
    if (from && from === to && from.length === 7) {
      const [a, b] = v < from ? [v, from] : [from, v]
      return update({ ranges: { date_from: a, date_to: b } })
    }
    update({ ranges: { date_from: v, date_to: v } })
  }
  const label = (v: string) => (v.length === 4 ? `’${v.slice(2)}` : MONTH_INITIALS[Number(v.slice(5)) - 1])

  return (
    <section>
      <Title
        aside={
          from || to ? (
            <button type="button" onClick={clear} className="text-xs font-medium text-accent-700 hover:text-accent-800 dark:text-accent-400">
              {dateRangeLabel(from, to)} ×
            </button>
          ) : (
            <span className="text-xs text-zinc-400">Any time</span>
          )
        }
      >
        Date taken
      </Title>
      {bars.length === 0 ? (
        <p className="text-sm text-zinc-500">No dates in the photos' EXIF.</p>
      ) : (
        <>
          {byYear && zoom && (
            <button
              type="button"
              onClick={() => setZoom('')}
              className="mb-1.5 flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <ChevronRight className="size-3.5 rotate-180" />
              All years · <span className="text-zinc-900 dark:text-zinc-100">{zoom}</span>
            </button>
          )}
          <div className="flex h-16 items-end gap-1" role="group" aria-label={showYears ? 'Photos per year' : 'Photos per month'}>
            {bars.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => m.count && pick(m.value)}
                disabled={!m.count}
                title={`${dateRangeLabel(m.value, m.value)}: ${formatNumber(m.count)} photo${m.count === 1 ? '' : 's'}`}
                aria-label={`${dateRangeLabel(m.value, m.value)}, ${m.count} photos`}
                aria-pressed={lit(m.value)}
                className="group flex h-full min-w-0 flex-1 flex-col items-stretch justify-end gap-1 disabled:cursor-default"
              >
                <span
                  className={cn(
                    'w-full rounded-t-[3px] transition-colors',
                    lit(m.value)
                      ? 'bg-accent-600 dark:bg-accent-400'
                      : m.count
                        ? 'bg-zinc-300 group-hover:bg-zinc-400 dark:bg-zinc-700 dark:group-hover:bg-zinc-600'
                        : 'bg-zinc-200 dark:bg-zinc-800',
                  )}
                  style={{ height: `${m.count ? Math.max(8, (m.count / max) * 100) : 4}%` }}
                />
                {bars.length <= 16 && (
                  <span className={cn('text-center text-[10px] leading-none tabular', lit(m.value) ? 'font-semibold text-accent-700 dark:text-accent-300' : 'text-zinc-400')}>
                    {label(m.value)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {bars.length > 16 && (
            <div className="mt-1 flex justify-between text-[11px] text-zinc-400 tabular">
              <span>{dateRangeLabel(bars[0].value, bars[0].value)}</span>
              <span>{dateRangeLabel(bars[bars.length - 1].value, bars[bars.length - 1].value)}</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function RangeInput({
  label,
  minKey,
  maxKey,
  state,
  update,
  step,
  unit,
  type = 'number',
}: {
  label: string
  minKey: RangeKey
  maxKey: RangeKey
  state: SearchState
  update: Update
  step?: number
  unit?: string
  type?: 'number' | 'date'
}) {
  const [lo, setLo] = useState(state.ranges[minKey])
  const [hi, setHi] = useState(state.ranges[maxKey])
  useEffect(() => setLo(state.ranges[minKey]), [state.ranges, minKey])
  useEffect(() => setHi(state.ranges[maxKey]), [state.ranges, maxKey])
  // One debounce for both ends: typing "from" then "to" quickly must not drop the first value.
  const commit = useDebouncedCallback((a: string, b: string) => update({ ranges: { [minKey]: a, [maxKey]: b } }, { replace: true }), 600)
  const input = (key: RangeKey, value: string, set: (v: string) => void, aria: string) => (
    <div className="relative min-w-0 flex-1">
      <input
        type={type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        step={step}
        value={value}
        placeholder={type === 'number' ? (key === minKey ? 'Min' : 'Max') : undefined}
        aria-label={aria}
        onChange={(e) => {
          set(e.target.value)
          if (key === minKey) commit(e.target.value, hi)
          else commit(lo, e.target.value)
        }}
        className={cn('field tabular', unit && 'pr-9', type === 'date' && 'pr-2 text-[13px]')}
      />
      {unit && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-zinc-400">{unit}</span>}
    </div>
  )
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="flex items-center gap-2">
        {input(minKey, lo, setLo, `${label} from`)}
        <span className="text-zinc-300 dark:text-zinc-600">–</span>
        {input(maxKey, hi, setHi, `${label} to`)}
      </div>
    </div>
  )
}

/** Everything the dock's More panel offers: presets, date, camera, sort and thumbnail size. */
export function MoreFilters({
  state,
  update,
  facets,
  sortable,
  density,
  onDensity,
}: {
  state: SearchState
  update: Update
  facets: Facets | null
  sortable: boolean
  density: Density
  onDensity: (d: Density) => void
}) {
  const [custom, setCustom] = useState(false)
  return (
    <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
      <div className="flex flex-col gap-5">
        {PRESET_GROUPS.map((g) => (
          <Presets key={g.title} g={g} state={state} update={update} facets={facets} />
        ))}
        <section>
          <button
            type="button"
            onClick={() => setCustom((v) => !v)}
            aria-expanded={custom}
            className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', custom && 'rotate-90')} />
            Exact ranges
          </button>
          {custom && (
            <div className="mt-3 grid gap-3">
              <RangeInput label="Focal length" minKey="focal_min" maxKey="focal_max" state={state} update={update} step={1} unit="mm" />
              <RangeInput label="ISO" minKey="iso_min" maxKey="iso_max" state={state} update={update} step={100} />
              <RangeInput label="Aperture" minKey="f_min" maxKey="f_max" state={state} update={update} step={0.1} unit="ƒ" />
              <RangeInput label="Date" minKey="date_from" maxKey="date_to" state={state} update={update} type="date" />
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-5">
        <DateHistogram state={state} update={update} facets={facets} />
        <section>
          <Title>Camera</Title>
          <div className="grid gap-2">
            <Select value={state.model} onChange={(e) => update({ model: e.target.value })} aria-label="Camera">
              <option value="">Any camera</option>
              {facets?.models.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </Select>
            <Select value={state.lens} onChange={(e) => update({ lens: e.target.value })} aria-label="Lens">
              <option value="">Any lens</option>
              {facets?.lenses.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value} ({f.count})
                </option>
              ))}
            </Select>
          </div>
        </section>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          {sortable && (
            <section>
              <Title>Sort by</Title>
              <div className="flex items-center gap-1.5">
                <Select
                  value={state.sort}
                  onChange={(e) => update({ sort: e.target.value as SortKey }, { replace: true })}
                  aria-label="Sort by"
                  className="w-40"
                >
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABELS[k]}
                    </option>
                  ))}
                </Select>
                {state.sort !== 'random' && (
                  <button
                    type="button"
                    onClick={() => update({ order: state.order === 'desc' ? 'asc' : 'desc' }, { replace: true })}
                    className="grid size-11 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-600 md:size-9 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                    aria-label={state.order === 'desc' ? 'Descending, newest first' : 'Ascending, oldest first'}
                    title={state.order === 'desc' ? 'Descending' : 'Ascending'}
                  >
                    {state.order === 'desc' ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpNarrowWide className="size-4" />}
                  </button>
                )}
              </div>
            </section>
          )}
          <section>
            <Title>Thumbnails</Title>
            <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-900">
              {(['compact', 'comfortable'] as Density[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onDensity(d)}
                  aria-pressed={density === d}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium md:h-8',
                    density === d
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
                  )}
                >
                  {d === 'compact' ? <Grid3x3 className="size-4" /> : <Grid2x2 className="size-4" />}
                  {d === 'compact' ? 'Small' : 'Large'}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
