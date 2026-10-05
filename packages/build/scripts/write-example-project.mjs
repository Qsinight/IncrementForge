/**
 * 把 `17.2` 的示例项目写成磁盘上的项目文件（`iforge-pack` 与 `e2e/` 的输入）。
 *
 * ## 为什么需要这一步
 *
 * `model` 的 `createExampleProject()` 是**内存**工厂，而 `iforge-pack` 的输入是文件。
 * 这里补的正是中间那一段：`prepareForSave()`（7.9：写 `engineVersion`/`modifiedAt`）
 * + `JSON.stringify(..., null, 2)`（10.2「序列化为格式化 JSON」）。
 *
 * 为什么不把这段逻辑塞进 `cli.ts` 当一个 `--example` 开关：那样 `iforge-pack` 就得
 * 认识“输入不是文件”的模式，而它的契约（`cli.ts` 的文件头）是“输入永远是导出出来的
 * 项目文件”。这里单独一个脚本，让 CLI 的职责保持单一。
 *
 * ## 用法
 *
 * ```bash
 * node packages/build/scripts/write-example-project.mjs path/to/example.json
 * ```
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { runTs } from './run-ts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'write-example.ts')

const target = process.argv[2]
if (target === undefined) {
  process.stderr.write('用法：node packages/build/scripts/write-example-project.mjs <out.json>\n')
  process.exit(2)
}

const { writeExampleProject } = await runTs(entry, [resolve(process.cwd(), target)])
const written = await writeExampleProject(resolve(process.cwd(), target))
process.stdout.write(`${written}\n`)
