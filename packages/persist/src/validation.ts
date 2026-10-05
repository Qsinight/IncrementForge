/**
 * 校验错误 -> 可定位问题清单（TECH_DESIGN 6.4「定位路径」、10.2「导出前跑一次校验」）。
 *
 * ## 为什么单独一个模块
 *
 * 保存（`ProjectRepository.save`）与导出（`exportProjectJson`）都要**在写盘/落文件之前**
 * 拿到结构化的问题清单，而不是一条拼好的 `message` 字符串。6.4 与 11.1 都要求
 * “列出问题位置”，编辑器要按 `where` 把红框标到具体输入框。
 *
 * `model` 的 `parseProjectFile()` 已经把全部问题汇总进 message（便于命令行阅读），
 * 但**结构化**的信息在它内部被拍平了；这里直接从 Schema 上跑一次拿原始 Zod issue，
 * 因此两条路径共用同一份校验实现，却各自保留合适的输出形态。
 */
import type { ZodIssue } from 'zod'
import { isForgeError } from '@iforge/num'
import type { ErrorCode } from '@iforge/num'
import type { ValidationIssue } from '@iforge/model'

/**
 * Zod path -> 定位文本：`['generators', 0, 'costs']` -> `generators[0].costs`。
 *
 * 与 6.4 的定位写法一致：数组下标用 `[n]`、字段名用 `.`（首段没有点）。
 */
export function formatWhere(path: ReadonlyArray<string | number>): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

/**
 * Zod issue -> `ValidationIssue`。
 *
 * `schema.ts` 的 `superRefine` 把一致性问题写成 `` `${code}: ${message}` `` 或纯 `` `code` ``，
 * 因此这里把错误码从 message 里**还原**出来（否则编辑器只能显示 `E_SCHEMA`，无法分支处理）。
 */
export function issueFromZod(issue: ZodIssue): ValidationIssue {
  const message = issue.message
  const matched = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(message)
  const code = (matched?.[1] ?? 'E_SCHEMA') as ErrorCode
  const rest = matched?.[2]
  return { code, where: formatWhere(issue.path), message: rest ?? (matched ? '' : message) }
}

/** 一批 Zod issue -> 问题清单。 */
export function issuesFromZod(issues: readonly ZodIssue[]): ValidationIssue[] {
  return issues.map(issueFromZod)
}

/** `ForgeError` -> 单条问题（版本不兼容、迁移失败等在结构校验之前抛出的错误）。 */
export function issueFromError(error: unknown): ValidationIssue {
  if (isForgeError(error)) return { code: error.code, where: error.where ?? '', message: error.message }
  return {
    code: 'E_SCHEMA',
    where: '',
    message: error instanceof Error ? error.message : String(error),
  }
}
