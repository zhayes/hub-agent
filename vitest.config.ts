import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    // 架构测试会 spawn dependency-cruiser，给足时间
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 每个测试文件会 spawn 子进程；限制并发，避免 CI/本机启动超时抖动
    maxWorkers: 4,
  },
})
