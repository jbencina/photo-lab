import { AnimatePresence, motion } from 'framer-motion'
import { CalendarArrowDown, CalendarArrowUp, Heart, Shuffle, SlidersHorizontal, Tags, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn, normalizeHex } from '../lib/format'
import { EMPTY_RANGES, newSeed, type SearchState, type Update } from '../lib/search'
import type { Facets, SubjectCount } from '../lib/types'
import { ColorPicker, PRESET_COLORS } from './ColorPicker'
import { MoreFilters } from './MoreFilters'
import type { Density } from './PhotoGrid'
import { SubjectPicker } from './SubjectPicker'

type PanelId = 'color' | 'subjects' | 'more'

/** Number of filters the More panel owns (exposure ranges count once per pair). */
export function moreCount(s: SearchState): number {
  const r = s.ranges
  return (
    (s.make ? 1 : 0) +
    (s.model ? 1 : 0) +
    (s.lens ? 1 : 0) +
    (r.focal_min || r.focal_max ? 1 : 0) +
    (r.iso_min || r.iso_max ? 1 : 0) +
    (r.f_min || r.f_max ? 1 : 0) +
    (r.date_from || r.date_to ? 1 : 0)
  )
}

function DockButton({
  icon,
  label,
  onClick,
  active,
  open,
  pressed,
  expanded,
  badge,
  ariaLabel,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  /** The current sort mode (accent color). */
  active?: boolean
  /** A panel is open or the filter is on (lighter highlight). */
  open?: boolean
  /** For toggles (aria-pressed). */
  pressed?: boolean
  /** For the buttons that open a panel (aria-expanded). */
  expanded?: boolean
  badge?: number
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-pressed={pressed ?? active}
      aria-expanded={expanded}
      className={cn(
        'relative flex h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-medium transition-colors md:h-11 md:flex-none md:flex-row md:gap-2 md:px-3.5 md:text-[13px]',
        active
          ? 'bg-accent-600 text-white dark:bg-accent-500 dark:text-zinc-950'
          : open
            ? 'bg-zinc-700 text-white dark:bg-zinc-600'
            : 'text-zinc-300 hover:bg-zinc-800 hover:text-white dark:hover:bg-zinc-700',
      )}
    >
      {icon}
      <span className="max-w-full truncate">{label}</span>
      {!!badge && (
        <span className="absolute top-1 right-[calc(50%-22px)] grid h-4 min-w-4 place-items-center rounded-full bg-accent-400 px-1 text-[10px] font-semibold text-zinc-950 tabular md:static md:h-[18px] md:min-w-[18px]">
          {badge}
        </span>
      )}
    </button>
  )
}

function Panel({
  title,
  onClose,
  action,
  footer,
  className,
  children,
}: {
  title: string
  onClose: () => void
  action?: ReactNode
  footer?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'fixed inset-x-2 bottom-[calc(max(12px,env(safe-area-inset-bottom))+72px)] z-40 md:inset-x-auto md:bottom-24 md:left-1/2 md:-translate-x-1/2',
        className,
      )}
    >
      <motion.div
        role="dialog"
        aria-label={title}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[calc(100dvh-180px)] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-950/20 md:max-h-[calc(100dvh-160px)] dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-2 md:px-5 md:pt-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <div className="flex items-center gap-1">
            {action}
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 grid size-10 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 md:size-8 dark:hover:bg-zinc-800"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-5 md:pb-5">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-zinc-200 px-4 py-2.5 text-[13px] text-zinc-500 md:px-5 dark:border-zinc-800 dark:text-zinc-400">
            {footer}
          </div>
        )}
      </motion.div>
    </div>
  )
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-md px-2 text-[13px] font-medium text-accent-700 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-300"
    >
      Clear
    </button>
  )
}

/**
 * Floating control bar at the bottom of the library (desktop and phone alike): sort, liked, color, subjects
 * and "More". Color, Subjects and More open a panel above the bar.
 */
export function Dock({
  state,
  update,
  subjects,
  facets,
  sortable,
  density,
  onDensity,
  countLabel,
  hidden,
}: {
  state: SearchState
  update: Update
  subjects: SubjectCount[] | null
  facets: Facets | null
  sortable: boolean
  density: Density
  onDensity: (d: Density) => void
  countLabel: string | null
  hidden?: boolean
}) {
  const [panel, setPanel] = useState<PanelId | null>(null)
  const toggle = (p: PanelId) => setPanel((cur) => (cur === p ? null : p))
  const close = () => setPanel(null)
  useEffect(() => {
    if (!panel) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPanel(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])
  useEffect(() => {
    if (hidden) setPanel(null)
  }, [hidden])

  const color = state.color ? normalizeHex(state.color) : null
  const colorName = color ? (PRESET_COLORS.find((c) => c.hex === color)?.name ?? 'Custom') : 'Color'
  const more = moreCount(state)
  const byDate = state.sort === 'taken_at'
  const footer = countLabel ? <span className="tabular">{countLabel}</span> : undefined

  return (
    <>
      <AnimatePresence>
        {panel && !hidden && (
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-30 bg-zinc-950/25 md:bg-transparent"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
        )}
        {panel === 'color' && !hidden && (
          <Panel key="color" title="Color" onClose={close} className="md:w-[400px]" footer={footer}>
            <ColorPicker value={state.color} onChange={(hex) => update({ color: hex, similar: null, q: hex ? '' : state.q }, { replace: !!state.color && !!hex })} />
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Photos are ranked by how much of the color they contain.</p>
          </Panel>
        )}
        {panel === 'subjects' && !hidden && (
          <Panel
            key="subjects"
            title="Subjects"
            onClose={close}
            className="md:w-[560px]"
            action={state.subjects.length > 0 ? <ClearButton onClick={() => update({ subjects: [] })} /> : undefined}
            footer={footer}
          >
            <SubjectPicker subjects={subjects} selected={state.subjects} onChange={(next) => update({ subjects: next })} />
          </Panel>
        )}
        {panel === 'more' && !hidden && (
          <Panel
            key="more"
            title="More filters"
            onClose={close}
            className="md:w-[min(880px,calc(100vw-48px))]"
            action={
              more > 0 ? (
                <ClearButton
                  onClick={() =>
                    update({
                      make: '',
                      model: '',
                      lens: '',
                      ranges: EMPTY_RANGES,
                    })
                  }
                />
              ) : undefined
            }
            footer={footer}
          >
            <MoreFilters state={state} update={update} facets={facets} sortable={sortable} density={density} onDensity={onDensity} />
          </Panel>
        )}
      </AnimatePresence>

      <nav
        aria-label="Library controls"
        className={cn(
          'fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-40 flex items-center gap-0.5 rounded-full bg-zinc-900/95 p-1.5 shadow-xl ring-1 shadow-zinc-950/25 ring-black/5 backdrop-blur transition-[opacity,transform] duration-200 md:inset-x-auto md:bottom-6 md:left-1/2 md:-translate-x-1/2 dark:bg-zinc-800/95 dark:ring-white/10',
          hidden && 'pointer-events-none translate-y-4 opacity-0 md:translate-y-4',
        )}
      >
        {sortable && (
          <>
            <DockButton
              icon={<Shuffle className="size-[18px] md:size-4" />}
              label="Shuffle"
              ariaLabel={state.sort === 'random' ? 'Shuffle again' : 'Shuffle'}
              active={state.sort === 'random'}
              onClick={() => update(state.sort === 'random' ? { seed: newSeed() } : { sort: 'random' }, { replace: true })}
            />
            <DockButton
              icon={
                byDate && state.order === 'asc' ? (
                  <CalendarArrowUp className="size-[18px] md:size-4" />
                ) : (
                  <CalendarArrowDown className="size-[18px] md:size-4" />
                )
              }
              label={byDate ? (state.order === 'asc' ? 'Oldest' : 'Newest') : 'By date'}
              ariaLabel={byDate ? `By date, ${state.order === 'asc' ? 'oldest' : 'newest'} first (tap to flip)` : 'Sort by date taken'}
              active={byDate}
              onClick={() =>
                update(byDate ? { order: state.order === 'desc' ? 'asc' : 'desc' } : { sort: 'taken_at', order: 'desc' }, { replace: true })
              }
            />
            <span className="mx-1 hidden h-6 w-px bg-zinc-700 md:block" />
          </>
        )}
        <DockButton
          icon={<Heart className={cn('size-[18px] md:size-4', state.liked && 'fill-rose-500 text-rose-500')} />}
          label="Liked"
          ariaLabel="Liked only"
          open={state.liked}
          pressed={state.liked}
          onClick={() => update({ liked: !state.liked })}
        />
        <DockButton
          icon={
            color ? (
              <span className="size-[18px] rounded-full ring-2 ring-white md:size-3.5" style={{ backgroundColor: color }} />
            ) : (
              <span className="flex h-[18px] items-center md:h-4">
                <span className="size-3 rounded-full bg-[#e53935]" />
                <span className="-ml-1 size-3 rounded-full bg-[#fdd835]" />
                <span className="-ml-1 size-3 rounded-full bg-[#1e88e5]" />
              </span>
            )
          }
          label={colorName}
          ariaLabel={color ? `Color: ${colorName}` : 'Color'}
          open={panel === 'color' || !!color}
          expanded={panel === 'color'}
          onClick={() => toggle('color')}
        />
        <DockButton
          icon={<Tags className="size-[18px] md:size-4" />}
          label="Subjects"
          badge={state.subjects.length}
          open={panel === 'subjects'}
          expanded={panel === 'subjects'}
          onClick={() => toggle('subjects')}
        />
        <DockButton
          icon={<SlidersHorizontal className="size-[18px] md:size-4" />}
          label="More"
          ariaLabel="More filters"
          badge={more}
          open={panel === 'more'}
          expanded={panel === 'more'}
          onClick={() => toggle('more')}
        />
      </nav>
    </>
  )
}
