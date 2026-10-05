/**
 * 删除条目的影响面分析（TECH_DESIGN 7.5「删除时的引用处理」表、D-38）。
 *
 * | 被删对象被谁引用 | 本模块给出的信息 |
 * | --- | --- |
 * | `costs[i].materialId` | 条目名 + 行号 |
 * | `produces[i].materialId` | 条目名 + 行号 |
 * | 页面 `entries[]` | 所属页面名（确认后从该页面移除） |
 * | `create()` 的 `page` 参数 | 页面名 + 表达式所在条目（诊断用） |
 * | 动态条目 | **不受影响**（只能 `destroy(id)`，8.7） |
 *
 * 只做**分析**，不做级联删除（6.4「引用完整性」在保存时兜底）。
 */
import type { EntryKind, ProjectFile } from '@iforge/model'

/** 一条引用记录。 */
export interface ReferenceHit {
  /** 引用方条目名。 */
  source: string
  sourceId: string
  /** 定位片段，如 `购买价格[0]`。 */
  where: string
  kind: EntryKind
}

/** 删除影响面。 */
export interface DeletionImpact {
  /** 悬空引用（确认后由 `E_DANGLING_REF` 阻断保存，7.5 表）。 */
  dangling: ReferenceHit[]
  /** 条目当前所属页面。 */
  page: { id: string; name: string } | null
  /** 页面被删时的额外提醒（`create()` 的 `page` 参数会悬空）。 */
  createPageRefs: ReferenceHit[]
}

/**
 * 列出删除 `id` 的影响面。
 *
 * @param kind 被删条目的类型；资源不会成为页面条目之外的目标，但可能出现在产出列表里
 *   （PRD 生成器编辑器 10 允许产出到资源），因此四种引用都要扫。
 */
export function analyzeDeletion(project: ProjectFile, kind: EntryKind, id: string): DeletionImpact {
  const dangling: ReferenceHit[] = []
  const scan = (
    list: readonly { id: string; name: string }[],
    rows: readonly { materialId: string }[],
    field: 'costs' | 'produces',
    selfKind: EntryKind,
  ): void => {
    list.forEach((item) => {
      rows.forEach((row, index) => {
        if (row.materialId !== id) return
        dangling.push({
          source: item.name,
          sourceId: item.id,
          where: `${field === 'costs' ? '购买价格' : '产出资源'}[${index}]`,
          kind: selfKind,
        })
      })
    })
  }

  if (kind === 'resource') {
    scan(
      project.generators,
      project.generators.flatMap((g) => g.costs),
      'costs',
      'generator',
    )
    scan(
      project.generators,
      project.generators.flatMap((g) => g.produces),
      'produces',
      'generator',
    )
    scan(
      project.upgrades,
      project.upgrades.flatMap((u) => u.costs),
      'costs',
      'upgrade',
    )
  } else if (kind === 'generator') {
    scan(
      project.generators,
      project.generators.flatMap((g) => g.produces),
      'produces',
      'generator',
    )
  }

  const page = project.pages.find((item) => item.entries.some((entry) => entry.id === id)) ?? null

  // 页面被删：表达式里的 `create(..., { page: "<id>" })` 会悬空（7.5 表第 4 行）。
  const createPageRefs: ReferenceHit[] = []
  if (kind === 'page') {
    const needle = `page: "${id}"`
    for (const upgrade of project.upgrades) {
      upgrade.effects.forEach((effect, index) => {
        if (effect.action.includes(needle) || effect.action.includes(`page:"${id}"`)) {
          createPageRefs.push({ source: upgrade.name, sourceId: upgrade.id, where: `升级效果[${index}]`, kind: 'upgrade' })
        }
      })
    }
  }

  return { dangling, page: page ? { id: page.id, name: page.name } : null, createPageRefs }
}

/** 条目在项目中的唯一定位（删除确认弹窗用，6.4「定位路径」风格）。 */
export function locateEntry(project: ProjectFile, kind: EntryKind, id: string): string | undefined {
  const lists: Record<EntryKind, Array<{ id: string }>> = {
    resource: project.resources,
    generator: project.generators,
    upgrade: project.upgrades,
    page: project.pages,
  }
  const index = lists[kind].findIndex((item) => item.id === id)
  return index < 0 ? undefined : `${LIST_NAME[kind]}[${index}]`
}

const LIST_NAME: Record<EntryKind, string> = {
  resource: 'resources',
  generator: 'generators',
  upgrade: 'upgrades',
  page: 'pages',
}
