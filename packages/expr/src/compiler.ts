/**
 * 闭包树编译器（TECH_DESIGN 5.6、ADR-02）。
 *
 * 每个 AST 节点编译为一个 `(scope) => value` 闭包，常量在**编译期**直接内联折叠，
 * 求值期不再递归解释（5.6「不做每 tick 递归解释」）。
 *
 * 求值作用域 `Scope` 只暴露三样东西（5.6「可读变量白名单」）：
 * - `read(path)`：由 `runtime` 的 `AttributeStore` 实现，属性读写与版本号递增都走它，
 *   因此表达式对属性的任何写入都会自动触发脏标记传播（5.3 末段）；
 * - `effValue`：仅 `effect` 上下文的局部变量（5.3）；
 * - `ctx`：函数调用上下文（随机源、副作用登记、动态条目查询）。
 *
 * 作用域对象由调用方用 `Object.create(null)` 构造，无原型污染路径（5.6 末条）。
 */
import { ForgeError, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import type { ConstantObject, ConstantValue, ContextKind, Node, Value } from './ast.js'
import type { CheckResult } from './checker.js'
import { staticCheck } from './checker.js'
import type { FunctionCallContext } from './functions.js'
import { lookupFunction } from './functions.js'
import { formatPathKey } from './properties.js'

/** 求值作用域（5.6「可读变量白名单」）。 */
export interface Scope {
  /**
   * 读条目属性。
   *
   * `runtime` 实现它时必须保证：属性不存在时抛 `E_UNKNOWN_ATTR`、下标越界读抛 `E_UNKNOWN_ATTR`、
   * 派生属性（`gen.<id>.perSec`）按需重算并缓存。任何异常都由求值器的 last-good 兜住（5.7）。
   */
  read: (key: string) => Value
  /**
   * 写条目属性。
   *
   * 5.6 要求写入**不在表达式求值阶段发生**：编译器只把写入登记成副作用，
   * 由提交阶段统一应用。因此本方法在 M1 的默认实现中不被调用——它是 `runtime` 提交阶段用的。
   */
  write?: (key: string, value: Value) => void
  /**
   * 编译作用域。`effValue` 与 `effValueAssigned` 是一对——后者区分
   * “本条效果赋过值”（需要登记写回）与“没赋值”（不登记、不递增 `version`，8.7）。
   */
  effValue?: Decimal
  /** 本次求值是否对 `effValue` 发生过赋值（5.6「未赋值则不登记写回」）。 */
  effValueAssigned?: boolean
  /** 函数调用上下文（随机源 / 副作用登记 / 动态条目查询）。 */
  call?: FunctionCallContext
  /** 编译期折叠出的常量（用于 `create()` 的 spec 原样透传）。 */
  constants?: ReadonlyMap<string, ConstantValue>
}

/** 编译产物（5.6 `CompiledExpr`）。 */
export interface CompiledExpr {
  /** 源码文本（与 `hash` 一起构成编译缓存键）。 */
  text: string
  /** 表达式求值。 */
  fn: (scope: Scope) => Value
  /** 依赖的属性键集合（5.6「变量解析」），用于脏标记与循环检测。 */
  deps: string[]
  /** 静态类型。 */
  type: CheckResult['type']
  /** 是否含副作用调用（8.8 离线可达性判定 / D-08 静态环检测）。 */
  hasEffect: boolean
  /** `contextKind + '\u0000' + text`，编译缓存键（5.6）。 */
  hash: string
}

const isDecimal = (value: Value): value is Decimal => typeof value === 'object' && value !== null && typeof (value as Decimal).cmp === 'function'

/** 数值实参断言：字符串参与算术报 `E_TYPE`（5.2「字符串不参与算术运算」）。 */
function asNumber(value: Value, span: Node['span'], what: string): Decimal {
  if (!isDecimal(value)) {
    throw new ForgeError('E_TYPE', { message: `${what} 需要数值，收到 ${typeof value === 'string' ? '字符串' : typeof value}`, span })
  }
  return value
}

/** 把常量值转成运行期值（`spec` 的字符串字段原样透传，数值字段按文本处理，8.7）。 */
function constantToValue(value: ConstantValue): Value {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value
  if (value === null) return 'null'
  if (typeof value === 'number') return Num.fromNumber(value)
  // 对象/数组在运行期保持原样（`create()` 的 spec 由提交阶段构造）。
  return JSON.stringify(value)
}

/** 编译器（每次 `compile()` 一个实例，负责常量内联）。 */
class Compiler {
  private readonly constants = new Map<string, ConstantValue>()

  constructor(private readonly context: ContextKind) {}

  compileNode(node: Node): (scope: Scope) => Value {
    switch (node.kind) {
      case 'number': {
        // 数字字面量：编译期构造 `Decimal`，支持 `1e1e10` 分层指数（4.2）。
        const value = Num.fromString(node.text)
        return () => value
      }
      case 'string': {
        const value = node.value
        return () => value
      }
      case 'boolean': {
        const value = node.value
        return () => value
      }
      case 'null':
        return () => 'null'
      case 'ident':
        return this.compileIdent(node)
      case 'path':
        return this.compilePath(node)
      case 'unary':
        return this.compileUnary(node)
      case 'binary':
        return this.compileBinary(node)
      case 'assign':
        return this.compileAssign(node)
      case 'call':
        return this.compileCall(node)
      case 'object':
      case 'array':
        return this.compileLiteral(node)
      default: {
        const exhaustive: never = node
        throw new ForgeError('E_PARSE', { message: `无法编译的节点 ${JSON.stringify(exhaustive)}` })
      }
    }
  }

  private compileIdent(node: Extract<Node, { kind: 'ident' }>): (scope: Scope) => Value {
    if (node.name === 'Infinity') {
      // D-46：`Infinity` 字面量解析为 `NUM_INF` 哨兵，各上下文语义见 4.4 第 6 条。
      const inf = Num.fromValue('Infinity')
      return () => inf
    }
    if (node.name === 'effValue') {
      return (scope) => scope.effValue ?? Num.fromNumber(0)
    }
    // `tick`/`time`/`dt`/`elapsed`/`offline`/`started` 由 runtime 通过 `read` 暴露，
    // 统一走 `read(<name>)` 以便它们参与版本号脏标记。
    const key = node.name
    return (scope) => scope.read(key)
  }

  private compilePath(node: Extract<Node, { kind: 'path' }>): (scope: Scope) => Value {
    // 规范键必须由 `formatPathKey` 生成：AST 的下标是独立数段，
    // `attrs.join('.')` 会得到 `costs.0.amount`，与 `set("gen.g1.costs[0].amount", …)`
    // 的字面量路径对不上，副作用会写到另一个键上（5.9.3 / 8.6.1）。
    const key = formatPathKey(node.path.prefix, node.path.id, node.path.attrs)
    return (scope) => scope.read(key)
  }

  private compileUnary(node: Extract<Node, { kind: 'unary' }>): (scope: Scope) => Value {
    const inner = this.compileNode(node.operand)
    return (scope) => {
      const value = inner(scope)
      if (node.op === '!') {
        if (typeof value !== 'boolean') {
          throw new ForgeError('E_TYPE', { message: '! 需要布尔操作数', span: node.span })
        }
        return !value
      }
      const numeric = asNumber(value, node.span, `一元 ${node.op}`)
      return node.op === '-' ? Num.neg(numeric) : numeric
    }
  }

  private compileBinary(node: Extract<Node, { kind: 'binary' }>): (scope: Scope) => Value {
    const left = this.compileNode(node.left)
    const right = this.compileNode(node.right)

    // 逻辑运算需要真正的短路：`&&` / `||` 的右操作数不求值可避免无谓的属性读取与报错，
    // 与 5.4「惰性分支」的语义一致（`if()` 的三个实参都求值是语言限制，这里不必跟随）。
    if (node.op === '&&' || node.op === '||') {
      return (scope) => {
        const l = left(scope)
        if (typeof l !== 'boolean') {
          throw new ForgeError('E_TYPE', { message: `${node.op} 的左操作数需要布尔值`, span: node.span })
        }
        if (node.op === '&&' && !l) return false
        if (node.op === '||' && l) return true
        const r = right(scope)
        if (typeof r !== 'boolean') {
          throw new ForgeError('E_TYPE', { message: `${node.op} 的右操作数需要布尔值`, span: node.span })
        }
        return r
      }
    }

    return (scope) => {
      const l = left(scope)
      const r = right(scope)
      switch (node.op) {
        case '==':
        case '!=':
        case '===':
        case '!==': {
          const equal = looseEquals(l, r)
          return node.op === '==' || node.op === '===' ? equal : !equal
        }
        case '<':
        case '<=':
        case '>':
        case '>=':
          return compareValues(l, r, node.op, node.span)
        default: {
          const a = asNumber(l, node.span, `运算符 ${node.op}`)
          const b = asNumber(r, node.span, `运算符 ${node.op}`)
          switch (node.op) {
            case '+':
              return Num.add(a, b)
            case '-':
              return Num.sub(a, b)
            case '*':
              return Num.mul(a, b)
            case '/':
              return Num.div(a, b)
            case '%':
              return Num.mod(a, b)
            case '^':
              return Num.pow(a, b)
            default: {
              const exhaustive: never = node.op as never
              throw new ForgeError('E_PARSE', { message: `未实现的运算符 ${String(exhaustive)}` })
            }
          }
        }
      }
    }
  }

  /**
   * 赋值（5.6、5.9.3）。
   *
   * 关键：**不在表达式求值阶段写入存储**。
   * - `=` / `+=` / `-=` / `*=` / `/=` 到条目属性 -> 登记 `set` 副作用进当前分桶；
   * - 赋给 `effValue` -> 只改**局部** `scope.effValue`，写回由 8.7 的
   *   `bucket.commitEffValue(scope.effValue)` 在提交阶段统一登记（5.6「同生共死」）。
   *
   * 因此副作用提交的时序统一由 5.6 的“固定提交阶段”保证，不存在“交互即时提交”的旁路（8.3.1）。
   */
  private compileAssign(node: Extract<Node, { kind: 'assign' }>): (scope: Scope) => Value {
    const right = this.compileNode(node.value)

    if (node.target.kind === 'ident' && node.target.name === 'effValue') {
      return (scope) => {
        const value = asNumber(right(scope), node.span, 'effValue')
        scope.effValue = value
        // 8.7：赋值标记驱动 `commitEffValue`，未赋值时**不登记写回**、
        // 也不递增该属性 `version`（否则每次“每秒生效”都制造无意义的缓存失效，R-06）。
        scope.effValueAssigned = true
        return value
      }
    }

    const target = node.target
    if (target.kind !== 'path') {
      throw new ForgeError('E_READONLY_TARGET', { message: '赋值目标必须是条目属性或 effValue', span: target.span })
    }
    const key = formatPathKey(target.path.prefix, target.path.id, target.path.attrs)

    return (scope) => {
      const raw = right(scope)
      const value = node.op === '=' ? raw : combine(node.op, asNumber(raw, node.span, '复合赋值'), scope.read(key))
      const ctx = scope.call
      if (!ctx) throw new ForgeError('E_SIDE_EFFECT_FORBIDDEN', { message: '当前上下文不允许副作用', span: node.span })
      return ctx.emit('set', { path: key, value })
    }
  }

  private compileCall(node: Extract<Node, { kind: 'call' }>): (scope: Scope) => Value {
    const fn = lookupFunction(node.name)
    if (!fn) {
      throw new ForgeError('E_UNKNOWN_IDENT', { message: `未知的函数 ${node.name}`, span: node.span })
    }
    const argFns = node.args.map((arg) => this.compileNode(arg))

    // `create()` 的 spec 在编译期已折叠为常量对象，**原样透传**（8.7「字段形态」）。
    // 绝不能经 `constantToValue`：那会把对象 `JSON.stringify` 成字符串，
    // `create()` 的实参校验随即报 `E_TYPE`，动态创建整条路径失效。
    if (node.name === 'create') {
      const specNode = node.args[1]!
      const spec: ConstantObject = {}
      if (specNode.kind === 'object') {
        for (const entry of specNode.entries) spec[entry.key] = entry.value
      }
      const kindFn = argFns[0]!
      return (scope) => {
        const ctx = requireCallContext(scope, node.span)
        return fn.impl([kindFn(scope), spec], ctx)
      }
    }

    return (scope) => {
      const ctx = requireCallContext(scope, node.span)
      const args = argFns.map((argFn) => argFn(scope))
      return fn.impl(args, ctx)
    }
  }

  /** `create()` 的字面量（正常路径不会走到这里，保留以满足穷尽性）。 */
  private compileLiteral(node: Extract<Node, { kind: 'object' | 'array' }>): (scope: Scope) => Value {
    const folded: ConstantValue = node.kind === 'object' ? Object.fromEntries(node.entries.map((entry) => [entry.key, entry.value])) : node.items
    this.constants.set(`lit:${node.span.start}`, folded)
    const value = constantToValue(folded)
    return () => value
  }
}

function requireCallContext(scope: Scope, span: Node['span']): FunctionCallContext {
  if (!scope.call) {
    throw new ForgeError('E_SIDE_EFFECT_FORBIDDEN', { message: '当前求值未提供调用上下文', span })
  }
  return scope.call
}

/** 复合赋值（`+=` 等）的结果。 */
function combine(op: string, right: Decimal, current: Value): Value {
  const left = asNumber(current, { start: 0, end: 0 }, `复合赋值 ${op}`)
  switch (op) {
    case '+=':
      return Num.add(left, right)
    case '-=':
      return Num.sub(left, right)
    case '*=':
      return Num.mul(left, right)
    case '/=':
      return Num.div(left, right)
    default:
      return right
  }
}

/**
 * 相等比较（`==` 与 `===` 在本语言中等价）。
 *
 * 数值与布尔严格按类型比较；**数值 0 与布尔 false 不相等**——
 * 语言不做 JS 的隐式转换，避免 `gen.g1.owned == false` 这类陷阱。
 */
function looseEquals(left: Value, right: Value): boolean {
  if (isDecimal(left) && isDecimal(right)) return left.eq(right)
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right
  if (typeof left === 'string' && typeof right === 'string') return left === right
  return false
}

/** 有序比较（`<`/`<=`/`>`/`>=`）：两侧必须是数值。 */
function compareValues(left: Value, right: Value, op: string, span: Node['span']): boolean {
  const a = asNumber(left, span, `比较 ${op}`)
  const b = asNumber(right, span, `比较 ${op}`)
  switch (op) {
    case '<':
      return a.lt(b)
    case '<=':
      return a.lte(b)
    case '>':
      return a.gt(b)
    case '>=':
      return a.gte(b)
    default:
      return false
  }
}

/**
 * 编译入口：`AST -> CompiledExpr`（5.6）。
 *
 * 顺序固定为「静态检查 -> 闭包编译」，与 5.6 的管线一致：
 * `源码 → Lexer → Parser(Pratt) → AST → StaticChecker → ClosureCompiler → CompiledExpr`。
 *
 * @throws {ForgeError} 静态检查错误（不进入运行期）。
 */
export function compile(ast: Node, text: string, context: ContextKind): CompiledExpr {
  const checked = staticCheck(ast, context)
  const compiler = new Compiler(context)
  const fn = compiler.compileNode(ast)
  return {
    text,
    fn,
    deps: checked.deps,
    type: checked.type,
    hasEffect: checked.hasEffect,
    hash: `${context}\u0000${text}`,
  }
}
