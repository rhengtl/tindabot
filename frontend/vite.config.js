import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Dev only: serves POST /api/ai from api/ai.ts (on Vercel the same file is a serverless function).
 * Server-side settings (GEMINI_API_KEY, optional GEMINI_MODEL) are read from frontend/.env.local by
 * this Node process and handed to the handler; they are never `VITE_`-prefixed, so Vite never puts
 * them in the browser bundle. `vite preview` has no function: the app then says the AI is not set up.
 */
function aiDevFunction() {
  return {
    name: 'tindabot-ai-dev-function',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.root, '')
      server.middlewares.use('/api/ai', async (req, res) => {
        try {
          const mod = await server.ssrLoadModule('/api/ai.ts')
          const chunks = []
          for await (const c of req) chunks.push(c)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
          const request = new Request('http://localhost/api/ai', { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined })
          const out = await mod.handle(request, { ...env, ...process.env })
          res.statusCode = out.status
          out.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await out.arrayBuffer()))
        } catch (e) {
          console.error('[ai dev function]', e)
          res.statusCode = 500
          res.end('{"error":"upstream"}')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    aiDevFunction(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'TindaBot',
        short_name: 'TindaBot',
        description: 'Smart listahan para sa sari-sari store',
        lang: 'tl',
        start_url: '/',
        display: 'standalone',
        background_color: '#fef9f0',
        theme_color: '#f0a500',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        // the AI function is network-only; never answer it with the cached app shell
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { port: 5173 },
})
