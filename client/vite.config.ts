import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const frontendCriticalCoverageScope = ['src/pages/Login.tsx', 'src/pages/AccountSettings.tsx'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.rtl.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: '../coverage/client',
      // Scope volontairement limité aux parcours actuellement exercés en RTL.
      // Ne pas présenter ce rapport comme une couverture applicative frontend globale.
      include: frontendCriticalCoverageScope,
      thresholds: {
        statements: 80,
        branches: 80,
      },
    },
  },
});
