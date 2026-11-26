import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import solid from '@solidjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/* 开发时 daemon 的端口；与 `ha web` 的默认值保持一致。 */
const HUB_PORT = Number.parseInt(process.env['HUBAGENT_PORT'] ?? '7788', 10)

/**
 * 开发模式也要"零配置"：把 daemon 的 bearer token 注入 index.html，
 * 和 `ha web` 的行为一致，避免开发时还要手动粘贴 token。
 * `HUBAGENT_DEV_NO_TOKEN=1` 用于 e2e（需要模拟未连接状态）。
 */
function injectToken(): Plugin {
  return {
    name: 'hubagent-dev-token',
    apply: 'serve',
    transformIndexHtml(html: string): string {
      const token = readToken()
      if (token === '') return html
      return html.replace(
        '</head>',
        `<script>window.__HUBAGENT_TOKEN__ = ${JSON.stringify(token)}</script></head>`,
      )
    },
  }
}

function readToken(): string {
  if (process.env['HUBAGENT_DEV_NO_TOKEN'] === '1') return ''
  const home = process.env['HUBAGENT_HOME'] ?? join(homedir(), '.hubagent')
  try {
    return readFileSync(join(home, 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), injectToken()],
  // @ui-sdk/solid loads its own core entries; pre-bundling one of them separately
  // makes the two copies disagree in development.
  optimizeDeps: { exclude: ['@ui-sdk/core'] },
  server: {
    // 开发时的 API 走 daemon；没有它，`/api` 会落到 index.html。
    proxy: {
      '/api': { target: `http://127.0.0.1:${HUB_PORT}`, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
