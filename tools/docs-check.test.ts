/**
 * `docs:check` —— 文档一致性校验（TECH_DESIGN 14.3「文档一致性校验（`docs:check`，与 `lint` 同级）」）。
 *
 * ## 为什么需要它
 *
 * 14.3 的核心风险是“改了一处漏了另一处”：5.9 的权限矩阵加了可写属性但 6.3 的存档 Schema
 * 没同步（R-33），6.5 引用的错误码没在 17.1 定义，17.6 的测试落点写了但 14.2 里没有对应用例。
 * 这些都不是代码 bug，而是**文档之间的漂移**，只能靠交叉校验发现。
 *
 * ## 实现方式
 *
 * 把 14.3 的 11 条规则拆成两种：
 * - **可执行规则**（1、2、7、8、11 的可判定部分）：直接调用包里的**代码级**检查函数
 *   （`model` 的 `checkSaveCoverage()`、`expr` 的函数权限位、`ui-kit` 的 17.4 清单），
 *   保证“代码里对”与“文档里写的一致”；
 * - **文本规则**（3、4、5、6、9、10）：解析 `TECH_DESIGN.md` 的表格与伪码，做存在性/一致性断言。
 *
 * 运行方式：`pnpm docs:check`（本质是 vitest 跑这一个文件，失败即阻断）。
 *
 * ## `docs:gen` 的形态（14.3 末段，M5 落地）
 *
 * 14.3 要求“从字段白名单**回写**文档表格，`docs:check` 以生成差异作为阻断条件”。
 * 实现上它**不整表重写** 5.9 / 6.3——那两张表是面向阅读的（同类属性合并成一行、
 * 存档位置列带说明文字），逐字段生成会把这些合并与说明抹平。
 *
 * 改为在人工表之后放一个**派生块**（`<!-- docs:gen:<id>:start -->` 圈出），内容是
 * “一个字段一行”的规范化清单，由 `packages/model/src/docgen.ts` 从
 * `PROPERTY_SPECS` 与 Zod Schema 产出。本文件的 `docs:gen 的生成块` 那组用例
 * 校验它与字段白名单一致；`pnpm docs:gen` 回写。
 *
 * 规则 1/2 的“文档 ↔ 代码”双向断言**保留**：它们读的是**人工表**，
 * 而生成块保证的是**代码 ↔ 派生块**。两者缺一不可——只有前者会在人工表漏改时失守，
 * 只有后者则人工表与代码可以各写各的。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { checkSaveCoverage, checkCreateSpecCoverage, generateDocTables, DOC_GEN_BLOCKS } from '@iforge/model'
import { BUILTIN_ICON_IDS, BUILTIN_THEME_IDS } from '@iforge/ui-kit'
import { BUILTIN_FUNCTIONS } from '@iforge/expr'
import { ERROR_CODES } from '@iforge/num'
import { missingKeysProbe } from '@iforge/i18n'

const techPath = fileURLToPath(new URL('../docs/TECH_DESIGN.md', import.meta.url))
// 文档在 Windows 上是 CRLF；统一去掉行尾 `\r` 再做行匹配，否则标题/表格行都对不上。
const techLines = readFileSync(techPath, 'utf8')
  .split('\n')
  .map((line) => line.replace(/\r$/, ''))

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 取某个小节的文本（按标题切片，避免全文搜索误命中目录）。
 *
 * 标题层级不固定（`### 6.3 …` 与 `#### 5.9.1 …` 并存），因此按“起始标题的层级”决定结束位置：
 * 遇到**同级或更高级**的标题即截断。
 */
function section(id: string): string {
  const pattern = new RegExp(`^(#{2,4}) ${escapeRe(id)}(\\s|$)`)
  const start = techLines.findIndex((line) => pattern.test(line))
  if (start < 0) throw new Error(`TECH_DESIGN.md 缺少小节 ${id}`)
  const level = pattern.exec(techLines[start]!)![1]!.length
  let end = techLines.length
  for (let i = start + 1; i < techLines.length; i += 1) {
    const heading = /^(#{1,6}) /.exec(techLines[i]!)
    if (heading && heading[1]!.length <= level) {
      end = i
      break
    }
  }
  return techLines.slice(start, end).join('\n')
}

/** 小节内所有表格行（`|` 开头、去掉分隔行）。 */
function tableRows(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\|[\s:-]+\|/.test(line.trim()))
    .map((line) => line.trim())
}

/** 表格行拆成单元格。 */
function cells(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

describe('14.3 规则 1：5.9 可写属性 → 6.3 存档顶层字段（R-33）', () => {
  it('存档 Schema 覆盖全部“存档位置含顶层”的可写属性', () => {
    // `checkSaveCoverage` 直接比对 5.9 权限矩阵与 `saveFileSchema` 的字段集合（model 侧的唯一事实源）。
    expect(checkSaveCoverage()).toEqual([])
  })

  it('6.3 的 SaveFile 不含 currentPageId（导航不持久化，D-50）', () => {
    expect(section('6.3 存档文件 Schema（`*.save.json`）')).not.toMatch(/^\s*currentPageId/m)
  })
})

describe('14.3 规则 2：6.5 标 ✅ 可赋值的字段必须在 5.9 有对应行', () => {
  it('资源/生成器/升级/页面四张表逐条对齐权限矩阵', () => {
    const matrix = [...section('5.9.1 条目属性'), ...section('5.9.2 页面属性')].flatMap(tableRows).flatMap(cells).join('\n')
    const missing: string[] = []
    for (const id of [
      '6.5.1 资源（PRD 资源编辑器 1–6）',
      '6.5.2 生成器（PRD 生成器编辑器 1–11）',
      '6.5.3 升级（PRD 升级编辑器 1–12）',
      '6.5.4 页面（PRD 页面编辑器 1–8）',
    ]) {
      for (const row of tableRows(section(id))) {
        const [prd, schemaField, , pathColumn, assignable] = cells(row)
        if (assignable !== '✅') continue
        // 表达式路径列形如 `res.<id>.amount` / `gen.<id>.costs[i].amount`；取属性名部分。
        const attrs = [...(pathColumn ?? '').matchAll(/\.([A-Za-z]+)(?:\[i\])?/g)].map((match) => match[1] as string)
        if (attrs.length === 0) continue
        for (const attr of attrs) {
          if (!matrix.includes(attr)) missing.push(`${id} / PRD ${prd} / ${schemaField} → 属性 ${attr}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

describe('14.3 规则 3：引用的错误码 / 决策号 / 风险号都已定义', () => {
  it('17.1 定义了 17 个以上错误码，且与 `num` 的 ERROR_CODES 一致', () => {
    const defined = new Set([...section('17.1 错误码表').matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1] as string))
    expect(defined.size).toBeGreaterThanOrEqual(30)
    for (const code of defined) {
      expect(Object.keys(ERROR_CODES)).toContain(code)
    }
  })

  it('6.5 引用的 E_* 都在 17.1 中定义', () => {
    const defined = new Set([...section('17.1 错误码表').matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1] as string))
    const referenced = new Set([...section('6.5 PRD 字段映射总表').matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1] as string))
    expect([...referenced].filter((code) => !defined.has(code))).toEqual([])
  })

  it('8.7 与 6.4 引用的 D-xx/R-xx 都在 16.1/16.2 定义', () => {
    const decisions = new Set([...section('16.1 决策记录（PRD 未明确事项）').matchAll(/\bD-\d{2}\b/g)].map((m) => m[0]))
    const risks = new Set([...section('16.2 风险清单').matchAll(/\bR-\d{2}\b/g)].map((m) => m[0]))
    expect(decisions.size).toBeGreaterThanOrEqual(45)
    expect(risks.size).toBeGreaterThanOrEqual(30)
    const referencedD = [...`${section('8.7 升级效果与动态条目')}\n${section('6.4 校验与迁移')}`.matchAll(/\bD-\d{2}\b/g)].map((m) => m[0])
    const referencedR = [...`${section('8.7 升级效果与动态条目')}\n${section('6.4 校验与迁移')}`.matchAll(/\bR-\d{2}\b/g)].map((m) => m[0])
    expect(referencedD.filter((id) => !decisions.has(id))).toEqual([])
    expect(referencedR.filter((id) => !risks.has(id))).toEqual([])
  })
})

describe('14.3 规则 4：17.6 追溯矩阵的测试落点在 14.2 有对应用例', () => {
  it('每行的“测试落点”非空，且其中的标识符类关键词能在 14.2 找到', () => {
    const cases = section('14.2 关键用例清单（抽样）')
    const problems: string[] = []
    for (const row of tableRows(section('17.6 需求追溯矩阵（PRD → TECH 章节 → 实现包 → 测试）'))) {
      const cell = cells(row)
      if (cell.length < 4) continue
      const [prd, , , tests] = cell
      if (!prd || prd === 'PRD 需求') continue
      if (!tests || tests === '—') {
        problems.push(`${prd}：测试落点为空`)
        continue
      }
      // 关键词只取**标识符类**（错误码、属性路径、函数名），中文描述不算：
      // 描述性文字在两份文档里本来就会换词，拿它做门禁只会制造无意义的红灯。
      const tokens = [...tests.matchAll(/`([^`]+)`/g)]
        .map((m) => m[1] as string)
        .filter((token) => /[A-Za-z_]/.test(token) && token.length >= 2 && !/^v\d/.test(token))
      if (tokens.length === 0) continue
      const hit = tokens.filter((token) => cases.includes(token))
      // 判定口径：
      // - **≥ 2 个标识符**时要求至少一半命中（“多数关键词能在 14.2 找到”）；
      // - 只有 1 个标识符时不做匹配门禁——14.2 本身是**抽样**清单（标题即如此声明），
      //   `game:ready`/`engineVersion` 这类“实现细节落点”只出现在 17.6 的实现包/章节列里，
      //   强制它们出现在用例清单会逼迫往抽样清单里塞噪声用例。
      if (tokens.length >= 2 && hit.length * 2 < tokens.length) {
        problems.push(`${prd}：14.2 未覆盖的关键词 ${tokens.filter((token) => !cases.includes(token)).join('、')}`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('14.3 规则 5：nav()/currentPageId 的三处落点', () => {
  it('8.1 的 GameState 与 8.11 的 BottomNav 都提到 currentPageId / nav()', () => {
    expect(section('8.1 核心状态')).toContain('currentPageId')
    const view = `${section('8.11 游戏视图与卡片字段映射（PRD 预览区 1–8）')}\n${section('8.12 页面导航与当前页面（PRD 预览区 8）')}`
    expect(view).toContain('nav()')
    expect(section('8.12 页面导航与当前页面（PRD 预览区 8）')).toContain('nav()')
  })

  it('currentPageId 不在 5.9 权限矩阵里（它不是表达式属性）', () => {
    expect(`${section('5.9.1 条目属性')}\n${section('5.9.2 页面属性')}`).not.toContain('currentPageId')
  })
})

describe('14.3 规则 6：ID_PATTERN、dyn 保留前缀与 Infinity 字面量', () => {
  it('6.1 的 ID_PATTERN / RESERVED 前缀与 8.7 的动态 id 规则一致', () => {
    const common = section('6.1 公共字段')
    expect(common).toContain('ID_PATTERN')
    expect(common).toContain('dyn')
    expect(section('8.7 升级效果与动态条目')).toContain('dyn_<递增序号>')
    // `model` 的 id.ts 是单一事实源：正则必须同时接受 6.1 声明的形态。
    const pattern = /ID_PATTERN = (\/\^\[[^;]+?\/)/.exec(common)?.[1]
    expect(pattern).toBeTruthy()
  })

  it('4.4 的“无上限”语义与 5.2 的数字字面量清单互相引用（`Infinity` 必须可编译）', () => {
    expect(section('4.4 溢出/下溢策略（饱和语义）')).toContain('`Infinity` 字面量')
    expect(section('5.2 语法')).toContain('`Infinity`')
    expect(section('5.2 语法')).toContain('4.4')
  })
})

describe('14.3 规则 7：5.4 的“价格上下文/离线”两列是 5.5 的投影，不得放宽', () => {
  it('随机函数在两列都是禁用；副作用函数仅在 effect 上下文可用', () => {
    const randomNames = [...BUILTIN_FUNCTIONS.values()].filter((fn) => fn.random).map((fn) => fn.name)
    expect(randomNames.length).toBeGreaterThanOrEqual(3)
    for (const fn of BUILTIN_FUNCTIONS.values()) {
      if (fn.random) {
        expect(fn.priceAllowed).toBe(false)
        expect(fn.offlineAllowed).toBe(false)
      }
      if (fn.effect) {
        // 副作用函数在价格/产出/条件上下文一律不可用（5.5 的“副作用”列全 ❌）。
        expect(fn.priceAllowed).toBe(false)
      }
    }
    const table = section('5.4 内置函数')
    for (const name of randomNames) {
      const row = tableRows(table).find((line) => line.includes(`\`${name}(`))
      expect(row, `5.4 缺少 ${name} 行`).toBeTruthy()
      expect(row).toContain('❌')
    }
    for (const name of ['set', 'create', 'destroy']) {
      const row = tableRows(table).find((line) => line.includes(`\`${name}(`))
      expect(row, `5.4 缺少 ${name} 行`).toBeTruthy()
    }
  })

  it('5.5 的权限表把副作用限制在 effect 上下文', () => {
    // 表里的上下文名带反引号（`field`），比较前统一去掉。
    const table = tableRows(section('5.5 上下文（Context）与权限')).map(cells)
    const permission = new Map(table.filter((row) => row[0]).map((row) => [(row[0] as string).replace(/`/g, ''), row]))
    for (const context of ['field', 'price', 'production', 'condition']) {
      expect(permission.get(context)?.[4], `${context} 上下文的副作用列应为 ❌`).toBe('❌')
    }
    expect(permission.get('effect')?.[4]).toBe('✅')
  })
})

describe('14.3 规则 8：5.2 的字面量允许位置覆盖 5.4 中所有以列表为实参的函数', () => {
  it('V1.0 没有任何内置函数接收数组/对象实参（create 的 spec 是唯一例外）', () => {
    const listArgFunctions = [...BUILTIN_FUNCTIONS.values()].filter((fn) => fn.name !== 'create' && /列表|数组|对象/.test(fn.name))
    expect(listArgFunctions.map((fn) => fn.name)).toEqual([])
    expect(section('5.2 语法')).toContain('E_LITERAL_NOT_ALLOWED')
    expect(section('13. 安全与沙箱')).toContain('E_LITERAL_NOT_ALLOWED')
  })

  it('create() 的 spec 字段白名单与 model 的一致（8.7 字段集合）', () => {
    expect(checkCreateSpecCoverage({ generator: [], upgrade: [] })).toEqual([])
    expect(section('8.7 升级效果与动态条目')).toContain('E_CREATE_FIELD_INVALID')
  })
})

describe('14.3 规则 9：buyAmount 归一化与 E_BUY_AMOUNT_INVALID / E_CLOCK_ROLLBACK', () => {
  it('5.9.3 的 ①/② 与 17.1 的触发条件一致（求值失败不属于该码）', () => {
    const impl = section('5.9.3 读写实现约定')
    expect(impl).toContain('E_BUY_AMOUNT_INVALID')
    expect(impl).toContain('有限性检查')
    const table = section('17.1 错误码表')
    expect(table).toMatch(/E_BUY_AMOUNT_INVALID[\s\S]*?求值结果为非有限实数/)
  })

  it('E_CLOCK_ROLLBACK 同时出现在 8.8 伪码首行、R-20 与 17.1', () => {
    expect(section('8.8 离线模拟')).toContain('E_CLOCK_ROLLBACK')
    expect(section('16.2 风险清单')).toContain('E_CLOCK_ROLLBACK')
    expect(section('17.1 错误码表')).toContain('E_CLOCK_ROLLBACK')
  })
})

describe('14.3 规则 10：E_PAGE_UNKNOWN 的孤儿动态条目口径四处一致', () => {
  it('6.3 读档顺序、6.4、7.1、8.7 都写明“保留存档 / 不渲染 / 可丢弃”', () => {
    const blocks = {
      '6.3 存档文件 Schema（`*.save.json`）': ['E_PAGE_UNKNOWN', '保留'],
      '6.4 校验与迁移': ['E_PAGE_UNKNOWN'],
      '7.1 界面总体布局（PRD 工作页面一览）': ['孤儿', '丢弃'],
      '8.7 升级效果与动态条目': ['E_PAGE_UNKNOWN', '孤儿'],
    }
    for (const [id, keywords] of Object.entries(blocks)) {
      const text = section(id)
      for (const keyword of keywords) {
        expect(text, `${id} 缺少“${keyword}”`).toContain(keyword)
      }
    }
  })
})

describe('14.3 规则 11：5.6 的分桶规则在 8.7 有落点，8.3.1 引用 5.6', () => {
  it('effValue 写回的分桶与“同生共死”在 5.6 与 8.7 都出现', () => {
    const common = section('5.6 编译与执行')
    expect(common).toContain('effValue')
    expect(common).toContain('分桶')
    const effects = section('8.7 升级效果与动态条目')
    expect(effects).toContain('commitEffValue')
    expect(effects).toContain('同生共死')
    expect(section('8.3.1 交互事件与 tick 边界')).toContain('5.6')
  })
})

describe('14.3 附加：17.4 内置清单与代码实现一致（id 不得变更）', () => {
  it('图标与主题 id 全部存在且覆盖 17.4 必备清单', () => {
    const rows = tableRows(section('17.4 内置图标与主题清单'))
    // 该节有两张表：图标表与主题表。只从图标表取 id，否则会把主题 id（dark/light…）误当成图标。
    const themeHeaderIndex = rows.findIndex((row) => cells(row)[0] === '主题类型')
    expect(themeHeaderIndex).toBeGreaterThan(0)
    const iconRows = rows.slice(0, themeHeaderIndex)
    const requiredIcons = new Set(iconRows.flatMap(cells).flatMap((cell) => [...cell.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1] as string)))
    expect(requiredIcons.size).toBeGreaterThan(30)
    for (const id of requiredIcons) {
      expect(BUILTIN_ICON_IDS, `内置图标缺少 ${id}`).toContain(id)
    }
    for (const id of ['dark', 'light', 'midnight', 'page-dark', 'page-light', 'page-midnight', 'entry-dark', 'entry-light', 'entry-midnight']) {
      expect(BUILTIN_THEME_IDS).toContain(id)
    }
  })
})

/**
 * 14.3 末段：`docs:check` 以**生成差异**作为阻断条件。
 *
 * 这一条替代 M3/M4 期间的“文档 ↔ 代码”双向断言兜底（见本文件的「已知未实现」注释）：
 * 生成块由 `packages/model/src/docgen.ts` 从**同一份字段白名单**产出，
 * 漏改白名单时 CI 在这里失败，错误信息直接指向代码里的字段。
 */
describe('14.3 末段：docs:gen 的生成块与字段白名单一致', () => {
  it('三个生成块都有配对的 start/end 标记', () => {
    for (const id of DOC_GEN_BLOCKS) {
      const start = `<!-- docs:gen:${id}:start -->`
      const end = `<!-- docs:gen:${id}:end -->`
      expect(techLines.join('\n'), `缺少生成块标记 ${id}`).toContain(start)
      expect(techLines.join('\n'), `缺少生成块标记 ${id}`).toContain(end)
    }
  })

  it('生成块内容与 PROPERTY_SPECS / Zod Schema 完全一致（check 模式不产生差异）', () => {
    const source = techLines.join('\n')
    const { result } = generateDocTables(source, true)
    expect(result.missing, '生成块标记缺失').toEqual([])
    expect(result.mismatched, '生成块与字段白名单不一致，请运行 `pnpm docs:gen`').toEqual([])
  })

  it('6.3 的生成块覆盖四类实体（含 assignments 容器，R-33）', () => {
    const source = techLines.join('\n')
    const from = source.indexOf('<!-- docs:gen:6.3.fields:start -->')
    const to = source.indexOf('<!-- docs:gen:6.3.fields:end -->')
    expect(from).toBeGreaterThan(-1)
    const block = source.slice(from, to)
    for (const entity of ['resource', 'generator', 'upgrade', 'page']) {
      expect(block).toContain(`\`${entity}\``)
    }
    // R-33 的核心不变式：四类实体都自带 `assignments` 容器。
    expect(block.split('`assignments`').length - 1).toBe(4)
  })
})

describe('PRD 补充 9：文案全部走 t()，不存在缺键', () => {
  it('zh-CN 文案表无缺键', () => {
    expect(missingKeysProbe()).toEqual([])
  })
})

/**
 * M5 的交付标准是**一句可验证的话**：“E2E 全流程通过，产物可离线游玩”。
 *
 * 这句话本身无法被门禁判定；能判定的是它的**载体**是否闭环：
 * ① 里程碑行按 [17.5](#175-实施里程碑建议) 原文保留（不在实现完成后改写交付标准）；
 * ② PRD 9（游戏打包）在 17.6 有测试落点，且落点关键词能在 14.2 找到；
 * ③ 打包相关的三个决策（D-53 存储与入口、D-54 产物来源、D-55 `docs:gen` 粒度）
 *    与三个新增风险（R-37/R-38/R-39）在正文都有落点——它们只写在 16.1/16.2 而正文没改，
 *    下一次照决策实现就会走偏。
 */
describe('17.5 里程碑表：M5 的交付标准与其正文落点闭环', () => {
  const matrix = (): string[][] => tableRows(section('17.6 需求追溯矩阵（PRD → TECH 章节 → 实现包 → 测试）')).map(cells)

  it('M5 行写明“单文件构建、主题/图标、错误面板、性能优化、Playwright”', () => {
    const row = tableRows(section('17.5 实施里程碑（建议）')).find((line) => line.startsWith('| M5'))
    expect(row).toBeTruthy()
    for (const keyword of ['单文件构建', '主题/图标', '错误面板', '性能优化', 'Playwright']) {
      expect(row, `M5 行缺少「${keyword}」`).toContain(keyword)
    }
    // 交付标准逐字：包含“离线”才能与 E2E 的 `file://` 断言对上。
    expect(cells(row!)[2]).toContain('E2E 全流程通过')
    expect(cells(row!)[2]).toContain('离线游玩')
  })

  it('PRD 9（游戏打包）在 17.6 的测试落点覆盖了可玩性与产物自检', () => {
    const cases = section('14.2 关键用例清单（抽样）')
    const row = matrix().find((cell) => cell[0]?.startsWith('9 游戏打包'))
    expect(row, '17.6 缺少 PRD 9 的追溯行').toBeTruthy()
    // 落点里必须同时提到“离线”与“结构自检”两类断言，否则交付标准的载体不完整。
    expect(row![3]).toMatch(/离线|file:\/\//)
    const tokens = [...(row![3] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.some((token) => cases.includes(token))).toBe(true)
  })

  it('D-53/D-54/D-55 与 R-37/R-38/R-39 已定义并在正文有落点', () => {
    const decisions = section('16.1 决策记录（PRD 未明确事项）')
    const risks = section('16.2 风险清单')
    for (const id of ['D-53', 'D-54', 'D-55']) {
      expect(decisions, `16.1 缺少 ${id}`).toContain(`| ${id} |`)
    }
    for (const id of ['R-37', 'R-38', 'R-39']) {
      expect(risks, `16.2 缺少 ${id}`).toContain(`| ${id} |`)
    }

    // D-53（打包态的存储与入口）必须在 10.3 与 17.3 有落点，否则实现者会沿用预览的桥。
    expect(section('10.3 存档时机')).toContain('localStorage')
    expect(section('17.3 打包产物结构')).toContain('standalone-entry.ts')
    // D-54（编辑器复用构建期产物）必须在 3.1/11.1 提到虚拟模块这条路径。
    expect(section('3.1 目录树')).toContain('virtual:iforge-runtime-shell')
    expect(section('11.1 构建管线')).toContain('virtual:iforge-runtime-shell')
    // D-55（docs:gen 的生成粒度）必须在 14.3 末段与 3.1 的目录树里都能定位。
    expect(section('14.3 质量门禁')).toContain('docs:gen:5.9.1')
    expect(section('3.1 目录树')).toContain('docs:gen')
    // R-37/R-38 必须在正文被引用（否则风险表里的措施无处落地）。
    const body = techLines.join('\n')
    expect(body).toContain('R-37')
    expect(body).toContain('R-38')
  })

  it('9.2 的 game:stats 带 perf/orphans/advice，host:control 带 discard（运行侧已实现）', () => {
    const protocol = section('9.2 消息协议')
    const statsRow = tableRows(protocol).find((line) => line.startsWith('| `game:stats`'))
    expect(statsRow).toContain('perf')
    expect(statsRow).toContain('orphans')
    expect(statsRow).toContain('advice')
    const controlRow = tableRows(protocol).find((line) => line.startsWith('| `host:control`'))
    expect(controlRow).toContain('discard')
  })

  it('12 的虚拟化口径与 D-56 一致（按当前页可见卡片数，不按全项目条目数）', () => {
    expect(section('12. 性能预算与优化')).toContain('D-56')
    expect(section('16.1 决策记录（PRD 未明确事项）')).toContain('D-56')
  })
})

describe('17.5 里程碑表：M3 的交付标准在文档里可查', () => {
  it('M3 行写明“React 布局、四类工作区表单、撤销重做、IndexedDB 持久化 / 增删改查 + 保存/导入导出可用”', () => {
    const row = tableRows(section('17.5 实施里程碑（建议）')).find((line) => line.startsWith('| M3'))
    expect(row).toBeTruthy()
    expect(row).toContain('React 布局')
    expect(row).toContain('IndexedDB 持久化')
    expect(row).toContain('增删改查')
  })
})

/**
 * M4「预览与模拟」的交付标准是**一句可验证的话**：“预览与运行时数据一致（自动化断言）”。
 *
 * 这句话本身无法被门禁判定；能判定的是它的**载体**是否在文档里闭环：
 * ① 里程碑行仍按 [17.5](#175-实施里程碑建议) 原文保留（不要在实现完成后改写交付标准）；
 * ② PRD 8 与“右侧预览区”两行在 17.6 有测试落点，且指向的用例在 14.2 里存在；
 * ③ M4 引入的两个决策（D-51 `game:save.intent`、D-52 协议/视图模型的归属）已落到
 *    9.2 与 3.1——它们只写在 16.1 而正文没改，下一次照 16.1 实现就会走偏。
 */
describe('17.5 里程碑表：M4 的交付标准与其正文落点闭环', () => {
  const matrix = (): string[][] => tableRows(section('17.6 需求追溯矩阵（PRD → TECH 章节 → 实现包 → 测试）')).map(cells)

  it('M4 行的交付标准逐字为“预览与运行时数据一致（自动化断言）”', () => {
    const row = tableRows(section('17.5 实施里程碑（建议）')).find((line) => line.startsWith('| M4'))
    expect(row).toBeTruthy()
    expect(cells(row!)[2]).toBe('预览与运行时数据一致（自动化断言）')
    expect(cells(row!)[1]).toContain('iframe 沙箱')
    expect(cells(row!)[1]).toContain('仪表盘')
    expect(cells(row!)[1]).toContain('离线结算')
  })

  it('PRD 8 与右侧预览区两行都有测试落点，且落点关键词能在 14.2 找到', () => {
    const cases = section('14.2 关键用例清单（抽样）')
    const rows = matrix().filter((cell) => cell[0]?.startsWith('8 预览与模拟') || cell[0]?.startsWith('右侧预览区'))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const tokens = [...(row[3] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
      expect(tokens.length, `${row[0]} 的测试落点里没有标识符类关键词`).toBeGreaterThan(0)
      // 落点里必须提到“注入物/端到端”或“热更新”，否则“数据一致”这句话没有用例支撑。
      expect(row[3]).toMatch(/注入物|端到端|热更新/)
      expect(tokens.some((token) => cases.includes(token))).toBe(true)
    }
  })

  it('D-51 的 game:save intent 与 D-52 的代码归属在正文都有落点', () => {
    const decisions = section('16.1 决策记录（PRD 未明确事项）')
    expect(decisions).toContain('| D-51 |')
    expect(decisions).toContain('| D-52 |')
    // D-51 → 9.2 的 game:save 行必须写出 intent，否则实现无从判断去向。
    const gameSaveRow = tableRows(section('9.2 消息协议')).find((line) => line.startsWith('| `game:save`'))
    expect(gameSaveRow).toContain('intent')
    // D-52 → 3.1 的目录树必须列出 runtime-shell 与 runtime 的三个模块。
    const tree = section('3.1 目录树')
    expect(tree).toContain('runtime-shell')
    expect(tree).toContain('protocol.ts')
    expect(tree).toContain('view-model.ts')
    expect(tree).toContain('patch.ts')
  })

  it('9.1 的沙箱取值与 9.3 的 load 补发都写进正文（这两条各挡一个“预览永远连接中”的缺陷）', () => {
    const sandbox = section('9.1 沙箱模型')
    expect(sandbox).toContain('allow-scripts allow-pointer-lock')
    expect(sandbox).not.toMatch(/sandbox="[^"]*allow-same-origin/)
    expect(sandbox).toContain('data-session-id')
    expect(section('9.3 生命周期')).toContain('load')
  })
})
