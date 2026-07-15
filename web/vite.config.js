import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ws: true is required here (unlike a plain string target) so the
      // /api/tv/ws WebSocket upgrade (server/src/tv.js) actually gets
      // proxied in dev instead of silently failing to connect -- only
      // reachable when the API side is a real `wrangler dev` instance
      // (npm run dev:api), since Durable Objects need the Workers runtime.
      '/api': {
        target: 'http://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
