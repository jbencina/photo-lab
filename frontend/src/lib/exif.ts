// Human-readable rendering of the raw EXIF dict (values arrive stringified from the backend).

const ENUMS: Record<string, Record<string, string>> = {
  ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' },
  MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Evaluative', 6: 'Partial', 255: 'Other' },
  WhiteBalance: { 0: 'Auto', 1: 'Manual' },
  ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
  ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 65535: 'Uncalibrated' },
  CustomRendered: { 0: 'Normal', 1: 'Custom' },
  SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
  SensingMethod: { 1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area', 5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear' },
  ResolutionUnit: { 1: 'None', 2: 'inch', 3: 'cm' },
  FocalPlaneResolutionUnit: { 1: 'None', 2: 'inch', 3: 'cm', 4: 'mm', 5: 'µm' },
  Orientation: { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored + 90° CCW', 6: 'Rotated 90° CW', 7: 'Mirrored + 90° CW', 8: 'Rotated 90° CCW' },
  YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v))
const round = (n: number, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d)

/** "FocalPlaneXResolution" -> "Focal Plane X Resolution", "ISOSpeedRatings" -> "ISO Speed Ratings". */
export function exifKey(k: string): string {
  return k.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

export function exifValue(key: string, raw: unknown): string {
  if (raw == null || raw === '') return '—'
  if (typeof raw === 'object') return JSON.stringify(raw)
  const v = String(raw)
  const n = num(v)
  const e = ENUMS[key]
  if (e && v in e) return e[v]
  switch (key) {
    case 'Flash':
      if (Number.isFinite(n)) return n & 1 ? 'Fired' : 'Did not fire'
      break
    case 'ExposureTime':
      if (Number.isFinite(n) && n > 0) return n < 1 ? `1/${Math.round(1 / n)} s` : `${round(n)} s`
      break
    case 'ShutterSpeedValue':
      if (Number.isFinite(n)) {
        const t = 2 ** -n
        return t < 1 ? `1/${Math.round(1 / t)} s` : `${round(t)} s`
      }
      break
    case 'ApertureValue':
    case 'MaxApertureValue':
      if (Number.isFinite(n)) return `ƒ/${round(2 ** (n / 2))}`
      break
    case 'FNumber':
      if (Number.isFinite(n)) return `ƒ/${round(n)}`
      break
    case 'FocalLength':
    case 'FocalLengthIn35mmFilm':
      if (Number.isFinite(n)) return `${round(n)} mm`
      break
    case 'ExposureBiasValue':
      if (Number.isFinite(n)) return `${n > 0 ? '+' : ''}${round(n, 2)} EV`
      break
    case 'LensSpecification': {
      const [f1, f2, a1, a2] = v.split(',').map(num)
      if (Number.isFinite(f1) && Number.isFinite(f2)) {
        const focal = f1 === f2 ? `${round(f1)} mm` : `${round(f1)}–${round(f2)} mm`
        const ap = Number.isFinite(a1) && a1 > 0 ? ` ƒ/${round(a1)}${Number.isFinite(a2) && a2 > 0 && a2 !== a1 ? `–${round(a2)}` : ''}` : ''
        return focal + ap
      }
      break
    }
    case 'FocalPlaneXResolution':
    case 'FocalPlaneYResolution':
    case 'XResolution':
    case 'YResolution':
      if (Number.isFinite(n)) return round(n, 2)
      break
  }
  return v
}
