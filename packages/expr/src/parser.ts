/**
 * Pratt 解析器（TECH_DESIGN 5.2 语法、ADR-02）。
 *
 * 选择 Pratt（前缀/中缀优先级表）而非递归下降的原因：5.2 的产生式里 `power` 右结合、
 * `postfix` 可链式下标，用优先级表表达比手写递归层次更短，且能直接把优先级数值化，
 * 便于对每层嵌套计深度（5.6 的 64 层上限）。
 *
 * 关键约束（不是通用 JS 表达式子集，而是本引擎的受限方言）：
 * - **无语句、无 `;`、无三元、无函数声明**；整个程序是且仅是一个 `assignment`；
 * - **对象/数组字面量只允许出现在 `create()` 的 `spec` 实参内**（5.2 约束表，
 *   其它位置一律 `E_LITERAL_NOT_ALLOWED`）——在 `primary` 里通过
 *   `literalAllowed` 标志传递该权限，而不是解析完再删节点，避免“解析成功但语义非法”；
 * - `set()` 的路径实参在编译期必须是字面量（D-27）。
 */
import { ForgeError } from '@iforge/num'

import type { AssignNode, AssignOp, BinaryNode, BinaryOp, ConstantObject, ConstantValue, Node, PathPrefix } from './ast.js'
import type { Token } from './lexer.js'
import { tokenize } from './lexer.js'
import { MAX_DEPTH, MAX_LITERAL_DEPTH, MAX_LITERAL_ITEMS } from './limits.js'
import { normalizePropertyKey } from './properties.js'

/** 路径前缀白名单（5.2 `path` 规则）。 */
const PATH_PREFIXES: ReadonlySet<string> = new Set(['res', 'gen', 'up', 'page'])

/** 二元运算符的结合力（数值越大越紧）。 */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '===': 3,
  '!==': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '^': 7,
}

const ASSIGN_OPS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/='])

/** 右结合的运算符：连续出现时向右绑定（5.2 `power = unary [ ("^"|"**") power ]`）。 */
const RIGHT_ASSOCIATIVE: ReadonlySet<string> = new Set(['^', '**'])

/** 深度守卫。超过 `MAX_DEPTH` 抛 `E_PARSE_DEPTH`，防止 `((((…))))` 耗尽调用栈。 */
class DepthGuard {
  private depth = 0

  enter(): void {
    this.depth += 1
    if (this.depth > MAX_DEPTH) {
      throw new ForgeError('E_PARSE_DEPTH', { message: `嵌套深度超过 ${MAX_DEPTH}` })
    }
  }

  exit(): void {
    this.depth -= 1
  }
}

class Parser {
  private index = 0
  private readonly depth = new DepthGuard()
  /** 字面量许可：只有 `create()` 的 spec 实参内为真（5.2 约束表第一行）。 */
  private literalAllowed = false
  /** 字面量自身嵌套深度（上限 `MAX_LITERAL_DEPTH`，与总深度 `MAX_DEPTH` 并行计数）。 */
  private literalDepth = 0

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!
  }

  private next(): Token {
    const token = this.peek()
    if (token.type !== 'eof') this.index += 1
    return token
  }

  private matchOp(...ops: string[]): Token | undefined {
    const token = this.peek()
    if (token.type === 'op' && ops.includes(token.value)) {
      this.index += 1
      return token
    }
    return undefined
  }

  private expectOp(op: string): Token {
    const token = this.peek()
    if (token.type !== 'op' || token.value !== op) {
      throw new ForgeError('E_PARSE', { message: `期望 ${op}，实际是 ${token.value || '表达式结尾'}`, span: token })
    }
    return this.next()
  }

  /** 入口：`program = assignment`。 */
  parseProgram(): Node {
    const node = this.parseAssignment()
    const token = this.peek()
    if (token.type !== 'eof') {
      // 语言无语句，多余 token 说明作者写了两条表达式（例如漏了 `&&`）。
      throw new ForgeError('E_PARSE', {
        message: '语言无语句，表达式后不允许出现多余内容（是否漏写运算符？）',
        span: token,
      })
    }
    return node
  }

  /** `assignment = or [ ("=" | "+=" | "-=" | "*=" | "/=") assignment ]`（右结合）。 */
  private parseAssignment(): Node {
    const left = this.parseBinary(1)
    const token = this.peek()
    if (token.type === 'op' && ASSIGN_OPS.has(token.value)) {
      this.next()
      this.depth.enter()
      try {
        const value = this.parseAssignment()
        const node: AssignNode = {
          kind: 'assign',
          op: token.value as AssignOp,
          target: left,
          value,
          span: { start: left.span.start, end: value.span.end },
        }
        return node
      } finally {
        this.depth.exit()
      }
    }
    return left
  }

  /** `parseBinary(minPrecedence)`：Pratt 主循环。 */
  private parseBinary(minPrecedence: number): Node {
    let left = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (token.type !== 'op') break
      const precedence = BINARY_PRECEDENCE[token.value]
      if (precedence === undefined || precedence < minPrecedence) break
      this.next()
      // 右结合运算符的下一层最小优先级不提升，实现 `2 ^ 3 ^ 2 = 2 ^ (3 ^ 2)`。
      const nextMin = RIGHT_ASSOCIATIVE.has(token.value) ? precedence : precedence + 1
      this.depth.enter()
      let right: Node
      try {
        right = this.parseBinary(nextMin)
      } finally {
        this.depth.exit()
      }
      const node: BinaryNode = {
        kind: 'binary',
        op: token.value as BinaryOp,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      }
      left = node
    }
    return left
  }

  /** `unary = ("-"|"+"|"!") unary | postfix`。 */
  private parseUnary(): Node {
    const token = this.peek()
    if (token.type === 'op' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      this.next()
      this.depth.enter()
      try {
        const operand = this.parseUnary()
        return {
          kind: 'unary',
          op: token.value as '-' | '+' | '!',
          operand,
          span: { start: token.start, end: operand.span.end },
        }
      } finally {
        this.depth.exit()
      }
    }
    return this.parsePostfix()
  }

  /** `postfix = primary { "." ident | "[" expression "]" }`。 */
  private parsePostfix(): Node {
    const primary = this.parsePrimary()
    let node = primary
    for (;;) {
      if (this.matchOp('.')) {
        const ident = this.peek()
        if (ident.type !== 'ident') {
          throw new ForgeError('E_PARSE', { message: '属性名必须是标识符', span: this.peek() })
        }
        this.next()
        node = this.extendPath(node, ident.value, ident)
        continue
      }
      if (this.matchOp('[')) {
        // 列表下标：5.2 写作 `expression`，但下标只在编译期可静态判定越界与白名单
        // （5.9.3「越界与下标」），因此**只接受整数字面量**，非字面量报 `E_PARSE`。
        const indexToken = this.peek()
        if (indexToken.type !== 'number' || !/^\d+$/.test(indexToken.value)) {
          throw new ForgeError('E_PARSE', {
            message: '列表下标只支持整数字面量（编译期需静态判定越界）',
            span: indexToken,
          })
        }
        this.next()
        this.expectOp(']')
        node = this.extendPath(node, indexToken.value, indexToken)
        continue
      }
      // 路径必须完整成型：缺少条目 id（`gen.amount` 的 `amount` 会被当成 id）
      // 或缺少属性（`gen.g1`）都立即报错，不能拖到静态检查才暴露——
      // 否则 `parse()` 本身会产出一棵非法的 AST。
      if (node.kind === 'path' && (node.path.id === '' || node.path.attrs.length === 0)) {
        throw new ForgeError('E_PARSE', {
          message: '路径不完整，应形如 gen.g1.amount',
          span: node.span,
        })
      }
      return node
    }
  }

  /**
   * 把 `primary` 之后追加的属性段合并进路径节点。
   *
   * 两种情形：
   * - `node` 是前缀标识符（`res`/`gen`/`up`/`page`）：紧随的这一段就是**条目 id**；
   * - `node` 已是路径：继续把该段并入属性链（属性名或列表下标）。
   *
   * 首个 `primary` 若不是前缀标识符，则报 `E_UNKNOWN_IDENT`——语言没有对象成员访问，
   * `a.b` 只可能是条目属性。
   */
  private extendPath(node: Node, segment: string, token: Token): Node {
    this.depth.enter()
    try {
      if (node.kind === 'ident') {
        if (!PATH_PREFIXES.has(node.name)) {
          throw new ForgeError('E_UNKNOWN_IDENT', {
            message: `${node.name}. 不构成条目路径（路径须以 res/gen/up/page 开头）`,
            span: node.span,
          })
        }
        // 前缀后的第一段就是条目 id：`gen` + `.g1` -> id = 'g1'，属性链仍为空。
        return {
          kind: 'path',
          path: { prefix: node.name as PathPrefix, id: segment, attrs: [] },
          span: { start: node.span.start, end: token.end },
        }
      }
      if (node.kind === 'path') {
        node.path.attrs = [...node.path.attrs, segment]
        node.span = { start: node.span.start, end: token.end }
        return node
      }
      throw new ForgeError('E_PARSE', { message: '该表达式不是可访问属性的对象', span: token })
    } finally {
      this.depth.exit()
    }
  }

  /** `primary`：字面量、路径、标识符、函数调用、括号、受限字面量。 */
  private parsePrimary(): Node {
    const token = this.next()

    if (token.type === 'number') {
      return { kind: 'number', text: token.value, span: { start: token.start, end: token.end } }
    }

    if (token.type === 'string') {
      return { kind: 'string', value: unescapeString(token.value), span: { start: token.start, end: token.end } }
    }

    if (token.type === 'ident') {
      // `Infinity` 是合法数字字面量（D-46）：解析为哨兵，不走 `E_UNKNOWN_IDENT`。
      if (token.value === 'Infinity') {
        return { kind: 'ident', name: 'Infinity', span: { start: token.start, end: token.end } }
      }
      if (token.value === 'true') return { kind: 'boolean', value: true, span: { start: token.start, end: token.end } }
      if (token.value === 'false') return { kind: 'boolean', value: false, span: { start: token.start, end: token.end } }
      if (token.value === 'null') return { kind: 'null', span: { start: token.start, end: token.end } }
      if (this.peek().type === 'op' && this.peek().value === '(') {
        return this.parseCall(token)
      }
      return { kind: 'ident', name: token.value, span: { start: token.start, end: token.end } }
    }

    if (token.type === 'op') {
      if (token.value === '(') {
        this.depth.enter()
        try {
          const inner = this.parseAssignment()
          const close = this.expectOp(')')
          return { ...inner, span: { start: token.start, end: close.end } }
        } finally {
          this.depth.exit()
        }
      }
      if (token.value === '{') return this.parseObjectLiteral(token)
      if (token.value === '[') return this.parseArrayLiteral(token)
    }

    throw new ForgeError('E_PARSE', {
      message: token.type === 'eof' ? '表达式意外结束' : `意外的 ${token.value}`,
      span: { start: token.start, end: token.end },
    })
  }

  /** `ident "(" args ")"`：内置函数调用（5.4）。 */
  private parseCall(token: Token): Node {
    this.expectOp('(')
    const args: Node[] = []
    if (!(this.peek().type === 'op' && this.peek().value === ')')) {
      let argIndex = 0
      for (;;) {
        // `create()` 的**第二个**实参（`spec`）才允许字面量；其余实参一律禁止。
        // 许可必须在解析该实参**之前**打开——否则 `{` 已经在 `parsePrimary` 被当成非法起始，
        // 白名单形同虚设，而这正是 5.2 约束表要堵的口子。
        const prevLiteral = this.literalAllowed
        this.literalAllowed = token.value === 'create' && argIndex === 1
        try {
          args.push(this.parseAssignment())
        } finally {
          this.literalAllowed = prevLiteral
        }
        argIndex += 1
        if (this.matchOp(',')) continue
        break
      }
    }
    const close = this.expectOp(')')
    // 注意：**不在此处**判断实参个数。`rand()` 合法地取 0 个实参，而 arity 定义在
    // `functions.ts`、只有静态检查器知道；解析期一律放行，个数/类型由检查器按 arity 判定。
    return { kind: 'call', name: token.value, args, span: { start: token.start, end: close.end } }
  }

  /**
   * 受限对象字面量（5.2 约束表）。
   *
   * 键必须是字符串字面量或标识符；不支持展开运算符 `...`、计算键名与变量键（13 第 2 条）。
   * 位置不在 `create()` 的 spec 内时直接 `E_LITERAL_NOT_ALLOWED`——在**解析期**拒绝，
   * 保证恶意字面量连 AST 都构造不出来。
   */
  private parseObjectLiteral(token: Token): Node {
    if (!this.literalAllowed) {
      throw new ForgeError('E_LITERAL_NOT_ALLOWED', {
        message: '对象字面量仅可用于 create() 的 spec',
        span: { start: token.start, end: token.end },
      })
    }
    this.literalDepth += 1
    if (this.literalDepth > MAX_LITERAL_DEPTH) {
      throw new ForgeError('E_PARSE_DEPTH', {
        message: `字面量嵌套超过 ${MAX_LITERAL_DEPTH} 层`,
        span: { start: token.start, end: token.end },
      })
    }
    try {
      const entries: Array<{ key: string; value: ConstantValue }> = []
      while (!(this.peek().type === 'op' && this.peek().value === '}')) {
        if (this.peek().type === 'op' && this.peek().value === '...') {
          throw new ForgeError('E_PARSE', { message: '不支持展开运算符 ...', span: this.peek() })
        }
        const keyToken = this.next()
        let key: string
        if (keyToken.type === 'string') key = keyToken.value
        else if (keyToken.type === 'ident') key = keyToken.value
        else {
          throw new ForgeError('E_PARSE', {
            message: '对象的键必须是字符串字面量或标识符',
            span: { start: keyToken.start, end: keyToken.end },
          })
        }
        this.expectOp(':')
        const value = this.parseConstantValue()
        entries.push({ key, value })
        // 允许尾逗号（5.2 约束表“键形式”行）。
        if (this.matchOp(',')) continue
        break
      }
      const close = this.expectOp('}')
      return { kind: 'object', entries, span: { start: token.start, end: close.end } }
    } finally {
      this.literalDepth -= 1
    }
  }

  /** 受限数组字面量（5.2 约束表；单数组 ≤ `MAX_LITERAL_ITEMS` 项）。 */
  private parseArrayLiteral(token: Token): Node {
    if (!this.literalAllowed) {
      throw new ForgeError('E_LITERAL_NOT_ALLOWED', {
        message: '数组字面量仅可用于 create() 的 spec',
        span: { start: token.start, end: token.end },
      })
    }
    this.literalDepth += 1
    if (this.literalDepth > MAX_LITERAL_DEPTH) {
      throw new ForgeError('E_PARSE_DEPTH', {
        message: `字面量嵌套超过 ${MAX_LITERAL_DEPTH} 层`,
        span: { start: token.start, end: token.end },
      })
    }
    try {
      const items: ConstantValue[] = []
      while (!(this.peek().type === 'op' && this.peek().value === ']')) {
        items.push(this.parseConstantValue())
        if (items.length > MAX_LITERAL_ITEMS) {
          throw new ForgeError('E_BUDGET', {
            message: `单个数组字面量超过 ${MAX_LITERAL_ITEMS} 项`,
            span: { start: token.start, end: token.end },
          })
        }
        if (this.matchOp(',')) continue
        break
      }
      const close = this.expectOp(']')
      return { kind: 'array', items, span: { start: token.start, end: close.end } }
    } finally {
      this.literalDepth -= 1
    }
  }

  /**
   * 字面量的常量折叠（5.2 约束表“求值”行：静态折叠为常量值）。
   *
   * 只接受常量与嵌套字面量；不允许出现运算符或属性引用——`spec` 必须是纯常量，
   * `create()` 的副作用顺序才是确定的（5.6）。
   */
  private parseConstantValue(): ConstantValue {
    // 字面量解析器要求 `{` / `[` **已经被消费**（`parsePrimary` 也是这么调用的）。
    // 这里必须先 `next()` 再传，否则 `parseArrayLiteral` 会看到尚未消费的 `[`，
    // 把它当成数组的第一个元素重新进入本方法 -> 无限递归直到撞上字面量深度上限。
    const token = this.next()
    if (token.type === 'op' && token.value === '{') return foldNode(this.parseObjectLiteral(token))
    if (token.type === 'op' && token.value === '[') return foldNode(this.parseArrayLiteral(token))
    return foldNode(this.parseAssignmentFrom(token))
  }

  /** 从一个已消费的 token 开始解析赋值表达式（`parsePrimary` 的已消费分支复用）。 */
  private parseAssignmentFrom(token: Token): Node {
    switch (token.type) {
      case 'number':
        return { kind: 'number', text: token.value, span: { start: token.start, end: token.end } }
      case 'string':
        return { kind: 'string', value: unescapeString(token.value), span: { start: token.start, end: token.end } }
      case 'ident': {
        if (token.value === 'Infinity') {
          return { kind: 'ident', name: 'Infinity', span: { start: token.start, end: token.end } }
        }
        if (token.value === 'true') return { kind: 'boolean', value: true, span: { start: token.start, end: token.end } }
        if (token.value === 'false') return { kind: 'boolean', value: false, span: { start: token.start, end: token.end } }
        if (token.value === 'null') return { kind: 'null', span: { start: token.start, end: token.end } }
        throw new ForgeError('E_PARSE', {
          message: `字面量中不允许标识符 ${token.value}`,
          span: { start: token.start, end: token.end },
        })
      }
      case 'eof':
        throw new ForgeError('E_PARSE', { message: '字面量意外结束', span: { start: token.start, end: token.end } })
      default:
        throw new ForgeError('E_PARSE', {
          message: `字面量中只允许常量，遇到 ${token.value}`,
          span: { start: token.start, end: token.end },
        })
    }
  }
}

/** 字符串字面量反转义（5.2：支持 `\"`、`\\`、`\n`）。 */
function unescapeString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[++i]
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else out += next ?? ''
  }
  return out
}

/** 节点 -> 常量值（只接受常量节点，其余抛 `E_PARSE`）。 */
function foldNode(node: Node): ConstantValue {
  switch (node.kind) {
    case 'number':
      return Number.isFinite(Number(node.text)) ? Number(node.text) : node.text
    case 'string':
      return node.value
    case 'boolean':
      return node.value
    case 'null':
      return null
    case 'ident':
      // `Infinity` 保留为文本，交由 `create` 的数值字段解析为哨兵。
      return node.name === 'Infinity'
        ? 'Infinity'
        : (() => {
            throw new ForgeError('E_PARSE', { message: `字面量中不允许标识符 ${node.name}`, span: node.span })
          })()
    case 'object': {
      const out: ConstantObject = {}
      for (const entry of node.entries) out[entry.key] = entry.value
      return out
    }
    case 'array':
      return node.items
    default:
      throw new ForgeError('E_PARSE', { message: '字面量中只允许常量', span: node.span })
  }
}

/**
 * 解析入口：`源码 -> Token 流 -> AST`。
 *
 * @throws {ForgeError} 词法/语法/字面量位置/深度/预算类错误（`E_*` 见 17.1）。
 */
export function parse(source: string): Node {
  const tokens = tokenize(source)
  return new Parser(tokens, source).parseProgram()
}

/** 供静态检查与测试使用：把 AST 中的路径节点收集为 `key -> 位置` 列表。 */
export function collectPathKeys(
  node: Node,
  out: Array<{ prefix: PathPrefix; id: string; key: string; span: Node['span'] }> = [],
): Array<{
  prefix: PathPrefix
  id: string
  key: string
  span: Node['span']
}> {
  switch (node.kind) {
    case 'path':
      out.push({ prefix: node.path.prefix, id: node.path.id, key: normalizePropertyKey(node.path.attrs), span: node.span })
      break
    case 'unary':
      collectPathKeys(node.operand, out)
      break
    case 'binary':
      collectPathKeys(node.left, out)
      collectPathKeys(node.right, out)
      break
    case 'assign':
      collectPathKeys(node.target, out)
      collectPathKeys(node.value, out)
      break
    case 'call':
      for (const arg of node.args) collectPathKeys(arg, out)
      break
    default:
      break
  }
  return out
}
