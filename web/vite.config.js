import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'CRS Dispatch',
        short_name: 'Dispatch',
        start_url: '/',
        display: 'standalone',
        theme_color: '#0E7C70',
        background_color: '#FFFFFF',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*/,
            handler: 'NetworkFirst',
            options: { cacheName: 'dispatch-api', networkTimeoutSeconds: 5 },
          },
        ],
      },
    }),
  ],
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
