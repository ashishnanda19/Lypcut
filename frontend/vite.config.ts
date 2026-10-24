import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    build: { target: 'es2022' },
    server: {
      // With VITE_API_MODE=real, /api (and the job feed on /api/jobs/ws) goes to the backend, so the browser sees one
      // origin and the login cookies work without CORS. The mock never reaches this: it answers in the browser.
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY || 'http://localhost:4000',
          ws: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  }
})
