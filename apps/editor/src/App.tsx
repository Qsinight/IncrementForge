/**
 * 编辑器外壳：四分区布局 + 全局对话框（TECH_DESIGN 7.1、7.9、10.2、PRD 工作页面一览）。
 *
 * | 分区 | 组件 |
 * | --- | --- |
 * | 顶部标题栏 | `TitleBar` |
 * | 左侧功能区 | `SideNav` |
 * | 中间工作区 | `Workspace` |
 * | 右侧预览区 | `PreviewPane`（M3 为占位 + 模拟设置栏） |
 *
 * 对话框：新建确认（7.9）、删除确认（7.5 的引用清单）、导入冲突确认（10.2 / D-33）、
 * 校验问题清单（6.4）。M4 之后“重新开始”二次确认也在这里（8.10）。
 */
import { useCallback, useState } from 'react'

import { t } from '@iforge/i18n'

import { PreviewPane } from './app/PreviewPane.js'
import { SideNav } from './app/SideNav.js'
import { TitleBar } from './app/TitleBar.js'
import { Workspace } from './app/Workspace.js'
import { useShortcuts } from './app/shortcuts.js'
import { Dialog } from './components/Dialog.js'
import { confirmDelete, requestDeleteFor } from './features/shell/deleteFlow.js'
import { packageProject } from './features/shell/packageGame.js'
import { exportProject, importProject, newProject, saveProject } from './features/shell/projectIo.js'
import type { ProjectIo } from './features/shell/projectIo.js'
import { issuesOfLastOperation } from './features/shell/projectIo.js'
import { analyzeDeletion } from './lib/references.js'
import { useEditorStore } from './stores/editor.js'
import { useProjectStore } from './stores/project.js'
import { redo, undo } from './stores/undoRedo.js'
import { usePreviewStore } from './stores/preview.js'

export interface AppProps {
  io: ProjectIo
}

export function App({ io }: AppProps) {
  const project = useProjectStore((state) => state.project)
  const toast = useEditorStore((state) => state.toast)
  const notify = useEditorStore((state) => state.notify)
  const dismissToast = useEditorStore((state) => state.dismissToast)
  const pendingDelete = useEditorStore((state) => state.pendingDelete)
  const requestDelete = useEditorStore((state) => state.requestDelete)
  const confirmNew = useEditorStore((state) => state.confirmNew)
  const confirmNewProject = useEditorStore((state) => state.confirmNewProject)
  const requestNew = useEditorStore((state) => state.requestNew)
  const pendingImport = useEditorStore((state) => state.pendingImport)
  void pendingImport
  const setPendingImport = useEditorStore((state) => state.setPendingImport)

  const [issuesOpen, setIssuesOpen] = useState(false)
  const [importText, setImportText] = useState<string | null>(null)

  const onSave = useCallback(() => {
    void saveProject(io).then((result) => {
      if (!result.ok) setIssuesOpen(true)
    })
  }, [io])
  const onExport = useCallback(() => {
    void exportProject(io).then((result) => {
      if (!result.ok) setIssuesOpen(true)
    })
  }, [io])
  const onImport = useCallback(() => {
    // 导入走文件选择器：读取文本后先校验，确认覆盖才落库（10.2 / D-33）。
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void file.text().then((text) => {
        void importProject(io, text, false).then((result) => {
          if (result.ok || result.validated) setImportText(text)
        })
      })
    }
    input.click()
  }, [io])

  /**
   * 打包（11.1、17.5 的 M5 交付标准）。
   *
   * `game:ready` 之前不给打包：7.1 明确“打包仅在 `game:ready` 后启用”，
   * 而按钮的 `disabled` 由 `TitleBar` 读 `previewStore.status` 控制——这里只是兜底
   * （快捷键 `Ctrl+P` 同样走这个入口，快捷键不检查 `disabled`）。
   */
  const onPackage = useCallback(() => {
    if (usePreviewStore.getState().status !== 'ready') {
      notify(t('lifecycle.packageNotReady'), 'error')
      return
    }
    void packageProject(io).then((result) => {
      if (!result.ok) setIssuesOpen(true)
    })
  }, [io, notify])

  useShortcuts({
    onSave,
    onUndo: () => undo(),
    onRedo: () => redo(),
    onImport: onImport,
    onExport: onExport,
    onPackage: onPackage,
    onTogglePause: () => usePreviewStore.getState().togglePause(),
  })

  const impact = pendingDelete ? analyzeDeletion(project, pendingDelete.kind, pendingDelete.id) : null

  return (
    <div className="app">
      <TitleBar
        onNew={() => (useProjectStore.getState().dirty ? requestNew() : newProject(io))}
        onSave={onSave}
        onImport={onImport}
        onExport={onExport}
        onUndo={() => undo()}
        onRedo={() => redo()}
        onPackage={onPackage}
      />
      <div className="app-body">
        <SideNav />
        <main className="app-main">
          <Workspace />
        </main>
        <PreviewPane />
      </div>

      {toast ? (
        <div className={toast.tone === 'error' ? 'toast error' : 'toast'} role="status">
          <span>{t(toast.text, { count: issuesOfLastOperation().length, message: toast.text })}</span>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={dismissToast}>
            ✕
          </button>
        </div>
      ) : null}

      {/* 新建确认（7.9：有未保存改动时先确认） */}
      <Dialog
        open={confirmNew}
        title={t('lifecycle.new.title')}
        onClose={confirmNewProject}
        footer={
          <>
            <button type="button" className="btn" onClick={confirmNewProject}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                newProject(io)
                confirmNewProject()
              }}
            >
              {t('common.confirm')}
            </button>
          </>
        }
      >
        <p>{t('lifecycle.new.confirm')}</p>
      </Dialog>

      {/* 删除确认（7.5：列出受影响引用，不做级联，D-38） */}
      <Dialog
        open={pendingDelete !== null}
        title={t('delete.title')}
        onClose={() => requestDelete(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => requestDelete(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn danger"
              data-testid="confirm-delete"
              onClick={() => {
                confirmDelete()
              }}
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        {pendingDelete && impact ? (
          <>
            <p>
              {t('delete.title')}：<strong>{pendingDelete.name}</strong>
            </p>
            {impact.dangling.length === 0 ? (
              <p className="muted">{t('delete.noReferences')}</p>
            ) : (
              <>
                <p className="muted">{t('delete.references')}</p>
                <ul>
                  {impact.dangling.map((hit) => (
                    <li key={`${hit.sourceId}-${hit.where}`}>
                      {hit.source} · {hit.where}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {impact.page ? <p className="muted">{t('delete.pageAssignment', { page: impact.page.name })}</p> : null}
            {impact.createPageRefs.length > 0 ? (
              <p className="field-error">E_PAGE_UNKNOWN：{impact.createPageRefs.map((hit) => `${hit.source} · ${hit.where}`).join('、')}</p>
            ) : null}
            <p className="muted small">{t('delete.dynamicUntouched')}</p>
          </>
        ) : null}
      </Dialog>

      {/* 导入确认（10.2：只提供覆盖当前项目 / 取消，D-33） */}
      <Dialog
        open={importText !== null}
        title={t('lifecycle.import.title')}
        onClose={() => {
          setImportText(null)
          setPendingImport(null)
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setImportText(null)
                setPendingImport(null)
              }}
            >
              {t('lifecycle.import.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              data-testid="confirm-import"
              onClick={() => {
                const text = importText
                setImportText(null)
                setPendingImport(null)
                if (text) {
                  void importProject(io, text, true).then((result) => {
                    if (!result.ok) setIssuesOpen(true)
                  })
                }
              }}
            >
              {t('lifecycle.import.confirm')}
            </button>
          </>
        }
      >
        <p>{t('lifecycle.import.overwrite')}</p>
      </Dialog>

      {/* 校验问题清单（6.4：定位路径 + 错误码） */}
      <Dialog open={issuesOpen} title={t('error.title')} onClose={() => setIssuesOpen(false)}>
        {issuesOfLastOperation().length === 0 ? (
          <p className="muted">{t('error.none')}</p>
        ) : (
          <ul className="issue-list">
            {issuesOfLastOperation().map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <code>{issue.code}</code>
                <span className="muted">{issue.where}</span>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  )
}

export { requestDeleteFor }
