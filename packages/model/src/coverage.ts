/**
 * Schema ↔ 权限矩阵 ↔ 存档 Schema 的**一致性自检**（TECH_DESIGN 14.3 规则 1、R-33）。
 *
 * ## 为什么要有这个模块
 *
 * 6.3 写了一条「完整性不变式」：顶层字段必须覆盖 5.9.1/5.9.2 中所有“存档位置含顶层”的可写属性。
 * R-33 记录了它被违反过的后果——新增可写属性（如 `isClicker`）时只改了权限矩阵、
 * 没同步 `SaveFile`，于是该属性的运行时赋值**只落在 `assignments`**，而布尔/数值属性读档
 * “以顶层为准”，赋值在读档后**静默丢失且无任何报错**。
 *
 * 14.3 把这条不变式的防线定为 CI 里的 `docs:check` 脚本。本模块是该脚本的**可执行形态**：
 * 它直接读 `PROPERTY_SPECS`（expr 包的 5.9 权限表，**唯一依据**）与本包的 Zod Schema，
 * 在单测里就能拦住漂移，不必等 CI。
 */
import { PROPERTY_SPECS, templateKey } from '@iforge/expr'
import type { PropertySpec } from '@iforge/expr'

import { generatorShape, saveGeneratorShape, savePageShape, saveResourceShape, saveUpgradeShape, upgradeShape } from './schema.js'

/** 四类实体在存档里的顶层字段集合（取自 6.3 的 Schema 形状）。 */
export const SAVE_TOP_LEVEL_FIELDS = {
  resource: saveResourceShape,
  generator: saveGeneratorShape,
  upgrade: saveUpgradeShape,
  page: savePageShape,
} as const

export type SaveEntityKind = keyof typeof SAVE_TOP_LEVEL_FIELDS

/** 条目/页面前缀（`res`/`gen`/`up`/`page`）到存档实体类的映射（5.3 的路径前缀与 6.3 的记录容器）。 */
const PREFIX_TO_ENTITY: Readonly<Record<string, SaveEntityKind>> = {
  res: 'resource',
  gen: 'generator',
  up: 'upgrade',
  page: 'page',
}

/**
 * 只读但仍落在存档顶层的字段（5.9.1 第 19 行：`buyDelay` 是实现细节、只读，
 * 但 6.3 的 `SaveGenerator`/`SaveUpgrade` 都存了它）。
 *
 * 这条不参与“可写属性”比对（它是只读的），单独列出以免把“不在期望集合里”误报成缺失。
 */
const READONLY_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(['buyDelay'])

/**
 * 5.9 的属性名 -> 6.3 的存档顶层字段名。
 *
 * 只有一处需要转换：列表属性 `effectValues[i]` 在存档里是一个以效果下标为键的
 * **记录**（6.3 `effectValues: Record<string, string>`），字段名是 `effectValues` 而非
 * `effectValues[i]`。其余属性同名。
 *
 * 注意不能用 `templateKey()` 反推：`templateKey` 是把**具体**下标 `costs[0]` 归一成模板
 * `costs[i]`（expr 侧的方向），这里要的是反方向——把模板还原成存档里的容器名。
 */
function saveFieldName(property: string): string {
  return property.endsWith('[i]') ? property.slice(0, -3) : property
}

/**
 * 6.3 的完整性不变式（14.3 规则 1）。
 *
 * 对 5.9 中每一条 `writable && storage === 'top-level'` 的属性，
 * 断言它在对应实体的存档顶层字段里存在。
 */
export function checkSaveCoverage(): string[] {
  const problems: string[] = []
  const fieldsByEntity: Record<string, Set<string>> = {
    resource: new Set(Object.keys(saveResourceShape)),
    generator: new Set(Object.keys(saveGeneratorShape)),
    upgrade: new Set(Object.keys(saveUpgradeShape)),
    page: new Set(Object.keys(savePageShape)),
  }

  for (const [name, spec] of Object.entries(PROPERTY_SPECS)) {
    if (!spec.writable || spec.storage !== 'top-level') continue
    // `res.<id>.owned` 是 `amount` 的别名（D-37）：`lookupProperty` 已把它归一到 `amount`，
    // 但 `PROPERTY_SPECS` 里仍有这条独立登记，这里显式跳过以免误报“存档缺 owned”。
    if (name === 'res.owned') continue
    // 列表字段只落 `assignments`（6.3 末段），它们在 `storage` 里已是 `assignments`，上面已过滤。
    if (spec.storage !== 'top-level') continue

    const field = saveFieldName(templateKey(name))
    for (const prefix of spec.prefixes) {
      const entity = PREFIX_TO_ENTITY[prefix]
      if (!entity) continue
      const fields = fieldsByEntity[entity]!
      if (!fields.has(field)) {
        problems.push(`5.9 的可写属性 ${prefix}.<id>.${field}（${entity}）在 6.3 的存档顶层字段中缺失（${entity}: ${[...fields].join(', ')}）`)
      }
    }
  }

  // 反向检查：存档顶层多出来的字段必须是 5.9 登记过的（否则说明有属性绕过了权限矩阵）。
  for (const entity of Object.keys(fieldsByEntity) as SaveEntityKind[]) {
    const prefix = Object.entries(PREFIX_TO_ENTITY).find(([, value]) => value === entity)?.[0]
    if (!prefix) continue
    for (const field of fieldsByEntity[entity]!) {
      if (READONLY_TOP_LEVEL_FIELDS.has(field)) continue
      if (field === 'assignments') continue
      const spec: PropertySpec | undefined = PROPERTY_SPECS[field]
      const listSpec: PropertySpec | undefined = PROPERTY_SPECS[`${field}[i]`]
      if (!spec?.prefixes.includes(prefix as never) && !listSpec?.prefixes.includes(prefix as never)) {
        problems.push(`6.3 的存档顶层字段 ${entity}.${field} 在 5.9 属性读写矩阵中没有对应行`)
      }
    }
  }

  return problems
}

/**
 * 动态创建 spec 白名单与项目文件字段的一致性（5.2 约束表「键名」行、8.7「字段集合」行）。
 *
 * 约束是双向的：
 * - `create()` 的 `spec` 必须是 `GeneratorDef`/`UpgradeDef` 的**子集**（5.2 约束表）；
 * - 白名单里的 `page` 是 spec 专有字段（PRD 补充 7 要求动态条目必须指定页面），
 *   它不出现在项目文件里，因为静态条目的归属由 `PageDef.entries` 承载；
 * - `kind`/`buyDelay` **由运行时接管**，出现在 spec 中即 `E_CREATE_FIELD_INVALID`（8.7），
 *   因此它们**不在**白名单里（`expr` 的 `RUNTIME_MANAGED_FIELDS` 负责报错）。
 *
 * 新增条目字段时若忘了同步 `expr` 的 `create-spec.ts`，本函数会立刻报出来——
 * 否则动态创建的条目就会缺字段，作者只能在运行时看到“字段不存在”。
 */
export function checkCreateSpecCoverage(createFields: Readonly<Record<'generator' | 'upgrade', readonly string[]>>): string[] {
  const problems: string[] = []
  /** spec 专有、不在项目文件里的字段（附理由）。 */
  const specOnly = new Set(['page'])
  const shapes: Record<'generator' | 'upgrade', Set<string>> = {
    generator: new Set(Object.keys(generatorShape)),
    upgrade: new Set(Object.keys(upgradeShape)),
  }
  for (const kind of ['generator', 'upgrade'] as const) {
    for (const field of createFields[kind]) {
      if (specOnly.has(field)) continue
      if (!shapes[kind]!.has(field)) {
        problems.push(`create() 的 ${kind} spec 含 ${field}，但它不是 ${kind}Def 的字段（5.2 约束表「键名」行）`)
      }
    }
  }
  return problems
}
