import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Three widths are enough to catch a broken breakpoint: 1440 (rail + content),
// 768 (stacked), 390 (single column). 1024 rarely fails on its own and costs
// two more committed baselines per surface.
const cases = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
] as const

const themes = ['light', 'dark'] as const

for (const theme of themes) {
  for (const item of cases) {
    test(`gallery ${theme} ${item.name}`, async ({ page }) => {
      await page.setViewportSize({ width: item.width, height: item.height })
      // Reduced motion also freezes the loading grid and streaming caret.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript((value) => {
        localStorage.setItem('hubagent.theme', value)
        localStorage.setItem('hubagent.locale', 'en-US')
      }, theme)

      await page.goto('/dev/ui')
      await expect(page.getByRole('heading', { name: 'UI gallery' })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)

      await expect(page).toHaveScreenshot(`gallery-${theme}-${item.name}.png`, {
        fullPage: true,
        animations: 'disabled',
        // Default threshold (0.2) tolerates a whole fill shift: #181614 vs #0e0d0c
        // is only ~4% per channel and would pass as "identical".
        threshold: 0.05,
        maxDiffPixelRatio: 0.002,
      })
    })
  }
}

test('gallery has no critical or serious axe violations', async ({ page }) => {
  await page.goto('/dev/ui')
  await expect(page.getByRole('heading', { name: 'UI gallery' })).toBeVisible()

  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )

  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    JSON.stringify(blocking, null, 2),
  ).toEqual([])
})
