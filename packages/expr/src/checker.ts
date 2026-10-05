/**
 * 静态检查（TECH_DESIGN 5.6 管线的一环、5.5 权限、5.9 权限矩阵、13 安全与沙箱）。
 *
 * 在**编译期**拦掉的问题（全部不进入运行期，符合 5.6「不进入运行期」的约束）：
 * - 未知标识符/函数 -> `E_UNKNOWN_IDENT`
 * - 不存在的属性 -> `E_UNKNOWN_ATTR`
 * - 写只读属性 -> `E_READONLY_TARGET`
 * - 类型不匹配 -> `E_ASSIGN_TYPE`
 * - 价格上下文用随机函数 -> `E_RAND_DISABLED`（PRD 补充 1）
 * - 非 `effect` 上下文用副作用函数 -> `E_SIDE_EFFECT_FORBIDDEN`
 * - 字面量出现在 `create()` spec 之外 -> `E_LITERAL_NOT_ALLOWED`（由解析器抛出）
 * - `create()` 的 spec 含未知键 -> `E_CREATE_FIELD_INVALID`
 * - `create()` 缺 `page` -> `E_CREATE_NO_PAGE`
 * - `set()` 的路径非字面量 -> `E_TYPE`
 *
 * 检查器同时推导每个节点的静态类型，供赋值目标做 `E_ASSIGN_TYPE` 判定。
 */
import { ForgeError } from '@iforge/num'

import type { CallNode, ConstantObject, ContextKind, Node, PathPrefix, ValueType } from './ast.js'
import { CREATE_SPEC_FIELDS, checkCreateSpec, checkSpecPage } from './create-spec.js'
import type { FunctionCallContext } from './functions.js'
import { lookupFunction } from './functions.js'
import { formatPathKey, lookupProperty, normalizePropertyKey, parseLiteralPath, templateKey } from './properties.js'

/**
 * `create()` 的 `spec` 字段白名单（8.7「字段集合」行）。
 *
 * 它必须与项目文件的 `GeneratorDef`/`UpgradeDef` 字段保持一致（5.2 约束表「键名」行：
 * “与 `GeneratorDef`/`UpgradeDef` 字段一致”，且**不允许实现期临时放宽**）。
 * `kind` 与 `buyDelay` 由运行时接管，出现在 spec 里报 `E_CREATE_FIELD_INVALID`（8.7）。
 */
export { CREATE_SPEC_FIELDS }

/** 内置变量白名单（5.3）：`tick`/`time`/`dt`/`elapsed`/`offline`/`started` + `effValue`。 */
const BUILTIN_VARIABLES: ReadonlySet<string> = new Set(['tick', 'time', 'dt', 'elapsed', 'offline', 'started'])

/** 局部变量（5.3 `effValue`）：只在 `effect` 上下文存在。 */
const LOCAL_VARIABLES: ReadonlySet<string> = new Set(['effValue'])

/** `Infinity` 是合法字面量（D-46），解析为哨兵而非普通标识符。 */
const SPECIAL_IDENTIFIERS: ReadonlySet<string> = new Set(['Infinity'])

/** 检查结果：静态类型 + 依赖列表（5.6：用于脏标记与循环检测）。 */
export interface CheckResult {
  type: ValueType
  /** `["res.r1.amount", "gen.g1.bought", ...]`，5.6「变量解析」。 */
  deps: string[]
  /**
   * 读到的**内建变量**（`tick`/`time`/`dt`/`elapsed`/`offline`/`started`），5.3。
   *
   * 它们不是条目属性，因此**不在 `deps` 里**、也没有版本号可依赖——每一 tick 都在变。
   * 于是任何“按依赖缓存求值结果”的地方（视图模型的价格合计缓存）都必须知道这条：
   * 只按 `deps` 判脏，`10 + time` 这类价格会被永久缓存成开局那个值。
   * 命中任意一个即表示“这条表达式不能跨 tick 缓存”。
   */
  vars: string[]
  /** 是否含有副作用调用（用于静态环检测与离线可达性判断，8.8 / D-08）。 */
  hasEffect: boolean
}

/** 路径的规范字符串形式（作为 `deps` 的元素）。 */
export function pathKey(prefix: string, id: string, attrs: readonly string[]): string {
  return formatPathKey(prefix as PathPrefix, id, attrs)
}

class Checker {
  readonly deps: string[] = []
  readonly vars: string[] = []
  hasEffect = false

  constructor(private readonly context: ContextKind) {}

  check(node: Node): ValueType {
    switch (node.kind) {
      case 'number':
        return 'number'
      case 'string':
        return 'string'
      case 'boolean':
        return 'boolean'
      case 'null':
        // 单列一档：5.9.3 明确“布尔 / `null` 赋给数值或表达式文本属性报 `E_ASSIGN_TYPE`”。
        return 'null'
      case 'ident':
        return this.checkIdent(node.name, node.span)
      case 'path':
        return this.checkPath(node, node.span)
      case 'unary': {
        const operandType = this.check(node.operand)
        if (node.op === '!') return 'boolean'
        if (operandType === 'string') {
          throw new ForgeError('E_TYPE', { message: '字符串不参与算术运算（语言无 str() 与字符串拼接）', span: node.span })
        }
        return 'number'
      }
      case 'binary':
        return this.checkBinary(node)
      case 'assign':
        return this.checkAssign(node)
      case 'call':
        return this.checkCall(node)
      case 'object':
      case 'array':
        // 字面量只能作为 create() 的 spec 实参出现，解析期已校验；此处按常量处理。
        return 'string'
      default: {
        const exhaustive: never = node
        void exhaustive
        return 'number'
      }
    }
  }

  private checkIdent(name: string, span: Node['span']): ValueType {
    if (SPECIAL_IDENTIFIERS.has(name)) return 'number'
    if (LOCAL_VARIABLES.has(name)) {
      // 5.3：`effValue` 只在 `effect` 上下文存在。
      if (this.context !== 'effect') {
        throw new ForgeError('E_UNKNOWN_IDENT', { message: 'effValue 只在 effect 上下文可用（5.3）', span })
      }
      return 'number'
    }
    if (BUILTIN_VARIABLES.has(name)) {
      this.vars.push(name)
      return name === 'offline' || name === 'started' ? 'boolean' : 'number'
    }
    if (lookupFunction(name)) {
      throw new ForgeError('E_PARSE', { message: `函数 ${name} 缺少实参`, span })
    }
    throw new ForgeError('E_UNKNOWN_IDENT', { message: `未知的变量 ${name}`, span })
  }

  private checkPath(node: Extract<Node, { kind: 'path' }>, span: Node['span']): ValueType {
    if (node.path.id === '') {
      throw new ForgeError('E_PARSE', { message: '路径缺少条目 id', span })
    }
    const key = pathKey(node.path.prefix, node.path.id, node.path.attrs)
    // 依赖收集（5.6）：用于版本号脏标记与运行期循环检测。
    this.deps.push(key)
    // 直接按 AST 里的属性链查表，不做“拼字符串再解析”的往返——
    // 下标在 AST 里是独立数段，字符串往返会丢失方括号形式。
    const { spec } = lookupProperty(node.path.prefix, node.path.attrs)
    if (!spec) {
      throw new ForgeError('E_UNKNOWN_ATTR', {
        message: `${node.path.prefix} 条目没有属性 ${templateKey(normalizePropertyKey(node.path.attrs))}（5.9）`,
        span,
      })
    }
    return spec.type
  }

  private checkBinary(node: Extract<Node, { kind: 'binary' }>): ValueType {
    const left = this.check(node.left)
    const right = this.check(node.right)
    const comparison = ['==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||']
    if (comparison.includes(node.op)) {
      // 比较/逻辑：两侧只要有一侧是字符串就可能触发类型问题，这里只拦明显的字符串算术。
      return 'boolean'
    }
    if (left === 'string' || right === 'string') {
      throw new ForgeError('E_TYPE', {
        message: `运算符 ${node.op} 不支持字符串（语言无字符串拼接）`,
        span: node.span,
      })
    }
    return 'number'
  }

  /** 赋值：目标必须是可写路径或 `effValue`（5.4 末段、5.9.3）。 */
  private checkAssign(node: Extract<Node, { kind: 'assign' }>): ValueType {
    const valueType = this.check(node.value)

    if (node.target.kind === 'ident' && node.target.name === 'effValue') {
      // `effValue` 只在 `effect` 上下文存在（5.3）——上下文判定不能被“赋值”绕过。
      if (this.context !== 'effect') {
        throw new ForgeError('E_UNKNOWN_IDENT', { message: 'effValue 只在 effect 上下文可用（5.3）', span: node.span })
      }
      // 类型必须是数值（写回 `up.<id>.effectValues[i]`）。
      if (valueType !== 'number') {
        throw new ForgeError('E_ASSIGN_TYPE', { message: `effValue 只接受数值，收到 ${valueType}`, span: node.span })
      }
      return valueType
    }

    if (node.target.kind !== 'path') {
      throw new ForgeError('E_READONLY_TARGET', { message: '赋值目标必须是条目属性或 effValue', span: node.target.span })
    }

    this.checkPath(node.target, node.target.span)
    const { spec, key } = lookupProperty(node.target.path.prefix, node.target.path.attrs)
    if (!spec) {
      throw new ForgeError('E_UNKNOWN_ATTR', { message: '赋值目标不存在', span: node.target.span })
    }
    if (!spec.writable) {
      throw new ForgeError('E_READONLY_TARGET', {
        message: `属性 ${key} 只读（5.9 属性读写矩阵）`,
        span: node.target.span,
      })
    }

    // 类型匹配（5.9.3 表）：
    // - 布尔属性：只接受布尔；
    // - 字符串属性：只接受字符串；
    // - 数值 / 表达式文本属性：接受数值或字符串（字符串是“替换为新的常量源码”的唯一入口，D-29），
    //   **布尔与 `null` 一律拒绝**（5.9.3 表末两行）。
    if (spec.type === 'boolean' && valueType !== 'boolean') {
      throw new ForgeError('E_ASSIGN_TYPE', {
        message: `布尔属性 ${key} 只接受布尔值，收到 ${valueType}`,
        span: node.span,
      })
    }
    if (spec.type === 'string' && valueType !== 'string') {
      throw new ForgeError('E_ASSIGN_TYPE', {
        message: `字符串属性 ${key} 只接受字符串，收到 ${valueType}`,
        span: node.span,
      })
    }
    if (spec.type === 'number' && (valueType === 'boolean' || valueType === 'null')) {
      throw new ForgeError('E_ASSIGN_TYPE', {
        message: `数值属性 ${key} 不接受 ${valueType}（5.9.3）`,
        span: node.span,
      })
    }
    return valueType
  }

  private checkCall(node: CallNode): ValueType {
    const fn = lookupFunction(node.name)
    if (!fn) {
      throw new ForgeError('E_UNKNOWN_IDENT', { message: `未知的函数 ${node.name}`, span: node.span })
    }

    // 5.5：随机函数在价格上下文禁用（编译期报 `E_RAND_DISABLED`，PRD 补充 1）。
    if (fn.random && this.context === 'price') {
      throw new ForgeError('E_RAND_DISABLED', {
        message: `随机函数 ${node.name} 在价格表达式中不可用（PRD 补充 1）`,
        span: node.span,
      })
    }
    // 5.5：副作用函数仅 `effect` 上下文可用。
    if (fn.effect && this.context !== 'effect') {
      throw new ForgeError('E_SIDE_EFFECT_FORBIDDEN', {
        message: `${node.name} 只在 effect 上下文可用（5.5）`,
        span: node.span,
      })
    }

    if (node.args.length < fn.arity.min || node.args.length > fn.arity.max) {
      throw new ForgeError('E_PARSE', {
        message: `${node.name} 需要 ${fn.arity.min === fn.arity.max ? fn.arity.min : `${fn.arity.min}~${fn.arity.max}`} 个实参`,
        span: node.span,
      })
    }

    // `set()` 的第一个实参必须是字面量路径（D-27）：编译期完成目标解析与权限校验。
    if (node.name === 'set') {
      const [pathNode, valueNode] = node.args as [Node, Node]
      if (pathNode.kind !== 'string') {
        throw new ForgeError('E_TYPE', {
          message: 'set() 的第一个参数必须是字面量路径字符串，不接受变量或拼接（D-27）',
          span: pathNode.span,
        })
      }
      const resolved = parseLiteralPath(pathNode.value)
      if (!resolved) {
        throw new ForgeError('E_UNKNOWN_ATTR', { message: `无法解析的路径 ${pathNode.value}`, span: pathNode.span })
      }
      if (!resolved.spec) {
        throw new ForgeError('E_UNKNOWN_ATTR', { message: `属性不存在：${resolved.key}`, span: pathNode.span })
      }
      if (!resolved.spec.writable) {
        throw new ForgeError('E_READONLY_TARGET', {
          message: `属性 ${resolved.key} 只读（5.9 属性读写矩阵）`,
          span: pathNode.span,
        })
      }
      this.deps.push(pathKey(resolved.prefix, resolved.id, resolved.attrs))
      const valueType = this.check(valueNode)
      if (resolved.spec.type === 'boolean' && valueType !== 'boolean') {
        throw new ForgeError('E_ASSIGN_TYPE', { message: `${resolved.key} 只接受布尔值`, span: valueNode.span })
      }
      if (resolved.spec.type === 'string' && valueType !== 'string') {
        throw new ForgeError('E_ASSIGN_TYPE', { message: `${resolved.key} 只接受字符串`, span: valueNode.span })
      }
      if (resolved.spec.type === 'number' && (valueType === 'boolean' || valueType === 'null')) {
        throw new ForgeError('E_ASSIGN_TYPE', { message: `${resolved.key} 不接受 ${valueType}`, span: valueNode.span })
      }
      // `set()` 是副作用函数（5.5 副作用列），依赖环静态检测需要知道它（8.7 / D-08）。
      this.hasEffect = true
      return valueType
    }

    if (node.name === 'create') {
      const kindNode = node.args[0]!
      if (kindNode.kind !== 'string') {
        throw new ForgeError('E_TYPE', { message: 'create() 的第一个参数必须是 kind 字符串', span: kindNode.span })
      }
      const specNode = node.args[1]!
      if (specNode.kind !== 'object') {
        throw new ForgeError('E_LITERAL_NOT_ALLOWED', { message: 'create() 的 spec 必须是对象字面量', span: specNode.span })
      }
      const spec: ConstantObject = {}
      for (const entry of specNode.entries) spec[entry.key] = entry.value
      checkCreateSpec(spec, kindNode.value, specNode.span)
      checkSpecPage(spec, specNode.span)
      this.hasEffect = true
      return 'string'
    }

    if (node.name === 'destroy') {
      const idNode = node.args[0]!
      if (idNode.kind !== 'string') {
        throw new ForgeError('E_TYPE', { message: 'destroy() 需要条目 id 字符串', span: idNode.span })
      }
      this.hasEffect = true
      return 'string'
    }

    // 普通纯函数：逐个检查实参类型。
    const types = node.args.map((arg) => this.check(arg))
    // `if` 的第二/第三实参可异构（按条件返回其一）；`has`/`count` 收的是**字符串**实参，
    // 不能套用“纯数值函数不接受字符串”的通用规则。
    if (node.name === 'if') return types[1] ?? types[2] ?? 'number'
    if (node.name === 'has' || node.name === 'count') {
      for (const [index, type] of types.entries()) {
        if (type !== 'string') {
          throw new ForgeError('E_TYPE', {
            message: `${node.name} 的第 ${index + 1} 个参数需要字符串`,
            span: node.args[index]!.span,
          })
        }
      }
      return node.name === 'has' ? 'boolean' : 'number'
    }
    for (const [index, type] of types.entries()) {
      if (type === 'string' || type === 'null') {
        throw new ForgeError('E_TYPE', { message: `${node.name} 不接受 ${type} 实参`, span: node.args[index]!.span })
      }
    }
    return node.name === 'randChance' ? 'boolean' : 'number'
  }
}

/**
 * 静态检查入口。
 *
 * @throws {ForgeError} 上述任一编译期错误。
 */
export function staticCheck(node: Node, context: ContextKind): CheckResult {
  const checker = new Checker(context)
  const type = checker.check(node)
  return {
    type,
    deps: [...new Set(checker.deps)],
    vars: [...new Set(checker.vars)],
    hasEffect: checker.hasEffect,
  }
}

export type { FunctionCallContext }
