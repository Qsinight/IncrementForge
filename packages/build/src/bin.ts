/**
 * `runCli` 的可执行入口，供 `scripts/iforge-pack.mjs` 之外的环境使用。
 *
 * ## 为什么不是一个独立脚本
 *
 * Node 的 `--experimental-strip-types` **不做** `.js` -> `.ts` 的模块映射，
 * 而全仓源码按 3.2 的 bundler 约定写 `./cli.js`。启动器因此需要额外的解析钩子
 * （`scripts/ts-resolver.mjs`），把这件事放在 `scripts/` 里而不是 `src/`：
 * `src/` 里的模块要同时被 Vite/Vitest/esbuild/tsc 消费，多一份 Node 专用的
 * 扩展名写法只会给三条构建路径制造分歧。
 *
 * 本文件保留是为了让 `src/` 也有一个明确的“CLI 在这里”落点（便于 `docs:check`
 * 之类的脚本定位），运行时入口一律走 `scripts/iforge-pack.mjs`。
 */
export { runCli } from './cli.js'
export type { CliIo } from './cli.js'
