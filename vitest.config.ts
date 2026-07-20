import { fileURLToPath, URL } from 'node:url';
import { transformWithOxc } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'test-tsx-transform',
      enforce: 'pre',
      async transform(code, id) {
        const filename = id.split('?')[0];
        if (!filename.endsWith('.tsx')) return null;

        return transformWithOxc(code, filename, {
          lang: 'tsx',
          jsx: { runtime: 'automatic' },
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
