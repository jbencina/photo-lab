// Screenshots for the documentation site -> docs/static/img/screenshots/<name>.jpg
// Usage (from frontend/):  BASE_URL=http://localhost:8000 node scripts/docs-shots.mjs
//   OUT=dir      output dir (default ../docs/static/img/screenshots)
//   PHOTO=id     photo shown in the lightbox and "similar" shots (default: the oldest photo tagged "dog")
//   ONLY=a,b     only take the shots with these names
// Read-only: it never likes, tags, refreshes or purges anything. Serve with a decision model so the
// Admin page shows tagging as available.
//
// Folder paths, model endpoints, camera/lens serial numbers and GPS are replaced in the API responses
// before the page sees them, so the screenshots show placeholders instead of details of this machine.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:8000'
const OUT = path.resolve(process.env.OUT ?? path.join(here, '../../docs/static/img/screenshots'))
const ONLY = process.env.ONLY?.split(',')
const SEED = 7
const CARD = 'main [role="button"][tabindex="0"]'
const DIALOG = '[role="dialog"][aria-modal="true"]'

const DESKTOP = { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

const PLACEHOLDER = {
  catalog_dir: '/path/to/photos',
  data_dir: '/path/to/data',
  index_dir: '/path/to/data/catalogs/photos-3f9a1c0b7e',
  endpoint: 'http://gpu-host.example:8080/v1/embeddings',
}

/** Rewrites the API responses that carry machine-specific or personal details. */
async function scrub(context) {
  await context.route(/\/api\/(status|admin\/config|images\/[^/?]+)(\?|$)/, async (route) => {
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const json = await response.json()
    for (const key of ['catalog_dir', 'data_dir', 'index_dir']) if (json[key]) json[key] = PLACEHOLDER[key]
    for (const m of [json.model, json.tagger]) if (m?.endpoint) m.endpoint = PLACEHOLDER.endpoint
    if (json.exif) {
      for (const key of Object.keys(json.exif)) if (/serial|gps/i.test(key)) delete json.exif[key]
      json.gps_lat = json.gps_lon = null
    }
    await route.fulfill({ response, json })
  })
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  // Lazy thumbnails below the fold never load, so wait at most 5 s for the rest.
  await page.evaluate(() =>
    Promise.race([
      Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => (i.onload = i.onerror = r)))),
      new Promise((r) => setTimeout(r, 5000)),
    ]),
  )
  await page.waitForTimeout(500)
}

async function run() {
  await mkdir(OUT, { recursive: true })
  const pick = async (q) => (await (await fetch(`${BASE}/api/images?${q}`)).json()).items[0]?.id
  const photo = process.env.PHOTO ?? (await pick('subject=dog&sort=taken_at&order=asc&limit=1')) ?? (await pick('limit=1'))
  const view = `view=${encodeURIComponent(photo)}`
  const browser = await chromium.launch()
  let taken = 0

  async function session(vp, theme, fn) {
    const { width, height, ...device } = vp
    const context = await browser.newContext({ viewport: { width, height }, ...device, colorScheme: theme })
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('photolib:theme', t)
      } catch {}
    }, theme)
    await scrub(context)
    const page = await context.newPage()
    const tap = (loc) => (vp.hasTouch ? loc.tap() : loc.click())
    const open = async (url, selector = CARD) => {
      await page.goto(`${BASE}${url}`)
      await page.waitForSelector(selector)
      await settle(page)
    }
    const shot = async (name, opts = {}) => {
      if (ONLY && !ONLY.includes(name)) return
      await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, ...opts })
      console.log(`  ${name}.jpg`)
      taken++
    }
    const dock = (name) => tap(page.locator('nav[aria-label="Library controls"]').getByRole('button', { name }))
    await fn({ page, tap, open, shot, dock })
    await context.close()
  }

  await session(DESKTOP, 'light', async ({ page, open, shot, dock }) => {
    await open(`/?seed=${SEED}`)
    await shot('library')

    await page.getByRole('combobox').click()
    await page.getByRole('combobox').pressSequentially('bir')
    await page.locator('#search-suggestions').waitFor()
    await page.waitForTimeout(300)
    await shot('search-suggestions', { clip: { x: 0, y: 0, width: 1440, height: 520 } })

    await open(`/?q=${encodeURIComponent('bird in flight')}`)
    await page.locator(CARD).first().hover()
    await page.waitForTimeout(300)
    await shot('query')

    await open(`/?seed=${SEED}&subject=bird&focal_min=70&focal_max=299.9&date_from=2025&date_to=2025`)
    await shot('filters-active')

    await open(`/?seed=${SEED}`)
    for (const [button, name] of [['Color', 'dock-color'], [/^Subjects/, 'dock-subjects'], ['More filters', 'dock-more']]) {
      await dock(button)
      await page.waitForTimeout(500)
      await shot(name)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }

    await open('/?color=%23fb8c00')
    await shot('color')
    await open(`/?similar=${encodeURIComponent(photo)}`)
    await shot('similar')

    await open(`/?${view}`, DIALOG)
    await shot('lightbox')
    await page.locator(`${DIALOG} details summary`).first().click()
    await page.waitForTimeout(300)
    await page.locator(`${DIALOG} aside > div`).evaluate((el) => el.scrollTo(0, el.scrollHeight * 0.35))
    await page.waitForTimeout(300)
    await shot('lightbox-exif')

    await open(`/?${view}`, DIALOG)
    const tagBox = page.getByRole('combobox', { name: 'Add a tag' })
    await tagBox.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await tagBox.click()
    await page.getByRole('listbox', { name: 'Tag suggestions' }).waitFor()
    await page.waitForTimeout(400)
    await shot('lightbox-add-tag')

    await open('/admin', 'text=Photo folder')
    await shot('admin')
    await shot('admin-full', { fullPage: true })
    await page.getByRole('button', { name: 'Retag all' }).click()
    await page.waitForSelector('[role="alertdialog"]')
    await page.waitForTimeout(400)
    await shot('admin-retag')
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  await session(DESKTOP, 'dark', async ({ open, shot }) => {
    await open(`/?seed=${SEED}`)
    await shot('library-dark')
  })

  await session(PHONE, 'light', async ({ page, tap, open, shot, dock }) => {
    await open(`/?seed=${SEED}`)
    await shot('phone-library')
    await dock(/^Subjects/)
    await page.waitForTimeout(600)
    await shot('phone-subjects')
    await open(`/?${view}`, DIALOG)
    await shot('phone-lightbox')
    await tap(page.getByRole('button', { name: 'Info' }))
    await page.waitForTimeout(700)
    await shot('phone-lightbox-info')
  })

  await session(PHONE, 'dark', async ({ open, shot }) => {
    await open(`/?seed=${SEED}`)
    await shot('phone-library-dark')
  })

  await browser.close()
  console.log(`${taken} screenshots in ${path.relative(process.cwd(), OUT)}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
