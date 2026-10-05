/**
 * 右侧预览区（PRD 工作页面一览「右侧预览区」、TECH_DESIGN 7.1「顶部模拟设置栏」+ 7.1 表、9.1/9.2/9.3）。
 *
 * ## 分工
 *
 * | 部分 | 归属 | 说明 |
 * | --- | --- | --- |
 * **模拟设置栏** | 编辑器外壳 | 设备三选一、暂停/继续、重新开始、倍速、解锁全部（7.1）。**不属于游戏内容**，不进入打包产物（D-42、R-32） |
 * **游戏视图** | iframe 内的 `@iforge/runtime-shell` | 8.11 的组件树，含仪表盘、四类卡片、底部导航、游戏内设置页 |
 * **诊断面板** | 编辑器外壳 | 7.1 末条的错误列表 + 8.7 的“孤儿动态条目”丢弃入口 |
 *
 * 模拟设置栏的每个控件只改 `previewStore`，由 `PreviewFrame` 的 effect 翻译成
 * `host:control`（9.2）——UI 组件不直接拼协议消息，这样“控件状态”和“协议消息”不会各写一遍。
 */
import { useCallback, useRef, useState } from 'react'

import type { SaveFile } from '@iforge/model'
import { t } from '@iforge/i18n'

import { PreviewFrame } from '../features/preview/PreviewFrame.js'
import { activeSession, requestSave, sendActiveControl } from '../features/preview/session.js'
import { DEVICE_MAX_COLUMNS, DEVICE_WIDTH, SPEEDS, totalDiagnostics, usePreviewStore } from '../stores/preview.js'
import type { Speed } from '../stores/preview.js'
import { useSettingsStore } from '../stores/settings.js'
import { formatBytes, formatPercent } from './perf-format.js'

export function PreviewPane() {
  const device = usePreviewStore((state) => state.device)
  const setDevice = usePreviewStore((state) => state.setDevice)
  const paused = usePreviewStore((state) => state.paused)
  const togglePause = usePreviewStore((state) => state.togglePause)
  const speed = usePreviewStore((state) => state.speed)
  const setSpeed = usePreviewStore((state) => state.setSpeed)
  const unlocked = usePreviewStore((state) => state.unlocked)
  const setUnlocked = usePreviewStore((state) => state.setUnlocked)
  const diagnostics = usePreviewStore((state) => state.diagnostics)
  const diagnosticLog = usePreviewStore((state) => state.diagnosticLog)
  const orphans = usePreviewStore((state) => state.orphans)
  const setOrphans = usePreviewStore((state) => state.setOrphans)
  const adviceEntities = usePreviewStore((state) => state.adviceEntities)
  const stats = usePreviewStore((state) => state.stats)
  const status = usePreviewStore((state) => state.status)
  const packaging = usePreviewStore((state) => state.packaging)

  const paneWidth = useSettingsStore((state) => state.paneWidth)
  const setPaneWidth = useSettingsStore((state) => state.setPaneWidth)
  const collapsed = useSettingsStore((state) => state.paneCollapsed)
  const setCollapsed = useSettingsStore((state) => state.setPaneCollapsed)

  const dragging = useRef(false)
  const [panelOpen, setPanelOpen] = useState(false)

  const onResizeStart = useCallback(
    (event: React.PointerEvent) => {
      dragging.current = true
      const startX = event.clientX
      const startWidth = paneWidth
      const onMove = (move: PointerEvent): void => {
        if (!dragging.current) return
        // 面板在右侧：向左拖是加宽。
        setPaneWidth(startWidth + (startX - move.clientX))
      }
      const onUp = (): void => {
        dragging.current = false
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [paneWidth, setPaneWidth],
  )

  const errorCount = totalDiagnostics({ diagnostics })
  // D-41 表：phone 390 / tablet 834 / auto = 容器宽度；断点列数上限与之一一对应。
  const viewportWidth = DEVICE_WIDTH[device]
  const maxColumns = DEVICE_MAX_COLUMNS[device]

  const onDownloadSave = useCallback((save: SaveFile) => {
    // PRD 预览区 9：导出存档 -> 下载 `*.save.json`。宿主在编辑器上下文中下载，
    // 因此不受 9.1 沙箱对文件下载的限制（`sandbox` 没给 `allow-downloads`）。
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${save.projectName || 'incrementforge'}.save.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [])

  return (
    <aside className="preview-pane" data-preview-pane tabIndex={-1} style={{ width: collapsed ? 48 : paneWidth }}>
      <div className="preview-controls" role="toolbar" aria-label={t('preview.controls')}>
        <div className="segmented" role="group" aria-label={t('preview.device')}>
          {(['phone', 'tablet', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={device === mode ? 'seg active' : 'seg'}
              data-testid={`preview-device-${mode}`}
              aria-pressed={device === mode}
              onClick={() => setDevice(mode)}
            >
              {t(`preview.device.${mode}` as 'preview.device.phone')}
            </button>
          ))}
        </div>
        <div className="preview-controls-mid">
          <button
            type="button"
            className="icon-btn"
            data-testid="preview-pause"
            aria-label={paused ? t('preview.resume') : t('preview.pause')}
            aria-pressed={paused}
            onClick={togglePause}
          >
            {paused ? '▶' : '❚❚'}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="preview-restart"
            aria-label={t('preview.restart')}
            onClick={() => {
              // 8.10 的“重新开始”二次确认：不可撤销（清空 assignments/effectValues/dynamic，D-18）。
              if (!window.confirm(t('preview.restartConfirm'))) return
              sendActiveControl('restart')
              // `forceUnlock` 是纯内存标记、重置即清空（D-16），因此按钮态也要复位。
              setUnlocked(false)
            }}
          >
            ⟲
          </button>
          <select
            className="input compact"
            data-testid="preview-speed"
            aria-label={t('preview.speed')}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value) as Speed)}
          >
            {SPEEDS.map((option) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="preview-unlock"
            className={unlocked ? 'btn active' : 'btn'}
            aria-pressed={unlocked}
            onClick={() => setUnlocked(true)}
          >
            {t('preview.unlockAll')}
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          data-testid="preview-export-save"
          aria-label={t('preview.exportSave')}
          onClick={() => {
            // 9.2 的 `host:save{silent}`：宿主请求运行时导出存档。
            // `silent=false` 表示“玩家主动要的”，运行时据此回 `game:save{intent:'export'}`（D-51）。
            const session = activeSession()
            if (session) requestSave(session, false)
          }}
        >
          ⤓
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid="preview-collapse"
          aria-label={collapsed ? t('preview.expand') : t('preview.collapse')}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </div>

      <div className="preview-body">
        {collapsed ? null : (
          <>
            <div className="preview-device" style={viewportWidth ? { maxWidth: viewportWidth } : undefined}>
              {status === 'ready' ? null : (
                <p className="muted pad small" data-testid="preview-status">
                  {t('preview.connecting')}
                </p>
              )}
              <PreviewFrame device={device} downloadSave={onDownloadSave} />
              {stats ? (
                <p className="muted pad small" data-testid="preview-stats">
                  {t('preview.tickMs')}: {stats.tickMs.toFixed(2)}ms · {t('preview.fps')}: {stats.fps.toFixed(0)}
                </p>
              ) : null}
            </div>
            {/* 诊断面板的入口**始终**存在，不只是出错时。
                7.1 只规定“有错误时显示角标”，但 12 性能预算要求诊断面板常驻显示
                tick 耗时 / 求值次数 / 缓存命中率 / 格式化次数——若入口只在出错时出现，
                “一切正常但很慢”的场景就永远看不到那四个数字。
                因此 0 错误时渲染一个不带计数的低调入口（`aria-label` 相同，形状不同）。 */}
            <button
              type="button"
              className={errorCount > 0 ? 'badge error preview-diagnostics' : 'badge preview-diagnostics'}
              data-testid="preview-diagnostics"
              aria-label={errorCount > 0 ? t('error.count', { count: errorCount }) : t('preview.diagnostics')}
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
            >
              {errorCount > 0 ? errorCount : '·'}
            </button>
            {panelOpen ? (
              <div className="preview-panel" role="dialog" aria-label={t('preview.diagnostics')} data-testid="preview-diagnostics-panel">
                <h4 className="panel-title">{t('preview.diagnostics')}</h4>
                {diagnosticLog.length === 0 ? (
                  <p className="muted small">{t('error.none')}</p>
                ) : (
                  <ul className="issue-list">
                    {diagnosticLog.map((item) => (
                      <li key={`${item.code}-${item.where ?? ''}`} data-testid="diagnostic-row">
                        <code>{item.code}</code>
                        <span className="muted">{item.where ?? ''}</span>
                        <span>{item.message}</span>
                        <span className="muted">×{item.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* 8.7 的“孤儿动态条目”丢弃入口：卡片不渲染（pageId 失效），
                    唯一移除路径就是这里或表达式里的 destroy()。

                    丢弃走 `host:control{action:'discard'}` 而不是就地改本地数组：条目住在
                    运行时里（存档侧），只删宿主这份列表会让卡片下次重建又出现。
                    运行时回 `game:event{type:'discard'}`，列表随下一条 `game:stats` 收敛。 */}
                <h4 className="panel-title">{t('preview.orphans')}</h4>
                {orphans.length === 0 ? (
                  <p className="muted small">{t('preview.orphansNone')}</p>
                ) : (
                  <ul className="issue-list" data-testid="orphan-list">
                    {orphans.map((id) => (
                      <li key={id}>
                        <code>{id}</code>
                        <button
                          type="button"
                          className="btn danger"
                          data-testid="orphan-discard"
                          onClick={() => {
                            if (sendActiveControl('discard', id)) setOrphans(orphans.filter((item) => item !== id))
                          }}
                        >
                          {t('game.discard')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 8.6 末条：连续降级 60 tick 的条目在这里按实体键列出。
                    卡片上也会给同一条提示（`game.rewriteAdvice`），但卡片只覆盖**当前页面**，
                    这里覆盖全局——作者在别的页面也看不到自己写坏的条目。 */}
                {adviceEntities.length > 0 ? (
                  <>
                    <h4 className="panel-title">{t('preview.advice')}</h4>
                    <p className="muted small">{t('game.rewriteAdvice')}</p>
                    <ul className="issue-list" data-testid="advice-list">
                      {adviceEntities.map((key) => (
                        <li key={key}>
                          <code>{key}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {/* 12 性能预算末条：tick 耗时 / 求值次数 / 缓存命中率 / 格式化次数。
                    这一段与角标**独立**：诊断数为 0 时性能面板照样要看得到
                    （“一切正常但很慢”和“没有错误”完全是两回事）。 */}
                <h4 className="panel-title">{t('preview.perf')}</h4>
                {stats?.perf ? (
                  <dl className="perf-grid" data-testid="preview-perf">
                    <dt>{t('preview.perfEvaluations')}</dt>
                    <dd data-testid="perf-evaluations">{stats.perf.evaluations}</dd>
                    <dt>{t('preview.perfCache')}</dt>
                    <dd data-testid="perf-cache">{formatPercent(stats.perf.cacheHitRate)}</dd>
                    <dt>{t('preview.perfCompile')}</dt>
                    <dd data-testid="perf-compile">{formatPercent(stats.perf.compileHitRate)}</dd>
                    <dt>{t('preview.perfFormats')}</dt>
                    <dd data-testid="perf-formats">
                      {stats.perf.formats}
                      <span className="muted">
                        {' '}
                        / {t('preview.perfFormatCache')} {stats.perf.formatCacheSize}
                      </span>
                    </dd>
                  </dl>
                ) : (
                  <p className="muted small">{t('preview.connecting')}</p>
                )}
                {stats?.perf?.budgetExhausted ? (
                  <p className="field-error" data-testid="perf-budget">
                    {t('preview.perfBudget')}
                  </p>
                ) : null}

                {/* 11.2 的体积预算：把 1.5MB 这条工程约束摆在作者眼前，
                    否则它只在 CI 里以“测试失败”的形式出现。 */}
                {packaging ? (
                  <>
                    <h4 className="panel-title">{t('package.result')}</h4>
                    <dl className="perf-grid" data-testid="package-result">
                      <dt>{t('package.file')}</dt>
                      <dd data-testid="package-file">{packaging.fileName}</dd>
                      <dt>{t('preview.packageSize')}</dt>
                      <dd data-testid="package-size">{formatBytes(packaging.bytes, packaging.gzipBytes)}</dd>
                      <dt>{t('preview.packageFingerprint')}</dt>
                      <dd data-testid="package-fingerprint">{packaging.fingerprint}</dd>
                    </dl>
                    {packaging.overBudget ? (
                      <p className="field-error" data-testid="package-over-budget">
                        {t('package.overBudget')}
                      </p>
                    ) : null}
                  </>
                ) : null}

                <h4 className="panel-title">{t('preview.columns')}</h4>
                <p className="muted small" data-testid="preview-columns">
                  {maxColumns}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {!collapsed ? <div className="preview-resizer" role="separator" aria-orientation="vertical" onPointerDown={onResizeStart} /> : null}
    </aside>
  )
}
