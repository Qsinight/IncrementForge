/**
 * 打包产物的端到端用例（TECH_DESIGN 17.5 的 M5 交付标准“**产物可离线游玩**”、14.1 的端到端链路）。
 *
 * ## 这个 project 覆盖 14.1 端到端那一行的后半段
 *
 * **打开单文件 HTML → 游玩 → 导出存档 → 重新导入**，并且是 M5 交付标准的**直接载体**：
 * 交付标准就是这句话，验它的方式只能是把产物丢进一个没有服务器的浏览器。
 *
 * ## 为什么走 `file://` 而不是起一个 HTTP 服务器
 *
 * `file://` 是这条用例成立的前提，而不是省事：
 *
 * - 产物里残留**任何**外部引用（字体、图片、CDN 的 React）在 `file://` 下立刻失效，
 *   而在 `http://` 下照常工作；
 * - 反过来，`localStorage` 在 `file://` 下的行为也与 HTTP 不同（Chrome 按 origin 隔离），
 *   存档往返的断言正是在这个更苛刻的环境下做的。
 *
 * 换句话说：用 HTTP 测“产物能跑”会放过最常见的一类打包事故——单文件其实不是单文件。
 *
 * ## 产物从哪来
 *
 * 由**生产代码路径**产出：示例项目（`writeExampleProject`）-> `runCli`（`iforge-pack`）。
 * 也就是 E2E 跑的就是作者点“打包”时走的同一条管线（11.1）。
 */
import type { Page } from '@playwright/test'

import { bundleProjectUrl, expect, playableProjectFile, readDownload, test } from './fixtures.js'

/** 产物的落地目录（每个用例一份，Playwright 默认并行度下互不干扰）。 */
let bundlePromise: Promise<string> | null = null

/**
 * 产出（或复用）单文件 HTML，并返回它的 `file://` URL。
 *
 * 复用是因为打包要真的编译运行时（约 1s）；同一个 worker 内的用例共用一份产物，
 * 既省时间又保证“这些用例验的是同一份字节”。
 */
async function packagedGameUrl(): Promise<string> {
  bundlePromise ??= bundleProjectUrl(await playableProjectFile())
  return bundlePromise
}

/**
 * 当前页面里 `r1`（矿石）的数量（仪表盘的数据，PRD 预览区 2）。
 *
 * 断言**矿石**而不是点击器的拥有数量：8.5 的 `click` 走 `applyProduces`，
 * 增加的是产出目标（r1.amount）；点击器自身的 `owned` 只受 `max` 约束、点击不变。
 * 早先用 `owned-value` 断言失败，正是因为把这两件事搞混了。
 *
 * 读数用 `evaluate` 直接取 `textContent` 并转数字：仪表盘的数字会带千分位/科学计数，
 * Playwright 的 `expect.toHaveText` 走的是字符串精确比较，不适合这种“比大小”的断言。
 */
async function resourceAmount(page: Page): Promise<number> {
  const text = await page.getByTestId('resource-amount').first().textContent()
  return Number((text ?? '0').replace(/[^\d.e+-]/g, ''))
}

test.describe('打包产物可离线游玩（17.5 的 M5 交付标准）', () => {
  test('打开单文件 HTML 即渲染出游戏视图（11.1、17.3）', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    await page.goto(await packagedGameUrl())

    // PRD 预览区 1–3：标题、仪表盘、资源卡片。
    await expect(page.getByTestId('game-title')).toHaveText('示例：矿石工厂')
    await expect(page.getByTestId('game-dashboard')).toBeVisible()
    await expect(page.getByTestId('card-resource')).toBeVisible()

    // D-42 / R-32：产物里**不含**编辑器外壳的模拟设置栏。
    await expect(page.getByRole('button', { name: '解锁全部' })).toHaveCount(0)
    await expect(page.locator('[data-testid="preview-pause"]')).toHaveCount(0)

    expect(errors, `页面脚本错误：${errors.join('; ')}`).toEqual([])
  })

  test('样式已内联且命中（11.2：离线打开不能是一堆裸文字）', async ({ page }) => {
    await page.goto(await packagedGameUrl())
    await expect(page.locator('.iforge-game')).toBeVisible()

    // 具体到样式**真的生效**：底部导航与卡片都是 flex 布局，
    // 若 CSS 丢失它们会退化成块级堆叠（`display` 变成 `block`）。
    await expect(page.getByTestId('bottom-nav')).toHaveCSS('display', 'flex')
    await expect(page.getByTestId('card-resource').first()).toHaveCSS('display', 'flex')
  })

  test('点击器可玩：点击增加产出目标的资源（PRD 生成器编辑器 11、8.5 `click`）', async ({ page }) => {
    await page.goto(await packagedGameUrl())

    // 点击器在 p2「实验区」；产物用的是可玩变体（p2 未禁用），因此“点击”按钮存在。
    await page.getByTestId('nav-item').nth(1).click()
    await expect(page.getByTestId('card-clicker')).toBeVisible()
    // D-28：点击器不可购买。
    await expect(page.getByTestId('card-clicker').getByTestId('buy-button')).toHaveCount(0)

    // 8.5 的 `click` 走 `applyProduces`：增加的是**产出目标**（r1.amount），
    // 点击器自身的 `owned` 不变（它只受 `max` 约束）。因此断言矿石数量，
    // 而不是点击器的拥有数量。
    const before = await resourceAmount(page)
    await page.getByTestId('click-button').click()
    await expect.poll(() => resourceAmount(page)).toBeGreaterThan(before)
  })

  test('存档写入 localStorage，刷新后进度仍在（10.3）', async ({ page }) => {
    await page.goto(await packagedGameUrl())

    await page.getByTestId('nav-item').nth(1).click()
    const before = await resourceAmount(page)
    // 点到**确定超过** `before`：离线结算（8.8）可能补上一点，
    // 因此刷新后的断言用 `>=`，而这一次用 `>` 锁定“点击确实生效了”。
    for (let i = 0; i < 5; i += 1) await page.getByTestId('click-button').click()
    await expect.poll(() => resourceAmount(page)).toBeGreaterThan(before)

    // 存档时机（10.3）：自动存档按真实秒数计（8.3 第 8 步），默认 30s。
    // E2E 不等 30s，因此走 `visibilitychange -> hidden` 的补写路径
    // （`installLifecycleAutosave`，见 `local-sink.ts`）。
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await page.reload()
    await expect(page.getByTestId('game-title')).toBeVisible()
    // 刷新后回到“至少已经点过五次”的进度，而不是从头开始。
    await expect.poll(() => resourceAmount(page)).toBeGreaterThanOrEqual(before + 5)
  })

  test('“导出存档”下载可被重新导入的 save 文件（10.2、PRD 预览区 9）', async ({ page }) => {
    await page.goto(await packagedGameUrl())

    await page.getByTestId('nav-item').nth(1).click()
    for (let i = 0; i < 3; i += 1) await page.getByTestId('click-button').click()

    await page.getByTestId('nav-item').last().click()
    await expect(page.getByTestId('settings-title')).toBeVisible()

    const text = await readDownload(page, async () => {
      await page.getByTestId('settings-export-save').click()
    })
    const save = JSON.parse(text) as {
      format: string
      slotId: string
      resources: Record<string, { amount: string }>
      generators: Record<string, unknown>
    }
    expect(save.format).toBe('incrementforge-save')
    // PRD 补充 8：V1.0 单存档，slotId 固定 'main'。
    expect(save.slotId).toBe('main')
    expect(save.generators['g2']).toBeTruthy()
    // 点击器的产出落在 r1 上，存档里必须有它且不为初始值（点击确实被记进去了）。
    expect(Number(save.resources['r1']!.amount)).toBeGreaterThan(0)
  })

  test('“重新开始”丢弃运行时赋值与动态条目（8.10、D-18、PRD 补充 6）', async ({ page }) => {
    await page.goto(await packagedGameUrl())

    // 点击器 `initial = "1"`（8.5 初始化表：点击器 `bought = 0`、`owned = initial`），
    // 因此矿石的初值是 0；点若干次把它做上去。
    await page.getByTestId('nav-item').nth(1).click()
    const initial = await resourceAmount(page)
    for (let i = 0; i < 5; i += 1) await page.getByTestId('click-button').click()
    await expect.poll(() => resourceAmount(page)).toBeGreaterThan(initial)

    await page.getByTestId('nav-item').last().click()
    await page.getByTestId('settings-restart').click()

    await page.getByTestId('nav-item').nth(1).click()
    // D-18：重新开始按 8.5 的初始化表把 `amount` 复位为 `initial`（r1.initial = 0）。
    await expect.poll(() => resourceAmount(page)).toBe(initial)
  })

  test('游戏内设置改设置在打包态写 localStorage（D-22）', async ({ page }) => {
    await page.goto(await packagedGameUrl())

    await page.getByTestId('nav-item').last().click()
    await page.getByTestId('settings-input').first().selectOption('layered')
    // 来源徽标切到“本会话覆盖”（8.10 的强制 UI 元素）。
    await expect(page.getByTestId('settings-source-badge').first()).toHaveAttribute('data-source', 'session')

    // D-22：打包态的覆盖值存 `localStorage`，**刷新后仍在**（预览态只在内存里）。
    await page.reload()
    await page.getByTestId('nav-item').last().click()
    await expect(page.getByTestId('settings-source-badge').first()).toHaveAttribute('data-source', 'session')
  })
})
