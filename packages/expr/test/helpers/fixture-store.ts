/**
 * 测试夹具：一个最小但真实的属性存储。
 *
 * M1 交付的是编译期与求值期语义，`AttributeStore` 的真实实现属 `@iforge/runtime`（M2）。
 * 本夹具按 5.6 的 `Scope.read` 契约实现一个**只读**属性表，用来验证：
 * - 路径解析与 `deps` 收集是否正确（5.3/5.6）；
 * - 各上下文权限是否按 5.5 生效；
 * - last-good、循环检测、求值预算是否按 5.7 生效。
 *
 * 关键设计：属性值可以存**字符串**（与 `NumExpr` 字段一致，6.2），未显式设置的数值型
 * `NumExpr` 字段回落为 `'0'`。这样 `gen.g1.produces[0].amount` 这类“表达式文本属性”
 * 能被真正读取，而不是被硬编码成数字。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { ContextKind, Value } from '../../src/ast.js'

export interface FixtureOptions {
  /** 上下文（决定 `NumExpr` 字段的求值上下文与权限）。 */
  context?: ContextKind
  /** 初始属性表：键为 `res.r1.amount` 这类规范路径。 */
  entries?: Record<string, Value>
  /** 覆盖某个 `read` 的实现（用于构造依赖环等异常场景；返回 `undefined` 表示不覆盖）。 */
  readOverride?: (key: string) => Value | undefined
}

/** 测试用属性存储。 */
export class FixtureStore {
  readonly entries: Map<string, Value>
  /** 覆盖某个 `read` 的实现（返回 `undefined` 表示不覆盖）。 */
  private readonly readOverride: FixtureOptions['readOverride']
  /** 记录读取顺序，供断言“同一 tick 内记忆化只读一次”。 */
  readonly reads: string[] = []

  // 字段声明必须放在构造函数**之前**：本工程开启了 `useDefineForClassFields`，
  // 字段按声明顺序在构造体执行前完成定义，写在构造函数之后虽能通过类型检查，
  // 但初始化顺序不再直观，容易在后续改动中踩到“构造函数赋值被字段定义覆盖”的坑。
  constructor(options: FixtureOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.readOverride = options.readOverride
  }

  set(key: string, value: Value): void {
    this.entries.set(key, value)
  }

  /** 读取属性。 */
  read = (key: string): Value => {
    this.reads.push(key)
    const overridden = this.readOverride?.(key)
    if (overridden !== undefined) return overridden

    const direct = this.entries.get(key)
    if (direct !== undefined) return direct

    // 数值型 NumExpr 字段：条目缺省时返回文本 `'0'`，等价于“开局为 0”。
    if (NUMERIC_TEXT_FIELDS.has(key)) return DEFAULT_NUM_TEXT
    if (key === 'tick') return Num.fromNumber(0)
    if (key === 'time') return Num.fromNumber(0)
    if (key === 'dt') return Num.fromNumber(0.05)
    if (key === 'elapsed') return Num.fromNumber(0)
    if (key === 'offline' || key === 'started') return false
    if (key === 'Infinity') return Num.fromValue('Infinity')

    throw Object.assign(new Error(`E_UNKNOWN_ATTR: ${key}`), { code: 'E_UNKNOWN_ATTR' })
  }
}

/**
 * 数值型 `NumExpr` 字段的**模板键**（5.9.1）。
 *
 * 下标一律写成 `[i]`：查表用的是模板形式（`properties.ts` 的 `templateKey` 会把
 * 具体下标 `costs[0]` 归一成 `costs[i]`），这里必须与之一致，否则读不到。
 */
export const NUMERIC_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'initial',
  'max',
  'buyAmount',
  'amount',
  'bought',
  'owned',
  'perSec',
  'buyDelay',
  'effectValues[i]',
  'conditions[i]',
  'effects[i].condition',
  'effects[i].action',
  'costs[i].materialId',
  'costs[i].amount',
  'produces[i].materialId',
  'produces[i].amount',
])

const DEFAULT_NUM_TEXT = '0'

/** 断言用：把求值结果转成可比较的字符串（数值取十进制文本，保留大数精度）。 */
export function valueToString(value: Value): string {
  if (typeof value === 'boolean' || typeof value === 'string') return String(value)
  if (typeof value === 'object' && value !== null && 'cmp' in value) return (value as Decimal).toString()
  return JSON.stringify(value)
}

/** 断言用：数值结果转 number（仅用于小数量级的断言）。 */
export function valueToNumber(value: Value): number {
  return (value as Decimal).toNumber()
}
