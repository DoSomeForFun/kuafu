import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'store': 'src/store.ts',
    'kernel': 'src/kernel/index.ts',
    'action': 'src/action.ts',
    'telemetry': 'src/telemetry.ts',
  },
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'node20',
  external: ['better-sqlite3', 'pino', 'sqlite-vec'],
});
