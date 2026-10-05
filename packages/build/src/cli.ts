/**
 * `iforge-pack` —— 命令行打包入口（TECH_DESIGN 11.1 的管线，CLI 形态）。
 *
 * ## 为什么要 CLI
 *
 * 11.1 的管线本身与“谁点的打包按钮”无关。CLI 存在的三个理由：
 *
 * 1. **CI / 门禁**：14.3 的合并门禁要跑“打包产物冒烟测试”，那需要一条能脚本化的打包命令；
 * 2. **回归定位**：M5 的 E2E 需要在 Node 里产出产物再让浏览器打开（浏览器不能跑 esbuild）；
 * 3. **体积观测**：`--sizes` 直接打印 raw / gzip 字节数，是 11.2 预算最省事的观测点。
 *
 * ## 输入为什么是“项目 JSON 文件”而不是内存模型
 *
 * CLI 拿不到编辑器的内存模型。走文件路径正好复用 10.2 的导入路径（大小上限 → Zod → 迁移），
 * 也就是“作者导出的那份 `.json`”——这恰恰是最该被打包的东西：
 * 它已经完成 10.1「保存/导出规范化」的资产内联，`checkAssets` 因此天然通过。
 *
 * ## 为什么不 import `@iforge/persist`
 *
 * 10.2 的导入路径拆成两半：**纯函数**部分在 `@iforge/model`（`parseProjectFile`），
 * **依赖 IndexedDB** 的部分在 `persist`（`importProjectJson` 里的 `assertProjectSize` 走
 * 同一条文本上限判定，但那只是读 `text.length`）。
 *
 * CLI 里没有浏览器，`persist` 的仓储构造会引入 `IDBDatabase` 全局（其源码用了 TS
 * 参数属性，Node 的 strip-only 类型剥离也处理不了）。把纯函数部分留在 `model`、
 * CLI 只依赖它，既符合 3.2 的依赖方向，也让 `build` 不必拖一个浏览器包。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseProjectFile } from '@iforge/model'

import { compileRuntimeBundle } from './bundle.js'
import { formatPackIssues, validateForPack } from './validate.js'
import { packageGame, warmUpGzip } from './package-game.js'
import { MAX_PROJECT_BYTES } from '@iforge/ui-kit'

/**
 * CLI 的 I/O 与工作目录（便于测试注入）。
 *
 * 全部字段**可选**：缺省时从 `process` 与环境变量取，因此
 * `node scripts/iforge-pack.mjs <args>` 与单测里的 `runCli()` 走的是同一份实现。
 */
export interface CliIo {
  /** 命令行参数；缺省读 `IFORGE_SCRIPT_ARGS`，再缺省读 `process.argv`。 */
  argv?: readonly string[]
  stdout?(text: string): void
  stderr?(text: string): void
  cwd?: string
}

/**
 * 从运行环境取 argv。
 *
 * 优先 `IFORGE_SCRIPT_ARGS`（`scripts/run-ts.mjs` 通过它注入，见该文件的注释）：
 * 启动器的参数里有 `--rebuild` 之类**不该**被 `runCli` 看到的东西，
 * 直接读 `process.argv.slice(2)` 会把它们当成打包参数。
 * 没有该变量时回落到 `process.argv`（例如被别的 runner 直接调用时）。
 */
function argvFromEnv(): string[] {
  const raw = typeof process !== 'undefined' ? process.env.IFORGE_SCRIPT_ARGS : undefined
  if (raw === undefined) return typeof process === 'undefined' ? [] : process.argv.slice(2)
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * 跑一次命令行打包。
 *
 * @returns 进程退出码：`0` 成功，`1` 校验/打包失败，`2` 用法错误。
 */
export async function runCli(io: Partial<CliIo> = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(`${text}\n`))
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(`${text}\n`))
  const cwd = io.cwd ?? process.cwd()
  const args = [...(io.argv ?? argvFromEnv())]
  if (args.includes('--help') || args.includes('-h')) {
    stdout(usage())
    return 0
  }

  const sizes = args.includes('--sizes')
  const outputIndex = args.indexOf('--out')
  // `--out <path>` 的**值**不是位置参数，必须先摘掉，否则 `--out game.html` 里的
  // `game.html` 会被当成输入项目、真正要打包的那个反而排在后面。
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out')
  const projectPath = positional[0]
  if (projectPath === undefined) {
    stderr(usage())
    return 2
  }

  let project
  try {
    const text = await readFile(resolve(cwd, projectPath), 'utf8')
    // 13 第 6 条：大小上限先于解析，避免超大文件拖垮主线程。
    if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) {
      stderr(`项目文件超过 ${MAX_PROJECT_BYTES / 1024 / 1024}MB 上限（13 第 6 条）`)
      return 1
    }
    project = parseProjectFile(text)
  } catch (error) {
    stderr(`读取或解析项目文件失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  // 先单独跑一遍校验：不通过就**不必**编译运行时（约 300ms），错误信息也因此更快出来。
  const issues = validateForPack(project)
  if (issues.length > 0) {
    stderr('打包前校验未通过（11.1）：\n' + formatPackIssues(issues))
    return 1
  }

  // 预加载 `zlib`：`packageGame` 是同步的，而 ESM 里 `node:zlib` 只有异步入口。
  // 编译运行时要等 ~300ms，顺手把 zlib 拉进来零成本（`package-game.ts` 的注释）。
  await warmUpGzip()

  const runtimeSource = await compileRuntimeBundle()
  const outcome = packageGame({ project, runtimeSource })
  if (!outcome.ok) {
    stderr('打包失败：\n' + formatPackIssues(outcome.issues))
    return 1
  }

  const target =
    outputIndex >= 0 && args[outputIndex + 1] !== undefined ? resolve(cwd, args[outputIndex + 1] as string) : resolve(cwd, outcome.fileName)
  await writeFile(target, outcome.html, 'utf8')

  stdout(`已打包：${target}`)
  stdout(`  指纹     ${outcome.meta.fingerprint}`)
  stdout(`  引擎版本 ${outcome.meta.engineVersion}`)
  stdout(`  打包时间 ${outcome.meta.builtAt}`)
  if (sizes) {
    const gzip = outcome.gzipBytes === 0 ? '不可用' : `${(outcome.gzipBytes / 1024).toFixed(1)}KB`
    stdout(`  体积     ${(outcome.bytes / 1024).toFixed(1)}KB（gzip ${gzip}）`)
    stdout(`  预算     ${outcome.overBudget ? '超出 11.2 的 1.5MB' : '在 11.2 的预算内'}`)
  }
  return 0
}

function usage(): string {
  return [
    '用法：iforge-pack <project.json> [--out <game.html>] [--sizes]',
    '',
    '把一个导出的项目文件打包成**单文件**可离线游玩的 HTML（TECH_DESIGN 11.1）。',
    '打包前会跑 11.1 的 7 条校验，任何一条不过都以非 0 退出并列出问题位置。',
    '',
    '选项：',
    '  --out <path>  产物路径（默认 `<项目名>.html`，与项目文件同目录）',
    '  --sizes       打印原始/gzip 体积与 11.2 的预算判定',
    '  -h, --help    显示本帮助',
  ].join('\n')
}
