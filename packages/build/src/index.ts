/**
 * `@iforge/build` —— 单文件打包（TECH_DESIGN 11、17.3）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime ← build`。本包是**构建期**工具，
 * 允许导入 Node API（`node:fs`、`node:zlib`、`esbuild`）——与 `runtime` 的“无 DOM”约束
 * 同源但不同层：`runtime` 跑在浏览器里，`build` 跑在 Node 里（编辑器的“打包”按钮
 * 走的是 `packageGame()` 的**纯函数**部分，编译步骤由构建期完成，见 `bundle.ts` 的注释）。
 *
 * ## 模块地图
 *
 * | 模块 | 职责 | 文档 |
 * | --- | --- | --- |
 * | `validate` | 打包前 7 条校验（复用 `validateProject` + 补设置/资产） | 11.1 |
 * | `fingerprint` | 项目指纹（规范化后 FNV-1a）与产物文件名 | 11.1 末条 |
 * | `template` | 17.3 的单文件模板、`__IFORGE_BOOTSTRAP__` 注入与转义 | 17.3、13 第 5 条 |
 * | `package-game` | 管线编排与体积预算 | 11.1、11.2 |
 * | `bundle` | Node 侧的 esbuild 编译（CLI / e2e 用） | 11.1 第 1 步 |
 * | `cli` | `iforge-pack` 命令行入口 | 11.1 |
 *
 * ## 导出面为什么分成两半
 *
 * - **浏览器可用**：`packageGame`、`validateForPack`、`renderBundleHtml`、`projectFingerprint`——
 *   编辑器直接 import 它们（纯函数，无 Node 依赖）；
 * - **仅 Node**：`compileRuntimeBundle`、`runCli`——从子路径 `@iforge/build/node` 引入，
 *   这样编辑器的 bundle 不会因为顶层 `import 'esbuild'` 而失败。
 */
export * from './validate.js'
export * from './fingerprint.js'
export * from './template.js'
export * from './package-game.js'
// `write-example.ts` 与 `bundle.ts` 一样只在 Node 侧使用（它们要读文件、跑 esbuild），
// 从 `@iforge/build/node` 导出——编辑器 import 顶层入口时不会把 `node:fs` 拖进浏览器 bundle。
