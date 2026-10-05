/**
 * 表达式 AST（TECH_DESIGN 5.2）。
 *
 * 所有节点都带 `span`（源码列区间），供 5.8 的错误定位与 17.1 的 `E_*` 定位使用。
 * 节点设计贴合闭包树编译（5.6）：每个节点都能直接编译成一个 `(scope) => value` 闭包。
 */
import type { Decimal } from '@iforge/num'

/** 条目/页面四类路径前缀（5.2 `path` 规则、5.3）。 */
export type PathPrefix = 'res' | 'gen' | 'up' | 'page'

/** 表达式上下文（5.5）。决定随机函数、副作用函数与属性读写的权限。 */
export type ContextKind = 'field' | 'price' | 'production' | 'condition' | 'effect'

/**
 * 求值结果的静态类型。
 *
 * `null` 单列一档而不是并入 `string`：5.9.3 要求“布尔 / `null` 赋给数值或表达式文本属性
 * 报 `E_ASSIGN_TYPE`”，若把 `null` 折进 `string`，它就会被当成合法的“源码文本”而通过检查。
 */
export type ValueType = 'number' | 'boolean' | 'string' | 'null'

/**
 * 属性访问路径：`("res"|"gen"|"up"|"page") "." id "." attr` 后可跟若干
 * `"." ident` / `"[" 数字 "]"`（列表下标，如 `gen.g1.costs[0].materialId`）。
 */
export interface PathRef {
  prefix: PathPrefix
  id: string
  /** 属性链，如 `['costs', '0', 'materialId']`。 */
  attrs: string[]
}

export interface NodeBase {
  span: { start: number; end: number }
}

export interface NumberNode extends NodeBase {
  kind: 'number'
  /** 原始字面量文本，保留 `1e1e10` 这类分层写法。 */
  text: string
}

export interface StringNode extends NodeBase {
  kind: 'string'
  value: string
}

export interface BooleanNode extends NodeBase {
  kind: 'boolean'
  value: boolean
}

export interface NullNode extends NodeBase {
  kind: 'null'
}

export interface IdentNode extends NodeBase {
  kind: 'ident'
  name: string
}

export interface PathNode extends NodeBase {
  kind: 'path'
  path: PathRef
}

/** 一元运算：`-`、`+`、`!`。 */
export interface UnaryNode extends NodeBase {
  kind: 'unary'
  op: '-' | '+' | '!'
  operand: Node
}

/** 二元运算（含比较与逻辑）。 */
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '===' | '!==' | '<' | '<=' | '>' | '>=' | '&&' | '||'

export interface BinaryNode extends NodeBase {
  kind: 'binary'
  op: BinaryOp
  left: Node
  right: Node
}

/** 赋值：`=`、`+=`、`-=`、`*=`、`/=`（5.2 assignment）。 */
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/='

export interface AssignNode extends NodeBase {
  kind: 'assign'
  op: AssignOp
  /** 赋值目标：只能是 `path` 或局部变量 `effValue`。 */
  target: Node
  value: Node
}

/** 函数调用：`set(path, expr)`、`create("upgrade", spec)` 等。 */
export interface CallNode extends NodeBase {
  kind: 'call'
  name: string
  args: Node[]
}

/** 受限对象字面量（仅允许出现在 `create()` 的 `spec` 实参内，5.2 约束表）。 */
export interface ObjectLiteralNode extends NodeBase {
  kind: 'object'
  /** 键必须是字符串字面量或标识符；值为常量（静态折叠）。 */
  entries: Array<{ key: string; value: ConstantValue }>
}

/** 受限数组字面量（同上）。 */
export interface ArrayLiteralNode extends NodeBase {
  kind: 'array'
  items: ConstantValue[]
}

/**
 * 字面量的静态值。
 *
 * `create()` 的 `spec` 在编译期静态折叠成常量再构造，因此这里用普通 JS 值承载，
 * 不保留 `Decimal`/节点结构。数值统一用十进制文本，避免大数在 JSON 化时丢精度。
 */
export type ConstantValue = string | number | boolean | null | ConstantObject | ConstantValue[]

export interface ConstantObject {
  [key: string]: ConstantValue
}

export type Node =
  | NumberNode
  | StringNode
  | BooleanNode
  | NullNode
  | IdentNode
  | PathNode
  | UnaryNode
  | BinaryNode
  | AssignNode
  | CallNode
  | ObjectLiteralNode
  | ArrayLiteralNode

/**
 * 运行期求值结果。
 *
 * 包含 `ConstantObject` 是为 `create()` 的 `spec`：spec 在编译期已折叠成常量对象，
 * 由编译器原样透传给 `emit('create', …)`，不经任何字符串化（8.7「字段形态」）。
 * 数值位置由编译器用 `asNumber()` 判定（必须是 `Decimal`），因此对象值混进来
 * 不会污染算术——它只会让需要数值的路径报 `E_TYPE`。
 */
export type Value = Decimal | boolean | string | ConstantObject

/** 带类型信息的求值结果（编译器在静态检查后附加类型，供 `E_ASSIGN_TYPE` 判定）。 */
export interface TypedValue {
  value: Value
  type: ValueType
}

/** 副作用类型（5.4、5.6）。 */
export type EffectKind = 'set' | 'create' | 'destroy'

/** 一条待提交的副作用（由 `EffectSink` 分桶收集，5.6）。 */
export interface Effect {
  kind: EffectKind
  /** `set` 的字面量路径；`destroy` 的条目 id；`create` 无。 */
  path?: string
  /** `set` 的值；`create` 的已折叠 spec。 */
  value?: Value | ConstantValue
  /** `create` 的 kind 参数。 */
  createKind?: string
  /** `create` 的 spec 常量。 */
  spec?: ConstantObject
  /** `create()` 返回的新条目 id（提交阶段回填）。 */
  createdId?: string
  /** 记录该副作用的源码表达式文本（仅审计用，读档不回放，6.3）。 */
  expr: string
}
