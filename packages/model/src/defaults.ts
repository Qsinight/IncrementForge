/**
 * 默认工厂与新建项目模板（TECH_DESIGN 7.9、8.7「缺省」行、D-03）。
 *
 * **“新建”写默认模板**（7.9）只走 `createDefaultProject()`；“列表添加”（7.5）只走
 * `createResource/createGenerator/createUpgrade/createPage`，两者共用同一份字段默认值，
 * 保证动态创建的缺省值（8.7「缺省」行）与编辑器新建条目**逐字一致**——
 * 这两条路径若各写一份默认值，同一个条目从编辑器加进来和从表达式创建出来就会长得不一样。
 */
import { ID_PATTERN } from './id.js'
import { KIND_ID_PREFIX, nextId } from './id.js'
import type { EntryKind } from './id.js'
import type { GeneratorDef, IconRef, PageDef, ProjectFile, ProjectSettings, ResourceDef, ThemeRef, UpgradeDef } from './schema.js'
import { PROJECT_FORMAT, SCHEMA_VERSION } from './schema.js'

/** 编辑器自身版本（6.2 `engineVersion`：最后修改时记录的编辑器版本，PRD 设置页 5）。 */
export const ENGINE_VERSION = '1.0.0'

/**
 * “无上限”的缺省写法（D-46、4.4 第 6 条）。
 *
 * 必须是**合法字面量文本**：5.2 收录了 `Infinity`，因此 `max: "Infinity"` 能编译通过
 * （若语法漏收该字面量会报 `E_UNKNOWN_IDENT`，动态条目根本创建不出来，R-36）。
 * 运行期 `isInf(max)` 为真时 `applyCap` 完全跳过钳制。
 */
export const NO_LIMIT = 'Infinity'

/** 游戏默认设置（6.2、D-03、7.7）。 */
export const DEFAULT_SETTINGS: ProjectSettings = {
  numberFormat: 'standard',
  tickRate: 20,
  maxFrameStep: 250,
  autosaveInterval: 30,
  offlineEnabled: true,
  offlineCap: 8,
}

/** 默认内置图标/主题引用。 */
export function builtin<T extends IconRef | ThemeRef>(value: string): T {
  return { kind: 'builtin', value } as T
}

interface NewEntryOptions {
  /** 已占用的 id（四类全局唯一，6.1）。缺省时只用“刚造出来的同类条目”做去重。 */
  taken?: ReadonlySet<string>
  /** 显式指定 id（动态创建的 `spec.id` 会走这里，8.7「id」行）。 */
  id?: string
  name?: string
  order?: number
  page?: string
}

function allocateId(kind: EntryKind, options: NewEntryOptions): string {
  if (options.id !== undefined) return options.id
  return nextId(KIND_ID_PREFIX[kind], options.taken ?? new Set<string>())
}

/** 新建资源（7.5「添加」行）：PRD 资源编辑器 1–6 的缺省值。 */
export function createResource(options: NewEntryOptions = {}): ResourceDef {
  return {
    kind: 'resource',
    id: allocateId('resource', options),
    order: options.order ?? 1,
    name: options.name ?? '新资源',
    description: '',
    icon: builtin<IconRef>('gem'),
    visible: true,
    // 8.7「缺省」行与 6.2 的 NumExpr 约定：数值字段一律字符串。
    initial: '0',
    max: NO_LIMIT,
  }
}

/** 新建生成器（7.5「添加」行、8.7「缺省」行）。 */
export function createGenerator(options: NewEntryOptions = {}): GeneratorDef {
  return {
    kind: 'generator',
    id: allocateId('generator', options),
    order: options.order ?? 1,
    name: options.name ?? '新生成器',
    description: '',
    icon: builtin<IconRef>('factory'),
    visible: true,
    initial: '0',
    max: NO_LIMIT,
    disabled: false,
    isClicker: false,
    buyAmount: '1',
    buyDelay: 1,
    costs: [],
    produces: [],
  }
}

/** 新建升级（7.5「添加」行、8.7「缺省」行）。 */
export function createUpgrade(options: NewEntryOptions = {}): UpgradeDef {
  return {
    kind: 'upgrade',
    id: allocateId('upgrade', options),
    order: options.order ?? 1,
    name: options.name ?? '新升级',
    description: '',
    icon: builtin<IconRef>('star'),
    visible: true,
    initial: '0',
    max: NO_LIMIT,
    disabled: false,
    perSecond: false,
    buyAmount: '1',
    buyDelay: 1,
    costs: [],
    // 购买条件默认为真（PRD 升级编辑器 8「默认为真」）。
    conditions: [],
    effects: [],
  }
}

/** 新建页面（7.5「添加」行）。`entries` 一律为空：复制页面**不复制 entries**（D-39、PRD 补充 7）。 */
export function createPage(options: NewEntryOptions = {}): PageDef {
  return {
    kind: 'page',
    id: allocateId('page', options),
    order: options.order ?? 1,
    name: options.name ?? '新页面',
    description: '',
    icon: builtin<IconRef>('grid'),
    visible: true,
    disabled: false,
    theme: builtin<ThemeRef>('page-dark'),
    columns: 1,
    entries: [],
  }
}

/**
 * 新建项目模板（7.9「新建」）。
 *
 * 写一个默认页面 `p1`（`name = "主页面"`、`visible = true`、`columns = 1`、`entries = []`），
 * `resources/generators/upgrades = []`、`assets = {}`，`settings` 取 `DEFAULT_SETTINGS`。
 * 游戏内“设置”页是**运行时内置页面**，不属于 `pages`（7.9 同节），因此这里不出现它。
 *
 * @param projectId `crypto.randomUUID()`（由调用方注入以保证可测试，7.9）；
 *   本函数本身不返回它——它只在 `ProjectFile` 之外作为 IndexedDB 主键与存档字段使用。
 */
export function createDefaultProject(options: { now?: string; engineVersion?: string } = {}): ProjectFile {
  const now = options.now ?? new Date().toISOString()
  return {
    format: PROJECT_FORMAT,
    version: SCHEMA_VERSION,
    engineVersion: options.engineVersion ?? ENGINE_VERSION,
    meta: {
      name: '未命名项目',
      author: '',
      description: '',
      createdAt: now,
      modifiedAt: now,
    },
    settings: { ...DEFAULT_SETTINGS },
    resources: [],
    generators: [],
    upgrades: [],
    pages: [
      {
        kind: 'page',
        id: 'p1',
        order: 1,
        name: '主页面',
        description: '',
        icon: builtin<IconRef>('grid'),
        visible: true,
        disabled: false,
        theme: builtin<ThemeRef>('page-dark'),
        columns: 1,
        entries: [],
      },
    ],
    assets: {},
  }
}

/**
 * `ID_PATTERN` 的重导出，避免 `schema.ts` 与 `defaults.ts` 各引一次造成循环依赖。
 * 6.1「单一事实源」要求只有 `id.ts` 定义它。
 */
export { ID_PATTERN }
