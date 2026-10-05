/**
 * 价格形状识别与闭式求和（TECH_DESIGN 8.6 的 A 段、ADR-08、D-48、R-03、R-04）。
 *
 * ## 为什么值得单独一个模块
 *
 * 这一段是纯数学：不碰条目、不碰存储、不碰副作用，只吃一个 `j -> Decimal` 的价格函数。
 * 把它与批量求解（`batch.ts`）分开，好处是**可以脱离运行时单独验证**——14.2 要求
 * “闭式族四族与未见采样点复验”逐条断言，以及“改动未被采样的系数后必须识别失败”，
 * 这些用例只需构造几个 `PriceFn` 就能跑，不必搭一个完整项目。
 *
 * ## 定位：识别只是加速，绝不是正确性前提（8.6 的 A 段末句、D-48）
 *
 * 识别失败不是错误，只是退回逐级累加（受 tick 预算分摊）。因此本模块**不抛异常**，
 * 一律返回 `undefined` 并由调用方记 `E_BATCH_MONOTONE`。
 */
import { Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

/** 四个可闭式求和族（8.6 的 A 段、D-48）。 */
export type PriceShape =
  /** `P(j) = A` */
  | { family: 'constant'; a: Decimal }
  /** `P(j) = A·q^j` */
  | { family: 'geometric'; a: Decimal; q: Decimal }
  /** `P(j) = A·q^j + B` */
  | { family: 'geometricPlusConstant'; a: Decimal; q: Decimal; b: Decimal }
  /** `P(j) = A·q^j + B·j + C` */
  | { family: 'geometricPlusLinear'; a: Decimal; q: Decimal; b: Decimal; c: Decimal }
  /** `P(j) = A·j + B` */
  | { family: 'linear'; a: Decimal; b: Decimal }

/** 单件价格求值器：`j` 是 0 基的价格等级偏移。 */
export type PriceFn = (j: Decimal) => Decimal

/** 相对容差：复验的判定阈值（8.6 的 A 段：相对容差 1e-9）。 */
export const RELATIVE_TOLERANCE = 1e-9

/** 采样点倍率：`{0, h, 2h, 5h, 8h}`（8.6 的 A 段）。 */
export const SAMPLE_MULTIPLIERS = [0, 1, 2, 5, 8] as const

/** 复验点倍率：`{3h, 11h}` —— **未被采样**，防止“拟合对了采样点却错了整体”。 */
export const HOLDOUT_MULTIPLIERS = [3, 11] as const

/** 值是否已饱和/非有限（饱和值不适合当拟合参数，4.4）。 */
function isSaturated(value: Decimal): boolean {
  return value.isNan() || !Number.isFinite(value.toNumber())
}

/** 相对误差是否在容差内。 */
function closeEnough(predicted: Decimal, actual: Decimal): boolean {
  const diff = Num.abs(Num.sub(predicted, actual))
  const scale = Num.max(Num.abs(predicted), Num.abs(actual))
  if (scale.eq(0)) return diff.eq(0)
  return Num.div(diff, scale).toNumber() <= RELATIVE_TOLERANCE
}

/**
 * 识别价格形状（8.6 的 A 段、D-48）。
 *
 * ## 四族都是**解析可解**的，不需要数值搜索
 *
 * 设 `u = q^h`，采样点取 `j ∈ {0, h, 2h, 5h, 8h}`，记 `p0 = P(0)`、`ph = P(h)`、`p2h = P(2h)`。
 *
 * - ① `A·q^j`：`u = ph/p0`，`A = p0`。
 * - ④ `A·j + B`：`A = (ph − p0)/h`，`B = p0`。
 * - ② `A·q^j + B`：相邻差分 `d1 = ph−p0 = A(u−1)`、`d2 = p2h−ph = A·u(u−1)`，
 *   故 `u = d2/d1`、`A = d1/(u−1)`、`B = p0 − A`。
 * - ③ `A·q^j + B·j + C`：差分 `d1 = ph−p0`、`d2 = p2h−ph`（间距 `h`）与
 *   `d3 = p5h−p2h`、`d4 = p8h−p5h`（间距 `3h`），于是
 *   `d2−d1 = A(u−1)²`、`d4−d3 = A·u²(u³−1)²`。两式相除：
 *
 *   ```
 *   R = (d4−d3)/(d2−d1) = u²(u²+u+1)² = (u³+u²+u)²
 *   ⇒ u³ + u² + u = √R
 *   ```
 *
 *   这是一个在 `u > 0` 上**严格单调**的三次方程，正根唯一，牛顿迭代即可精确求解；
 *   随后 `A = (d2−d1)/(u−1)²`、`B = (d1 − A(u−1))/h`、`C = p0 − A`。
 *
 * ## 识别只是加速，必须复验（8.6 的 A 段末句、R-04）
 *
 * 拟合完在**未被采样**的 `j ∈ {3h, 11h}` 上复验残差（相对容差 `1e-9`），
 * 并额外要求采样点本身也全部命中。任一超差即判“未知形状”，调用方记 `E_BATCH_MONOTONE`
 * 并降级逐级累加。采样点出现递减或负价格同样直接判失败——单调性不成立时闭式再准也不该用。
 *
 * @returns 识别成功返回形状；否则 `undefined`（调用方记 `E_BATCH_MONOTONE` 并降级）。
 */
export function detectPriceShape(price: PriceFn, h: Decimal): PriceShape | undefined {
  const samples = SAMPLE_MULTIPLIERS.map((m) => {
    const j = Num.mul(h, Num.fromNumber(m))
    return { j, p: price(j) }
  })
  const p0 = samples[0]!.p
  const ph = samples[1]!.p
  const p2h = samples[2]!.p
  const p5h = samples[3]!.p
  const p8h = samples[4]!.p

  // 单调性与非负性检查：任一 `P(j) < P(j−1)` 或负价格即判“未知形状”（R-04）。
  for (let i = 0; i < samples.length; i += 1) {
    const current = samples[i]!.p
    if (current.lt(0)) return undefined
    if (i > 0 && current.lt(samples[i - 1]!.p)) return undefined
  }

  const candidates: PriceShape[] = []
  const one = Num.fromNumber(1)

  // ① 等比：`u = P(h)/P(0)`。
  if (!p0.eq(0)) {
    const u = Num.div(ph, p0)
    if (u.gt(0) && !u.isNan()) {
      candidates.push({ family: 'geometric', a: p0, q: rootOfU(u, h) })
    }
  }

  // ④ 线性：`P(j) = (P(h) − P(0))/h · j + P(0)`（`q → 1` 时 ① 的退化形式）。
  if (h.gt(0)) candidates.push({ family: 'linear', a: Num.div(Num.sub(ph, p0), h), b: p0 })

  // ② 指数 + 常数：`u = d2/d1`。
  const d1 = Num.sub(ph, p0)
  const d2 = Num.sub(p2h, ph)
  if (!d1.eq(0)) {
    const u = Num.div(d2, d1)
    const uMinusOne = Num.sub(u, one)
    if (u.gt(0) && !uMinusOne.eq(0)) {
      const a = Num.div(d1, uMinusOne)
      if (!a.isNan() && !isSaturated(a)) {
        candidates.push({ family: 'geometricPlusConstant', a, q: rootOfU(u, h), b: Num.sub(p0, a) })
      }
    }
  }

  // ③ 指数 + 线性 + 常数：先由 `u³ + u² + u = √R` 解出 `u`，再解线性三元组。
  //
  // 注意分子是 **`d4 − d3`**：`d3`/`d4` 各自含 `3Bh` 的线性项，必须先消掉才能得到
  // `A·u²(u³−1)²`。直接除 `d4` 会把线性项算进去，解出的 `u` 偏大、复验必然失败
  // ——这个错位表现为“族 ③ 永远识别不出来”，而 ①②④ 都正常，很容易被误判成数值精度问题。
  const d3 = Num.sub(p5h, p2h)
  const d4 = Num.sub(p8h, p5h)
  const gap12 = Num.sub(d2, d1)
  if (!gap12.eq(0) && h.gt(0)) {
    const target = Num.sqrt(Num.div(Num.sub(d4, d3), gap12))
    if (target.gt(0) && !target.isNan()) {
      const u = solveCubicU(target)
      const uMinusOne = Num.sub(u, one)
      if (u.gt(0) && !uMinusOne.eq(0)) {
        const a = Num.div(gap12, Num.mul(uMinusOne, uMinusOne))
        if (a.gt(0) && !isSaturated(a)) {
          const b = Num.div(Num.sub(d1, Num.mul(a, uMinusOne)), h)
          candidates.push({ family: 'geometricPlusLinear', a, q: rootOfU(u, h), b, c: Num.sub(p0, a) })
        }
      }
    }
  }

  for (const shape of candidates) {
    if (verifyShape(shape, price, h, samples)) return shape
  }
  return undefined
}

/** `u = q^h` -> `q`：`h = 0` 时无从定义，取 `q = 1`（退化为常数/线性族）。 */
function rootOfU(u: Decimal, h: Decimal): Decimal {
  if (h.eq(0)) return Num.fromNumber(1)
  return Num.pow(u, Num.div(Num.fromNumber(1), h))
}

/**
 * 解单调三次方程 `u³ + u² + u = target`（牛顿迭代）。
 *
 * `f(u) = u³ + u² + u − target` 在 `u > 0` 上严格单调递增，正根唯一且牛顿迭代收敛。
 * 初值取 `target^(1/3)`（忽略低阶项的近似），迭代 40 次即触到双精度极限。
 */
function solveCubicU(target: Decimal): Decimal {
  const one = Num.fromNumber(1)
  const three = Num.fromNumber(3)
  let u = Num.pow(target, Num.div(one, three))
  for (let i = 0; i < 40; i += 1) {
    const u2 = Num.mul(u, u)
    const f = Num.sub(Num.add(Num.add(u2, Num.mul(u, u2)), u), target)
    const df = Num.add(Num.mul(three, u2), Num.mul(Num.fromNumber(2), u))
    if (df.eq(0)) break
    const next = Num.sub(u, Num.div(f, df))
    if (!next.gt(0)) break
    if (Num.abs(Num.sub(next, u)).lt(Num.fromNumber(1e-15))) return next
    u = next
  }
  return u
}

/**
 * 复验：采样点与**未采样的** holdout 点（`3h` / `11h`）必须全部命中（相对容差 `1e-9`）。
 *
 * 把采样点也纳入判定是有意为之：拟合本来就该命中采样点，纳入判定可以把“拟合错族”
 * 挡在提交之前，而不只靠 holdout 兜底。
 */
function verifyShape(shape: PriceShape, price: PriceFn, h: Decimal, samples: ReadonlyArray<{ j: Decimal; p: Decimal }>): boolean {
  for (const sample of samples) {
    if (!closeEnough(evaluateShape(shape, sample.j), sample.p)) return false
  }
  for (const m of HOLDOUT_MULTIPLIERS) {
    const j = Num.mul(h, Num.fromNumber(m))
    if (!closeEnough(evaluateShape(shape, j), price(j))) return false
  }
  return true
}

/** 闭式求 `P(j)`。 */
export function evaluateShape(shape: PriceShape, j: Decimal): Decimal {
  switch (shape.family) {
    case 'constant':
      return shape.a
    case 'geometric':
      return Num.mul(shape.a, Num.pow(shape.q, j))
    case 'geometricPlusConstant':
      return Num.add(Num.mul(shape.a, Num.pow(shape.q, j)), shape.b)
    case 'geometricPlusLinear':
      return Num.add(Num.add(Num.mul(shape.a, Num.pow(shape.q, j)), Num.mul(shape.b, j)), shape.c)
    case 'linear':
      return Num.add(Num.mul(shape.a, j), shape.b)
  }
}

/**
 * `0 + 1 + … + (n−1) = n(n−1)/2`。
 *
 * **注意是 `n(n−1)` 而不是 `n(n+1)`**：`C(k)` 求的是 `j ∈ [0, k−1]` 的和，
 * 用 `n(n+1)/2` 会多算一项、把线性项整体抬高 `A·k`——对 `A·j + B` 这种常见价格
 * 就是系统性超收。
 */
function triangularSum(n: Decimal): Decimal {
  return Num.div(Num.mul(n, Num.sub(n, Num.fromNumber(1))), Num.fromNumber(2))
}

/** 闭式求前 `k` 件总价 `C(k)`（8.6 的 A 段四个公式）。 */
export function sumShape(shape: PriceShape, k: Decimal): Decimal {
  const n = k
  switch (shape.family) {
    case 'constant':
      return Num.mul(shape.a, n)
    case 'geometric':
      return geometricSum(shape.a, shape.q, n)
    case 'geometricPlusConstant':
      return Num.add(geometricSum(shape.a, shape.q, n), Num.mul(shape.b, n))
    case 'geometricPlusLinear': {
      // Σ A·q^j + B·(j + 1) + C，j ∈ [0, k−1] => Σ B·j = B·k(k−1)/2，B·k 项提出来。
      const linearTerm = Num.mul(shape.b, triangularSum(n))
      return Num.add(Num.add(geometricSum(shape.a, shape.q, n), linearTerm), Num.mul(shape.c, n))
    }
    case 'linear': {
      const triangular = triangularSum(n)
      return Num.add(Num.mul(shape.a, triangular), Num.mul(shape.b, n))
    }
  }
}

/**
 * 等比部分的求和 `A·(q^n − 1)/(q − 1)`；`q ≈ 1` 时退化为 `A·n`。
 *
 * `q − 1` 用 `|q−1| < 1e-12` 判定而不是 `eq(0)`：拟合出的 `q` 常常是 `1 ± 1e-16`
 * 这种“几乎为 1”的值，直接除会得到一个巨大的伪分母。
 */
function geometricSum(a: Decimal, q: Decimal, n: Decimal): Decimal {
  const qMinusOne = Num.sub(q, Num.fromNumber(1))
  if (Num.abs(qMinusOne).lt(Num.fromNumber(1e-12))) return Num.mul(a, n)
  return Num.div(Num.mul(a, Num.sub(Num.pow(q, n), Num.fromNumber(1))), qMinusOne)
}
