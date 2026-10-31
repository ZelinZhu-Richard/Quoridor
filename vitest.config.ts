import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'scripts/*.test.mjs'],
    environment: 'node',
  },
});
