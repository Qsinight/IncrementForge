/**
 * 编辑器**预览与模拟** E2E（TECH_DESIGN 7.1 模拟设置栏、9.1/9.2/9.3、7.4、8.2、8.10）。
 *
 * 与 `editor-authoring.spec.ts` 的分工：那边验“作者改数据”，这边验“改完之后预览是不是真的跟着变”，
 * 以及模拟设置栏这一整排控件是否真的通过 9.2 的协议驱动了 iframe 内的运行时。
 *
 * ## 为什么要用可玩夹具
 *
 * 17.2 的示例项目 `p2` 是禁用的、`r1.initial = 0`、`g1.initial = 0`，矿石唯一的来路是
 * 点一下得 1 个的点击器（见 `fixtures.ts` 里 `cheapPlayableProjectFile()` 的说明）。
 * 模拟设置栏的三件事——重开、导出存档、倍速——全都要求“先有进度”，所以这一组用例改用便宜夹具。
 */
import type { Page } from '@playwright/test'

import {
  cheapProjectFile,
  expect,
  frameText,
  importExampleProject,
  importProjectFile,
  previewFrame,
  readDownload,
  test,
  waitForPreviewReady,
} from './fixtures.js'

/** 预览 iframe 内某个数值字段的当前值（仪表盘/卡片上的数字带格式，按数值比较）。 */
async function frameNumber(page: Page, testId: string): Promise<number> {
  return Number((await frameText(page, testId)).replace(/[^\d.e+-]/g, ''))
}

/** 导入便宜夹具并把当前页切到点击器所在的 `p2`。 */
async function importPlayable(page: Page): Promise<void> {
  await importProjectFile(page, await cheapProjectFile())
  await previewFrame(page).getByTestId('nav-item').nth(1).click()
}

/** 点 N 次点击器（8.5 的 `click`：每次 +1 矿石）。 */
async function clickTimes(page: Page, times: number): Promise<void> {
  const button = previewFrame(page).getByTestId('click-button')
  for (let i = 0; i < times; i += 1) await button.click()
}

test.describe('编辑器预览与模拟（7.1 模拟设置栏 / 9.2 协议 / 7.4 热更新 / 8.2 时钟）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
  })

  test('设备档位切换改的是容器宽度与断点列数，不改任何结算（D-41、9.1）', async ({ page }) => {
    await importExampleProject(page)
    const device = page.locator('.preview-device')
    const iframe = page.getByTestId('preview-iframe')

    // 诊断面板里的“断点列数上限”与设备档位一一对应（D-41 表）。
    await page.getByTestId('preview-diagnostics').click()
    const columns = page.getByTestId('preview-columns')

    await page.getByTestId('preview-device-phone').click()
    await expect(device).toHaveCSS('max-width', '390px')
    await expect(columns).toHaveText('1')
    // 手机档下 iframe 的实际渲染宽度也被压到 390 以内（9.1 的“容器宽度”口径）。
    expect((await iframe.boundingBox())!.width).toBeLessThanOrEqual(390)

    await page.getByTestId('preview-device-tablet').click()
    await expect(device).toHaveCSS('max-width', '834px')
    await expect(columns).toHaveText('2')

    await page.getByTestId('preview-device-auto').click()
    await expect(columns).toHaveText('3')
    await expect(page.getByTestId('preview-frame')).toHaveAttribute('data-device', 'auto')
  })

  test('预览区可折叠，折叠时 iframe 整体卸载（D-14 之外不额外留 DOM）', async ({ page }) => {
    await importExampleProject(page)
    await expect(page.getByTestId('preview-iframe')).toHaveCount(1)

    await page.getByTestId('preview-collapse').click()
    await expect(page.getByTestId('preview-iframe')).toHaveCount(0)
    // 折叠时拖拽把手也要一起消失。
    await expect(page.locator('.preview-resizer')).toHaveCount(0)

    await page.getByTestId('preview-collapse').click()
    await expect(page.getByTestId('preview-iframe')).toHaveCount(1)
    // 重新挂载后仍然是可用的运行时（不是空白文档）。
    await waitForPreviewReady(page)
  })

  test('“重新开始”需要二次确认，确认后按 8.5 的初始化表复位（8.10、D-18）', async ({ page }) => {
    await importPlayable(page)
    await clickTimes(page, 5)
    await expect.poll(() => frameNumber(page, 'resource-amount')).toBeGreaterThanOrEqual(5)

    // 先取消：进度必须原样保留（8.10 的二次确认不是摆设）。
    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.getByTestId('preview-restart').click()
    await page.waitForTimeout(300)
    expect(await frameNumber(page, 'resource-amount')).toBeGreaterThanOrEqual(5)

    // 再确认：D-18「不可撤销」，但语义是**回到项目初始值**而不是清零存档文件。
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByTestId('preview-restart').click()
    // r1.initial = 0 → 复位后应为 0。
    await expect.poll(() => frameNumber(page, 'resource-amount')).toBe(0)
  })

  test('预览区“导出存档”由宿主下载，且带的是玩家点出来的进度（D-51、PRD 预览区 9）', async ({ page }) => {
    await importPlayable(page)
    await clickTimes(page, 4)

    const text = await readDownload(page, async () => {
      await page.getByTestId('preview-export-save').click()
    })
    const save = JSON.parse(text) as {
      format: string
      slotId: string
      resources: Record<string, { amount: string }>
      generators: Record<string, { owned: string }>
    }
    expect(save.format).toBe('incrementforge-save')
    expect(save.slotId).toBe('main')
    // 9.1 的 iframe 没有 `allow-downloads`，因此下载必须发生在**宿主**上下文里；
    // 顺带证明这条路径真的通了（否则 `waitForEvent('download')` 会超时）。
    expect(Number(save.resources['r1']!.amount)).toBeGreaterThanOrEqual(4)
    // 点击器 `bought = 0` / `owned = initial = 1`（8.5 的初始化表，D-19/D-28）。
    expect(Number(save.generators['g2']!.owned)).toBe(1)
  })

  test('运行期错误进诊断面板：角标计数 + 明细含错误码（9.3、7.1 末条）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-generators').click()
    await page.getByTestId('entry-g1').click()

    // 0 错误时入口也在（12 的性能预算要求诊断面板常驻），因此先确认初始态。
    await page.getByTestId('preview-diagnostics').click()
    await expect(page.getByTestId('diagnostic-row')).toHaveCount(0)

    // 写一个编译不过的价格表达式：编辑器显示错误码，运行时按 last-good 兜住并上报。
    await page
      .locator('.numexpr')
      .filter({ has: page.getByRole('textbox', { name: '购买价格 1 · 数量' }) })
      .getByRole('textbox')
      .fill('10 * (1 +')

    const rows = page.getByTestId('diagnostic-row')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    await expect(rows.first().locator('code')).toHaveText(/^E_[A-Z_]+/)
    // 9.3 第 3 步：角标变成错误计数（不再是低调的 `·`）。
    await expect(page.getByTestId('preview-diagnostics')).toHaveText(/^[1-9]/)
  })

  test('伪造的 host 消息被丢弃并计数，游戏状态不受影响（9.2、R-19）', async ({ page }) => {
    await importPlayable(page)

    // 会话 id 是 R-19 里“伪造消息”的唯一屏障：拿一个错的 id 发 `host:control{pause}`。
    await page.evaluate(() => {
      const frame = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement | null
      frame?.contentWindow?.postMessage({ v: 1, sessionId: 'forged-session-id', kind: 'host:control', payload: { action: 'pause' } }, '*')
    })

    // ① 游戏**没有**被暂停（伪造消息不生效）。
    await page.waitForTimeout(500)
    await expect(previewFrame(page).getByTestId('paused-badge')).toHaveCount(0)
    // ② 但它被计数了（9.2「丢弃并计数」），因此宿主角标会出现 1 条 E_MSG_INVALID。
    await page.getByTestId('preview-diagnostics').click()
    await expect(page.getByTestId('diagnostic-row').first()).toContainText('E_MSG_INVALID', { timeout: 15_000 })
  })

  test('预览 iframe 是不透明源沙箱：allow-scripts 但没有 allow-same-origin（9.1）', async ({ page }) => {
    await importExampleProject(page)
    const iframe = page.getByTestId('preview-iframe')

    // 9.1 逐字：`allow-scripts` + `allow-pointer-lock`，**不加** allow-same-origin。
    // 少给 allow-same-origin 是 10.3 的前提（localStorage 必须访问失败而不是读到宿主的）。
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock')
    // 运行时是 `srcdoc` 内联的 esbuild 产物，没有 `src`（M4 的注入机制）。
    await expect(iframe).not.toHaveAttribute('src', /.*/)
    expect(await iframe.getAttribute('srcdoc')).toContain('__IFORGE_BOOTSTRAP__')
  })

  test('撤销/重做的快捷键与按钮可用性一致（7.1 快捷键表、7.3）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    // 中间工作区只渲染**选中条目**的表单（7.5「选中行高亮，与中间工作区表单双向绑定」）。
    await page.locator('[role="option"]').first().click()
    const name = page.getByLabel('名称')

    await name.fill('快捷键改名')
    await expect(previewFrame(page).getByTestId('entry-name').first()).toHaveText('快捷键改名')
    // 没有可重做的事时重做按钮必须是禁用的。
    await expect(page.getByTestId('titlebar-redo')).toBeDisabled()

    // 焦点移出输入框后，快捷键与按钮走同一条 store 事务（7.1 末条：无旁路实现）。
    await page.getByTestId('nav-resources').click()
    await page.keyboard.press('Control+z')
    await expect(name).not.toHaveValue('快捷键改名')
    // 撤销一步后“立刻”能重做：这两个按钮的置灰跟历史栈走（7.1）。
    await expect(page.getByTestId('titlebar-undo')).toBeDisabled()
    await expect(page.getByTestId('titlebar-redo')).toBeEnabled()

    await page.keyboard.press('Control+y')
    await expect(name).toHaveValue('快捷键改名')
    await expect(previewFrame(page).getByTestId('entry-name').first()).toHaveText('快捷键改名')
    // 全部重做回去之后按钮重新变灰。
    await expect(page.getByTestId('titlebar-redo')).toBeDisabled()
    await expect(page.getByTestId('titlebar-undo')).toBeEnabled()
  })

  test('焦点在输入框里时 Ctrl+Z 不触发项目级撤销（7.1 的快捷键范围表）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    await page.locator('[role="option"]').first().click()

    await page.getByLabel('名称').fill('改过的名字')
    // 输入框里按 Ctrl+Z 只走浏览器原生的输入撤销，项目历史**不动**——
    // 否则作者打字打到一半会把自己的字段改动撤掉（`shortcuts.ts` 的 `isEditable` 门禁）。
    await page.keyboard.press('Control+z')
    await expect(page.getByTestId('titlebar-redo')).toBeDisabled()

    // 按钮仍然可用：项目级撤销随时能做。
    await page.getByTestId('titlebar-undo').click()
    await expect(page.getByLabel('名称')).toHaveValue('矿石')
    await expect(page.getByTestId('titlebar-redo')).toBeEnabled()
  })

  test('未保存改动显示圆点，保存后消失（7.1 标题栏、10.1）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    await page.locator('[role="option"]').first().click()
    await page.getByLabel('名称').fill('未保存的名字')
    await expect(page.locator('.dirty-dot')).toBeVisible()

    await page.getByTestId('titlebar-save').click()
    await expect(page.locator('.dirty-dot')).toHaveCount(0)
    // 保存后的 toast 是唯一的“落库成功”信号。
    await expect(page.getByRole('status')).toContainText('已保存')
  })

  test('时间倍速加快结算但不影响暂停语义（7.1、8.2、D-31）', async ({ page }) => {
    await importPlayable(page)
    await clickTimes(page, 6)

    // 买一台矿机开自动产出（8.5 的 `applyProduces`；`p1` 上是生成器卡片）。
    await previewFrame(page).getByTestId('nav-item').first().click()
    const buy = previewFrame(page).getByTestId('card-generator').getByTestId('buy-button')
    await expect(buy).toBeEnabled()
    await buy.click()
    await expect(previewFrame(page).getByTestId('card-generator').getByTestId('owned-value')).toHaveText('1')

    // 1× 下 1.2 秒的增量（每秒 10 矿石，夹具把单件速率调成了 10）。
    const read = async (): Promise<number> => frameNumber(page, 'resource-amount')
    const base = await read()
    await page.waitForTimeout(1200)
    const slow = (await read()) - base

    // 同样 1.2 秒切到 10×：增量必须显著更大（D-31「倍速只加速 tick，不改存档计时」）。
    await page.getByTestId('preview-speed').selectOption('10')
    const fastBase = await read()
    await page.waitForTimeout(1200)
    const fast = (await read()) - fastBase

    expect(fast, `1× 增量 ${slow}，10× 增量 ${fast}，倍速没有生效`).toBeGreaterThan(slow * 3)

    // 暂停：tick 停推进（8.2），倍速档位保持。
    await page.getByTestId('preview-pause').click()
    await expect(previewFrame(page).getByTestId('paused-badge')).toBeVisible()
    const frozen = await read()
    await page.waitForTimeout(600)
    expect(await read()).toBe(frozen)
    await expect(page.getByTestId('preview-speed')).toHaveValue('10')
  })

  test('改价格表达式热更新到预览卡片的价格行（7.4 的逐字段 diff）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-generators').click()
    await page.getByTestId('entry-g1').click()

    const price = page
      .locator('.numexpr')
      .filter({ has: page.getByRole('textbox', { name: '购买价格 1 · 数量' }) })
      .getByRole('textbox')
    await price.fill('999')

    // 7.4：热更新保留运行时进度，只换字段本身；因此卡片上的价格行要立刻变成 999。
    const cost = previewFrame(page).getByTestId('card-generator').getByTestId('costs').locator('.cost-amount')
    await expect(cost).toHaveText('999')

    await page.getByTestId('titlebar-undo').click()
    // g1.bought = 0 → 原价 `10 * 1.15^0 = 10`。
    await expect(cost).toHaveText('10')
  })

  test('删掉 `create()` 指向的页面后，动态条目成为孤儿并可从诊断面板丢弃（8.7、7.5 末条）', async ({ page }) => {
    await importProjectFile(page, await cheapProjectFile())
    // 先在运行时里真的创建出动态条目：`gen.g1.bought >= 10` 才触发 `create("upgrade", …, page:"p1")`。
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    const clicker = previewFrame(page).getByTestId('click-button')
    for (let i = 0; i < 12; i += 1) await clicker.click()
    await previewFrame(page).getByTestId('nav-item').first().click()
    const buy = previewFrame(page).getByTestId('card-generator').getByTestId('buy-button')
    for (let i = 0; i < 10; i += 1) await buy.click()
    await previewFrame(page).getByTestId('card-upgrade').getByTestId('buy-button').click()
    await expect(previewFrame(page).locator('article[data-dynamic="true"]')).toBeVisible({ timeout: 15_000 })

    // 删掉 `p1`：删除弹窗必须提前指出 `create()` 的 `page` 参数会悬空（7.5 的引用表第 4 行）。
    await page.getByTestId('nav-pages').click()
    await page.getByTestId('entry-p1').getByRole('button', { name: /^删除/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('E_PAGE_UNKNOWN')
    await expect(dialog).toContainText('升级效果[2]')
    await page.getByTestId('confirm-delete').click()

    // 动态条目仍在运行时里，但 `pageId` 已失效 → 不渲染、进孤儿清单（8.7）。
    await expect(previewFrame(page).locator('article[data-dynamic="true"]')).toHaveCount(0, { timeout: 15_000 })
    await page.getByTestId('preview-diagnostics').click()
    const orphans = page.getByTestId('orphan-list')
    await expect(orphans).toContainText('uTmp', { timeout: 15_000 })

    // 丢弃走 `host:control{action:'discard'}`（7.1 末条：与卡片按钮同一个 `destroy()`）。
    await page.getByTestId('orphan-discard').click()
    await expect(orphans).toHaveCount(0, { timeout: 15_000 })
  })
})
