import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    // Yjs' benign "Invalid access" hydration warning (see src/main.ts).
    onConsoleLog: (log) => !log.startsWith('Invalid access: Add Yjs type'),
  },
})
