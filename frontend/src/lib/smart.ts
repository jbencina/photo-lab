/**
 * Filter suggestions for the search box. Only the word(s) being typed at the end of the text are matched,
 * nothing is applied until the user picks a suggestion, and Enter keeps searching the text as typed, so
 * typing a sentence is never hijacked.
 */
import { formatNumber, labelCase } from './format'
import { PRESET_GROUPS, presetActive, presetCount } from './presets'
import type { SearchPatch, SearchState } from './search'
import type { Facets, SubjectCount } from './types'

export type SuggestionKind = 'subject' | 'preset' | 'date' | 'camera' | 'lens' | 'liked'

export interface Suggestion {
  id: string
  kind: SuggestionKind
  label: string
  hint?: string
  count?: number | null
  /** The trailing text this suggestion replaces when picked. */
  fragment: string
  patch: SearchPatch
}

interface Candidate {
  id: string
  kind: SuggestionKind
  label: string
  hint?: string
  count?: number | null
  keys: string[]
  patch: SearchPatch
}

const MAX = 6
const MIN_CHARS = 3
// Words that are part of almost any sentence; on their own they never trigger suggestions.
const STOP = new Set(
  'a an the in on at of with and or to by for from near over under is are was it its this that my our some very into onto up down out off'.split(
    ' ',
  ),
)
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const PRESET_ALIASES: Record<string, string[]> = {
  wide: ['wide', 'wide angle', 'wide-angle'],
  normal: ['normal lens'],
  tele: ['tele', 'telephoto', 'zoom'],
  super: ['super-tele', 'super tele', 'super telephoto', 'supertele'],
  bright: ['bright', 'daylight', 'low iso'],
  indoor: ['dim', 'indoor', 'indoors'],
  low: ['low light', 'lowlight', 'high iso'],
  shallow: ['shallow', 'bokeh', 'shallow depth', 'wide open'],
  medium: ['medium depth'],
  deep: ['deep focus', 'deep depth', 'stopped down'],
}

function candidates(state: SearchState, subjects: SubjectCount[] | null, facets: Facets | null): Candidate[] {
  const out: Candidate[] = []
  const picked = new Set(state.subjects)
  for (const s of subjects ?? []) {
    if (picked.has(s.label)) continue
    out.push({ id: `s:${s.label}`, kind: 'subject', label: labelCase(s.label), hint: 'Subject', count: s.count, keys: [s.label], patch: { subjects: [...state.subjects, s.label] } })
  }
  for (const g of PRESET_GROUPS)
    for (const p of g.presets) {
      if (presetActive(state, g, p)) continue
      out.push({
        id: `p:${p.id}`,
        kind: 'preset',
        label: p.label,
        hint: `${g.title} · ${p.hint}`,
        count: presetCount(facets?.[g.facet], p),
        keys: PRESET_ALIASES[p.id],
        patch: { ranges: { [g.minKey]: p.min, [g.maxKey]: p.max } },
      })
    }
  if (!state.liked)
    out.push({ id: 'liked', kind: 'liked', label: 'Liked', hint: 'Only photos you liked', keys: ['liked', 'likes', 'favorite', 'favorites', 'favourite', 'favourites', 'hearted'], patch: { liked: true } })
  for (const m of facets?.models ?? [])
    if (m.value !== state.model)
      out.push({ id: `c:${m.value}`, kind: 'camera', label: m.value, hint: 'Camera', count: m.count, keys: [m.value.toLowerCase()], patch: { model: m.value } })
  for (const l of facets?.lenses ?? [])
    if (l.value !== state.lens)
      out.push({ id: `l:${l.value}`, kind: 'lens', label: l.value, hint: 'Lens', count: l.count, keys: [l.value.toLowerCase()], patch: { lens: l.value } })
  return out
}

function dateSuggestions(fragment: string, facets: Facets | null, exactOnly: boolean): Suggestion[] {
  const months = facets?.months ?? []
  if (!months.length) return []
  const out: Suggestion[] = []
  const year = fragment.match(/^((?:19|20)\d\d)$/)
  if (year) {
    const n = months.filter((m) => m.value.startsWith(year[1])).reduce((a, m) => a + m.count, 0)
    if (n) out.push({ id: `y:${year[1]}`, kind: 'date', label: year[1], hint: 'Date taken', count: n, fragment, patch: { ranges: { date_from: year[1], date_to: year[1] } } })
  }
  // "jun", "june", "june 2025"
  const mm = fragment.match(/^([a-z]{3,9})(?:\s+((?:19|20)\d{0,2}))?$/)
  if (mm) {
    const idx = MONTHS.findIndex((name) => (exactOnly ? name === mm[1] : name.startsWith(mm[1])))
    if (idx >= 0) {
      const mon = String(idx + 1).padStart(2, '0')
      for (const m of [...months].reverse()) {
        if (!m.value.endsWith(`-${mon}`) || (mm[2] && !m.value.startsWith(mm[2]))) continue
        const name = MONTHS[idx][0].toUpperCase() + MONTHS[idx].slice(1)
        out.push({ id: `m:${m.value}`, kind: 'date', label: `${name} ${m.value.slice(0, 4)}`, hint: 'Date taken', count: m.count, fragment, patch: { ranges: { date_from: m.value, date_to: m.value } } })
        if (out.length >= 3) break
      }
    }
  }
  return out
}

/** How well `key` matches the typed fragment: 0 exact, 1 prefix, 2 a later word starts with it, else -1. */
function rank(key: string, fragment: string): number {
  if (key === fragment) return 0
  if (key.startsWith(fragment)) return 1
  if (key.split(/[\s\-/]+/).some((w, i) => i > 0 && w.startsWith(fragment))) return 2
  if (fragment.length >= 3 && /\d/.test(fragment) && key.includes(fragment)) return 2 // lens/camera codes: "200-800", "r7"
  return -1
}

/**
 * Returns filter suggestions for the end of `text`. The last one to three words are tried (longest first)
 * so multi-word labels like "bird in flight" or "low light" match. Nothing is suggested while the text
 * ends in a space, for a lone stop word or for fewer than three letters.
 *
 * Inside a sentence (two or more words before the ones being matched) only exact matches of the
 * non-subject filters are offered ("tele", "june", "2025", "RF200…"): subjects are everyday words that
 * semantic search already understands, and suggesting them on every word would get in the way of typing.
 */
export function suggest(text: string, state: SearchState, subjects: SubjectCount[] | null, facets: Facets | null): Suggestion[] {
  if (!text || /\s$/.test(text)) return []
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const all = candidates(state, subjects, facets)
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const fragment = words.slice(-n).join(' ')
    if (n === 1 && STOP.has(fragment)) continue
    const sentence = words.length - n >= 2
    const scored: { c: Candidate; r: number }[] = []
    for (const c of all) {
      if (fragment.length < MIN_CHARS) continue
      if (sentence && c.kind === 'subject') continue
      const r = Math.min(...c.keys.map((k) => rank(k, fragment)).map((x) => (x < 0 ? 9 : x)))
      if (r < 9 && (!sentence || r === 0)) scored.push({ c, r })
    }
    const dates = dateSuggestions(fragment, facets, sentence)
    if (!scored.length && !dates.length) continue
    // Multi-word fragments only count when they match more than their last word alone would.
    if (n > 1 && !dates.length && scored.every((x) => x.r === 2)) continue
    scored.sort((a, b) => a.r - b.r || (b.c.count ?? 0) - (a.c.count ?? 0))
    // The fragment is taken from the original text so picking a suggestion keeps the user's casing elsewhere.
    const orig = text.trimEnd().split(/\s+/).slice(-n).join(' ')
    return [
      ...dates.map((d) => ({ ...d, fragment: orig })),
      ...scored.map(({ c }) => ({ id: c.id, kind: c.kind, label: c.label, hint: c.hint, count: c.count, fragment: orig, patch: c.patch })),
    ].slice(0, MAX)
  }
  return []
}

/** Returns the text with the picked suggestion's fragment removed from its end. */
export function withoutFragment(text: string, fragment: string): string {
  const t = text.trimEnd()
  return t.toLowerCase().endsWith(fragment.toLowerCase()) ? t.slice(0, t.length - fragment.length).trimEnd() : t
}

export const countText = (n: number | null | undefined) => (n == null ? '' : formatNumber(n))
