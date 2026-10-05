/**
 * React 根组件（把 `GameController` 接到 `AppView` 上）。
 *
 * ## 为什么用 `useSyncExternalStore`
 *
 * 控制器是**类 + 事件**（`GameState` 是 M2 的状态机，8.x），而 React 需要一个可订阅的快照源。
 * `useSyncExternalStore` 正好是这个形状：
 * - `subscribe(controller.subscribe)`：控制器重建视图时通知；
 * - `getSnapshot(controller.getView)`：返回**同一份** `GameViewModel` 对象引用
 *   （`buildViewModel()` 每次产出新对象，因此重建一定会触发重渲染，不需要额外版本号）。
 *
 * 不用 `useState` + `useEffect` 的原因：那会在 StrictMode 下双订阅，并且快照比较需要自己
 * 维护“变了没有”的标志位——而“是否变了”在这里已经有权威答案（对象引用）。
 *
 * ## 事件回调的稳定性
 *
 * `AppView` 的回调都用 `useCallback([])` 包一层并只依赖 `controller`（ref 固定）：
 * 交互密集时（点击器连点）每次重渲染都新建回调会让四类卡片全部失去 `memo` 的短路，
 * 直接退化到 12 性能预算里最怕的“数百卡片全量 diff”。
 *
 * ## 这里**不**再统计诊断角标
 *
 * 错误总数曾由这里聚合并传给 `AppView` 在仪表盘上渲染“诊断 N”。它已从游戏视图移除：
 * 唯一的去处是编辑器的诊断面板（7.1 末条、12 的性能预算），运行时侧的数据仍然经
 * `game:error` / `game:stats` 上报（9.2），不受影响。
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

import type { GameController } from './controller.js'
import { AppView } from './view/AppView.js'

export interface GameAppProps {
  controller: GameController
}

export function GameApp({ controller }: GameAppProps) {
  // 控制器在应用生命周期内不变（9.3 的握手只有一次），放进 ref 让回调保持稳定引用。
  const ref = useRef(controller)
  const view = useSyncExternalStore(
    useCallback((onChange: () => void) => ref.current.subscribe(onChange), []),
    useCallback(() => ref.current.getView(), []),
    useCallback(() => ref.current.getView(), []),
  )

  const actions = useMemo(
    () => ({
      onClick: (id: string) => ref.current.click(id),
      onBuy: (id: string) => ref.current.buy(id),
      onDiscard: (id: string) => ref.current.discard(id),
    }),
    [],
  )

  return (
    <AppView
      view={view}
      actions={actions}
      paused={controller.state.flags.paused}
      onNavigate={(pageId) => ref.current.navigate(pageId)}
      onChangeSetting={(key, value) => ref.current.setGameSetting(key, value)}
      onChangeTheme={(value) => ref.current.setThemeOverride(value)}
      onResetDefaults={() => ref.current.resetSettingsDefaults()}
      onExportSave={() => ref.current.requestExportSave()}
      onImportSave={() => ref.current.requestImportSave()}
      onRestart={() => ref.current.restart()}
      onDismissOffline={() => ref.current.dismissOffline()}
    />
  )
}
