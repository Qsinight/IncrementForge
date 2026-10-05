/**
 * 求值器：编译缓存、tick 记忆化、循环检测、last-good、求值预算（TECH_DESIGN 5.7、ADR-07）。
 *
 * - **每 tick 记忆化**：`tickCache: Map<cacheKey, value>`，同一 tick 内同表达式只算一次；
 * - **缓存键隔离覆盖层**（8.6.1 的易错点）：键必须附加覆盖层段
 *   `hash(ctx + '\u0000' + text + '\u0000' + overlayKey)`，否则同一段表达式在不同 `j` 处
 *   会命中彼此的缓存值，导致 `P(1) == P(5)` 这类静默错误；
 * - **依赖环检测**：求值节点入栈时打标，重入即抛 `E_CYCLE`，该属性取 last-good；
 * - **last-good**：任何表达式错误都不中断 tick，保留上次成功值、累加错误计数（D-07）；
 * - **配额**：单 tick 内求值次数上限 `EVAL_BUDGET_PER_TICK`，超出即停止并报 `E_BUDGET`。
 */
import { Diagnostics, ForgeError, Num, isForgeError } from '@iforge/num'
import type { ErrorCode } from '@iforge/num'
import { ERROR_CODE_LIST } from '@iforge/num'

import type { ContextKind, Value } from './ast.js'
import type { CompiledExpr, Scope } from './compiler.js'
import { compile } from './compiler.js'
import type { DynamicHost, FunctionCallContext } from './functions.js'
import { COMPILE_CACHE_LIMIT, EVAL_BUDGET_PER_TICK } from './limits.js'
import { parse } from './parser.js'
import { createRandomSource } from './random.js'

/** 求值器构造选项。 */
export interface EvaluatorOptions {
  /** 属性读取（由 `runtime` 的 `AttributeStore` 实现，5.6「变量解析」）。 */
  read: (key: string, scope?: Scope) => Value
  /** 副作用登记（通常是 `EffectSink.emit`）。 */
  emit: FunctionCallContext['emit']
  /** 动态条目查询（`has`/`count`）。 */
  dynamic?: DynamicHost
  /**
   * 回滚当前分桶（5.6「求值失败时的回滚」）。
   *
   * 求值器不直接持有 `EffectSink`，而是通过本钩子与宿主接线：某条表达式求值抛错时，
   * 该表达式**已经收集**的副作用必须整体丢弃（含其前半段子树写入的 `set`/`create`），
   * 而其它表达式的副作用不受影响。宿主的实现通常是 `sink.rollbackCurrent()`。
   */
  rollbackCurrentBucket?: () => void
}

/** 单次求值的结果：值 + 是否发生了 last-good 回退。 */
export interface EvaluationResult {
  value: Value
  /** 本次求值是否抛错并回退到上次成功值。 */
  lastGood: boolean
  /** 本次求值的错误码（若有）。 */
  code?: string
}

/**
 * 从任意抛出的值里取出错误码。
 *
 * 表达式自身抛的是 `ForgeError`；但宿主（`AttributeStore`、`create()` 的实现）
 * 抛出的错误不一定来自本包——可能只是带 `code` 字段的普通 Error。
 * 这里统一按“`code` 是已登记的错误码”来归一，避免把运行期错误一律压成 `E_TYPE`
 * 而丢掉可观测性。
 */
function extractErrorCode(error: unknown): ErrorCode {
  if (isForgeError(error)) return error.code
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && (ERROR_CODE_LIST as string[]).includes(code)) return code as ErrorCode
  return 'E_TYPE'
}

/**
 * 求值器。
 *
 * 一个 `Evaluator` 对应一个运行时上下文（`field`/`price`/`production`/`condition`/`effect`）。
 * M2 起 `runtime` 按字段持有 5 个实例；共享的编译缓存由静态表提供。
 */
export class Evaluator {
  private readonly tickCache = new Map<string, { value: Value; versionKey: string }>()
  /** last-good：属性键 -> 上次成功值（5.7）。 */
  private readonly lastGoodValues = new Map<string, Value>()
  /** 循环检测栈：正在求值的属性键（5.7「依赖环检测」）。 */
  private readonly evaluating = new Set<string>()
  private tickCount = 0
  /** 本 tick 命中 tick 缓存的次数（12 性能预算「缓存命中率」）。 */
  private tickCacheHits = 0
  private tick: number
  private budgetExhausted = false

  constructor(
    readonly context: ContextKind,
    private readonly options: EvaluatorOptions,
    tick = 0,
  ) {
    this.tick = tick
  }

  /** 每 tick 归零缓存与配额（8.3 第 1 步）。 */
  beginTick(tick: number): void {
    this.tick = tick
    this.tickCache.clear()
    this.tickCount = 0
    this.tickCacheHits = 0
    this.budgetExhausted = false
  }

  /**
   * 丢弃本 tick 已缓存的全部求值结果（写入后调用）。
   *
   * 缓存只在“**这一 tick 内没有任何写入**”的前提下成立。写入一旦发生，
   * 之前缓存的表达式值就是**过期**的，而且过期是静默的：
   * 自动购买阶段写完 `bought` 之后，同一 tick 内升级条件 `gen.g1.bought >= n`
   * 仍会读到买入前的结果，于是“买了就满足条件”这类逻辑看起来随机失效。
   *
   * 所以失效必须挂在**写入**上（`AttributeStore.bump` 是所有写路径的唯一收口），
   * 而不是只靠 tick 边界。选择“整体清空”而不是按 `versionOf` 做细粒度判定：
   * 后者要求缓存键携带每个被读属性的版本，代价与收益不成比例——写入本来就稀疏，
   * 而“写入后重算”正是缓存该有的行为。
   */
  invalidateCache(): void {
    this.tickCache.clear()
  }

  /**
   * 求值（带编译缓存）。
   *
   * @param text 表达式源码
   * @param scope 求值作用域；`effValue` / `effValueAssigned` 在求值后会被回写（8.7 写回登记）
   * @param overlayKey 只读等级视图的覆盖层标识（8.6.1）；空串表示无覆盖层
   */
  evaluate(text: string, scope: Partial<Scope> = {}, overlayKey = ''): EvaluationResult {
    const compiled = this.compile(text)
    const cacheKey = overlayKey.length === 0 ? compiled.hash : `${compiled.hash}\u0000${overlayKey}`
    // `effect` 上下文**不走 tick 缓存**。
    //
    // 理由是赋值表达式有副作用，且副作用必须每次求值都重新登记一次：
    // - `res.r1.amount = …` / `set(...)` / `create(...)` 要把效果挂进当前分桶（5.6）；
    // - `effValue = …` 要经 `scope.effValueAssigned` 回写（8.7），而求值发生在内部作用域上。
    //
    // 命中缓存会直接 `return`，两者都不发生。表现最直观的是“每秒自增”效果
    // `effValue = effValue + 1`：第一次算完缓存了结果，之后每次都是缓存命中 ->
    // `effValueAssigned` 缺失 -> 写回不登记 -> `effectValues[0]` 永远停在初值。
    //
    // 缓存的目的是省掉同 tick 内**重复的纯求值**，对有副作用的表达式本来就不适用。
    const cacheable = this.context !== 'effect'
    const cached = cacheable ? this.tickCache.get(cacheKey) : undefined
    if (cached) {
      this.tickCacheHits += 1
      return { value: cached.value, lastGood: false }
    }

    if (this.tickCount >= EVAL_BUDGET_PER_TICK) {
      this.budgetExhausted = true
      Diagnostics.record('E_BUDGET', text)
      // 超预算时停止求值并报 E_BUDGET（5.7 配额）；返回值沿用 last-good（无则 0）。
      return { value: this.lastGoodValues.get(cacheKey) ?? ZERO, lastGood: true, code: 'E_BUDGET' }
    }
    this.tickCount += 1

    let threw = false
    try {
      // `scope.read` 可覆盖默认读取：8.6.1 的只读等级视图正是靠它在**不修改存储**的前提下
      // 把 `bought` 的读取值覆盖为 `j`。无论用哪个 read，都仍要过循环检测（5.7）。
      const baseRead = scope.read ?? ((key: string) => this.options.read(key))
      const fullScope: Scope = {
        read: (key: string) => this.readGuarded(key, baseRead),
        ...(scope.effValue !== undefined ? { effValue: scope.effValue } : {}),
        call: this.makeCallContext(scope),
      }
      const value = compiled.fn(fullScope)
      // 把 `effValue` 与赋值标记回写给调用方：求值发生在内部作用域上，
      // 但 8.7 的 `commitEffValue(scope.effValue)` 由调用方（升级效果结算）发起，
      // 必须能看到本次求值的结果。
      if (fullScope.effValue !== undefined) scope.effValue = fullScope.effValue
      if (fullScope.effValueAssigned !== undefined) scope.effValueAssigned = fullScope.effValueAssigned
      if (cacheable) this.tickCache.set(cacheKey, { value, versionKey: cacheKey })
      this.lastGoodValues.set(cacheKey, value)
      return { value, lastGood: false }
    } catch (error) {
      threw = true
      const code = extractErrorCode(error)
      const where = isForgeError(error) ? error.where : undefined
      Diagnostics.record(code, where, text.slice(0, 120))
      // D-07：保留 last-good + 诊断，不中断 tick。
      const fallback = this.lastGoodValues.get(cacheKey)
      if (fallback !== undefined) {
        this.tickCache.set(cacheKey, { value: fallback, versionKey: cacheKey })
        return { value: fallback, lastGood: true, code }
      }
      // 无 last-good 时按类型给中性值，保证结算继续（诊断面板会显示错误数）。
      return { value: compiled.type === 'boolean' ? false : compiled.type === 'string' ? '' : ZERO, lastGood: true, code }
    } finally {
      // 5.6：求值失败时丢弃该表达式本次已收集的全部副作用（“要么整体生效、要么完全不生效”），
      // 连带 `effValue` 写回（8.7「同生共死」）。成功时不触碰队列——
      // 副作用一律等到固定提交阶段按书写顺序统一应用（8.3 第 6 步）。
      if (threw) this.options.rollbackCurrentBucket?.()
    }
  }

  /** 编译并缓存（5.6：缓存键 `contextKind + '\u0000' + text`，上限 8192）。 */
  compile(text: string): CompiledExpr {
    const cached = COMPILE_CACHE.get(this.context, text)
    if (cached) return cached
    const ast = parse(text)
    const compiled = compile(ast, text, this.context)
    COMPILE_CACHE.set(this.context, text, compiled)
    return compiled
  }

  /**
   * 属性读取（带循环检测，5.7）。
   *
   * 重入即 `E_CYCLE`：表达式 A 读属性 X，X 的派生计算又读表达式 A 的属性，形成闭环。
   * 诊断面板按访问路径展示，这里把当前栈拼进 `where` 便于定位。
   */
  private readGuarded(key: string, baseRead: (key: string) => Value): Value {
    if (this.evaluating.has(key)) {
      throw new ForgeError('E_CYCLE', {
        where: `依赖环：${[...this.evaluating, key].join(' -> ')}`,
        message: '属性求值重入，存在循环引用',
      })
    }
    this.evaluating.add(key)
    try {
      return baseRead(key)
    } finally {
      this.evaluating.delete(key)
    }
  }

  private makeCallContext(scope: Partial<Scope>): FunctionCallContext {
    return (
      scope.call ?? {
        context: this.context,
        offline: false,
        random: createRandomSource(this.tick),
        dynamic: this.options.dynamic ?? defaultDynamicHost,
        emit: this.options.emit,
      }
    )
  }

  /** 本 tick 求值次数（诊断面板展示）。 */
  evaluations(): number {
    return this.tickCount
  }

  /** 本 tick 命中 tick 缓存的次数（12 性能预算「缓存命中率」）。 */
  cacheHits(): number {
    return this.tickCacheHits
  }

  /** 本 tick 是否已耗尽预算。 */
  isBudgetExhausted(): boolean {
    return this.budgetExhausted
  }
}

const ZERO = Num.fromNumber(0)

const defaultDynamicHost: DynamicHost = {
  has: () => false,
  count: () => ZERO,
}

/**
 * 跨上下文共享的编译缓存（5.6）。
 *
 * 键是 `contextKind + '\u0000' + text`——同一段文本在不同上下文的静态检查结果不同
 * （`set()` 在 `effect` 合法、在 `price` 报 `E_SIDE_EFFECT_FORBIDDEN`），故上下文必须进键。
 */
class CompileCache {
  private readonly cache = new Map<string, CompiledExpr>()
  /** 命中次数（12 性能预算「表达式编译 < 1ms/条，缓存命中 ~0」）。 */
  private hits = 0
  /** 未命中（即真正编译）次数。 */
  private misses = 0

  get(context: ContextKind, text: string): CompiledExpr | undefined {
    const found = this.cache.get(`${context}\u0000${text}`)
    if (found !== undefined) this.hits += 1
    else this.misses += 1
    return found
  }

  set(context: ContextKind, text: string, compiled: CompiledExpr): void {
    if (this.cache.size >= COMPILE_CACHE_LIMIT) {
      // 超上限时整体丢弃最旧的一半：Map 的插入序即写入序，保留后半段以偏向近期文本。
      const keys = [...this.cache.keys()]
      for (const key of keys.slice(0, Math.floor(COMPILE_CACHE_LIMIT / 2))) this.cache.delete(key)
    }
    this.cache.set(`${context}\u0000${text}`, compiled)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  /** 命中率快照（`clear()` **不清零**计数：命中率要看整段会话，跨 tick 才有意义）。 */
  stats(): CompileCacheStats {
    const total = this.hits + this.misses
    return { hits: this.hits, misses: this.misses, size: this.cache.size, hitRate: total === 0 ? 0 : this.hits / total }
  }
}

/** 编译缓存性能快照（12 性能预算）。 */
export interface CompileCacheStats {
  hits: number
  misses: number
  size: number
  /** `hits / (hits + misses)`，从未查过则为 `0`。 */
  hitRate: number
}

/** 全局编译缓存（编辑器与运行时共享，避免同一表达式重复编译）。 */
export const COMPILE_CACHE = new CompileCache()

/** 编译缓存性能快照（12 性能预算「编译缓存（8192）+ 常量折叠」的可观测口径）。 */
export function compileCacheStats(): CompileCacheStats {
  return COMPILE_CACHE.stats()
}

/** 清空编译缓存（“重新开始”与测试使用）。 */
export function resetCompileCache(): void {
  COMPILE_CACHE.clear()
}

/**
 * 只读等级视图（8.6.1）——批量求解要回答“第 `j` 级”的价格/条件，
 * 而表达式里写的是当前属性路径（`gen.g1.bought`）。
 *
 * 做法是在作用域中**覆盖读取值**，**绝不修改 `AttributeStore`**：
 * - 不递增属性 `version`、不触发脏标记与下游失效、不写 `assignments`——否则一次批量求解
 *   会污染存档，并把整批结果记成“最后一次赋值”；
 * - `price`/`condition` 上下文本就禁止副作用（编译期 `E_SIDE_EFFECT_FORBIDDEN`），
 *   覆盖层内不存在对 `bought` 的写入路径。
 *
 * 记忆化隔离：`key()` 的返回值必须作为 `evaluate()` 的 `overlayKey` 传入，
 * 否则同一段表达式在不同 `j` 处会命中彼此的缓存值（`P(1) == P(5)` 的静默错误）。
 *
 * ```ts
 * // 批量求解器内部
 * const read = levelOverlayReader(storeRead, 'gen.g1.bought', Num.fromNumber(j))
 * const price = evaluator.evaluate('10 * 1.15 ^ gen.g1.bought', { read }, levelOverlayKey('gen.g1.bought', j))
 * ```
 */
export function levelOverlayReader(baseRead: (key: string) => Value, targetKey: string, level: Value): (key: string) => Value {
  return (key: string) => (key === targetKey ? level : baseRead(key))
}

/** 覆盖层的记忆化隔离键（8.6.1：缓存键必须附加覆盖层段）。 */
export function levelOverlayKey(targetKey: string, level: Value): string {
  return `${targetKey}=${typeof level === 'string' || typeof level === 'boolean' ? String(level) : level.toString()}`
}
