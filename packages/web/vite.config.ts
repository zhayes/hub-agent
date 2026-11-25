import solid from '@solidjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  // @ui-sdk/solid loads its own core entries; pre-bundling one of them separately
  // makes the two copies disagree in development.
  optimizeDeps: { exclude: ['@ui-sdk/core'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
