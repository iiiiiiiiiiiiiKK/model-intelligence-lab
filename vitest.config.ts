import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * `node:sqlite` is a Node 22.5+ builtin, but Vite's resolver does not list it as
 * a builtin, so it would otherwise try to resolve a package named "sqlite".
 * This tiny plugin marks it (and every other `node:` specifier) as external so
 * Node resolves it at runtime.
 */
const nodeBuiltins = {
  name: 'node-builtins-external',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id.startsWith('node:')) return { id, external: true };
    return null;
  },
};

export default defineConfig({
  plugins: [nodeBuiltins, react()],
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Server-side suites need real timers, real sockets and a real filesystem.
    environmentMatchGlobs: [
      ['tests/integration/**', 'node'],
      ['tests/server/**', 'node'],
      ['tests/unit/stats.test.ts', 'node'],
      ['tests/unit/scoring.test.ts', 'node'],
      ['tests/unit/security.test.ts', 'node'],
      ['tests/components/**', 'jsdom'],
    ],
    environment: 'jsdom',
  },
});
