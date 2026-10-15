// Manual tags, tag suggestions and per-label propagation, end to end against a REAL `photolib serve`
// (EmbeddingGemma + d1-3B on the GPU). It WRITES to the catalog's database: it creates the labels below and
// tags photos, so point it at a scratch data dir, never your real library:
//
//   PHOTOLIB_DATA_DIR=/tmp/pl-data uv run photolib catalog set /path/to/sample
//   PHOTOLIB_DATA_DIR=/tmp/pl-data uv run photolib serve --port 8001 &
//   BASE_URL=http://localhost:8001 OUT=/tmp/pl-shots node scripts/e2e-tags.mjs
//
// The photo ids / labels are specific to the sample catalog. Each variant (desktop/phone x light/dark)
// creates one NEW label and propagates it; the first one also runs the detailed checks. To run it again,
// drop the labels first: `photolib labels --remove jellyfish --yes` (etc.), or rebuild the scratch catalog.
// OUT=dir saves screenshots as <viewport>-<theme>-<step>.png. ONLY=desktop-light,... restricts variants.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:8001'
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : null

const VARIANTS = [
  { vp: 'desktop', theme: 'light', photo: '5N7A1464.jpg', label: 'jellyfish', minAdded: 15, full: true },
  { vp: 'desktop', theme: 'dark', photo: '5N7A1380.jpg', label: 'lamp', minAdded: 4 },
  { vp: 'phone', theme: 'light', photo: '5N7A1387.jpg', label: 'seaweed', minAdded: 5 }, // (d1 is unsure about "kelp": 0 confirmed)
  { vp: 'phone', theme: 'dark', photo: '5N7A1418.jpg', label: 'sea anemone', minAdded: 1 },
].filter((v) => !process.env.ONLY || process.env.ONLY.split(',').includes(`${v.vp}-${v.theme}`))
const EXISTING = { photo: 'KI8A3893.jpg', typed: 'Reflec', label: 'reflection' } // a builtin label the harbor photo lacks
const NEGATIVE = { photo: '5N7A1293.jpg', label: 'red wattle' } // on the one turkey photo; nothing else has one
const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
}

const DIALOG = '[role="dialog"][aria-modal="true"]'
const INPUT = 'input[aria-label="Add a tag"]'
const LIST = '[role="listbox"][aria-label="Tag suggestions"]'
const OPTION = `${LIST} [role="option"]`
const OFFER = '[data-testid="propagation-offer"]'
const PROGRESS = '[data-testid="propagation-progress"]'
const RESULT = '[data-testid="propagation-result"]'

const problems = []
const check = (cond, msg) => {
  if (!cond) problems.push(msg)
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  return cond
}
const api = async (p, init) => (await fetch(`${BASE}/api${p}`, init)).json()
const subjectsOf = async (id) => (await api(`/images/${encodeURIComponent(id)}`)).subjects
const withLabel = async (label) => (await api(`/images?limit=500&subject=${encodeURIComponent(label)}`)).items.map((i) => i.id).sort()

async function waitIdle(timeout = 300000) {
  const t0 = Date.now()
  for (;;) {
    const p = await api('/admin/progress')
    if (!p.running) return p
    if (Date.now() - t0 > timeout) throw new Error('job did not finish')
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r }))))
  await page.waitForTimeout(350)
}

async function shot(page, v, name) {
  if (!OUT) return
  const file = path.join(OUT, `${v.vp}-${v.theme}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  shot ${path.basename(file)}`)
}

async function openPhoto(page, v, id) {
  await page.goto(`${BASE}/?view=${encodeURIComponent(id)}`)
  await page.waitForSelector(DIALOG)
  if (v.vp === 'phone') await page.getByRole('button', { name: 'Info' }).tap()
  await page.waitForSelector(INPUT)
  await settle(page)
}

/** Type into the add-tag box and wait for the suggestions that answer exactly this text. */
async function typeTag(page, text) {
  const done = page.waitForResponse((r) => {
    const u = new URL(r.url())
    return u.pathname === '/api/labels/suggest' && u.searchParams.get('q') === text
  })
  await page.fill(INPUT, text)
  const json = await (await done).json()
  await page.waitForTimeout(120)
  return json
}

const rows = (page) =>
  page.locator(OPTION).evaluateAll((els) =>
    els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), disabled: e.getAttribute('aria-disabled') === 'true', active: e.getAttribute('aria-selected') === 'true', h: e.getBoundingClientRect().height })),
  )

async function createAndPropagate(page, v) {
  console.log(`\n== ${v.vp}/${v.theme}: create "${v.label}" on ${v.photo} and propagate`)
  await openPhoto(page, v, v.photo)
  const before = await subjectsOf(v.photo)

  // empty focus -> likely labels for this photo
  if (v.vp === 'phone') await page.tap(INPUT)
  else await page.click(INPUT)
  await page.waitForSelector(OPTION)
  check((await page.locator('text=Suggested for this photo').count()) === 1, 'focus shows "Suggested for this photo" defaults')
  const defaults = await rows(page)
  check(defaults.length > 0 && defaults.every((r) => !before.some((s) => r.text.toLowerCase().startsWith(s.label))), `defaults exclude tags already on the photo (${defaults.slice(0, 3).map((r) => r.text).join(' | ')})`)

  // typing: embedding-similar existing tags + Create row
  const sea = await typeTag(page, 'sea')
  const seaRows = await rows(page)
  console.log(`    "sea" -> ${seaRows.map((r) => r.text + (r.disabled ? ' [disabled]' : '')).join(' | ')}`)
  check(sea.items.find((i) => i.label === 'ocean')?.match === 'similar', '"sea" suggests ocean as a similar tag')
  check(seaRows.some((r) => /similar/i.test(r.text)), 'similar rows carry a "similar" badge')
  check(seaRows.at(-1)?.text.includes('Create “sea”'), 'last row is Create "sea" (no exact match)')
  check(seaRows.every((r) => r.h >= 44), `rows are >= 44px tall (${Math.min(...seaRows.map((r) => r.h))}px)`)
  if (sea.items.some((i) => i.on_image)) check(seaRows.some((r) => r.disabled && /on this photo/.test(r.text)), 'a tag already on the photo is shown disabled')
  if (v.vp === 'phone') {
    const box = await page.locator(INPUT).boundingBox()
    const last = await page.locator(OPTION).last().boundingBox()
    check(box.y < 844 * 0.4, `input scrolled to the top of the sheet (y=${Math.round(box.y)})`)
    check(last.y + last.height <= 844 * 0.72, `whole list fits in the upper 72% of the screen, clear of a keyboard (bottom=${Math.round(last.y + last.height)})`)
  }
  await shot(page, v, 'tag-dropdown')

  // the new label
  const typed = v.label.replace(/^./, (c) => c.toUpperCase()) + ' '
  const sug = await typeTag(page, typed)
  const newRows = await rows(page)
  check(sug.exact_exists === false && sug.normalized === v.label, `"${typed}" normalizes to "${v.label}", not an existing tag`)
  check(newRows.at(-1)?.text.includes(`Create “${v.label}”`) && newRows.at(-1).active, 'Create row is present and highlighted')
  await shot(page, v, 'tag-create-row')
  const added = page.waitForResponse((r) => r.url().includes('/tags') && r.request().method() === 'POST')
  if (v.vp === 'phone') await page.locator(OPTION).last().tap()
  else await page.keyboard.press('Enter')
  const res = await (await added).json()
  check(res.created === true && res.label === v.label, `POST /tags created "${res.label}"`)
  check(res.propagate && res.propagate.candidates >= 0, `preview: ${res.propagate?.candidates} candidates, ~${res.propagate?.est_seconds}s`)
  await page.waitForSelector(`[data-manual-tag="${v.label}"]`)
  check((await page.locator(`[data-manual-tag="${v.label}"] button[aria-label^="Remove tag"]`).count()) === 1, 'new tag renders as a manual chip with a remove button')
  const after = await subjectsOf(v.photo)
  const mine = after.find((s) => s.label === v.label)
  const manual = after.filter((s) => s.source === 'user').length
  check(mine?.source === 'user' && mine.score === 1 && mine.display_rank === manual, `stored as source=user, score 1, ranked with the manual tags ahead of model tags (#${mine?.display_rank})`)

  await page.waitForSelector(OFFER)
  const offer = await page.locator(OFFER).innerText()
  check(offer.includes(`Look for “${v.label}” in your other photos?`) && offer.includes(`${res.propagate.candidates} candidate`), `prompt: ${offer.replace(/\s+/g, ' ').slice(0, 110)}`)
  await page.locator(OFFER).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await shot(page, v, 'tag-created-prompt')

  const t0 = Date.now()
  const run = page.locator(OFFER).getByRole('button', { name: 'Run' })
  if (v.vp === 'phone') await run.tap()
  else await run.click()
  await page.waitForSelector(PROGRESS, { timeout: 15000 })
  check(true, 'progress appears after Run')
  // wait until d1 is actually answering (a "n / N" counter with n > 0), but don't miss short jobs
  const seen = res.propagate.candidates >= 12 ? '([4-9]|\\d\\d+)' : '[1-9]\\d*' // a few photos in, so rate/ETA are showing
  await page.waitForFunction(([sel, n]) => new RegExp(`${n} / \\d+`).test(document.querySelector(sel)?.textContent ?? ''), [PROGRESS, seen], { timeout: 60000 }).catch(() => {})
  if (await page.locator(PROGRESS).count()) await shot(page, v, 'tag-propagating')
  await page.waitForSelector(RESULT, { timeout: 300000 })
  const secs = (Date.now() - t0) / 1000
  const p = await api('/admin/progress')
  const result = (await page.locator(RESULT).innerText()).replace(/\s+/g, ' ')
  console.log(`    ${result}  [wall ${secs.toFixed(1)}s, job ${p.propagate_seconds}s]`)
  check(p.mode === 'propagate' && p.error == null && p.total === res.propagate.candidates, `job checked ${p.total} candidates, added ${p.propagate_added}`)
  check(p.propagate_added >= v.minAdded, `d1 confirmed at least ${v.minAdded} (got ${p.propagate_added})`)
  const have = await withLabel(v.label)
  check(have.length === p.propagate_added + 1, `${have.length} photos now have "${v.label}" (1 manual + ${p.propagate_added} d1)`)
  console.log(`    photos: ${have.map((i) => i.replace(/^5N7A|\.jpg$/g, '')).join(' ')}`)
  const st = await api('/status')
  check(st.tagger.loaded === false, 'd1 unloaded after the job')
  await page.locator(RESULT).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await shot(page, v, 'tag-result')
  return { res, p, have }
}

async function detailed(page, v) {
  console.log('\n== detailed checks (existing tag, remove, keyboard, model tags)')
  await openPhoto(page, v, EXISTING.photo)
  await page.click(INPUT)
  const sug = await typeTag(page, EXISTING.typed)
  let r = await rows(page)
  console.log(`    "${EXISTING.typed}" -> ${r.map((x) => x.text).join(' | ')}`)
  check(sug.items[0].label === EXISTING.label && sug.items[0].match === 'prefix', 'prefix match offered first')
  check(r[0].active, 'first text match is highlighted')
  // arrow keys move the highlight, wrap around, Enter picks
  await page.keyboard.press('ArrowDown')
  check((await rows(page))[1]?.active === true, 'ArrowDown moves the highlight')
  await page.keyboard.press('ArrowUp')
  check((await rows(page))[0].active, 'ArrowUp moves it back')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`[data-manual-tag="${EXISTING.label}"]`)
  let subs = await subjectsOf(EXISTING.photo)
  check(subs[0].label === EXISTING.label && subs[0].source === 'user', `Enter added existing tag "${EXISTING.label}" as a manual tag`)
  check((await page.locator(OFFER).count()) === 0, 'no propagation prompt for an existing tag')
  check((await page.inputValue(INPUT)) === '', 'input cleared after adding')

  // exact match typed -> no Create row, the row is disabled because it's on the photo
  await page.click(INPUT)
  const exact = await typeTag(page, EXISTING.label)
  r = await rows(page)
  check(exact.exact_exists && !r.some((x) => x.text.startsWith('Create')), 'exact match: no Create row')
  check(r[0].disabled, 'the tag that is already on the photo is disabled')
  // Esc closes the dropdown but not the lightbox
  await page.keyboard.press('Escape')
  check((await page.locator(LIST).count()) === 0 && (await page.locator(DIALOG).count()) === 1, 'Esc closes the suggestions, not the lightbox')
  await page.fill(INPUT, '')

  // remove via the x; model tags have no x
  check((await page.locator('button[aria-label^="Remove tag"]').count()) === 1, 'only the manual tag has a remove button')
  await page.click(`[data-manual-tag="${EXISTING.label}"] button[aria-label^="Remove tag"]`)
  await page.waitForSelector(`[data-manual-tag="${EXISTING.label}"]`, { state: 'detached' })
  subs = await subjectsOf(EXISTING.photo)
  check(!subs.some((s) => s.label === EXISTING.label), 'x removed the manual tag')
  const del = await fetch(`${BASE}/api/images/${EXISTING.photo}/tags/${encodeURIComponent(subs[0].label)}`, { method: 'DELETE' })
  check(del.status === 409, `DELETE on a model tag is refused (409)`)
  // add it back by clicking the row (kept for the retag check)
  await page.click(INPUT)
  await typeTag(page, EXISTING.typed)
  await page.locator(OPTION).first().click()
  await page.waitForSelector(`[data-manual-tag="${EXISTING.label}"]`)
  await shot(page, v, 'tag-manual-chip')

  // the new label is a normal subject everywhere: filter chips + subject filter
  await page.keyboard.press('Escape')
  await page.goto(`${BASE}/?subject=${encodeURIComponent(v.label)}`)
  await page.waitForSelector('main [role="button"][tabindex="0"]')
  await settle(page)
  const n = await page.locator('main [role="button"][tabindex="0"]').count()
  check(n === (await withLabel(v.label)).length, `subject filter "${v.label}" shows ${n} photos`)
  await shot(page, v, 'tag-filter-grid')
}

async function negative(page, v) {
  console.log(`\n== negative: "${NEGATIVE.label}" on ${NEGATIVE.photo}, propagated from the admin page`)
  await openPhoto(page, v, NEGATIVE.photo)
  await page.click(INPUT)
  await typeTag(page, NEGATIVE.label)
  const added = page.waitForResponse((r) => r.url().includes('/tags') && r.request().method() === 'POST')
  await page.keyboard.press('Enter')
  const res = await (await added).json()
  check(res.created, `created "${NEGATIVE.label}" (${res.propagate.candidates} candidates)`)
  await page.waitForSelector(OFFER)
  await page.locator(OFFER).getByRole('button', { name: 'Not now' }).click()
  check((await page.locator(OFFER).count()) === 0, '"Not now" dismisses the prompt')

  await page.goto(`${BASE}/admin`)
  await page.waitForSelector('[data-testid="user-labels"]')
  await settle(page)
  const card = (await page.locator('[data-testid="user-labels"]').innerText()).replace(/\s+/g, ' ')
  check(card.toLowerCase().includes(NEGATIVE.label) && card.toLowerCase().includes(v.label), `admin lists user labels: ${card.slice(0, 140)}`)
  await page.locator('[data-testid="user-labels"] li', { hasText: new RegExp(NEGATIVE.label, 'i') }).getByRole('button', { name: 'Find in library' }).click()
  await page.waitForSelector('[role="alertdialog"]')
  await page.waitForFunction(() => /\d+ photos?/.test(document.querySelector('[role="alertdialog"]')?.textContent ?? ''))
  const dlg = (await page.locator('[role="alertdialog"]').innerText()).replace(/\s+/g, ' ')
  check(dlg.includes(`${res.propagate.candidates} photo`), `confirm dialog shows the candidate count (${res.propagate.candidates})`)
  await page.waitForTimeout(300)
  await shot(page, v, 'admin-find-dialog')
  if (res.propagate.candidates > 0) {
    await page.locator('[role="alertdialog"]').getByRole('button', { name: 'Find in library' }).click()
    await page.waitForFunction(() => document.body.innerText.includes('Looking for'), null, { timeout: 15000 })
    await page.waitForFunction(() => /[1-9]\d* \/ \d+/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 60000 }).catch(() => {})
    await shot(page, v, 'admin-propagating')
    const p = await waitIdle()
    check(p.mode === 'propagate' && p.error == null && p.propagate_added === 0, `d1 checked ${p.total} candidates and confirmed ${p.propagate_added} (expect 0)`)
    await page.waitForFunction(() => document.body.innerText.includes('Last run complete'), null, { timeout: 15000 })
    await settle(page)
    await shot(page, v, 'admin-after-propagate')
  }
  check((await withLabel(NEGATIVE.label)).join() === NEGATIVE.photo, `"${NEGATIVE.label}" is still only on ${NEGATIVE.photo}`)
}

async function adminCard(page, v) {
  await page.goto(`${BASE}/admin`)
  await page.waitForSelector('[data-testid="user-labels"]')
  await settle(page)
  await page.locator('[data-testid="user-labels"]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  check((await page.locator('[data-testid="user-labels"] li').count()) >= 1, 'admin Labels card lists user labels')
  // (mobile emulation widens the layout viewport instead of scrolling, so compare against the device width)
  const wide = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth))
  check(wide <= VIEWPORTS[v.vp].viewport.width, `admin page has no horizontal overflow (${wide}px)`)
  await shot(page, v, 'admin-labels')
}

if (OUT) await mkdir(OUT, { recursive: true })
const existing = new Set((await api('/labels')).items.map((l) => l.label))
const clash = [...VARIANTS.map((v) => v.label), ...(VARIANTS.some((v) => v.full) ? [NEGATIVE.label] : [])].filter((l) => existing.has(l))
if (clash.length) {
  console.error(`These labels already exist (run on a fresh scratch catalog or \`photolib labels --remove\` them): ${clash.join(', ')}`)
  process.exit(2)
}
const browser = await chromium.launch()
const errors = []
try {
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({ ...VIEWPORTS[v.vp], colorScheme: v.theme })
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('photolib:theme', t)
      } catch {}
    }, v.theme)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`${v.vp}/${v.theme}: ${e}`))
    page.on('console', (m) => m.type() === 'error' && !/409|404|422/.test(m.text()) && errors.push(`${v.vp}/${v.theme}: ${m.text()}`))
    await createAndPropagate(page, v)
    if (v.full) {
      await detailed(page, v)
      await negative(page, v)
    }
    await adminCard(page, v)
    await ctx.close()
  }
} catch (e) {
  problems.push(`crashed: ${e.message.split('\n')[0]}`)
  console.error(e)
}
check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`)
await browser.close()
console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nAll checks passed.')
process.exitCode = problems.length ? 1 : 0
