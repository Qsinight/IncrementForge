/**
 * 测试夹具：构造可控的 `GameState`。
 *
 * 与 M1 的 `expr` 夹具思路一致：M2 的语义（tick 时序、结算、存档）不依赖 DOM，
 * 因此可以在 node 环境下直接驱动 `stepTick`。本文件只负责把“项目文件 + 墙钟 + 有效设置”
 * 这三样注入 `GameState`，并提供一些常用的断言辅助。
 */
import { Diagnostics, Num, resetDiagnostics } from '@iforge/num'
import type { Decimal } from '@iforge/num'
import { createDefaultProject, createExampleProject } from '@iforge/model'
import type { GeneratorDef, PageDef, ProjectFile, ResourceDef, UpgradeDef } from '@iforge/model'

import { GameState } from '../../src/game-state.js'
import { entityKeyOf } from '../../src/attribute-store.js'
import { resetRateHistory } from '../../src/dashboard.js'
import { resetMonotonicCache } from '../../src/batch.js'
import type { EntryState } from '../../src/attribute-store.js'

/** 固定墙钟起点，让时间相关的用例可复现。 */
export const T0 = Date.parse('2026-01-01T00:00:00.000Z')

export interface HarnessOptions {
  project?: ProjectFile
  /** 每 tick 的墙钟推进（ms）。默认按 `tickRate` 精确对齐，等价于恒定帧率。 */
  frameMs?: number
}

/** 测试夹具。 */
export class Harness {
  readonly state: GameState
  private clock: number
  private readonly frameMs: number

  constructor(options: HarnessOptions = {}) {
    resetDiagnostics()
    resetMonotonicCache()
    resetRateHistory()
    this.clock = T0
    const project = options.project ?? createExampleProject()
    const stepMs = 1000 / project.settings.tickRate
    this.frameMs = options.frameMs ?? stepMs
    this.state = new GameState({
      project,
      now: () => this.clock,
      nowIso: () => new Date(this.clock).toISOString(),
    })
  }

  /** 推进墙钟。 */
  advanceClock(ms: number): void {
    this.clock += ms
  }

  /** 当前墙钟。 */
  now(): number {
    return this.clock
  }

  /**
   * 跑 `count` 个逻辑帧。
   *
   * 每次调用等价于 `frame(now)`：推进墙钟、按 `tickRate` 切出 tick 批次。
   * 这里**每帧只跑一个 tick**，与 rAF 的 60fps + 20 tick/s 的默认配置一致；
   * 需要一帧多 tick 的场景用 `stepTick` 直接控制。
   */
  runTicks(count: number): void {
    const stepMs = 1000 / this.state.effectiveSettings().tickRate
    for (let i = 0; i < count; i += 1) {
      this.advanceClock(this.frameMs)
      this.state.stepTick(stepMs, this.frameMs)
    }
  }

  /** 跑若干秒的游戏内时间（按 `tickRate` 换算 tick 数）。 */
  runSeconds(seconds: number): void {
    const settings = this.state.effectiveSettings()
    this.runTicks(Math.round(seconds * settings.tickRate))
  }

  /** 推进一帧的完整路径（含 `FrameClock` 的步数计算）。 */
  runFrames(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.advanceClock(this.frameMs)
      const plan = this.state.clock.advance(this.clock)
      for (let k = 0; k < plan.count; k += 1) this.state.stepTick(plan.stepMs, plan.realShareMs)
    }
  }

  /** 资源当前数量。 */
  resource(id: string): Decimal {
    const entity = this.state.attrs.find(entityKeyOf('resource', id))
    if (!entity) throw new Error(`资源 ${id} 不存在`)
    return this.state.attrs.value(entity, 'amount')
  }

  /** 生成器/升级的 `bought` / `owned`。 */
  count(kind: 'generator' | 'upgrade', id: string, attr: 'bought' | 'owned'): Decimal {
    const entity = this.state.attrs.find(entityKeyOf(kind, id))
    if (!entity) throw new Error(`条目 ${id} 不存在`)
    return this.state.attrs.value(entity, attr)
  }

  /** 生成器状态。 */
  generator(id: string): EntryState {
    const entity = this.state.attrs.find(entityKeyOf('generator', id))
    if (!entity) throw new Error(`生成器 ${id} 不存在`)
    return entity
  }

  /** 升级状态。 */
  upgrade(id: string): EntryState {
    const entity = this.state.attrs.find(entityKeyOf('upgrade', id))
    if (!entity) throw new Error(`升级 ${id} 不存在`)
    return entity
  }

  /** 页面状态。 */
  page(id: string): EntryState {
    const entity = this.state.attrs.find(entityKeyOf('page', id))
    if (!entity) throw new Error(`页面 ${id} 不存在`)
    return entity
  }

  /** 给资源发一笔“初始资金”（避免测试从 0 起步时的琐碎设置）。 */
  grant(resourceId: string, amount: number | string): void {
    const entity = this.state.attrs.find(entityKeyOf('resource', resourceId))
    if (!entity) throw new Error(`资源 ${resourceId} 不存在`)
    this.state.attrs.write(`res.${resourceId}.amount`, typeof amount === 'number' ? Num.fromNumber(amount) : Num.fromString(amount), '<test>')
  }

  /** 诊断计数。 */
  diagnosticCount(code: Parameters<typeof Diagnostics.count>[0]): number {
    return Diagnostics.count(code)
  }
}

/** 构造一个只有资源的最小项目（用于聚焦单条规则的用例）。 */
export function minimalProject(overrides: Partial<ProjectFile> = {}): ProjectFile {
  const base = createDefaultProject()
  return { ...base, ...overrides }
}

/** 在项目上加一个资源。 */
export function withResource(resource: Partial<ResourceDef> & { id: string }, project = minimalProject()): ProjectFile {
  const full: ResourceDef = {
    kind: 'resource',
    order: 1,
    name: '资源',
    description: '',
    icon: { kind: 'builtin', value: 'gem' },
    initial: '0',
    max: 'Infinity',
    visible: true,
    ...resource,
  }
  return { ...project, resources: [...project.resources, full] }
}

/** 在最小项目上加一个生成器。 */
export function withGenerator(generator: Partial<GeneratorDef> & { id: string }, project = minimalProject()): ProjectFile {
  const full: GeneratorDef = {
    kind: 'generator',
    order: 1,
    name: '生成器',
    description: '',
    icon: { kind: 'builtin', value: 'factory' },
    initial: '0',
    max: 'Infinity',
    visible: true,
    disabled: false,
    isClicker: false,
    buyAmount: '1',
    buyDelay: 1,
    costs: [],
    produces: [],
    ...generator,
  }
  return { ...project, generators: [...project.generators, full] }
}

/** 在项目上加一个升级。 */
export function withUpgrade(upgrade: Partial<UpgradeDef> & { id: string }, project: ProjectFile): ProjectFile {
  const full: UpgradeDef = {
    kind: 'upgrade',
    order: 1,
    name: '升级',
    description: '',
    icon: { kind: 'builtin', value: 'star' },
    initial: '0',
    max: 'Infinity',
    visible: true,
    disabled: false,
    perSecond: false,
    buyAmount: '1',
    buyDelay: 1,
    costs: [],
    conditions: [],
    effects: [],
    ...upgrade,
  }
  return { ...project, upgrades: [...project.upgrades, full] }
}

/** 在项目上加一个页面。 */
export function withPage(page: Partial<PageDef> & { id: string }, project: ProjectFile): ProjectFile {
  const full: PageDef = {
    kind: 'page',
    order: 99,
    name: '页面',
    description: '',
    icon: { kind: 'builtin', value: 'grid' },
    visible: true,
    disabled: false,
    theme: { kind: 'builtin', value: 'page-dark' },
    columns: 1,
    entries: [],
    ...page,
  }
  return { ...project, pages: [...project.pages, full] }
}

/** 把条目加入页面 `entries`（PRD 补充 7：一个条目只能属于一个页面）。 */
export function assignToPage(project: ProjectFile, pageId: string, entryIds: string[]): ProjectFile {
  return {
    ...project,
    pages: project.pages.map((page) =>
      page.id === pageId
        ? { ...page, entries: entryIds.map((id, index) => ({ id, order: index + 1, theme: { kind: 'builtin', value: 'entry-dark' } })) }
        : page,
    ),
  }
}

export { createDefaultProject, createExampleProject }
