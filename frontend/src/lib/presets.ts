import type { RangeKey, SearchState } from './search'
import type { FacetValue } from './types'

/** A ready-made range for one of the exposure filters ('' = open end). */
export interface Preset {
  id: string
  label: string
  hint: string
  min: string
  max: string
}

export interface PresetGroup {
  title: string
  minKey: RangeKey
  maxKey: RangeKey
  facet: 'focal_values' | 'iso_values' | 'f_values'
  presets: Preset[]
}

export const PRESET_GROUPS: PresetGroup[] = [
  {
    title: 'Lens',
    minKey: 'focal_min',
    maxKey: 'focal_max',
    facet: 'focal_values',
    presets: [
      { id: 'wide', label: 'Wide', hint: 'under 35mm', min: '', max: '34.9' },
      { id: 'normal', label: 'Normal', hint: '35–70mm', min: '35', max: '69.9' },
      { id: 'tele', label: 'Tele', hint: '70–300mm', min: '70', max: '299.9' },
      { id: 'super', label: 'Super-tele', hint: '300mm+', min: '300', max: '' },
    ],
  },
  {
    title: 'Light',
    minKey: 'iso_min',
    maxKey: 'iso_max',
    facet: 'iso_values',
    presets: [
      { id: 'bright', label: 'Bright', hint: 'ISO ≤ 400', min: '', max: '400' },
      { id: 'indoor', label: 'Dim', hint: 'ISO 500–2500', min: '401', max: '3199' },
      { id: 'low', label: 'Low light', hint: 'ISO 3200+', min: '3200', max: '' },
    ],
  },
  {
    title: 'Depth of field',
    minKey: 'f_min',
    maxKey: 'f_max',
    facet: 'f_values',
    presets: [
      { id: 'shallow', label: 'Shallow', hint: 'ƒ/2.8 or wider', min: '', max: '2.8' },
      { id: 'medium', label: 'Medium', hint: 'ƒ/3.2–ƒ/7.1', min: '2.9', max: '7.9' },
      { id: 'deep', label: 'Deep', hint: 'ƒ/8 or narrower', min: '8', max: '' },
    ],
  },
]

export function presetActive(state: SearchState, g: PresetGroup, p: Preset): boolean {
  return state.ranges[g.minKey] === p.min && state.ranges[g.maxKey] === p.max
}

/** Returns how many photos in the library fall in the preset's range. */
export function presetCount(values: FacetValue<number>[] | undefined, p: Preset): number | null {
  if (!values) return null
  const lo = p.min ? Number(p.min) : -Infinity
  const hi = p.max ? Number(p.max) : Infinity
  return values.reduce((n, v) => (v.value >= lo && v.value <= hi ? n + v.count : n), 0)
}

/** Every month from the first to the last one with photos, so gaps show as empty bars. */
export function monthSeries(months: FacetValue<string>[] | undefined): FacetValue<string>[] {
  if (!months?.length) return []
  const counts = new Map(months.map((m) => [m.value, m.count]))
  const [y0, m0] = months[0].value.split('-').map(Number)
  const [y1, m1] = months[months.length - 1].value.split('-').map(Number)
  const out: FacetValue<string>[] = []
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, (m = 1)) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push({ value: key, count: counts.get(key) ?? 0 })
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats a `YYYY` / `YYYY-MM` / `YYYY-MM-DD` prefix for chips and labels. */
export function formatDatePrefix(v: string): string {
  const [y, m, d] = v.split('-')
  if (!m) return y
  return `${d ? `${Number(d)} ` : ''}${MONTHS[Number(m) - 1]} ${y}`
}

/** Returns the label of a date range ("Jun – Aug 2025", "2024", "since Mar 2025"). */
export function dateRangeLabel(from: string, to: string): string {
  if (from && to && from === to) return formatDatePrefix(from)
  if (from && to) {
    const [a, b] = [formatDatePrefix(from), formatDatePrefix(to)]
    const ya = a.split(' ').pop()
    return ya === b.split(' ').pop() && a.includes(' ') ? `${a.replace(` ${ya}`, '')} – ${b}` : `${a} – ${b}`
  }
  if (from) return `since ${formatDatePrefix(from)}`
  return `until ${formatDatePrefix(to)}`
}
