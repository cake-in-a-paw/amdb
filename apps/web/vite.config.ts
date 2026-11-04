import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // The router plugin must run before React's so it can generate routeTree.gen.ts first.
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    // Must match WEB_ORIGIN in .env.example: Better Auth trusts that origin and redirects to it.
    port: 5173,
    strictPort: true,
    // Same origin in dev: the API and its auth cookie live behind /api.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
