/**
 * Vite 虚拟模块的类型声明。
 *
 * 两个模块都由 `apps/editor/vite/iforge-runtime-shell.ts` 在构建时用 esbuild 产出
 * （9.1 预览注入物、11.1 打包产物运行时），它们没有对应的磁盘文件，
 * 因此必须显式声明类型，否则 `tsc --noEmit` 报“找不到模块”。
 *
 * 默认导出是**编译产物的文本**（一个自执行 IIFE）：
 *
 * | 虚拟模块 | 入口 | 挂载点 | 消费方 |
 * | --- | --- | --- | --- |
 * | `virtual:iforge-runtime-shell` | `iframe-entry.ts` | `#iforge-root` | `PreviewFrame` 的 `srcdoc` |
 * | `virtual:iforge-standalone-runtime` | `standalone-entry.ts` | `#app` | `packageGame()` 的 `runtimeSource` |
 *
 * **两者不可互换**：打包模板只提供 `#app`，误用预览那份会让运行时自己新建
 * `#iforge-root` 挂到空 `#app` 之下，于是页面上半部分留出一整屏空白。
 */
declare module 'virtual:iforge-runtime-shell' {
  /** esbuild 产出的 IIFE 文本（含 React 与全部 `@iforge/*`，以及内联的 CSS）。 */
  const source: string
  export default source
}

declare module 'virtual:iforge-standalone-runtime' {
  /** 与 `virtual:iforge-runtime-shell` 同规格的 IIFE 文本，但入口是**直挂**版。 */
  const source: string
  export default source
}
