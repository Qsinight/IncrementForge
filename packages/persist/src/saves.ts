/**
 * 存档仓储（TECH_DESIGN 10.1 表的 `saves` 行、10.3 存档时机、6.3）。
 *
 * V1.0 固定 `slotId = 'main'`（PRD 补充 8 单存档），但键 `${projectId}:${slotId}`
 * 与存档文件里的 `slotId` 字段**先落地**（6.3）——多存档只需放开枚举与选择 UI，
 * 序列化格式不用改（15 表「多存档」）。
 *
 * **游戏内设置不进存档**（6.3 末条、D-22）：本仓储只存 `SaveFile`，
 * 不掺入 UI 偏好；`meta` 仓库负责后者。
 */
import { saveFileSchema } from '@iforge/model'
import type { SaveFile } from '@iforge/model'

import { INDEX, STORE, storeOf, withTransaction } from './db.js'

/** `saves` 仓库记录：复合主键 + `by-projectId` 索引。 */
export interface SaveRow {
  saveId: string
  projectId: string
  save: SaveFile
}

/** 复合键：`${projectId}:${slotId}`（10.1 表的 Key 列）。 */
export function saveKey(projectId: string, slotId: string): string {
  return `${projectId}:${slotId}`
}

/** `saves` 仓库。 */
export class SaveRepository {
  constructor(private readonly db: IDBDatabase) {}

  /**
   * 写存档（10.3 的自动存档/手动导出/离线结算前都是这条路径）。
   *
   * 写入前按 `saveFileSchema` 校验（11.1 第 6 条的精神：先校验再落盘，
   * 防止手改存档在后续读档时把运行时打崩）。
   */
  async put(save: SaveFile): Promise<SaveFile> {
    const parsed = saveFileSchema.parse(save) as SaveFile
    const row: SaveRow = { saveId: saveKey(parsed.projectId, parsed.slotId), projectId: parsed.projectId, save: parsed }
    await withTransaction(this.db, STORE.saves, 'readwrite', (tx) => storeOf(tx, STORE.saves).put(row))
    return parsed
  }

  /** 读存档；不存在返回 `undefined`。 */
  async get(projectId: string, slotId = 'main'): Promise<SaveFile | undefined> {
    const row = await withTransaction<SaveRow | undefined>(this.db, STORE.saves, 'readonly', (tx) =>
      storeOf(tx, STORE.saves).get(saveKey(projectId, slotId)),
    )
    return row?.save
  }

  /** 列出某项目的全部存档（V1.0 恒 ≤ 1 条；多存档框架的入口）。 */
  async listByProject(projectId: string): Promise<SaveFile[]> {
    const rows = await withTransaction<SaveRow[]>(
      this.db,
      STORE.saves,
      'readonly',
      (tx) => storeOf(tx, STORE.saves).index(INDEX.projectId).getAll(projectId) as IDBRequest<SaveRow[]>,
    )
    return (rows ?? []).map((row) => row.save)
  }

  async remove(projectId: string, slotId = 'main'): Promise<void> {
    await withTransaction(this.db, STORE.saves, 'readwrite', (tx) => storeOf(tx, STORE.saves).delete(saveKey(projectId, slotId)))
  }
}
