import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli.ts', 'src/version.ts'],
      thresholds: { 'src/plan/**': { lines: 90 }, 'src/format/**': { lines: 90 }, 'src/sinks/**': { lines: 80 } },
    },
  },
});
