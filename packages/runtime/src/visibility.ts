/**
 * 可见性与禁用的有效状态（页面继承）（TECH_DESIGN 8.4、D-21、R-21）。
 *
 * ## 收敛为唯一判定入口的理由（R-21）
 *
 * 页面禁用要求“其下所有生成器/升级不可购买、不可产出、不生效”，页面不可见要求“其下**所有**条目
 * 不可见”。这四类规则要在**七个地方**生效：购买、产出、点击、每秒生效、效果应用、自动购买、
 * UI 渲染、仪表盘预测。任何一处绕过判定函数直接读 `entry.visible`，就会出现
 * “页面禁用了但资源还在涨”的诡异行为。因此本模块是**唯一**实现，各阶段只能调用它。
 *
 * ## 两条容易搞反的规则
 *
 * 1. **资源没有“禁用”态**（8.4「资源没有禁用态」行）：页面禁用只让生成器/升级置灰，
 *    资源卡片**不**置灰、`amount` 仍随存量生成器增长。把资源也置灰会造成误导性的“不可用”暗示。
 * 2. **页面可见性对所有条目生效**（含资源）：PRD 页面编辑器 5 写的是“所有条目”。
 *
 * 以及：**页面禁用不影响跳转**（PRD 页面编辑器 4「仍可跳转」），导航不在本模块判定范围内。
 */
import { Diagnostics } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { AttributeStore, EntryState } from './attribute-store.js'
import { entityKeyOf, isClickerDef } from './attribute-store.js'
import type { RuntimeEntityKind } from './keys.js'

/** 判定所需的依赖（由 `GameState` 提供）。 */
export interface VisibilityDeps {
  attrs: AttributeStore
  /** 条目 -> 所属页面 id；无归属时 `undefined`（8.4 的 `pageOf`）。 */
  pageOf(state: EntryState): string | undefined
  /** 当前生效的数量上限（用于 `canBuy` 的上限判定）。 */
  capOf(state: EntryState): Decimal
  /** 某个 `owned` 的当前值。 */
  ownedOf(state: EntryState): Decimal
  /**
   * 升级的 `conditions` 是否全为真（PRD 补充 4 的 AND 判定，8.4 的 `canBuy` 伪码第四行）。
   *
   * 以**回调**注入而不是直接 `import`：条件求值要经过 `AttributeStore` + `ExpressionRuntime`
   * + 只读等级视图（8.6.1），这些都在 `purchase.ts` 里。写成回调让依赖方向保持单向
   * （`purchase` 依赖 `judge`，`judge` 不反向依赖 `purchase`）。
   */
  conditionsAllTrue(state: EntryState): boolean
}

/**
 * 可见性与禁用的判定集合。
 *
 * 全部方法都是**纯读**（除记诊断外不产生副作用），因此可以在同一 tick 的多个阶段
 * 安全地重复调用；8.4 要求“每个阶段在遍历前取一次快照”，调用方用 `snapshot()` 实现。
 */
export class VisibilityJudge {
  constructor(private readonly deps: VisibilityDeps) {}

  /** 条目 -> 所属页面（静态条目查 `PageDef.entries`，动态条目查存档里的 `pageId`）。 */
  pageOf(state: EntryState): string | undefined {
    return this.deps.pageOf(state)
  }

  /**
   * `isVisible(entryId)`：自身 `visible` ∧ 页面 `visible`（PRD 页面编辑器 5）。
   *
   * 无归属（孤儿动态条目，8.7）按 `visible = false` 处理并记 `E_PAGE_UNKNOWN`。
   */
  isVisible(state: EntryState): boolean {
    if (!state.visible) return false
    const pageId = this.deps.pageOf(state)
    if (pageId === undefined) return this.reportOrphan(state, false)
    const page = this.deps.attrs.find(entityKeyOf('page', pageId))
    if (!page) return this.reportOrphan(state, false)
    return page.visible
  }

  /**
   * `isDisabled(entryId)`：资源恒 `false`；生成器/升级 = 自身 `disabled` ∨ 页面 `disabled`
   * （PRD 页面编辑器 4）。
   *
   * 页面本身只看自身——页面之间没有继承关系，`nav()` 也不看它（8.12）。
   */
  isDisabled(state: EntryState): boolean {
    if (state.kind === 'resource') return false
    if (state.kind === 'page') return state.disabled
    if (state.disabled) return true
    const pageId = this.deps.pageOf(state)
    if (pageId === undefined) return this.reportOrphan(state, true)
    const page = this.deps.attrs.find(entityKeyOf('page', pageId))
    if (!page) return this.reportOrphan(state, true)
    return page.disabled
  }

  /** `isEffectivelyVisible(e)`：不可见即不参与任何结算。 */
  isEffectivelyVisible(state: EntryState): boolean {
    return this.isVisible(state)
  }

  /** `isEffectivelyDisabled(e)`：`isDisabled || !isVisible`。 */
  isEffectivelyDisabled(state: EntryState): boolean {
    return this.isDisabled(state) || !this.isVisible(state)
  }

  /** `isClicker(e)`：生成器且 `isClicker === true`。 */
  isClicker(state: EntryState): boolean {
    return isClickerDef(state)
  }

  /** `canProduce(e)`：可见 ∧ 未禁用（点击器在调用方另行排除，8.3 第 3 步）。 */
  canProduce(state: EntryState): boolean {
    // 8.4 的「停止产出」四因：不可见、不可买（禁用）、`owned >= max`、**点击器**。
    // 点击器只由点击事件驱动产出，所以它在这里就要被排除——
    // 产出阶段因此可以直接用这一条判定，不必再单独判断 `isClicker`。
    if (this.isClicker(state)) return false
    return this.isVisible(state) && !this.isDisabled(state)
  }

  /**
   * `canBuy(e)`：可见 ∧ 未禁用 ∧ `owned < max` ∧ 非点击器（PRD 生成器 11）。
   *
   * 点击器不可购买是**运行时硬约束**（D-28、R-25），不是 UI 层“不画按钮”的副作用。
   */
  canBuy(state: EntryState): boolean {
    if (state.kind !== 'generator' && state.kind !== 'upgrade') return false
    if (!this.isVisible(state) || this.isDisabled(state)) return false
    if (this.isClicker(state)) return false
    // 升级：`conditions` 全为真才可购买（PRD 补充 4 的 AND 判定）。
    // 少了这一条，`canBuy` 会在条件不满足时返回 true——UI 会把“不可购买”的升级
    // 画成可点击的按钮，玩家点下去才被 `buyOne` 拒绝（一次无谓的失败反馈）。
    if (state.kind === 'upgrade' && !this.deps.conditionsAllTrue(state)) return false
    const owned = this.deps.ownedOf(state)
    const cap = this.deps.capOf(state)
    // `max = "Infinity"` 时 `cap` 是 `NUM_INF`，比较恒真即“无上限”（D-46）。
    return owned.lt(cap)
  }

  /** `canTick(e)`：每秒生效与点击的判定（可见 ∧ 未禁用）。 */
  canTick(state: EntryState): boolean {
    return this.isVisible(state) && !this.isDisabled(state)
  }

  /**
   * `ownsUpgrade(e)`：升级是否**已拥有**（`owned > 0`）——升级效果生效的唯一门槛（D-43）。
   *
   * 用 `owned` 而非 `bought`，才能覆盖“被其它升级产出的升级”（`bought = 0`、`owned > 0`）。
   * `owned` 每次**实时读取**、不做缓存，以便同一 tick 内被别的升级改写后立即反映。
   */
  ownsUpgrade(state: EntryState): boolean {
    return state.kind === 'upgrade' && this.deps.ownedOf(state).gt(0)
  }

  /**
   * 取一次判定快照（8.4「判定时机」：每个阶段在遍历前取一次，阶段内不再变化）。
   *
   * 返回的是 `id -> 判定结果` 的映射，遍历阶段用它做 O(1) 查表，
   * 既避免同 tick 内半途改页面导致结算不一致，也把每 tick 的判定次数从 O(条目 × 阶段)
   * 降到 O(条目)。
   */
  snapshot(states: readonly EntryState[]): VisibilitySnapshot {
    const map = new Map<string, VisibilitySnapshotEntry>()
    for (const state of states) {
      map.set(entityKeyOf(state.kind, state.id), {
        visible: this.isVisible(state),
        disabled: this.isDisabled(state),
        pageId: this.deps.pageOf(state),
      })
    }
    return new VisibilitySnapshot(map)
  }

  /** 孤儿条目的诊断：`E_PAGE_UNKNOWN` 只在**每个 tick 一次**的频率上报，避免刷屏。 */
  private reportOrphan(state: EntryState, fallback: boolean): boolean {
    Diagnostics.record('E_PAGE_UNKNOWN', entityKeyOf(state.kind, state.id), `条目 ${state.id} 的归属页面不存在`)
    return fallback
  }
}

/** 单个条目的判定快照。 */
export interface VisibilitySnapshotEntry {
  visible: boolean
  disabled: boolean
  pageId: string | undefined
}

/** 一次遍历用的判定快照。 */
export class VisibilitySnapshot {
  constructor(private readonly map: Map<string, VisibilitySnapshotEntry>) {}

  /** 取某条目的判定；未在快照中（动态新建）时保守返回“不可见且禁用”。 */
  get(kind: RuntimeEntityKind, id: string): VisibilitySnapshotEntry {
    return (
      this.map.get(entityKeyOf(kind, id)) ?? {
        visible: false,
        disabled: true,
        pageId: undefined,
      }
    )
  }

  /** 可见 ∧ 未禁用（结算类判定）。 */
  canSettle(kind: RuntimeEntityKind, id: string): boolean {
    const entry = this.get(kind, id)
    return entry.visible && !entry.disabled
  }
}
