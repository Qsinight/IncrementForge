/**
 * 项目文件与存档文件的 Zod Schema（TECH_DESIGN 6.2、6.3、6.4）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime`。本包只依赖 `@iforge/num` 与
 * `@iforge/expr`（表达式编译校验与 8.7 的字段白名单复用），不依赖 `runtime`，不导入任何 DOM API。
 *
 * ## 两条关键约束
 *
 * 1. **未知字段一律保留并回写**（6.4 末条“向前兼容，避免新引擎字段被旧编辑器丢弃”）：
 *    所有对象 schema 用 `.passthrough()`，而不是 `.strict()`。`strict()` 会让新引擎写的字段
 *    被旧引擎拒绝，与 6.4 的意图正好相反。
 * 2. **拒绝 `__proto__` 键**（13 第 6 条）：`JSON.parse` 会把 `__proto__` 建成**自有属性**，
 *    拷贝进普通对象时若不显式拦截就会污染原型链。这里用 `z.preprocess` 统一检查。
 */
import { z } from 'zod'

import { ENTRY_KINDS, ID_PATTERN } from './id.js'

/** 文件格式标识（6.2 / 6.3）：用于区分项目文件与存档文件，导入时先看它。 */
export const PROJECT_FORMAT = 'incrementforge-project' as const
export const SAVE_FORMAT = 'incrementforge-save' as const

/** 当前 Schema 版本（6.2 `version`；迁移器按它逐级升级，6.4）。 */
export const SCHEMA_VERSION = 1 as const

/** V1.0 固定存档位（PRD 补充 8 单存档；字段先落地以预留多存档，6.3）。 */
export const DEFAULT_SLOT_ID = 'main' as const

/**
 * 拒绝 `__proto__` / `constructor` / `prototype` 键（13 第 6 条「拒绝 `__proto__` 键」）。
 *
 * `z.preprocess` 而不是 `superRefine`：后者在 `.parse()` 已经把输入**拷贝**进结果对象之后才跑，
 * 污染已经发生；preprocess 在拷贝之前拦，才是真正的双保险。
 */
function rejectProtoKeys<T extends z.ZodTypeAny>(schema: T): T {
  return z.preprocess((value, ctx) => {
    if (isForbiddenKeyContainer(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '文件含 __proto__/constructor/prototype 键（13 第 6 条）' })
      return z.NEVER
    }
    return value
  }, schema) as unknown as T
}

function isForbiddenKeyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isForbiddenKeyContainer)
  if (typeof value !== 'object' || value === null) return false
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true
    if (isForbiddenKeyContainer((value as Record<string, unknown>)[key])) return true
  }
  return false
}

/** 带 `.passthrough()` 与原型键拦截的对象 schema。 */
function openObject<T extends z.ZodRawShape>(shape: T) {
  return rejectProtoKeys(z.object(shape).passthrough())
}

/**
 * 条目定义 schema（资源/生成器/升级/页面）的构造器。
 *
 * 返回**未包 `rejectProtoKeys`** 的裸 `ZodObject`，因为存档 Schema 需要在它之上
 * `.extend({ createdAt, pageId })` 构造动态条目（6.3 `dynamic[]`），
 * 而 `ZodEffects`（`z.preprocess` 的产物）没有 `.extend`。
 * 原型键拦截最终由 `projectFileSchema` / `saveFileSchema` 这两个**最外层** schema 兜住
 * （`isForbiddenKeyContainer` 是递归的，一次就能拦住整棵树）。
 */
function defObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).passthrough()
}

/**
 * `kind` 的默认值（6.1：`ResourceDef { kind: 'resource' }` 等）。
 *
 * 用 `.default()` 而不是必填：17.2 的示例项目 JSON 里每个条目都**没有** `kind`
 * ——数组位置（`resources`/`generators`/`upgrades`/`pages`）已经唯一确定了类型，
 * 文件里省略它是无信息的冗余，强制作者补一遍只会让手写项目文件更啰嗦。
 * 输出类型仍是必填（`z.infer` 得到 `'resource'` 而非 `| undefined`），
 * 因此 `DefByKind` 的分派与运行时的穷尽性不受影响。
 */
function kindLiteral<T extends string>(value: T) {
  return z.literal(value).default(value)
}

/** `IconRef`（6.1）：内置图标 id / `data:` URL / 资产库 id。 */
export const iconRefSchema = rejectProtoKeys(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('builtin'), value: z.string() }).passthrough(),
    z.object({ kind: z.literal('data'), value: z.string() }).passthrough(),
    z.object({ kind: z.literal('asset'), value: z.string() }).passthrough(),
  ]),
)

/** `ThemeRef`（6.1）：内置主题 id / 自定义 CSS 文本。结构与 `IconRef` 同形。 */
export const themeRefSchema = iconRefSchema

/** `order`：`1..N` 连续整数（7.5「排序」行、D-40），此处只兜下界。 */
const orderSchema = z.number().int().min(0)

/** 布尔字段统一用 `boolean`：`visible`/`disabled`/`isClicker`/`perSecond`。 */
const booleanSchema = z.boolean()

/**
 * `NumExpr`：纯数字字面量或表达式源码的**字符串**字段（6.1、5.9.3）。
 *
 * 这里只保证是字符串；合法性与表达式语义由 `validateProject` 逐字段按所属上下文编译校验
 * （6.4「表达式目标合法」），避免在 Schema 层就把 `"abc"` 这种“编译期才发现的问题”变成类型错误。
 */
const numExprSchema = z.string()

/** `CostEntry`（6.2）：购买价格 / 产出。`amount` 是单件价格或**单件产出速率**（D-30）。 */
export const costEntrySchema = openObject({
  materialId: z.string(),
  amount: numExprSchema,
})

/** `EffectEntry`（6.2）：效果前提 / 效果内容（赋值表达式，5.1）。 */
export const effectEntrySchema = openObject({
  condition: z.string(),
  action: z.string(),
})

/** `VisualDef` 共有字段（6.1）。 */
const visualShape = {
  id: z.string(),
  order: orderSchema,
  name: z.string(),
  description: z.string(),
  icon: iconRefSchema,
  visible: booleanSchema,
}

/** `EntryDef` 共有字段（6.1：资源/生成器/升级）。 */
const entryShape = {
  ...visualShape,
  initial: numExprSchema,
  /** 缺省/无上限写 `"Infinity"`（D-46、4.4 第 6 条），是合法字面量因此编译期不会 `E_UNKNOWN_IDENT`。 */
  max: numExprSchema,
}

/**
 * `ResourceDef`（6.2）：**无 `disabled`、无 `bought`**（D-20、D-37）。
 */
export const resourceShape = {
  kind: kindLiteral('resource'),
  ...entryShape,
}
export const resourceDefSchema = defObject(resourceShape)

/** `GeneratorDef`（6.2、6.5.2）。 */
const buyableShape = {
  disabled: booleanSchema,
  /** `NumExpr`，整数，`>0` 默认 1、`<=100` 为上限、`0`=最大、`<0`=自动最大（D-36）。 */
  buyAmount: numExprSchema,
  /**
   * 自动最大购买的间隔 tick 数（D-04，默认每 tick 一次）。
   *
   * 给了 `.default(1)`：它是实现细节字段（8.7 明确 `kind`/`buyDelay` 由运行时接管、
   * 不出现在 `create()` 的 spec 里），17.2 的示例项目里 `u1` 就没有写它——
   * 作者不该为实现细节的默认值埋单。
   */
  buyDelay: z.number().int().min(1).default(1),
}

export const generatorShape = {
  kind: kindLiteral('generator'),
  ...entryShape,
  ...buyableShape,
  isClicker: booleanSchema,
  costs: z.array(costEntrySchema),
  produces: z.array(costEntrySchema),
}
export const generatorDefSchema = defObject(generatorShape)

/** `UpgradeDef`（6.2、6.5.3）。 */
export const upgradeShape = {
  kind: kindLiteral('upgrade'),
  ...entryShape,
  ...buyableShape,
  perSecond: booleanSchema,
  costs: z.array(costEntrySchema),
  /** AND 组合（PRD 补充 4）；需 OR 由用户在表达式内自行实现。 */
  conditions: z.array(z.string()),
  effects: z.array(effectEntrySchema),
}
export const upgradeDefSchema = defObject(upgradeShape)

/**
 * `PageDef.entries[]` 元素（6.2）：条目只能属于一个页面（PRD 补充 7）。
 *
 * `theme` **可选**：缺省即“跟随页面主题”（PRD 页面编辑器 8）。跟随必须能被表达成
 * “没有值”，否则作者一旦选过某个条目主题就再也回不到跟随态（而跟随态正是页面主题
 * 换色时卡片跟着换的前提）。渲染期由 `resolveEntryTokens()` 解析，缺项逐键回退（D-13）。
 */
export const pageEntrySchema = openObject({
  id: z.string(),
  theme: themeRefSchema.optional(),
  order: orderSchema,
})

/** `PageDef`（6.2、6.5.4）。 */
export const pageShape = {
  kind: kindLiteral('page'),
  ...visualShape,
  disabled: booleanSchema,
  theme: themeRefSchema,
  columns: z.number().int().min(1),
  entries: z.array(pageEntrySchema),
}
export const pageDefSchema = defObject(pageShape)

/** 数字显示格式枚举（4.5、D-17）。 */
export const numberFormatSchema = z.enum(['standard', 'scientific', 'engineering', 'letters', 'layered'])

/** `ProjectSettings`（6.2「游戏默认设置」）：只由编辑器设置页修改，随“保存”落盘（D-22）。 */
export const projectSettingsSchema = openObject({
  numberFormat: numberFormatSchema,
  /** 逻辑帧率，默认 20（D-03）。 */
  tickRate: z.number().positive(),
  /** 单帧最大步长（ms），默认 250（D-03）。 */
  maxFrameStep: z.number().positive(),
  /** 自动存档间隔（秒），默认 30（D-03）。 */
  autosaveInterval: z.number().positive(),
  offlineEnabled: booleanSchema,
  /** 离线收益上限（小时），默认 8（D-03）。 */
  offlineCap: z.number().min(0),
})

/** 已内联的资产（6.2 `assets`；导出/打包时把被引用的资产内联为 `data:`，D-12）。 */
export const assetRecordSchema = openObject({
  kind: z.enum(['icon', 'theme']),
  mime: z.string(),
  data: z.string(),
})

export const projectFileSchema = rejectProtoKeys(
  z
    .object({
      format: z.literal(PROJECT_FORMAT),
      version: z.number().int().positive(),
      engineVersion: z.string(),
      meta: openObject({
        name: z.string(),
        author: z.string(),
        description: z.string(),
        /** ISO8601（6.2）。 */
        createdAt: z.string(),
        modifiedAt: z.string(),
      }),
      settings: projectSettingsSchema,
      resources: z.array(resourceDefSchema),
      generators: z.array(generatorDefSchema),
      upgrades: z.array(upgradeDefSchema),
      pages: z.array(pageDefSchema),
      assets: z.record(z.string(), assetRecordSchema),
    })
    .passthrough()
    // 6.4「跨条目一致性校验（superRefine，不通过则阻断保存/打包）」：
    // 实现放在 `validate.ts`（编辑器表单提交与打包前检查各自单独调用），
    // 这里只把它挂到 Schema 上，使「Zod 校验 → 一致性校验 → 事务写」是同一步。
    // 走惰性注册是为了断开 `schema` ↔ `validate` 的模块级循环
    // （`validate` 依赖本文件的 Schema，`superRefine` 又依赖 `validate`）。
    .superRefine((value, ctx) => {
      for (const issue of crossEntryIssues(value as ProjectFile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          // 把 `generators[3].costs[0].amount` 解析成 Zod 的 path 数组，
          // 编辑器才能把错误定位到**那个输入框**而不是整份文件的根节点。
          path: parseWherePath(issue.where),
          message: issue.message ? `${issue.code}: ${issue.message}` : issue.code,
        })
      }
    }),
)

/** 把定位路径文本（`generators[3].costs[0].amount`）解析成 Zod 的 path 数组。 */
function parseWherePath(where: string): (string | number)[] {
  const out: (string | number)[] = []
  const pattern = /([A-Za-z]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(where)) !== null) {
    if (match[1] !== undefined) out.push(match[1])
    else if (match[2] !== undefined) out.push(Number(match[2]))
  }
  return out
}

/**
 * 跨条目一致性校验的**惰性**入口（避免 `schema` ↔ `validate` 的模块级循环）。
 *
 * `validate.ts` 顶层会 import 本文件的 Schema（`parseProjectFile` 依赖它），
 * 若这里再静态 import `validate.ts` 就成了 ESM 循环；用一个函数级 import 打断即可
 * （ESM 的静态分析能正确处理，且只在首次解析项目文件时才真正加载）。
 */
function crossEntryIssues(value: ProjectFile): Array<{ code: string; where: string; message?: string }> {
  const module = validateModule
  return module ? module.validateProject(value) : []
}

/** 由 `validate.ts` 在模块初始化末尾注入（见下方 `installCrossEntryValidator`）。 */
let validateModule: { validateProject: (project: ProjectFile) => Array<{ code: string; where: string; message?: string }> } | undefined

/** 由 `validate.ts` 调用一次，避免上面的惰性占位符永远为空。 */
export function installCrossEntryValidator(module: NonNullable<typeof validateModule>): void {
  validateModule = module
}

/**
 * `Assignment`（6.3）：运行时被赋值过的属性记录。
 *
 * `value`/`expr` 的语义按目标类型分档，见 6.3 的对照表——键 `path` 本身已编码目标类型，
 * **不需要** `targetType` 字段。`expr` 只读不解释，读档**不回放**（6.3「不回放表达式」）。
 */
export const assignmentSchema = openObject({
  value: z.string(),
  expr: z.string(),
  tick: z.number(),
})

const assignmentsSchema = z.record(z.string(), assignmentSchema)

/**
 * 存档的资源记录（6.3）。
 *
 * 资源无 `bought`/`disabled`（D-20）；`owned` 是 `amount` 的别名、**不单独存档**（D-37、6.3 完整性不变式）。
 */
export const saveResourceShape = {
  amount: z.string(),
  max: z.string(),
  initial: z.string(),
  visible: booleanSchema,
  description: z.string(),
  assignments: assignmentsSchema,
}
export const saveResourceSchema = openObject(saveResourceShape)

/** 存档的生成器记录（6.3）。顶层字段必须覆盖 5.9.1 中所有“存档位置含顶层”的可写属性（含 `isClicker`，R-33）。 */
export const saveGeneratorShape = {
  bought: z.string(),
  owned: z.string(),
  max: z.string(),
  initial: z.string(),
  visible: booleanSchema,
  disabled: booleanSchema,
  isClicker: booleanSchema,
  buyAmount: z.string(),
  buyDelay: z.number().int().min(1).default(1),
  description: z.string(),
  assignments: assignmentsSchema,
}
export const saveGeneratorSchema = openObject(saveGeneratorShape)

/** 存档的升级记录（6.3）。`effectValues` 每个效果独立持久化（PRD 升级编辑器 12）。 */
export const saveUpgradeShape = {
  bought: z.string(),
  owned: z.string(),
  max: z.string(),
  initial: z.string(),
  visible: booleanSchema,
  disabled: booleanSchema,
  buyAmount: z.string(),
  buyDelay: z.number().int().min(1).default(1),
  perSecond: booleanSchema,
  description: z.string(),
  /** 键为效果下标字符串；默认 `0`，“重新开始”后清零（D-18）。 */
  effectValues: z.record(z.string(), z.string()),
  assignments: assignmentsSchema,
}
export const saveUpgradeSchema = openObject(saveUpgradeShape)

/** 存档的页面记录（6.3）：无 `initial`/`max`/`bought`。 */
export const savePageShape = {
  visible: booleanSchema,
  disabled: booleanSchema,
  description: z.string(),
  assignments: assignmentsSchema,
}
export const savePageSchema = openObject(savePageShape)

/** 动态条目：项目定义 + `createdAt` + `pageId`（6.3 `dynamic`；不写项目文件，只进存档）。 */
export const dynamicGeneratorSchema = defObject({
  ...generatorShape,
  createdAt: z.string(),
  pageId: z.string(),
})
export const dynamicUpgradeSchema = defObject({
  ...upgradeShape,
  createdAt: z.string(),
  pageId: z.string(),
})

/**
 * `SaveFile`（6.3）。
 *
 * **没有 `currentPageId`**：导航是 UI 会话状态，不写入存档（D-50、14.3 规则 5）。
 * **没有游戏内设置**：数字格式/帧率等属 UI 偏好，按 D-22 单独持久化，导出存档不携带。
 */
export const saveFileSchema = rejectProtoKeys(
  z
    .object({
      format: z.literal(SAVE_FORMAT),
      version: z.number().int().positive(),
      engineVersion: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      slotId: z.string(),
      savedAt: z.string(),
      lastSeenAt: z.string(),
      /** 秒。 */
      playtime: z.number(),
      /** 游戏内累计秒数（含离线）。 */
      gameTime: z.number(),
      /** 已结算的离线收益秒数。 */
      offlineAccum: z.number(),
      resources: z.record(z.string(), saveResourceSchema),
      generators: z.record(z.string(), saveGeneratorSchema),
      upgrades: z.record(z.string(), saveUpgradeSchema),
      pages: z.record(z.string(), savePageSchema),
      dynamic: openObject({
        generators: z.array(dynamicGeneratorSchema),
        upgrades: z.array(dynamicUpgradeSchema),
      }),
      /** 未知字段合并进来并在下次写回时保留（6.3 读档顺序 ⑥）。 */
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
)

/** 由 Schema 推导的类型（编辑器只通过 Schema 读写数据，3.2「禁止直接操作裸对象字面量」）。 */
export type IconRef = z.infer<typeof iconRefSchema>
export type ThemeRef = z.infer<typeof themeRefSchema>
export type NumberFormat = z.infer<typeof numberFormatSchema>
export type CostEntry = z.infer<typeof costEntrySchema>
export type EffectEntry = z.infer<typeof effectEntrySchema>
export type ResourceDef = z.infer<typeof resourceDefSchema>
export type GeneratorDef = z.infer<typeof generatorDefSchema>
export type UpgradeDef = z.infer<typeof upgradeDefSchema>
export type PageEntry = z.infer<typeof pageEntrySchema>
export type PageDef = z.infer<typeof pageDefSchema>
export type ProjectSettings = z.infer<typeof projectSettingsSchema>
export type AssetRecord = z.infer<typeof assetRecordSchema>
export type ProjectFile = z.infer<typeof projectFileSchema>
export type Assignment = z.infer<typeof assignmentSchema>
export type SaveFile = z.infer<typeof saveFileSchema>
export type SaveResource = z.infer<typeof saveResourceSchema>
export type SaveGenerator = z.infer<typeof saveGeneratorSchema>
export type SaveUpgrade = z.infer<typeof saveUpgradeSchema>
export type SavePage = z.infer<typeof savePageSchema>
export type DynamicGenerator = z.infer<typeof dynamicGeneratorSchema>
export type DynamicUpgrade = z.infer<typeof dynamicUpgradeSchema>

/** 条目定义的联合类型（四类，6.1 的三级继承在类型层面同样分层）。 */
export type EntryDef = ResourceDef | GeneratorDef | UpgradeDef
export type BuyableDef = GeneratorDef | UpgradeDef
/** 条目类型 -> 定义的映射，供 `AttributeStore` 与 8.4 判定函数做穷尽分派。 */
export type DefByKind = {
  resource: ResourceDef
  generator: GeneratorDef
  upgrade: UpgradeDef
  page: PageDef
}
export const ALL_ENTRY_KINDS = ENTRY_KINDS
export { ID_PATTERN }
