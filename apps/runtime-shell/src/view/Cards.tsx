/**
 * 四类卡片（PRD 预览区 3/4/5/6，8.11 的 `ResourceCard`/`ClickerCard`/`GeneratorCard`/`UpgradeCard`）。
 *
 * ## 三条硬约束在这里落地
 *
 * 1. **点击器不可购买**（D-28、R-25）：`ClickerCard` **只**渲染“点击”，`GeneratorCard`
 *    才渲染“购买”。运行时侧另有 `canBuy` 恒假 + `E_CLICKER_NOT_BUYABLE` 的硬约束——
 *    这里“不画购买按钮”只是表现层，两者都要在（用例同时断言 UI 与运行时路径）。
 * 2. **禁用保留卡片但置灰、隐藏按钮**（8.11「卡片显隐」）：页面禁用要求的是“不可购买”而非
 *    “不可见”，置灰掉整张卡片会让玩家误以为内容被删了。资源卡片**不**置灰（8.4 的两条容易
 *    搞反的规则之一：页面禁用不影响资源）。
 * 3. **价格/产量/条件/效果都是格式化后的当前生效值**（8.11 末条），随 tick 增量更新。
 *    组件只读 `CardView`，不调用任何 `GameState`/`AttributeStore` API。
 */
import type { CardView } from '@iforge/runtime'
import { t } from '@iforge/i18n'

import { Icon } from './Icon.js'

/** 卡片交互回调（由 `GameApp` 绑定到 `GameController`，8.3.1 的即时结算）。 */
export interface CardActions {
  onClick(id: string): void
  onBuy(id: string): void
  onDiscard(id: string): void
}

export interface EntryCardProps {
  card: CardView
  actions: CardActions
}

export function EntryCard({ card, actions }: EntryCardProps) {
  const common = { card, actions }
  switch (card.kind) {
    case 'resource':
      return <ResourceCard {...common} />
    case 'clicker':
      return <ClickerCard {...common} />
    case 'generator':
      return <GeneratorCard {...common} />
    case 'upgrade':
      return <UpgradeCard {...common} />
  }
}

/** 卡片的公共骨架：图标 / 名称 / 描述 / 右上角数量位 / 动态条目丢弃按钮。 */
function CardShell({
  card,
  children,
  aside,
  actions,
}: {
  card: CardView
  children?: React.ReactNode
  aside?: React.ReactNode
  actions: CardActions
}) {
  return (
    <article
      className={card.disabled ? 'entry-card disabled' : 'entry-card'}
      data-testid={`card-${card.kind}`}
      data-entry={card.id}
      data-disabled={card.disabled ? 'true' : 'false'}
      data-capped={card.capped ? 'true' : 'false'}
      data-dynamic={card.dynamic ? 'true' : 'false'}
    >
      <header className="entry-head">
        <Icon icon={card.icon} alt={card.name} className="entry-icon" />
        <div className="entry-main">
          <h3 className="entry-name" data-testid="entry-name">
            {card.name}
          </h3>
          {card.description ? <p className="entry-desc">{card.description}</p> : null}
        </div>
        {aside}
        {card.dynamic ? (
          <button
            type="button"
            className="icon-btn entry-discard"
            data-testid="discard"
            aria-label={t('game.discard')}
            title={t('game.discard')}
            onClick={() => actions.onDiscard(card.id)}
          >
            🗑
          </button>
        ) : null}
      </header>
      {children}
      <RewriteAdvice card={card} />
    </article>
  )
}

/**
 * 8.6 末条的作者提示：“价格形状无法闭式求解，已按 tick 分摊”。
 *
 * PRD 没要求这条提示，但 8.6 把它列为降级路径**可被作者自行修复**的必要反馈：
 * 没有它，作者只会看到长期“计算中…”而不知成因。
 *
 * 触发条件是 `rewriteAdvice`（连续 ≥60 tick 走降级路径，由 `GameState` 统计），
 * 因此**一次**边界性的降级不会打扰任何人。
 */
function RewriteAdvice({ card }: { card: CardView }) {
  if (!card.rewriteAdvice) return null
  return (
    <p className="entry-advice" role="status" data-testid="rewrite-advice">
      {t('game.rewriteAdvice')}
    </p>
  )
}

/** 资源卡片（PRD 预览区 3：图标｜名称｜描述｜右侧数量；无购买按钮，D-20）。 */
function ResourceCard({ card, actions }: { card: CardView; actions: CardActions }) {
  return (
    <CardShell
      card={card}
      actions={actions}
      aside={
        <span className="entry-amount" data-testid="resource-value">
          {card.amount}
        </span>
      }
    />
  )
}

/** 点击器卡片（PRD 预览区 4：图标｜名称｜描述｜产量 + “点击”）。 */
function ClickerCard({ card, actions }: { card: CardView; actions: CardActions }) {
  return (
    <CardShell
      card={card}
      actions={actions}
      aside={
        <span className="entry-amount" data-testid="owned-value">
          {card.owned}
        </span>
      }
    >
      <OutputLine card={card} />
      {!card.disabled ? (
        <button
          type="button"
          className="btn primary entry-action"
          data-testid="click-button"
          disabled={!card.canClick}
          title={card.capped ? t('game.capped') : undefined}
          onClick={() => actions.onClick(card.id)}
        >
          {t('game.click')}
        </button>
      ) : null}
    </CardShell>
  )
}

/** 生成器卡片（PRD 预览区 5：+ 价格｜产量｜右侧已购买/拥有 + “购买”）。 */
function GeneratorCard({ card, actions }: { card: CardView; actions: CardActions }) {
  return (
    <CardShell card={card} actions={actions} aside={<CountAside card={card} />}>
      <OutputLine card={card} />
      <CostLines card={card} />
      {!card.disabled ? <BuyButton card={card} actions={actions} /> : null}
    </CardShell>
  )
}

/** 升级卡片（PRD 预览区 6：+ 条件｜价格｜效果｜右侧已购买/拥有 + “购买”；动态条目带“丢弃”）。 */
function UpgradeCard({ card, actions }: { card: CardView; actions: CardActions }) {
  return (
    <CardShell card={card} actions={actions} aside={<CountAside card={card} />}>
      {card.conditions && card.conditions.length > 0 ? (
        <ul className="entry-conditions" data-testid="conditions">
          {card.conditions.map((condition, index) => (
            <li key={`${card.id}-c${index}`} className={condition.true ? 'condition true' : 'condition false'}>
              <span className="condition-mark">{condition.true ? '✔' : '✘'}</span>
              <code>{condition.text}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <CostLines card={card} />
      {card.effects && card.effects.length > 0 ? (
        <ul className="entry-effects" data-testid="effects">
          {card.effects.map((effect, index) => (
            <li key={`${card.id}-e${index}`} className="effect">
              <code className="effect-action">{effect.action}</code>
              <span className="effect-value" data-testid="effect-value">
                {effect.value}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {!card.disabled ? <BuyButton card={card} actions={actions} /> : null}
    </CardShell>
  )
}

/** 右侧“已购买数量 / 拥有数量”（PRD 预览区 5/6）。 */
function CountAside({ card }: { card: CardView }) {
  return (
    <span className="entry-count">
      <span data-testid="bought-value" title={t('game.bought')}>
        {card.bought}
      </span>
      <span className="entry-count-sep">/</span>
      <span data-testid="owned-value" title={t('game.owned')}>
        {card.owned}
      </span>
    </span>
  )
}

/** 产量行（生成器=每秒，点击器=每次点击，8.11 的两套口径）。 */
function OutputLine({ card }: { card: CardView }) {
  if (card.noOutput) {
    return (
      <p className="entry-output muted" data-testid="output">
        {t('game.noOutput')}
      </p>
    )
  }
  return (
    <p className="entry-output" data-testid="output">
      <span className="entry-output-label">{card.outputUnit === 'click' ? t('game.perClick') : t('game.perSecond')}</span>
      <span className="entry-output-value">{card.output}</span>
    </p>
  )
}

/** 价格行（PRD 预览区 5/6 的“价格”）。 */
function CostLines({ card }: { card: CardView }) {
  if (!card.costs || card.costs.length === 0) return null
  return (
    <ul className="entry-costs" data-testid="costs">
      {card.costs.map((cost) => (
        <li key={`${card.id}-${cost.materialId}`} className="cost">
          <span className="cost-material">{cost.materialName}</span>
          <span className="cost-amount">{cost.amount}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 购买按钮（8.6 三态的可见形态）。
 *
 * 标签必须回答“**点下去会发生什么**”，而不是“作者配置了什么”：
 *
 * | `buyMode` | 标签 | 依据 |
 * | --- | --- | --- |
 * | `count` | `购买 ×{buyCount}`（`buyCount` 是**当前买得起**的件数） | `view-model` 的 `affordableInCountMode`，与 `solveBatch` 同口径 |
 * | `max` | `最大购买` | 件数事先不可知 |
 * | `free` | `免费购买` | 不扣材料（8.6 的 `free` 语义） |
 *
 * 早先这里显示的是 `buyAmount`（配置值），于是卡片在“按钮写 ×10、点下去只买到 1 件”
 * 的时候也在说谎；更糟的是求解走了迭代路径时 `degraded` 恒为真，`calculating` 被置真后
 * 再没人清，按钮**永久**显示“计算中…”。现在 `calculating` 只由 `truncated` 驱动
 * （见 `GameState.pendingSolves`），而件数来自真实可负担量。
 */
function BuyButton({ card, actions }: { card: CardView; actions: CardActions }) {
  const count = card.buyCount ?? 0
  const request = card.buyRequest ?? count
  const label = card.calculating
    ? t('game.calculating')
    : card.buyMode === 'free'
      ? t('game.freeBuy')
      : card.buyMode === 'max'
        ? t('game.maxBuy')
        : (count > 1 ? count : request) > 1
          ? t('game.buyTimes', { count: count > 0 ? count : request })
          : t('game.buy')
  // 一件也买不起时按钮禁用并说明原因；买得起但不足整批时说明“本该买几件、现在只够几件”。
  const hint = card.buyBlockReason ?? (count > 0 && request > count ? t('game.buyTimesPartial', { total: request, count }) : undefined)
  return (
    <button
      type="button"
      className="btn primary entry-action"
      data-testid="buy-button"
      data-mode={card.buyMode}
      data-count={count}
      data-request={request}
      disabled={!card.canBuy}
      title={hint}
      onClick={() => actions.onBuy(card.id)}
    >
      {label}
    </button>
  )
}
