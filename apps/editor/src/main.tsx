/**
 * 编辑器入口（TECH_DESIGN 3.1 的 `apps/editor`、7.2）。
 *
 * 启动顺序：
 * 1. 打开 IndexedDB（10.1）→ 注入 `ProjectIo`；
 * 2. 读编辑器偏好（主题、面板宽度、当前项目指针，7.2 `settingsStore`）；
 * 3. 载入上次项目或新建默认模板（7.9）；
 * 4. 挂载 React 应用。
 *
 * IndexedDB 不可用（隐私模式/禁用存储）时**不静默失败**：把错误渲染到页面上，
 * 因为“编辑器打不开且没有提示”是最难排查的失败形态。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AssetRepository, MetaRepository, ProjectRepository, openForgeDb } from '@iforge/persist'

import { App } from './App.js'
import { hydrateSettings, applyEditorTheme } from './stores/settings.js'
import { restoreLastProject } from './features/shell/projectIo.js'
import './styles/editor.css'

/** 挂载 React 应用。 */
export function mount(container: HTMLElement): void {
  createRoot(container).render(
    <StrictMode>
      <App io={io} />
    </StrictMode>,
  )
}

/**
 * 运行期依赖（`ProjectIo`）。
 *
 * 顶层初始化而不是在组件里 `await`：编辑器是**单项目**应用（15），启动时打开一次库就够了；
 * 组件里再 open 会引入第二个连接，让“保存写入哪个库”变得不确定。
 */
const io = {
  projects: undefined as unknown as ProjectRepository,
  assets: undefined as unknown as AssetRepository,
  meta: undefined as unknown as MetaRepository,
}

/** 启动流程（返回失败信息便于测试与页面提示）。 */
export async function bootstrap(): Promise<string | undefined> {
  applyEditorTheme()
  try {
    const db = await openForgeDb()
    io.projects = new ProjectRepository(db)
    io.assets = new AssetRepository(db)
    io.meta = new MetaRepository(db)
    await hydrateSettings(io.meta)
    await restoreLastProject(io)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const root = document.getElementById('root')
if (root) {
  void bootstrap().then((error) => {
    if (error) {
      root.innerHTML = `<div class="fatal"><h1>无法启动编辑器</h1><p>${error}</p><p>请确认浏览器允许使用 IndexedDB（隐私模式会禁用它）。</p></div>`
      return
    }
    mount(root)
  })
}
