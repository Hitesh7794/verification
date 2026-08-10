import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // VITE_ALLOW_TUNNEL=1 binds on all interfaces + accepts any Host
    // header, so an HTTPS tunnel (localhost.run / cloudflared / ngrok)
    // can hand a *.lhr.life / *.trycloudflare.com / *.ngrok-free.app
    // URL straight to a remote browser. Off by default to keep the
    // dev server local-only when not deliberately tunnelling.
    host: process.env.VITE_ALLOW_TUNNEL ? true : 'localhost',
    allowedHosts: process.env.VITE_ALLOW_TUNNEL ? true : undefined,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
