// Smart filter suggestions in the search box, at four widths. Usage: BASE_URL=http://localhost:8000 node scripts/e2e-smart.mjs
//   OUT=dir saves screenshots. Read-only. The sample-specific checks (June 2025, the RF200 lens) assume the sample catalog.
// What it guards: typing a sentence and pressing Enter always searches the text and adds no filter, and
// suggestions only appear for short input (logged per sentence), while picking one by keyboard, click or tap
// turns the typed word into a filter.
import { chromium } from 'playwright'
const B = process.env.BASE_URL ?? 'http://localhost:8000', OUT = process.env.OUT
const b = await chromium.launch(); const errs = []
let fails = 0
const check = (c, m) => { if (!c) fails++; console.log((c ? '  ok   ' : '  FAIL ') + m) }
const SENTENCES = ['bird in flight over the ocean', 'a dog sitting on the grass', 'sunset at the beach with waves', 'orange flowers in the garden', 'whale tail near the boat']
for (const [name, vp, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['tablet', { width: 820, height: 1180 }, true], ['phone', { width: 390, height: 844 }, true], ['small', { width: 360, height: 640 }, true]]) {
  console.log(`== ${name} ${vp.width}x${vp.height}`)
  const ctx = await b.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 })
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(name + ': ' + e.message))
  const box = p.getByRole('combobox')
  const list = p.locator('#search-suggestions')
  const params = () => new URL(p.url()).searchParams
  const fresh = async () => { await p.goto(B + '/?seed=7'); await p.waitForSelector('main img'); await p.waitForTimeout(600) }
  await fresh()

  // 1. Sentences: Enter searches the text, never adds a filter; log which keystrokes showed suggestions
  for (const s of SENTENCES) {
    await box.click(); await box.fill('')
    const shown = []
    for (let i = 1; i <= s.length; i++) {
      await box.pressSequentially(s[i - 1])
      if (await list.isVisible()) shown.push(s.slice(0, i).split(' ').pop())
    }
    await box.press('Enter'); await p.waitForTimeout(500)
    const q = params().get('q'); const filt = ['subject', 'focal_min', 'focal_max', 'iso_min', 'iso_max', 'f_min', 'f_max', 'date_from', 'liked', 'lens', 'model'].filter((k) => params().has(k))
    check(q === s && filt.length === 0, `"${s}" -> q=${JSON.stringify(q)}, filters=[${filt}]; suggestions shown while typing: ${[...new Set(shown)].join(', ') || 'never'}`)
    await fresh()
  }

  // 2. keyboard pick: "tele" + ArrowDown + Enter
  await box.click(); await box.pressSequentially('tele')
  check(await list.isVisible(), 'typing "tele" shows suggestions')
  const first = (await list.getByRole('option').first().innerText()).replace(/\s+/g, ' ')
  if (!mobile) {
    await box.press('ArrowDown'); await box.press('Enter'); await p.waitForTimeout(600)
    check(params().get('focal_min') === '70' && !params().get('q') && (await box.inputValue()) === '', `ArrowDown+Enter picks "${first}" -> focal 70–299.9, box cleared, no text search`)
  } else {
    await list.getByRole('option').first().tap(); await p.waitForTimeout(600)
    check(params().get('focal_min') === '70' && (await box.inputValue()) === '', `tap picks "${first}" -> focal 70–299.9, box cleared`)
  }
  check(await p.getByRole('button', { name: 'Remove filter' }).count() >= 1, 'picked filter shows as a chip')
  await fresh()

  // 3. text + filter: "whale june" -> pick June, then Enter searches "whale"
  await box.click(); await box.pressSequentially('whale june')
  const opts = await list.getByRole('option').allInnerTexts()
  check(opts.some((o) => /June 2025/.test(o)), `"whale june" suggests ${opts.map((o) => o.split('\n')[0]).join(' | ')}`)
  await list.getByRole('option', { name: /June 2025/ }).click(); await p.waitForTimeout(400)
  check((await box.inputValue()) === 'whale ', `after picking, the box keeps "whale " (got ${JSON.stringify(await box.inputValue())})`)
  await box.press('Enter'); await p.waitForTimeout(700)
  check(params().get('q') === 'whale' && params().get('date_from') === '2025-06', `Enter -> q=whale with date 2025-06 (${params().toString()})`)
  await fresh()

  // 4. Escape hides suggestions and keeps the text; typing brings them back
  await box.click(); await box.pressSequentially('bird')
  await box.press('Escape'); await p.waitForTimeout(150)
  check(!(await list.isVisible()) && (await box.inputValue()) === 'bird', 'Esc hides suggestions, keeps "bird"')
  await box.pressSequentially('s'); await p.waitForTimeout(150)
  check(await list.isVisible(), 'typing again shows them again ("birds")')
  await fresh()

  // 5. multi-word + lens code + year + liked
  for (const [t, re] of [['bird in', /Bird in flight/], ['low li', /Low light/], ['rf200', /RF200-800mm/], ['2025', /^2025/], ['favor', /Liked/]]) {
    await box.click(); await box.fill(''); await box.pressSequentially(t)
    const o = (await list.isVisible()) ? await list.getByRole('option').allInnerTexts() : []
    check(o.length > 0 && re.test(o[0]), `"${t}" -> first suggestion ${JSON.stringify(o[0]?.split('\n')[0])}`)
  }

  // 6. layout: dropdown inside the viewport, no horizontal scroll, rows are tappable
  await box.fill(''); await box.pressSequentially('bird')
  const r = await list.boundingBox()
  check(r && r.x >= 0 && r.x + r.width <= vp.width + 0.5, `dropdown fits the width (${Math.round(r?.x)}..${Math.round(r?.x + r?.width)} of ${vp.width})`)
  const rowH = (await list.getByRole('option').first().boundingBox()).height
  check(!mobile || rowH >= 44, `option rows ${Math.round(rowH)}px tall`)
  check(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'no horizontal scroll')
  if (OUT) await p.screenshot({ path: `${OUT}/${name}-bird.png` })
  await box.fill(''); await box.pressSequentially('whale june')
  if (OUT) await p.screenshot({ path: `${OUT}/${name}-whale-june.png` })
  await ctx.close()
}
console.log(fails ? `${fails} FAILED` : 'all passed', '| page errors:', errs.length ? errs : 'none')
await b.close()
process.exit(fails || errs.length ? 1 : 0)
