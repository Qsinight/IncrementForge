/**
 * `GameState` —— 运行时状态机（TECH_DESIGN 8.1、8.2、8.3、8.3.1、8.4、8.5、8.7、8.12）。
 *
 * ## 单 tick 的固定时序（8.3）
 *
 * 1. 每 tick 归零缓存（`tickCache.clear()` + 刷新随机上下文）
 * 2. 每秒触发阶段（按 `gameTime` 判定；离线跳过）
 * 3. 产出结算
 * 4. 点击器（事件驱动，tick 内不推进）
 * 5. 自动购买（`buyAmount < 0`；点击器无条件跳过；离线不触发）
 * 6. **副作用提交**（唯一提交点，5.6）
 * 7. 统计与快照
 * 8. 自动存档（按 `realElapsed`，真实秒数）
 *
 * 时序固定意味着同一 tick 序列永远得到同一结果——可预测、可测试、可重放。
 *
 * ## 单一提交点（8.3.1）
 *
 * `set/create/destroy` 与 `effValue` 写回**只**在第 6 步应用。落在两次 tick 之间的
 * 交互（点击器点击、购买、丢弃）**状态字段即时结算**，但它们收集的副作用进同一队列、
 * 在**下一个**第 6 步应用——不另开即时提交旁路。因此“暂停时购买升级，其效果不会立刻显现”
 * 是必然结果，而不是缺陷。
 */
import { Diagnostics, ForgeError, Num, formatStats } from '@iforge/num'
import type { Decimal, ErrorCode } from '@iforge/num'
import { compileCacheStats } from '@iforge/expr'
import type { Effect, Value } from '@iforge/expr'
import type { ProjectFile, ProjectSettings } from '@iforge/model'
import { collectIds } from '@iforge/model'

import { AttributeStore, entityKeyOf, perSecondDef } from './attribute-store.js'
import type { EntryState } from './attribute-store.js'
import { createBudget, solveBatch } from './batch.js'
import type { BatchResult, SolveBudget } from './batch.js'
import { FrameClock } from './clock.js'
import { resetRateHistory, sampleRates } from './dashboard.js'
import { DYNAMIC_LIMIT, DynamicRegistry } from './dynamic-registry.js'
import type { DynamicEntry } from './dynamic-registry.js'
import { ExpressionRuntime } from './expression-runtime.js'
import type { ClickOutcome } from './interactions.js'
import type { PerfPayload } from './protocol.js'
import { buyOne, conditionsAllTrue, modeOf } from './purchase.js'
import type { BuyMode } from './purchase.js'
import { click, produceOnce } from './production.js'
import { applyEffect } from './upgrade-effect.js'
import { VisibilityJudge } from './visibility.js'
import type { VisibilitySnapshot } from './visibility.js'

/** 运行标志（8.1）。 */
export interface GameFlags {
  paused: boolean
  /** 时间倍速（D-31：`1 / 2 / 5 / 10`；只加速在线 tick 推进）。 */
  speed: number
  offline: boolean
  started: boolean
}

/** 运行统计（8.1）。 */
export interface GameStats {
  /** 真实游玩秒数（存档字段 `playtime`）。 */
  playtime: number
  /** 真实经过秒数（不随倍速放大；自动存档间隔与 `elapsed` 用，8.2）。 */
  realElapsed: number
  tick: number
  lastTickAt: number
  lastSaveAt: number
}

/** 内置设置页的哨兵 id（8.12：不是 `PageDef`，不占用页面 id 空间）。 */
export const SETTINGS_PAGE_ID = '__settings__'

/**
 * 连续降级多少 tick 后给出“改写价格形状”的作者提示（8.6 末条）。
 *
 * 取 60 而不是 1：一次降级可能只是材料不够导致的边界情形，连续 60 tick（约 3 秒游戏时间）
 * 才说明这条价格**形状**本身不可闭式。
 */
export const REWRITE_ADVICE_TICKS = 60

/** 构造选项。 */
export interface GameStateOptions {
  project: ProjectFile
  /** 存档位（V1.0 固定 `main`，PRD 补充 8）。 */
  slotId?: string
  projectId?: string
  /** 墙钟（ms），便于测试注入离线结算（R-20）。 */
  now?: () => number
  /** ISO8601 时间戳，用于动态条目的 `createdAt`。 */
  nowIso?: () => string
}

export class GameState {
  /**
   * 项目文件（8.1）。
   *
   * **可写**而不是 `readonly`：7.4 的 `host:patch` 增量热更新需要在**保留运行时进度**的前提下
   * 换掉结构（详见 `patch.ts` 的 `applyProjectPatch`）。改结构的动作全部收敛在 `patch.ts`，
   * 其它地方一律走 `loadProject()`（整表重建，进度按 8.5 重置）——两条路径的语义差别很大，
   * 混用会让“改一个名字把进度清零”这种事故变得无法排查。
   */
  project: ProjectFile
  /** 会话覆盖：有效值 = `project.settings ⊕ settingsOverride`（D-22）。 */
  settingsOverride: Partial<ProjectSettings> = {}
  /** 属性存储（资源/生成器/升级/页面属性值，含运行时赋值）。 */
  readonly attrs: AttributeStore
  /** 表达式运行时（五个上下文 + 副作用收集）。 */
  readonly runtime = new ExpressionRuntime()
  /** 动态条目注册表。 */
  readonly dynamic: DynamicRegistry
  /** 可见性判定（8.4 的唯一入口）。 */
  readonly judge: VisibilityJudge

  /** 运行标志。 */
  flags: GameFlags = { paused: false, speed: 1, offline: false, started: false }
  /** 运行统计。 */
  stats: GameStats = { playtime: 0, realElapsed: 0, tick: 0, lastTickAt: 0, lastSaveAt: 0 }

  /** 游戏内累计秒数（随倍速推进，供 `time` 变量与“每秒生效”使用，D-35）。 */
  gameTime: Decimal = Num.fromNumber(0)
  /** 已结算的离线收益秒数（存档字段 `offlineAccum`，8.8）。 */
  offlineAccum = 0
  /** 上次“每秒生效”触发时的 `gameTime`（8.3 第 2 步；由 `gameTime` 单调推导，不单独存档）。 */
  lastPerSecondAt = 0
  /** 当前所在页面；内置设置页用哨兵 `'__settings__'`（8.12）。 */
  currentPageId: string = SETTINGS_PAGE_ID

  /** 帧时钟（8.2 的纯时间累积部分）。 */
  readonly clock: FrameClock

  readonly slotId: string
  readonly projectId: string
  private readonly now: () => number
  private readonly nowIso: () => string
  /** “强制解锁”标记（纯内存态，D-16）。 */
  private readonly forceUnlocked = new Set<string>()
  /** 上一次自动存档的游标（避免重复写）。 */
  private needsSave = false
  /**
   * 自动购买阶段的求值预算（8.6 的 C 分支）。
   *
   * 每个 tick 重新给一份：预算是**单 tick** 的上限（12 性能预算“单 tick ≤ 1e5 次求值”），
   * 跨 tick 续算靠“本 tick 已确认的前缀立即结算 + 下一 tick 从断点继续”，而不是把预算累加。
   */
  private autoBuyBudget: SolveBudget = createBudget()

  /**
   * 连续降级的 tick 计数（8.6「持续降级时的作者提示」）。
   *
   * 键是实体键（`gen.g1`/`up.u2`），值是“本条目**连续**处于降级路径的 tick 数”。
   * 达到 `REWRITE_ADVICE_TICKS = 60` 时进入 `rewriteAdvice` 集合，供诊断面板与卡片
   * 追加固定提示文案（“价格形状无法闭式求解，已按 tick 分摊；建议改写为等比或指数+线性形式”）。
   *
   * **只在“本 tick 真的尝试求解过”时计数**：`k = 0`（材料不够）与前置判定失败都**不算**降级，
   * 否则一个买不起的生成器会在 60 tick 后被误标成“需要改写价格形状”。
   */
  private degradedStreak = new Map<string, number>()

  /**
   * 求解被**单 tick 求值预算**截断、还在等下一 tick 续算的条目（8.6 的 C 分支）。
   *
   * 卡片据此显示“计算中…”。它与 `degradedStreak` 是两回事，必须分开：
   *
   * - `degraded` = “走了迭代路径”。降级本身**可能已经算完了**（迭代路径通常只花百量级求值），
   *   拿它当“计算中”的依据，就会出现“第一次点击后按钮永远显示计算中…”——交互路径每次点击
   *   都拿一份全新的预算，根本不存在跨 tick 续算，也就没有“等下一 tick”这回事；
   * - `truncated` = “预算用光了，`k` 只是已确认的前缀”。只有它才对应真正的“还在算”。
   *
   * 放在 `GameState` 而不是宿主控制器：这份状态必须随**每次求解结果**自我更新，
   * 任何一条不更新它的路径都会让按钮卡在“计算中…”（这正是缺陷本身的形态）。
   */
  private readonly pendingSolve = new Set<string>()

  constructor(options: GameStateOptions) {
    this.project = options.project
    this.slotId = options.slotId ?? 'main'
    this.projectId = options.projectId ?? 'iforge-local-project'
    this.now = options.now ?? (() => Date.now())
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())

    this.attrs = new AttributeStore(this.runtime)
    this.runtime.attachStore(this.attrs)

    this.dynamic = new DynamicRegistry({
      attrs: this.attrs,
      staticIds: () => this.staticIds(),
      hasPage: (pageId) => this.attrs.find(entityKeyOf('page', pageId)) !== undefined,
      now: () => this.nowIso(),
    })
    this.runtime.dynamic = this.dynamic

    this.judge = new VisibilityJudge({
      attrs: this.attrs,
      pageOf: (state) => this.pageOfEntry(state),
      capOf: (state) => this.attrs.capOf(state),
      ownedOf: (state) => this.attrs.value(state, 'owned'),
      conditionsAllTrue: (state) => conditionsAllTrue(this, state),
    })

    this.clock = new FrameClock({
      tickRate: this.effectiveSettings().tickRate,
      maxFrameStep: this.effectiveSettings().maxFrameStep,
      speed: 1,
    })

    this.loadProject(options.project)
    this.reset()
  }

  // -------------------------------------------------------------------------
  // 有效设置（D-22）
  // -------------------------------------------------------------------------

  /** 有效设置 = 项目默认 ⊕ 会话覆盖。 */
  effectiveSettings(): ProjectSettings {
    return { ...this.project.settings, ...this.settingsOverride }
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 载入项目结构（7.9 的 `host:init` 等价路径）。 */
  loadProject(project: ProjectFile): void {
    this.project = project
    this.attrs.loadProject(project)
    this.clock.configure({
      tickRate: this.effectiveSettings().tickRate,
      maxFrameStep: this.effectiveSettings().maxFrameStep,
    })
    this.currentPageId = this.initialPageId()
    this.forceUnlocked.clear()
  }

  /**
   * `GameState.reset()`（8.10「重新开始」、D-18）。
   *
   * 按 8.5 的初始化规则把全部属性复位为项目文件值，丢弃 `assignments`/`effectValues`/`dynamic`，
   * 重置 `gameTime`/`playtime`，并把当前页面复位到 8.12 的初始页面。
   */
  reset(): void {
    this.dynamic.reset()
    this.attrs.resetValues()
    this.runtime.resetSink()
    // 采样历史同样要清（8.9 的最近 20 tick 窗口）：不清的话新一局的头 20 个速率
    // 是拿上一局的 `amount` 算出来的回归斜率，会出现“重新开始后速率离谱”的现象。
    resetRateHistory()
    this.gameTime = Num.fromNumber(0)
    this.offlineAccum = 0
    this.lastPerSecondAt = 0
    this.stats = { playtime: 0, realElapsed: 0, tick: 0, lastTickAt: this.now(), lastSaveAt: 0 }
    this.flags = { paused: false, speed: this.flags.speed, offline: false, started: false }
    this.clock.resetAccumulator()
    this.forceUnlocked.clear()
    this.degradedStreak.clear()
    this.pendingSolve.clear()
    this.needsSave = false
    this.currentPageId = this.initialPageId()
  }

  /** 8.12 的初始页面：`order` 最小且可见的页面；无可见页面时取 `order` 最小的页面（**不报错**）。 */
  initialPageId(): string {
    const pages = this.attrs.listByKind('page')
    if (pages.length === 0) return SETTINGS_PAGE_ID
    const visible = pages.filter((page) => page.visible)
    if (visible.length === 0) return pages[0]!.id
    return visible[0]!.id
  }

  // -------------------------------------------------------------------------
  // 页面归属与导航（8.4 `pageOf`、8.12）
  // -------------------------------------------------------------------------

  /**
   * 条目 -> 所属页面（8.4 `pageOf`）。
   *
   * 静态条目查 `PageDef.entries`；动态条目查存档里的 `pageId`。
   * 无归属时返回 `undefined`——调用方按“不可见且禁用”处理并记 `E_PAGE_UNKNOWN`（8.7 孤儿口径）。
   */
  pageOfEntry(state: EntryState): string | undefined {
    if (state.kind === 'page') return undefined
    if (state.dynamic) return state.dynamic.pageId
    for (const page of this.attrs.listByKind('page')) {
      const def = page.def as { entries: { id: string }[] }
      if (def.entries.some((entry) => entry.id === state.id)) return page.id
    }
    return undefined
  }

  /**
   * `nav(pageId)`：唯一跳转入口（8.12）。
   *
   * **不**校验 `visible`/`disabled`——页面禁用仍可跳转（PRD 页面编辑器 4「仍可跳转」），
   * 不可见页面也允许直达（供“解锁全部”与调试）。
   */
  nav(pageId: string): boolean {
    if (pageId === SETTINGS_PAGE_ID) {
      this.currentPageId = SETTINGS_PAGE_ID
      return true
    }
    if (!this.attrs.find(entityKeyOf('page', pageId))) {
      Diagnostics.record('E_PAGE_UNKNOWN', `nav(${pageId})`, '页面不存在')
      return false
    }
    this.currentPageId = pageId
    return true
  }

  // -------------------------------------------------------------------------
  // tick 主循环（8.2、8.3）
  // -------------------------------------------------------------------------

  /**
   * `stepTick(stepMs, realDtMs)`：推进一个逻辑帧（8.2）。
   *
   * 顺序固定（8.3 的 1~8 步），因此同一 tick 序列永远得到同一结果。
   */
  stepTick(stepMs: number, realDtMs: number): void {
    const dtSeconds = Num.div(Num.fromNumber(stepMs), Num.fromNumber(1000))

    // ---- 1) 每 tick 归零缓存 + 刷新随机上下文（8.3 第 1 步）----
    this.stats.tick += 1
    this.gameTime = Num.add(this.gameTime, dtSeconds)
    this.stats.realElapsed += realDtMs / 1000
    this.stats.playtime += realDtMs / 1000
    this.attrs.vars = {
      tick: this.stats.tick,
      time: this.gameTime,
      dt: dtSeconds,
      elapsed: this.stats.realElapsed,
      offline: this.flags.offline,
      started: this.flags.started,
    }
    this.runtime.beginTick(this.stats.tick, this.flags.offline)
    this.flags.started = true
    // 求值预算是**单 tick** 的：每 tick 重置（12 性能预算）。
    this.autoBuyBudget = createBudget()

    const generators = this.attrs.listByKind('generator')
    const upgrades = this.attrs.listByKind('upgrade')
    // 判定快照：阶段内取一次，避免同 tick 内半途改页面导致结算不一致（8.4「判定时机」）。
    const snapshot = this.judge.snapshot([...generators, ...upgrades, ...this.attrs.listByKind('resource')])

    // ---- 2) 每秒触发阶段（按 gameTime 判定；离线跳过）----
    if (!this.flags.offline) this.runPerSecondPhase(upgrades, snapshot)

    // ---- 3) 产出结算（8.3 第 3 步）----
    this.runProductionPhase(generators, snapshot, dtSeconds)

    // ---- 4) 点击器：事件驱动，tick 内不推进（8.3 第 4 步）----

    // ---- 5) 自动购买（8.3 第 5 步；离线不触发）----
    if (!this.flags.offline) this.runAutoBuyPhase([...generators, ...upgrades], snapshot)

    // ---- 6) 副作用提交（唯一提交点）----
    this.commitEffects()

    // ---- 7) 统计与快照（8.9 的仪表盘数据）----
    // 必须在这里采样：产出结算（3）与副作用提交（6）都已完成，采到的才是**本 tick 生效后**的
    // `amount`。放到提交之前会让速率与下一个 tick 的数量错位一位。
    sampleRates(this)

    // ---- 8) 自动存档（按真实秒数，不随倍速加速，D-31）----
    this.stats.lastTickAt = this.now()
    this.needsSave = this.stats.realElapsed >= this.effectiveSettings().autosaveInterval
  }

  /**
   * 本帧**没有产生 tick** 时，把真实经过时间记进 `realElapsed` / `playtime`。
   *
   * ## 为什么需要它（8.2 伪码的一个真实漏洞）
   *
   * 8.2 的伪码是：
   * ```
   * realShare = nPlan > 0 ? realDt / nPlan : realDt
   * for i in 1..nPlan:  stepTick(step, realShare)
   * ```
   * 当 `nPlan === 0`（默认配置下 60fps 的帧里约有 2/3 落在这里：20 tick/s 需要 50ms
   * 才攒出一个 tick，而每帧只有 16ms）时循环一次都不执行，那 `realDt` 就**整段丢失**了。
   * 结果是 `stats.realElapsed` 只按“有 tick 的帧”累加，实际速度约为真实时间的 1/3，
   * 进而让 D-35/D-31 明确要求的“自动存档间隔按**真实秒数**计”变成 3 倍时长。
   *
   * 因此把“没有任何 tick 承载的真实时间”显式补记在这里：`stepTick` 的语义保持不变
   * （它只负责分摊**属于某个 tick** 的那部分），主循环在 `plan.count === 0` 时调用本方法。
   */
  advanceRealTime(realDtMs: number): void {
    if (realDtMs <= 0) return
    this.stats.realElapsed += realDtMs / 1000
    this.stats.playtime += realDtMs / 1000
  }

  /** 每秒触发阶段（8.3 第 2 步、D-35、D-43）。 */
  private runPerSecondPhase(upgrades: readonly EntryState[], snapshot: VisibilitySnapshot): void {
    const settings = this.effectiveSettings()
    void settings
    // `gameTime >= lastPerSecondAt + 1` 时触发一次，并跳过多余的秒——
    // 保证单帧内跑多个 tick 时每游戏秒最多触发一次。
    const currentSeconds = Num.floor(this.gameTime).toNumber()
    if (currentSeconds < this.lastPerSecondAt + 1) return
    this.lastPerSecondAt = Math.floor(currentSeconds - ((currentSeconds - this.lastPerSecondAt) % 1))

    // 按 `order` 稳定排序（PRD 补充 5）——`listByKind` 已排序。
    for (const upgrade of upgrades) {
      // 只对“有效可见、有效未禁用、**已拥有**”的升级触发（8.3 第 2 步、D-43）。
      if (!snapshot.canSettle('upgrade', upgrade.id)) continue
      if (!this.judge.ownsUpgrade(upgrade)) continue
      if (!upgradeDefPerSecond(upgrade)) continue
      applyEffect(this, upgrade)
    }
  }

  /** 产出结算阶段（8.3 第 3 步、D-30）。 */
  private runProductionPhase(generators: readonly EntryState[], snapshot: VisibilitySnapshot, dt: Decimal): void {
    for (const generator of generators) {
      // 点击器不参与自动产出（PRD 生成器 11）。
      if (this.judge.isClicker(generator)) continue
      if (!snapshot.canSettle('generator', generator.id)) continue
      const owned = this.attrs.value(generator, 'owned')
      if (!owned.gt(0)) continue
      produceOnce(this, generator, owned, dt)
    }
  }

  /**
   * 自动购买阶段（8.3 第 5 步、D-04、D-28）。
   *
   * 只处理 `buyAmount < 0`（自动最大购买，免费）的生成器/升级，且必须满足
   * `buyDelay` 间隔（D-04：默认每 tick 一次）。**点击器一律跳过**——`isClicker` 生成器
   * 不可购买，否则“免费自动最大购买”会把它当免费产出来白嫖（8.6 的前置判定）。
   */
  private runAutoBuyPhase(states: readonly EntryState[], snapshot: VisibilitySnapshot): void {
    for (const state of states) {
      if (!snapshot.canSettle(state.kind, state.id)) continue
      if (this.judge.isClicker(state)) continue
      const buyAmount = this.attrs.fieldValue(state, 'buyAmount')
      if (modeOf(buyAmount) !== 'free') continue
      const delay = Math.max(1, Math.floor(buyDelayOf(state)))
      if (this.stats.tick % delay !== 0) continue
      this.noteSolveOutcome(state, solveBatch(this, state, this.autoBuyBudget))
    }
  }

  /** 副作用提交（8.3 第 6 步）：`destroy` 先于 `create`（由 `EffectSink` 保证）。 */
  commitEffects(): number {
    return this.runtime.commit((effect) => {
      if (effect.kind === 'set') {
        this.attrs.write(effect.path ?? '', toWriteValue(effect.value), effect.expr)
        return
      }
      if (effect.kind === 'destroy') {
        try {
          this.dynamic.destroy(effect.path ?? '')
        } catch (error) {
          Diagnostics.record(forgeCode(error, 'E_DESTROY_STATIC'), `destroy(${effect.path})`, errorMessage(error))
        }
        return
      }
      try {
        const id = this.dynamic.create(effect.createKind ?? 'upgrade', effect.spec)
        effect.createdId = id
      } catch (error) {
        Diagnostics.record(forgeCode(error, 'E_CREATE_FIELD_INVALID'), `create(${effect.createKind})`, errorMessage(error))
      }
    })
  }

  // -------------------------------------------------------------------------
  // 交互（8.3.1）
  // -------------------------------------------------------------------------

  /** 点击器点击（8.5 `click`）：状态即时结算，副作用不进队列（产出不是表达式副作用）。 */
  click(generatorId: string): ClickOutcome {
    const state = this.attrs.find(entityKeyOf('generator', generatorId))
    if (!state) return { ok: false, gained: Num.fromNumber(0) }
    try {
      const gained = click(this, state)
      return { ok: true, gained }
    } catch {
      return { ok: false, gained: Num.fromNumber(0) }
    }
  }

  /** 单件购买（8.5 `buyOne`）。 */
  buy(id: string): boolean {
    const state = this.attrs.find(entityKeyOf('generator', id)) ?? this.attrs.find(entityKeyOf('upgrade', id))
    if (!state) return false
    return buyOne(this, state)
  }

  /** 批量购买（8.6）。副作用在**下一个**提交阶段应用（8.3.1）。 */
  batch(id: string, budget: SolveBudget = createBudget()): BatchResult | null {
    const state = this.attrs.find(entityKeyOf('generator', id)) ?? this.attrs.find(entityKeyOf('upgrade', id))
    if (!state) return null
    const result = solveBatch(this, state, budget)
    this.noteSolveOutcome(state, result)
    return result
  }

  /**
   * 记录一次求解的降级状态（8.6 末条的作者提示）与“仍在分摊”状态（8.6 的 C 分支）。
   *
   * 降级计数只在**进入过求解**（`failure === undefined`）且确实降级时累加；任何一次非降级
   * （命中闭式、二分收敛、条件快路径）或前置失败都会把计数清零——“连续”是提示的前提。
   *
   * `truncated` 则相反：它表示“这一轮没算完”，因此**进**集合；下一轮算完就**出**集合。
   * 两条规则互不干扰（降级但算完 → 只清 streak，不进 pending）。
   */
  private noteSolveOutcome(state: EntryState, result: BatchResult): void {
    const key = entityKeyOf(state.kind, state.id)
    if (result.truncated) this.pendingSolve.add(key)
    else this.pendingSolve.delete(key)
    if (result.failure !== undefined || !result.degraded) {
      this.degradedStreak.delete(key)
      return
    }
    const streak = (this.degradedStreak.get(key) ?? 0) + 1
    this.degradedStreak.set(key, streak)
  }

  /**
   * 仍在跨 tick 分摊求解的实体键集合（卡片显示“计算中…”的唯一依据，8.6 的 C 分支）。
   *
   * 只读快照：由每次 `batch()` / 自动购买阶段的结果**自我更新**，
   * 因此不存在“控制器忘了清、按钮永远转圈”的可能。
   */
  pendingSolves(): ReadonlySet<string> {
    return new Set(this.pendingSolve)
  }

  /**
   * 需要提示作者改写价格形状的实体键集合（8.6 末条）。
   *
   * 只读快照：调用方（诊断面板、视图模型）不应修改它。集合在“收敛”或“`reset()`”时收缩。
   */
  rewriteAdvice(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const [key, streak] of this.degradedStreak) {
      if (streak >= REWRITE_ADVICE_TICKS) out.add(key)
    }
    return out
  }

  /**
   * 丢弃动态条目（卡片“丢弃”按钮，8.11 / 8.7）。
   *
   * **立即生效且不经 `EffectSink`**：这是玩家的直接操作，卡片必须立刻从视图消失
   * （8.3.1「丢弃动态条目」行）。
   */
  discardDynamic(id: string): boolean {
    try {
      this.dynamic.destroy(id)
      return true
    } catch {
      return false
    }
  }

  /** 当前页面的条目（静态 + 动态，按 `order` / `createdAt` 排序，8.11）。 */
  entriesOfCurrentPage(): EntryState[] {
    const pageId = this.currentPageId
    if (pageId === SETTINGS_PAGE_ID) return []
    const page = this.attrs.find(entityKeyOf('page', pageId))
    if (!page) return []
    const def = page.def as { entries: { id: string; order: number }[] }
    const ordered = [...def.entries].sort((a, b) => a.order - b.order)
    const out: EntryState[] = []
    for (const entry of ordered) {
      for (const kind of ['resource', 'generator', 'upgrade'] as const) {
        const state = this.attrs.find(entityKeyOf(kind, entry.id))
        if (state) {
          out.push(state)
          break
        }
      }
    }
    // 动态条目：归属当前页面且不可见（孤儿不渲染，8.7）。
    for (const dynamic of this.dynamic.list()) {
      if (dynamic.pageId !== pageId) continue
      out.push(dynamic.state)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // “解锁全部”（D-16）
  // -------------------------------------------------------------------------

  /**
   * 一次性把全部页面/条目的 `visible` 置真、`disabled` 置假（D-16）。
   *
   * `forceUnlock` 是**纯运行时内存标记**：不写项目文件、不写存档、不参与任何结算判定
   * （判定只看属性当前值），只在“被表达式覆盖”与“强制解锁”之间作区分。
   */
  unlockAll(): void {
    for (const kind of ['resource', 'generator', 'upgrade'] as const) {
      for (const state of this.attrs.listByKind(kind)) {
        state.visible = true
        state.disabled = false
        this.forceUnlocked.add(entityKeyOf(kind, state.id))
        this.attrs.write(`${entityKeyOf(kind, state.id)}.visible`, true, '<unlockAll>')
      }
    }
    for (const page of this.attrs.listByKind('page')) {
      const key = entityKeyOf('page', page.id)
      page.visible = true
      page.disabled = false
      this.forceUnlocked.add(key)
      this.attrs.write(`${key}.visible`, true, '<unlockAll>')
      this.attrs.write(`${key}.disabled`, false, '<unlockAll>')
    }
    // 当前页面可能因不可见而被复位到内置设置页，这里重新选一个可见页面。
    this.currentPageId = this.initialPageId()
  }

  /** 某条目是否带强制解锁标记（诊断用）。 */
  isForceUnlocked(entity: string): boolean {
    return this.forceUnlocked.has(entity)
  }

  // -------------------------------------------------------------------------
  // 自动存档游标（8.3 第 8 步、10.3）
  // -------------------------------------------------------------------------

  /** 本帧是否需要写存档。 */
  shouldAutosave(): boolean {
    return this.needsSave
  }

  /** 标记存档已写入。 */
  markSaved(at: number = this.now()): void {
    this.stats.lastSaveAt = at
    this.stats.realElapsed = 0
    this.needsSave = false
  }

  /** 真实经过秒数（自动存档间隔用）。 */
  realElapsedSeconds(): number {
    return this.stats.realElapsed
  }

  // -------------------------------------------------------------------------
  // 辅助
  // -------------------------------------------------------------------------

  /** 项目里已占用的静态 id（四类全局唯一，6.1）。 */
  private staticIds(): Set<string> {
    return collectIds(this.project.resources, this.project.generators, this.project.upgrades, this.project.pages)
  }

  /** 动态条目（序列化与诊断面板用，6.3）。 */
  dynamicEntries(): readonly DynamicEntry[] {
    return this.dynamic.list()
  }

  /** 动态条目总数（2000 上限，D-32）。 */
  dynamicCount(): number {
    return this.dynamic.size()
  }

  /**
   * 某个错误码的累计诊断计数（预览诊断角标，7.1）。
   *
   * 放在 `GameState` 上而不是让调用方直接用 `Diagnostics`，是为了给 UI 一个稳定入口。
   * 注意语义是**进程内累计**（`Diagnostics` 是模块级全局，编辑器里编辑器与预览两个运行时
   * 共享它）；UI 侧在装载新项目时应先 `resetDiagnostics()`，见 `README` 的 M2 说明。
   */
  diagnosticCount(code: ErrorCode): number {
    return Diagnostics.count(code)
  }

  /** 诊断计数快照（`Object.create(null)`，无原型污染路径，见 5.6）。 */
  diagnosticsSnapshot(): Record<string, number> {
    return Diagnostics.countsSnapshot()
  }

  /**
   * 性能采样（12 性能预算末条：诊断面板显示 tick 耗时、求值次数、缓存命中率、格式化次数）。
   *
   * 三类计数分别来自三个包的**唯一**实现：`evaluations`/`cacheHits` 取自本包的
   * `ExpressionRuntime`（包住 `Evaluator` 的 tick 计数），`compile*` 取自 `expr` 的全局编译缓存，
   * `formats` 取自 `num` 的格式化 LRU。运行侧算好再上报，宿主不自己复算（ADR-03）。
   */
  perfSnapshot(): PerfPayload {
    const evaluations = this.runtime.evaluations()
    const cacheHits = this.runtime.cacheHits()
    const denominator = cacheHits + evaluations
    const compiled = compileCacheStats()
    const formats = formatStats()
    return {
      evaluations,
      cacheHits,
      cacheHitRate: denominator === 0 ? 0 : cacheHits / denominator,
      compileHitRate: compiled.hitRate,
      compileCacheSize: compiled.size,
      formats: formats.calls,
      formatCacheSize: formats.cacheSize,
      budgetExhausted: this.runtime.budgetExhausted(),
    }
  }

  /**
   * 孤儿动态条目 id（`pageId` 指向已删除页面，7.1 末条、8.7）。
   *
   * 这些条目**保留在存档与内存中**（6.3 读档顺序 ②）、**不渲染**（因此拿不到卡片上的
   * “丢弃”按钮）、不产出也不参与仪表盘。诊断面板是它们唯一的处置入口。
   */
  orphanIds(): string[] {
    return this.dynamic.orphans().map((entry) => entry.id)
  }

  /** 动态上限常量（UI 提示用）。 */
  static readonly DYNAMIC_LIMIT = DYNAMIC_LIMIT
}

/** `GameState` 满足 `PurchaseDeps` / `ProductionDeps` / `EffectDeps` 的结构化子集。 */
export interface GameLike {
  attrs: AttributeStore
  runtime: ExpressionRuntime
  judge: VisibilityJudge
}

/** 生成器的 `buyDelay`（D-04；只读实现细节字段）。 */
export function buyDelayOf(state: EntryState): number {
  return Math.max(1, Math.floor(state.buyDelay))
}

/** 升级的 `perSecond` 开关（PRD 升级编辑器 11）。 */
export function upgradeDefPerSecond(state: EntryState): boolean {
  return perSecondDef(state)
}

/**
 * `Effect.value` 的静态类型比 `Value` 宽（含 `number` 与 `ConstantValue[]`），
 * 因为 `create()` 的 spec 会以常量形式挂在同一条结构上。真正写进 `AttributeStore`
 * 的 `set` 副作用只可能带 `Value`，这里做一次收敛：非 `Value` 的载荷按字符串处理
 * （`set()` 的载荷要么是属性值、要么是 `set()` 的字面量路径）。
 */
function toWriteValue(value: Effect['value']): Value {
  if (value === undefined) return 'null'
  if (typeof value === 'number') return Num.fromNumber(value)
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'cmp' in value) return value as Decimal
  // 对象/数组：不是合法的属性值，按“无法赋值的文本”处理并记 `E_ASSIGN_TYPE`。
  return JSON.stringify(value)
}

/** 从任意抛出的值取错误码（`ForgeError` 带 `code`；否则用兜底码）。 */
function forgeCode(error: unknown, fallback: ErrorCode): ErrorCode {
  if (error instanceof ForgeError) return error.code
  return fallback
}

/** 错误消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { BuyMode }
