/**
 * `@iforge/expr` —— 表达式沙箱（TECH_DESIGN 5）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime`。本包只依赖 `@iforge/num`，
 * 不导入任何 DOM API，不引入其它 `@iforge/*` 包。
 *
 * 管线（5.6）：`源码 → Lexer → Parser(Pratt) → AST → StaticChecker → ClosureCompiler → CompiledExpr`，
 * 求值与调度能力由 `Evaluator` 提供（5.7）。
 *
 * 本包**不含**运行时状态机（tick/购买/升级/离线，属 `@iforge/runtime`，M2），
 * 也不含编辑器 UI（属 `apps/editor`，M3）。M1 的交付物是编译期与求值期的全部语义，
 * 以及 14.2 中属于本里程碑的用例。
 */
export * from './ast.js'
export * from './lexer.js'
export * from './limits.js'
export * from './parser.js'
export * from './properties.js'
export * from './create-spec.js'
export * from './functions.js'
export * from './random.js'
export * from './checker.js'
export * from './compiler.js'
export * from './effects.js'
export * from './evaluator.js'

import type { ContextKind } from './ast.js'
import { Evaluator } from './evaluator.js'
import { parse as parseExpression } from './parser.js'

/**
 * 一次性检查表达式是否可编译，不产生求值产物。
 *
 * 供 11.1 打包前检查与编辑器实时校验（5.8「实时校验」）使用：只跑
 * `Lexer → Parser → StaticChecker`，返回错误码与位置，不进入闭包编译。
 */
export function validateExpression(
  text: string,
  context: ContextKind,
): { ok: true } | { ok: false; code: string; message: string; span?: { start: number; end: number } } {
  try {
    const ast = parseExpression(text)
    const evaluator = new Evaluator(context, { read: () => 'unreachable', emit: () => 'unreachable' })
    evaluator.compile(text)
    void ast
    return { ok: true }
  } catch (error) {
    if (isCodeError(error)) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.span ? { span: error.span } : {}),
      }
    }
    return { ok: false, code: 'E_PARSE', message: error instanceof Error ? error.message : String(error) }
  }
}

function isCodeError(error: unknown): error is { code: string; message: string; span?: { start: number; end: number } } {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
}
