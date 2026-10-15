// Visual QA of the admin page's two-phase progress (embed -> tag) at library scale.
// Usage (from frontend/):  BASE_URL=http://localhost:8001 node scripts/shot-progress.mjs
//   Default: read-only. /api/status and /api/admin/progress are answered in the browser with synthetic
//   25k-photo states (embedding, then tagging), so the screenshots are deterministic.
//   REAL=1   also starts a real "Retag all" on the server and shoots the live tagging state
//            (re-runs d1 over the whole catalog; nothing is deleted).
//   Files: qa/screenshots/<desktop|phone>-<light|dark>-admin-progress-<embedding|tagging|live>.png
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:8000'
const OUT = path.resolve(process.env.OUT ?? path.join(here, '../../qa/screenshots'))
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
]
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')
const N = 25000
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString()

function states(real) {
  const base = {
    running: true, mode: 'refresh', current: '2024/Iceland/IMG_4211.jpg', started_at: minutesAgo(12), finished_at: null,
    error: null, interrupted: false, skipped: 0, failed: 0, missing: 0, pruned: 0, failures: [], skip_tags: false,
    tag_failed: 0,
  }
  const embedding = {
    ...base, phase: 'embedding', done: 9840, total: N, added: 9840, embed_done: 9840, embed_total: N, embed_seconds: null,
    tag_done: 0, tag_total: 0, tag_seconds: null, tagged: 0, untagged: 9840, rate: 14.2, eta_seconds: (N - 9840) / 14.2,
  }
  const tagging = {
    ...base, started_at: minutesAgo(61), phase: 'tagging', current: '2021/Yosemite/KI8A1187.jpg', done: 6210, total: N,
    added: N, embed_done: N, embed_total: N, embed_seconds: 1771, tag_done: 6210, tag_total: N, tag_seconds: null,
    tagged: 6210, untagged: N - 6210, rate: 3.42, eta_seconds: (N - 6210) / 3.42,
  }
  const status = (p, loadedTagger) => ({
    ...real, image_count: p.embed_done, tagged_count: p.tagged, untagged_count: p.untagged, liked_count: 0,
    subject_count: p.phase === 'tagging' ? 131 : 0, db_size_bytes: 210e6 * (p.embed_done / N),
    tagger: { ...real.tagger, loaded: loadedTagger }, indexing: p,
  })
  return { embedding: [embedding, status(embedding, false)], tagging: [tagging, status(tagging, true)] }
}

async function run() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const real = await (await fetch(`${BASE}/api/status`)).json()
  const S = states(real)
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile, hasTouch: vp.hasTouch, colorScheme: theme,
      })
      await context.addInitScript((t) => { try { localStorage.setItem('photolib:theme', t) } catch {} }, theme)
      const page = await context.newPage()
      for (const [name, [progress, status]] of Object.entries(S)) {
        await page.unroute('**/api/status')
        await page.unroute('**/api/admin/progress')
        await page.route('**/api/status', (r) => r.fulfill({ json: status }))
        await page.route('**/api/admin/progress', (r) => r.fulfill({ json: progress }))
        await page.goto(`${BASE}/admin`)
        await page.waitForSelector('text=Photo folder')
        await page.waitForTimeout(1500)
        const box = page.locator('main ol').first()
        await box.scrollIntoViewIfNeeded()
        await page.evaluate(() => window.scrollBy(0, 160))
        await page.waitForTimeout(300)
        const file = path.join(OUT, `${vp.name}-${theme}-admin-progress-${name}.png`)
        await page.screenshot({ path: file })
        console.log(`shot ${path.relative(process.cwd(), file)}`)
      }
      await context.close()
    }
  }
  if (process.env.REAL) {
    const r = await fetch(`${BASE}/api/admin/retag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' })
    console.log('retag', r.status, await r.text())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const page = await context.newPage()
    await page.goto(`${BASE}/admin`)
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector('main ol')?.textContent ?? '') && /photos\/s/.test(document.body.innerText), null, { timeout: 60000 })
    await page.locator('main ol').first().scrollIntoViewIfNeeded()
    await page.evaluate(() => window.scrollBy(0, 160))
    const file = path.join(OUT, 'desktop-light-admin-progress-live.png')
    await page.screenshot({ path: file })
    console.log(`shot ${path.relative(process.cwd(), file)}`)
    await page.waitForFunction(() => /Last run complete/.test(document.body.innerText), null, { timeout: 180000 })
    await context.close()
  }
  await browser.close()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
