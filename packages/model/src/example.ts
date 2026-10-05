/**
 * 示例项目（TECH_DESIGN 17.2）——最小可玩示例，作为单测 / E2E / “新建项目”起始模板的**唯一夹具**。
 *
 * 放在 `model` 而不是各包 `test/helpers` 里的原因：M2 的交付标准是
 * 「可在无 UI 下跑通示例项目 1000 tick」（17.5），而 `model`（校验/Schema）与
 * `runtime`（tick）**都要**用同一份夹具——写成两份就会漂移，出现“model 测过的项目
 * runtime 跑不起来”或反之。本包被 `runtime` 依赖（3.2 的 `model ← runtime`），
 * 因此两边的测试都从 `@iforge/model` 取同一份数据。
 *
 * 内容与 17.2 逐字对应：主示例 + 三条补充片段（点击器 / 动态创建 / 页面禁用）。
 */
import { NO_LIMIT } from './defaults.js'
import type { GeneratorDef, PageDef, ProjectFile, ResourceDef, UpgradeDef } from './schema.js'
import { PROJECT_FORMAT, SCHEMA_VERSION } from './schema.js'

const NOW = '2026-01-01T00:00:00.000Z'

const entryTheme = { kind: 'builtin' as const, value: 'entry-dark' }
const pageTheme = { kind: 'builtin' as const, value: 'page-dark' }

/** 主示例的资源（17.2 `resources`）：矿石。 */
function exampleResource(): ResourceDef {
  return {
    kind: 'resource',
    id: 'r1',
    order: 1,
    name: '矿石',
    description: '基础资源',
    icon: { kind: 'builtin', value: 'gem' },
    initial: '0',
    // 1e1e10 量级：PRD 补充 2 要求的购买/产出/效果量级。
    max: '1e1e10',
    visible: true,
  }
}

/** 主示例的生成器（17.2 `generators[0]`）：矿机。 */
function exampleGenerator(): GeneratorDef {
  return {
    kind: 'generator',
    id: 'g1',
    order: 1,
    name: '矿机',
    description: '自动产出矿石',
    icon: { kind: 'builtin', value: 'factory' },
    initial: '0',
    max: '500',
    visible: true,
    disabled: false,
    isClicker: false,
    buyAmount: '1',
    buyDelay: 1,
    // 价格成长由“材料已购买数量”的表达式实现（PRD 生成器编辑器 9）。
    costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }],
    // D-30：`amount` 是**单件**产出速率，总产出 = owned × 1，此处不再乘 owned。
    produces: [{ materialId: 'r1', amount: '1' }],
  }
}

/** 主示例的升级（17.2 `upgrades[0]`）：双倍产量。 */
function exampleUpgrade(): UpgradeDef {
  return {
    kind: 'upgrade',
    id: 'u1',
    order: 1,
    name: '双倍产量',
    description: '矿机产量 ×2',
    icon: { kind: 'builtin', value: 'star' },
    initial: '0',
    max: '1',
    visible: true,
    disabled: false,
    perSecond: true,
    buyAmount: '1',
    // 17.2 的 JSON 未写 `buyDelay`：它是实现细节字段（8.7 由运行时接管、不进 `create()` 的 spec），
    // Schema 给的是 `.default(1)`（D-04 的“默认每 tick 一次”）。内存中的 `ProjectFile` 始终带该字段。
    buyDelay: 1,
    costs: [{ materialId: 'r1', amount: '100' }],
    // 购买条件列表 AND 判定（PRD 补充 4）。
    conditions: ['gen.g1.bought >= 5'],
    // 两条效果都会被判断，不短路（D-23）。
    // 17.2 注释：一个 action 只能是一条赋值表达式（语法无语句、5.2 无 `;`、13 的 `;` 黑名单），
    // 需要多条写入时拆成多条效果。
    effects: [
      // 效果 0：热替换单件速率——“2”原样成为新的表达式源码（D-29、5.4 的 set()）。
      { condition: 'gen.g1.bought >= 5', action: 'set("gen.g1.produces[0].amount", "2")' },
      // 效果 1：持久化效果数值——对 effValue 赋值即写回 up.u1.effectValues[1]。
      { condition: 'gen.g1.bought >= 20', action: 'effValue = 1.5 * gen.g1.owned' },
      // 补充片段 ②（17.2）：动态创建升级。
      // 前提必须带 !has(...) 幂等守卫，否则该效果每次重算都会重复创建并报 E_CREATE_ID_CONFLICT（8.7）。
      {
        condition: 'gen.g1.bought >= 10 && !has("upgrade", "uTmp")',
        action:
          'create("upgrade", { id: "uTmp", name: "临时强化", description: "动态条目，不进项目文件", page: "p1", initial: "0", max: "1", costs: [{ materialId: "r1", amount: "50" }], conditions: ["true"] })',
      },
    ],
  }
}

/** 主示例的页面（17.2 `pages[0]`）：工厂。 */
function examplePage(): PageDef {
  return {
    kind: 'page',
    id: 'p1',
    order: 1,
    name: '工厂',
    description: '主页面',
    icon: { kind: 'builtin', value: 'grid' },
    visible: true,
    disabled: false,
    theme: pageTheme,
    columns: 1,
    entries: [
      { id: 'r1', order: 1, theme: entryTheme },
      { id: 'g1', order: 2, theme: entryTheme },
      { id: 'u1', order: 3, theme: entryTheme },
    ],
  }
}

/** 补充片段 ①（17.2）：点击器——取消自动生产、不可购买、`bought = 0`、`owned = initial`（D-19/D-28）。 */
function exampleClicker(): GeneratorDef {
  return {
    kind: 'generator',
    id: 'g2',
    order: 2,
    name: '手动敲击',
    description: '点击获得矿石',
    icon: { kind: 'builtin', value: 'hand' },
    initial: '1',
    max: '10',
    visible: true,
    disabled: false,
    isClicker: true,
    buyAmount: '1',
    buyDelay: 1,
    // costs 虽保留在数据模型中，但 canBuy 恒假、永不被求值（D-28）。
    costs: [],
    produces: [{ materialId: 'r1', amount: '1' }],
  }
}

/** 补充片段 ③（17.2）：被禁用的页面——条目不可购买/产出/生效，但资源卡片不置灰、导航仍可跳转（8.4）。 */
function exampleDisabledPage(): PageDef {
  return {
    kind: 'page',
    id: 'p2',
    order: 2,
    name: '实验区',
    description: '被禁用的页面',
    icon: { kind: 'builtin', value: 'lab' },
    visible: true,
    disabled: true,
    theme: pageTheme,
    columns: 1,
    entries: [{ id: 'g2', order: 1, theme: entryTheme }],
  }
}

/** 完整示例项目：17.2 主示例 + 三条补充片段。 */
export function createExampleProject(): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: SCHEMA_VERSION,
    engineVersion: '1.0.0',
    meta: {
      name: '示例：矿石工厂',
      author: 'IncrementForge',
      description: '最小可玩示例',
      createdAt: NOW,
      modifiedAt: NOW,
    },
    settings: {
      numberFormat: 'standard',
      tickRate: 20,
      maxFrameStep: 250,
      autosaveInterval: 30,
      offlineEnabled: true,
      offlineCap: 8,
    },
    resources: [exampleResource()],
    generators: [exampleGenerator(), exampleClicker()],
    upgrades: [exampleUpgrade()],
    pages: [examplePage(), exampleDisabledPage()],
    assets: {},
  }
}

/**
 * 去掉补充片段的“纯主示例”（17.2 代码块本体）。
 *
 * 用途：需要精确对照 17.2 逐字段断言（价格文本、效果文本、`creates` 等）的用例用它，
 * 避免把片段 ①③ 的存在误当成主示例的一部分。
 */
export function createMinimalExampleProject(): ProjectFile {
  const project = createExampleProject()
  project.generators = [exampleGenerator()]
  project.pages = [examplePage()]
  return project
}

export { NO_LIMIT }
