import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/worker.ts', 'src/presentation/web/server.ts', 'src/tui/index.ts', 'src/tui/presentation/app.ts', 'src/tui/presentation/widgets/**'],
    },
    testTimeout: 15_000,
  },
});
