import { defineConfig, configDefaults } from 'vitest/config'

// results/ 归档的回放 oracle 里含原轮的 tests/*.spec.ts 终态——它们是数据不是测试。
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'results/**'] },
})
