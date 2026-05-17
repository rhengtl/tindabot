import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/chat': 'http://localhost:8000',
      '/load-sales': 'http://localhost:8000',
      '/forecast': 'http://localhost:8000',
      '/sales-summary': 'http://localhost:8000',

    },
  },
})
