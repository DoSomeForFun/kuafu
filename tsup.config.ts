import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'node20',
  external: ['better-sqlite3', 'pino', 'sqlite-vec']  // 外部依赖
});
