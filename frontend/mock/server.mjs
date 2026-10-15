// photo-lib mock API with ~30 fake images, for UI work without a backend: library, search, filters, likes and the
// admin catalog/refresh/purge flow. Tags, labels and retag are not implemented. No dependencies.
// Usage: npm run mock   (PORT=8000, MOCK_DELAY=120 ms)
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8000)
const DELAY = Number(process.env.MOCK_DELAY ?? 120)

// ---------- deterministic randomness ----------
let seed = 1337
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const hashStr = (s) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0) / 4294967296
}

// ---------- color helpers ----------
function hexToRgb(hex) {
  const n = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16))
}
function rgbToLab([r, g, b]) {
  const lin = (c) => {
    c /= 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}
const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
function jitter(hex, amt = 18) {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.max(0, Math.min(255, Math.round(c + (rand() - 0.5) * 2 * amt))))
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
}

// ---------- scenes ----------
const SCENES = [
  { name: 'bird', subjects: ['bird', 'wildlife', 'sky', 'nature'], palette: ['#8fb8de', '#cfe3f3', '#5a4632', '#2f3b2a', '#c9a77c', '#eef4f8'], shape: 'bird' },
  { name: 'sunset', subjects: ['sunset', 'beach', 'ocean', 'sky', 'clouds'], palette: ['#f28c38', '#f6c26b', '#7b3f6e', '#1f2a4a', '#e55b5b', '#2d1b35'], shape: 'sun' },
  { name: 'forest', subjects: ['forest', 'landscape', 'nature', 'tree'], palette: ['#2f5d34', '#6f9a4b', '#1b2e1c', '#a8c686', '#4a3a28', '#d9e4c4'], shape: 'hills' },
  { name: 'mountain', subjects: ['mountain', 'snow', 'landscape', 'sky'], palette: ['#dfe7ef', '#7f97b2', '#3c4a5c', '#ffffff', '#a9b8c9', '#24303d'], shape: 'peaks' },
  { name: 'city', subjects: ['city', 'night', 'architecture', 'street'], palette: ['#141b33', '#2c3e6b', '#f5c04a', '#e0773a', '#0a0e1c', '#7a8bb5'], shape: 'skyline' },
  { name: 'flower', subjects: ['flower', 'macro', 'nature', 'garden'], palette: ['#d6337f', '#f590b8', '#3f7a3a', '#9cc66b', '#fbe3ee', '#5b1f3b'], shape: 'flower' },
  { name: 'food', subjects: ['food', 'still life'], palette: ['#8a4b22', '#d9a066', '#c0392b', '#f3e2c7', '#3b2416', '#6b8e23'], shape: 'plate' },
  { name: 'dog', subjects: ['dog', 'pet', 'mammal', 'grass'], palette: ['#c69a63', '#7fae4f', '#3e5a2a', '#f1e3c8', '#5b3d22', '#a7c97e'], shape: 'hills' },
  { name: 'lake', subjects: ['lake', 'water', 'landscape', 'reflection', 'mountain'], palette: ['#4f8fa8', '#a5d0dc', '#264653', '#e9f1ee', '#5a7d5a', '#183040'], shape: 'lake' },
  { name: 'car', subjects: ['car', 'street', 'vehicle'], palette: ['#c62828', '#9e9e9e', '#2b2b2b', '#e0e0e0', '#5d6d7e', '#111111'], shape: 'road' },
  { name: 'aircraft', subjects: ['aircraft', 'sky', 'clouds'], palette: ['#6fa3d6', '#dbe9f6', '#b0b8c1', '#ffffff', '#38506b', '#e8eef3'], shape: 'plane' },
  { name: 'portrait', subjects: ['portrait', 'people'], palette: ['#d9b08c', '#6d5a4e', '#2c2a29', '#efe0d0', '#9a8478', '#43403c'], shape: 'portrait' },
  { name: 'insect', subjects: ['insect', 'macro', 'wildlife', 'flower'], palette: ['#f2b705', '#4a7c2f', '#1e1e1e', '#cfe28a', '#8c5e14', '#f7ecc0'], shape: 'flower' },
  { name: 'boat', subjects: ['boat', 'ocean', 'water', 'sky'], palette: ['#1f6f8b', '#99d5e6', '#f0f0f0', '#0f3d4f', '#c94f3d', '#e6f5f9'], shape: 'lake' },
]

const CAMERAS = [
  { make: 'Canon', model: 'Canon EOS R7', lenses: ['RF200-800mm F6.3-9 IS USM', 'RF-S18-150mm F3.5-6.3 IS STM', 'RF100-500mm F4.5-7.1 L IS USM'], prefix: '5N7A', software: 'Firmware Version 1.5.0' },
  { make: 'Sony', model: 'ILCE-7M4', lenses: ['FE 24-70mm F2.8 GM II', 'FE 90mm F2.8 Macro G OSS', 'FE 200-600mm F5.6-6.3 G OSS'], prefix: 'DSC0', software: 'ILCE-7M4 v3.01' },
  { make: 'FUJIFILM', model: 'X-T5', lenses: ['XF16-55mmF2.8 R LM WR', 'XF56mmF1.2 R WR', 'XF70-300mmF4-5.6 R LM OIS WR'], prefix: '_DSF', software: 'Digital Camera X-T5 Ver2.10' },
  { make: 'Apple', model: 'iPhone 15 Pro', lenses: ['iPhone 15 Pro back triple camera 6.765mm f/1.78'], prefix: 'IMG_', software: '18.1' },
]
const ASPECTS = [
  [1600, 1067], [1067, 1600], [1600, 1200], [1200, 1600], [1600, 900], [1400, 1400], [1280, 1600], [1600, 1067], [1600, 686],
]
const SHUTTERS = ['1/4000', '1/2000', '1/1250', '1/800', '1/500', '1/250', '1/125', '1/60', '1/30', '1/8', '2']

function makeImage(i) {
  const scene = SCENES[i % SCENES.length]
  const cam = scene.name === 'bird' || scene.name === 'aircraft' ? CAMERAS[0] : pick(CAMERAS)
  const lens = pick(cam.lenses)
  const [w, h] = pick(ASPECTS)
  const num = String(1000 + Math.floor(rand() * 9000))
  const file_name = `${cam.prefix}${num}.${cam.make === 'Sony' ? 'JPG' : 'jpg'}`
  const month = 1 + Math.floor(rand() * 12)
  const day = 1 + Math.floor(rand() * 28)
  const year = rand() < 0.5 ? 2024 : 2025
  const pad = (n) => String(n).padStart(2, '0')
  const taken_at = `${year}-${pad(month)}-${pad(day)}T${pad(6 + Math.floor(rand() * 14))}:${pad(Math.floor(rand() * 60))}:${pad(Math.floor(rand() * 60))}-08:00`
  const rel_path = i % 4 === 0 ? `${year}/${pad(month)}/${file_name}` : file_name
  const iso = pick([100, 200, 400, 800, 1600, 3200, 4000, 6400])
  const f_number = cam.make === 'Apple' ? 1.8 : pick([1.2, 2.8, 4, 5.6, 6.3, 8, 9, 11, 14])
  const exposure_str = pick(SHUTTERS)
  const range = lens.match(/(\d+)-(\d+)\s*mm/i) ?? lens.match(/(\d+)\s*mm/i)
  const lo = range ? Number(range[1]) : 50
  const hi = range && range[2] ? Number(range[2]) : lo
  const focal_length = cam.make === 'Apple' ? 6.8 : Math.round(lo + (hi - lo) * rand())
  // palette: shares descending
  let shares = scene.palette.map(() => 0.3 + rand())
  const sum = shares.reduce((a, b) => a + b, 0)
  shares = shares.map((s) => s / sum).sort((a, b) => b - a)
  const colors = scene.palette.map((hex, k) => {
    const j = jitter(hex)
    return { hex: j, lab: rgbToLab(hexToRgb(j)), share: Math.round(shares[k] * 1000) / 1000 }
  })
  const subjects = scene.subjects
    .slice(0, 2 + Math.floor(rand() * (scene.subjects.length - 1)))
    .map((label, k) => ({ label, score: Math.round((0.72 - k * 0.05 - rand() * 0.04) * 1000) / 1000 }))
  const exposure_time = exposure_str.includes('/') ? 1 / Number(exposure_str.split('/')[1]) : Number(exposure_str)
  return {
    id: rel_path,
    file_name,
    width: w,
    height: h,
    taken_at,
    make: cam.make,
    model: cam.model,
    lens,
    software: cam.software,
    iso,
    f_number,
    exposure_str,
    focal_length,
    liked: rand() < 0.2,
    liked_at: null,
    colors,
    subjects,
    scene: scene.name,
    shape: scene.shape,
    file_size: Math.floor(2_000_000 + rand() * 9_000_000),
    sha1: Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join(''),
    indexed_at: new Date(Date.now() - (30 - i) * 60000).toISOString(),
    exif: {
      Make: cam.make,
      Model: cam.model,
      LensModel: lens,
      Software: cam.software,
      DateTimeOriginal: taken_at.slice(0, 19).replace('T', ' ').replace(/-/g, ':').replace(/^(\d+):(\d+):(\d+) /, '$1:$2:$3 '),
      OffsetTimeOriginal: '-08:00',
      ExposureTime: exposure_str,
      FNumber: String(f_number),
      ISOSpeedRatings: String(iso),
      FocalLength: `${focal_length} mm`,
      ExposureBiasValue: pick(['0', '-1/3', '+1/3', '-2/3']),
      ExposureProgram: pick(['Manual', 'Aperture priority', 'Shutter priority']),
      MeteringMode: pick(['Pattern', 'CenterWeightedAverage', 'Spot']),
      Flash: 'Flash did not fire',
      WhiteBalance: pick(['Auto', 'Manual']),
      ColorSpace: 'sRGB',
      ExifImageWidth: String(w),
      ExifImageHeight: String(h),
      Orientation: 'Horizontal (normal)',
      BodySerialNumber: String(Math.floor(rand() * 1e12)),
      exposure_time,
    },
  }
}

const ALL = Array.from({ length: 30 }, (_, i) => makeImage(i))
for (const img of ALL) if (img.liked) img.liked_at = new Date(Date.now() - rand() * 1e9).toISOString()

// ---------- catalog / indexing state ----------
const DATA_DIR = '/path/to/photo-lib/data'
let catalogDir = '/path/to/photos'
let visible = ALL.length // first N images are "indexed"
const indexing = { running: false, done: 0, total: 0, current: null, started_at: null, error: null }
let job = null // { start, duration, base, adds }

function tick() {
  if (!job) return
  const frac = Math.min(1, (Date.now() - job.start) / job.duration)
  indexing.done = Math.floor(frac * indexing.total)
  if (job.adds) visible = job.base + indexing.done
  const cur = ALL[Math.min(ALL.length - 1, (job.adds ? job.base : 0) + indexing.done)]
  indexing.current = frac < 1 ? cur.id : null
  if (frac >= 1) {
    indexing.running = false
    indexing.done = indexing.total
    indexing.current = null
    job = null
  }
}
function startJob() {
  const missing = ALL.length - visible
  const adds = missing > 0
  indexing.running = true
  indexing.done = 0
  indexing.total = adds ? missing : ALL.length
  indexing.current = null
  indexing.error = null
  indexing.started_at = new Date().toISOString()
  job = { start: Date.now(), duration: 10000, base: visible, adds }
}

const images = () => {
  tick()
  return ALL.slice(0, visible)
}

// ---------- serialization ----------
const enc = encodeURIComponent
function summary(img, score) {
  const s = {
    id: img.id,
    file_name: img.file_name,
    thumb_url: `/api/thumb/${enc(img.id)}`,
    image_url: `/api/image/${enc(img.id)}`,
    width: img.width,
    height: img.height,
    taken_at: img.taken_at,
    make: img.make,
    model: img.model,
    lens: img.lens,
    iso: img.iso,
    f_number: img.f_number,
    exposure_str: img.exposure_str,
    focal_length: img.focal_length,
    liked: img.liked,
    colors: img.colors.map(({ hex, share }) => ({ hex, share })),
    subjects: img.subjects,
  }
  if (score !== undefined) s.score = Math.round(score * 1000) / 1000
  return s
}

// ---------- filters ----------
function applyFilters(list, q) {
  const num = (k) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : null)
  const subjects = q.getAll('subject')
  const [isoMin, isoMax, fMin, fMax, flMin, flMax] = ['iso_min', 'iso_max', 'f_min', 'f_max', 'focal_min', 'focal_max'].map(num)
  const dateFrom = q.get('date_from')
  const dateTo = q.get('date_to')
  const qm = (q.get('q_meta') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter((img) => {
    if (q.get('liked') === '1' && !img.liked) return false
    if (subjects.length && !img.subjects.some((s) => subjects.includes(s.label))) return false
    for (const k of ['make', 'model', 'lens']) if (q.get(k) && img[k] !== q.get(k)) return false
    if (isoMin != null && img.iso < isoMin) return false
    if (isoMax != null && img.iso > isoMax) return false
    if (fMin != null && img.f_number < fMin) return false
    if (fMax != null && img.f_number > fMax) return false
    if (flMin != null && img.focal_length < flMin) return false
    if (flMax != null && img.focal_length > flMax) return false
    const d = img.taken_at?.slice(0, 10)
    if (dateFrom && (!d || d < dateFrom)) return false
    if (dateTo && (!d || d > dateTo)) return false
    if (qm.length) {
      const words = [img.file_name, img.make, img.model, img.lens, img.software]
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9_.]+/)
      if (!qm.every((t) => words.some((w) => w.startsWith(t)))) return false
    }
    return true
  })
}

function sortList(list, sort = 'taken_at', order = 'desc', seed = '0') {
  if (sort === 'random') {
    const key = (i) => { let h = 2166136261; for (const ch of `${seed}:${i.id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0 }
    return [...list].sort((a, b) => key(a) - key(b))
  }
  const dir = order === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    const va = a[sort]
    const vb = b[sort]
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    return va < vb ? -dir : va > vb ? dir : 0
  })
}

const limitOf = (q) => Math.max(1, Math.min(500, Number(q.get('limit') ?? 60)))

// ---------- search scoring ----------
const SYN = { puppy: 'dog', kitten: 'cat', plane: 'aircraft', airplane: 'aircraft', sea: 'ocean', flight: 'bird', flying: 'bird', town: 'city', food: 'food', meal: 'food', person: 'people', face: 'portrait', bug: 'insect', bee: 'insect', snowy: 'snow', trees: 'forest' }
function queryScore(img, q) {
  const words = q.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => SYN[w] ?? w.replace(/s$/, ''))
  let s = 0.18 + hashStr(img.id + q) * 0.08
  for (const w of words) {
    const hit = img.subjects.find((x) => x.label === w || x.label.startsWith(w))
    if (hit) s += 0.3 * hit.score
    if (img.scene === w) s += 0.08
  }
  return Math.min(0.95, s)
}
function colorScore(img, qlab) {
  return img.colors.reduce((acc, c) => acc + c.share * Math.exp(-deltaE(c.lab, qlab) / 25), 0)
}
function similarScore(a, b) {
  const la = new Set(a.subjects.map((s) => s.label))
  const lb = new Set(b.subjects.map((s) => s.label))
  const inter = [...la].filter((x) => lb.has(x)).length
  const jac = inter / new Set([...la, ...lb]).size
  const col = b.colors.reduce((acc, c) => acc + c.share * colorScore(a, c.lab), 0)
  return 0.25 + 0.5 * jac + 0.25 * col + hashStr(a.id + b.id) * 0.02
}

// ---------- SVG placeholder art ----------
function art(img, maxEdge) {
  const scale = maxEdge ? Math.min(1, maxEdge / Math.max(img.width, img.height)) : 1
  const W = Math.round(img.width * scale)
  const H = Math.round(img.height * scale)
  const [c0, c1, c2, c3, c4, c5] = img.colors.map((c) => c.hex)
  const r = (k) => hashStr(img.id + k)
  let fg = ''
  const hz = H * (0.55 + r('hz') * 0.15)
  switch (img.shape) {
    case 'sun':
      fg = `<circle cx="${W * (0.3 + r('sx') * 0.4)}" cy="${hz}" r="${Math.min(W, H) * 0.14}" fill="${c4}" opacity=".9"/>
            <rect y="${hz}" width="${W}" height="${H - hz}" fill="${c3}"/>
            <rect y="${hz + (H - hz) * 0.2}" width="${W}" height="${(H - hz) * 0.06}" fill="${c1}" opacity=".35"/>`
      break
    case 'peaks':
      fg = `<path d="M0 ${hz} L${W * 0.22} ${H * 0.28} L${W * 0.42} ${hz * 0.85} L${W * 0.63} ${H * 0.2} L${W} ${hz} V${H} H0Z" fill="${c2}"/>
            <path d="M${W * 0.63} ${H * 0.2} L${W * 0.55} ${H * 0.33} L${W * 0.6} ${H * 0.31} L${W * 0.66} ${H * 0.35} L${W * 0.71} ${H * 0.3}Z" fill="${c3}"/>
            <rect y="${hz}" width="${W}" height="${H - hz}" fill="${c5}"/>`
      break
    case 'skyline': {
      let x = 0
      let rects = ''
      let k = 0
      while (x < W) {
        const bw = W * (0.06 + r('b' + k) * 0.08)
        const bh = H * (0.25 + r('h' + k) * 0.45)
        rects += `<rect x="${x}" y="${H - bh}" width="${bw - 2}" height="${bh}" fill="${k % 2 ? c4 : c1}"/>`
        for (let wy = H - bh + 10; wy < H - 10; wy += 18)
          if (r('w' + k + wy) > 0.55) rects += `<rect x="${x + bw * 0.3}" y="${wy}" width="${bw * 0.25}" height="6" fill="${c2}" opacity=".8"/>`
        x += bw
        k++
      }
      fg = rects
      break
    }
    case 'flower': {
      const cx = W * 0.5
      const cy = H * 0.48
      const pr = Math.min(W, H) * 0.16
      let petals = ''
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        petals += `<ellipse cx="${cx + Math.cos(a) * pr}" cy="${cy + Math.sin(a) * pr}" rx="${pr * 0.75}" ry="${pr * 0.45}" transform="rotate(${(a * 180) / Math.PI} ${cx + Math.cos(a) * pr} ${cy + Math.sin(a) * pr})" fill="${k % 2 ? c0 : c1}" opacity=".92"/>`
      }
      fg = `<rect width="${W}" height="${H}" fill="${c3}" opacity=".55"/>${petals}<circle cx="${cx}" cy="${cy}" r="${pr * 0.45}" fill="${c5}"/>`
      break
    }
    case 'plate':
      fg = `<rect width="${W}" height="${H}" fill="${c4}"/>
            <circle cx="${W / 2}" cy="${H / 2}" r="${Math.min(W, H) * 0.36}" fill="${c3}"/>
            <circle cx="${W / 2}" cy="${H / 2}" r="${Math.min(W, H) * 0.26}" fill="${c1}"/>
            <circle cx="${W * 0.45}" cy="${H * 0.46}" r="${Math.min(W, H) * 0.08}" fill="${c2}"/>
            <circle cx="${W * 0.56}" cy="${H * 0.55}" r="${Math.min(W, H) * 0.06}" fill="${c5}"/>`
      break
    case 'lake':
      fg = `<path d="M0 ${hz} L${W * 0.3} ${H * 0.35} L${W * 0.5} ${hz * 0.92} L${W * 0.75} ${H * 0.3} L${W} ${hz}Z" fill="${c4}"/>
            <rect y="${hz}" width="${W}" height="${H - hz}" fill="${c0}"/>
            <path d="M0 ${hz} L${W * 0.3} ${hz + (hz - H * 0.35) * 0.6} L${W * 0.5} ${hz + hz * 0.05} L${W * 0.75} ${hz + (hz - H * 0.3) * 0.6} L${W} ${hz}Z" fill="${c4}" opacity=".35"/>`
      break
    case 'road':
      fg = `<rect y="${hz}" width="${W}" height="${H - hz}" fill="${c2}"/>
            <rect x="${W * 0.2}" y="${hz - H * 0.12}" width="${W * 0.6}" height="${H * 0.16}" rx="${H * 0.05}" fill="${c0}"/>
            <rect x="${W * 0.32}" y="${hz - H * 0.2}" width="${W * 0.32}" height="${H * 0.1}" rx="${H * 0.04}" fill="${c0}"/>
            <circle cx="${W * 0.32}" cy="${hz + H * 0.04}" r="${H * 0.06}" fill="${c5}"/>
            <circle cx="${W * 0.68}" cy="${hz + H * 0.04}" r="${H * 0.06}" fill="${c5}"/>`
      break
    case 'plane':
      fg = `<g transform="translate(${W * 0.5} ${H * 0.45}) rotate(-12)" fill="${c2}">
              <rect x="${-W * 0.25}" y="-${H * 0.025}" width="${W * 0.5}" height="${H * 0.05}" rx="${H * 0.025}"/>
              <path d="M${-W * 0.04} 0 L${W * 0.06} ${-H * 0.22} L${W * 0.1} ${-H * 0.22} L${W * 0.06} 0Z"/>
              <path d="M${-W * 0.04} 0 L${W * 0.06} ${H * 0.22} L${W * 0.1} ${H * 0.22} L${W * 0.06} 0Z"/>
              <path d="M${-W * 0.24} 0 L${-W * 0.2} ${-H * 0.09} L${-W * 0.17} ${-H * 0.09} L${-W * 0.18} 0Z"/>
            </g>`
      break
    case 'bird':
      fg = `<rect y="${H * 0.82}" width="${W}" height="${H * 0.18}" fill="${c3}" opacity=".6"/>
            <path transform="translate(${W * (0.35 + r('bx') * 0.3)} ${H * (0.35 + r('by') * 0.2)}) scale(${Math.min(W, H) / 400})"
              d="M-90 -10 C-60 -50 -30 -40 0 0 C30 -40 60 -50 90 -10 C60 -25 30 -15 8 12 L0 22 L-8 12 C-30 -15 -60 -25 -90 -10Z" fill="${c2}"/>`
      break
    case 'portrait':
      fg = `<circle cx="${W / 2}" cy="${H * 0.4}" r="${Math.min(W, H) * 0.17}" fill="${c0}"/>
            <path d="M${W * 0.2} ${H} C${W * 0.2} ${H * 0.7} ${W * 0.8} ${H * 0.7} ${W * 0.8} ${H}Z" fill="${c1}"/>`
      break
    default: // hills
      fg = `<path d="M0 ${hz} C${W * 0.25} ${hz - H * 0.18} ${W * 0.5} ${hz + H * 0.05} ${W} ${hz - H * 0.1} V${H} H0Z" fill="${c1}"/>
            <path d="M0 ${hz + H * 0.12} C${W * 0.3} ${hz} ${W * 0.7} ${hz + H * 0.2} ${W} ${hz + H * 0.08} V${H} H0Z" fill="${c2}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></linearGradient>
<radialGradient id="v" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>${fg}<rect width="${W}" height="${H}" fill="url(#v)"/></svg>`
}

// ---------- routing ----------
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string'
  res.writeHead(status, {
    'Content-Type': isStr ? 'text/plain' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(isStr ? body : JSON.stringify(body))
}
const notFound = (res, msg = 'Not found') => send(res, 404, { detail: msg })
const findImage = (id) => images().find((i) => i.id === id)

async function readBody(req) {
  let data = ''
  for await (const chunk of req) data += chunk
  try {
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}

const routes = [
  ['GET', /^\/api\/status$/, () => {
    const list = images()
    return {
      catalog_dir: catalogDir,
      image_count: list.length,
      liked_count: list.filter((i) => i.liked).length,
      subject_count: new Set(list.flatMap((i) => i.subjects.map((s) => s.label))).size,
      db_size_bytes: 1_250_000 + list.length * 48_000,
      model: { name: 'google/embeddinggemma-2', device: 'cuda (NVIDIA GeForce RTX 4090)', dim: 768, loaded: true },
      indexing: { ...indexing },
    }
  }],
  ['GET', /^\/api\/images$/, (q) => {
    const filtered = sortList(applyFilters(images(), q), q.get('sort') ?? 'taken_at', q.get('order') ?? 'desc', q.get('seed') ?? '0')
    const offset = Math.max(0, Number(q.get('offset') ?? 0))
    return { items: filtered.slice(offset, offset + limitOf(q)).map((i) => summary(i)), total: filtered.length }
  }],
  ['GET', /^\/api\/images\/([^/]+)$/, (q, m, res) => {
    const img = findImage(m[1])
    if (!img) return notFound(res, 'Image not found')
    return { ...summary(img), exif: img.exif, file_size: img.file_size, sha1: img.sha1, indexed_at: img.indexed_at }
  }],
  ['POST', /^\/api\/images\/([^/]+)\/like$/, (q, m, res, body) => {
    const img = findImage(m[1])
    if (!img) return notFound(res, 'Image not found')
    img.liked = !!body.liked
    img.liked_at = img.liked ? new Date().toISOString() : null
    return { liked: img.liked, liked_at: img.liked_at }
  }],
  ['GET', /^\/api\/search\/query$/, (q, m, res) => {
    const text = (q.get('q') ?? '').trim()
    if (!text) return send(res, 422, { detail: 'q is required' })
    const ranked = images().map((img) => [img, queryScore(img, text)]).sort((a, b) => b[1] - a[1])
    const allowed = new Set(applyFilters(images(), q))
    return { items: ranked.filter(([i]) => allowed.has(i)).slice(0, limitOf(q)).map(([i, s]) => summary(i, s)) }
  }],
  ['GET', /^\/api\/search\/similar\/([^/]+)$/, (q, m, res) => {
    const src = findImage(m[1])
    if (!src) return notFound(res, 'Image not found')
    const allowed = new Set(applyFilters(images(), q))
    const ranked = images()
      .filter((i) => i !== src && allowed.has(i))
      .map((i) => [i, similarScore(src, i)])
      .sort((a, b) => b[1] - a[1])
    return { items: ranked.slice(0, limitOf(q)).map(([i, s]) => summary(i, Math.min(0.99, s))) }
  }],
  ['GET', /^\/api\/search\/color$/, (q, m, res) => {
    const hex = q.get('hex') ?? ''
    if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) return send(res, 422, { detail: 'hex must look like #rrggbb' })
    const qlab = rgbToLab(hexToRgb(hex.startsWith('#') ? hex : '#' + hex))
    const allowed = new Set(applyFilters(images(), q))
    const ranked = images()
      .filter((i) => allowed.has(i))
      .map((i) => [i, colorScore(i, qlab)])
      .sort((a, b) => b[1] - a[1])
    return { items: ranked.slice(0, limitOf(q)).map(([i, s]) => summary(i, s)) }
  }],
  ['GET', /^\/api\/subjects$/, () => {
    const counts = new Map()
    for (const img of images()) for (const s of img.subjects) counts.set(s.label, (counts.get(s.label) ?? 0) + 1)
    return { items: [...counts].map(([label, count]) => ({ label, count, category: null })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) }
  }],
  ['GET', /^\/api\/facets$/, () => {
    const list = images()
    const facet = (k) => {
      const c = new Map()
      for (const i of list) if (i[k]) c.set(i[k], (c.get(i[k]) ?? 0) + 1)
      return [...c].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
    }
    const range = (k) => {
      const v = list.map((i) => i[k]).filter((x) => x != null)
      return v.length ? { min: Math.min(...v), max: Math.max(...v) } : { min: null, max: null }
    }
    const dates = list.map((i) => i.taken_at).filter(Boolean).sort()
    const values = (get) => {
      const c = new Map()
      for (const i of list) if (get(i) != null) c.set(get(i), (c.get(get(i)) ?? 0) + 1)
      return [...c].map(([value, count]) => ({ value, count })).sort((a, b) => (a.value < b.value ? -1 : 1))
    }
    return {
      makes: facet('make'),
      models: facet('model'),
      lenses: facet('lens'),
      iso: range('iso'),
      f_number: range('f_number'),
      focal_length: range('focal_length'),
      dates: { min: dates[0] ?? null, max: dates.at(-1) ?? null },
      iso_values: values((i) => i.iso),
      f_values: values((i) => i.f_number),
      focal_values: values((i) => i.focal_length),
      months: values((i) => i.taken_at?.slice(0, 7)),
    }
  }],
  ['GET', /^\/api\/thumb\/([^/]+)$/, (q, m, res) => {
    const img = findImage(m[1])
    if (!img) return notFound(res)
    send(res, 200, art(img, 640), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
  }],
  ['GET', /^\/api\/image\/([^/]+)$/, (q, m, res) => {
    const img = findImage(m[1])
    if (!img) return notFound(res)
    send(res, 200, art(img), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
  }],
  ['GET', /^\/api\/admin\/config$/, () => ({ catalog_dir: catalogDir, data_dir: DATA_DIR })],
  ['POST', /^\/api\/admin\/catalog$/, (q, m, res, body) => {
    if (body.confirm !== true) return send(res, 400, { detail: 'confirm must be true' })
    if (!body.catalog_dir?.trim()) return send(res, 400, { detail: 'catalog_dir is required' })
    if (body.catalog_dir.includes('missing')) return send(res, 400, { detail: `Directory does not exist: ${body.catalog_dir}` })
    catalogDir = body.catalog_dir.trim()
    visible = 0
    for (const i of ALL) {
      i.liked = false
      i.liked_at = null
    }
    startJob()
    return { ok: true }
  }],
  ['POST', /^\/api\/admin\/refresh$/, () => {
    tick()
    if (!catalogDir) return { ok: false, already_running: false, detail: 'No catalog configured' }
    if (indexing.running) return { ok: true, already_running: true }
    startJob()
    return { ok: true, already_running: false }
  }],
  ['GET', /^\/api\/admin\/progress$/, () => {
    tick()
    return { ...indexing }
  }],
  ['POST', /^\/api\/admin\/purge$/, (q, m, res, body) => {
    if (body.confirm !== true) return send(res, 400, { detail: 'confirm must be true' })
    catalogDir = null
    visible = 0
    job = null
    Object.assign(indexing, { running: false, done: 0, total: 0, current: null, started_at: null, error: null })
    for (const i of ALL) {
      i.liked = false
      i.liked_at = null
    }
    return { ok: true }
  }],
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' })
    return res.end()
  }
  for (const [method, re, handler] of routes) {
    if (method !== req.method) continue
    const raw = re.exec(url.pathname)
    if (!raw) continue
    const m = raw.map((g, k) => (k === 0 || g == null ? g : decodeURIComponent(g)))
    const body = method === 'POST' ? await readBody(req) : {}
    const isMedia = url.pathname.startsWith('/api/thumb') || url.pathname.startsWith('/api/image/')
    if (!isMedia && DELAY) await new Promise((r) => setTimeout(r, DELAY * (url.pathname.includes('/search/') ? 2.5 : 1)))
    try {
      const out = handler(url.searchParams, m, res, body)
      if (out !== undefined && !res.headersSent) send(res, 200, out)
    } catch (err) {
      console.error(err)
      if (!res.headersSent) send(res, 500, { detail: String(err) })
    }
    console.log(`${req.method} ${url.pathname}${url.search} ${res.statusCode}`)
    return
  }
  notFound(res)
})

server.listen(PORT, '0.0.0.0', () => console.log(`photo-lib mock API on http://0.0.0.0:${PORT} (${ALL.length} images)`))
