/**
 * 影子运行时（TECH_DESIGN 2.2「编辑器内嵌影子运行时」、ADR-03/D-15、7.4）。
 *
 * ## 用途（M3 范围内）
 *
 * 只服务**编辑期的试算**（5.8「失焦与输入停顿 300ms 时在影子运行时试算，右侧显示求值结果与耗时」）
 * 与表达式字段的即时反馈。它复用 `@iforge/runtime` 的 `GameState`，
 * 因此试算到的数值与预览/成品**一致**（ADR-03 的核心价值）。
 *
 * ## 为什么不推进 tick
 *
 * 影子运行时只求值、不模拟：M3 不做预览 iframe（9.1 是 M4），
 * 也没有“编辑器改动 → 运行时热更新”的渲染通道需求。
 * 逐 tick 模拟会引入与编辑无关的随机性与时间推进，让作者看到的价格/产出莫名其妙地变化。
 *
 * ## 缓存策略
 *
 * 以“项目版本 + 目标属性值”为键复用实例：作者改一个名字不应该重建整个影子状态，
 * 改了 `initial`/`bought` 才需要重建（否则试算读到旧值）。
 */
import { GameState } from '@iforge/runtime'
import type { ContextKind } from '@iforge/expr'
import { Num, isForgeError } from '@iforge/num'
import type { ProjectFile } from '@iforge/model'

import type { EvaluationPreview } from './expression-check.js'

/** 影子运行时实例（包一层，只暴露编辑器需要的读/试算能力）。 */
export class ShadowRuntime {
  private constructor(
    readonly state: GameState,
    private readonly signature: string,
  ) {}

  /** 用项目文件构建（内部入口，走 `getShadow` 的缓存）。 */
  static create(project: ProjectFile): ShadowRuntime {
    // 固定时间源：影子运行时不做离线结算，时间必须可复现（否则试算结果每次刷新都不同）。
    const state = new GameState({
      project,
      projectId: 'shadow',
      slotId: 'shadow',
      now: () => 0,
      nowIso: () => '1970-01-01T00:00:00.000Z',
    })
    // 走几步 tick 让初始 `initial` 求值完成（8.3 的产出/条件阶段），
    // 这样试算看到的是“已开局”的属性值而不是未初始化的 0。
    state.stepTick(50, 50)
    return new ShadowRuntime(state, signatureOf(project))
  }

  /** 项目是否变化（用于缓存失效判断）。 */
  get signatureKey(): string {
    return this.signature
  }

  /** 求值并格式化（5.8 的“求值结果与耗时”）。 */
  evaluate(text: string, context: ContextKind): EvaluationPreview {
    const started = performance.now()
    try {
      const result = this.state.runtime.evaluate(text, context)
      const value = result.value
      const shown = typeof value === 'boolean' ? String(value) : formatValue(value)
      return {
        text: shown,
        ms: performance.now() - started,
        error: result.lastGood ? `E_${result.code ?? 'UNKNOWN'}` : undefined,
      }
    } catch (error) {
      const message = isForgeError(error) ? `${error.code}: ${error.message}` : String(error)
      return { text: '—', ms: performance.now() - started, error: message }
    }
  }

  /** 读取某个属性路径的当前值（编辑器表单的“当前值”展示，5.9.3 的只读等级视图不需要）。 */
  readValue(path: string): string | undefined {
    try {
      return formatValue(this.state.runtime.evaluate(path, 'field').value)
    } catch {
      return undefined
    }
  }
}

/** 把求值结果格式化为文本（布尔直出，其余按 4.5 的 `standard` 格式）。 */
function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  return Num.format(value as never, 'standard')
}

/** 项目签名：条目集合 + 会被表达式读到的初值字段。 */
function signatureOf(project: ProjectFile): string {
  const parts: string[] = [
    project.resources.map((r) => `${r.id}:${r.initial}:${r.max}`).join(','),
    project.generators
      .map(
        (g) => `${g.id}:${g.initial}:${g.max}:${g.isClicker}:${g.costs.map((c) => c.amount).join('|')}:${g.produces.map((p) => p.amount).join('|')}`,
      )
      .join(','),
    project.upgrades.map((u) => `${u.id}:${u.initial}:${u.max}:${u.conditions.join('&')}:${u.effects.map((e) => e.action).join('|')}`).join(','),
    project.pages.map((p) => `${p.id}:${p.visible}:${p.disabled}:${p.entries.map((e) => e.id).join(',')}`).join(','),
  ]
  return parts.join(';')
}

let cached: ShadowRuntime | undefined

/**
 * 取影子运行时（带缓存）。
 *
 * 签名不同即重建；重建成本是“建 `GameState` + 一步 tick”，在数百条目下仍是毫秒级，
 * 而作者每秒最多输入几次。
 */
export function getShadow(project: ProjectFile): ShadowRuntime {
  const signature = signatureOf(project)
  if (!cached || cached.signatureKey !== signature) cached = ShadowRuntime.create(project)
  return cached
}

/** 丢弃缓存（“新建/导入项目”“测试复位”用，7.9）。 */
export function resetShadow(): void {
  cached = undefined
}
