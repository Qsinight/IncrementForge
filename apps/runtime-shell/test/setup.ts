/**
 * 测试环境初始化（TECH_DESIGN 14.1「集成：Vitest + jsdom」）。
 *
 * 三件事：
 * 1. `@testing-library/jest-dom` — DOM 断言扩展；
 * 2. `resetDiagnostics()` — `Diagnostics` 是**模块级全局**，跨用例不清会让
 *    “某错误码是否出现”的断言依赖执行顺序（先跑哪个文件决定计数）；
 * 3. `afterEach(cleanup)` — 组件树卸载，避免上一个用例的订阅影响下一个。
 */
import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

import { resetDiagnostics } from '@iforge/num'
import { resetMonotonicCache, resetViewModelCache } from '@iforge/runtime'

beforeEach(() => {
  resetDiagnostics()
  resetMonotonicCache()
  // 可负担件数的记忆化按“条目 + 自身 bought 版本 + 各价格行 deps 的版本 +
  // 各材料 amount 的版本”键，跨用例不清会让“改了材料但件数没变”的断言偶然通过。
  resetViewModelCache()
})

afterEach(() => {
  cleanup()
})
