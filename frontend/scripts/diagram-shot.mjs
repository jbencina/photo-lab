// Exports the system diagram from the documentation site for the README
// -> docs/static/img/system-overview-<light|dark>.png
// Usage (from frontend/):  DOCS_URL=http://localhost:3000/photo-lab node scripts/diagram-shot.mjs
// Serve the docs first (cd docs && npm start, or npm run build && npm run serve).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCS = process.env.DOCS_URL ?? 'http://localhost:3000/photo-lab'
const OUT = path.join(here, '../../docs/static/img')

const browser = await chromium.launch()
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 })
  await page.goto(`${DOCS}/internals/overview`)
  // The wide layout; the narrow one is hidden at this width.
  const svg = page.locator('figure svg').first()
  await svg.waitFor()
  await svg.screenshot({ path: path.join(OUT, `system-overview-${scheme}.png`) })
  await page.close()
}
await browser.close()
