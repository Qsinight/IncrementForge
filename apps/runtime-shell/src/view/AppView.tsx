/**
 * 游戏视图根组件（PRD 预览区 1–9 的组件树，8.11 的 `AppView`）。
 *
 * ```
 * AppView
 * ├─ GameTitleBar          项目名称（PRD 预览区 1）
 * ├─ Dashboard             数量/增长速度 + 下一个可购买条目预测时间（PRD 预览区 2，8.9）
 * ├─ OfflineNotice         离线收益提示条（8.8 末条；可选）
 * ├─ PageView(pageId) | SettingsPage     （PRD 预览区 3–9）
 * └─ BottomNav             图标+名称，最后一格是内置设置页（PRD 预览区 8）
 * ```
 *
 * ## 这个组件树同时服务**预览**与**打包**（ADR-03、ADR-05、D-42）
 *
 * 它是纯展示 + 事件回调，不含任何编辑器外壳元素：
 * - **模拟设置栏**（设备/暂停/倍速/解锁全部）不在这里（7.1 的“顶部模拟设置栏不属于游戏内容”、D-42），
 *   由 `apps/editor` 的 `PreviewPane` 提供并通过 `host:control` 下发；
 * - 因此 M5 的打包产物可以直接挂载同一棵树，不需要剔除任何分支。
 *
 * 数据全部来自 `GameViewModel`（`buildViewModel()` 的输出），组件不做二次计算（8.11 末条）。
 *
 * ## 仪表盘里**没有**性能与诊断指标
 *
 * `tick 耗时 / 帧率 / 诊断` 三项只出现在编辑器的诊断面板（7.1 末条、12 的性能预算），
 * 不再重复出现在游戏视图里：编辑器预览时它们就在预览框正下方重复了一遍，
 * 打包产物里则是玩家无从处置的作者向信息。数据本身仍在
 * `game:stats`（9.2）与 `GameViewModel` 里，只是不再由游戏视图渲染。
 */
import type { GameViewModel } from '@iforge/runtime'
import { t } from '@iforge/i18n'

import { BottomNav } from './BottomNav.js'
import type { CardActions } from './Cards.js'
import { Dashboard } from './Dashboard.js'
import { OfflineNotice } from './OfflineNotice.js'
import { PageView } from './PageView.js'
import { SettingsPage } from './SettingsPage.js'
import { pageTokenStyle, themeRefOf, useDocumentPageTokens } from './theme.js'

export interface AppViewProps {
  view: GameViewModel
  actions: CardActions
  onNavigate(pageId: string): void
  onChangeSetting(key: string, value: string): void
  /** 内置设置页的“页面主题”开关（8.10）：只改会话偏好，不写项目文件。 */
  onChangeTheme(value: string): void
  onResetDefaults(): void
  onExportSave(): void
  onImportSave(): void
  onRestart(): void
  onDismissOffline(): void
  paused: boolean
}

export function AppView(props: AppViewProps) {
  const { view, actions, onNavigate, paused } = props
  // 页面主题落在**根节点**（PRD 页面编辑器 6、17.3 的主题约定）：顶部标题栏、仪表盘与
  // 底部导航栏是这一页不可分割的一部分，它们不是 `.game-page` 的后代，令牌只内联到
  // 页面节时读不到 —— 症状就是“换页面主题后壳层纹丝不动”（详见 `theme.ts`）。
  //
  // 生效值由**视图模型**给出（`view.pageTheme`）而不是这里现算：它已经把
  // 玩家的主题偏好、停在内置设置页时该跟谁（8.12 的初始页面）都算好了。
  // 视图若自己 `view.page?.theme`，停在内置设置页时就会掉回 `page-dark` 缺省——
  // 症状是“点进设置、整屏跳成暗色”（PRD 页面编辑器 6 要求壳层与页面一致）。
  const pageTheme = themeRefOf(view.pageTheme)
  // 同一份令牌还要落到 `documentElement`：`.game-root` 之外的画布（body、内边距那一圈、
  // 以及壳层被内容顶出视口时的溢出区）才是“黑边”的来源，见 `theme.ts` 的文件头。
  useDocumentPageTokens(pageTheme)
  return (
    <div
      className="game-root"
      data-testid="game-root"
      data-page={view.onSettings ? '__settings__' : (view.page?.id ?? '')}
      data-theme={view.pageTheme}
      style={pageTokenStyle(pageTheme)}
    >
      <header className="game-title" data-testid="game-title">
        {view.title}
      </header>
      <Dashboard dashboard={view.dashboard} dynamicCount={view.settings.dynamicCount} dynamicLimit={view.settings.dynamicLimit} paused={paused} />
      {view.offline ? <OfflineNotice notice={view.offline} onDismiss={props.onDismissOffline} /> : null}
      <main className="game-main">
        {view.onSettings || !view.page ? (
          <SettingsPage
            settings={view.settings}
            onChange={props.onChangeSetting}
            onChangeTheme={props.onChangeTheme}
            onResetDefaults={props.onResetDefaults}
            onExportSave={props.onExportSave}
            onImportSave={props.onImportSave}
            onRestart={props.onRestart}
            paused={paused}
          />
        ) : (
          <PageView page={view.page} actions={actions} />
        )}
      </main>
      <BottomNav items={view.nav} onNavigate={onNavigate} testId="bottom-nav" />
      <p className="sr-only" aria-live="polite">
        {t('game.currentPage')}: {view.onSettings ? t('game.settingsTitle') : (view.page?.name ?? '')}
      </p>
    </div>
  )
}
