/**
 * 在 Node 里执行仓库内的 TypeScript 源码（供 `iforge-pack`、示例项目生成器等脚本复用）。
 *
 * ## 为什么需要它：三条路都走不通
 *
 * 这里记录**每种方案失败的原因**，因为它们都不是“写法不对”，而是不解决就会复发的问题：
 *
 * 1. `node --experimental-strip-types` 直接跑 `src/cli.ts`：**模块解析**不认
 *    `./cli.js` -> `cli.ts` 的映射（全仓按 3.2 的 bundler 约定书写），报
 *    `ERR_MODULE_NOT_FOUND`。加一个 `module.register` 解析钩子能解决这一层……
 * 2. ……但解析解决后是**语法**：`strip-only` 模式不支持构造函数参数属性
 *    （`constructor(private readonly tokens: Token[])`），而 `@iforge/expr` 的 `Lexer`、
 *    `@iforge/persist` 的仓储都在用。`--experimental-transform-types` 能处理，
 *    但它是实验特性且明显更慢，不值得为一个 CLI 付这个风险。
 * 3. `tsx` / `vite-node`：能跑通，但为了跑仓库代码引入两个开发依赖不划算——
 *    而且它们会让“CLI 能跑”和“测试跑不了”变成两种可能的语义。
 *
 * esbuild 本来就是 `build` 包的既有依赖（M4 已用它打过运行时产物），用它把
 * 入口连同整个依赖图打成**一个临时 ESM 文件**再 `import()`，既绕开上面全部三个限制，
 * 又不给仓库引入任何新依赖。
 *
 * 产物落在 `node_modules/.cache/iforge-scripts/`（不进版本库），改源码会自动失效。
 *
 * @param entry 入口 `.ts` 的绝对路径
 * @param args 传给入口的 argv（入口读 `IFORGE_SCRIPT_ARGS`，见下）
 * @returns 入口模块的命名空间
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 缓存根目录（`node_modules/.cache` 由 pnpm 与 git 自动忽略）。 */
const CACHE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache', 'iforge-scripts')

/**
 * 会被扫描的源码目录（改动其中任一文件都会让缓存失效）。
 *
 * 显式列出而不是遍历 `packages/*`：多扫几个无关包的代价可以忽略，
 * 而**漏扫一个**会让 CLI 用到过期逻辑——那才是真正难查的问题。
 * 顺序即相对 `@iforge/build` 的路径。
 */
const WATCHED_DIRS = [
  'src',
  '../num/src',
  '../expr/src',
  '../model/src',
  '../runtime/src',
  '../ui-kit/src',
  '../persist/src',
]

/**
 * 打包并执行一个入口。
 *
 * @param entry 入口 `.ts`
 * @param args 传给入口的 argv（**不**走 `process.argv`——那里面混着启动器自己的参数）
 */
export async function runTs(entry, args = []) {
  const cacheDir = join(CACHE_ROOT, hashOf(entry))
  const outFile = join(cacheDir, 'main.mjs')

  // `IFORGE_FORCE_REBUILD=1` 供 `--rebuild` 与 CI 的干净工作区使用。
  const force = process.env.IFORGE_FORCE_REBUILD === '1'
  if (force || !existsSync(outFile) || (await sourcesChanged(outFile, entry))) {
    await rm(cacheDir, { recursive: true, force: true })
    await mkdir(cacheDir, { recursive: true })
    await build({
      entryPoints: [entry],
      bundle: true,
      outfile: outFile,
      format: 'esm',
      platform: 'node',
      target: ['node20'],
      minify: true,
      logLevel: 'silent',
      // `@iforge/*` 必须打进 bundle：workspace 包的 `exports` 指向 `src/*.ts`
      // （3.1 的“源码互引”约定），Node 无法直接执行。只有带原生绑定的
      // esbuild 需要留在外部——`bundle.ts` 只在**调用点**才需要它。
      external: ['esbuild'],
    })
  }

  process.env.IFORGE_SCRIPT_ARGS = JSON.stringify(args)
  return import(pathToFileURL(outFile).href)
}

/** 入口路径 -> 稳定的缓存目录名（同一入口永远命中同一目录）。 */
function hashOf(entry) {
  let hash = 0x811c9dc5
  for (const char of entry) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 产物是否比任何一个被监视的源码文件更旧。 */
async function sourcesChanged(outPath, entry) {
  const builtAt = (await stat(outPath)).mtimeMs
  if ((await stat(entry)).mtimeMs > builtAt) return true
  const root = resolve(dirname(entry), '..')
  for (const dir of WATCHED_DIRS) {
    const target = resolve(root, dir)
    if (!existsSync(target)) continue
    if ((await newestMtime(target)) > builtAt) return true
  }
  return false
}

/** 目录里最新的源码文件 mtime（毫秒；目录不存在时为 0）。 */
async function newestMtime(dir) {
  let newest = 0
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await stat(path)
    if (info.isDirectory()) newest = Math.max(newest, await newestMtime(path))
    else if (/\.(ts|tsx|json|css)$/.test(name)) newest = Math.max(newest, info.mtimeMs)
  }
  return newest
}
