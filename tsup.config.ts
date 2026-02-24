import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,  // 暂时禁用 DTS 生成，修复 TypeScript 缓存问题
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'node20',
  external: ['better-sqlite3', 'pino', 'sqlite-vec']
});
