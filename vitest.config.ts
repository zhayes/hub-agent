import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    // 架构测试会 spawn dependency-cruiser，给足时间
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
