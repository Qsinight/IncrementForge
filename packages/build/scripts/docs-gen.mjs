/**
 * `docs:gen` 的启动器（纯 `.mjs`，Node 直接可跑）。
 *
 * 复用 `run-ts.mjs` 的机制（那里记录了为什么 Node 里跑仓库 TypeScript 需要 esbuild 现场打包），
 * 因此这里只有参数与退出码。
 *
 * ## 用法
 *
 * ```bash
 * pnpm docs:gen          # 回写生成块
 * pnpm docs:gen --check  # 只校验（docs:check 的同一份实现）
 * ```
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { runTs } from './run-ts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// `docs:gen` 的实现住在 `packages/model`（它要读 5.9 的 `PROPERTY_SPECS` 与 6.3 的 Zod Schema，
// 3.2 的依赖方向决定了它不能反过来放在 `packages/build` 的 `src/` 里）。
const entry = resolve(here, '..', '..', 'model', 'src', 'docgen-cli.ts')

const check = process.argv.includes('--check')
const target = resolve(process.cwd(), 'docs', 'TECH_DESIGN.md')

const { runDocGen } = await runTs(entry, [target, check ? '--check' : '--write'])
process.exit(await runDocGen(target, check))
