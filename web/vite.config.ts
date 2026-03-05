import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'rolldown-vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    codeInspectorPlugin({
      bundler: 'vite',
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: '/admin/',
  build: {
    outDir: resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5177,
    strictPort: true,
    hmr: {
      host: 'localhost',
      clientPort: 5177,
    },
    proxy: {
      '/api': 'http://localhost:4099',
      '/openai': 'http://localhost:4099',
      '/anthropic': 'http://localhost:4099',
    },
  },
});
