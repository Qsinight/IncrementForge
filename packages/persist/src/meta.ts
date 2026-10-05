/**
 * `meta` 仓库：编辑器偏好与当前项目指针（TECH_DESIGN 10.1 表的 `meta` 行、7.2 `settingsStore`）。
 *
 * ## 为什么编辑器偏好不进项目文件
 *
 * PRD 设置页 1（编辑器主题）明确它属于编辑器而非项目；D-22 进一步把
 * “游戏内设置”也划成会话覆盖而不回写项目文件。因此这里存的是**编辑器侧**的
 * 键值对：主题、面板宽度、当前 `projectId`、上次打开时间等。
 *
 * 键名带前缀（`editor.*`）以避免与未来的其它 meta 用途相撞。
 */
import { STORE, storeOf, withTransaction } from './db.js'

/** `meta` 仓库。 */
export class MetaRepository {
  constructor(private readonly db: IDBDatabase) {}

  async get<T>(key: string): Promise<T | undefined> {
    return withTransaction<T | undefined>(this.db, STORE.meta, 'readonly', (tx) => storeOf(tx, STORE.meta).get(key) as IDBRequest<T | undefined>)
  }

  async set<T>(key: string, value: T): Promise<void> {
    await withTransaction(this.db, STORE.meta, 'readwrite', (tx) => storeOf(tx, STORE.meta).put(value, key))
  }

  async delete(key: string): Promise<void> {
    await withTransaction(this.db, STORE.meta, 'readwrite', (tx) => storeOf(tx, STORE.meta).delete(key))
  }

  /**
   * 读全部偏好（键前缀过滤，缺省读 `editor.`）。
   *
   * 用游标而不是 `getAllKeys()` + `getAll()`：游标在**同一个事务**里顺序取值，
   * 不需要把两个请求的结果按索引对齐（键顺序在规范里有保证，但少一层耦合更好）。
   */
  async all<T>(prefix = 'editor.'): Promise<Record<string, T>> {
    const out: Record<string, T> = {}
    await withTransaction(this.db, STORE.meta, 'readonly', (tx) => {
      const request = storeOf(tx, STORE.meta).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        if (String(cursor.key).startsWith(prefix)) out[String(cursor.key)] = cursor.value as T
        cursor.continue()
      }
      return undefined
    })
    return out
  }
}

/** 编辑器偏好的键（7.2 `settingsStore` + 7.1 面板宽度）。 */
export const META_KEYS = {
  theme: 'editor.theme',
  paneWidth: 'editor.previewPaneWidth',
  paneCollapsed: 'editor.previewPaneCollapsed',
  currentProjectId: 'editor.currentProjectId',
  lastOpenedAt: 'editor.lastOpenedAt',
} as const
