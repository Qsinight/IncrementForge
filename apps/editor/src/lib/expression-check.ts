/**
 * 表达式的实时校验与试算（TECH_DESIGN 5.8「表达式编辑器交互」、5.5 上下文、5.9 权限）。
 *
 * | 能力 | 实现 | 落点 |
 * | --- | --- | --- |
 * | 编译期校验（语法/未知变量/只读赋值/禁用函数） | `checkExpression()` → `@iforge/expr` 的 `validateExpression` | 5.6 |
 * | 按上下文过滤的可用函数/变量提示 | `describeContext()` | 5.4 表是 5.5 权限表的投影，docs:check 规则 7 |
 * | 试算（当前值 + 耗时） | `tryEvaluate()` → 影子 `GameState` | 5.8、ADR-03/D-15 |
 *
 * **为什么错误码在这里统一**：`E_RAND_DISABLED`（价格上下文）、`E_SIDE_EFFECT_FORBIDDEN`、
 * `E_READONLY_TARGET` 等都是**编译期**结论，编辑器必须把它们显示成红框而不是运行期报错，
 * 否则作者会以为“表达式没生效”。
 */
import { BUILTIN_FUNCTIONS, validateExpression } from '@iforge/expr'
import type { ContextKind } from '@iforge/expr'
import type { ErrorCode } from '@iforge/num'

import { useProjectStore } from '../stores/project.js'
import { getShadow } from './shadow.js'

/** 一条校验结论。 */
export interface ExpressionCheck {
  ok: boolean
  /** 17.1 的错误码（`ok` 为真时为 `undefined`）。 */
  code?: ErrorCode
  message?: string
}

/** 空白文本：视为“无表达式”，合法（默认值即空）。 */
function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
 * 编译期校验（7.6 的 `NumExprField` 与所有表达式文本字段共用）。
 *
 * @param text 表达式源码
 * @param context 求值上下文（5.5）：`field`/`price`/`production`/`condition`/`effect`
 */
export function checkExpression(text: string, context: ContextKind): ExpressionCheck {
  if (isBlank(text)) return { ok: true }
  const result = validateExpression(text, context)
  return result.ok ? { ok: true } : { ok: false, code: result.code as ErrorCode, message: result.message }
}

/** 上下文可用的内置函数（5.4 两列 + 5.5 权限的交集，5.8 悬浮提示用）。 */
export interface FunctionHint {
  name: string
  /** 参数个数描述，如 `2+`。 */
  arity: string
  random: boolean
  effect: boolean
}

/**
 * 列出某上下文**可调用**的函数（5.8「悬浮提示（可用变量/函数按当前字段上下文过滤）」）。
 *
 * 判据直接读 `BUILTIN_FUNCTIONS` 的 `priceAllowed`/`effect` 三个标志位——
 * 它们本身就是 5.5 权限表的投影（docs:check 规则 7 保证两者不漂移），
 * 因此这里**不**另写一份白名单。
 */
export function describeContext(context: ContextKind): FunctionHint[] {
  const hints: FunctionHint[] = []
  for (const fn of BUILTIN_FUNCTIONS.values()) {
    // 副作用函数只在 `effect` 上下文可用（5.5「副作用」列）；
    // 随机函数在**价格**上下文禁用，其余上下文（含 effect）可用（PRD 补充 1）。
    const usable = fn.effect ? context === 'effect' : context === 'price' ? fn.priceAllowed : true
    if (!usable) continue
    hints.push({
      name: fn.name,
      arity: `${fn.arity.min}${fn.arity.max === Infinity ? '+' : ''}`,
      random: fn.random,
      effect: fn.effect,
    })
  }
  return hints
}

/** 上下文的中文名（悬浮提示标题）。 */
export const CONTEXT_LABEL: Readonly<Record<ContextKind, string>> = {
  field: '常量字段',
  price: '购买价格',
  production: '产出数量',
  condition: '条件',
  effect: '升级效果（赋值）',
}

/** 试算结果（5.8「右侧显示求值结果与耗时」）。 */
export interface EvaluationPreview {
  /** 格式化后的求值结果。 */
  text: string
  /** 耗时（毫秒）。 */
  ms: number
  /** 试算失败的原因（运行时错误，如 `E_CYCLE`、last-good）。 */
  error?: string
}

/**
 * 在影子运行时里试算一段表达式（5.8）。
 *
 * 影子 `GameState` 与预览/打包版共用 `@iforge/runtime`（ADR-03），因此这里看到的
 * 数值与游戏内一致；无运行态时返回 `undefined`（UI 显示占位而不是 0，0 会被误读为“求值结果”）。
 *
 * **只求值右侧**：赋值类写法（`gen.g1.initial = 2 * gen.g1.owned`）的语义在 5.9.3 已定义为
 * “右侧先求值、不回写源码”，因此试算等价于对整段文本求值的结果（影子状态本身不落盘）。
 */
export function tryEvaluate(text: string, context: ContextKind): EvaluationPreview | undefined {
  if (isBlank(text)) return undefined
  const shadow = getShadow(useProjectStore.getState().project)
  return shadow.evaluate(text, context)
}

/**
 * 常用片段快捷插入（5.8「常用片段快捷插入」）。
 *
 * 片段是**当前条目自身属性**、**其它条目引用**与**随机函数**三类，PRD 未规定具体内容，
 * 这里按“最容易写错的写法”选取（例如价格成长、产出速率、条件阈值）。
 */
export interface ExpressionSnippet {
  label: string
  code: string
}

/** 构造某条目的片段（`pathPrefix` 形如 `gen.g1`）。 */
export function snippetsFor(pathPrefix: string): ExpressionSnippet[] {
  return [
    { label: '自身数量', code: `${pathPrefix}.owned` },
    { label: '自身已购买', code: `${pathPrefix}.bought` },
    { label: '等比价格 10·1.15^bought', code: `10 * 1.15 ^ ${pathPrefix}.bought` },
    { label: '线性价格 10+5·bought', code: `10 + 5 * ${pathPrefix}.bought` },
    { label: '条件阈值 bought ≥ 5', code: `${pathPrefix}.bought >= 5` },
    { label: '随机 0~1', code: 'rand()' },
    { label: '热替换源码', code: `set("${pathPrefix}.produces[0].amount", "2")` },
  ]
}
