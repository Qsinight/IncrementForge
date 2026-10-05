/**
 * `GameController` —— 运行时侧的**唯一**状态机（TECH_DESIGN 8.2、8.3、8.3.1、9.2、9.3）。
 *
 * ## 它是什么
 *
 * 宿主（`apps/editor`）与游戏视图之间的**全部**交互都经过这里：`host:init` / `host:patch` /
 * `host:control` / `host:save` 进入，`game:ready` / `game:stats` / `game:event` / `game:save` /
 * `game:error` 出去。把这段编排放在**宿主之外**的独立类里（而不是塞进 iframe 的 React 组件）有三个好处：
 *
 * 1. **可脱离 DOM 测试**：`requestFrame`/`now`/`wallClock` 全部可注入，因此
 *    “交互在两次 tick 之间发生、副作用到下一个提交阶段才生效”（8.3.1）能用假时钟精确断言；
 * 2. **打包态可复用**（ADR-05、11.1）：打包版没有 `postMessage`，但 `GameController` 逻辑一致，
 *    只是 `Sink` 换成写 `localStorage`（M5）；
 * 3. **协议与状态机分层**：`bridge.ts` 只做收发与校验（9.2/R-19），`controller.ts` 只做状态推进。
 *
 * ## 主循环（8.2）
 *
 * ```
 * frame(now):                      // now = rAF 提供的单调墙钟（performance.now，R-20）
 *   if paused → 仅重建视图，返回     // 保留渲染与交互（7.1、8.3.1）
 *   plan = clock.advance(now)       // 8.2 的单帧最大步长 + MAX_STEPS_PER_FRAME + 丢弃积压
 *   for i in 1..plan.count: stepTick(plan.stepMs, plan.realShareMs)   // 8.3 的 1~8 步
 * ```
 *
 * 暂停时**不**调用 `clock.advance()`：那会让累加器在暂停期间继续堆积，恢复瞬间爆发
 * `MAX_STEPS_PER_FRAME` 个 tick。改为清空累加器，恢复后第一帧只对齐时间基准（8.2「暂停时只返回
 * 0 步，保留渲染」）。
 */
import { Diagnostics } from '@iforge/num'
import { saveFileSchema } from '@iforge/model'
import type { SaveFile, ProjectFile, ProjectSettings } from '@iforge/model'

import {
  applyProjectPatch,
  buildViewModel,
  GameState,
  resetViewModelCache,
  restoreSave,
  serializeSave,
  settleOffline,
  THEME_FOLLOW_PAGE,
} from '@iforge/runtime'
import type {
  EntryState,
  GameErrorPayload,
  GameEventPayload,
  GameSavePayload,
  GameViewModel,
  HostControlAction,
  HostPatch,
  InitPayload,
  OfflineReport,
  StatsPayload,
} from '@iforge/runtime'

/** 设备断点（D-41 表：`auto` 由宿主按容器宽度折算成具体列数）。 */
export const DEVICE_MAX_COLUMNS: Readonly<Record<string, number>> = { phone: 1, tablet: 2, desktop: 3 }

/** `GameController` 的构造选项。 */
export interface ControllerOptions {
  project: ProjectFile
  save?: SaveFile | null
  settingsOverride?: Partial<ProjectSettings>
  /**
   * 会话级页面主题覆盖（内置设置页的“页面主题”开关，8.10）。
   *
   * 与 `settingsOverride` 同一层：玩家/预览者的偏好，**不**进项目文件、不进存档
   * （D-22 的分层）。打包态由 `local-sink.ts` 从 `localStorage` 读回来注入这里。
   */
  themeOverride?: string
  projectId?: string
  slotId?: string
  /** 引擎版本（写进 `SaveFile.engineVersion` 与 `game:ready`，9.2）。 */
  engineVersion: string
  /** 墙钟（ms，`Date.now`）——离线结算与存档时间戳用它（R-20 的墙钟侧）。 */
  wallClock: () => number
  /** 单调时钟（ms，`performance.now`）——主循环用它，**不受改系统时间影响**（8.2/R-20）。 */
  now: () => number
  requestFrame: (callback: (now: number) => void) => number
  cancelFrame: (handle: number) => void
  /** 运行时所在的 document（“导入存档”的文件选择器需要；测试可省略）。 */
  document?: Document
}

/** 出站消息（9.2 的 `game:*`）。 */
export interface ControllerSink {
  ready(payload: { engineVersion: string; warnings: string[] }): void
  stats(payload: StatsPayload): void
  event(payload: GameEventPayload): void
  save(payload: GameSavePayload): void
  error(payload: GameErrorPayload): void
}

/** 视图重建的节流间隔（8.11「随 tick 增量更新」与 12 性能预算的折中）。 */
export const VIEW_INTERVAL_MS = 100

export class GameController {
  readonly state: GameState
  /**
   * 出站通道。
   *
   * 默认是**空实现**而不是构造参数：预览桥（`bridge.ts`）必须在控制器**之后**建立——
   * 桥要拿到 `sessionId` 才能构造信封，而 `sessionId` 由桥自己生成。因此改成 `setSink()`
   * 注入（见 `createPreviewRuntime()`）。
   *
   * 空实现期间丢弃消息是安全的：控制器构造、`loadProject()`、`restore()` 都不发消息
   * （会发消息的只有 `start()` 里的 `game:ready` 与诊断上报，而诊断只在 `applyInit()`
   * 之后才可能触发——那时 sink 必然已挂上）。
   */
  private sink: ControllerSink = NOOP_SINK
  private readonly options: ControllerOptions
  private readonly listeners = new Set<() => void>()

  private view: GameViewModel
  private frameHandle: number | null = null
  private running = false
  private lastViewAt = -Infinity
  private lastStatsAt = -Infinity
  private lastFrameAt = 0
  private tickMs = 0
  private fps = 0
  private frameCount = 0
  private fpsWindowStart = 0
  private offlineReport: OfflineReport | null = null
  /**
   * 会话级页面主题覆盖（8.10：`THEME_FOLLOW_PAGE` = 跟随作者设定）。
   *
   * 放在控制器而不是 `GameState`：它是**观感偏好**，不参与任何结算，
   * `GameState` 的字段清单（8.1）也因此保持“游戏状态”这一单一语义。
   */
  private themeOverride: string | undefined
  private disposed = false

  constructor(options: ControllerOptions) {
    this.options = options
    this.state = new GameState({
      project: options.project,
      slotId: options.slotId ?? 'main',
      projectId: options.projectId ?? 'iforge-local-project',
      // `GameState` 用墙钟记存档时间戳与动态条目的 `createdAt`；主循环的时间累积
      // 在 `controller.frame()` 里用单调钟，两者**刻意**分开（R-20）。
      now: options.wallClock,
      nowIso: () => new Date(options.wallClock()).toISOString(),
    })
    if (options.settingsOverride) this.state.settingsOverride = { ...options.settingsOverride }
    this.themeOverride = coerceThemeOverride(options.themeOverride)

    // 诊断 -> `game:error`（9.3 第 3 步：运行时错误上报，宿主显示角标）。
    Diagnostics.onDiagnostic((diagnostic) => {
      this.sink.error({
        code: diagnostic.code,
        message: diagnostic.message ?? '',
        where: diagnostic.where,
        tick: this.state.stats.tick,
      })
    })

    if (options.save) this.restore(options.save)
    this.view = buildViewModel(this.state, this.viewContext())
  }

  /** 注入出站通道（预览桥建立后调用，见类注释）。 */
  setSink(sink: ControllerSink): void {
    this.sink = sink
  }

  // -------------------------------------------------------------------------
  // 视图订阅（React `useSyncExternalStore` 的来源）
  // -------------------------------------------------------------------------

  /** 订阅视图重建；返回退订函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 当前视图模型（8.11 组件树的唯一数据源）。 */
  getView(): GameViewModel {
    return this.view
  }

  /** 重建视图并通知订阅者。 */
  refresh(): void {
    if (this.disposed) return
    this.view = buildViewModel(this.state, this.viewContext())
    for (const listener of this.listeners) listener()
  }

  /** 视图上下文（含离线报告、性能采样、分摊中的条目）。 */
  private viewContext() {
    return {
      offline: this.offlineReport,
      // 8.6 的 C 分支 -> 卡片“计算中…”。**唯一来源是 `GameState`**，不在控制器里另存一份：
      // 控制器持有过的那个 `Set` 只在“下一次购买不降级”时才被清掉，而交互路径每次点击
      // 都拿到一份全新预算、`degraded` 恒为真 —— 于是第一次点击后按钮永远停在“计算中…”，
      // 而实际上那一刻的求解已经算完了（`truncated = false`）。
      calculating: this.state.pendingSolves(),
      // 8.6 末条的作者提示：连续降级 60 tick 的条目在卡片与诊断面板上追加改写建议。
      rewriteAdvice: this.state.rewriteAdvice(),
      tickMs: this.tickMs,
      fps: this.fps,
      savedAt: this.state.stats.lastSaveAt,
      perf: this.state.perfSnapshot(),
      // 8.10：页面主题偏好与 settings 同层，经视图上下文交给 `buildViewModel` 解析生效值。
      themeOverride: this.themeOverride,
    }
  }

  // -------------------------------------------------------------------------
  // 主循环（8.2）
  // -------------------------------------------------------------------------

  /** 启动主循环并发出 `game:ready`（9.3 第 2 步）。 */
  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    this.lastFrameAt = this.options.now()
    this.fpsWindowStart = this.lastFrameAt
    this.frameCount = 0
    this.state.clock.configure({ speed: this.state.flags.speed })
    this.sink.ready({ engineVersion: this.options.engineVersion, warnings: collectWarnings() })
    this.schedule()
  }

  /** 停循环（9.3 第 4 步：关闭项目/卸载时释放 tick）。 */
  stop(): void {
    this.running = false
    if (this.frameHandle !== null) {
      this.options.cancelFrame(this.frameHandle)
      this.frameHandle = null
    }
  }

  /** 彻底释放（销毁 iframe 时调用）。 */
  dispose(): void {
    this.stop()
    this.disposed = true
    this.listeners.clear()
  }

  private schedule(): void {
    if (!this.running) return
    this.frameHandle = this.options.requestFrame((now) => {
      this.frameHandle = null
      this.frame(now)
      this.schedule()
    })
  }

  /**
   * 一帧（8.2）。
   *
   * 拆成 `frame()`（纯算术，可直接测）与 rAF 回调分离，是为了让测试能用固定时间戳序列驱动，
   * 不依赖真实的 `requestAnimationFrame` 时序。
   */
  frame(now: number): void {
    if (this.disposed) return
    this.sampleFps(now)
    this.state.clock.configure({ speed: this.state.flags.speed })

    if (!this.state.flags.paused) {
      const plan = this.state.clock.advance(now)
      const startedAt = now
      for (let index = 0; index < plan.count; index += 1) {
        this.state.stepTick(plan.stepMs, plan.realShareMs)
      }
      // 本帧没有任何 tick 时，那段真实时间没有 `stepTick` 可以分摊，必须显式补记——
      // 否则 `realElapsed` 只按“有 tick 的帧”累加，自动存档间隔会变成真实时长的数倍（D-31/D-35）。
      if (plan.count === 0) this.state.advanceRealTime(plan.realDtMs)
      // 8.2 的 `MAX_STEPS_PER_FRAME` 兜底在 `FrameClock.advance()` 内已完成（丢弃积压）。
      this.tickMs = plan.count > 0 ? Math.max(0, this.options.now() - startedAt) / plan.count : 0
      this.runAutosave()
    } else {
      // 暂停：清空累加器而不是让它堆积（见文件头注释）。渲染与交互保留（7.1、8.3.1）。
      this.state.clock.resetAccumulator()
    }

    this.lastFrameAt = now
    this.maybeRebuildView(now)
    this.maybeReportStats(now)
  }

  /** fps 采样（12 性能预算的“渲染 60fps”一项，按秒窗口统计）。 */
  private sampleFps(now: number): void {
    this.frameCount += 1
    const windowMs = now - this.fpsWindowStart
    if (windowMs >= 1000) {
      this.fps = (this.frameCount * 1000) / windowMs
      this.frameCount = 0
      this.fpsWindowStart = now
    }
  }

  /**
   * 视图重建的节流（8.11 末条“随 tick 增量更新”，12 性能预算“仅变化卡片更新”）。
   *
   * 节流到 10Hz 的理由：`buildViewModel()` 会求值当前页每条卡片的价格/产量/条件/效果，
   * 在数百条目下每帧都跑一遍会把 60fps 的预算吃光；而 100ms 的视觉延迟对这种数字面板
   * 不可感知。交互事件（`click`/`buy`/…）会**强制**立即重建，见 `settleInteraction()`。
   */
  private maybeRebuildView(now: number, force = false): void {
    if (!force && now - this.lastViewAt < VIEW_INTERVAL_MS) return
    this.lastViewAt = now
    this.refresh()
  }

  /** `game:stats` 的 ≤10Hz 节流上报（9.2）。 */
  private maybeReportStats(now: number): void {
    if (now - this.lastStatsAt < VIEW_INTERVAL_MS) return
    this.lastStatsAt = now
    const dashboard = this.view.dashboard
    this.sink.stats({
      rates: dashboard.resources.map((resource) => ({ id: resource.id, amount: resource.amount, rate: resource.rate })),
      nextBuy: dashboard.nextBuy,
      tickMs: this.tickMs,
      fps: this.fps,
      // 12 性能预算末条与 8.6 末条都走 ≤10Hz 的这条通道，不另开 kind：
      // 三者（性能采样、孤儿列表、改写建议）都是“给宿主看的低频快照”，
      // 开三个新 kind 只会让 9.2 的表和两端的 switch 都膨胀。
      perf: this.state.perfSnapshot(),
      orphans: this.state.orphanIds(),
      advice: [...this.state.rewriteAdvice()],
    })
  }

  // -------------------------------------------------------------------------
  // 自动存档（8.3 第 8 步、10.3）
  // -------------------------------------------------------------------------

  /** 自动存档（按**真实**秒数，不随倍速加速，D-31）。 */
  private runAutosave(): void {
    if (!this.state.shouldAutosave()) return
    this.sink.save({ save: this.exportSave(), intent: 'autosave' })
    this.state.markSaved()
  }

  /**
   * 玩家点击“导出存档”（PRD 预览区 9）。
   *
   * 走 `game:save{intent:'export'}` 让**宿主**下载，而不是运行时自己下载：9.1 的 iframe
   * 是 `sandbox="allow-scripts"` 的不透明源，浏览器会拦截其中的文件下载
   * （需要 `allow-downloads`，而 9.1 明确没给）。宿主在编辑器的上下文中下载，天然带用户手势。
   */
  requestExportSave(): void {
    this.sink.save({ save: this.exportSave(), intent: 'export' })
  }

  /**
   * 玩家点击“导入存档”（PRD 预览区 9）。
   *
   * 文件选择器在运行时**自己**创建（而不是请宿主代劳）：`input[type=file]` 的点击只需要
   * 用户手势，不需要 `allow-same-origin`，因此在沙箱里可用；而走宿主要多加一种消息 kind。
   * 元素取到文件后立即移除，避免在预览里留下作者看不见的 DOM（D-42）。
   */
  requestImportSave(): void {
    const doc = this.options.document
    if (!doc) {
      Diagnostics.record('E_MSG_INVALID', 'ui', '当前环境没有 document，无法打开文件选择器')
      return
    }
    const input = doc.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    input.onchange = () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) return
      void file.text().then((text) => this.applyImportSaveText(text))
    }
    doc.body.append(input)
    input.click()
  }

  /**
   * 导入存档文本（10.2「导入存档」：Zod 校验 → 覆盖当前进度 → 触发一次离线结算预览）。
   *
   * 校验失败**不**改动任何状态：损坏的存档不能把正在玩的这一局打烂。失败记
   * `E_SCHEMA`/`E_VERSION` 并通过 `game:error` 上报，宿主显示角标。
   */
  applyImportSaveText(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      Diagnostics.record('E_SCHEMA', 'importSave', `存档不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const result = saveFileSchema.safeParse(parsed)
    if (!result.success) {
      Diagnostics.record('E_SCHEMA', 'importSave', `存档校验失败：${result.error.issues[0]?.path?.join('.') ?? '未知字段'}`)
      return
    }
    this.importSave(result.data as SaveFile)
  }

  /** 导出存档（6.3；`currentPageId` 与游戏内设置**不进存档**，D-50/D-22）。 */
  exportSave(): SaveFile {
    return serializeSave(this.state, {
      projectId: this.options.projectId ?? 'iforge-local-project',
      projectName: this.state.project.meta.name,
      slotId: this.options.slotId ?? 'main',
      engineVersion: this.options.engineVersion,
      now: () => new Date(this.options.wallClock()).toISOString(),
    })
  }

  /**
   * 读档并结算离线收益（10.2「导入存档」、8.8）。
   *
   * 顺序固定为“先恢复存档、再离线结算”——`settleOffline` 要用存档里的 `savedAt`/
   * `lastSeenAt` 与恢复后的产出速率，颠倒会让离线时长算在错误的资源基线上。
   */
  private restore(save: SaveFile): void {
    const nowMs = this.options.wallClock()
    const savedAt = Date.parse(save.savedAt)
    const lastSeenAt = Date.parse(save.lastSeenAt)
    restoreSave(this.state, save, { project: this.state.project })
    resetViewModelCache()
    if (Number.isNaN(savedAt)) return
    this.offlineReport = settleOffline(this.state, savedAt, Number.isNaN(lastSeenAt) ? savedAt : lastSeenAt, nowMs)
  }

  /** 导入存档（PRD 预览区 9 的“导入存档”按钮，10.2：校验 -> 覆盖当前进度 -> 离线结算预览）。 */
  importSave(save: SaveFile): void {
    this.state.reset()
    this.restore(save)
    this.settleInteraction({ type: 'settings', payload: { imported: true } })
  }

  // -------------------------------------------------------------------------
  // host:* 入站（9.2、7.4、9.3）
  // -------------------------------------------------------------------------

  /** `host:init`（9.3 第 1 步）：装入项目（可带存档）。 */
  applyInit(payload: InitPayload): void {
    resetViewModelCache()
    this.offlineReport = null
    this.state.loadProject(payload.project)
    this.state.settingsOverride = (payload.settings as Partial<ProjectSettings>) ?? {}
    this.state.clock.configure({
      tickRate: this.state.effectiveSettings().tickRate,
      maxFrameStep: this.state.effectiveSettings().maxFrameStep,
    })
    this.state.reset()
    if (payload.save) this.restore(payload.save)
    this.refresh()
  }

  /** `host:patch`（7.4）：条目级增量热更新，保留运行时进度。 */
  applyPatches(patches: readonly HostPatch[]): void {
    let applied = 0
    for (const patch of patches) {
      if (applyProjectPatch(this.state, patch)) applied += 1
    }
    // 结构变了就重建一次：条目/页面的增删改会改变卡片集合。
    if (applied > 0) this.refresh()
  }

  /** `host:control`（9.2 的模拟设置栏与游戏内设置）。 */
  applyControl(action: HostControlAction, value?: unknown): void {
    switch (action) {
      case 'pause':
        this.state.flags.paused = true
        break
      case 'resume':
        this.state.flags.paused = false
        // 恢复时丢弃暂停期间积压的时间（8.2/8.3.1：暂停期没有提交阶段）。
        this.state.clock.resetAccumulator()
        break
      case 'restart':
        this.state.reset()
        this.offlineReport = null
        resetViewModelCache()
        this.refresh()
        return
      case 'speed': {
        const speed = Number(value)
        if (!Number.isFinite(speed) || speed <= 0) break
        this.state.flags.speed = speed
        this.state.clock.configure({ speed })
        break
      }
      case 'unlockAll':
        // D-16：一次性置真 visible / 置假 disabled；`forceUnlock` 是纯内存标记，不落盘。
        this.state.unlockAll()
        this.refresh()
        return
      case 'device':
        // 9.1：设备模拟只改宿主侧的容器宽度与 `pointer: coarse`，不参与任何结算。
        break
      case 'settings':
        this.state.settingsOverride = { ...(value as Partial<ProjectSettings> | undefined) }
        this.state.clock.configure({
          tickRate: this.state.effectiveSettings().tickRate,
          maxFrameStep: this.state.effectiveSettings().maxFrameStep,
        })
        this.refresh()
        return
      case 'discard': {
        // 7.1 末条：诊断面板对孤儿动态条目的“丢弃”。与卡片按钮走**同一个** `discard()`，
        // 因此两条路径的语义（立即生效、不经 `EffectSink`）不可能分叉。
        // 丢弃成功/失败都回传 `game:event{type:'discard'}`，宿主据此把列表刷新。
        const id = typeof value === 'string' ? value : ''
        if (id.length > 0) this.discard(id)
        this.refresh()
        return
      }
    }
    this.refresh()
  }

  // -------------------------------------------------------------------------
  // 交互（8.3.1）
  // -------------------------------------------------------------------------

  /**
   * 交互的统一收口：**状态字段即时结算**，副作用进 `EffectSink` 等**下一个**提交阶段。
   *
   * 交互后**立即重建视图**（而不是等 10Hz 节流）：PRD 要求“改名称立即同步到预览”（7.4），
   * 而点击/购买后的反馈延迟同样不该被节流掩盖。副作用的延迟由 8.3.1 明确承担，
   * 这里不做任何“即时提交旁路”。
   */
  private settleInteraction(event: GameEventPayload): void {
    this.maybeRebuildView(this.options.now(), true)
    this.sink.event(event)
  }

  /** 点击器点击（8.5 `click`）。 */
  click(generatorId: string): void {
    const outcome = this.state.click(generatorId)
    this.settleInteraction({ type: 'click', target: generatorId, payload: { ok: outcome.ok } })
  }

  /** 购买（8.6：按 `buyAmount` 走 `count`/`max`/`free` 三态）。 */
  buy(id: string): void {
    const entry = this.findBuyable(id)
    const result = entry ? this.state.batch(id) : null
    if (!entry || !result) {
      this.settleInteraction({ type: 'buy', target: id, payload: { k: '0' } })
      return
    }
    // 8.6 的 C 分支：是否还在跨 tick 分摊由 `GameState.pendingSolves()` 回答（只认
    // `truncated`），控制器不再自己维护一份会“置真之后再没人清”的状态。
    this.settleInteraction({ type: 'buy', target: id, payload: { k: result.k.toString() } })
  }

  /** 丢弃动态条目（PRD 预览区 6、8.7：卡片右上角；**立即生效且不经 `EffectSink`**）。 */
  discard(id: string): void {
    const ok = this.state.discardDynamic(id)
    this.settleInteraction({ type: 'discard', target: id, payload: { ok } })
  }

  /** 页面跳转（8.12：唯一入口 `nav()`，不校验可见/禁用）。 */
  navigate(pageId: string): void {
    const ok = this.state.nav(pageId)
    this.settleInteraction({ type: 'nav', target: pageId, payload: { ok } })
  }

  /** 游戏内设置变更（8.10/D-22：只写会话覆盖 + 上报，绝不写项目文件）。 */
  setGameSetting(key: string, value: string): void {
    const override = { ...this.state.settingsOverride } as Record<string, unknown>
    const coerced = coerceSetting(key, value)
    if (coerced === null) {
      // 归一化失败：不写入、保持 last-good。不这么做的话 `tickRate = "abc"` 会让
      // `1000 / tickRate` 得到 NaN，主循环**静默停摆**——表现为“预览不动了且没有报错”。
      Diagnostics.record('E_ASSIGN_TYPE', `settings.${key}`, `设置项 ${key} 不接受 "${value}"`)
      this.settleInteraction({ type: 'settings', payload: { [key]: value, rejected: true } })
      return
    }
    // 改回项目默认值 = 撤销覆盖（D-22 的“恢复默认设置”按钮也是这条路径）。
    // 这里必须把 `removed` 一并回传：`payload` 只带 `{key: value}` 时，
    // 打包态的落盘侧无法区分“这一项被改成了 layered”和“这一项的覆盖被撤销了”。
    const removed: string[] = []
    if (String(this.state.project.settings[key as keyof ProjectSettings]) === value) {
      delete override[key]
      removed.push(key)
    } else {
      override[key] = coerced
    }
    this.state.settingsOverride = override as Partial<ProjectSettings>
    this.state.clock.configure({
      tickRate: this.state.effectiveSettings().tickRate,
      maxFrameStep: this.state.effectiveSettings().maxFrameStep,
    })
    this.settleInteraction({ type: 'settings', payload: removed.length > 0 ? { [key]: value, removed } : { [key]: value } })
  }

  /**
   * 设置会话级页面主题（内置设置页的“页面主题”开关，8.10）。
   *
   * 与 `setGameSetting` 同样的两条纪律：
   *
   * 1. **只写会话覆盖，绝不写项目文件**（D-22/R-24）——玩家的观感偏好不该改写
   *    作者为每个页面设定的主题；
   * 2. **非法值不写入、保持 last-good 并记诊断**。覆盖值只接受 17.4 的内置**页面**
   *    主题（`builtin:page-*`）或“跟随页面”（`THEME_FOLLOW_PAGE`）：
   *    自定义主题是 CSS 文本（`data:`/`asset:`），让玩家在设置页里随手切换一段
   *    未经 `sanitizeTheme` 的 CSS 会绕开 13 第 5 条的安全过滤。
   */
  setThemeOverride(value: string): void {
    const coerced = coerceThemeOverride(value)
    if (coerced === undefined) {
      Diagnostics.record('E_ASSIGN_TYPE', 'theme', `页面主题不接受 "${value}"（只允许内置页面主题或跟随页面）`)
      this.settleInteraction({ type: 'theme', payload: { theme: value, rejected: true } })
      return
    }
    this.themeOverride = coerced
    this.settleInteraction({ type: 'theme', payload: { theme: coerced } })
  }

  /** 恢复项目默认设置（D-22：清除全部会话覆盖；属 UI 偏好，不清游戏进度）。 */
  resetSettingsDefaults(): void {
    this.state.settingsOverride = {}
    this.state.clock.configure({
      tickRate: this.state.effectiveSettings().tickRate,
      maxFrameStep: this.state.effectiveSettings().maxFrameStep,
    })
    // 页面主题偏好与设置覆盖同属“玩家偏好”，因此“恢复默认”一并清掉它。
    // 清掉后必须再发一条 `theme` 事件：打包态的落盘侧据此删掉 `localStorage` 里的键，
    // 否则刷新后又变回覆盖值（与 `removed` 同一条理由，见 `setGameSetting` 的注释）。
    this.themeOverride = undefined
    this.settleInteraction({ type: 'settings', payload: { reset: true } })
    this.sink.event({ type: 'theme', payload: { theme: THEME_FOLLOW_PAGE } })
  }

  /** 重新开始（8.10：二次确认后 `GameState.reset()`，D-18）。 */
  restart(): void {
    this.state.reset()
    this.offlineReport = null
    resetViewModelCache()
    this.settleInteraction({ type: 'settings', payload: { restarted: true } })
  }

  /** 关闭离线提示条（8.8 末条：玩家可手动关掉，但结算已完成、不可撤销）。 */
  dismissOffline(): void {
    this.offlineReport = null
    this.refresh()
  }

  /** 离线报告（宿主/测试读取，8.8）。 */
  offline(): OfflineReport | null {
    return this.offlineReport
  }

  /** 设备断点给出的最大列数（D-41：`phone` 1 列 / `tablet` 2 列 / `auto` 交给 CSS 断点）。 */
  maxColumnsForDevice(device: string): number {
    return DEVICE_MAX_COLUMNS[device] ?? Number.POSITIVE_INFINITY
  }

  private findBuyable(id: string): EntryState | undefined {
    return this.state.attrs.find(`gen.${id}`) ?? this.state.attrs.find(`up.${id}`)
  }
}

/** 空 sink（`setSink()` 之前）。见 `GameController.sink` 的注释。 */
const NOOP_SINK: ControllerSink = {
  ready: () => undefined,
  stats: () => undefined,
  event: () => undefined,
  save: () => undefined,
  error: () => undefined,
}

/**
 * 设置值的类型收敛（8.10：游戏内设置的六项是异构的）。
 *
 * 文本框给的是字符串，而 `ProjectSettings` 里有数字与布尔。不做收敛的话
 * `tickRate: "20"` 会让 `1000 / tickRate` 得到 `NaN`，主循环直接停摆。
 *
 * @returns 归一化后的值；**无法解释时返回 `null`**，由调用方保持 last-good 并记诊断
 *   （与 5.9.3 的归一化思路一致：失败不写入，而不是写入一个坏值）。
 */
function coerceSetting(key: string, value: string): string | number | boolean | null {
  if (key === 'offlineEnabled') return value === 'true'
  if (key === 'numberFormat') return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  // 三项数值设置都有下界要求（11.1 第 7 条的打包前校验在编辑器侧做，这里兜住游戏内改值）。
  if (key === 'offlineCap' && numeric < 0) return null
  if ((key === 'tickRate' || key === 'maxFrameStep' || key === 'autosaveInterval') && numeric <= 0) return null
  return numeric
}

/** 页面主题的内置 id 前缀（`builtin:page-*`，17.4）。 */
const BUILTIN_PAGE_THEME_PREFIX = 'builtin:page-'

/**
 * 归一化会话级页面主题覆盖（8.10）。
 *
 * 只接受两种形态：`THEME_FOLLOW_PAGE`（不覆盖）与 `builtin:page-*`（17.4 的内置页面主题）。
 * 其余一律拒绝（`undefined`）——理由见 `setThemeOverride` 的注释：自定义主题是
 * **CSS 文本**，走设置页就等于给玩家一条绕过 13 第 5 条过滤的注入路径。
 */
function coerceThemeOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value === THEME_FOLLOW_PAGE) return THEME_FOLLOW_PAGE
  return value.startsWith(BUILTIN_PAGE_THEME_PREFIX) ? value : undefined
}

/** `game:ready` 的 `warnings`（9.2）：把当前诊断聚合成可读提示，让宿主能显示角标。 */
function collectWarnings(): string[] {
  const counts = Diagnostics.countsSnapshot()
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${code} ×${count}`)
}
