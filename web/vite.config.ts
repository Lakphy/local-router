import path, { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { defineConfig } from 'rolldown-vite';

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
      '@': path.resolve(__dirname, './src'),
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
      '/api': {
        target: 'http://localhost:4099',
        ws: true,
      },
      '/openai': 'http://localhost:4099',
      '/anthropic': 'http://localhost:4099',
    },
  },
});
