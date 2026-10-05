/**
 * `@iforge/persist` —— IndexedDB 仓储与导入导出（TECH_DESIGN 10、10.2）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime ← (persist | build)`。
 * 本包允许导入 DOM API（IndexedDB、File、Blob）——3.2 明确 `persist` 是例外。
 *
 * ## 模块地图
 *
 * | 模块 | 职责 | 文档 |
 * | --- | --- | --- |
 * | `db` | 库/仓库/索引与事务包装 | 10.1 |
 * | `projects` | 项目保存（校验 → 事务写 → 更新时间戳/引擎版本） | 7.9、10.1 |
 * | `assets` | 上传资产落库、`kind:'asset'` 解析、保存规范化 | 10.1、13 第 4/5 条、D-12 |
 * | `saves` | 存档读写（复合键 `${projectId}:${slotId}`） | 10.1 表、10.3、PRD 补充 8 |
 * | `meta` | 编辑器偏好与当前项目指针 | 10.1 表、7.2、D-22 |
 * | `project-io` | 项目文件 <-> 文本（与打包同一条路径） | 10.2、11.1、13 第 6 条 |
 *
 * ## 一条贯穿全包的约定
 *
 * **运行时赋值不参与保存**（PRD 补充 6、R-08）：本包只写 `ProjectFile`，
 * 存档侧的 `assignments`/`effectValues`/`dynamic` 由 `runtime` 的 `save.ts` 序列化，
 * 两者绝不合并（8.4 的“影子运行时”也不在这里落盘）。
 */
export * from './db.js'
export * from './validation.js'
export * from './projects.js'
export * from './assets.js'
export * from './saves.js'
export * from './meta.js'
export * from './project-io.js'
