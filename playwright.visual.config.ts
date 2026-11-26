import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'line',
  // 基线**不入库**：截图是本地开发时的比对工具，不是仓库资产（几百 KB 的
  // PNG 只会让 clone 变重，且换个镜像版本就全部失效）。
  //
  //   pnpm test:visual                       → 只跑 axe（CI 用的就是这个）
  //   VISUAL_SNAPSHOTS=1 pnpm test:visual    → 额外比对本地基线
  //   VISUAL_SNAPSHOTS=1 pnpm test:visual:update → 刷新本地基线
  //
  // 本地基线落在 tests/visual/*-snapshots/，与 test-results/ 一样被 gitignore。
  ignoreSnapshots: process.env.VISUAL_SNAPSHOTS !== '1',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'pnpm --filter @hubagent/web dev --port 4173',
    url: 'http://127.0.0.1:4173',
    // Never reuse a stray dev server: a stale one silently serves old CSS, so
    // the "actual" screenshot matches an outdated baseline and the diff is lost.
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
