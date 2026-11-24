import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/content-script.ts'),
      name: 'ChromeBrowserMcpContent',
      formats: ['iife'],
      fileName: () => 'content-script.js',
    },
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
