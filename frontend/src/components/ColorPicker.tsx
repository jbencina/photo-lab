import { Check, Pipette, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn, normalizeHex, readableOn } from '../lib/format'
import { useDebouncedCallback } from '../lib/hooks'

export const PRESET_COLORS: { hex: string; name: string }[] = [
  { hex: '#e53935', name: 'Red' },
  { hex: '#fb8c00', name: 'Orange' },
  { hex: '#fdd835', name: 'Yellow' },
  { hex: '#7cb342', name: 'Lime' },
  { hex: '#2e7d32', name: 'Green' },
  { hex: '#00897b', name: 'Teal' },
  { hex: '#4fc3f7', name: 'Sky' },
  { hex: '#1e88e5', name: 'Blue' },
  { hex: '#283593', name: 'Navy' },
  { hex: '#8e24aa', name: 'Purple' },
  { hex: '#ec407a', name: 'Pink' },
  { hex: '#6d4c41', name: 'Brown' },
  { hex: '#d7c4a3', name: 'Sand' },
  { hex: '#fafafa', name: 'White' },
  { hex: '#9e9e9e', name: 'Gray' },
  { hex: '#212121', name: 'Black' },
]

export function ColorPicker({ value, onChange }: { value: string | null; onChange: (hex: string | null) => void }) {
  const committed = value ? normalizeHex(value) : null
  // The native picker fires continuously while dragging; show the color live but commit it debounced.
  const [draft, setDraft] = useState<string | null>(committed)
  useEffect(() => setDraft(committed), [committed])
  const commit = useDebouncedCallback((hex: string) => onChange(hex), 300)
  const isPreset = PRESET_COLORS.some((c) => c.hex === draft)
  return (
    <div>
      <div className="grid grid-cols-8 gap-1.5">
        {PRESET_COLORS.map((c) => {
          const active = draft === c.hex
          return (
            <button
              key={c.hex}
              type="button"
              title={c.name}
              aria-label={`${c.name} ${c.hex}`}
              aria-pressed={active}
              onClick={() => onChange(active ? null : c.hex)}
              className={cn(
                'relative aspect-square min-h-8 rounded-full ring-1 ring-black/10 ring-inset transition-transform duration-150 hover:scale-110 dark:ring-white/15',
                active && 'scale-110 ring-2 ring-offset-2 ring-offset-white ring-zinc-900 dark:ring-white dark:ring-offset-zinc-900',
              )}
              style={{ backgroundColor: c.hex }}
            >
              {active && (
                <Check className="absolute inset-0 m-auto size-3.5" style={{ color: readableOn(c.hex) }} strokeWidth={3} />
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label
          className={cn(
            'relative flex h-11 flex-1 cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-sm shadow-xs transition-colors hover:border-zinc-300 md:h-9 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700',
            draft && !isPreset && 'border-zinc-900 dark:border-zinc-200',
          )}
        >
          <span
            className="grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-black/10 ring-inset dark:ring-white/15"
            style={{
              background: draft
                ? draft
                : 'conic-gradient(from 0deg, #f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)',
            }}
          >
            {!draft && <Pipette className="size-3 text-white drop-shadow" />}
          </span>
          <span className={cn('flex-1 truncate font-mono text-xs', draft ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400')}>
            {draft ?? 'Custom color'}
          </span>
          <input
            type="color"
            value={draft ?? '#3b82f6'}
            onChange={(e) => {
              const hex = e.target.value.toLowerCase()
              setDraft(hex)
              commit(hex)
            }}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            aria-label="Pick a custom color"
          />
        </label>
        {draft && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex h-11 items-center gap-1 rounded-lg px-3 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 md:h-9 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="size-3.5" />
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
