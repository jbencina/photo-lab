// Visual QA: screenshots of every main screen at phone / tablet / desktop sizes in light and dark.
// Usage (from frontend/):  BASE_URL=http://localhost:8000 node scripts/shot.mjs
//   OUT=dir         output dir (default ../qa/screenshots) — files are <viewport>-<theme>-<page>.png
//   ONLY=phone,...  restrict viewports;  THEMES=dark  restrict themes
// Read-only: it never likes, unlikes, tags or purges anything.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:8000'
const OUT = path.resolve(process.env.OUT ?? path.join(here, '../../qa/screenshots'))
const QUERY = process.env.QUERY ?? 'bird in flight'

const ALL_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet', width: 820, height: 1180, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  { name: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
]
const VIEWPORTS = process.env.ONLY ? ALL_VIEWPORTS.filter((v) => process.env.ONLY.split(',').includes(v.name)) : ALL_VIEWPORTS
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')
const CARD = 'main [role="button"][tabindex="0"]'
const DIALOG = '[role="dialog"][aria-modal="true"]'

const problems = []
const check = (cond, msg) => {
  if (!cond) problems.push(msg)
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  // Lazy thumbnails below the fold never load, so wait at most 5 s for the rest.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r })),
      ),
      new Promise((r) => setTimeout(r, 5000)),
    ]),
  )
  await page.waitForTimeout(450)
}

async function run() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const status = await (await fetch(`${BASE}/api/status`)).json()
  const firstId = (await (await fetch(`${BASE}/api/images?limit=1`)).json()).items[0]?.id
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      console.log(`\n== ${vp.name} ${vp.width}x${vp.height} / ${theme}`)
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        colorScheme: theme,
      })
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('photolib:theme', t)
        } catch {}
      }, theme)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      const tap = (loc) => (vp.hasTouch ? loc.tap() : loc.click())
      const shot = async (name, opts = {}) => {
        const file = path.join(OUT, `${vp.name}-${theme}-${name}.png`)
        await page.screenshot({ path: file, ...opts })
        console.log(`  shot ${path.relative(process.cwd(), file)}`)
      }
      const noHScroll = async (where) =>
        check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `no horizontal scroll (${where})`)

      // Library
      await page.goto(`${BASE}/`)
      await page.waitForSelector(CARD)
      await settle(page)
      check((await page.evaluate(() => document.documentElement.classList.contains('dark'))) === (theme === 'dark'), `theme is ${theme}`)
      check((await page.locator(CARD).count()) === status.image_count, `grid shows ${status.image_count} photos`)
      await noHScroll('library')
      await shot('library')

      // Query results
      await page.goto(`${BASE}/?q=${encodeURIComponent(QUERY)}`)
      await page.waitForSelector(CARD)
      await settle(page)
      await noHScroll('query')
      if (!vp.hasTouch) await page.locator(CARD).first().hover()
      await page.waitForTimeout(250)
      await shot('query')

      // Dock panels: More filters with a few filters active, then Subjects with the find box in use
      {
        await page.goto(`${BASE}/?subject=bird&focal_min=70&focal_max=299.9&date_from=2025&date_to=2025`)
        await page.waitForSelector(CARD)
        await settle(page)
        await tap(page.locator('nav[aria-label="Library controls"]').getByRole('button', { name: 'More filters' }))
        await page.waitForTimeout(500)
        await shot('filters')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
        await tap(page.locator('nav[aria-label="Library controls"]').getByRole('button', { name: /^Subjects/ }))
        await page.waitForTimeout(500)
        await page.getByRole('dialog', { name: 'Subjects' }).getByLabel('Find subject').fill('bi')
        await page.waitForTimeout(300)
        await shot('subjects-find')
        await page.keyboard.press('Escape')
      }

      // Lightbox (+ mobile info sheet)
      await page.goto(`${BASE}/`)
      await page.waitForSelector(CARD)
      await settle(page)
      await tap(page.locator(CARD).first())
      await page.waitForSelector(DIALOG)
      await settle(page)
      await page.waitForTimeout(300)
      await shot('lightbox')
      if (vp.width < 1024) {
        await tap(page.getByRole('button', { name: 'Info' }))
        await page.waitForTimeout(600)
        await shot('lightbox-info')
        // scroll the sheet to show subjects + EXIF table
        await page.locator(`${DIALOG} details summary`).first().click()
        await page.locator(`${DIALOG} details`).first().scrollIntoViewIfNeeded()
        await page.waitForTimeout(300)
        await shot('lightbox-info-exif')
      } else {
        await page.locator(`${DIALOG} details summary`).first().click()
        await page.waitForTimeout(300)
        await page.locator(`${DIALOG} aside > div`).evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.35))
        await page.waitForTimeout(200)
        await shot('lightbox-exif')
      }

      // EG-fallback subject chip: no sample photo needs the fallback, so the detail response is rewritten in the browser
      if (firstId) {
        const detailPath = `/api/images/${encodeURIComponent(firstId)}`
        await page.route((u) => u.pathname === detailPath, async (route) => {
          const response = await route.fetch()
          const json = await response.json()
          json.subjects = [{ label: json.subjects[0]?.label ?? 'bird', score: 0.7125, source: 'eg', eg_score: 0.7125, display_rank: 1 }]
          await route.fulfill({ response, json })
        })
        await page.goto(`${BASE}/?view=${encodeURIComponent(firstId)}`)
        await page.waitForSelector(DIALOG)
        await settle(page)
        if (vp.width < 1024) {
          await tap(page.getByRole('button', { name: 'Info' }))
          await page.waitForTimeout(600)
        }
        await page.locator(DIALOG).getByText('Subjects', { exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }))
        await page.waitForTimeout(250)
        await shot('lightbox-eg')
        await page.unroute((u) => u.pathname === detailPath)
      }

      // Color + similar results
      await page.goto(`${BASE}/?color=%23fb8c00`)
      await page.waitForSelector(CARD)
      await settle(page)
      await shot('color')
      if (firstId) {
        await page.goto(`${BASE}/?similar=${encodeURIComponent(firstId)}`)
        await page.waitForSelector(CARD)
        await settle(page)
        await shot('similar')
      }

      // Admin + confirm dialog
      await page.goto(`${BASE}/admin`)
      await page.waitForSelector('text=Photo folder')
      await settle(page)
      await noHScroll('admin')
      await shot('admin')
      await shot('admin-full', { fullPage: true })
      await page.fill('#catalog-dir', '/path/to/other/photos')
      await tap(page.getByRole('button', { name: /^(Switch|Rebuild) catalog$/ }))
      await page.waitForSelector('[role="alertdialog"]')
      await page.waitForTimeout(400)
      await shot('admin-confirm')
      await tap(page.getByRole('button', { name: 'Cancel' }))
      await page.waitForTimeout(400)
      await page.fill('#catalog-dir', status.catalog_dir ?? '')
      // Retag confirm (states the time estimate); cancelled, nothing is started
      await tap(page.getByRole('button', { name: 'Retag all' }))
      await page.waitForSelector('[role="alertdialog"]')
      await page.waitForTimeout(400)
      check(/Estimated time/.test(await page.locator('[role="alertdialog"]').innerText()), 'retag confirm shows the time estimate')
      await shot('admin-retag-confirm')
      await tap(page.getByRole('button', { name: 'Cancel' }))

      check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`)
      await context.close()
    }
  }
  await browser.close()
  console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nAll checks passed.')
  process.exitCode = problems.length ? 1 : 0
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
