/**
 * 游戏视图模型（TECH_DESIGN 8.9 仪表盘、8.10 游戏内设置页、8.11 卡片字段、8.12 页面导航、8.8 离线提示条）。
 *
 * ## 为什么视图模型是**运行时包**的一部分而不是 React 组件
 *
 * 17.5 的 M4 交付标准是“**预览与运行时数据一致（自动化断言）**”。这句话需要一个可断言的
 * 中间层：如果一致性只能靠“渲染出来的 DOM 与某个快照比对”，一旦视图层自己算了一套
 * 展示逻辑（比如自己判断禁用、自己格式化），断言就退化成“视图和视图一致”，失去意义。
 *
 * 因此本模块是**唯一**的展示逻辑来源：
 *
 * - 它把 `GameState` 的生效值（经 8.4 的判定过滤）派生成一份**可序列化**的结构；
 * - 所有价格/产量/条件/效果文本在这里就按 4.5 的 `numberFormat` **格式化完毕**；
 * - React 视图只做“把这个结构画出来”，不做任何二次计算（8.11 末条“不在 UI 层另算一套逻辑”）。
 *
 * 这样三条断言都成立且互不重复：
 * 1. `buildViewModel()` 的字段 = 运行时生效值（单测直接比 `GameState`）；
 * 2. DOM 的文本与 `data-*` = `buildViewModel()` 的字段（组件测试）；
 * 3. iframe 内外两侧渲染的是**同一份** `buildViewModel()`（“一致”由架构保证，见 `GameController`）。
 *
 * ## 卡片字段与 PRD 的逐条对应（8.11）
 *
 * | 卡片 | PRD 预览区 | 本模块字段 |
 * | --- | --- | --- |
 * | `ResourceCard` | 3：图标｜名称｜描述｜右侧数量 | `icon`/`name`/`description`/`amount` |
 * | `ClickerCard` | 4：+ 产量 + “点击”按钮 | `output`（`outputUnit: 'click'`）+ `canClick` |
 * | `GeneratorCard` | 5：+ 价格｜产量｜右侧已购买/拥有 + “购买” | `costs`/`output`（`outputUnit: 'second'`）/`bought`/`owned` |
 * | `UpgradeCard` | 6：+ 条件｜效果 + 动态条目的“丢弃” | `conditions`/`effects`/`canDiscard` |
 *
 * 页面描述（PRD 预览区 7）与底部导航（PRD 预览区 8）分别由 `page.description` 与
 * `nav` 承载；导航的**当前页**唯一由 `GameState.currentPageId` 决定（8.12、`docs:check` 规则 5）。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { parse, staticCheck } from '@iforge/expr'
import type { GeneratorDef, NumberFormat, PageDef, ProjectSettings, ThemeRef } from '@iforge/model'

import type { EntryState } from './attribute-store.js'
import { conditionsOf, costsOf, effectsOf, entityKeyOf } from './attribute-store.js'
import { affordableInCountMode } from './batch.js'
import type { CountAffordability } from './batch.js'
import type { DashboardSnapshot } from './dashboard.js'
import { collectDashboard } from './dashboard.js'
import { GameState, SETTINGS_PAGE_ID } from './game-state.js'
import type { OfflineReport } from './offline.js'
import type { PerfPayload } from './protocol.js'
import { evaluateCostAt, modeOf, priceRowsUsable } from './purchase.js'
import type { BuyMode } from './purchase.js'

export type { BuyMode }

/**
 * 价格行不可用时给作者的原因文案（`priceRowsUsable` 为假的唯一出口）。
 *
 * 必须与 `purchase.ts` 的**拒绝**同义：卡片上写“不可购买”、运行时就真的要拒。
 * 早先这里只按 `judge.canBuy` 画按钮，于是悬空/空 `materialId` 表现为
 * “没有价格行 + 按钮可点”，作者看到的是一个**能白嫖且不产出**的生成器。
 */
export const BROKEN_PRICE_REASON = '购买材料或价格无效（E_DANGLING_REF）：请检查价格行的材料引用与价格表达式'

/**
 * 不可购买的原因：材料不足（`count`/`max` 模式下一件也买不起）。
 *
 * 与 `judge.canBuy` 的结构性判定分开：那条回答“这条**有没有**购买路径”，
 * 这条回答“路径在不在但材料不够”。两者都要落到按钮上，否则玩家的体感是
 * “按钮亮着、点下去什么都没发生”。
 */
export const NOT_ENOUGH_MATERIAL_REASON = '材料不足（当前一件也买不起）'

/** 产量单位：生成器是“每秒”，点击器是“每次点击”（8.11 的卡片字段口径不同）。 */
export type OutputUnit = 'second' | 'click'

/** 一条购买价格（已格式化）。 */
export interface CostView {
  /** 材料资源 id（稳定 key）。 */
  materialId: string
  materialName: string
  /** 数量文本（已按 `numberFormat` 格式化）。 */
  amount: string
  /** 该条目有价格行求值失败（last-good 兜底，8.5/5.7）；UI 标注为估算。 */
  failed: boolean
}

/** 一条升级效果（PRD 升级编辑器 12：效果前提 / 效果内容 / 效果数值）。 */
export interface EffectView {
  /** 效果前提的**当前文本**（可被热替换，5.9.3）。 */
  condition: string
  /** 效果内容的**当前文本**。 */
  action: string
  /** 效果数值的当前值（持久化，默认 0）。 */
  value: string
}

/** 卡片视图（四类共用一个结构，按 `kind` 决定渲染哪些字段）。 */
export interface CardView {
  /** 实体键（`res.r1`/`gen.g1`/`up.u1`），稳定 key。 */
  key: string
  kind: 'resource' | 'clicker' | 'generator' | 'upgrade'
  id: string
  name: string
  description: string
  /** 图标引用：`builtin:<id>` 或 `asset:<data url>`（6.1、10.1 资产解析链路）。 */
  icon: string
  /** 动态条目（8.7）：右上角渲染“丢弃”按钮。 */
  dynamic: boolean
  /** 有效禁用（8.4 的 `isDisabled`）：置灰并隐藏按钮，**不是**不渲染。 */
  disabled: boolean
  /** 已达数量上限（PRD 补充 3）。 */
  capped: boolean

  // ---- 资源（PRD 预览区 3）----
  /** 资源当前数量。 */
  amount?: string

  // ---- 生成器 / 点击器（PRD 预览区 4/5）----
  /** 产量文本（`owned × Σ produces`，D-30 单件口径，`owned` 只乘一次）。 */
  output?: string
  outputUnit?: OutputUnit
  /** `produces` 为空（UI 显示“无产出”）。 */
  noOutput?: boolean

  // ---- 生成器 / 升级（PRD 预览区 5/6）----
  costs?: CostView[]
  bought?: string
  owned?: string
  /** 购买模式（8.6 三态）。 */
  buyMode?: BuyMode
  /**
   * `count` 模式下**当前买得起**的件数（已按 5.9.3 的 ③④ 归一化，且受材料约束）。
   *
   * 这是按钮上显示的件数，而不是 `buyAmount`：按钮写 10 而点下去只买到 1 件，
   * 等于卡片在骗玩家。`max`/`free` 模式为 `0`（它们的件数事先不可知）。
   */
  buyCount?: number
  /**
   * 作者配置的批量购买件数（`count` 模式；其余为 `0`）。
   *
   * 与 `buyCount` 分开是为了让“本该买 10 件、现在只够 3 件”这件事**看得见**：
   * 按钮与悬浮提示都靠这两个数的差异说明原因（8.11 的卡片字段 + 8.6 的三态）。
   */
  buyRequest?: number
  canBuy?: boolean
  /** 不可购买的原因（悬浮提示；`undefined` = 可购买）。 */
  buyBlockReason?: string
  /**
   * 求解仍在**跨 tick 分摊**（8.6 的 C 分支、D-48）：卡片显示“计算中…”。
   *
   * 只由“本次求解被单 tick 求值预算截断”触发（`BatchResult.truncated`），
   * **不是**“走了迭代路径”——见 `GameState.pendingSolves` 的两条规则对照。
   */
  calculating?: boolean
  /**
   * 连续 ≥60 tick 走降级路径（8.6 末条的作者提示）。
   *
   * 卡片据此追加固定提示文案“价格形状无法闭式求解，已按 tick 分摊；建议改写为等比或
   * 指数+线性形式”。PRD 没规定这条提示，但没有它作者只会看到长期“计算中…”而不知成因。
   */
  rewriteAdvice?: boolean
  canDiscard?: boolean

  // ---- 升级（PRD 预览区 6）----
  conditions?: { text: string; true: boolean }[]
  effects?: EffectView[]

  // ---- 点击器（PRD 预览区 4）----
  canClick?: boolean
}

/** 仪表盘视图（8.9）。 */
export interface DashboardView {
  resources: { id: string; name: string; amount: string; rate: string }[]
  /** 下一个可购买条目的预测时间（秒，已格式化）。 */
  nextBuy?: { id: string; name: string; dt: string }
  /** 无候选时的原因（悬浮提示；8.9 的 `—` 分支）。 */
  nextBuyHint?: string
}

/** 底部导航项（PRD 预览区 8）。 */
export interface NavItemView {
  id: string
  name: string
  icon: string
  current: boolean
  /** 内置设置页（哨兵 `__settings__`，8.12）：不是 `PageDef`，固定排在最后。 */
  builtIn: boolean
}

/** 页面视图（8.11 的 `PageView`）。 */
export interface PageView {
  id: string
  name: string
  /** PRD 预览区 7：页面描述。 */
  description: string
  /** 实际列数 = `min(page.columns, 设备断点列数)`（D-41、9.1）。 */
  columns: number
  /** 页面主题引用（17.4）。 */
  theme: string
  /** 条目主题引用（缺省跟随页面主题，M3 的取舍）。 */
  entryTheme: string
  entries: CardView[]
}

/** 游戏内设置页的一行设置（8.10）。 */
export interface SettingsFieldView {
  key: string
  label: string
  kind: 'number' | 'boolean' | 'select'
  /** `'select'` 的可选项。 */
  options?: { value: string; label: string }[]
  /** 当前输入值（字符串形态）。 */
  value: string
  /** 有效值 = 项目默认 ⊕ 会话覆盖（D-22）。 */
  effective: string
  /** 已被本会话覆盖：徽标显示“本会话覆盖”并高亮（R-24 的**强制** UI 元素）。 */
  overridden: boolean
  /** 项目默认值（徽标“项目默认”的内容）。 */
  projectDefault: string
}

/**
 * “页面主题”开关的取值（`THEME_FOLLOW_PAGE` = 不覆盖，跟随作者设定）。
 *
 * 用**空串**而不是 `undefined` 表示“跟随”，是因为这个值要原样进 `<select>` 的
 * `value`：选项里必须有一项能选回“跟随页面”，而 `<option value="">` 是唯一
 * 不需要额外哨兵就能表达它的写法。
 */
export const THEME_FOLLOW_PAGE = ''

/**
 * 内置设置页的“页面主题”开关（8.10，与 `settings` 同属玩家偏好层）。
 *
 * 徽标口径与 `SettingsFieldView.overridden` 一致（R-24 的同款防线）：
 * 改它**只**影响本次游玩/预览的观感，不回写作者的页面主题。
 */
export interface PageThemeView {
  /** 当前生效值（`themeKeyOf` 形态；`THEME_FOLLOW_PAGE` 表示跟随页面）。 */
  value: string
  /** 作者设定的当前页面主题（覆盖时作为“项目默认”展示）。 */
  projectTheme: string
  /** 是否已被本会话覆盖（决定来源徽标）。 */
  overridden: boolean
}

/** 游戏内设置页视图（8.10）。 */
export interface SettingsPageView {
  projectName: string
  author: string
  description: string
  gameTime: string
  offlineTime: string
  playtime: string
  savedAt: string
  settings: SettingsFieldView[]
  /** “页面主题”开关（`THEME_FOLLOW_PAGE` = 跟随页面）。 */
  theme: PageThemeView
  dynamicCount: number
  dynamicLimit: number
}

/** 离线收益提示条（8.8 末条、8.10）。 */
export interface OfflineNoticeView {
  /** 真实离线时长。 */
  rawSeconds: string
  /** 实际结算时长（`offlineCap` 截断后）。 */
  settledSeconds: string
  gains: { id: string; name: string; gained: string }[]
  truncated: boolean
  /** 近似结算且误差方向可能为正（D-49）。 */
  approximate: boolean
  /** 墙钟回拨，本次未结算（R-20）。 */
  clockRollback: boolean
  /** 因段数/步数预算而顺延剩余时间（8.8 约束 ①）。 */
  deferred: boolean
}

/** 视图上下文（不属于 `GameState`，由宿主/控制器提供）。 */
export interface ViewModelContext {
  offline?: OfflineReport | null
  /**
   * 批量求解仍在**跨 tick 分摊**的实体键集合（8.6 的 C 分支）。
   *
   * 由 `GameState.pendingSolves()` 提供——它是活的：每次求解结果都会更新，
   * 因此不会像早期实现那样“置真之后再没人清”，按钮永远停在“计算中…”。
   */
  calculating?: ReadonlySet<string>
  /** 需要提示作者改写价格形状的实体键集合（8.6 末条）。 */
  rewriteAdvice?: ReadonlySet<string>
  /** 设备断点给出的最大列数（D-41：`auto` 由宿主按容器宽度算出）。 */
  maxColumns?: number
  /** 上次存档的墙钟 ms（8.10 的只读信息）。 */
  savedAt?: number | null
  tickMs?: number
  fps?: number
  /**
   * 会话级页面主题覆盖（内置设置页的“页面主题”开关，8.10）。
   *
   * 形如 `builtin:page-light`（`themeKeyOf` 形态）；`undefined` 或
   * `THEME_FOLLOW_PAGE` = 不覆盖。**不是** `PageDef.theme`——它属于玩家偏好层，
   * 不进项目文件、不进存档（同 D-22 的分层）。
   */
  themeOverride?: string
  /** 性能采样（12 性能预算末条）。 */
  perf?: PerfPayload | null
  /** 已结算的离线秒数（存档字段 `offlineAccum`）。 */
  offlineAccum?: number
}

/** 完整视图模型。 */
export interface GameViewModel {
  /** 顶部标题栏（PRD 预览区 1）。 */
  title: string
  dashboard: DashboardView
  /**
   * **壳层与页面共同生效**的页面主题（`themeKeyOf` 形态）。
   *
   * 为什么单独有这个字段而不是让视图去读 `page.theme`：
   *
   * - 停在内置设置页时 `page` 为 `null`，而设置页是壳层的一部分、必须与游戏同色；
   *   视图若在缺省路径上回落 `DEFAULT_THEME.page`（`page-dark`），作者就会看到
   *   “点进设置、整屏跳成暗色”（与页面主题不匹配）。
   * - 玩家的“页面主题”偏好要覆盖**整个壳层**，而不仅仅是当前页面。
   *
   * 因此这里给出唯一权威答案：`覆盖值 ⊕ 作者设定的当前页面主题`，
   * 停在内置设置页时“当前页面”取 8.12 的初始页面。
   */
  pageTheme: string
  /** 当前页面；停在内置设置页时为 `null`。 */
  page: PageView | null
  /** 是否停在内置设置页（8.12 的哨兵 `__settings__`）。 */
  onSettings: boolean
  nav: NavItemView[]
  settings: SettingsPageView
  offline: OfflineNoticeView | null
  tickMs: number
  fps: number
  /**
   * 性能采样（12 性能预算末条）。
   *
   * 由 `GameState.perfSnapshot()` 经 `ViewModelContext.perf` 注入——视图**不自己**去数
   * 求值次数（那需要跨包再实例化一份求值器，违背 ADR-03）。
   */
  perf: PerfPayload | null
}

/** 设置项元信息（PRD 预览区 9 的六项）。顺序即 UI 顺序。 */
export const SETTING_FIELDS: readonly {
  key: keyof ProjectSettings
  label: string
  kind: SettingsFieldView['kind']
  options?: readonly { value: string; label: string }[]
}[] = [
  {
    key: 'numberFormat',
    label: '数字显示格式',
    kind: 'select',
    options: [
      { value: 'standard', label: '标准' },
      { value: 'scientific', label: '科学计数' },
      { value: 'engineering', label: '工程计数' },
      { value: 'letters', label: '字母计数' },
      { value: 'layered', label: '分层指数' },
    ],
  },
  { key: 'tickRate', label: '逻辑帧率', kind: 'number' },
  { key: 'maxFrameStep', label: '单帧最大步长', kind: 'number' },
  { key: 'autosaveInterval', label: '自动存档间隔', kind: 'number' },
  { key: 'offlineEnabled', label: '开启离线收益', kind: 'boolean' },
  { key: 'offlineCap', label: '离线收益上限（小时）', kind: 'number' },
]

/**
 * 构建完整视图模型。
 *
 * **纯函数**（除 `Num.format` 的 LRU 缓存与“可负担件数”的记忆化外无副作用），
 * 因此可以对同一 `GameState` 反复调用并断言稳定性。
 */
export function buildViewModel(state: GameState, context: ViewModelContext = {}): GameViewModel {
  const format = state.effectiveSettings().numberFormat
  const theme = resolvePageTheme(state, context.themeOverride)
  return {
    title: state.project.meta.name,
    dashboard: buildDashboard(state, format),
    pageTheme: theme.effective,
    page: buildPage(state, format, context, theme),
    onSettings: state.currentPageId === SETTINGS_PAGE_ID,
    nav: buildNav(state),
    settings: buildSettingsPage(state, format, context, theme),
    offline: context.offline ? buildOfflineNotice(state, format, context.offline) : null,
    tickMs: context.tickMs ?? 0,
    fps: context.fps ?? 0,
    perf: context.perf ?? null,
  }
}

/** 页面主题的解析结果（`effective` = 真正生效的那一个）。 */
interface ResolvedPageTheme {
  /** 覆盖值（`THEME_FOLLOW_PAGE`/缺省 = 未覆盖）。 */
  override: string
  /** 作者设定的当前页面主题。 */
  project: string
  /** `override` 非空时的覆盖值，否则等于 `project`。 */
  effective: string
  /**
   * 覆盖值对应的引用；**没有覆盖时是 `undefined`**。
   *
   * 条目主题缺省要跟随“**生效**的页面主题”（PRD 页面编辑器 8），因此条目侧需要
   * 拿到覆盖值的引用而不是它的键文本——没覆盖时保持 `undefined`，让条目回落到
   * `PageDef.theme`（作者写的那一份）。
   */
  effectiveRef: ThemeRef | undefined
}

/**
 * 解析生效的页面主题（见 `GameViewModel.pageTheme`）。
 *
 * 停在内置设置页时，“当前页面”取 8.12 的**初始页面**——它是 `GameState` 唯一
 * 能在不引入隐藏状态（“上一次看的页面”）的前提下确定答案的口径：内置设置页
 * 没有 `PageDef.theme`，而设置页又是壳层的一部分，必须与游戏同色。
 */
function resolvePageTheme(state: GameState, override: string | undefined): ResolvedPageTheme {
  const project = themeKeyOf(pageThemeOf(state, state.currentPageId))
  const applied = override && override !== THEME_FOLLOW_PAGE ? override : THEME_FOLLOW_PAGE
  return {
    override: applied,
    project,
    effective: applied === THEME_FOLLOW_PAGE ? project : applied,
    effectiveRef: applied === THEME_FOLLOW_PAGE ? undefined : themeRefOf(applied),
  }
}

/** `themeKeyOf` 的反函数：`kind:value` -> `ThemeRef`（覆盖值走这个入口进来）。 */
function themeRefOf(key: string): ThemeRef | undefined {
  const at = key.indexOf(':')
  if (at <= 0) return undefined
  const kind = key.slice(0, at)
  if (kind !== 'builtin' && kind !== 'asset' && kind !== 'data') return undefined
  return { kind, value: key.slice(at + 1) }
}

/** 页面 id 的主题引用；内置设置页与不存在的 id 落到 8.12 的初始页面。 */
function pageThemeOf(state: GameState, pageId: string): { kind: string; value: string } {
  const resolved = pageId === SETTINGS_PAGE_ID ? state.initialPageId() : pageId
  const page = state.attrs.find(entityKeyOf('page', resolved))
  const def = page?.def as PageDef | undefined
  return def?.theme ?? { kind: 'builtin', value: 'page-dark' }
}

/** 仪表盘（8.9）。 */
export function buildDashboard(state: GameState, format: NumberFormat): DashboardView {
  const snapshot: DashboardSnapshot = collectDashboard(state)
  return {
    resources: snapshot.amounts.map((entry) => ({
      id: entry.id,
      name: entry.name,
      amount: Num.format(entry.amount, format),
      // 负速率（资源被消耗）如实带符号：8.9 的 `rate` 就是回归斜率本身。
      rate: Num.format(entry.ratePerSecond, format),
    })),
    nextBuy: snapshot.nextBuy ? { id: snapshot.nextBuy.id, name: snapshot.nextBuy.name, dt: Num.format(snapshot.nextBuy.dt, format) } : undefined,
    nextBuyHint: snapshot.nextBuy ? undefined : snapshot.nextBuyHint,
  }
}

/** 当前页面（8.11）。停在内置设置页时返回 `null`。 */
function buildPage(state: GameState, format: NumberFormat, context: ViewModelContext, theme: ResolvedPageTheme): PageView | null {
  const pageId = state.currentPageId
  if (pageId === SETTINGS_PAGE_ID) return null
  const page = state.attrs.find(entityKeyOf('page', pageId))
  if (!page) return null
  const def = page.def as PageDef
  const maxColumns = context.maxColumns ?? Number.POSITIVE_INFINITY
  // D-41：实际列数 = min(page.columns, 设备断点列数)。
  const columns = Math.max(1, Math.min(def.columns, maxColumns))
  const entries = state
    .entriesOfCurrentPage()
    // `isVisible` 为假不渲染（8.11「卡片显隐」）；禁用则保留卡片但置灰。
    .filter((entry) => state.judge.isVisible(entry))
    .map((entry) => buildCard(state, entry, format, context))
  return {
    id: page.id,
    name: def.name,
    description: page.description,
    columns,
    // 生效主题（可能已被玩家的“页面主题”覆盖）：条目主题缺省要跟随**它**。
    theme: theme.effective,
    entryTheme: themeKeyOf(resolveEntryTheme(def, theme.effectiveRef)),
    entries,
  }
}

/** 底部导航（PRD 预览区 8、8.12）。 */
export function buildNav(state: GameState): NavItemView[] {
  // 按 `page.order` 渲染（`listByKind` 已稳定排序）；`visible = false` 的页面不渲染按钮，
  // 但 `nav()` 仍可直达（8.12「跳转入口」）。
  const items: NavItemView[] = state.attrs
    .listByKind('page')
    .filter((page) => page.visible)
    .map((page) => ({
      id: page.id,
      name: page.def.name,
      icon: iconKeyOf(page.def.icon),
      current: state.currentPageId === page.id,
      builtIn: false,
    }))
  // 最后一格固定为内置“设置”页：不是 `PageDef`，不进 `pages`，不参与可见/禁用继承。
  items.push({
    id: SETTINGS_PAGE_ID,
    name: '设置',
    icon: 'gear',
    current: state.currentPageId === SETTINGS_PAGE_ID,
    builtIn: true,
  })
  return items
}

/** 游戏内设置页（8.10）。 */
function buildSettingsPage(state: GameState, format: NumberFormat, context: ViewModelContext, theme: ResolvedPageTheme): SettingsPageView {
  const project = state.project
  const effective = state.effectiveSettings()
  const settings: SettingsFieldView[] = SETTING_FIELDS.map((field) => {
    const projectDefault = String(project.settings[field.key])
    const value = String(effective[field.key])
    return {
      key: String(field.key),
      label: field.label,
      kind: field.kind,
      options: field.options ? field.options.map((option) => ({ ...option })) : undefined,
      value,
      effective: value,
      overridden: projectDefault !== value,
      projectDefault,
    }
  })
  return {
    projectName: project.meta.name,
    author: project.meta.author,
    description: project.meta.description,
    gameTime: Num.format(state.gameTime, format),
    offlineTime: Num.format(Num.fromNumber(context.offlineAccum ?? state.offlineAccum), format),
    playtime: formatSeconds(state.stats.playtime),
    savedAt: formatTimestamp(context.savedAt ?? state.stats.lastSaveAt),
    settings,
    theme: {
      value: theme.override,
      projectTheme: theme.project,
      overridden: theme.override !== THEME_FOLLOW_PAGE,
    },
    dynamicCount: state.dynamicCount(),
    dynamicLimit: GameState.DYNAMIC_LIMIT,
  }
}

/** 离线收益提示条（8.8 末条、8.10）。 */
function buildOfflineNotice(state: GameState, format: NumberFormat, report: OfflineReport): OfflineNoticeView {
  return {
    rawSeconds: formatSeconds(report.rawSeconds),
    settledSeconds: formatSeconds(report.settledSeconds),
    gains: report.gains.map((gain) => {
      const resource = state.attrs.find(entityKeyOf('resource', gain.resourceId))
      return {
        id: gain.resourceId,
        name: resource?.def.name ?? gain.resourceId,
        gained: Num.format(gain.gained, format),
      }
    }),
    truncated: report.truncated,
    approximate: report.approximate,
    clockRollback: report.clockRollback,
    deferred: report.truncated,
  }
}

/** 单个条目的卡片（8.11）。 */
export function buildCard(state: GameState, entry: EntryState, format: NumberFormat, context: ViewModelContext = {}): CardView {
  const key = entityKeyOf(entry.kind, entry.id)
  const disabled = state.judge.isDisabled(entry)
  const cap = state.attrs.capOf(entry)
  const owned = entry.kind === 'resource' ? state.attrs.value(entry, 'amount') : state.attrs.value(entry, 'owned')
  const card: CardView = {
    key,
    kind: cardKindOf(state, entry),
    id: entry.id,
    name: entry.def.name,
    description: entry.description,
    icon: iconKeyOf(entry.def.icon),
    dynamic: entry.dynamic !== undefined,
    disabled,
    capped: owned.gte(cap),
  }

  // ---- 资源（PRD 预览区 3）：无购买路径（D-20），也不受页面禁用影响（8.4）----
  if (entry.kind === 'resource') {
    card.amount = Num.format(state.attrs.value(entry, 'amount'), format)
    return card
  }

  // ---- 生成器 / 点击器的产量（PRD 预览区 4/5、D-30）----
  if (entry.kind === 'generator') {
    card.output = Num.format(state.attrs.perSecond(entry), format)
    card.outputUnit = card.kind === 'clicker' ? 'click' : 'second'
    card.noOutput = producesOf(entry).length === 0
  }

  // ---- 购买相关（生成器与升级，PRD 预览区 5/6）----
  const buyAmount = state.attrs.fieldValue(entry, 'buyAmount')
  const mode = modeOf(buyAmount)
  const quote = evaluateCostAt(state, entry, state.attrs.value(entry, 'bought'))
  const request = mode === 'count' ? normalizedCount(buyAmount) : 0
  // `count` 模式的“当前买得起的件数 + 对应消耗”。
  //
  // 走的是 `batch.affordableInCountMode`——与 `planBatch`/`solveBatch` **同一份**逐级累加
  // 与同一套“逐材料滚动和超过存量即停”的规则，因此“卡片上写的件数与消耗”与
  // “点下去真的买到几件、花掉多少”不可能分叉（8.11 末条：不在 UI 层另算一套逻辑）。
  const affordable = mode === 'count' ? countAffordabilityOf(state, entry, request) : undefined
  // 一件也买不起时显示“配置件数”的合计，让“还差多少”有数可看；这也正是修正
  // “第二个及以后的生成器价格永远显示成开局那个便宜价”的关键：数字必须是**真价**。
  const totals = affordable ? (affordable.k > 0 ? affordable.affordableTotals : affordable.fullTotals) : undefined
  card.costs = quote.quotes.map((line) => ({
    materialId: line.materialId,
    materialName: state.attrs.find(line.materialKey)?.def.name ?? line.materialId,
    // `count` 模式显示**本次购买的合计**（PRD 预览区 5 的“价格”对应按钮真正会花的量）；
    // `max` 的花费事先不可知、`free` 为 0，两者都显示**下一件**单件价格。
    amount: Num.format(totals?.find((row) => row.materialId === line.materialId)?.price ?? line.price, format),
    failed: quote.failed > 0,
  }))
  card.bought = Num.format(state.attrs.value(entry, 'bought'), format)
  card.owned = Num.format(state.attrs.value(entry, 'owned'), format)
  card.buyMode = mode
  card.buyCount = affordable?.k ?? 0
  card.buyRequest = request
  // 价格行不可用时按钮必须**禁用**：运行时同样会拒绝购买（`priceRowsUsable`），
  // 按钮与结算必须同口径，否则作者点下去只会看到“买了但不扣钱”。
  const priceUsable = priceRowsUsable(state, entry, quote)
  card.canBuy = priceUsable && state.judge.canBuy(entry) && buysAnything(state, entry, mode, affordable)
  card.buyBlockReason = priceUsable ? buyBlockReason(state, entry, card.canBuy) : BROKEN_PRICE_REASON
  card.calculating = context.calculating?.has(key) ?? false
  card.rewriteAdvice = context.rewriteAdvice?.has(key) ?? false

  // ---- 升级的购买条件与效果（PRD 预览区 6）----
  if (entry.kind === 'upgrade') {
    card.conditions = evaluateConditions(state, entry)
    card.effects = buildEffects(state, entry, format)
  }

  // ---- 点击器（PRD 预览区 4、D-28、R-25）----
  if (card.kind === 'clicker') {
    // 点击器没有购买路径：卡片只渲染“点击”。判定仍走 8.4 的入口，而不是 UI 层自己拼，
    // 这样暂停/禁用/上限/页面继承在按钮可用性上的口径与结算完全一致。
    card.canClick = state.judge.canTick(entry) && !card.capped
  }

  // 动态条目右上角的“丢弃”（PRD 预览区 6、8.7）。点击器没有 `costs`，
  // 丢弃按钮对它同样有意义——8.7 的 `destroy()` 不区分形态。
  card.canDiscard = card.dynamic
  return card
}

/** 卡片形态：生成器 + `isClicker` 渲染 `ClickerCard`（8.11 末条、D-26）。 */
function cardKindOf(state: GameState, entry: EntryState): CardView['kind'] {
  if (entry.kind === 'resource') return 'resource'
  if (entry.kind === 'generator') return state.judge.isClicker(entry) ? 'clicker' : 'generator'
  return 'upgrade'
}

/** 升级的购买条件逐条求值（PRD 补充 4 的 AND 语义；UI 逐条显示真假）。 */
function evaluateConditions(state: GameState, entry: EntryState): { text: string; true: boolean }[] {
  const out: { text: string; true: boolean }[] = []
  const count = conditionsOf(entry).length
  for (let index = 0; index < count; index += 1) {
    const where = `${entityKeyOf(entry.kind, entry.id)}.conditions[${index}]`
    const text = state.attrs.textOr(entry, `conditions[${index}]`)
    out.push({ text, true: safeBoolean(state, text, 'condition', where) })
  }
  return out
}

/** 升级效果的“效果内容 / 效果数值”（PRD 升级编辑器 12）。 */
function buildEffects(state: GameState, entry: EntryState, format: NumberFormat): EffectView[] {
  const effects = effectsOf(entry)
  const out: EffectView[] = []
  for (let index = 0; index < effects.length; index += 1) {
    out.push({
      condition: state.attrs.textOr(entry, `effects[${index}].condition`),
      action: state.attrs.textOr(entry, `effects[${index}].action`),
      value: Num.format(entry.values.get(`effectValues[${index}]`) ?? Num.fromNumber(0), format),
    })
  }
  return out
}

/** 不可购买的原因（悬浮提示；`undefined` = 可购买）。 */
function buyBlockReason(state: GameState, entry: EntryState, canBuy: boolean): string | undefined {
  if (canBuy) return undefined
  if (state.judge.isClicker(entry)) return '点击器不可购买，请使用“点击”按钮'
  if (!state.judge.isVisible(entry)) return '条目不可见'
  if (state.judge.isDisabled(entry)) return '条目已禁用'
  if (state.attrs.value(entry, 'owned').gte(state.attrs.capOf(entry))) return '已达数量上限'
  if (entry.kind === 'upgrade' && !conditionsAllTrue(state, entry)) return '购买条件未满足'
  if (!buysAnything(state, entry, modeOf(state.attrs.fieldValue(entry, 'buyAmount')), undefined)) {
    return NOT_ENOUGH_MATERIAL_REASON
  }
  return '暂时不可购买'
}

/**
 * “这一笔**至少能买到一件**吗”（`canBuy` 的材料维度）。
 *
 * `judge.canBuy` 只回答**结构性**问题（可见 / 未禁用 / 未达上限 / 非点击器 / 升级条件，
 * 8.4）；它**故意**不看材料，于是“亮着的按钮 + 点下去什么都没发生”是它的必然结果。
 * 卡片必须把这一层也判掉，否则玩家看到的就是一个死按钮（这正是“第二个及以后的
 * 生成器买不了”的观感来源：价格显示成开局的便宜价、按钮亮着、点击却结算失败）。
 *
 * | 模式 | 判定 |
 * | --- | --- |
 * | `count` | 用 `affordableInCountMode` 的 `k > 0`（它与 `solveBatch` 同口径） |
 * | `max` | 只看**下一件**的单件价格是否付得起（`max` 的总价事先不可知，求它是 `O(k)`） |
 * | `free` | 恒真（不扣材料，8.6 的 `free` 语义） |
 */
function buysAnything(state: GameState, entry: EntryState, mode: BuyMode, affordable: { k: number } | undefined): boolean {
  if (mode === 'free') return true
  if (mode === 'count') return (affordable?.k ?? 0) > 0
  const single = evaluateCostAt(state, entry, state.attrs.value(entry, 'bought'))
  if (single.failed > 0 || single.quotes.length === 0) return true // 价格行无效：`priceRowsUsable` 单独判
  return single.quotes.every((quote) => {
    const material = state.attrs.find(quote.materialKey)
    if (!material) return true
    return state.attrs.value(material, 'amount').gte(quote.price)
  })
}

/** 条件是否全真（`canBuy` 的升级分支，8.4）。 */
function conditionsAllTrue(state: GameState, entry: EntryState): boolean {
  return evaluateConditions(state, entry).every((condition) => condition.true)
}

/**
 * 一条价格表达式对属性存储的**完整依赖**（5.6 的 `deps` + 5.3 的内建变量）。
 *
 * | 结果 | 含义 |
 * | --- | --- |
 * | `undefined` | 文本解析/静态检查失败 —— **不缓存**（文本随时可能被热替换，宁可多算） |
 * | `{ volatile: false, keys }` | 只依赖列出的属性键：按它们的版本号判脏即可 |
 * | `{ volatile: true, keys }` | 还读了 `time`/`tick`/… 等每 tick 都变的内建变量：**不能跨 tick 缓存** |
 */
interface PriceDeps {
  /** 表达式读到的属性键（`deps`）。 */
  keys: readonly string[]
  /** 是否读了每 tick 都变的内建变量（`10 + time` 这类价格）。 */
  volatile: boolean
}

const priceDepsCache = new Map<string, PriceDeps | undefined>()

function priceDepsOf(text: string): PriceDeps | undefined {
  const cached = priceDepsCache.get(text)
  if (cached !== undefined || priceDepsCache.has(text)) return cached
  let result: PriceDeps | undefined
  try {
    const checked = staticCheck(parse(text), 'price')
    result = { keys: checked.deps, volatile: checked.vars.length > 0 }
  } catch {
    result = undefined
  }
  priceDepsCache.set(text, result)
  return result
}

/**
 * `count` 模式的“当前买得起的件数 + 消耗”，带**依赖完整**的记忆化（PRD 预览区 5）。
 *
 * ## 键必须覆盖**价格表达式真正读到的全部东西**
 *
 * 早先的键是 `(条目, 自身 bought 版本, 件数, 材料)`，漏掉了价格表达式引用的**其它条目属性**。
 * 于是 `100 * (10000 ^ floor(gen.g1.bought / 10))` 这种“价格挂在另一个生成器身上”的常见写法
 * （「反物质维度」这类维度跃迁项目全部如此）在 `g1.bought` 越过台阶之后，
 * `g2`~`g4` 的价格**永远停留在开局那个便宜价**（实测便宜 1000 倍）：
 * 按钮亮着、写着“购买 ×10”、点下去却因材料不足结算 0 件——作者据此认为
 * “第二个及以后的生成器买不了”。修正办法不是“多清几次缓存”，而是把键补全。
 *
 * | 段 | 覆盖 |
 * | --- | --- |
 * | `bought#版本` | 只读等级视图的基准（8.6.1 的 overlay） |
 * | `键#版本,…` | 每条价格行 `deps` 里的条目属性（`versionOf` 是写入路径的唯一收口） |
 * | `@tick` | 仅当某行读了 `time`/`tick` 等内建变量（它们没有版本号，见 `PriceDeps.volatile`） |
 *
 * 上界 100（5.9.3 的夹取）保证单次计算是常数级开销；缓存只是省掉重复的那一份。
 */
const affordCache = new Map<string, CountAffordability>()
const AFFORD_CACHE_LIMIT = 4096

/** 容量护栏：条目多 + `count` 模式时键会不断增长，丢掉最早插入的一半即可（它们必然最久未被命中）。 */
function pruneAffordCache(): void {
  if (affordCache.size <= AFFORD_CACHE_LIMIT) return
  const keys = [...affordCache.keys()].slice(0, Math.floor(AFFORD_CACHE_LIMIT / 2))
  for (const key of keys) affordCache.delete(key)
}

/**
 * 记忆化键（`undefined` = **不缓存**这一条）。
 *
 * 键必须覆盖结果依赖的**每一个**可变输入：
 *
 * | 段 | 覆盖 |
 * | --- | --- |
 * | 自身 `bought` + 版本 | 只读等级视图的基准（8.6.1 的 overlay） |
 * | 每条价格行的 `deps` + 版本 | 价格表达式读到的**任意条目属性**（价格挂在别的生成器身上时靠这段） |
 * | 每条价格行的 `materialId` + `res.<id>.amount` 版本 | **材料存量**——`k` 是“买得起几件”，与存量直接相关 |
 * | `@tick` | 仅当某行读了 `time`/`tick` 等内建变量（它们没有版本号，见 `PriceDeps.volatile`） |
 *
 * 漏掉“材料存量”这一段的后果是：常量价格（`1`）的条目在第一次建视图时把 `k = 0`
 * 记进缓存，之后材料涨到够买也仍然显示“买不起”——和原先漏掉 `deps` 一样，
 * 都是**键不完整**而不是“缓存该不该有”。
 *
 * @param rows 该条目的全部价格行（`materialId` 与 `amount` 文本都要参与）。
 */
function affordCacheKey(
  state: GameState,
  entry: EntryState,
  count: number,
  rows: readonly { materialId: string; text: string }[],
): string | undefined {
  const boughtKey = `${entityKeyOf(entry.kind, entry.id)}.bought`
  const parts: string[] = [boughtKey, String(state.attrs.versionOf(boughtKey))]
  for (const row of rows) {
    const deps = priceDepsOf(row.text)
    // 文本解析/静态检查失败时不缓存：它随时可能被热替换成另一段依赖不同的表达式，
    // 此时宁可多算一次，也不能把上一段文本的结论套上去。
    if (!deps) return undefined
    for (const key of deps.keys) parts.push(key, String(state.attrs.versionOf(key)))
    if (deps.volatile) parts.push('@tick', String(state.stats.tick))
    // 材料存量：`k` 随它变（“买得起几件”）。`materialId` 本身也可能在热更新里被换掉。
    const amountKey = `${entityKeyOf('resource', row.materialId)}.amount`
    parts.push(amountKey, String(state.attrs.versionOf(amountKey)))
  }
  return `${parts.join('|')}|${count}`
}

/** `count` 模式的“当前买得起的件数 + 消耗”（带记忆化）。 */
function countAffordabilityOf(state: GameState, entry: EntryState, count: number): CountAffordability {
  const rows: { materialId: string; text: string }[] = []
  const costCount = costsOf(entry).length
  for (let index = 0; index < costCount; index += 1) {
    rows.push({
      materialId: state.attrs.textOr(entry, `costs[${index}].materialId`),
      text: state.attrs.textOr(entry, `costs[${index}].amount`),
    })
  }
  const key = affordCacheKey(state, entry, count, rows)
  if (key === undefined) return affordableInCountMode(state, entry, count)
  const cached = affordCache.get(key)
  if (cached !== undefined) return cached
  const computed = affordableInCountMode(state, entry, count)
  affordCache.set(key, computed)
  pruneAffordCache()
  return computed
}

/** 清空价格合计缓存（“重新开始”/ 载入新项目 / 换文本）。 */
export function resetViewModelCache(): void {
  affordCache.clear()
  priceDepsCache.clear()
}

/** `buyAmount` 的归一化件数（5.9.3 的 ③④：`floor` + 夹 100）。 */
function normalizedCount(buyAmount: Decimal): number {
  const asNumber = Num.floor(buyAmount).toNumber()
  if (!Number.isFinite(asNumber)) return 0
  return Math.max(0, Math.min(100, Math.floor(asNumber)))
}

/** `produces` 是否为空。 */
function producesOf(entry: EntryState): GeneratorDef['produces'] {
  return entry.kind === 'generator' ? (entry.def as GeneratorDef).produces : []
}

/** `costs` 是否为空（卡片据此省略价格行）。 */
export function hasCosts(entry: EntryState): boolean {
  return costsOf(entry).length > 0
}

/** 条件求值（抛错按“不成立”并由 last-good 兜底，8.7「前提求值失败」）。 */
function safeBoolean(state: GameState, text: string, context: 'condition', where: string): boolean {
  try {
    return state.runtime.evaluateBoolean(text, context, where)
  } catch {
    return false
  }
}

/** `IconRef` -> `"builtin:<id>"` / `"asset:<data url>"`（10.1 资产解析链路的落地形态）。 */
export function iconKeyOf(icon: { kind: string; value: string }): string {
  return `${icon.kind}:${icon.value}`
}

/** `ThemeRef` -> `"builtin:<id>"` / `"asset:<css>"`。 */
export function themeKeyOf(theme: { kind: string; value: string }): string {
  return `${theme.kind}:${theme.value}`
}

/**
 * 条目主题：缺省跟随**生效**的页面主题（PRD 页面编辑器 8、M3 的取舍——渲染期解析，
 * 数据模型里没有隐式状态）。
 *
 * `override` 是会话级页面主题覆盖（8.10）：作者没显式配条目主题时，卡片要跟随的是
 * **玩家看到的**页面主题，而不是项目文件里那一份——否则“换了页面主题，页面变白、
 * 卡片还是暗的”。
 */
function resolveEntryTheme(def: PageDef, override: ThemeRef | undefined): { kind: string; value: string } {
  const explicit = def.entries.find((entry) => entry.theme !== undefined)?.theme
  return explicit ?? override ?? def.theme
}

/** 秒数 -> 人读文本（`1分23秒`）。 */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0秒'
  const total = Math.floor(seconds)
  if (total < 60) return `${total}秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}小时` : `${hours}小时${restMinutes}分`
}

/** 时间戳 -> 本地时间文本；无效/缺省时给 `—`（8.10 的最后存档）。 */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
