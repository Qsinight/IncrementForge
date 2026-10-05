/**
 * 环境相关的类型补充：`?inline` CSS 导入（Vite 与本项目的 esbuild 插件都支持该后缀）。
 *
 * 单独成文件而不是塞进某个 `tsconfig` 的 `include` 之外的路径——
 * `*.css?inline` 不是 TS 能自己推断的模块形态，必须显式声明，否则 `tsc --noEmit` 报错。
 */
declare module '*.css?inline' {
  const css: string
  export default css
}

declare module '*.css' {
  const css: string
  export default css
}
