import type { ImageSummary } from './types'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat().format(n)
}

/** Parse the API's ISO timestamp without shifting it into the viewer's zone (show local wall-clock time of capture). */
function wallClock(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—'
  const d = wallClock(iso)
  if (!d) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  })
}

export function formatAperture(f: number | null | undefined): string | null {
  if (f == null) return null
  return `ƒ/${Number.isInteger(f) ? f.toFixed(0) : f.toFixed(1).replace(/\.0$/, '')}`
}

export function formatShutter(s: string | null | undefined): string | null {
  if (!s) return null
  return /s$/.test(s) ? s : `${s}s`
}

export function formatFocal(mm: number | null | undefined): string | null {
  if (mm == null) return null
  return `${Math.round(mm)}mm`
}

export function exposureParts(img: Pick<ImageSummary, 'f_number' | 'exposure_str' | 'iso' | 'focal_length'>): string[] {
  return [
    formatFocal(img.focal_length),
    formatAperture(img.f_number),
    formatShutter(img.exposure_str),
    img.iso != null ? `ISO ${img.iso}` : null,
  ].filter((x): x is string => !!x)
}

export function cameraName(img: Pick<ImageSummary, 'make' | 'model'>): string | null {
  const { make, model } = img
  if (!make && !model) return null
  if (make && model && model.toLowerCase().startsWith(make.toLowerCase())) return model
  return [make, model].filter(Boolean).join(' ')
}

export function aspect(img: Pick<ImageSummary, 'width' | 'height'>): number {
  const w = img.width ?? 0
  const h = img.height ?? 0
  if (w > 0 && h > 0) return w / h
  return 3 / 2
}

export function megapixels(w: number | null, h: number | null): string | null {
  if (!w || !h) return null
  return `${((w * h) / 1e6).toFixed(1)} MP`
}

/** Pick black or white text for a background color. */
export function readableOn(hex: string): string {
  const m = hex.replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#18181b' : '#ffffff'
}

export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s.split('').map((c) => c + c).join('')}`
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`
  return null
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** "bird in flight" -> "Bird in flight" (sentence case; CSS `capitalize` would title-case every word). */
export function labelCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Seconds -> "45s", "12 min", "2 h 05 min" (rounded; for ETAs and estimates). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}
