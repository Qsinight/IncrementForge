/**
 * `@iforge/model` —— 数据模型（TECH_DESIGN 6）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime`。本包只依赖 `@iforge/num` 与 `@iforge/expr`，
 * **不依赖 `runtime`**，也不导入任何 DOM API。
 *
 * 职责：
 * - `id.ts` —— 条目 id 的命名约束与分配（D-45、8.7 动态 id 规则，**单一事实源**）
 * - `schema.ts` —— 项目文件 / 存档文件的 Zod Schema（6.2、6.3）
 * - `defaults.ts` —— 默认工厂与新建项目模板（7.9、8.7「缺省」行）
 * - `example.ts` —— 17.2 的示例项目（单测 / E2E / 新建项目模板的**唯一夹具**）
 * - `order.ts` —— 排序工具（7.5、D-40）
 * - `coverage.ts` —— 5.9 权限矩阵 ↔ 6.3 存档 Schema 的自检（14.3 规则 1、R-33）
 * - `docgen.ts` —— 把字段白名单回写成文档的生成块（14.3 末段的 `docs:gen`）
 * - `validate.ts` —— 跨条目一致性校验、表达式静态校验、迁移器（6.4、11.1）
 *
 * 与运行时的边界：`runtime` 通过本包的 Schema 与默认工厂读写数据，
 * **编辑器只通过本包的 Schema 读写数据**（3.2「禁止直接操作裸对象字面量」）。
 */
export * from './id.js'
export * from './schema.js'
export * from './defaults.js'
export * from './example.js'
export * from './order.js'
export * from './coverage.js'
export * from './docgen.js'
export * from './validate.js'
