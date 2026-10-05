/**
 * 词法分析（TECH_DESIGN 5.2 语法、13 安全与沙箱第 1 条）。
 *
 * 产出扁平的 token 流，保留 `start`/`end` 列区间——5.8 的“错误定位到列区间、红色下划线”
 * 直接依赖这个区间，不做二次定位。
 *
 * 数字字面量的分层指数（`1e1e10`）由本文件手写状态机解析，不能用 `Number()`：
 * `Number('1e1e10')` 得到 `NaN`。解析结果保留原始文本，交由 `@iforge/num` 的
 * `Decimal.fromString` 构造（4.2 支持分层表示）。
 */
import { ForgeError } from '@iforge/num'

import { FORBIDDEN_TOKENS, MAX_TEXT_LENGTH } from './limits.js'

export type TokenType = 'number' | 'string' | 'ident' | 'op' | 'eof'

export interface Token {
  type: TokenType
  /** token 文本（数字为原始字面量文本，标识符为名字，运算符为符号）。 */
  value: string
  /** 源码起始列（0 基，闭区间）。 */
  start: number
  /** 源码结束列（0 基，开区间）。 */
  end: number
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'
const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch)
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch)

/**
 * 多字符运算符，按长度降序匹配，保证 `>=` 不被拆成 `>` + `=`、`===` 不被拆成 `==` + `=`。
 */
const OPERATORS = [
  '===',
  '!==',
  '**',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '=',
  '<',
  '>',
  '!',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '.',
]

/**
 * 扫描一个数字字面量，返回结束位置。
 *
 * 语法（5.2）：`123`、`1.5`、`1e10`、`1e1e10`、`-2.5e-3`（负号由 unary 处理）。
 * 指数部分可再跟一组 `e<数字>`，这就是分层指数的来源；`Infinity` 是独立标识符
 * （由 `primary` 规则识别为哨兵字面量，D-46），不在这里处理。
 */
function scanNumber(text: string, start: number): number {
  let i = start
  // 整数或小数部分
  while (i < text.length && isDigit(text[i]!)) i += 1
  if (text[i] === '.') {
    i += 1
    while (i < text.length && isDigit(text[i]!)) i += 1
  }
  // 指数部分可继续跟 `e<数字>`，这就是**分层指数**的来源（4.2 的 L1/L2/L3+）。
  // 层数不设上限：`NUM_MAX_LAYER` 是数值层的饱和边界（4.4），而字面量的层数由文本长度
  // 与整体深度上限（`MAX_TEXT_LENGTH` / `MAX_DEPTH`）约束，超过时由 break_eternity 归一化。
  for (;;) {
    if (i >= text.length || (text[i] !== 'e' && text[i] !== 'E')) break
    const afterE = i + 1
    let j = afterE
    if (text[j] === '+' || text[j] === '-') j += 1
    if (j >= text.length || !isDigit(text[j]!)) break
    while (j < text.length && isDigit(text[j]!)) j += 1
    i = j
  }
  return i
}

/** 扫描字符串字面量：只用双引号，支持 `\"`、`\\`、`\n`（5.2）。 */
function scanString(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') return i + 1
    i += 1
  }
  return -1 // 未闭合
}

/**
 * 把源码切成 token 流。
 *
 * @throws {ForgeError} `E_FORBIDDEN_TOKEN` 命中黑名单；`E_PARSE` 非法字符/未闭合字符串；
 *   `E_PARSE_DEPTH`（长度上限以 `E_PARSE_DEPTH` 之外单独用 `E_BUDGET` 表达，见下）。
 */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_TEXT_LENGTH) {
    throw new ForgeError('E_BUDGET', {
      message: `表达式长度 ${source.length} 超过上限 ${MAX_TEXT_LENGTH}`,
      span: { start: MAX_TEXT_LENGTH, end: source.length },
    })
  }

  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]!

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }

    // 单引号不是字符串定界符（5.2：只用双引号）——直接按非法字符报错，避免被当成标识符起始。
    if (ch === "'") {
      throw new ForgeError('E_PARSE', {
        message: '字符串只用双引号，单引号不是字符串定界符',
        span: { start: i, end: i + 1 },
      })
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const end = scanNumber(source, i)
      tokens.push({ type: 'number', value: source.slice(i, end), start: i, end })
      i = end
      continue
    }

    if (ch === '"') {
      const end = scanString(source, i)
      if (end < 0) {
        throw new ForgeError('E_PARSE', { message: '字符串字面量未闭合', span: { start: i, end: source.length } })
      }
      tokens.push({ type: 'string', value: source.slice(i + 1, end - 1), start: i, end })
      i = end
      continue
    }

    if (isIdentStart(ch)) {
      let end = i
      while (end < source.length && isIdentPart(source[end]!)) end += 1
      const value = source.slice(i, end)
      if (FORBIDDEN_TOKENS.has(value)) {
        throw new ForgeError('E_FORBIDDEN_TOKEN', { message: `不允许的标识符 ${value}`, span: { start: i, end } })
      }
      tokens.push({ type: 'ident', value, start: i, end })
      i = end
      continue
    }

    // 黑名单里既有标识符（`import`/`__proto__` 等，由上面的 ident 分支处理），
    // 也有 `;`、`=>`、`` ` `` 这类**不是运算符**的字符——它们不会命中 OPERATORS，
    // 必须在这里按前缀单独判定，否则会退化成“无法识别的字符”的 E_PARSE，
    // 错误码与 13 第 1 条 / 17.1 的约定不一致。
    const forbidden = forbiddenTokenAt(source, i)
    if (forbidden) {
      throw new ForgeError('E_FORBIDDEN_TOKEN', {
        message: `不允许的语法 ${JSON.stringify(forbidden)}`,
        span: { start: i, end: i + forbidden.length },
      })
    }

    // 运算符：先按多字符匹配，再退化到单字符。
    const operator = OPERATORS.find((op) => source.startsWith(op, i))
    if (operator) {
      tokens.push({ type: 'op', value: operator, start: i, end: i + operator.length })
      i += operator.length
      continue
    }

    throw new ForgeError('E_PARSE', { message: `无法识别的字符 ${JSON.stringify(ch)}`, span: { start: i, end: i + 1 } })
  }

  tokens.push({ type: 'eof', value: '', start: source.length, end: source.length })
  return tokens
}

/** 标识符是否能作为路径的一环（`path = ("res"|"gen"|"up"|"page") "." id "." attr`，5.2）。 */
export function isIdentifierName(value: string): boolean {
  return value.length > 0 && isIdentStart(value[0]!) && [...value].every(isIdentPart)
}

/**
 * 找出位置 `i` 处的**非标识符**黑名单 token（`;`、`=>`、`` ` ``）。
 *
 * 标识符类黑名单（`import`、`__proto__` 等）由 `tokenize` 的 ident 分支单独处理；
 * 这里只处理不能被 `isIdentStart` 起始的那几个，否则 `=>` 会被拆成 `>` + `=`
 * 并以“无法识别的字符”报 `E_PARSE`，掩盖 13 第 1 条的真实意图。
 */
function forbiddenTokenAt(text: string, index: number): string | undefined {
  let best: string | undefined
  for (const token of FORBIDDEN_TOKENS) {
    if (isIdentStart(token[0]!)) continue
    if (!text.startsWith(token, index)) continue
    if (best === undefined || token.length > best.length) best = token
  }
  return best
}
