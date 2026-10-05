/**
 * 数据仪表盘（PRD 预览区 2，8.9 的 `Dashboard`）。
 *
 * 两块内容：
 * 1. **各资源的数量与增长速度**（`+x/s`）——数据来自 `buildViewModel().dashboard`，
 *    即 `collectDashboard()`（8.9 的 20 tick 线性回归斜率），**不在这里重算**；
 * 2. **下一个可购买条目的预测时间**——`nextBuy` 为空时显示 `—` 并把 `nextBuyHint`
 *    放进悬浮提示（8.9 列举的五种 `—` 分支）。
 *
 * ## 为什么有展开/收回
 *
 * 仪表盘把**当前页之外的全部资源**都列出来，条目一多它就能吃掉整屏：
 * 实测 49 个资源时仪表盘自身有 623px 高，主区 `.game-main` 被 flex 压到 **0px**，
 * 页面上的条目**一张都看不到也够不着**——不是难用，是完全不可用。
 * 而且溢出 `.game-root`（`height: 100vh`）的那部分会落到文档画布上，
 * 于是页面还会多出一段可以滚动的空白。
 *
 * 因此这里给仪表盘一个**展开/收回**开关，并把展开态的高度封顶
 * （CSS 里的 `max-height` + 内部滚动，见 `game.css`）：
 * 收回时只留一行标题，剩余高度全部让给条目区。
 *
 * ## 这里**不渲染**什么
 *
 * `tick 耗时` / `帧率` / `诊断角标` 三项：它们是**作者向**信息，唯一去处是编辑器的
 * 诊断面板（7.1 末条、12 的性能预算）。游戏视图重复渲染它们，在编辑器预览里与
 * 预览框正下方的统计行完全重复（同一份 `game:stats` 显示两遍），在打包产物里则是
 * 玩家无从处置的数字。数据仍在 `GameViewModel` 与 `game:stats` 里。
 */
import { useState } from 'react'

import type { DashboardView } from '@iforge/runtime'
import { t } from '@iforge/i18n'

export interface DashboardProps {
  dashboard: DashboardView
  /** 动态条目数量 / 上限（R-16：预览角标提示）。 */
  dynamicCount: number
  dynamicLimit: number
  paused: boolean
}

export function Dashboard({ dashboard, dynamicCount, dynamicLimit, paused }: DashboardProps) {
  // 缺省展开：仪表盘是 PRD 预览区 2 的常驻部件，作者第一次看到它时应当是展开的。
  // 收回只影响本次挂载（切页不重挂，因此不会“看一眼就被收起来”）。
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section className="game-dashboard" aria-label={t('game.dashboard')} data-testid="game-dashboard" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="dashboard-head">
        <button
          type="button"
          className="dashboard-toggle"
          data-testid="dashboard-toggle"
          aria-expanded={!collapsed}
          aria-controls="dashboard-body"
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className="dashboard-caret" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          {t('game.dashboard')}
        </button>
      </div>

      <div className="dashboard-body" id="dashboard-body" hidden={collapsed} data-testid="dashboard-body">
        <div className="dashboard-row">
          <ul className="dashboard-resources">
            {dashboard.resources.length === 0 ? (
              <li className="muted">{t('game.noResources')}</li>
            ) : (
              dashboard.resources.map((resource) => (
                <li key={resource.id} className="dashboard-resource" data-resource-id={resource.id}>
                  <span className="dashboard-name">{resource.name}</span>
                  <span className="dashboard-amount" data-testid="resource-amount">
                    {resource.amount}
                  </span>
                  <span className="dashboard-rate" data-rate-sign={resource.rate.startsWith('-') ? 'negative' : 'positive'}>
                    {resource.rate}/s
                  </span>
                </li>
              ))
            )}
          </ul>
          <div className="dashboard-next">
            <span className="dashboard-next-label">{t('game.nextBuy')}</span>
            {dashboard.nextBuy ? (
              <span className="dashboard-next-value" data-testid="next-buy">
                {dashboard.nextBuy.name} · {dashboard.nextBuy.dt}s
              </span>
            ) : (
              <span className="dashboard-next-value muted" data-testid="next-buy" title={dashboard.nextBuyHint}>
                {t('game.dash')}
              </span>
            )}
          </div>
        </div>
        {/* 页脚只在真有内容时渲染：空 div 仍带 `margin-top`，会在仪表盘底部留一道无意义的空隙。 */}
        {paused || dynamicCount > 0 ? (
          <div className="dashboard-foot">
            {paused ? (
              <span className="badge warn" data-testid="paused-badge">
                {t('game.pausedBadge')}
              </span>
            ) : null}
            {dynamicCount > 0 ? (
              <span className="badge" data-testid="dynamic-count">
                {t('game.dynamicCount', { count: dynamicCount, limit: dynamicLimit })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
