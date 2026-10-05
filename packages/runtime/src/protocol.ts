/**
 * 预览与宿主通信协议（TECH_DESIGN 9.2、9.3、13 第 3 条、R-19、`E_MSG_INVALID`）。
 *
 * ## 协议包与校验
 *
 * 9.2 的前提是“运行时运行在不透明源 iframe 里，**不能**访问编辑器 DOM/存储”，因此
 * 两侧唯一的通道就是 `postMessage`。这带来两个必须由**本模块**统一兜住的问题（R-19）：
 *
 * - **伪造**：同页其他脚本也能往 iframe 投消息、也能从 iframe 收消息。
 * - **错序 / 串台**：上一轮预览（重建 iframe、换项目）的消息可能迟到。
 *
 * 两条防线分别是 `sessionId`（每次挂载重新生成）与 `kind` 白名单；再加上长度上限，
 * 三者任一不满足即**丢弃并计数**（记 `E_MSG_INVALID`），不抛异常、不影响编辑器。
 *
 * ## 为什么协议常量放在 `runtime` 而不是编辑器
 *
 * 9.2 是双向的：`apps/editor`（宿主）与 `apps/runtime-shell`（运行时）都要引用同一份枚举。
 * 放进 `apps/editor/src/stores/preview.ts` 的话，运行时会反向依赖编辑器应用——既违反 3.2
 * 的依赖方向，也让打包产物（ADR-05，11.1）没法引用。因此这里落在 `runtime`：
 * `runtime/index.ts` 的开篇已经声明本包承载“TECH_DESIGN 8、**9 的运行侧**、10 的序列化路径”。
 *
 * 协议本身是**纯数据 + 纯函数**，不引入任何 DOM API，`@iforge/runtime` 的“无 DOM”约束
 * （3.2）保持不变：`postMessage` 由两个 app 各自的适配器负责。
 */
import type { SaveFile, ProjectFile } from '@iforge/model'

/** 消息协议版本（9.2：所有消息 `{ v: 1, sessionId, kind, payload }`）。 */
export const PROTOCOL_VERSION = 1 as const

/** 宿主 -> 运行时（9.2 表的上四行）。 */
export const HOST_KINDS = ['host:init', 'host:patch', 'host:control', 'host:save'] as const
export type HostKind = (typeof HOST_KINDS)[number]

/** 运行时 -> 宿主（9.2 表的下五行）。 */
export const GAME_KINDS = ['game:ready', 'game:stats', 'game:event', 'game:save', 'game:error'] as const
export type GameKind = (typeof GAME_KINDS)[number]

/** 全部 `kind`（9.2 表的并集）。 */
export const MESSAGE_KINDS = [...HOST_KINDS, ...GAME_KINDS] as const
export type MessageKind = HostKind | GameKind

/** `kind` -> 合法方向（9.2 的 H→R / R→H）。 */
const DIRECTION: Readonly<Record<MessageKind, 'host' | 'game'>> = Object.freeze({
  'host:init': 'host',
  'host:patch': 'host',
  'host:control': 'host',
  'host:save': 'host',
  'game:ready': 'game',
  'game:stats': 'game',
  'game:event': 'game',
  'game:save': 'game',
  'game:error': 'game',
})

/** payload 体积上限（9.2：超大 payload 一律丢弃并计数）。 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

/** `sessionId` 的字节数（9.1：随机 16 字节）。 */
export const SESSION_ID_BYTES = 16

// ---------------------------------------------------------------------------
// 消息信封
// ---------------------------------------------------------------------------

/** 消息信封（9.2）。 */
export interface Envelope<K extends MessageKind = MessageKind, P = unknown> {
  v: typeof PROTOCOL_VERSION
  sessionId: string
  kind: K
  payload: P
}

/** 消息构造结果（`Envelope` 或校验失败的拒绝原因）。 */
export type BuildResult<K extends MessageKind, P> = { ok: true; message: Envelope<K, P> } | { ok: false; reason: RejectReason }

/** 拒绝原因（全部记 `E_MSG_INVALID`，17.1）。 */
export type RejectReason = 'version' | 'session' | 'kind' | 'direction' | 'payload-size' | 'shape'

export const REJECT_REASON_TEXT: Readonly<Record<RejectReason, string>> = Object.freeze({
  version: `协议版本不匹配（期望 v=${PROTOCOL_VERSION}）`,
  session: 'sessionId 不匹配（可能来自上一轮预览的迟到消息）',
  kind: '未知的消息 kind',
  direction: '消息方向不合法（宿主只接收 game:*，运行时只接收 host:*）',
  'payload-size': `payload 超过 ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB 上限`,
  shape: '消息结构不合法',
})

/**
 * 构造一条消息。
 *
 * 构造本身**不**校验方向（调用方是协议内的合法角色），但仍然校验 `sessionId` 非空与
 * `kind` 合法——这两者是 9.2 明确要求宿主/运行时各自把关的项，漏掉任一侧都会让
 * “未知 kind 一律丢弃”这条规则形同虚设。
 */
export function buildMessage<K extends MessageKind, P>(sessionId: string, kind: K, payload: P): BuildResult<K, P> {
  if (sessionId.length === 0) return { ok: false, reason: 'session' }
  if (!isMessageKind(kind)) return { ok: false, reason: 'kind' }
  if (payloadSize(payload) > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload-size' }
  return { ok: true, message: { v: PROTOCOL_VERSION, sessionId, kind, payload } }
}

/** `kind` 是否在枚举内。 */
export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && Object.hasOwn(DIRECTION, value)
}

/** 某 `kind` 的方向。 */
export function directionOf(kind: MessageKind): 'host' | 'game' {
  return DIRECTION[kind]
}

/**
 * 校验一条收到的消息。
 *
 * @param data `event.data` 或等价值
 * @param sessionId 期望的会话 id
 * @param expect 期望接收的方向：`'game'` = 宿主侧，`'host'` = 运行时侧
 *
 * @returns `ok: true` 时 `message` 已按 `kind` 收窄到 `Expect` 方向
 */
export function acceptMessage<Expect extends 'host' | 'game'>(
  data: unknown,
  sessionId: string,
  expect: Expect,
): { ok: true; message: Envelope } | { ok: false; reason: RejectReason } {
  if (typeof data !== 'object' || data === null) return { ok: false, reason: 'shape' }
  const raw = data as Record<string, unknown>
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: 'version' }
  if (typeof raw.sessionId !== 'string') return { ok: false, reason: 'shape' }
  if (raw.sessionId !== sessionId) return { ok: false, reason: 'session' }
  if (!isMessageKind(raw.kind)) return { ok: false, reason: 'kind' }
  if (DIRECTION[raw.kind] !== expect) return { ok: false, reason: 'direction' }
  if (payloadSize(raw.payload) > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload-size' }
  return { ok: true, message: { v: PROTOCOL_VERSION, sessionId: raw.sessionId, kind: raw.kind, payload: raw.payload } }
}

/**
 * payload 的字节数估计。
 *
 * 用 `JSON.stringify` 的长度近似即可：9.2 的上限是**防滥用**（R-19）而不是精确计费，
 * 而真正的序列化开销（`postMessage` 内部也要 `structuredClone`）与它同量级。
 */
export function payloadSize(payload: unknown): number {
  if (payload === undefined) return 0
  try {
    return JSON.stringify(payload)?.length ?? 0
  } catch {
    // 循环引用等不可序列化载荷按“超限”处理：宁可丢弃，也不让 `postMessage` 抛到调用方。
    return MAX_PAYLOAD_BYTES + 1
  }
}

/**
 * 生成会话 id（9.1：随机 16 字节）。
 *
 * 用 `crypto.getRandomValues` 而非 `Math.random()`——`Math.random()` 的输出熵不足，
 * 而 `sessionId` 是 R-19 里“伪造消息”的**唯一**屏障。
 *
 * 无 `crypto` 时（极老的宿主）退回时间戳拼接，并在这里如实降级：安全校验仍然生效
 * （只是可预测性变差），而不是抛错让预览起不来。
 */
export function newSessionId(): string {
  const bytes = new Uint8Array(SESSION_ID_BYTES)
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
    return hexOf(bytes)
  }
  let out = ''
  for (const byte of bytes) out += (byte % 16).toString(16)
  return `s${out}${Date.now().toString(36)}`
}

function hexOf(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// host:* 的 payload
// ---------------------------------------------------------------------------

/** `host:init` 的 payload（9.2）：初始化运行时。 */
export interface InitPayload {
  project: ProjectFile
  /** 已有存档则带上（预览态从 IndexedDB 读，10.1）。 */
  save?: SaveFile | null
  /** 会话覆盖（游戏内设置页产生的，8.10/D-22）；宿主也会把项目默认设置一并下发。 */
  settings?: Record<string, unknown>
  /** 编辑器主题 id（17.4），用于游戏内设置页展示。 */
  theme?: string
  locale?: string
  /** 存档位（V1.0 固定 `main`，PRD 补充 8）。 */
  slotId?: string
  projectId?: string
}

/** `host:patch` 的单个补丁（9.2：`upsert`/`remove`/`meta`/`settings`）。 */
export interface HostPatch {
  op: 'upsert' | 'remove' | 'meta' | 'settings'
  /** 目标集合：`resources`/`generators`/`upgrades`/`pages`/`meta`/`settings`。 */
  target: string
  id?: string
  data?: unknown
}

/** `host:patch` 的 payload。 */
export interface HostPatchPayload {
  patches: HostPatch[]
}

/**
 * `host:control` 的动作（9.2）。
 *
 * `device` 只改宿主侧的预览容器宽度（9.1「设备模拟」），运行时收到后仅用于把
 * `pointer: coarse` 施加到自己的根节点——它**不**参与任何结算，因此 M4 的运行时
 * 只记录不消费。
 *
 * `discard`（M5 补齐 7.1 的“唯一孤儿处置入口”）：`value` 是动态条目 id。
 * 7.1 要求诊断面板对 `E_PAGE_UNKNOWN` 的孤儿动态条目提供“丢弃”，而**孤儿卡片不渲染**
 * （6.3 读档顺序 ②、8.7），因此玩家侧唯一能触达 `destroy(id)` 的路径就是宿主：
 * 打包版没有诊断面板，那条入口不存在（卡片能渲染时卡片自己的“丢弃”按钮仍然可用）。
 */
export type HostControlAction = 'pause' | 'resume' | 'restart' | 'speed' | 'unlockAll' | 'device' | 'settings' | 'discard'

/** `host:control` 的 payload。 */
export interface HostControlPayload {
  action: HostControlAction
  value?: unknown
}

// ---------------------------------------------------------------------------
// game:* 的 payload
// ---------------------------------------------------------------------------

/** `game:ready` 的 payload（9.2/9.3 第 2 步）。 */
export interface ReadyPayload {
  engineVersion: string
  warnings: string[]
}

/**
 * 性能采样（12 性能预算末条：诊断面板显示 tick 耗时、求值次数、缓存命中率、格式化次数）。
 *
 * 三个比率/次数都由**运行侧**算好再上报：宿主只有消息，没有求值器，
 * 让编辑器自己复算就得把 `ExpressionRuntime` 再实例化一份——那正是 ADR-03 要避免的
 * “两套逻辑”。
 */
export interface PerfPayload {
  /** 本 tick 的表达式求值次数（5.7 配额上限 20000）。 */
  evaluations: number
  /** 本 tick 命中 tick 缓存的次数。 */
  cacheHits: number
  /** `cacheHits / (cacheHits + evaluations)`，`0..1`；一个都没算过时为 `0`。 */
  cacheHitRate: number
  /** 编译缓存命中率（`hits / (hits + misses)`），进程级累计。 */
  compileHitRate: number
  /** 编译缓存条目数（上限 8192）。 */
  compileCacheSize: number
  /** 进程内累计的 `format()` 调用次数。 */
  formats: number
  /** 格式化 LRU 缓存条目数（上限 4096）。 */
  formatCacheSize: number
  /** 是否本 tick 耗尽了求值预算（`E_BUDGET`，5.7）。 */
  budgetExhausted: boolean
}

/** `game:stats` 的 payload（9.2：仪表盘数据节流上报，≤10Hz）。 */
export interface StatsPayload {
  /** 各资源的数量与增长速度（8.9）。 */
  rates: { id: string; amount: string; rate: string }[]
  nextBuy?: { id: string; name: string; dt: string }
  tickMs: number
  fps: number
  /**
   * 性能采样（12 性能预算末条）。
   *
   * **可选**：旧宿主忽略它即退化为 M4 行为（与 `game:save.intent` 的可选策略一致，D-51）。
   */
  perf?: PerfPayload
  /**
   * 孤儿动态条目 id 列表（`E_PAGE_UNKNOWN`：页面已删除，7.1 末条的“丢弃”入口、8.7）。
   *
   * **可选**：旧宿主忽略即退化为 M4 行为。它们**不渲染卡片**（拿不到卡片上的“丢弃”按钮），
   * 因此这是宿主侧唯一的处置通道。
   */
  orphans?: string[]
  /**
   * 需要提示作者改写价格形状的实体键（8.6 末条）。
   *
   * **可选**：与卡片上的 `rewriteAdvice` 同源（都来自 `GameState.rewriteAdvice()`）。
   * 卡片提示只覆盖**当前页面**——作者切到别的页面就看不到自己写坏的条目，因此宿主侧
   * 的诊断面板需要这份**全局**视图（7.1 末条的诊断列表）。
   */
  advice?: string[]
}

/**
 * `game:event` 的类型（9.2）。
 *
 * `theme` 是内置设置页“页面主题”开关产生的会话偏好（8.10）：它与 `settings` 同层
 * （玩家偏好、不回写项目文件），但**不是** `ProjectSettings` 的字段，因此单列一个
 * 类型而不是塞进 `settings` 的 payload——后者会让 `settingsOverride` 长出一个
 * 项目文件里不存在的键。
 */
export type GameEventType = 'click' | 'buy' | 'nav' | 'discard' | 'settings' | 'theme'

/** `game:event` 的 payload（9.2；结算时机见 8.3.1）。 */
export interface GameEventPayload {
  type: GameEventType
  /** 条目标识（`g1`/`up.u2`/`p1`），`settings` 事件为空。 */
  target?: string
  payload?: Record<string, unknown>
}

/** `game:save` 的 payload（9.2/9.3：交由编辑器持久化，10.1）。 */
export interface GameSavePayload {
  save: SaveFile
  /**
   * 存档意图（**可选**，D-51）。
   *
   * 9.2 的 `game:save` 只有 `{ save }`，但运行时需要区分两种去向：
   * - 缺省 / `'autosave'`：**自动存档**（8.3 第 8 步、10.3）→ 宿主写入 IndexedDB；
   * - `'export'`：**玩家点了“导出存档”**（PRD 预览区 9）→ 宿主下载 `*.save.json`。
   *
   * 为什么不能靠宿主自己判断：自动存档与玩家点击对运行时来说是同一件事（“产出了一份存档”），
   * 只有运行时知道这次是不是玩家主动要求的。不加这个字段的话，宿主只能一律持久化，
   * “导出存档”按钮就永远触发不了下载——或者反过来让每次自动存档都弹下载框。
   *
   * 字段可选因此**向后兼容**：老宿主忽略它即退化为“一律持久化”，与 M4 之前的行为一致。
   */
  intent?: 'autosave' | 'export'
}

/** `game:error` 的 payload（9.2/9.3 第 3 步：诊断角标）。 */
export interface GameErrorPayload {
  code: string
  message: string
  where?: string
  tick?: number
}

/** `game:stats` 的节流间隔 ms（9.2：≤10Hz）。 */
export const STATS_THROTTLE_MS = 100
