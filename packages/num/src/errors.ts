/**
 * 错误码与诊断通道。
 *
 * 单一事实源：TECH_DESIGN 17.1 错误码表。本文件是该表的**可执行映射**，
 * `expr`/`model`/`runtime`/`persist`/`build` 全部从这里取码，不允许各自定义字符串字面量。
 *
 * 落点：17.1 错误码表；5.7 last-good 与诊断计数（D-07：表达式求值失败保留 last-good + 诊断，不中断 tick）；
 * 4.4 第 3 条（饱和标记可观测）。
 */

/** TECH_DESIGN 17.1 错误码全集（键即码值，值为中文提示文案方向）。 */
export const ERROR_CODES = {
  // ---- 表达式解析 / 静态检查 ----
  /** 语法错误 */
  E_PARSE: '语法错误',
  /** 嵌套超过 64 层（字面量自身嵌套超过 4 层） */
  E_PARSE_DEPTH: '表达式过于复杂',
  /** 出现禁用 token：`;`、`=>`、`import`/`await`、`__proto__`/`constructor`/`prototype` */
  E_FORBIDDEN_TOKEN: '表达式中包含不允许的语法',
  /** 对象/数组字面量出现在 `create()` 的 `spec` 之外的位置 */
  E_LITERAL_NOT_ALLOWED: '字面量仅可用于 create() 的 spec',
  /** 类型不匹配（如字符串参与算术） */
  E_TYPE: '类型不匹配，期望数值',
  /** 未知变量/函数 */
  E_UNKNOWN_IDENT: '未知的变量或函数',
  /** 引用不存在的属性（如资源的 `bought`） */
  E_UNKNOWN_ATTR: '该条目无此属性',
  /** 价格上下文或离线使用随机函数 */
  E_RAND_DISABLED: '随机函数在该场景不可用',
  /** 价格/产出/条件上下文调用 `set/create` */
  E_SIDE_EFFECT_FORBIDDEN: '该场景不允许副作用',
  /** 属性求值重入 */
  E_CYCLE: '存在循环引用',
  /** 读越界 */
  E_INDEX_OUT_OF_RANGE: '下标越界（增删行请用编辑器操作）',

  // ---- 数值饱和 ----
  /** 饱和计数（诊断级，不中断）；也覆盖 `Infinity` 字面量折算为 `NUM_MAX` 的情形 */
  E_OVERFLOW: '数值已达上限',
  /** 下溢饱和计数（诊断级，不中断） */
  E_UNDERFLOW: '数值已下溢',
  /** 数量上限 ≤ 0 */
  E_CAP_NON_POSITIVE: '上限需大于零，按 1 处理',

  // ---- 结算 ----
  /** 已达数量上限，无法购买 */
  E_CAP: '已达上限',
  /** 条目禁用 */
  E_DISABLED: '条目已禁用',
  /** 条目不可见 */
  E_HIDDEN: '条目不可见',
  /** 材料不足 */
  E_NOT_ENOUGH: '材料不足',
  /** 批量购买次数求值为非有限实数 */
  E_BUY_AMOUNT_INVALID: '批量购买次数需为有效数值',
  /** 价格非单调，降级迭代 */
  E_BATCH_MONOTONE: '价格非单调，建议使用单调价格',
  /** 升级购买条件无法走单调快路径 */
  E_BATCH_CONDITION: '建议用单调条件表达式（如 bought >= n）',

  // ---- 动态条目 ----
  /** 动态创建未指定页面 */
  E_CREATE_NO_PAGE: '必须指定页面',
  /** `create()` 的 `spec` 含未知键或运行时不接管的字段 */
  E_CREATE_FIELD_INVALID: '动态创建的字段不合法',
  /** 静态条目 `id` 不合规或跨类重名 */
  E_ID_INVALID: '条目 id 需以类型字母开头、只含字母数字下划线且长度 ≤ 32',
  /** `create()` 的 `spec.id` 非法/冲突，或读档时动态条目 id 重复 */
  E_CREATE_ID_CONFLICT: '动态条目 id 需全局唯一，可省略 id 由运行时生成',
  /** `destroy()` 试图销毁静态条目 */
  E_DESTROY_STATIC: '静态条目只能在编辑器中删除',
  /** 动态条目总数达到 2000 硬上限（D-32） */
  E_DYNAMIC_LIMIT: '动态条目已达上限',
  /** 引用的页面不存在 */
  E_PAGE_UNKNOWN: '页面不存在或条目未分配页面',

  // ---- 赋值 ----
  /** 赋值到只读属性 */
  E_READONLY_TARGET: '该属性不可被表达式修改',
  /** 赋值类型不匹配 */
  E_ASSIGN_TYPE: '类型不匹配',
  /** 点击器不可购买（PRD 生成器 11） */
  E_CLICKER_NOT_BUYABLE: '点击器不可购买，请使用“点击”按钮',

  // ---- 引用与文件 ----
  /** 同一条目被分配到多个页面 */
  E_DUPLICATE_PAGE_ENTRY: '一个条目只能属于一个页面',
  /** 引用了不存在的条目 */
  E_DANGLING_REF: '引用了已删除的条目',
  /** 存档顶层字段与 `assignments` 记录不一致 */
  E_SAVE_FIELD_CONFLICT: '已按顶层值恢复',
  /** 文件校验失败 */
  E_SCHEMA: '文件校验失败',
  /** 文件迁移失败 */
  E_MIGRATION_FAIL: '文件迁移失败',
  /** 文件版本不兼容 */
  E_VERSION: '文件版本不兼容',

  // ---- 资产与安全 ----
  /** 资产超限 */
  E_ASSET_TOO_LARGE: '资产超限，请压缩或更换',
  /** 资产被安全过滤拒绝 */
  E_ASSET_INVALID: '资产不符合安全要求',
  /** postMessage 校验失败 */
  E_MSG_INVALID: '消息校验失败',

  // ---- 离线与预算 ----
  /** 离线分段结算速率递减或非单调（D-49） */
  E_OFFLINE_APPROX: '离线为近似结算；建议把产出速率写成非递减形式',
  /** 离线结算时检测到墙钟回拨（R-20） */
  E_CLOCK_ROLLBACK: '系统时间被回拨，本次未结算离线收益；请校准系统时间后重新载入',
  /** 本 tick 求值次数超预算 */
  E_BUDGET: '本 tick 求值次数超预算，已降频',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** 错误码全集，供 `docs:check` 交叉校验 6.5 / 6.4 引用的码是否已定义。 */
export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[]

/** 诊断记录：`code` + 可选定位信息。UI 与诊断面板消费（8.8 离线提示、5.7 预览诊断角标）。 */
export interface Diagnostic {
  code: ErrorCode
  /** 出错位置，如 `generators[3].costs[0].amount` 或表达式字段路径 */
  where?: string | undefined
  /** 补充说明（不替代码本身） */
  message?: string | undefined
  /** 逻辑帧序号；M2 起由 runtime 回填 */
  tick?: number | undefined
}

/** 表达式求值抛出的错误；`where` 用于编辑器定位列区间/条目路径。 */
export class ForgeError extends Error {
  readonly code: ErrorCode
  readonly where: string | undefined
  /** 源码内的列区间（0 基，闭开区间 `[start, end)`），供 5.8 红色下划线定位。 */
  readonly span: { start: number; end: number } | undefined

  constructor(code: ErrorCode, options: { where?: string; message?: string; span?: { start: number; end: number } } = {}) {
    const message = options.message ? `${ERROR_CODES[code]}：${options.message}` : ERROR_CODES[code]
    super(message)
    this.name = 'ForgeError'
    this.code = code
    this.where = options.where
    this.span = options.span
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError
}

type Listener = (diagnostic: Diagnostic) => void

/**
 * 诊断收集器（诊断级、**不中断** tick，5.7 / D-02）。
 *
 * 计数按码聚合，UI 只展示聚合计数（预览诊断角标，7.1）；`onDiagnostic` 订阅用于需要逐条
 * 展示的场景（如离线提示条、批量购买作者提示文案，8.6/8.8）。`runtime` 未接入前由
 * `num`/`expr` 自行记录，M2 起由 runtime 回填 `tick`。
 */
class DiagnosticsCollector {
  private readonly counts = new Map<ErrorCode, number>()
  private readonly listeners = new Set<Listener>()
  /** 有界保留最近若干条明细，避免长跑游戏内存无上限增长（对齐 7.3 栈容量上限的做法）。 */
  private static readonly MAX_DETAIL = 256
  private readonly recent: Diagnostic[] = []

  record(code: ErrorCode, where?: string, message?: string): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1)
    const diagnostic: Diagnostic = { code, where, message }
    this.recent.push(diagnostic)
    if (this.recent.length > DiagnosticsCollector.MAX_DETAIL) this.recent.shift()
    for (const listener of this.listeners) listener(diagnostic)
  }

  count(code: ErrorCode): number {
    return this.counts.get(code) ?? 0
  }

  /** 按码聚合的计数快照（`Object.create(null)`，无原型污染路径，见 5.6）。 */
  countsSnapshot(): Record<string, number> {
    const out: Record<string, number> = Object.create(null) as Record<string, number>
    for (const [code, n] of this.counts) out[code] = n
    return out
  }

  total(): number {
    let sum = 0
    for (const n of this.counts.values()) sum += n
    return sum
  }

  recentDetails(): readonly Diagnostic[] {
    return this.recent
  }

  onDiagnostic(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    this.counts.clear()
    this.recent.length = 0
  }
}

export const Diagnostics = new DiagnosticsCollector()
// 注：`resetDiagnostics()` 需要同时清空 `Diagnostics` 与饱和标记（饱和标记由 WeakSet 承载，
// 无法逐个枚举），故它定义在同时依赖两者的 `num.ts`，不在本文件单独实现，避免循环依赖。
