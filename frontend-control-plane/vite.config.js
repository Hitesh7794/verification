import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      // CP local dev port is 8090 — matches config.go default (CP_HTTP_ADDR
      // defaults to :8090) and backend/.env. 8091 was a stale value.
      '/api': 'http://localhost:8090',
    },
  },
})
