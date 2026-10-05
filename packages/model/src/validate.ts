/**
 * 跨条目一致性校验与迁移（TECH_DESIGN 6.4、6.4「表达式目标合法」、11.1 打包前检查）。
 *
 * 校验项逐条对应 6.4 的列表：
 * - **条目页面唯一性**（PRD 补充 7）-> `E_DUPLICATE_PAGE_ENTRY`
 * - **引用完整性**（`PageDef.entries[].id` / `costs[i].materialId` / `produces[i].materialId`）-> `E_DANGLING_REF`
 * - **`id` 命名规范**（D-45、R-35）-> `E_ID_INVALID`，**不自动改 id**
 * - **表达式目标合法**（5.9 权限矩阵）-> `E_READONLY_TARGET` / `E_ASSIGN_TYPE` / `E_PARSE` 等
 * - **动态创建**（8.7 字段集合与页面存在性）-> `E_PAGE_UNKNOWN` / `E_CREATE_FIELD_INVALID`
 * - `max` 表达式 ≤ 0 **不阻断保存**（运行期按 1 处理并记 `E_CAP_NON_POSITIVE`）
 *
 * ## 为什么单独一个模块而不是全塞进 Zod
 *
 * 6.4 要求这批校验既是 `projectFileSchema.superRefine` 的一部分（保存时自动跑），
 * 又能被编辑器表单提交与打包前检查（11.1）**单独调用**。因此实现放在这里，
 * 由 `schema.ts` 反过来 `superRefine` 引用它——单一实现、多处复用。
 */
import { ForgeError, isForgeError } from '@iforge/num'
import type { ErrorCode } from '@iforge/num'
import { CREATE_SPEC_FIELD_LIST, formatPathKey, parse, parseLiteralPath, staticCheck, validateExpression } from '@iforge/expr'
import type { ConstantObject, ContextKind, Node, PathPrefix } from '@iforge/expr'

import { ID_PATTERN } from './id.js'
import type { ProjectFile } from './schema.js'
import { PROJECT_FORMAT, SCHEMA_VERSION, installCrossEntryValidator, projectFileSchema } from './schema.js'

// 打破 `schema.ts` ↔ `validate.ts` 的模块级循环：`schema.ts` 的 `superRefine` 需要
// `validateProject`，而 `parseProjectFile` 需要 `projectFileSchema`。
// 用一个显式的注入函数把两者接起来，比在任一侧写 require/动态 import 更可读，
// 也不会让「校验逻辑到底在哪一侧」变得含糊。
installCrossEntryValidator({ validateProject: (project) => validateProject(project) })

/** 一条校验问题：`code` 来自 17.1，`where` 定位到具体路径（如 `generators[3].costs[0].amount`）。 */
export interface ValidationIssue {
  code: ErrorCode
  /** 定位路径，如 `generators[3].id`、`pages[0].entries[1].id`。 */
  where: string
  message?: string
}

/**
 * 表达式字段 -> 求值上下文（5.5 的五个上下文）。
 *
 * 这张表是 6.4「表达式目标合法」与 11.1 第 1 条的共同依据：同一条文本换个上下文
 * 编译期结论就不同（`rand()` 在 `price` 报 `E_RAND_DISABLED`，`set()` 在 `effect` 合法）。
 * 因此**必须**按字段逐个映射，不能统一用一个上下文编译。
 */
export const EXPRESSION_CONTEXTS = {
  /** `initial` / `max` / `buyAmount`（常量表达式，5.1）。 */
  numExpr: 'field',
  /** `costs[i].amount`（价格，PRD 补充 1 禁随机）。 */
  cost: 'price',
  /** `produces[i].amount`（单件产出速率，D-30）。 */
  produce: 'production',
  /** `conditions[i]`（购买条件，PRD 补充 4）。 */
  condition: 'condition',
  /** `effects[i].condition`（效果前提）。 */
  effectCondition: 'condition',
  /** `effects[i].action`（效果内容，赋值表达式）。 */
  effectAction: 'effect',
} as const satisfies Record<string, ContextKind>

/** 一条被收集的表达式字段：`where` 定位路径、`key` 规范属性路径、`text` 源码、`context` 求值上下文。 */
export interface CollectedExpression {
  /** 编辑器定位路径，如 `generators[3].costs[0].amount`。 */
  where: string
  /**
   * 规范属性键，如 `gen.g3.costs[0].amount`。
   *
   * 必须给出：环检测的二分图需要 `key → expr` 的**定义边**
   * （“这个属性的值由这条表达式算出”，见 `findStaticCycles`），只靠 `where` 反推会把
   * 下标与 id 重新拼一遍，容易和 `formatPathKey` 的规范形式对不上。
   */
  key: string
  text: string
  context: ContextKind
}

/**
 * 收集项目文件里全部表达式字段（`(where, text, context)` 三元组）。
 *
 * 11.1 第 1 条「打包前校验」与 6.4「表达式目标合法」都基于它，
 * D-08 的**静态依赖环**检测也用它建图（只覆盖项目文件里的静态表达式）。
 */
export function collectExpressions(project: ProjectFile): CollectedExpression[] {
  const out: CollectedExpression[] = []
  const push = (where: string, key: string, text: string, context: (typeof EXPRESSION_CONTEXTS)[keyof typeof EXPRESSION_CONTEXTS]): void => {
    out.push({ where, key, text, context })
  }

  for (const [i, resource] of project.resources.entries()) {
    push(`resources[${i}].initial`, `res.${resource.id}.initial`, resource.initial, EXPRESSION_CONTEXTS.numExpr)
    push(`resources[${i}].max`, `res.${resource.id}.max`, resource.max, EXPRESSION_CONTEXTS.numExpr)
  }
  for (const [i, generator] of project.generators.entries()) {
    push(`generators[${i}].initial`, `gen.${generator.id}.initial`, generator.initial, EXPRESSION_CONTEXTS.numExpr)
    push(`generators[${i}].max`, `gen.${generator.id}.max`, generator.max, EXPRESSION_CONTEXTS.numExpr)
    push(`generators[${i}].buyAmount`, `gen.${generator.id}.buyAmount`, generator.buyAmount, EXPRESSION_CONTEXTS.numExpr)
    generator.costs.forEach((cost, j) => {
      push(`generators[${i}].costs[${j}].amount`, `gen.${generator.id}.costs[${j}].amount`, cost.amount, EXPRESSION_CONTEXTS.cost)
    })
    generator.produces.forEach((produces, j) => {
      push(`generators[${i}].produces[${j}].amount`, `gen.${generator.id}.produces[${j}].amount`, produces.amount, EXPRESSION_CONTEXTS.produce)
    })
  }
  for (const [i, upgrade] of project.upgrades.entries()) {
    push(`upgrades[${i}].initial`, `up.${upgrade.id}.initial`, upgrade.initial, EXPRESSION_CONTEXTS.numExpr)
    push(`upgrades[${i}].max`, `up.${upgrade.id}.max`, upgrade.max, EXPRESSION_CONTEXTS.numExpr)
    push(`upgrades[${i}].buyAmount`, `up.${upgrade.id}.buyAmount`, upgrade.buyAmount, EXPRESSION_CONTEXTS.numExpr)
    upgrade.costs.forEach((cost, j) => {
      push(`upgrades[${i}].costs[${j}].amount`, `up.${upgrade.id}.costs[${j}].amount`, cost.amount, EXPRESSION_CONTEXTS.cost)
    })
    upgrade.conditions.forEach((condition, j) => {
      push(`upgrades[${i}].conditions[${j}]`, `up.${upgrade.id}.conditions[${j}]`, condition, EXPRESSION_CONTEXTS.condition)
    })
    upgrade.effects.forEach((effect, j) => {
      push(
        `upgrades[${i}].effects[${j}].condition`,
        `up.${upgrade.id}.effects[${j}].condition`,
        effect.condition,
        EXPRESSION_CONTEXTS.effectCondition,
      )
      push(`upgrades[${i}].effects[${j}].action`, `up.${upgrade.id}.effects[${j}].action`, effect.action, EXPRESSION_CONTEXTS.effectAction)
    })
  }
  return out
}

/**
 * 静态依赖环检测（11.1 第 1 条、D-08）。
 *
 * ## 图的方向（这里最容易做错）
 *
 * 文档 11.1 写的是“对全部表达式的 `deps` 建有向图（被引用者 → 引用者）”。
 * 但只建 `deps` 的边**检不出自指**：表达式 `produces[0].amount = "gen.g1.produces[0].amount + 1"`
 * 产生的边是 `属性键 → 表达式位置`，而 `表达式位置` 在只建 `deps` 的图里没有任何出边，
 * 永远走不回自己。
 *
 * 因此实际建的是一张**二分图**，两类节点 `expr:<位置>`（表达式实例）与 `key:<属性键>`（属性），
 * 三类边：
 * - `expr → key`：**读**依赖（表达式里出现的属性路径）；
 * - `key → expr`：**写**依赖（赋值运算符与 `set()` 的目标路径）；
 * - `key → expr`：**定义边**——`initial`/`max`/`buyAmount`/`costs[i].amount` 这类字段的
 *   **值本身就是这条表达式的结果**，所以“求这个属性”必然“求这条表达式”。
 *   定义边是自指公式能被检出的关键：`produces[0].amount = "gen.g1.produces[0].amount + 1"`
 *   若只有读边，`expr` 节点没有任何出边回环，永远检不出。
 *
 * 自指写法形成 `expr → key → expr` 的环；两个生成器互相读对方的产出速率形成
 * `expr₁ → key → expr₂ → key' → expr₁` 的环，两种都能检出。
 *
 * ## 一条刻意的例外：同式读写同一属性不构成环
 *
 * `gen.g1.max += gen.g1.max`（5.2 的复合赋值，8.7「按条件切换表达式结构」的合法写法）
 * 既读又写 `gen.g1.max`。若照字面同时发出两条边，就会得到长度为 2 的**假环**——
 * 但它在运行期完全正常：读发生在求值期、写发生在提交阶段（5.6 的单一提交点），
 * 两者有严格先后。因此本实现规定：**同一表达式对同一属性只发读边，不发写边**。
 * 它对下游的影响由“下游读该属性 -> expr -> 读该属性”的传递闭包自然覆盖。
 *
 * **只覆盖项目文件里的静态表达式**：涉及动态创建、运行时改 `materialId`、表达式文本热替换的
 * 依赖**无法在事前建全图**，由运行期求值重入检测兜底（5.7）——本函数不追求完备，
 * 只负责“能在事前抓住的那一类”，与 D-08 的分层口径一致。
 */
export function findStaticCycles(project: ProjectFile): ValidationIssue[] {
  const edges = new Map<string, string[]>()
  const link = (from: string, to: string): void => {
    const list = edges.get(from) ?? []
    list.push(to)
    edges.set(from, list)
  }

  for (const node of collectExpressions(project)) {
    const expr = `expr:${node.where}`
    const { reads, writes } = expressionDependencies(node.text, node.context)
    for (const key of reads) link(expr, `key:${key}`)
    for (const key of writes) {
      if (reads.has(key)) continue // 见文件头「同式读写同一属性不构成环」
      link(`key:${key}`, expr)
    }
    // 定义边：该属性的值由这条表达式算出。
    link(`key:${node.key}`, expr)
  }

  const issues: ValidationIssue[] = []
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const reported = new Set<string>()

  const visit = (node: string): void => {
    const current = state.get(node) ?? 0
    if (current === 2) return
    if (current === 1) {
      const start = stack.indexOf(node)
      const cycle = [...stack.slice(start), node]
      // 同一个环只报一次：以环内节点集合的字典序作为标识。
      const key = [...new Set(cycle)].sort().join('|')
      if (!reported.has(key)) {
        reported.add(key)
        issues.push({ code: 'E_CYCLE', where: displayNode(node), message: `静态依赖环：${cycle.map(displayNode).join(' -> ')}` })
      }
      return
    }
    state.set(node, 1)
    stack.push(node)
    for (const next of edges.get(node) ?? []) visit(next)
    stack.pop()
    state.set(node, 2)
  }

  for (const node of edges.keys()) visit(node)
  return issues
}

/** 图节点名 -> 诊断里显示的名字（去掉内部前缀）。 */
function displayNode(node: string): string {
  return node.slice(node.indexOf(':') + 1)
}

/**
 * 收集一条表达式的读/写属性键（按节点类型判定，不用 `deps` 的并集）。
 *
 * `deps`（5.6「变量解析」）是“提到过哪些属性”的**去重集合**，无法区分
 * `set("k", "1")` 里的 `k` 是写入目标、`set("k", "k + 1")` 里的 `k` 又是读——
 * 而这个区别恰好决定要不要发写边（见文件头的假环说明）。因此这里走一次 AST：
 * - `path` 节点：读；
 * - `assign` 目标：`=` 是纯写，复合赋值（`+= -= *= /=`）读写都要（编译器在 `combine` 里先读旧值）；
 * - `set()` 的字面量路径：纯写。
 *
 * `effValue` 是 `effect` 上下文的局部变量（8.7），它最终写回 `up.<id>.effectValues[i]`
 * ——但那条写回由 `EffectSink` 在提交阶段登记，编译期看不到，因此**不**在这里补边
 * （否则每个 `effValue = …` 都会被当成一次写入，制造噪声与假环）。
 */
function expressionDependencies(text: string, context: ContextKind): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>()
  const writes = new Set<string>()
  const ast = parseSafe(text)
  // 静态检查失败时不收集：那条表达式已经由 `validateProject` 单独报错，
  // 拿半截 AST 建边只会产生噪声。
  if (!ast || !validateExpression(text, context).ok) return { reads, writes }
  walkDependencies(ast, reads, writes)
  return { reads, writes }
}

function walkDependencies(node: Node, reads: Set<string>, writes: Set<string>): void {
  const record = node as unknown as Record<string, unknown>
  const kind = record['kind']

  if (kind === 'path') {
    const path = record['path'] as { prefix: string; id: string; attrs: string[] }
    reads.add(formatPathKey(path.prefix as PathPrefix, path.id, path.attrs))
  }

  if (kind === 'assign') {
    const target = record['target'] as { kind?: string; path?: { prefix: string; id: string; attrs: string[] } } | undefined
    if (target?.kind === 'path' && target.path) {
      const key = formatPathKey(target.path.prefix as PathPrefix, target.path.id, target.path.attrs)
      writes.add(key)
      // 复合赋值要读旧值：`+=` 等（5.2 assignment，编译器 `combine()` 里 `scope.read(key)`）。
      if (record['op'] !== '=') reads.add(key)
    }
  }

  if (kind === 'call' && record['name'] === 'set') {
    const args = record['args'] as Node[] | undefined
    const first = args?.[0] as { kind?: string; value?: string } | undefined
    if (first && first.kind === 'string' && typeof first.value === 'string') {
      const resolved = parseLiteralPath(first.value)
      if (resolved) writes.add(formatPathKey(resolved.prefix, resolved.id, resolved.attrs))
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walkDependencies(item, reads, writes)
    } else if (isNode(value)) {
      walkDependencies(value, reads, writes)
    }
  }
}

/**
 * 取一条表达式的 `deps`（5.6「变量解析」）——对外暴露给编辑器做“这条表达式读了哪些属性”的提示。
 *
 * 环检测**不用**它（见 `findStaticCycles` 的假环说明），因为 `deps` 是去重后的并集，
 * 区分不了“写入目标”与“同时也是读”。
 */
export function expressionDeps(text: string, context: ContextKind): string[] {
  try {
    return staticCheck(parse(text), context).deps
  } catch {
    return []
  }
}

/**
 * `create()` 调用的静态校验（11.1 第 5 条、8.7 字段集合）。
 *
 * 只做**能在编译期做的**部分：`spec` 键名白名单与 `page` 必填由 `expr` 的检查器在编译期判定
 * （`E_CREATE_FIELD_INVALID` / `E_CREATE_NO_PAGE`，见 5.2 约束表「键名」行），本函数只补上
 * “`page` 指向的页面是否存在”这一**需要全局条目表**的信息（`E_PAGE_UNKNOWN`）。
 */
export function validateCreateCalls(project: ProjectFile): ValidationIssue[] {
  const pageIds = new Set(project.pages.map((page) => page.id))
  const issues: ValidationIssue[] = []
  project.upgrades.forEach((upgrade, i) => {
    upgrade.effects.forEach((effect, j) => {
      const where = `upgrades[${i}].effects[${j}].action`
      // 编译期错误（含键名白名单、`page` 必填）由表达式校验统一报，此处不重复。
      if (!validateExpression(effect.action, 'effect').ok) return
      for (const pageId of collectCreatePages(effect.action)) {
        if (!pageIds.has(pageId)) {
          issues.push({ code: 'E_PAGE_UNKNOWN', where, message: `create() 的 page "${pageId}" 不存在` })
        }
      }
    })
  })
  return issues
}

/** 从 `action` 中抽出 `create(kind, { page: "..." })` 的页面 id。 */
function collectCreatePages(action: string): string[] {
  const ast = parseSafe(action)
  if (!ast) return []
  const pages: string[] = []
  walkCreate(ast, (spec) => {
    const page = spec['page']
    if (typeof page === 'string') pages.push(page)
  })
  return pages
}

/** 允许 `create()` 使用的 spec 字段全集（8.7「字段集合」行的并集，供 11.1 第 5 条与 `docs:check` 枚举）。 */
export const CREATE_SPEC_ALL_FIELDS: ReadonlySet<string> = new Set([...CREATE_SPEC_FIELD_LIST.generator, ...CREATE_SPEC_FIELD_LIST.upgrade])

function parseSafe(text: string): Node | undefined {
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

/** 遍历 AST，遇到 `create(kind, spec)` 调用即回调 spec。 */
function walkCreate(node: Node, visit: (spec: ConstantObject) => void): void {
  const anyNode = node as unknown as Record<string, unknown>
  if (anyNode['kind'] === 'call' && anyNode['name'] === 'create') {
    const specNode = (anyNode['args'] as Node[] | undefined)?.[1]
    if (specNode && (specNode as { kind: string }).kind === 'object') {
      const spec: ConstantObject = {}
      for (const entry of (specNode as { entries: Array<{ key: string; value: unknown }> }).entries) {
        spec[entry.key] = entry.value as never
      }
      visit(spec)
    }
  }
  for (const value of Object.values(anyNode)) {
    if (Array.isArray(value))
      for (const item of value)
        if (isNode(item)) walkCreate(item, visit)
        else if (isNode(value)) walkCreate(value, visit)
  }
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

/**
 * 跨条目一致性校验（6.4）：返回**全部**问题而不是遇错即停，
 * 这样编辑器能一次列出所有要改的地方（6.4「定位路径」、11.1「列出问题位置」）。
 */
export function validateProject(project: ProjectFile): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // ---- `id` 命名规范 + 跨四类全局唯一（6.1、D-45）----
  const seen = new Map<string, string>()
  const checkId = (id: string, where: string): void => {
    if (!ID_PATTERN.test(id)) {
      issues.push({ code: 'E_ID_INVALID', where, message: `id "${id}" 不匹配 ${ID_PATTERN.source}` })
      return
    }
    if (id.startsWith('dyn')) {
      issues.push({ code: 'E_ID_INVALID', where, message: `id "${id}" 以保留前缀 dyn 开头` })
      return
    }
    const previous = seen.get(id)
    if (previous !== undefined) {
      issues.push({ code: 'E_ID_INVALID', where, message: `id "${id}" 与 ${previous} 重复（跨四类全局唯一）` })
      return
    }
    seen.set(id, where)
  }
  project.resources.forEach((item, i) => checkId(item.id, `resources[${i}].id`))
  project.generators.forEach((item, i) => checkId(item.id, `generators[${i}].id`))
  project.upgrades.forEach((item, i) => checkId(item.id, `upgrades[${i}].id`))
  project.pages.forEach((item, i) => checkId(item.id, `pages[${i}].id`))

  // ---- 引用完整性（6.4「引用完整性」）----
  const resourceIds = new Set(project.resources.map((item) => item.id))
  const generatorIds = new Set(project.generators.map((item) => item.id))
  /** 购买材料只指向资源；产出可指向资源或生成器（6.4「引用完整性」行）。 */
  project.generators.forEach((generator, i) => {
    generator.costs.forEach((cost, j) => {
      if (!resourceIds.has(cost.materialId)) {
        issues.push({
          code: 'E_DANGLING_REF',
          where: `generators[${i}].costs[${j}].materialId`,
          message: `购买材料 "${cost.materialId}" 不是已存在的资源`,
        })
      }
    })
    generator.produces.forEach((produces, j) => {
      if (!resourceIds.has(produces.materialId) && !generatorIds.has(produces.materialId)) {
        issues.push({
          code: 'E_DANGLING_REF',
          where: `generators[${i}].produces[${j}].materialId`,
          message: `产出目标 "${produces.materialId}" 不是已存在的资源或生成器`,
        })
      }
    })
  })
  project.upgrades.forEach((upgrade, i) => {
    upgrade.costs.forEach((cost, j) => {
      if (!resourceIds.has(cost.materialId)) {
        issues.push({
          code: 'E_DANGLING_REF',
          where: `upgrades[${i}].costs[${j}].materialId`,
          message: `购买材料 "${cost.materialId}" 不是已存在的资源`,
        })
      }
    })
  })

  // ---- 条目页面唯一性（PRD 补充 7、6.4）----
  const assignees = new Map<string, string[]>()
  project.pages.forEach((page, i) => {
    page.entries.forEach((entry, j) => {
      const list = assignees.get(entry.id) ?? []
      list.push(`pages[${i}].entries[${j}].id`)
      assignees.set(entry.id, list)
    })
  })
  for (const [entryId, locations] of assignees) {
    if (locations.length > 1) {
      issues.push({
        code: 'E_DUPLICATE_PAGE_ENTRY',
        where: locations[0]!,
        message: `条目 ${entryId} 被分配到多个页面：${locations.join('、')}（一个条目只能属于一个页面）`,
      })
    }
  }
  const knownEntries = new Set<string>([...resourceIds, ...generatorIds, ...project.upgrades.map((u) => u.id)])
  for (const [entryId, locations] of assignees) {
    if (!knownEntries.has(entryId)) {
      issues.push({
        code: 'E_DANGLING_REF',
        where: locations[0]!,
        message: `页面条目引用了不存在的条目 "${entryId}"`,
      })
    }
  }

  // ---- 表达式目标合法（6.4、5.9 权限矩阵）----
  for (const node of collectExpressions(project)) {
    const result = validateExpression(node.text, node.context)
    if (!result.ok) {
      issues.push({ code: result.code as ErrorCode, where: node.where, message: result.message })
    }
  }
  issues.push(...validateCreateCalls(project))
  issues.push(...findStaticCycles(project))

  return issues
}

/**
 * 解析并校验一个项目文件（10.2「导入项目」第 2 步：Zod 校验 → 迁移）。
 *
 * @throws {ForgeError} `E_SCHEMA`（结构/一致性校验失败，附问题清单）或
 *   `E_VERSION`（`format` 不匹配且无法迁移，6.4「兼容模式」）。
 */
export function parseProjectFile(input: unknown): ProjectFile {
  const raw = typeof input === 'string' ? safeJsonParse(input) : input
  if (raw === undefined) {
    throw new ForgeError('E_SCHEMA', { message: '项目文件不是合法 JSON' })
  }
  const migrated = migrateProject(raw)
  const result = projectFileSchema.safeParse(migrated)
  if (!result.success) {
    // 汇总**全部**问题而不是只报第一条（6.4「定位路径」、11.1「列出问题位置」）：
    // 作者一次看到所有要改的地方，比逐条试错快得多。
    const summary = result.error.issues.map((issue) => `${formatZodPath(issue.path) || '<root>'} ${issue.message}`).join('；')
    throw new ForgeError('E_SCHEMA', {
      where: result.error.issues[0] ? formatZodPath(result.error.issues[0].path) : undefined,
      message: summary,
    })
  }
  const project = result.data as ProjectFile
  const issues = validateProject(project)
  if (issues.length > 0) {
    throw new ForgeError('E_SCHEMA', {
      where: issues[0]!.where,
      message: `跨条目一致性校验失败（${issues.length} 项）：${issues.map((i) => `${i.where} ${i.code}`).join('；')}`,
    })
  }
  return project
}
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function formatZodPath(path: (string | number)[]): string {
  return path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : segment)).join('.')
}

/**
 * 迁移器（6.4：`migrations[from: number]: (file) => file`，按 `version` 逐级执行）。
 *
 * V1.0 只有 `version: 1`，因此迁移表为空；接口按 6.4 的形状先落地，
 * 后续版本只需往 `MIGRATIONS` 里加一项，不必改调用方。
 *
 * 无法迁移时进入“兼容模式”（只读打开并提示导出原始文件），错误码 `E_MIGRATION_FAIL`。
 */
export type Migration = (file: Record<string, unknown>) => Record<string, unknown>

export const MIGRATIONS: Readonly<Record<number, Migration>> = {}

/** 支持迁移到的最高版本。 */
export const LATEST_VERSION = SCHEMA_VERSION

/**
 * 逐级迁移到最新版本。
 *
 * @throws {ForgeError} `E_VERSION`（`version` 高于当前引擎）、`E_MIGRATION_FAIL`（缺迁移步骤）
 */
export function migrateProject(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    throw new ForgeError('E_SCHEMA', { message: '项目文件必须是对象' })
  }
  const file = { ...(input as Record<string, unknown>) }
  if (file['format'] !== PROJECT_FORMAT) {
    throw new ForgeError('E_VERSION', { message: `format 不是 ${PROJECT_FORMAT}` })
  }
  const rawVersion = file['version']
  const version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 1
  if (version > LATEST_VERSION) {
    throw new ForgeError('E_VERSION', { message: `项目文件版本 ${version} 高于当前引擎支持的 ${LATEST_VERSION}` })
  }
  let current = file
  for (let v = version; v < LATEST_VERSION; v += 1) {
    const migrate = MIGRATIONS[v]
    if (!migrate) {
      throw new ForgeError('E_MIGRATION_FAIL', { where: `version: ${v}`, message: `缺少 v${v} -> v${v + 1} 的迁移步骤` })
    }
    current = migrate(current)
    current['version'] = v + 1
  }
  return current
}

/** 便捷导出：把 `ForgeError` 转成校验问题（编辑器表单提交路径用）。 */
export function toIssue(error: unknown, where?: string): ValidationIssue {
  if (isForgeError(error)) {
    return { code: error.code, where: where ?? error.where ?? '', message: error.message }
  }
  return { code: 'E_SCHEMA', where: where ?? '', message: error instanceof Error ? error.message : String(error) }
}
