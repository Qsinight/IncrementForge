/**
 * 排序工具（TECH_DESIGN 7.5「排序/复制/删除」行、D-40、PRD 补充 5）。
 *
 * ## 三条规则（7.5）
 *
 * 1. **上移/下移（或拖拽）改 `order`，并把同类条目的 `order` 重排为 `1..N` 连续整数**，
 *    避免长期存在重复 `order`（PRD 补充 5 的稳定排序依赖无重复）。
 * 2. **页面内条目排序只改 `PageDef.entries[i].order`**，不改动条目自身的 `order`——
 *    一个条目可以有自己的全局 `order`，但它在页面里的排列位置是另一回事（6.2 注释）。
 * 3. 三者写同一字段、同一事务（编辑器负责事务边界，本模块只做纯函数计算）。
 *
 * 本模块是**纯函数**：不修改入参，返回新的数组，编辑器的 immer draft 直接 `Object.assign` 回去即可。
 */

/** 带 `order` 字段的最小结构。 */
export interface Orderable {
  order: number
}

/** 按 `order` 升序稳定排序（PRD 补充 5：稳定排序）。 */
export function sortByOrder<T extends Orderable>(items: readonly T[]): T[] {
  // `Array.prototype.sort` 在 V8 上是稳定的（ES2019 起规范要求），
  // 因此同 `order` 时保持传入顺序即等价于文档要求的稳定语义。
  return [...items].sort((a, b) => a.order - b.order)
}

/**
 * 把 `order` 重排为 `1..N` 连续整数（D-40）。
 *
 * 先按当前 `order` 稳定排序，再依次写 `1..N`。**不修改入参**。
 */
export function normalizeOrder<T extends Orderable>(items: readonly T[]): T[] {
  const sorted = sortByOrder(items)
  return sorted.map((item, index) => ({ ...item, order: index + 1 }))
}

/**
 * 上移/下移一项，并重排为 `1..N`。
 *
 * @param items 同类条目（资源 / 生成器 / 升级 / 页面各自一份）
 * @param id 目标条目 id
 * @param direction `-1` 上移、`+1` 下移
 * @returns 新数组；`id` 不存在时原样返回
 */
export function moveOrder<T extends Orderable & { id: string }>(items: readonly T[], id: string, direction: -1 | 1): T[] {
  const sorted = normalizeOrder(items)
  const index = sorted.findIndex((item) => item.id === id)
  if (index < 0) return sorted
  const target = index + direction
  if (target < 0 || target >= sorted.length) return sorted
  const next = [...sorted]
  const [moved] = next.splice(index, 1)
  if (moved) next.splice(target, 0, moved)
  return next.map((item, i) => ({ ...item, order: i + 1 }))
}

/**
 * 按给定顺序重排（拖拽落位用，7.5「排序」行的拖拽形态）。
 *
 * @param orderedIds 目标顺序的 id 序列（必须与 `items` 的 id 集合一致；多/少的 id 被忽略）
 */
export function reorderBy<T extends Orderable & { id: string }>(items: readonly T[], orderedIds: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const placed = new Set<string>()
  const out: T[] = []
  for (const id of orderedIds) {
    const item = byId.get(id)
    if (item && !placed.has(id)) {
      out.push(item)
      placed.add(id)
    }
  }
  for (const item of sortByOrder(items)) {
    if (!placed.has(item.id)) out.push(item)
  }
  return out.map((item, index) => ({ ...item, order: index + 1 }))
}

/**
 * 复制条目时的插入位置（7.5「复制」行：`order` 插入源条目之后并重排）。
 *
 * @returns 新数组，副本紧跟源条目
 */
export function insertAfter<T extends Orderable & { id: string }>(items: readonly T[], sourceId: string, clone: T): T[] {
  const sorted = normalizeOrder(items)
  const index = sorted.findIndex((item) => item.id === sourceId)
  const next = [...sorted]
  next.splice(index < 0 ? next.length : index + 1, 0, clone)
  return next.map((item, i) => ({ ...item, order: i + 1 }))
}
