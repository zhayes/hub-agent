import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'line',
  // 基线按平台后缀入库（当前仅 -darwin）。非 macOS 环境跳过截图比对，
  // 只保留 axe 断言，避免在 Linux 容器里出现 "snapshot doesn't exist" 的假失败。
  ignoreSnapshots: process.platform !== 'darwin',
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
