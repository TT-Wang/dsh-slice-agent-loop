import { defineConfig, configDefaults } from 'vitest/config'

// results/ 归档的回放 oracle 里含原轮的 tests/*.spec.ts 终态——它们是数据不是测试。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'results/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/lab/**'],
      reporter: ['text', 'json-summary', 'html'],
      // First measured baseline: 86.8/79.73/87.87/90.85. Keep small, explicit
      // headroom across supported runtimes; do not silently auto-lower floors.
      thresholds: { statements: 85, branches: 78, functions: 86, lines: 90 },
    },
  },
})
