import { defineConfig } from 'vitest/config'

// All domain tests run in Asia/Manila so local-date rules are deterministic.
process.env.TZ = 'Asia/Manila'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
