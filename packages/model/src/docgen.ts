/**
 * `docs:gen` —— 从**字段白名单**生成文档里的可校验块（TECH_DESIGN 14.3 末段）。
 *
 * ## 为什么**不**整表重写 5.9 / 6.3
 *
 * 14.3 已经点明三份表格属人工维护的**追溯信息**，不可生成（PRD 编号 ↔ Schema 字段之间
 * 没有可推导的关系）。而 5.9 / 6.3 的现表是**面向阅读**的：它把同类的属性合并成一行
 * （`` `id` / `order` / `name` / `icon` ``、`` `produces[i].materialId` / `.amount` ``），
 * 并在“存档位置”列里带上说明文字（“顶层 `effectValues[i]`（PRD 升级编辑器 12）”）。
 * 按字段逐行生成会把这些合并与说明全部抹平，文档反而更难读。
 *
 * 因此本模块生成的是**紧随人工表之后的一个派生块**：
 *
 * ```
 * <!-- docs:gen:5.9.1:start -->
 * …逐字段的规范化清单（类型 / 可读 / 可写 / 存档位置）…
 * <!-- docs:gen:5.9.1:end -->
 * ```
 *
 * 它与人工表内容一致但粒度更细（一个字段一行），用途有三个：
 *
 * 1. **可校验**：漏改字段白名单时，`docs:check` 在这一块上失败，且错误信息能指向具体字段；
 * 2. **可执行**：单测与规则 1 可以直接读它，不必解析合并行；
 * 3. **不破坏可读性**：人工表保持原样，派生块标注“由 `docs:gen` 生成，勿手改”。
 *
 * ## 与 R-33 的关系
 *
 * R-33 记录的事故是“新增可写属性时只改了权限矩阵、没同步 `SaveFile`”。本模块的
 * `6.3.fields` 生成块直接列出四类实体的顶层字段集合，因此那条事故在**文档层面**
 * 也会立刻暴露（`docs:gen --check` 失败），而不只是单测里的 `checkSaveCoverage()`。
 */
import { PROPERTY_SPECS } from '@iforge/expr'
import type { PropertySpec } from '@iforge/expr'

import { saveGeneratorShape, savePageShape, saveResourceShape, saveUpgradeShape } from './schema.js'

/** 一条属性的规范化描述（5.9 表格的一行，**一个字段一行**）。 */
export interface MatrixRow {
  /** 属性路径（5.9.1/5.9.2 第一列，如 `costs[i].amount`）。 */
  path: string
  /** 适用的条目前缀。 */
  prefixes: string
  /** 类型（中文标注）。 */
  type: string
  /** 可读（第三列）。 */
  readable: boolean
  /** 可写（第四列）。 */
  writable: boolean
  /** 存档位置（第五列）。 */
  storage: string
  /** 重新开始时的行为（第六列）。 */
  resetTo: string
}

/** 生成块 id -> 起止标记。 */
const START = (id: string): string => `<!-- docs:gen:${id}:start -->`
const END = (id: string): string => `<!-- docs:gen:${id}:end -->`

/** 生成块 id。 */
export const DOC_GEN_BLOCKS = ['5.9.1', '5.9.2', '6.3.fields'] as const
export type DocGenBlock = (typeof DOC_GEN_BLOCKS)[number]

/** 类型 -> 文档里的中文标注。 */
const TYPE_TEXT: Readonly<Record<string, string>> = {
  string: '字符串',
  number: '数值',
  boolean: '布尔',
}

/** 存档位置 -> 文档里的中文标注。 */
const STORAGE_TEXT: Readonly<Record<string, string>> = {
  'top-level': '顶层',
  assignments: '仅 `assignments`',
  derived: '不存档（派生量）',
}

/** 前缀 -> 中文类名（生成块里的第一列辅助信息）。 */
const PREFIX_TEXT: Readonly<Record<string, string>> = {
  res: '资源',
  gen: '生成器',
  up: '升级',
  page: '页面',
}

/**
 * 5.9.1（条目属性）的逐字段清单。
 *
 * 行序即 `PROPERTY_SPECS` 的声明顺序——它是 5.9 表的**唯一事实源**
 * （`properties.ts` 的文件头已声明这一点），因此本函数只做“结构化数据 → Markdown 行”，
 * 不做排序判断。
 *
 * `res.owned` 是 `amount` 的别名（D-37）：它在人工表里单独成行，因此这里**保留**
 * （规则 1 的可执行版 `checkSaveCoverage()` 会显式跳过它，见 `coverage.ts`）。
 */
export function entryMatrixRows(): MatrixRow[] {
  return rowsFor(['res', 'gen', 'up'])
}

/** 5.9.2（页面属性）的逐字段清单。 */
export function pageMatrixRows(): MatrixRow[] {
  return rowsFor(['page'])
}

function rowsFor(prefixes: readonly string[]): MatrixRow[] {
  const out: MatrixRow[] = []
  for (const [name, spec] of Object.entries(PROPERTY_SPECS)) {
    const applicable = spec.prefixes.filter((prefix) => prefixes.includes(prefix))
    if (applicable.length === 0) continue
    out.push(toRow(name, spec, applicable))
  }
  return out
}

function toRow(name: string, spec: PropertySpec, applicable: readonly string[]): MatrixRow {
  return {
    path: name,
    prefixes: applicable.map((prefix) => PREFIX_TEXT[prefix] ?? prefix).join('/'),
    type: TYPE_TEXT[spec.type] ?? spec.type,
    readable: spec.readable,
    writable: spec.writable,
    storage: STORAGE_TEXT[spec.storage] ?? spec.storage,
    resetTo: spec.resetTo,
  }
}

/** 一行属性渲染成的 Markdown 表格行（7 列）。 */
export function renderMatrixRow(row: MatrixRow): string {
  const cells = [`\`${row.path}\``, row.prefixes, row.type, row.readable ? '✅' : '❌', row.writable ? '✅' : '❌', row.storage, row.resetTo]
  return `| ${cells.join(' | ')} |`
}

/** 生成块里的表头（人工表已有一份，这里是规范化版本）。 */
function renderMatrixHeader(): string {
  return '| 属性路径 | 适用 | 类型 | 可读 | 可写 | 存档位置 | 重新开始时 |\n| --- | --- | --- | --- | --- | --- | --- |'
}

/** 6.3 的四类实体顶层字段（与 `coverage.ts` 同源：都取自 Zod Schema 的形状）。 */
export interface SaveShapeRow {
  entity: 'resource' | 'generator' | 'upgrade' | 'page'
  fields: readonly string[]
}

/** 6.3 顶层字段集合。 */
export function saveShapeRows(): SaveShapeRow[] {
  return [
    { entity: 'resource', fields: Object.keys(saveResourceShape) },
    { entity: 'generator', fields: Object.keys(saveGeneratorShape) },
    { entity: 'upgrade', fields: Object.keys(saveUpgradeShape) },
    { entity: 'page', fields: Object.keys(savePageShape) },
  ]
}

/** 6.3 字段集合生成块的内容（按实体分组，便于人工核对）。 */
export function renderSaveShapeBlock(): string {
  const header = '| 实体 | 顶层字段 |\n| --- | --- |'
  const rows = saveShapeRows().map((row) => `| \`${row.entity}\` | ${row.fields.map((field) => `\`${field}\``).join('、')} |`)
  return [header, ...rows].join('\n')
}

/** 生成块 id -> 内容。 */
export function generatedBlocks(): Record<DocGenBlock, string> {
  return {
    '5.9.1': [
      '<!-- 本块由 `pnpm docs:gen` 从 `packages/expr` 的 `PROPERTY_SPECS` 生成，请勿手改；',
      '     上面的人工表才是面向阅读的版本，两者的字段集合必须一致（14.3 规则 1/2）。 -->',
      renderMatrixHeader(),
      ...entryMatrixRows().map(renderMatrixRow),
    ].join('\n'),
    '5.9.2': [
      '<!-- 本块由 `pnpm docs:gen` 从 `packages/expr` 的 `PROPERTY_SPECS` 生成，请勿手改。 -->',
      renderMatrixHeader(),
      ...pageMatrixRows().map(renderMatrixRow),
    ].join('\n'),
    '6.3.fields': [
      '<!-- 本块由 `pnpm docs:gen` 从 `packages/model` 的 Zod Schema 生成，请勿手改；',
      '     它是 6.3 顶部那些 `SaveFile` 类型的字段清单的权威副本（R-33）。 -->',
      renderSaveShapeBlock(),
    ].join('\n'),
  }
}

/** 一次生成/校验的结果。 */
export interface GenResult {
  /** 与字段白名单不一致的生成块 id。 */
  mismatched: string[]
  /** 缺失标记的生成块 id。 */
  missing: string[]
}

/**
 * 生成（或校验）文档里的生成块。
 *
 * 只比对标记块**内部**：标记之间的内容以生成为准，标记之外的一切（人工表的说明文字、
 * 章节排版）都不受影响。
 *
 * @param source 文档全文（CRLF 会被归一为 LF，否则每次都判定为不一致）
 * @param check 只校验不写入（`docs:check` 用）
 */
export function generateDocTables(source: string, check: boolean): { result: GenResult; text: string } {
  const blocks = generatedBlocks()
  const mismatched: string[] = []
  const missing: string[] = []
  let text = source.replace(/\r\n/g, '\n')

  for (const id of DOC_GEN_BLOCKS) {
    const expected = blocks[id]
    const start = START(id)
    const end = END(id)
    const from = text.indexOf(start)
    const to = text.indexOf(end)
    if (from < 0 || to < 0 || to < from) {
      missing.push(id)
      continue
    }
    if (text.slice(from + start.length, to).trim() === expected.trim()) continue
    mismatched.push(id)
    if (!check) {
      text = `${text.slice(0, from + start.length)}\n${expected}\n${text.slice(to)}`
    }
  }

  return { result: { mismatched, missing }, text }
}

/** 文档里某个生成块是否有配对标记（`docs:check` 的诊断用）。 */
export function hasMarkers(source: string, id: DocGenBlock): boolean {
  return source.includes(START(id)) && source.includes(END(id))
}
