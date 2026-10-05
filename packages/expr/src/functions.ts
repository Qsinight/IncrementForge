/**
 * 内置函数表（TECH_DESIGN 5.4）。
 *
 * 表中三列（随机 / 价格上下文 / 离线）是 5.5 权限表的**投影**，不是放宽：
 * - `random` 列对应 5.5 的「随机」列；
 * - `priceAllowed` 对应 5.5 的「价格上下文」列；
 * - `offlineAllowed` 表示离线期间是否仍可用，注意它只对 `effect` 上下文构成可达路径——
 *   离线结算跳过「每秒生效」与自动购买，期间不发生任何购买，`effect` 上下文不可达（8.8），
 *   因此 `set/create/destroy` 的 `offlineAllowed: true` 属于「登记但不构成可达路径」，
 *   防止误读成“离线可随意创建/销毁条目”（5.4 读法说明）。
 *
 * 价格上下文禁用随机函数（PRD 补充 1）在**编译期**报错 `E_RAND_DISABLED`（5.4 末段）；
 * 运行期离线禁用由求值器兜底，同样抛该码并由 last-good 机制处理（5.7）。
 */
import { ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { ConstantObject, ContextKind, Value } from './ast.js'
import type { RandomSource } from './random.js'

/** 内置函数 arity。 */
export interface Arity {
  min: number
  max: number
}

/** 动态条目查询所需的宿主能力（由 `runtime` 提供，M2 接入）。 */
export interface DynamicHost {
  /** 动态条目是否存在（`has(kind, id)`）。 */
  has(kind: string, id: string): boolean
  /** 某类条目数量（`count(kind)`）。 */
  count(kind: string): Decimal
}

/** `emit` 的载荷。 */
export interface EmitPayload {
  /** `set` 的字面量路径；`destroy` 的条目 id。 */
  path?: string
  /** `set` 的值。 */
  value?: Value
  /** `create` 的 kind 参数。 */
  createKind?: string
  /** `create` 的 spec 常量（编译期已折叠）。 */
  spec?: ConstantObject
}

/** 函数调用时可用的宿主能力（由求值器注入，5.6）。 */
export interface FunctionCallContext {
  context: ContextKind
  /** 离线标记（8.8）：为真时随机函数与副作用函数按 5.4 规则禁用。 */
  offline: boolean
  /** 确定性伪随机源（8.3 第 1 步：由 tick 派生，保证同 tick 内结果一致）。 */
  random: RandomSource
  /** 动态条目查询（`has`/`count`）。 */
  dynamic: DynamicHost
  /**
   * 登记副作用（`set`/`create`/`destroy`）。副作用不在表达式内立即生效，
   * 而是在 tick 的固定提交阶段按书写顺序统一应用（5.6）。
   *
   * `expr` 是审计用的源码文本（写入 `Effect.expr`，读档不回放，6.3），
   * 由 `EffectSink` 侧填充，编译器不传。
   */
  emit: (kind: 'set' | 'create' | 'destroy', payload: EmitPayload, expr?: string) => Value
}

export interface BuiltinFunction {
  name: string
  /** 是否随机函数（价格上下文禁用、离线禁用，PRD 补充 1）。 */
  random: boolean
  /** 是否副作用函数（只允许 `effect` 上下文，5.5 副作用列）。 */
  effect: boolean
  /** 价格上下文是否允许调用（5.5「价格上下文」列）。 */
  priceAllowed: boolean
  /** 离线期间是否仍允许（见文件头「登记但不构成可达路径」）。 */
  offlineAllowed: boolean
  arity: Arity
  impl: (args: Value[], ctx: FunctionCallContext) => Value
}

/** 取数值实参；非数值报 `E_TYPE`（5.2：字符串不参与算术运算）。 */
function numericArg(args: Value[], name: string, index: number): Decimal {
  const value = args[index]
  if (typeof value !== 'object' || value === null || typeof (value as Decimal).cmp !== 'function') {
    throw new ForgeError('E_TYPE', { message: `${name} 的第 ${index + 1} 个参数需要数值` })
  }
  return value as Decimal
}

function boolArg(args: Value[], name: string, index: number): boolean {
  const value = args[index]
  if (typeof value !== 'boolean') {
    throw new ForgeError('E_TYPE', { message: `${name} 的第 ${index + 1} 个参数需要布尔值` })
  }
  return value
}

function unary(name: string, fn: (a: Decimal) => Decimal): BuiltinFunction['impl'] {
  return (args) => fn(numericArg(args, name, 0))
}

/**
 * 函数表条目工厂。
 *
 * 返回 `[name, def]` 元组，让 `new Map([...])` 拿到正确的上下文类型——直接写对象字面量
 * 会被推断成普通对象而非元组，`impl` 的形参随之退化成 `any`，arity 与参数类型就完全
 * 失去编译期检查（与 14.3「Schema ↔ 实现的编译期对齐」同一意图）。
 */
function define(name: string, def: Omit<BuiltinFunction, 'name'>): [string, BuiltinFunction] {
  return [name, { name, ...def }]
}

/** 纯算术函数的公共权限位（各上下文均可用，含离线）。 */
const PURE = { random: false, effect: false, priceAllowed: true, offlineAllowed: true } as const
/** 随机函数的公共权限位（价格上下文与离线均禁用，PRD 补充 1）。 */
const RAND = { random: true, effect: false, priceAllowed: false, offlineAllowed: false } as const
/** 副作用函数的公共权限位（仅 `effect` 上下文；离线列见文件头说明）。 */
const EFFECT = { random: false, effect: true, priceAllowed: false, offlineAllowed: true } as const

/**
 * 内置函数表（V1.0）。
 *
 * **随机函数只有三条标量函数**（5.4「随机函数集合的边界」）：语言没有列表与变量类型，
 * 除 `create()` 的 spec 外任何位置都不允许数组字面量，因此不存在“接收列表的随机取值函数”
 * ——列进表里只会制造“可写却写不出”的死接口。需要“多候选中随机取一个”时用
 * `randInt(min, max)` 映射到序号，或用 `if(randChance(p), a, b)` 表达分支。
 *
 * 所有算术函数一律经 `@iforge/num` 以获得饱和语义（4.4），表达式层不另写数值逻辑。
 */
export const BUILTIN_FUNCTIONS: ReadonlyMap<string, BuiltinFunction> = new Map([
  // ---- 基础 ----
  define('min', { ...PURE, arity: { min: 2, max: Infinity }, impl: (args) => Num.min(...args.map((_, i) => numericArg(args, 'min', i))) }),
  define('max', { ...PURE, arity: { min: 2, max: Infinity }, impl: (args) => Num.max(...args.map((_, i) => numericArg(args, 'max', i))) }),
  define('clamp', {
    ...PURE,
    arity: { min: 3, max: 3 },
    impl: (args) => Num.clamp(numericArg(args, 'clamp', 0), numericArg(args, 'clamp', 1), numericArg(args, 'clamp', 2)),
  }),
  define('lerp', {
    ...PURE,
    arity: { min: 3, max: 3 },
    impl: (args) => Num.lerp(numericArg(args, 'lerp', 0), numericArg(args, 'lerp', 1), numericArg(args, 'lerp', 2)),
  }),
  define('abs', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('abs', Num.abs) }),
  define('sign', { ...PURE, arity: { min: 1, max: 1 }, impl: (args) => Num.fromNumber(Num.sign(numericArg(args, 'sign', 0))) }),

  // ---- 取整（超安全整数退化，4.4 第 5 条 / R-02）----
  define('floor', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('floor', Num.floor) }),
  define('ceil', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('ceil', Num.ceil) }),
  define('round', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('round', Num.round) }),
  define('trunc', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('trunc', Num.trunc) }),

  // ---- 对数与指数 ----
  define('sqrt', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('sqrt', Num.sqrt) }),
  define('ln', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('ln', Num.ln) }),
  define('log10', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('log10', Num.log10) }),
  define('log', { ...PURE, arity: { min: 2, max: 2 }, impl: (args) => Num.log(numericArg(args, 'log', 0), numericArg(args, 'log', 1)) }),
  define('pow', { ...PURE, arity: { min: 2, max: 2 }, impl: (args) => Num.pow(numericArg(args, 'pow', 0), numericArg(args, 'pow', 1)) }),
  define('exp', { ...PURE, arity: { min: 1, max: 1 }, impl: unary('exp', Num.exp) }),

  // ---- 惰性分支 ----
  // 三个实参都先求值再取值（沙箱语言没有短路语法糖）；语义与 5.4 的“惰性分支”等价，
  // 差别只在于被跳过的分支若抛错会照常抛出——该限制在 5.8 的编辑器提示中注明。
  define('if', { ...PURE, arity: { min: 3, max: 3 }, impl: (args) => (boolArg(args, 'if', 0) ? args[1]! : args[2]!) }),

  // ---- 随机函数（价格上下文与离线均禁用，PRD 补充 1）----
  define('rand', { ...RAND, arity: { min: 0, max: 0 }, impl: (_args, ctx) => ctx.random.next() }),
  define('randInt', {
    ...RAND,
    arity: { min: 2, max: 2 },
    impl: (args, ctx) => {
      const min = numericArg(args, 'randInt', 0)
      const max = numericArg(args, 'randInt', 1)
      if (max.lt(min)) throw new ForgeError('E_TYPE', { message: 'randInt 要求 min <= max' })
      // 闭区间 [min, max]：floor(rand × (max − min + 1)) + min。
      const span = Num.add(Num.sub(max, min), Num.fromNumber(1))
      return Num.add(min, Num.floor(Num.mul(span, ctx.random.next())))
    },
  }),
  define('randChance', { ...RAND, arity: { min: 1, max: 1 }, impl: (args, ctx) => ctx.random.next().lt(numericArg(args, 'randChance', 0)) }),

  // ---- 副作用函数（仅 effect 上下文，5.5）----
  define('set', {
    ...EFFECT,
    arity: { min: 2, max: 2 },
    impl: (args, ctx) => {
      const path = args[0]
      if (typeof path !== 'string') {
        throw new ForgeError('E_TYPE', { message: 'set() 的第一个参数必须是字面量路径字符串' })
      }
      return ctx.emit('set', { path, value: args[1]! })
    },
  }),
  define('create', {
    ...EFFECT,
    arity: { min: 2, max: 2 },
    impl: (args, ctx) => {
      const kind = args[0]
      if (typeof kind !== 'string') throw new ForgeError('E_TYPE', { message: 'create() 的第一个参数必须是 kind 字符串' })
      const spec = args[1]
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        throw new ForgeError('E_TYPE', { message: 'create() 的 spec 必须是对象字面量' })
      }
      // 编译器已把 spec 折叠成常量对象并原样传这里（8.7），此处只做形状兜底。
      return ctx.emit('create', { createKind: kind, spec: spec as ConstantObject })
    },
  }),
  define('destroy', {
    ...EFFECT,
    arity: { min: 1, max: 1 },
    impl: (args, ctx) => {
      const id = args[0]
      if (typeof id !== 'string') throw new ForgeError('E_TYPE', { message: 'destroy() 需要条目 id 字符串' })
      return ctx.emit('destroy', { path: id })
    },
  }),

  // ---- 动态条目查询（各上下文均可用）----
  define('has', {
    ...PURE,
    arity: { min: 2, max: 2 },
    impl: (args, ctx) => {
      const kind = args[0]
      const id = args[1]
      if (typeof kind !== 'string' || typeof id !== 'string') {
        throw new ForgeError('E_TYPE', { message: 'has() 需要 kind 与 id 两个字符串' })
      }
      return ctx.dynamic.has(kind, id)
    },
  }),
  define('count', {
    ...PURE,
    arity: { min: 1, max: 1 },
    impl: (args, ctx) => {
      const kind = args[0]
      if (typeof kind !== 'string') throw new ForgeError('E_TYPE', { message: 'count() 需要 kind 字符串' })
      return ctx.dynamic.count(kind)
    },
  }),
])

/** 查函数；未知函数在编译期报 `E_UNKNOWN_IDENT`（5.2 标识符条）。 */
export function lookupFunction(name: string): BuiltinFunction | undefined {
  return BUILTIN_FUNCTIONS.get(name)
}
