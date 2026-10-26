import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // Build scratch space, test artefacts and linter temp dirs must not
      // trigger HMR reloads (and can be locked mid-write on Windows).
      ignored: [
        '**/.tmp/**',
        '**/artifacts/**',
        '**/data/**',
        '**/dist/**',
        '**/coverage/**',
        '**/*.tmpdir/**',
        '**/*.tmp',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
});
