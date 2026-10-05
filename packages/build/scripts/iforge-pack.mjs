/**
 * `iforge-pack` 的启动器（纯 `.mjs`，Node 直接可跑，无需 tsx/vite-node）。
 *
 * 实际执行委托给 `run-ts.mjs`——那里记录了“为什么必须在 Node 里用 esbuild 现场打 bundle
 * 才能跑仓库 TypeScript”的三种失败方案及各自原因。
 *
 * ## 用法
 *
 * ```bash
 * pnpm --filter @iforge/build run pack -- <project.json> --sizes
 * pnpm --filter @iforge/build run pack -- --rebuild <project.json>   # 强制重打缓存 bundle
 * ```
 *
 * `--rebuild` 只影响本启动器：它不会进入 `runCli` 的参数表（否则会被当成未知选项）。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { runTs } from './run-ts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'cli.ts')

const argv = process.argv.slice(2)
if (argv.includes('--rebuild')) {
  process.env.IFORGE_FORCE_REBUILD = '1'
  argv.splice(argv.indexOf('--rebuild'), 1)
}

const { runCli } = await runTs(entry, argv)
process.exit(await runCli({ argv }))
