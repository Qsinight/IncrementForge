/**
 * IndexedDB 连接与对象仓库（TECH_DESIGN 10.1）。
 *
 * | Object Store | Key | Value | 索引 |
 * | --- | --- | --- | --- |
 * | `projects` | `projectId` | `ProjectFile` | `by-modifiedAt` |
 * | `assets`  | `assetId`   | `{ mime, data, name, kind }` | — |
 * | `saves`   | `${projectId}:${slotId}` | `SaveFile` | `by-projectId` |
 * | `meta`    | `key` | 编辑器偏好、当前项目指针 | — |
 *
 * ## 单项目约束（D-33、15）
 *
 * V1.0 只有一个项目，但键仍按 `projectId` 组织（10.1 已如此设计）：
 * 多项目管理落地时只需放开 UI，`projects`/`saves` 的键结构无需迁移
 * （15 表「多项目管理」的预留接口 `ProjectRegistry`）。
 *
 * ## 为什么所有 API 都是 Promise 且自行 reject
 *
 * IndexedDB 的 `IDBRequest` 是事件驱动的，包一层 Promise 让调用方（编辑器 store）
 * 用 `try/await` 表达事务边界。错误**不吞**：7.9 的保存流程要求
 * “校验失败必须让用户看到原因”，吞掉错误等于把校验结果变成静默失败。
 */

/** 数据库名（10.1）。 */
export const DB_NAME = 'incrementforge'

/** 数据库版本（10.1「版本 1」）。 */
export const DB_VERSION = 1

/** 四个对象仓库名。 */
export const STORE = {
  projects: 'projects',
  assets: 'assets',
  saves: 'saves',
  meta: 'meta',
} as const

export type StoreName = (typeof STORE)[keyof typeof STORE]

/** 索引名（10.1 表的“索引”列）。 */
export const INDEX = {
  modifiedAt: 'by-modifiedAt',
  projectId: 'by-projectId',
} as const

/**
 * 打开（或创建）数据库。
 *
 * @param name 库名；默认 `incrementforge`。参数存在是为了**测试隔离**——
 * 多个用例各开一个库，避免相互污染（生产代码不传）。
 */
export function openForgeDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE.projects)) {
        const projects = db.createObjectStore(STORE.projects, { keyPath: 'projectId' })
        projects.createIndex(INDEX.modifiedAt, 'modifiedAt')
      }
      if (!db.objectStoreNames.contains(STORE.assets)) {
        db.createObjectStore(STORE.assets, { keyPath: 'assetId' })
      }
      if (!db.objectStoreNames.contains(STORE.saves)) {
        // keyPath = `saveId`（复合键 `${projectId}:${slotId}`，10.1 表的 Key 列）：
        // 用 keyPath 而不是外置键，存档记录本身就能自描述（导出的调试日志更易读）。
        const saves = db.createObjectStore(STORE.saves, { keyPath: 'saveId' })
        saves.createIndex(INDEX.projectId, 'projectId')
      }
      if (!db.objectStoreNames.contains(STORE.meta)) {
        db.createObjectStore(STORE.meta)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
    request.onblocked = () => reject(new Error('IndexedDB 升级被其它标签页阻塞'))
  })
}

/** 删库（测试隔离与“重建数据库”用）。 */
export function deleteForgeDb(name: string = DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('删除 IndexedDB 失败'))
  })
}

/** 把 `IDBRequest` 包成 Promise。 */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

/**
 * 在一个事务里执行回调，返回事务的 `complete` 时点。
 *
 * 用它而不是“逐个 await 请求”的原因：IndexedDB 事务会在**微任务边界**自动提交，
 * 中间 await 会让事务提前结束（典型症状：`TransactionInactiveError`）。
 * 回调必须**同步地**发起所有请求，`await` 只放在外层。
 */
/**
 * 在一个事务里执行回调，返回事务的 `complete` 时点。
 *
 * 用它而不是“逐个 await 请求”的原因：IndexedDB 事务会在**微任务边界**自动提交，
 * 中间 await 会让事务提前结束（典型症状：`TransactionInactiveError`）。
 * 因此回调必须**同步发起**所有请求并返回其中一个（或 `void`），
 * `await` 只放在外层；返回 Promise 会被显式拒绝（那等于在事务里偷偷 await）。
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const tx = db.transaction(stores, mode)
  // **先挂 oncomplete，再 await 请求**：事务在最后一个请求的微任务之后就提交，
  // 若先 await 请求结果再挂监听器，会错过 complete 事件并永久挂起（测试里表现为超时）。
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'))
  })
  const result = body(tx)
  if (result instanceof Promise) {
    tx.abort()
    throw new Error('withTransaction 的回调不能返回 Promise：事务会在 await 期间自动提交（见函数注释）')
  }
  const value = result ? await requestToPromise(result) : undefined
  await completed
  return value
}

/** 取单仓库的读写句柄（供 `withTransaction` 的回调使用）。 */
export function storeOf(tx: IDBTransaction, name: StoreName): IDBObjectStore {
  return tx.objectStore(name)
}
