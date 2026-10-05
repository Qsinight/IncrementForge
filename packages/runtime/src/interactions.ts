/**
 * 交互事件的结算时机（TECH_DESIGN 8.3.1）。
 *
 * 玩家操作（点击器点击、购买/批量购买、丢弃动态条目、页面跳转、游戏内设置变更）由 DOM 事件
 * 触发，落在**两次 tick 之间**——JS 单线程保证一个 tick 执行过程中不会被插入交互事件
 * （`frame()` 先把本帧的 tick 批次跑完再回到事件循环，8.2）。
 *
 * | 交互 | 条目状态字段 | 副作用（`set/create/destroy`） |
 * | --- | --- | --- |
 * | 点击器点击 | **即时**结算产出（经 `applyProduces`/`applyCap`） | 不经 `EffectSink`：产出走 `produces[i].materialId` 指定的存储 |
 * | 购买 / 批量购买 | **即时**扣材料并推进 `bought/owned` | 与 tick 内产生的副作用**同池入队**，在**下一个**提交阶段应用 |
 * | 丢弃动态条目 | **即时**移除条目并级联清理 | 不经 `EffectSink`：玩家直接操作，卡片必须立刻消失 |
 * | 页面跳转 / 设置变更 | **即时**改 UI 会话状态（都不进存档） | 无 |
 *
 * **唯一提交点**：任何来源的副作用都只经 `EffectSink`、只在 8.3 第 6 步应用；交互事件的副作用
 * 既不单独即时提交，也不跨提交阶段保留（提交时无条件清空队列）。由此 `isClicker`、`visible`
 * 等经 `set()` 改写的属性同样“**下一 tick 起生效**”。
 *
 * 因此“暂停时购买升级，其效果不会立刻显现”是必然结果，**不得**为交互另开即时提交旁路。
 */
import type { Decimal } from '@iforge/num'

/** 点击器点击的结果。 */
export interface ClickOutcome {
  ok: boolean
  /** 本次获得的量（`owned × Σ 单件速率`）。失败为 0。 */
  gained: Decimal
}

/** 购买类交互的结果。 */
export interface PurchaseOutcome {
  ok: boolean
  /** 实际买到的件数；失败为 0。 */
  k: Decimal
  /** 失败原因（诊断码），成功为 `undefined`。 */
  code?: string
  /** 是否走了批量求解的降级路径（UI 显示“计算中…”）。 */
  degraded: boolean
}
