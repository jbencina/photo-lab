// Functional checks of the web UI against a REAL `photolib serve` (default http://localhost:8000).
// Usage: BASE_URL=http://localhost:8000 node scripts/e2e.mjs
//   ADMIN_FLOW=1  also runs Refresh and "Switch catalog" (switches to / rebuilds the index of CATALOG_DIR, required),
//                 then waits until the same number of photos is back.
// Prints the top results of each query so ranking can be eyeballed. Exit code 1 on any failed check.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:8000'
const CATALOG_DIR = process.env.CATALOG_DIR
const PAGE = 60 // photos per request in the library grid (src/pages/Library.tsx)
const QUERIES = ['bird in flight', 'dog', 'orange flower', 'sunset over water']

const problems = []
const check = (cond, msg) => {
  if (!cond) problems.push(msg)
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  return cond
}
const CARD = 'main [role="button"][tabindex="0"]'
const DIALOG = '[role="dialog"][aria-modal="true"]'
const DOCK = 'nav[aria-label="Library controls"]'
/** Opens one of the dock's panels (Color, Subjects, More filters) and returns it. */
async function openPanel(page, name) {
  const panel = page.getByRole('dialog', { name })
  if (!(await panel.count())) await page.locator(DOCK).getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await panel.waitFor()
  return panel
}
async function closePanel(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

async function apiJson(path, init) {
  const r = await fetch(`${BASE}/api${path}`, init)
  return r.json()
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(250)
}

/** Wait for the next GET response of an /api path prefix (optionally matching query params) and return its JSON. */
function nextJson(page, prefix, params = {}) {
  return page
    .waitForResponse(
      (r) => {
        const u = new URL(r.url())
        return (
          u.pathname.startsWith(`/api${prefix}`) &&
          r.request().method() === 'GET' &&
          Object.entries(params).every(([k, v]) => u.searchParams.get(k) === v)
        )
      },
      { timeout: 15000 },
    )
    .then((r) => r.json())
}

/** Poll until the first grid card is `name` (the grid re-renders shortly after the response). */
async function firstCardIs(page, name, timeout = 4000) {
  const t0 = Date.now()
  let first
  do {
    first = (await page.locator(CARD).first().getAttribute('aria-label').catch(() => null))?.replace(', liked', '')
    if (first === name) return true
    await page.waitForTimeout(100)
  } while (Date.now() - t0 < timeout)
  console.log(`    first card is ${first}, expected ${name}`)
  return false
}

const top = (items, n = 5) => items.slice(0, n).map((i) => `${i.file_name}${i.score != null ? ` (${i.score.toFixed(3)})` : ''}`).join(', ')
const cardNames = (page) => page.locator(CARD).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))

async function swipe(page, cdp, from, to) {
  const steps = 8
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

function watchErrors(page, label, sink) {
  page.on('pageerror', (e) => sink.push(`${label}: ${e}`))
  page.on('console', (m) => m.type() === 'error' && sink.push(`${label}: ${m.text()}`))
}

async function desktop(browser, errors) {
  console.log('\n== desktop 1440x900')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  watchErrors(page, 'desktop', errors)
  const status = await apiJson('/status')

  await page.goto(`${BASE}/`)
  await page.waitForSelector(CARD)
  await settle(page)
  // the grid loads PAGE photos at a time (infinite scroll), so a big catalog starts with one page
  const firstPage = Math.min(status.image_count, PAGE)
  check((await page.locator(CARD).count()) >= firstPage, `library shows the first ${firstPage} of ${status.image_count} photos`)

  // ---- Query search through the search box
  const input = page.getByRole('combobox', { name: /^Search \(/ })
  for (const q of QUERIES) {
    const resp = nextJson(page, '/search/query', { q })
    await input.fill(q)
    await input.press('Enter')
    const data = await resp
    console.log(`  "${q}" -> ${top(data.items)}`)
    check(data.items.length > 0 && (await firstCardIs(page, data.items[0].file_name)), `query "${q}" renders ranked results (first card = top hit)`)
  }
  const hasScoreBadge = await page.locator(`${CARD} >> text=/^0\\.\\d\\d$/`).count()
  check(hasScoreBadge > 0, 'query result cards carry a score badge (hover)')

  // ---- Metadata mode: filename prefix
  await page.getByRole('button', { name: 'Clear search' }).click()
  await page.getByRole('button', { name: /Search mode/ }).click()
  await page.getByRole('option', { name: /Metadata/ }).click()
  {
    const resp = nextJson(page, '/images', { q_meta: 'KI8A' })
    await input.fill('KI8A')
    const data = await resp
    await settle(page)
    console.log(`  meta "KI8A" -> ${top(data.items)} (total ${data.total})`)
    check(data.total === 1 && data.items[0].file_name.startsWith('KI8A'), 'metadata "KI8A" finds the one KI8A file')
  }
  {
    const resp = nextJson(page, '/images', { q_meta: 'RF200' })
    await input.fill('RF200')
    const data = await resp
    await settle(page)
    const want = (await apiJson('/facets')).lenses.filter((l) => l.value.startsWith('RF200')).reduce((n, l) => n + l.count, 0)
    check(data.total === want && want > 0, `metadata "RF200" (lens prefix) -> ${data.total} (facets say ${want})`)
  }
  await page.getByRole('button', { name: 'Clear search' }).click()
  await settle(page)

  // ---- Facet selects (dock -> More filters)
  const facets = await apiJson('/facets')
  await openPanel(page, 'More filters')
  for (const [label, key, list] of [
    ['Lens', 'lens', facets.lenses],
    ['Camera', 'model', facets.models],
  ]) {
    for (const f of list) {
      const resp = nextJson(page, '/images', { [key]: f.value })
      await page.getByLabel(label, { exact: true }).selectOption(f.value)
      const data = await resp
      check(data.total === f.count, `${label} = ${f.value} -> ${data.total} (facet says ${f.count})`)
    }
    await page.getByLabel(label, { exact: true }).selectOption('')
    await settle(page)
  }

  // ---- Lens preset: the count on the button is what the filter returns
  {
    const more = await openPanel(page, 'More filters')
    const tele = more.getByRole('button', { name: /^Tele/ })
    const want = Number((await tele.innerText()).match(/(\d[\d,]*)/)[1].replace(/,/g, ''))
    const resp = nextJson(page, '/images', { focal_min: '70' })
    await tele.click()
    const data = await resp
    check(data.total === want, `"Tele" preset -> ${data.total} photos (button says ${want})`)
    await tele.click()
    await settle(page)
  }

  // ---- ISO + date range (More filters -> Exact ranges)
  {
    const more = await openPanel(page, 'More filters')
    await more.getByRole('button', { name: 'Exact ranges' }).click()
    await page.getByLabel('ISO from').fill('100')
    await page.getByLabel('ISO to').fill('200')
    await page.waitForURL(/iso_min=100.*iso_max=200|iso_max=200.*iso_min=100/)
    await settle(page)
    const url = new URL(page.url())
    const data = await apiJson(`/images?${url.searchParams.toString()}&limit=100`)
    const ok = data.items.every((i) => i.iso >= 100 && i.iso <= 200)
    check(url.searchParams.get('iso_min') === '100' && url.searchParams.get('iso_max') === '200' && ok && data.total > 0, `ISO 100–200 -> ${data.total} photos, all in range`)
    check((await page.locator(CARD).count()) >= Math.min(data.total, PAGE), 'grid shows the ISO-filtered photos (first page)')
  }
  await page.goto(`${BASE}/`)
  await settle(page)
  {
    const more = await openPanel(page, 'More filters')
    await more.getByRole('button', { name: 'Exact ranges' }).click()
    await page.getByLabel('Date from').fill('2025-06-22')
    await page.getByLabel('Date to').fill('2025-06-22')
    await page.waitForURL(/date_from=2025-06-22.*date_to=2025-06-22|date_to=2025-06-22.*date_from=2025-06-22/)
    await closePanel(page)
    await settle(page)
    const url = new URL(page.url())
    const data = await apiJson(`/images?${url.searchParams.toString()}&limit=100`)
    const ok = data.items.every((i) => i.taken_at.startsWith('2025-06-22'))
    check(data.total > 0 && ok && (await page.locator(CARD).count()) === data.total, `date 2025-06-22 only -> ${data.total} photos, all that day`)
  }
  await page.goto(`${BASE}/`)
  await settle(page)

  // ---- Subject chip (dock -> Subjects, via the find box)
  {
    const subs = await apiJson('/subjects')
    const dog = subs.items.find((s) => s.label === 'dog')
    const panel = await openPanel(page, 'Subjects')
    const chips = await panel.locator('button[aria-pressed]').count()
    check(chips === subs.items.length, `subjects panel lists every subject in use, grouped (${chips})`)
    await panel.getByLabel('Find subject').fill('dog')
    const resp = nextJson(page, '/images')
    await panel.getByRole('button', { name: /^dog\s*\d+$/i }).first().click()
    const data = await resp
    await settle(page)
    check(data.total === dog.count && data.items.every((i) => i.subjects.some((s) => s.label === 'dog')), `subject chip "dog" -> ${data.total} (expect ${dog.count})`)
    await panel.getByRole('button', { name: /^dog\s*\d+$/i }).first().click()
    await settle(page)
    await closePanel(page)
  }

  // ---- Infinite scroll: pages of 10 (the request limit is rewritten in the browser) load without clicking
  {
    await page.route(
      (u) => u.pathname === '/api/images',
      (route) => {
        const u = new URL(route.request().url())
        u.searchParams.set('limit', '10')
        return route.continue({ url: u.toString() })
      },
    )
    await page.goto(`${BASE}/`)
    await page.waitForSelector(CARD)
    const t0 = Date.now()
    while ((await page.locator(CARD).count()) < status.image_count && Date.now() - t0 < 8000) {
      await page.mouse.wheel(0, 4000)
      await page.waitForTimeout(250)
    }
    check((await page.locator(CARD).count()) === status.image_count, `infinite scroll loads all ${status.image_count} photos in pages of 10`)
    check((await page.getByRole('button', { name: 'Load more' }).count()) === 0, 'no "Load more" left at the end')
    await page.unroute((u) => u.pathname === '/api/images')
    await page.goto(`${BASE}/`)
    await settle(page)
  }

  // ---- Double-click like + persistence + Liked filter (a fixed shuffle seed keeps the order across reloads)
  {
    await page.goto(`${BASE}/?seed=4242`)
    await settle(page)
    const card = page.locator(CARD).nth(3)
    const name = (await card.getAttribute('aria-label')).replace(', liked', '')
    const before = (await card.getAttribute('aria-label')).endsWith(', liked')
    const likeResp = page.waitForResponse((r) => r.url().includes('/like'))
    await card.dblclick()
    await likeResp
    await page.waitForTimeout(400)
    check(!page.url().includes('view='), 'double-click does not open the lightbox')
    const after = (await page.locator(`${CARD}[aria-label^="${name}"]`).getAttribute('aria-label')).endsWith(', liked')
    check(after !== before, `double-click toggles like on ${name} (${before} -> ${after})`)
    await page.reload()
    await page.waitForSelector(CARD)
    await settle(page)
    const persisted = (await page.locator(`${CARD}[aria-label^="${name}"]`).getAttribute('aria-label')).endsWith(', liked')
    check(persisted === after, 'like persists after reload')
    const liked = (await apiJson('/status')).liked_count
    await page.locator(DOCK).getByRole('button', { name: 'Liked only' }).click()
    await settle(page)
    check((await page.locator(CARD).count()) === liked, `Liked filter -> ${liked} photo(s)`)
    await page.locator(DOCK).getByRole('button', { name: 'Liked only' }).click()
    await settle(page)
    // restore
    await page.locator(`${CARD}[aria-label^="${name}"]`).dblclick()
    await page.waitForTimeout(600)
  }

  // ---- Lightbox: open, keyboard nav, palette swatch -> color search
  {
    await page.locator(CARD).first().click()
    await page.waitForSelector(DIALOG)
    await settle(page)
    const v0 = new URL(page.url()).searchParams.get('view')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(350)
    const v1 = new URL(page.url()).searchParams.get('view')
    check(v1 && v1 !== v0, `ArrowRight: ${v0} -> ${v1}`)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(350)
    check(new URL(page.url()).searchParams.get('view') === v0, 'ArrowLeft goes back')
    const exif = await page.locator(DIALOG).innerText()
    const lens = (await apiJson(`/images/${encodeURIComponent(v0)}`)).lens
    check(!lens || exif.includes(lens), `EXIF panel shows the lens name (${lens})`)
    const swatch = page.locator(`${DIALOG} button[title^="Search by #"]`).first()

    const hex = (await swatch.getAttribute('title')).replace('Search by ', '')
    const resp = nextJson(page, '/search/color')
    await swatch.click()
    const data = await resp
    await settle(page)
    console.log(`  palette ${hex} (from ${v0}) -> ${top(data.items)}`)
    check(new URL(page.url()).searchParams.get('color') === hex && data.items.some((i) => i.id === v0), `palette swatch -> color search, source photo is in the results`)
  }

  // ---- Preset swatch
  {
    await page.goto(`${BASE}/`)
    await settle(page)
    const resp = nextJson(page, '/search/color')
    await (await openPanel(page, 'Color')).getByRole('button', { name: /^Orange #/ }).click()
    const data = await resp
    await settle(page)
    console.log(`  preset Orange -> ${top(data.items)}`)
    check(data.items.length > 0 && (await page.locator(CARD).count()) >= Math.min(60, data.items.length), 'preset swatch -> color results')
  }

  // ---- Find similar
  {
    await page.goto(`${BASE}/?q=dog`)
    await settle(page)
    await page.locator(CARD).first().click()
    await page.waitForSelector(DIALOG)
    const src = new URL(page.url()).searchParams.get('view')
    const resp = nextJson(page, '/search/similar')
    await page.locator(DIALOG).getByRole('button', { name: /Find similar/ }).click()
    const data = await resp
    await settle(page)
    console.log(`  similar to ${src} -> ${top(data.items)}`)
    check(new URL(page.url()).searchParams.get('similar') === src && !data.items.some((i) => i.id === src) && data.items.length > 0, 'Find similar: results exclude the source')
  }

  // ---- Load more (offset paging) through the API the UI uses
  {
    const a = await apiJson('/search/query?q=bird&limit=10&offset=0')
    const b = await apiJson('/search/query?q=bird&limit=10&offset=10')
    const all = await apiJson('/search/query?q=bird&limit=20')
    check(JSON.stringify([...a.items, ...b.items].map((i) => i.id)) === JSON.stringify(all.items.map((i) => i.id)), 'search offset paging is consistent')
  }

  // ---- 404 route + admin page render
  await page.goto(`${BASE}/admin`)
  await page.waitForSelector('text=Photo folder')
  await settle(page)
  check(true, 'admin page renders')
  await ctx.close()
}

async function touch(browser, errors) {
  console.log('\n== phone 390x844 (touch)')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  watchErrors(page, 'phone', errors)
  const cdp = await ctx.newCDPSession(page)
  await page.goto(`${BASE}/?seed=4242`) // fixed shuffle: the like checks reload the page
  await page.waitForSelector(CARD)
  await settle(page)
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll at 390px')

  // double-tap like
  const card = page.locator(CARD).nth(2)
  const name = (await card.getAttribute('aria-label')).replace(', liked', '')
  const before = (await card.getAttribute('aria-label')).endsWith(', liked')
  await card.tap()
  await page.waitForTimeout(90)
  await card.tap()
  await page.waitForTimeout(600)
  check(!page.url().includes('view='), 'double-tap does not open the lightbox')
  const after = (await page.locator(`${CARD}[aria-label^="${name}"]`).getAttribute('aria-label')).endsWith(', liked')
  check(after !== before, `double-tap toggles like on ${name}`)
  await page.reload()
  await page.waitForSelector(CARD)
  await settle(page)
  check((await page.locator(`${CARD}[aria-label^="${name}"]`).getAttribute('aria-label')).endsWith(', liked') === after, 'touch like persists after reload')
  const c2 = page.locator(`${CARD}[aria-label^="${name}"]`)
  await c2.tap()
  await page.waitForTimeout(90)
  await c2.tap()
  await page.waitForTimeout(600)

  // single tap opens lightbox; swipe navigates; double-tap in lightbox likes
  await page.locator(CARD).first().tap()
  await page.waitForSelector(DIALOG)
  await settle(page)
  const v0 = new URL(page.url()).searchParams.get('view')
  await swipe(page, cdp, { x: 320, y: 420 }, { x: 60, y: 430 })
  await page.waitForTimeout(500)
  const v1 = new URL(page.url()).searchParams.get('view')
  check(v1 && v1 !== v0, `swipe left: ${v0} -> ${v1}`)
  await swipe(page, cdp, { x: 60, y: 420 }, { x: 330, y: 430 })
  await page.waitForTimeout(500)
  check(new URL(page.url()).searchParams.get('view') === v0, 'swipe right goes back')
  await page.getByRole('button', { name: 'Info' }).tap()
  await page.waitForTimeout(500)
  const lens = (await apiJson(`/images/${encodeURIComponent(v0)}`)).lens
  check(!lens || (await page.locator(DIALOG).innerText()).includes(lens), `info sheet shows EXIF (${lens})`)
  await page.getByRole('button', { name: 'Close details' }).tap()
  await page.waitForTimeout(400)
  await swipe(page, cdp, { x: 195, y: 300 }, { x: 195, y: 650 })
  await page.waitForTimeout(600)
  check(!(await page.locator(DIALOG).count()), 'swipe down closes the lightbox')

  // dock -> Subjects panel
  check(await page.locator(DOCK).isVisible(), 'dock is visible on the phone')
  await page.locator(DOCK).getByRole('button', { name: /^Subjects/ }).tap()
  const panel = page.getByRole('dialog', { name: 'Subjects' })
  await panel.waitFor()
  await panel.getByLabel('Find subject').fill('flight')
  await panel.getByRole('button', { name: /^bird in flight\s*\d+$/i }).first().tap()
  await settle(page)
  const n = (await apiJson('/subjects')).items.find((s) => s.label === 'bird in flight').count
  check((await panel.innerText()).includes(`${n} photo`), `subjects panel chip -> footer says ${n} photos`)
  check((await page.locator(DOCK).getByRole('button', { name: /^Subjects/ }).innerText()).includes('1'), 'Subjects button shows a count badge')
  await ctx.close()
}

async function adminFlow(browser, errors) {
  console.log('\n== admin flow (refresh + switch catalog)')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  watchErrors(page, 'admin', errors)
  const before = (await apiJson('/status')).image_count
  await page.goto(`${BASE}/admin`)
  await page.waitForSelector('text=Photo folder')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.waitForFunction(() => /Last run complete|added/.test(document.body.innerText), null, { timeout: 30000 })
  const p = await apiJson('/admin/progress')
  check(!p.running && p.added === 0 && p.skipped === before, `refresh: ${p.added} added, ${p.skipped} skipped`)
  check(/0 new/.test(await page.locator('main').innerText()), 'admin shows the refresh summary (0 new)')

  await page.fill('#catalog-dir', CATALOG_DIR)
  await page.getByRole('button', { name: /^(Switch|Rebuild) catalog$/ }).click()
  await page.waitForSelector('[role="alertdialog"]')
  check(/nothing is deleted|permanently delete/i.test(await page.locator('[role="alertdialog"]').innerText()), 'confirm dialog says what happens to the data')
  await page.locator('[role="alertdialog"]').getByRole('button', { name: /^(Switch catalog|Purge & rebuild)$/ }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Indexing…'), null, { timeout: 10000 }).then(
    () => check(true, 'live progress visible during reindex'),
    () => check(false, 'live progress visible during reindex'),
  )
  const t0 = Date.now()
  let s
  do {
    await page.waitForTimeout(1000)
    s = await apiJson('/status')
  } while (s.indexing.running && Date.now() - t0 < 180000)
  console.log(`  reindex took ~${Math.round((Date.now() - t0) / 1000)}s`)
  check(s.image_count === before, `after switch: ${s.image_count} photos (expect ${before})`)
  await page.goto(`${BASE}/`)
  await page.waitForSelector(CARD)
  await settle(page)
  check((await page.locator(CARD).count()) === before, 'library shows them again')
  await ctx.close()
}

const browser = await chromium.launch()
const errors = []
try {
  await desktop(browser, errors)
  await touch(browser, errors)
  if (process.env.ADMIN_FLOW) {
    if (CATALOG_DIR) await adminFlow(browser, errors)
    else check(false, 'ADMIN_FLOW needs CATALOG_DIR (the folder to switch the catalog to)')
  }
} catch (e) {
  problems.push(`crashed: ${e.message.split('\n')[0]}`)
  console.error(e)
}
check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`)
await browser.close()
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nAll checks passed.')
process.exitCode = problems.length ? 1 : 0
