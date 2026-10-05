/**
 * `docs:gen` 的 CLI 入口（`scripts/docs-gen.mjs` 调用）。
 *
 * 独立成文件而不是放进 `docgen.ts`：`docgen.ts` 是**纯函数**（被 `docs:check` 与单测直接调用，
 * 不碰文件系统），而读文件与写盘属于 Node 侧 I/O。分开之后，`docs:check` 不会因为引入
 * `node:fs` 而无法在任意环境运行。
 */
import { readFile, writeFile } from 'node:fs/promises'

import { DOC_GEN_BLOCKS, generateDocTables } from './docgen.js'

/**
 * 对文档执行一次生成或校验。
 *
 * @param path 文档路径
 * @param check 只校验（`docs:check` 用）；否则写回
 * @returns 退出码：`0` 一致，`1` 有差异/缺标记
 */
export async function runDocGen(path: string, check: boolean): Promise<number> {
  const source = await readFile(path, 'utf8')
  // 文档在 Windows 上是 CRLF；统一成 LF 再比对，否则每次都会报“整块都不同”。
  const normalized = source.replace(/\r\n/g, '\n')
  const { result, text } = generateDocTables(normalized, check)

  if (result.missing.length > 0) {
    for (const id of result.missing) {
      process.stderr.write(`缺少生成块标记：<!-- docs:gen:${id}:start --> / <!-- docs:gen:${id}:end -->\n`)
    }
  }
  if (check && result.mismatched.length > 0) {
    for (const id of result.mismatched) {
      process.stderr.write(`生成块 ${id} 与字段白名单不一致。请运行 \`pnpm docs:gen\` 回写。\n`)
    }
  }
  if (result.missing.length > 0) return 1

  if (check) {
    // 只校验：不一致即失败，交给调用方（`docs:check` / CI）阻断。
    const mismatched = result.mismatched.length
    // 通过时也要说一句话：`pnpm docs:gen -- --check` 静默退出让人怀疑“到底跑没跑”。
    // 这里只影响 CLI（`docs:check` 直接调纯函数 `generateDocTables`，不经过本文件）。
    process.stdout.write(mismatched === 0 ? `${path} 的生成块已是最新（${DOC_GEN_BLOCKS.length} 块）\n` : `${path} 有 ${mismatched} 个生成块待回写\n`)
    return mismatched === 0 ? 0 : 1
  }

  // 回写模式：`generateDocTables` 已经把差异补进去了，写盘即可。
  // 写完仍然**不**报“不一致”——那会让 `pnpm docs:gen` 在成功修复之后还返回非 0，
  // 第一次运行永远“失败”，逼得人去忽略退出码。
  if (text !== normalized) {
    await writeFile(path, text, 'utf8')
    process.stdout.write(`已回写 ${path}（${result.mismatched.length} 个生成块）\n`)
  } else {
    process.stdout.write(`${path} 已是最新\n`)
  }
  return 0
}
