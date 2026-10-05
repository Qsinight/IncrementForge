/**
 * `@iforge/build/node` —— 仅 Node 可用的入口（esbuild 编译 + CLI）。
 *
 * ## 为什么要单开一个子路径
 *
 * `bundle.ts` 顶层 `import { build } from 'esbuild'`。如果 `index.ts` 也把它导出，
 * 编辑器（浏览器）打包自己的 bundle 时就会把 esbuild 的原生绑定一起拖进去——
 * Vite 会因为无法解析 `esbuild/lib/main.js` 的浏览器版本而构建失败，或者更糟：
 * 构建成功、运行时才崩。
 *
 * 子路径导出让依赖方向在**模块图**上就是显式的：编辑器只 import `@iforge/build`，
 * 只有 CLI / e2e 才 import `@iforge/build/node`。
 */
export { compileRuntimeBundle, cssInlinePlugin, STANDALONE_ENTRY } from './bundle.js'
export type { CompileOptions } from './bundle.js'
export { runCli } from './cli.js'
export { warmUpGzip } from './package-game.js'
export { writeExampleProject } from './write-example.js'
