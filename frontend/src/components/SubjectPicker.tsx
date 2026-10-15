import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn, labelCase } from '../lib/format'
import type { SubjectCount } from '../lib/types'

const FIND_MAX = 40
const OWN = 'Your tags'

function SubjectChip({ s, on, onToggle }: { s: SubjectCount; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors md:h-8',
        on
          ? 'border-accent-600 bg-accent-600 text-white dark:border-accent-500 dark:bg-accent-500 dark:text-zinc-950'
          : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800',
      )}
    >
      {labelCase(s.label)}
      <span className={cn('text-[11px] tabular', on ? 'text-white/70 dark:text-zinc-950/60' : 'text-zinc-400')}>{s.count}</span>
    </button>
  )
}

/** Subject chips grouped by category, with a find box; selected subjects are listed first. */
export function SubjectPicker({
  subjects,
  selected,
  onChange,
}: {
  subjects: SubjectCount[] | null
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [find, setFind] = useState('')
  const q = find.trim().toLowerCase()
  const all = subjects ?? []
  const on = new Set(selected)
  const toggle = (label: string) => onChange(on.has(label) ? selected.filter((s) => s !== label) : [...selected, label])

  const matches = useMemo(() => {
    if (!q) return []
    // prefix matches (on any word) first, then substring matches; each group by count (API order)
    const rank = (label: string) => (label.startsWith(q) ? 0 : label.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2)
    return all
      .filter((s) => s.label.includes(q))
      .map((s, i) => ({ s, r: rank(s.label), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, FIND_MAX)
      .map((x) => x.s)
  }, [all, q])

  // Groups in order of their most common subject; labels you created go under "Your tags".
  const groups = useMemo(() => {
    const m = new Map<string, SubjectCount[]>()
    for (const s of all) {
      const g = s.category ?? OWN
      m.set(g, [...(m.get(g) ?? []), s])
    }
    return [...m.entries()]
  }, [all])

  if (subjects === null)
    return (
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="h-8 animate-pulse rounded-full bg-zinc-200/70 dark:bg-zinc-800" style={{ width: 52 + ((i * 23) % 40) }} />
        ))}
      </div>
    )
  if (!all.length) return <p className="text-sm text-zinc-500">No subjects yet. They appear once photos are tagged.</p>

  const picked = all.filter((s) => on.has(s.label))
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && find) {
              e.stopPropagation()
              setFind('')
            }
            if (e.key === 'Enter' && matches.length > 0) {
              toggle(matches[0].label)
              setFind('')
            }
          }}
          placeholder={`Find among ${all.length} subjects…`}
          aria-label="Find subject"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="field pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {find && (
          <button
            type="button"
            onClick={() => setFind('')}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Clear subject search"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {q ? (
        matches.length ? (
          <div className="flex flex-wrap gap-1.5">
            {matches.map((s) => (
              <SubjectChip key={s.label} s={s} on={on.has(s.label)} onToggle={() => toggle(s.label)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No subject matches “{find.trim()}”.</p>
        )
      ) : (
        <>
          {picked.length > 0 && (
            <Group title="Selected">
              {picked.map((s) => (
                <SubjectChip key={s.label} s={s} on onToggle={() => toggle(s.label)} />
              ))}
            </Group>
          )}
          {groups.map(([title, list]) => (
            <Group key={title} title={title}>
              {list.map((s) => (
                <SubjectChip key={s.label} s={s} on={on.has(s.label)} onToggle={() => toggle(s.label)} />
              ))}
            </Group>
          ))}
        </>
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{title}</h3>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </section>
  )
}
