/**
 * 独立调试页入口（3.1 目录树：`apps/runtime-shell/`「预览沙箱宿主页（仅供开发调试 iframe 内容）」）。
 *
 * 走**直挂**路径（ADR-05 的数据注入方式，17.3）：项目与存档由
 * `window.__IFORGE_BOOTSTRAP__` 提供，而不是等 `host:init`。两种路径共用
 * `mountGameRuntime()` 与同一棵 `AppView`，所以在这里看到的渲染与编辑器预览完全一致。
 *
 * 两种取数方式：
 * - URL 参数 `?bootstrap=<json>`：便于把一个项目文件直接粘进来调试；
 * - 编辑 `index.html` 里的 `window.__IFORGE_BOOTSTRAP__`：便于反复调。
 *
 * 没有引导数据时回落到示例项目（17.2），让这个页面 `pnpm --filter @iforge/runtime-shell dev`
 * 一开就能看到东西。
 */
import './game.css'

import { createExampleProject } from '@iforge/model'

import { mountGameRuntime } from './boot.js'
import type { Bootstrap } from './boot.js'

function bootstrapFromQuery(): Bootstrap | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = new URLSearchParams(window.location.search).get('bootstrap')
  if (!raw) return undefined
  try {
    return JSON.parse(decodeURIComponent(raw)) as Bootstrap
  } catch (error) {
    console.warn('[iforge] ?bootstrap 不是合法 JSON，回落到示例项目', error)
    return undefined
  }
}

const bootstrap = bootstrapFromQuery() ?? window.__IFORGE_BOOTSTRAP__ ?? { project: createExampleProject() }

const element = document.createElement('div')
element.id = 'iforge-root'
document.body.append(element)
// `.iforge-game` 由 `mountGameRuntime()` 统一挂到 `document.body`（见 `boot.ts` 的注释），
// 两条入口因此不可能出现“一边挂了另一边没挂”的样式分裂。

mountGameRuntime({ element, bootstrap, projectId: 'debug-shell', slotId: 'main' })
