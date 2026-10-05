/**
 * 全局快捷键（TECH_DESIGN 7.1「全局快捷键」表）。
 *
 * | 键 | 作用 | 作用范围 |
 * | --- | --- | --- |
 * | `Ctrl+S` | 保存项目（拦截浏览器默认保存） | 编辑器全局 |
 * | `Ctrl+Z` / `Ctrl+Shift+Z`、`Ctrl+Y` | 撤销 / 重做 | 编辑器全局 |
 * | `Ctrl+O` / `Ctrl+E` | 导入 / 导出 | 编辑器全局 |
 * | `Ctrl+P` | 打包（`game:ready` 后可用） | 编辑器全局 |
 * | `↑` / `↓` | 列表选中上/下一行 | 四类左侧列表（由 `EntryList` 处理） |
 * | `Alt+↑` / `Alt+↓` | 条目上移 / 下移 | 四类列表、页面内条目网格 |
 * | `Ctrl+D` / `Delete` | 复制 / 删除选中条目 | 四类左侧列表（由 `EntryList` 处理） |
 * | `Space` | 暂停 / 继续预览 | 预览区容器聚焦时 |
 * | `Esc` | 关闭对话框 / 取消拖拽 | 编辑器全局（`Dialog` 处理） |
 *
 * ## 为什么走同一套 store 动作
 *
 * 7.1 末条：“快捷键触发的保存/撤销/重做与按钮点击走同一条 store 事务，不存在旁路实现”。
 * 因此本模块只负责**识别组合键并调用既有动作**，不直接改任何状态。
 */
import { useEffect } from 'react'

/** 全局快捷键处理器。 */
export interface ShortcutHandlers {
  onSave(): void
  onUndo(): void
  onRedo(): void
  onImport(): void
  onExport(): void
  onPackage(): void
  onTogglePause(): void
}

/** 输入框内的按键不应触发全局快捷键（否则打字会撤销/保存）。 */
function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

/** 绑定全局快捷键（`App` 挂载时调用一次）。 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) {
        // `Space`：仅在预览区容器聚焦时切换暂停（7.1 表末行）。
        if (event.key === ' ' && !isEditable(event.target)) {
          const container = document.querySelector('[data-preview-pane]')
          if (container && container.contains(document.activeElement)) {
            event.preventDefault()
            handlers.onTogglePause()
          }
        }
        return
      }
      if (isEditable(event.target) && event.key !== 's') return
      switch (event.key.toLowerCase()) {
        case 's':
          event.preventDefault()
          handlers.onSave()
          break
        case 'z':
          event.preventDefault()
          if (event.shiftKey) handlers.onRedo()
          else handlers.onUndo()
          break
        case 'y':
          event.preventDefault()
          handlers.onRedo()
          break
        case 'o':
          event.preventDefault()
          handlers.onImport()
          break
        case 'e':
          event.preventDefault()
          handlers.onExport()
          break
        case 'p':
          event.preventDefault()
          handlers.onPackage()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
