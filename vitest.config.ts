import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirrors the `@shared` alias declared per-entry in electron.vite.config.ts.
// electron-vite only wires that alias into its own main/preload/renderer
// build graphs; plain `vitest run` has no vite config of its own, so runtime
// imports of `@shared/*` (as opposed to erased `import type`) fail to
// resolve for any test that transitively pulls in a module using it. This
// makes the existing tsconfig path alias actually work under `vitest`.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
});
