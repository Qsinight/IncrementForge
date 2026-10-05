/**
 * 测试夹具：构造可控的 `GameController`（TECH_DESIGN 8.2 主循环、8.3.1 交互边界）。
 *
 * ## 为什么需要假 rAF 与假时钟
 *
 * 8.3.1 的核心语义是“交互落在两次 tick 之间”：状态字段**即时**结算，副作用要等到
 * **下一个**提交阶段。这条性质只有在**完全掌控时间**时才能断言——
 * 真 `requestAnimationFrame` + 真 `performance.now()` 会让用例要么变慢、要么变成概率性断言。
 *
 * 因此这里提供 `ManualFrames`（`requestFrame` 把回调排进队列，由用例显式推进）
 * 与可注入的 `wallClock` / `now`：离线结算用墙钟、主循环用单调钟，两者在 R-20 下**必须**分开。
 */
import { createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import type { ControllerOptions, ControllerSink } from '../../src/controller.js'
import { GameController } from '../../src/controller.js'

/** 手动驱动的帧队列（代替 `requestAnimationFrame`）。 */
export class ManualFrames {
  private queue: ((now: number) => void)[] = []
  /** 已执行过的帧数。 */
  ran = 0

  readonly request = (callback: (now: number) => void): number => {
    this.queue.push(callback)
    return this.queue.length
  }

  readonly cancel = (): void => {
    this.queue = []
  }

  /** 执行当前排队的所有回调（一个“帧”）；`now` 由调用方给，必须单调递增。 */
  pump(now: number): void {
    const batch = this.queue
    this.queue = []
    for (const callback of batch) callback(now)
    this.ran += 1
  }

  /** 推进 `count` 帧，每帧 `stepMs`，返回最后一个时间戳（可作为下次起点）。 */
  pumpFrames(count: number, from: number, stepMs = 16): number {
    let cursor = from
    for (let index = 0; index < count; index += 1) {
      cursor += stepMs
      this.pump(cursor)
    }
    return cursor
  }

  /** 挂起的帧数（0 表示循环已停）。 */
  get pending(): number {
    return this.queue.length
  }
}

/**
 * 出站消息记录器（9.2 的 `game:*`）。
 *
 * 记录数组带 `Log` 后缀是刻意的：同名会与实现方法撞车，而 TS 的 `useDefineForClassFields`
 * 下**字段**覆盖原型方法，于是 `sink.ready(...)` 会变成“数组不是函数”。
 * 这个坑在测试夹具里出现过一次，因此在类型层面就不留同名空间。
 */
export class RecordingSink implements ControllerSink {
  readonly readyLog: { engineVersion: string; warnings: string[] }[] = []
  readonly statsLog: unknown[] = []
  readonly events: Record<string, unknown>[] = []
  readonly saves: { save: unknown; intent?: string }[] = []
  readonly errors: { code: string; message: string; where?: string; tick?: number }[] = []

  ready(payload: { engineVersion: string; warnings: string[] }): void {
    this.readyLog.push(payload)
  }

  stats(payload: unknown): void {
    this.statsLog.push(payload)
  }

  /**
   * 交互事件（9.2 的 `game:event`）。
   *
   * 形参用 `unknown`：控制器按 `ControllerSink` 的声明调用它，而那条声明的载荷是
   * `GameEventPayload`（含 `payload?: Record<…>`）。写窄会让 `implements` 因方法参数
   * 不兼容而报错——记录器本来就该接受任意载荷再原样存下。
   */
  event(payload: unknown): void {
    this.events.push(payload as Record<string, unknown>)
  }

  save(payload: { save: unknown; intent?: string }): void {
    this.saves.push(payload)
  }

  error(payload: { code: string; message: string; where?: string; tick?: number }): void {
    this.errors.push(payload)
  }
}

/** 控制器夹具。 */
export interface ControllerFixture {
  controller: GameController
  frames: ManualFrames
  sink: RecordingSink
  /** 推进墙钟（ms）。 */
  advanceWall(ms: number): void
  /** 当前墙钟。 */
  wall(): number
  /** 启动主循环（会发出 `game:ready`，9.3 第 2 步）。 */
  start(): void
  /** 跑 `frames` 帧并返回结束时的单调时间戳。 */
  runFrames(frames: number, stepMs?: number): void
}

/** 控制器夹具的选项。 */
export interface FixtureOptions {
  project?: ProjectFile
  save?: ControllerOptions['save']
  settingsOverride?: ControllerOptions['settingsOverride']
  /** 会话级页面主题覆盖（8.10）；打包态由 `boot.ts` 从 `localStorage` 注入。 */
  themeOverride?: ControllerOptions['themeOverride']
  startWallAt?: number
}

/** 建立控制器夹具（未启动主循环）。 */
export function makeController(options: FixtureOptions = {}): ControllerFixture {
  const project = options.project ?? createDefaultProject()
  const frames = new ManualFrames()
  let wall = options.startWallAt ?? Date.parse('2026-01-01T00:00:00.000Z')
  let monotonic = 0
  const sink = new RecordingSink()

  const controller = new GameController({
    project,
    save: options.save,
    settingsOverride: options.settingsOverride,
    themeOverride: options.themeOverride,
    projectId: 'test-project',
    slotId: 'main',
    engineVersion: '1.0.0',
    wallClock: () => wall,
    now: () => monotonic,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    document: typeof document === 'undefined' ? undefined : document,
  })
  controller.setSink(sink)

  return {
    controller,
    frames,
    sink,
    advanceWall: (ms) => {
      wall += ms
    },
    wall: () => wall,
    start: () => {
      // `start()` 自身会调用一次 `now()` 作为时间基准；这里先把它推进一格，
      // 否则第一帧的 `now - lastFrameAt` 为 0，`FrameClock` 不会推进任何 tick。
      monotonic = 1
      controller.start()
    },
    runFrames: (count, stepMs = 16) => {
      monotonic = frames.pumpFrames(count, monotonic, stepMs)
    },
  }
}

/** 构造一个 16ms/帧、`20 tick/s` 的标准帧节奏下的推进结果。 */
export const FRAME_MS = 16
