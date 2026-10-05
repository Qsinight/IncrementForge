/**
 * `docs:gen` 的单测（TECH_DESIGN 14.3 末段）。
 *
 * ## 为什么这些用例在**单测**里而不是只靠 `docs:check`
 *
 * `docs:check` 校验的是“仓库里那份 `TECH_DESIGN.md` 与当前字段白名单一致”，因此它
 * 在改字段白名单后**必然**会红（直到跑 `docs:gen`）。那是设计意图，但它测不出
 * 生成逻辑本身的错误：把“存档位置”的三种取值都渲染成同一个字符串，
 * `docs:check` 依然是绿的（文档与生成结果一致，只是都错）。
 *
 * 因此这里逐项断言**渲染内容本身**：行数、每列的值、别名与只读属性的处理。
 */
import { describe, expect, it } from 'vitest'

import { PROPERTY_SPECS } from '@iforge/expr'

import {
  DOC_GEN_BLOCKS,
  entryMatrixRows,
  generateDocTables,
  pageMatrixRows,
  renderMatrixRow,
  renderSaveShapeBlock,
  saveShapeRows,
} from '../src/docgen.js'

describe('5.9.1 生成块：条目属性逐字段展开', () => {
  it('每个条目属性恰好一行（不含页面专有属性）', () => {
    const rows = entryMatrixRows()
    const expected = Object.entries(PROPERTY_SPECS).filter(([, spec]) =>
      spec.prefixes.some((prefix) => prefix === 'res' || prefix === 'gen' || prefix === 'up'),
    ).length
    expect(rows).toHaveLength(expected)
    // 页面专有属性不得混进条目表（否则 5.9.1 会重复 5.9.2 的行）。
    expect(rows.map((row) => row.path)).not.toContain('theme')
    expect(rows.map((row) => row.path)).not.toContain('columns')
  })

  it('`res.owned` 别名保留为独立一行（D-37、5.9.1 第 8 行）', () => {
    // 规则 1 的可执行版会显式跳过它（它与 `amount` 共用存储），因此生成块必须保留它，
    // 否则文档里就看不到这条别名了。
    expect(entryMatrixRows().map((row) => row.path)).toContain('res.owned')
  })

  it('只读属性的可写列是 ❌，且存档位置写“项目文件”对应的不持久化语义', () => {
    const byPath = new Map(entryMatrixRows().map((row) => [row.path, row]))
    for (const path of ['id', 'order', 'name', 'icon', 'perSec', 'buyDelay']) {
      expect(byPath.get(path)?.writable, `${path} 应只读`).toBe(false)
    }
    // `perSec` 是派生量：不存档（R-08 的观测口径）。
    expect(byPath.get('perSec')?.storage).toBe('不存档（派生量）')
  })

  it('列表属性只落 `assignments`，`effectValues` 落顶层（D-25、R-33）', () => {
    const byPath = new Map(entryMatrixRows().map((row) => [row.path, row]))
    for (const path of ['costs[i].materialId', 'costs[i].amount', 'produces[i].amount', 'conditions[i]']) {
      expect(byPath.get(path)?.storage, `${path} 只落 assignments`).toBe('仅 `assignments`')
    }
    expect(byPath.get('effectValues[i]')?.storage).toBe('顶层')
    expect(byPath.get('effectValues[i]')?.resetTo).toBe('清零为 0')
  })

  it('`isClicker` 可写且落顶层（R-33 的具体字段）', () => {
    const row = entryMatrixRows().find((item) => item.path === 'isClicker')
    expect(row?.writable).toBe(true)
    expect(row?.storage).toBe('顶层')
  })

  it('`produces` 只属生成器、`perSecond` 只属升级（5.9.1 的适用范围）', () => {
    const byPath = new Map(entryMatrixRows().map((row) => [row.path, row]))
    expect(byPath.get('produces[i].amount')?.prefixes).toBe('生成器')
    expect(byPath.get('perSecond')?.prefixes).toBe('升级')
  })

  it('Markdown 行含 7 列且用 ✅/❌ 表达可读可写（14.3 的判定口径）', () => {
    const row = entryMatrixRows().find((item) => item.path === 'description')!
    const line = renderMatrixRow(row)
    expect(line.startsWith('|') && line.endsWith('|')).toBe(true)
    expect(line.split('|').filter((cell) => cell.trim() !== '')).toHaveLength(7)
    expect(line).toContain('✅')
    expect(line).toContain('`description`')
  })
})

describe('5.9.2 生成块：页面属性', () => {
  it('只含页面专有属性，且布局属性只读', () => {
    const rows = pageMatrixRows()
    // 行序即 `PROPERTY_SPECS` 的声明顺序（`description` 在 `visible`/`disabled` 之前）。
    expect(rows.map((row) => row.path)).toEqual(['id', 'order', 'name', 'icon', 'description', 'visible', 'disabled', 'theme', 'columns', 'entries'])
    for (const row of rows) {
      if (['theme', 'columns', 'entries', 'id', 'order', 'name', 'icon'].includes(row.path)) {
        expect(row.writable, `${row.path} 应只读（布局/标识属性）`).toBe(false)
      }
    }
  })

  it('不含 `currentPageId`（D-50：导航状态不持久化，也不是表达式属性）', () => {
    expect(pageMatrixRows().map((row) => row.path)).not.toContain('currentPageId')
  })
})

describe('6.3 生成块：四类实体的顶层字段', () => {
  it('四类实体都带 `assignments` 容器（R-33 的完整性不变式）', () => {
    for (const row of saveShapeRows()) {
      expect(row.fields, `${row.entity} 缺 assignments 容器`).toContain('assignments')
    }
  })

  it('生成器顶层含 `isClicker`、升级顶层含 `effectValues`（R-33 记录过的两个字段）', () => {
    const byEntity = new Map(saveShapeRows().map((row) => [row.entity, row.fields]))
    expect(byEntity.get('generator')).toContain('isClicker')
    expect(byEntity.get('upgrade')).toContain('effectValues')
    expect(byEntity.get('upgrade')).toContain('perSecond')
  })

  it('资源顶层**不含** `bought`/`disabled`（D-20：资源无购买路径、无禁用态）', () => {
    const resource = saveShapeRows().find((row) => row.entity === 'resource')!
    expect(resource.fields).not.toContain('bought')
    expect(resource.fields).not.toContain('disabled')
  })

  it('页面顶层只有 visible/disabled/description/assignments（6.3：页面无 initial/max/bought）', () => {
    const page = saveShapeRows().find((row) => row.entity === 'page')!
    expect([...page.fields].sort()).toEqual(['assignments', 'description', 'disabled', 'visible'])
  })

  it('渲染块里每个实体一行、字段用反引号包起来', () => {
    const block = renderSaveShapeBlock()
    for (const row of saveShapeRows()) {
      expect(block).toContain(`| \`${row.entity}\` |`)
      for (const field of row.fields) expect(block).toContain(`\`${field}\``)
    }
  })
})

describe('generateDocTables：标记块的写入与校验', () => {
  /** 造一份含全部标记块的最小文档。 */
  function skeleton(): string {
    return ['# T', ...DOC_GEN_BLOCKS.flatMap((id) => [`<!-- docs:gen:${id}:start -->`, `old-${id}`, `<!-- docs:gen:${id}:end -->`])].join('\n')
  }

  it('check 模式只报告差异、不改文本', () => {
    const source = skeleton()
    const { result, text } = generateDocTables(source, true)
    expect(result.missing).toEqual([])
    expect(result.mismatched).toEqual([...DOC_GEN_BLOCKS])
    expect(text).toBe(source)
  })

  it('回写模式把三个块都替换成生成内容，且标记外的文本不动', () => {
    const source = `${skeleton()}\n\n人工段落不应被动。\n`
    const { result, text } = generateDocTables(source, false)
    expect(result.mismatched).toHaveLength(3)
    expect(text).toContain('人工段落不应被动。')
    expect(text).not.toContain('old-5.9.1')
    // 回写后再校验应完全一致（幂等）。
    expect(generateDocTables(text, true).result).toEqual({ mismatched: [], missing: [] })
  })

  it('缺少标记时报 `missing` 而不是静默通过', () => {
    const { result } = generateDocTables('# 只有标题', true)
    expect(result.missing).toEqual([...DOC_GEN_BLOCKS])
    expect(result.mismatched).toEqual([])
  })

  it('CRLF 文档按 LF 归一后判定（Windows 上不会永远报“不一致”）', () => {
    const generated = generateDocTables(skeleton(), false).text
    const crlf = generated.replace(/\n/g, '\r\n')
    expect(generateDocTables(crlf, true).result).toEqual({ mismatched: [], missing: [] })
  })

  it('只有 start 没有 end 时同样报 missing（不写出半截内容）', () => {
    const source = DOC_GEN_BLOCKS.map((id) => `<!-- docs:gen:${id}:start -->\n\`${id}\``).join('\n')
    const { result, text } = generateDocTables(source, false)
    expect(result.missing).toEqual([...DOC_GEN_BLOCKS])
    expect(text).toBe(source.replace(/\r\n/g, '\n'))
  })
})
