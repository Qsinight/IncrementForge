/**
 * 词法与解析用例（TECH_DESIGN 5.2 语法、5.6 管线、13 安全与沙箱、17.1 错误码）。
 *
 * 覆盖 14.2 中属于解析阶段的用例：字面量语法边界、`Infinity` 字面量、
 * 禁用 token、深度/预算上限、`create()` spec 的受限字面量。
 */
import { describe, expect, it } from 'vitest'
import { ForgeError } from '@iforge/num'

import { parse } from '../src/parser.js'
import { tokenize } from '../src/lexer.js'
import { MAX_DEPTH, MAX_LITERAL_DEPTH, MAX_LITERAL_ITEMS, MAX_TEXT_LENGTH } from '../src/limits.js'

/** 断言抛出指定错误码。 */
function expectCode(fn: () => unknown, code: string): ForgeError {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown, `期望抛出 ${code}，但没有抛错`).toBeInstanceOf(ForgeError)
  expect((thrown as ForgeError).code).toBe(code)
  return thrown as ForgeError
}

describe('5.2 数字字面量', () => {
  it('普通整数、小数、科学计数', () => {
    expect(() => parse('123')).not.toThrow()
    expect(() => parse('1.5')).not.toThrow()
    expect(() => parse('1e10')).not.toThrow()
    expect(() => parse('-2.5e-3')).not.toThrow()
  })

  it('分层指数 1e1e10（PRD 补充 2）', () => {
    expect(() => parse('1e1e10')).not.toThrow()
    expect(() => parse('1e1e1e10')).not.toThrow()
    const tokens = tokenize('1e1e10')
    expect(tokens[0]).toMatchObject({ type: 'number', value: '1e1e10' })
  })

  it('Infinity 是合法字面量，不得报 E_UNKNOWN_IDENT / E_PARSE（D-46、R-36）', () => {
    expect(() => parse('Infinity')).not.toThrow()
    expect(() => parse('max = Infinity')).not.toThrow()
    const error = expectCode(() => parse('1e1e10e'), 'E_PARSE')
    expect(error.code).toBe('E_PARSE')
  })

  it('单独一个小数点是非法语法', () => {
    expectCode(() => parse('.'), 'E_PARSE')
  })
})

describe('5.2 字符串字面量', () => {
  it('只用双引号，支持转义', () => {
    expect(() => parse('"文本"')).not.toThrow()
    expect(() => parse('"a\\"b"')).not.toThrow()
    expect(() => parse('"a\\\\b"')).not.toThrow()
    expect(() => parse('"a\\nb"')).not.toThrow()
  })

  it('单引号不是字符串定界符，报 E_PARSE', () => {
    expectCode(() => parse("'abc'"), 'E_PARSE')
  })

  it('未闭合字符串报 E_PARSE', () => {
    expectCode(() => parse('"abc'), 'E_PARSE')
  })
})

describe('13 第 1 条 / 5.6：禁用 token', () => {
  it('分号、箭头函数、import、await 一律 E_FORBIDDEN_TOKEN', () => {
    expectCode(() => parse('1; 2'), 'E_FORBIDDEN_TOKEN')
    expectCode(() => parse('x => x'), 'E_FORBIDDEN_TOKEN')
    expectCode(() => parse('import'), 'E_FORBIDDEN_TOKEN')
    expectCode(() => parse('await'), 'E_FORBIDDEN_TOKEN')
  })

  it('属性原型链在词法层直接拒绝', () => {
    expectCode(() => parse('__proto__'), 'E_FORBIDDEN_TOKEN')
    expectCode(() => parse('gen.g1.constructor'), 'E_FORBIDDEN_TOKEN')
    expectCode(() => parse('gen.g1.prototype'), 'E_FORBIDDEN_TOKEN')
  })

  it('反引号不是字符串定界符', () => {
    expectCode(() => parse('`abc`'), 'E_FORBIDDEN_TOKEN')
  })
})

describe('5.2 优先级与结合性', () => {
  it('算术优先级', () => {
    expect(() => parse('1 + 2 * 3')).not.toThrow()
    expect(() => parse('(1 + 2) * 3')).not.toThrow()
    expect(() => parse('1 - 2 - 3')).not.toThrow()
  })

  it('幂右结合（5.2 `power` 行）', () => {
    expect(() => parse('2 ^ 3 ^ 2')).not.toThrow()
  })

  it('比较与逻辑', () => {
    expect(() => parse('a == 1 && b != 2')).not.toThrow()
    expect(() => parse('a === 1 || b !== 2')).not.toThrow()
    expect(() => parse('a < 1 && b <= 2 && c > 3 && d >= 4')).not.toThrow()
  })

  it('语言无语句：表达式后多余内容报 E_PARSE', () => {
    expectCode(() => parse('1 2'), 'E_PARSE')
    expectCode(() => parse('1 + 2)'), 'E_PARSE')
  })

  it('没有三元运算符（5.1：无语句，语法未定义三元）', () => {
    expectCode(() => parse('true ? 1 : 2'), 'E_PARSE')
  })

  it('意外结尾报 E_PARSE', () => {
    expectCode(() => parse('1 +'), 'E_PARSE')
    expectCode(() => parse(''), 'E_PARSE')
  })
})

describe('5.2 路径语法', () => {
  it('四种前缀 + id + 属性', () => {
    expect(() => parse('res.r1.amount')).not.toThrow()
    expect(() => parse('gen.g1.bought')).not.toThrow()
    expect(() => parse('up.u1.owned')).not.toThrow()
    expect(() => parse('page.p1.visible')).not.toThrow()
  })

  it('列表下标链', () => {
    expect(() => parse('gen.g1.costs[0].materialId')).not.toThrow()
    expect(() => parse('gen.g1.produces[0].amount')).not.toThrow()
    expect(() => parse('up.u1.effectValues[0]')).not.toThrow()
  })

  it('下标只接受整数字面量（编译期需静态判定越界，5.9.3）', () => {
    expectCode(() => parse('gen.g1.costs[i].amount'), 'E_PARSE')
    expectCode(() => parse('gen.g1.costs[0+1].amount'), 'E_PARSE')
  })

  it('非路径前缀的属性访问报 E_UNKNOWN_IDENT', () => {
    expectCode(() => parse('foo.bar.baz'), 'E_UNKNOWN_IDENT')
  })

  it('路径缺少 id 报 E_PARSE', () => {
    expectCode(() => parse('gen..amount'), 'E_PARSE')
    expectCode(() => parse('gen.amount'), 'E_PARSE')
  })
})

describe('5.2 约束表：受限字面量', () => {
  it('create() 的 spec 允许对象/数组字面量（PRD 升级编辑器 12）', () => {
    expect(() => parse('create("upgrade", { name: "x", page: "p1", costs: [{ materialId: "r1", amount: "10" }] })')).not.toThrow()
  })

  it('字面量出现在价格/条件/set() 等位置一律 E_LITERAL_NOT_ALLOWED', () => {
    expectCode(() => parse('{ a: 1 }'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('[1, 2]'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('1 + { a: 1 }'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('set("gen.g1.bought", { a: 1 })'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('1 + [1]'), 'E_LITERAL_NOT_ALLOWED')
  })

  it('字面量只允许在 create 的第二个实参内', () => {
    expectCode(() => parse('create({ name: "x" })'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('create("upgrade", { name: "x" }, { a: 1 })'), 'E_LITERAL_NOT_ALLOWED')
    expectCode(() => parse('min({ a: 1 }, 2, 3)'), 'E_LITERAL_NOT_ALLOWED')
  })

  it('spec 的键必须是字符串字面量或标识符（不支持计算键名）', () => {
    expectCode(() => parse('create("upgrade", { 1: "x", page: "p1" })'), 'E_PARSE')
  })

  it('不支持展开运算符 ...（E_PARSE）', () => {
    expectCode(() => parse('create("upgrade", { ...other, page: "p1" })'), 'E_PARSE')
  })

  it('允许尾逗号', () => {
    expect(() => parse('create("upgrade", { name: "x", page: "p1", })')).not.toThrow()
  })

  it('字面量嵌套超过 4 层报 E_PARSE_DEPTH（5.2 约束表「嵌套深度」行）', () => {
    // spec 对象本身占第 1 层，再嵌 4 层数组即达到上限，第 5 层必须被拒。
    const tooDeep = `create("upgrade", { page: "p1", a: ${'['.repeat(MAX_LITERAL_DEPTH)}${']'.repeat(MAX_LITERAL_DEPTH)}1${']'.repeat(MAX_LITERAL_DEPTH)} })`
    expectCode(() => parse(tooDeep), 'E_PARSE_DEPTH')
  })

  it('字面量嵌套恰好 4 层可编译', () => {
    const ok = `create("upgrade", { page: "p1", a: ${'['.repeat(MAX_LITERAL_DEPTH - 1)}1${']'.repeat(MAX_LITERAL_DEPTH - 1)} })`
    expect(() => parse(ok)).not.toThrow()
  })

  it('单数组超过 64 项报 E_BUDGET（5.2 约束表「数组长度」行）', () => {
    const items = Array.from({ length: MAX_LITERAL_ITEMS + 1 }, (_, i) => `"r${i}"`).join(', ')
    expectCode(() => parse(`create("upgrade", { page: "p1", conditions: [${items}] })`), 'E_BUDGET')
  })

  it('恰好 64 项可编译', () => {
    const items = Array.from({ length: MAX_LITERAL_ITEMS }, (_, i) => `"r${i}"`).join(', ')
    expect(() => parse(`create("upgrade", { page: "p1", conditions: [${items}] })`)).not.toThrow()
  })
})

describe('5.6 资源上限', () => {
  it('文本长度超过 2000 字符报 E_BUDGET', () => {
    const long = `1 + ${'1 + '.repeat(700)}1`
    expect(long.length).toBeGreaterThan(MAX_TEXT_LENGTH)
    expectCode(() => parse(long), 'E_BUDGET')
  })

  it('嵌套深度超过 64 层报 E_PARSE_DEPTH', () => {
    const deep = `${'('.repeat(MAX_DEPTH + 2)}1${')'.repeat(MAX_DEPTH + 2)}`
    expectCode(() => parse(deep), 'E_PARSE_DEPTH')
  })

  it('恰好 64 层可编译', () => {
    const ok = `${'('.repeat(MAX_DEPTH - 1)}1${')'.repeat(MAX_DEPTH - 1)}`
    expect(() => parse(ok)).not.toThrow()
  })
})

describe('5.6 token 区间', () => {
  it('每个 token 都带 [start, end) 区间，供 5.8 错误定位使用', () => {
    const tokens = tokenize('gen.g1.bought + 10')
    const nonEof = tokens.filter((t) => t.type !== 'eof')
    for (const token of nonEof) {
      expect(token.start).toBeGreaterThanOrEqual(0)
      expect(token.end).toBeGreaterThan(token.start)
    }
  })

  it('解析错误携带 span', () => {
    const error = expectCode(() => parse('1 +'), 'E_PARSE')
    expect(error.span).toBeDefined()
    expect(error.span!.start).toBeGreaterThanOrEqual(0)
  })
})
