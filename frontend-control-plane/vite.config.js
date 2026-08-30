import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      // CP local dev port is 8091 (matches config.go default and the
      // prod cp.env). 8081 was a stale value in an earlier commit.
      '/api': 'http://localhost:8091',
    },
  },
})
