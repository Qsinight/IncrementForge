/**
 * 「反物质维度（增量工坊学习版）」的**端到端**回归（真浏览器、真布局、真运行时）。
 *
 * 单测能守住数值，量不到布局；布局断言只放在这一层。数值侧的同族断言在
 * `packages/runtime/test/dimension-project.test.ts` 与
 * `apps/runtime-shell/test/buy-button.test.tsx`。
 *
 * | 缺陷 | 现象 | 本文件的断言 |
 * | --- | --- | --- |
 * | 1 | 升级效果的“效果前提/效果内容”显示区域过窄 | 两个字段各占一行、宽度接近整块编辑区 |
 * | 2 | 第一次点购买后按钮一直显示“计算中…” | 连续点击后按钮始终是“购买 ×N” |
 * | 3 | 第二个及以后的生成器买不了 | 卡片价格随 `g1.bought` 跳台阶，且真的买得到 |
 * | 4 | 基于 `up.u2.effectValues[i]` 的**产出表达式**乘不上倍率 | 走满 8 档后卡片“每秒”真的乘 1.5 |
 * | 5 | 成就页里基于“下一档”条件的 `购买维度` **买不了** | 条件为真时按钮可用，且点下去 `bought` +1 |
 *
 * ## 为什么缺陷 4 / 5 用 `docs/` 里的项目而不是示例项目
 *
 * 它们都只在“表达式引用**别的条目**”时才显形，而维度跃迁类项目恰好全都这么写：
 * ```
 * g1.produces[0].amount = (2^(…))*(up.u2.effectValues[0]+1)
 * u2.conditions[0]       = (up.u2.bought==0 && gen.g1.bought>=1) || (up.u2.bought==1 && gen.g2.bought>=1) || …
 * ```
 * 示例项目全部写 `gen.<自己>.bought` 与阈值型条件 `gen.<自己>.bought >= n`，用它做断言必然全绿，
 * 而真机上作者用的正是这两种写法。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, importProjectFile, previewFrame, test, waitForPreviewReady } from './fixtures.js'

/** 定位 `docs/` 下那份项目文件（文件名含中文与全角括号，不硬编码）。 */
function dimensionProjectFile(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const docs = join(dir, 'docs')
    if (existsSync(docs)) {
      const file = readdirSync(docs).find((name) => name.endsWith('.json'))
      if (file) return join(docs, file)
    }
    dir = dirname(dir)
  }
  throw new Error(`从 ${process.cwd()} 向上找不到 docs/*.json`)
}

/** 预览 iframe 里某个条目卡片。 */
function gameCard(page: Page, id: string) {
  return previewFrame(page).locator(`[data-entry="${id}"]`)
}

function buyButton(page: Page, id: string) {
  return gameCard(page, id).getByTestId('buy-button')
}

/** 打开功能区并选中一行（与 `editor-authoring.spec.ts` 同构）。 */
async function selectEntry(page: Page, nav: string, id: string): Promise<void> {
  await page.getByTestId(nav).click()
  await page.getByTestId(`entry-${id}`).click()
}

/**
 * 通过生成器编辑器改写某个生成器的“购买价格”与“产出”（走 7.4 的 `host:patch`，
 * 顺带验一遍热更新到预览）。
 *
 * 项目的价格是 `10*(1000^floor(bought/10))` 这类台阶，开局那 10 反物质只够买 1 台；
 * 断言 `bought == 10`、`bought >= 1` 之类就会依赖“攒了多久”，既慢又不确定。改成 1 之后
 * 一次点击就买满一批，断言因此是确定性的。
 *
 * `produce = '0'` 用来**掐断产出**：`g2`~`g8` 的产出目标都是别的生成器，不掐断的话
 * `owned` 会在断言窗口里一直涨，卡片上的“每秒”就不是一个可断言的确定值。
 */
async function configureGenerator(page: Page, id: string, fields: { cost?: string; produce?: string }): Promise<void> {
  await selectEntry(page, 'nav-generators', id)
  const field = (label: string) =>
    page
      .locator('.numexpr')
      .filter({ has: page.getByRole('textbox', { name: label }) })
      .getByRole('textbox')
  if (fields.cost !== undefined) await field('购买价格 1 · 数量').fill(fields.cost)
  if (fields.produce !== undefined) await field('产出资源 1 · 数量').fill(fields.produce)
  // 热更新是即时同步的（7.4），等卡片真的变掉再继续。
  if (fields.cost !== undefined) await expect(gameCard(page, id).getByTestId('costs')).toContainText(fields.cost)
}

test.describe('缺陷 1：升级效果的“效果前提 / 效果内容”要够宽（上下排列）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
  })

  test('两个表达式字段各占一整行，宽度接近整个效果编辑块', async ({ page }) => {
    await importProjectFile(page, dimensionProjectFile())
    await selectEntry(page, 'nav-upgrades', 'u1')
    // 该项目开局没有效果，点“+ 升级效果”加一条（PRD 升级编辑器 12）。
    await page.getByRole('button', { name: '+ 升级效果' }).click()
    const effect = page.getByTestId('effect-0')
    await expect(effect).toBeVisible()

    const condition = effect.locator('> .numexpr').nth(0)
    const action = effect.locator('> .numexpr').nth(1)
    const box = (await effect.boundingBox())!
    const conditionBox = (await condition.boundingBox())!
    const actionBox = (await action.boundingBox())!

    // **上下排列**：第二个字段在第一个字段下方，不在同一行。
    expect(actionBox.y, '“效果内容”应在“效果前提”下方').toBeGreaterThan(conditionBox.y)
    // **够宽**：两个字段都拿到编辑块的整幅宽度（原先各只有 ~120px，因为
    // `1fr 1fr auto auto` 四列把“效果数值 + 模板”那格的 140px 下限先吃掉了）。
    for (const [name, width] of [
      ['效果前提', conditionBox.width],
      ['效果内容', actionBox.width],
    ] as const) {
      expect(width, `${name} 的宽度`).toBeGreaterThan(box.width * 0.8)
    }
    // 表达式文本仍完整可见（横向不再被挤到需要横向滚动）。
    const textarea = condition.getByRole('textbox')
    const textWidth = await textarea.evaluate((node) => node.scrollWidth)
    const clientWidth = await textarea.evaluate((node) => node.clientWidth)
    expect(textWidth).toBeLessThanOrEqual(clientWidth + 1)
  })

  test('加到三条效果时每条都是单列纵向，互不影响', async ({ page }) => {
    await importProjectFile(page, dimensionProjectFile())
    await selectEntry(page, 'nav-upgrades', 'u1')
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: '+ 升级效果' }).click()
    for (let i = 0; i < 3; i += 1) {
      const effect = page.getByTestId(`effect-${i}`)
      await expect(effect).toBeVisible()
      const boxes = await effect.locator('> .numexpr').evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width }
        }),
      )
      expect(boxes).toHaveLength(2)
      // 同一列（x 相同）、不同行（y 递增）。
      expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y)
      expect(Math.abs(boxes[1]!.x - boxes[0]!.x)).toBeLessThan(2)
      expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width * 0.9)
    }
  })
})

test.describe('缺陷 2 / 3：预览里的购买按钮（「反物质维度」项目）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
    await importProjectFile(page, dimensionProjectFile())
    // 时间倍速 10×：产出快一点，少等几个数量级。
    await page.getByTestId('preview-speed').selectOption('10')
  })

  test('连续点击购买，按钮始终是“购买 ×N”，从不显示“计算中…”', async ({ page }) => {
    // 开局 10 反物质、g1 单件 10 -> 只够 1 台。
    const button = buyButton(page, 'g1')
    await expect(button).toBeVisible()
    for (let round = 0; round < 3; round += 1) {
      await expect(button, `第 ${round + 1} 轮点击前`).not.toContainText('计算中')
      if (await button.isEnabled()) await button.click()
      await expect(buyButton(page, 'g1'), `第 ${round + 1} 轮点击后`).not.toContainText('计算中')
    }
    // “计算中…”在整个预览里都不该出现。
    await expect(previewFrame(page).locator('text=计算中')).toHaveCount(0)
  })

  test('第二个及以后的生成器：买满一批后价格跳台阶，且按钮说的件数就是买到的件数', async ({ page }) => {
    // 开局：g2 单件 100、批量 10 -> 合计 1000。
    await expect(gameCard(page, 'g2')).toBeVisible()
    await expect(gameCard(page, 'g2').locator('.cost-amount').first()).toHaveText('1000')

    // 先用“解锁全部”把隐藏条目也放出来，避免断言依赖 `visible` 表达式。
    await page.getByTestId('preview-unlock').click()
    await expect(gameCard(page, 'g4')).toBeVisible()

    // 把 g1 的单件价格改成 1、单件产出改成 1e6：于是开局那 10 反物质**一次点击**就买满
    // 10 台，而 10 台 × 1e6 的产出让 1000（乃至更高台阶）的 g2 一两秒内就买得起。
    // 靠等产出自然攒够既慢又依赖时序，不是确定性断言；顺带也走了一遍 7.4 的
    // `host:patch`（改价格/产出文本热更新到预览）。
    await selectEntry(page, 'nav-generators', 'g1')
    const exprFieldIn = (label: string) =>
      page
        .locator('.numexpr')
        .filter({ has: page.getByRole('textbox', { name: label }) })
        .getByRole('textbox')
    await exprFieldIn('购买价格 1 · 数量').fill('1')
    await exprFieldIn('产出资源 1 · 数量').fill('1e6')
    // 价格改成 1 之后，g1 卡片上这一批（10 台）的合计应当是 10。
    await expect(gameCard(page, 'g1').getByTestId('costs')).toContainText('10')

    await buyButton(page, 'g1').click()
    await expect(gameCard(page, 'g1').getByTestId('bought-value')).toHaveText('10')

    // 等产出攒够 1000（自动重试，不依赖固定 sleep）。
    const g2 = buyButton(page, 'g2')
    await expect(g2).toBeEnabled({ timeout: 60_000 })
    // 按钮说的件数（`data-count`）必须等于点下去真的买到几件——**按钮不许说谎**。
    const promised = Number(await g2.getAttribute('data-count'))
    await g2.click()
    await expect(gameCard(page, 'g2').getByTestId('bought-value')).toHaveText(String(promised))
    // `floor(gen.g2.bought / 10)` 由 0 变 1 后，g2 自己的价格跳一个台阶：
    // 修复前它永远停在开局的 1000，于是按钮亮着、写着“购买 ×10”、点下去却结算 0 件。
    await expect(gameCard(page, 'g2').locator('.cost-amount').first()).toHaveText('10M')
  })

  test('材料不够时按钮禁用并写明是材料不足（不是点了没反应的死按钮）', async ({ page }) => {
    // 刚开局：10 反物质买不起 10 件的 g2（要 1000）。
    const button = buyButton(page, 'g2')
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', /材料不足/)
    // 价格仍然显示，作者据此知道差多少（价格行里同时有材料名与数量，故用 `toContainText`）。
    await expect(gameCard(page, 'g2').getByTestId('costs')).toContainText('1000')
  })

  test('只够一部分时按钮写当前买得起的件数', async ({ page }) => {
    await expect(buyButton(page, 'g1')).toHaveAttribute('data-request', '10')
    // 开局 10 反物质、单价 10 -> 恰好 1 件。
    await expect(buyButton(page, 'g1')).toHaveAttribute('data-count', '1')
    await expect(buyButton(page, 'g1')).toHaveText('购买 ×1')
  })
})

/**
 * 缺陷 5（成就页）：基于“下一档”条件的 `购买维度` 买不了。
 *
 * ## 现象
 *
 * `u2` 的条件是
 * ```
 * (up.u2.bought==0 && gen.g1.bought>=1) || (up.u2.bought==1 && gen.g2.bought>=1) || … || (up.u2.bought==7 && gen.g8.bought>=1)
 * ```
 * 即“第 `k` 件按 `up.u2.bought == k` 判定，并要求第 `k+1` 个生成器”。
 *
 * 求解器曾把条件读在“成交**之后**一级”（`bought + j`，`j ∈ [1, k]`），于是条件永远要求
 * **再往后一档**的生成器：条件那一行打勾、按钮亮着、写着“购买 ×1”，点下去却结算 0 件。
 * 按钮与卡片件数因此在**说谎**（`buyCount` 用的是成交时的等级，求解器用的是成交后的）。
 *
 * 更要命的是连锁反应：`u2.max = 8`，而只有买到第 8 件才会触发那 8 条 `effValue = 0.5`
 * 的效果；`u2` 永远到不了 8，`up.u2.effectValues[i]` 就永远是 0，于是每个生成器的
 * 产出表达式 `(2^(…))*(up.u2.effectValues[i]+1)` 里的倍率**永远乘不上**——这正是缺陷 4。
 */
test.describe('缺陷 5：成就页里基于“下一档”条件的升级买不了', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
    await importProjectFile(page, dimensionProjectFile())
    // 时间倍速 10×：产出快一点，少等几个数量级。
    await page.getByTestId('preview-speed').selectOption('10')
  })

  test('条件为真且按钮可用时，点下去“已购买数量”必须真的 +1', async ({ page }) => {
    // 把 g1 的价格改成 1，开局那 10 反物质就够一次买满 10 台
    // （`bought = 10` 让 `gen.g1.bought >= 1` 稳定成立，断言不依赖“攒了多久”）。
    await configureGenerator(page, 'g1', { cost: '1' })
    const g1 = buyButton(page, 'g1')
    await expect(g1).toBeEnabled()
    await g1.click()
    await expect(gameCard(page, 'g1').getByTestId('bought-value')).toHaveText('10')

    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    const u2 = gameCard(page, 'u2')
    await expect(u2).toBeVisible()

    // 条件那一行必须是“成立”（打勾而不是打叉）。
    await expect(u2.locator('.condition')).toHaveClass(/true/)
    const button = buyButton(page, 'u2')
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute('data-count', '1')
    await expect(u2.getByTestId('bought-value')).toHaveText('0')

    // 修复前：点下去 bought 仍是 0（按钮说谎）。
    await button.click()
    await expect(u2.getByTestId('bought-value')).toHaveText('1')
  })

  test('条件不成立时按钮禁用并写明是条件未满足（不是点了没反应）', async ({ page }) => {
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    const u2 = gameCard(page, 'u2')
    await expect(u2).toBeVisible()
    // 还没买 g1 -> `gen.g1.bought >= 1` 不成立。
    await expect(u2.locator('.condition')).toHaveClass(/false/)
    const button = buyButton(page, 'u2')
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', /条件/)
  })

  test('缺陷 4：产出表达式的倍率因子随 `up.u2.effectValues[i]` 生效', async ({ page }) => {
    // 通过“解锁全部”把隐藏的 g5~g8 放出来（它们平时由 u1 的效果解锁），
    // 这样一条用例就能把 `u2` 的 8 档走完——不必模拟“买满 g4 的 20 台”那条更长的支线。
    await page.getByTestId('preview-unlock').click()
    // 价格都改成 1：开局那 10 反物质够买 g1，之后靠 g1 自己的产出慢慢喂后面的（20/s，倍速 10×）。
    await configureGenerator(page, 'g1', { cost: '1' })
    // `g2`~`g8` 的产出改成 0：掐断“生成器产出生成器”那条链，它们的 `owned` 于是稳定在 10，
    // `g1.owned` 也跟着稳定 —— 否则卡片上的“每秒”会在断言窗口里一直涨，不是确定值。
    // `g1` 的产出表达式**必须保持原样**（它正是被观察的对象）。
    for (const id of ['g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) {
      await configureGenerator(page, id, { cost: '1', produce: '0' })
    }

    await previewFrame(page).getByTestId('nav-item').nth(0).click()
    for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) {
      const button = buyButton(page, id)
      await expect(button, `${id} 的购买按钮`).toBeEnabled()
      await button.click()
      await expect(gameCard(page, id).getByTestId('bought-value'), `${id} 的已购买数量`).toHaveText('10')
    }

    // g1 买满 10 台 -> 单件速率 `2^1 * (0 + 1) = 2`，卡片“每秒”= 10 × 2 = 20。
    const perSec = async () => (await gameCard(page, 'g1').getByTestId('output').innerText()).replace(/\s+/g, ' ')
    await expect(gameCard(page, 'g1').getByTestId('owned-value')).toHaveText('10')
    await expect(perSec).resolves.toBe('每秒 20')

    // 走满 `u2` 的 8 档（max = 8）。条件是逐档推进的，因此每买一件都要等一拍。
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    const u2 = gameCard(page, 'u2')
    for (let level = 1; level <= 8; level += 1) {
      const button = buyButton(page, 'u2')
      await expect(button, `第 ${level} 档按钮`).toBeEnabled()
      await button.click()
      await expect(u2.getByTestId('bought-value')).toHaveText(String(level))
    }

    // 第 8 件的效果（8 条 `effValue = 0.5`）在**下一个提交阶段**落地（8.3.1 的单一提交点）。
    await previewFrame(page).getByTestId('nav-item').nth(0).click()
    // 单件速率 `2^1 * (0.5 + 1) = 3` -> 每秒 30。修复前这一项永远是 20。
    await expect.poll(perSec, { timeout: 30_000 }).toBe('每秒 30')
  })
})
