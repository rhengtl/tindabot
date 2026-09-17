import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// All domain tests run in Asia/Manila so local-date rules are deterministic.
process.env.TZ = 'Asia/Manila'

// The online Supabase suite (src/sync/__tests__/online.test.ts) reads TEST_* / TINDABOT_* from
// frontend/.env.test.local (git-ignored) and skips itself entirely when they are absent.
// Only the anon key and the two dedicated test users ever appear there.
const onlineEnv = loadEnv('test', __dirname, ['TINDABOT_', 'TEST_'])

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: onlineEnv,
  },
})
