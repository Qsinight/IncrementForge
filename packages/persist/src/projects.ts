/**
 * 项目仓储（TECH_DESIGN 7.9「保存」、10.1、10.2「导出项目」）。
 *
 * 保存流程严格是 7.9 规定的顺序：**Zod 校验 → 跨条目一致性校验 → 事务写**，
 * 并在同一事务里更新 `modifiedAt` 与 `engineVersion`（PRD 设置页 5 的“引擎版本”
 * 正是“项目文件最后修改时记录的编辑器版本”）。
 *
 * 校验失败**不写库**：6.4 要求 `E_DUPLICATE_PAGE_ENTRY` / `E_DANGLING_REF` /
 * `E_ID_INVALID` 阻断保存，把问题清单抛给编辑器定位到具体字段。
 */
import { ENGINE_VERSION, migrateProject, projectFileSchema } from '@iforge/model'
import type { ProjectFile, ValidationIssue } from '@iforge/model'

import { INDEX, STORE, openForgeDb, storeOf, withTransaction } from './db.js'
import { issueFromError, issuesFromZod } from './validation.js'

/**
 * `projects` 仓库的记录形状。
 *
 * `projectId` 与 `modifiedAt`/`name` 是**冗余**字段：
 * - `projectId` 是主键，而它不在 `ProjectFile` 内部（7.9：它只在项目文件之外作主键）；
 * - `modifiedAt`/`name` 供 `by-modifiedAt` 索引与列表展示，避免为了排序把整个项目读出来。
 */
export interface ProjectRecord {
  projectId: string
  project: ProjectFile
  modifiedAt: string
  name: string
}

/** 保存被校验阻断时抛出的错误，附带可定位到字段的问题清单。 */
export class ValidationBlockedError extends Error {
  readonly issues: readonly ValidationIssue[]
  constructor(issues: readonly ValidationIssue[]) {
    super(`项目校验未通过，共 ${issues.length} 处问题`)
    this.name = 'ValidationBlockedError'
    this.issues = issues
  }
}

/** `projects` 仓库（V1.0 单项目，但键按 `projectId` 组织以预留多项目，15）。 */
export class ProjectRepository {
  constructor(private readonly db: IDBDatabase) {}

  /**
   * 保存项目（7.9）。
   *
   * @param projectId 主键；`projectStore` 持有（7.9 用 `crypto.randomUUID()` 生成）
   * @param project 项目文件；保存前会整体过一遍 Schema 与一致性校验
   * @param now ISO8601 时间戳（注入以便测试）
   * @param engineVersion 写入 `engineVersion`（PRD 设置页 5；默认当前引擎版本）
   * @throws {ValidationBlockedError} 校验未通过（**不写库**）
   */
  async save(projectId: string, project: ProjectFile, options: { now?: string; engineVersion?: string } = {}): Promise<ProjectFile> {
    const now = options.now ?? new Date().toISOString()
    // 6.4 的“写入前校验”：迁移 → Zod Schema（其 `superRefine` 内含 6.4 的五类一致性校验）。
    // 走 `safeParse` 而不是 `parseProjectFile`，是为了拿到**结构化**的 issue 列表（见 validation.ts）。
    const parsed = validateOrThrow(project)
    const next: ProjectFile = {
      ...parsed,
      engineVersion: options.engineVersion ?? ENGINE_VERSION,
      meta: { ...parsed.meta, modifiedAt: now },
    }
    await withTransaction(this.db, STORE.projects, 'readwrite', (tx) =>
      storeOf(tx, STORE.projects).put({
        projectId,
        project: next,
        modifiedAt: next.meta.modifiedAt,
        name: next.meta.name,
      } satisfies ProjectRecord),
    )
    return next
  }

  /** 读项目；不存在返回 `undefined`（V1.0 首次启动的正常分支）。 */
  async get(projectId: string): Promise<ProjectFile | undefined> {
    const record = await withTransaction<ProjectRecord | undefined>(this.db, STORE.projects, 'readonly', (tx) =>
      storeOf(tx, STORE.projects).get(projectId),
    )
    return record?.project
  }

  /** 列出全部项目（按 `by-modifiedAt` 倒序，10.1 表的索引用途）。 */
  async list(): Promise<ProjectRecord[]> {
    // 索引取值在事务内同步发起，排序在事务外做（排序是纯计算，没必要占着事务）。
    const records =
      (await withTransaction<ProjectRecord[]>(
        this.db,
        STORE.projects,
        'readonly',
        (tx) => storeOf(tx, STORE.projects).index(INDEX.modifiedAt).getAll() as IDBRequest<ProjectRecord[]>,
      )) ?? []
    return [...records].sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0))
  }

  /** 删除项目及其存档（10.1：存档键含 `projectId`，删项目必须一并删，否则存档成孤儿）。 */
  async remove(projectId: string): Promise<void> {
    await withTransaction(this.db, [STORE.projects, STORE.saves], 'readwrite', (tx) => {
      storeOf(tx, STORE.projects).delete(projectId)
      const saves = storeOf(tx, STORE.saves)
      const request = saves.index(INDEX.projectId).openCursor(IDBKeyRange.only(projectId))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        cursor.delete()
        cursor.continue()
      }
    })
  }

  /** 项目数量（单项目管理下应为 0 或 1；> 1 说明被外部写脏了，编辑器据此提示）。 */
  async count(): Promise<number> {
    const total = await withTransaction<number>(this.db, STORE.projects, 'readonly', (tx) => storeOf(tx, STORE.projects).count())
    return total ?? 0
  }
}

/** 把校验异常转成 `ValidationIssue[]`（`parseProjectFile` 抛的 `ForgeError` 带 `where`）。 */
function issuesOf(error: unknown): ValidationIssue[] {
  if (error instanceof ValidationBlockedError) return [...error.issues]
  return [issueFromError(error)]
}

/**
 * 校验并返回规范化后的项目文件；不通过则抛 `ValidationBlockedError`（**不写库**）。
 *
 * 迁移与 Schema 各占一段：`migrateProject` 抛的是版本类错误（`E_VERSION`/`E_MIGRATION_FAIL`，
 * 6.4 的“兼容模式”入口），Schema 抛的是结构/一致性问题（6.4 的定位路径）。
 */
export function validateOrThrow(input: unknown): ProjectFile {
  let migrated: unknown
  try {
    migrated = migrateProject(input)
  } catch (error) {
    throw new ValidationBlockedError(issuesOf(error))
  }
  const result = projectFileSchema.safeParse(migrated)
  if (!result.success) throw new ValidationBlockedError(issuesFromZod(result.error.issues))
  return result.data as ProjectFile
}

/** 便捷入口：用指定（默认）库名打开并返回 `projects` 仓储。 */
export async function openProjectRepository(name?: string): Promise<ProjectRepository> {
  return new ProjectRepository(await openForgeDb(name))
}
