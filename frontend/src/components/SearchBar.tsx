import { AnimatePresence, motion } from 'framer-motion'
import { Aperture, Calendar, Camera, Check, ChevronDown, CornerDownLeft, Heart, Search, Sparkles, Tag, Tags, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/format'
import { useDebouncedCallback } from '../lib/hooks'
import type { SearchMode, SearchPatch, SearchState } from '../lib/search'
import { countText, suggest, withoutFragment, type Suggestion, type SuggestionKind } from '../lib/smart'
import type { Facets, SubjectCount } from '../lib/types'

const KIND_ICON: Record<SuggestionKind, typeof Tags> = {
  subject: Tags,
  preset: Aperture,
  date: Calendar,
  camera: Camera,
  lens: Aperture,
  liked: Heart,
}

const MODES: Record<SearchMode, { label: string; hint: string; placeholder: string; icon: typeof Sparkles }> = {
  query: {
    label: 'Query',
    hint: 'Describe what is in the photo',
    placeholder: 'Search photos…',
    icon: Sparkles,
  },
  meta: {
    label: 'Metadata',
    hint: 'File name, camera, lens, software',
    placeholder: 'Filename, camera, lens…',
    icon: Tag,
  },
}

export function SearchBar({
  value,
  mode,
  onSubmit,
  onModeChange,
  onLiveChange,
  queryAvailable = true,
  state,
  subjects,
  facets,
  onFilter,
}: {
  value: string
  mode: SearchMode
  onSubmit: (q: string) => void
  onModeChange: (m: SearchMode) => void
  /** Called (debounced) while typing in Metadata mode. */
  onLiveChange: (q: string) => void
  /** False when the server has no embedding model: the Query mode is shown disabled. */
  queryAvailable?: boolean
  /** The box suggests filters for the word being typed (see lib/smart.ts). */
  state: SearchState
  subjects: SubjectCount[] | null
  facets: Facets | null
  onFilter: (patch: SearchPatch) => void
}) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1) // -1 = Enter searches the text
  const suggestions = useMemo(
    () => (focused && !dismissed ? suggest(text, state, subjects, facets) : []),
    [text, state, subjects, facets, focused, dismissed],
  )
  const ids = suggestions.map((x) => x.id).join('|')
  useEffect(() => setActive(-1), [ids])
  const open = suggestions.length > 0
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastLive = useRef<string | null>(null)
  const live = useDebouncedCallback((q: string) => {
    lastLive.current = q
    onLiveChange(q)
  }, 350)

  // Sync from the URL (back/forward, clear), but don't clobber typing that our own live update caused.
  useEffect(() => {
    if (value === lastLive.current) return
    lastLive.current = null
    setText(value)
  }, [value])

  // Switching to Metadata mode applies whatever is in the box (also covers typing that raced the mode switch).
  const textRef = useRef(text)
  textRef.current = text
  const valueRef = useRef(value)
  valueRef.current = value
  useEffect(() => {
    if (mode === 'meta' && textRef.current.trim() !== valueRef.current) live(textRef.current.trim())
  }, [mode, live])

  useEffect(() => {
    if (!menuOpen) return

    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // "/" focuses search on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const M = MODES[mode]
  const ModeIcon = M.icon

  const pick = (sg: Suggestion) => {
    const rest = withoutFragment(text, sg.fragment)
    onFilter(sg.patch)
    setText(rest ? `${rest} ` : '')
    if (mode === 'meta') live(rest)
    setDismissed(true)
    inputRef.current?.focus()
  }

  return (
    <form
      role="search"
      className="group relative flex h-11 items-center rounded-xl border border-zinc-200 bg-white shadow-xs transition-[border-color,box-shadow] focus-within:border-accent-500 focus-within:ring-3 focus-within:ring-accent-500/15 hover:border-zinc-300 md:h-10 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:border-accent-400 dark:focus-within:ring-accent-400/15 dark:hover:border-zinc-700"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(text.trim())
        inputRef.current?.blur()
      }}
    >
      <Search className="pointer-events-none ml-3 size-4 shrink-0 text-zinc-400" />
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={text}
        role="combobox"
        aria-expanded={open}
        aria-controls="search-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `sg-${active}` : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          setDismissed(false)
          if (mode === 'meta') live(e.target.value.trim())
        }}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = suggestions.length
            setActive((i) => (e.key === 'ArrowDown' ? (i + 2) % (n + 1) - 1 : ((i + n + 1) % (n + 1)) - 1))
          } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
            e.preventDefault()
            pick(suggestions[active])
          } else if (e.key === 'Escape') {
            e.preventDefault() // keep the text (a search input clears itself on Escape)
            setDismissed(true)
          }
        }}
        placeholder={M.placeholder}
        aria-label={`Search (${M.label} mode)`}
        className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-[15px] text-zinc-900 outline-none placeholder:text-zinc-400 md:text-sm dark:text-zinc-100 dark:placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText('')
            onSubmit('')
            inputRef.current?.focus()
          }}
          className="grid size-9 shrink-0 place-items-center rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          aria-label="Clear search"
        >
          <X className="size-4" />
        </button>
      )}
      {open && (
        <div
          id="search-suggestions"
          role="listbox"
          aria-label="Add a filter"
          className="absolute inset-x-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/40"
        >
          <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Add a filter</div>
          {suggestions.map((sg, i) => {
            const I = KIND_ICON[sg.kind]
            return (
              <button
                key={sg.id}
                id={`sg-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(sg)}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left md:min-h-9 md:pointer-coarse:min-h-11',
                  i === active ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
                )}
              >
                <I className={cn('size-4 shrink-0', sg.kind === 'liked' ? 'text-rose-500' : 'text-zinc-400')} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{sg.label}</span>
                  {sg.hint && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{sg.hint}</span>}
                </span>
                <span className="shrink-0 text-xs text-zinc-400 tabular">{countText(sg.count)}</span>
              </button>
            )
          })}
          <div className="mt-1 hidden items-center gap-1.5 border-t border-zinc-100 px-3 pt-2 pb-1.5 text-xs text-zinc-400 md:flex dark:border-zinc-800">
            <CornerDownLeft className="size-3.5" />
            {active >= 0 ? 'adds the highlighted filter' : `searches “${text.trim()}”`}
            <span className="ml-auto">↑↓ pick a filter · Esc hide</span>
          </div>
        </div>
      )}
      <div ref={menuRef} className="relative h-full shrink-0 border-l border-zinc-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-label={`Search mode: ${M.label}`}
          className="flex h-full items-center gap-1.5 rounded-r-xl px-3 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-50"
        >
          <ModeIcon className={cn('size-4', mode === 'query' ? 'text-accent-600 dark:text-accent-400' : '')} />
          <span className="hidden sm:inline">{M.label}</span>
          <ChevronDown className={cn('size-3.5 text-zinc-400 transition-transform', menuOpen && 'rotate-180')} />
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              role="listbox"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
              className="absolute top-[calc(100%+8px)] right-0 z-40 w-72 origin-top-right rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl shadow-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/40"
            >
              {(Object.keys(MODES) as SearchMode[]).map((m) => {
                const I = MODES[m].icon
                const active = m === mode
                const off = m === 'query' && !queryAvailable
                return (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-disabled={off}
                    disabled={off}
                    onClick={() => {
                      setMenuOpen(false)
                      if (m !== mode) onModeChange(m)
                      inputRef.current?.focus()
                    }}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-zinc-100 dark:bg-zinc-800' : off ? 'cursor-not-allowed opacity-50' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
                    )}
                  >
                    <I className={cn('mt-0.5 size-4 shrink-0', m === 'query' ? 'text-accent-600 dark:text-accent-400' : 'text-zinc-500')} />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{MODES[m].label}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">{off ? 'Needs the embedding model, which this server runs without' : MODES[m].hint}</span>
                    </span>
                    {active && <Check className="mt-0.5 size-4 text-zinc-900 dark:text-zinc-100" />}
                  </button>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </form>
  )
}
