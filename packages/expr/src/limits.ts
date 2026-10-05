/**
 * 表达式资源上限（TECH_DESIGN 5.6 末条、13 安全与沙箱第 1/2 条）。
 *
 * 全部在**编译期**判定，超限抛错不进入运行期（5.6：“不进入运行期”）。
 * 这些常量是 14.3 `docs:check` 规则 1 的对照点之一：文档里出现的数字必须与此一致。
 */

/** 单条表达式文本长度上限（字符）。 */
export const MAX_TEXT_LENGTH = 2000

/** 表达式总嵌套深度上限。 */
export const MAX_DEPTH = 64

/** 对象/数组字面量自身嵌套上限（同时计入 `MAX_DEPTH`）。 */
export const MAX_LITERAL_DEPTH = 4

/** 单个数组字面量的最大元素个数。 */
export const MAX_LITERAL_ITEMS = 64

/** 编译缓存条目上限（5.6 编译缓存）。 */
export const COMPILE_CACHE_LIMIT = 8192

/** 单 tick 内表达式求值次数上限（5.7 配额，超出报 `E_BUDGET`）。 */
export const EVAL_BUDGET_PER_TICK = 20000

/**
 * 词法黑名单（13 第 1 条、5.6 禁止项）。
 *
 * `__proto__`/`constructor`/`prototype` 在**词法层**直接拒绝，而不是等求值时才发现——
 * 语言的作用域对象是 `Object.create(null)` 构造的，本来就没有原型链，但把这条路堵死在
 * 词法层可以让恶意表达式连 AST 都构造不出来。
 */
export const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set([
  ';',
  '=>',
  'import',
  'await',
  '__proto__',
  'constructor',
  'prototype',
  // 反引号不是字符串定界符（5.2：只用双引号），出现即视为非法语法。
  '`',
])

/** 词法黑名单命中的错误码（17.1 `E_FORBIDDEN_TOKEN`）。 */
export const FORBIDDEN_TOKEN_CODE = 'E_FORBIDDEN_TOKEN' as const
