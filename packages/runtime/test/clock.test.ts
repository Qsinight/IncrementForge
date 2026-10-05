/**
 * 帧时钟与时间基准（TECH_DESIGN 8.2、12 性能预算、D-31、R-20、R-21、R-29）。
 *
 * `FrameClock` 是**纯算术**的：它只接收一个 `now`（ms），不碰 `requestAnimationFrame`
 * （3.2：`packages/*` 不得依赖 DOM），rAF 由 M4/M5 的外壳提供。这让倍速、掉帧、
 * 标签页切后台这些时序可以在这里被确定性地断言。
 */
import { describe, expect, it } from 'vitest'

import { MAX_STEPS_PER_FRAME, FrameClock, seconds } from '../src/clock.js'

/** `tickRate` 20（默认）下的配置。 */
const CONFIG = { tickRate: 20, speed: 1, maxFrameStep: 1000 }

describe('8.2 帧时钟：步数切分', () => {
  it('第一帧只对齐基准，不产生 tick', () => {
    const clock = new FrameClock(CONFIG)
    const plan = clock.advance(1000)
    expect(plan.count).toBe(0)
    expect(plan.droppedBacklog).toBe(false)
  })

  it('60fps 帧长（16.7ms）在 20 tick/s 下每 3 帧出 1 tick', () => {
    const clock = new FrameClock(CONFIG)
    let now = 0
    clock.advance(now)
    const counts: number[] = []
    for (let i = 0; i < 30; i += 1) {
      now += 1000 / 60
      counts.push(clock.advance(now).count)
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10)
    expect(Math.max(...counts)).toBe(1)
  })

  it('恰好一个 tick 周期（50ms）稳定出 1 tick', () => {
    const clock = new FrameClock(CONFIG)
    let now = 0
    clock.advance(now)
    for (let i = 0; i < 10; i += 1) {
      now += 50
      expect(clock.advance(now).count, `第 ${i} 帧`).toBe(1)
    }
  })

  it('不足一个周期的余量会累积，不会被丢掉', () => {
    const clock = new FrameClock(CONFIG)
    let now = 0
    clock.advance(now)
    // 每帧 10ms：5 帧攒出 1 tick（50ms），中间 4 帧 count = 0。
    const counts: number[] = []
    for (let i = 0; i < 10; i += 1) {
      now += 10
      counts.push(clock.advance(now).count)
    }
    expect(counts).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })
})

describe('8.2 暂停与切后台', () => {
  it('`realDtMs ≤ 0`（暂停/时钟回拨）时出 0 tick 且不累积', () => {
    const clock = new FrameClock(CONFIG)
    clock.advance(1000)
    expect(clock.advance(1000).count).toBe(0)
    // 墙钟倒流（标签页、系统时间被改）。
    const back = clock.advance(500)
    expect(back.count).toBe(0)
    expect(back.realDtMs).toBe(0)
    // 恢复后按正常节奏继续，不会因为倒流而“补 tick”：从 500 到 1050 只过了 550ms
    // 的**有效**墙钟（1000 -> 500 被判为倒流、不计时），但 500 -> 1050 才是 550ms，
    // 因此这里再走 50ms 才刚好凑出一个 tick。
    expect(clock.advance(1050).count).toBe(11)
    expect(clock.advance(1100).count).toBe(1)
  })

  it('长帧被 `maxFrameStep` 截断（切后台 30 秒回来不会追 600 tick）', () => {
    const clock = new FrameClock(CONFIG)
    clock.advance(0)
    const plan = clock.advance(30_000)
    // 截断到 1000ms -> 1000/50 = 20 tick。
    expect(plan.count).toBe(20)
    expect(plan.realDtMs).toBe(1000)
    expect(plan.droppedBacklog).toBe(false)
  })
})

describe(`12 性能预算：单帧最多 ${MAX_STEPS_PER_FRAME} tick`, () => {
  it('积压超过上限时丢弃并标记 `droppedBacklog`', () => {
    // `maxFrameStep` 放到很大，让一帧真的能算出超过 512 个 tick。
    const clock = new FrameClock({ tickRate: 20, speed: 1, maxFrameStep: 10_000_000 })
    clock.advance(0)
    const plan = clock.advance(10_000_000)
    expect(plan.count).toBe(MAX_STEPS_PER_FRAME)
    expect(plan.droppedBacklog).toBe(true)
  })

  it('丢弃积压后不留下“大尾巴”：下一帧最多多出 1 tick', () => {
    const clock = new FrameClock({ tickRate: 20, speed: 1, maxFrameStep: 10_000_000 })
    clock.advance(0)
    clock.advance(10_000_000)
    // 关键：积压被压到**至多一个 step**（而不是清零，也不是留着一大截）。
    // 留一格是为了避免“每帧都差一点点”的长期漂移；留一大截会让之后每帧再次打满上限。
    const next = clock.advance(10_000_000 + 50)
    expect(next.count).toBe(2)
    expect(next.droppedBacklog).toBe(false)
    // 再走一帧就回到严格的 1 tick。
    expect(clock.advance(10_000_000 + 100).count).toBe(1)
  })
})

describe('D-31 / R-29：倍速只累积游戏内时间', () => {
  it('10x 倍速下墙钟 1 秒切出 200 个 tick（游戏内 10 秒）', () => {
    const clock = new FrameClock({ ...CONFIG, speed: 10 })
    clock.advance(0)
    // 20 tick/s × 10 倍 = 200 tick/秒；1 秒墙钟 = 1000ms -> 1000/50 × 10。
    const plan = clock.advance(1000)
    expect(plan.count).toBe(200)
    // `realShareMs` 把真实时间**均摊**到这一帧的每个 tick：1s / 200 = 5ms。
    // `stats.realElapsed` 只按它累加，因此总真实时间仍然是 1 秒（D-31）。
    expect(plan.realShareMs).toBeCloseTo(5, 9)
  })

  it('倍速不改变单 tick 的 `stepMs`（`dt` 恒为 1/tickRate）', () => {
    const clock = new FrameClock({ ...CONFIG, speed: 10 })
    expect(clock.advance(0).stepMs).toBe(50)
    expect(clock.advance(100).stepMs).toBe(50)
  })

  it('`configure()` 可运行时改倍速，下一帧生效', () => {
    const clock = new FrameClock(CONFIG)
    clock.advance(0)
    expect(clock.advance(100).count).toBe(2)
    clock.configure({ speed: 2 })
    expect(clock.current().speed).toBe(2)
    // 100ms × 2 = 200ms 游戏内时间 -> 4 tick。
    expect(clock.advance(200).count).toBe(4)
  })

  it('`tickRate` 可改，`stepMs` 随之变化', () => {
    const clock = new FrameClock({ ...CONFIG, tickRate: 50 })
    expect(clock.advance(0).stepMs).toBe(20)
    clock.advance(1000)
    expect(clock.advance(1100).count).toBe(5)
  })

  it('`resetAccumulator()` 丢弃全部积压（8.12“返回游戏/重新开始”）', () => {
    const clock = new FrameClock(CONFIG)
    clock.advance(0)
    clock.advance(30) // 累积 30ms
    clock.resetAccumulator()
    // 之前攒的 30ms 没了：再过 30ms 仍然不足一个 tick。
    expect(clock.advance(60).count).toBe(0)
    expect(clock.advance(110).count).toBe(1)
  })
})

describe('`seconds()` 辅助', () => {
  it('把 JS 秒数转成 `Decimal` 秒数', () => {
    expect(seconds(1.5).toNumber()).toBe(1.5)
    expect(seconds(0).toNumber()).toBe(0)
  })
})
