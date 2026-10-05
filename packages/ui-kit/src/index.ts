/**
 * `@iforge/ui-kit` —— 主题令牌、主题/图标注册表、资产安全过滤（TECH_DESIGN 7.8、13、17.4）。
 *
 * ## 与编辑器组件的分工（3.1 目录树）
 *
 * 目录树把「通用组件（字段控件、表达式输入框、图标选择器）」放在
 * `apps/editor/src/components`，把「主题令牌、主题注册表、图标集、通用控件」放在本包。
 * 本包的取舍是：**框架无关的部分**（令牌、注册表、过滤、SVG 字符串渲染）留在这里，
 * **React 控件**放在 `apps/editor/src/components`。
 *
 * 理由：React 控件会随编辑器交互演进（受 7.x 约束），留在应用内可以避免
 * 为了“控件复用”而把编辑器状态（projectStore、事务合并窗口）泄漏进通用包；
 * 而令牌/注册表是**跨端复用**的（M4 的预览 iframe 与 M5 的打包产物都要用同一份，
 * 否则会出现“编辑器好看、打包成品走样”）。
 *
 * ## 依赖
 *
 * 只依赖 `@iforge/model` 的**类型**（`IconRef`/`ThemeRef`）与 `@iforge/num` 的 `ForgeError`，
 * 不依赖 `expr`/`runtime`（3.2 依赖规则）。
 */
export * from './tokens.js'
export * from './themes.js'
export * from './icons.js'
export * from './render.js'
export * from './sanitize.js'
