/**
 * 编辑器**编写链路** E2E（TECH_DESIGN 7.5/7.6/7.7、5.8、11.1）。
 *
 * `editor-flow.spec.ts` 覆盖的是“载入示例 → 预览 → 打包”的**主链路**；本文件覆盖的是
 * **作者在中间工作区里改数据**的那一半——7.5 的四类列表、7.6 的四类表单、5.8 的表达式字段、
 * 7.7 的设置页，以及“改坏了会怎样”（错误码、悬空引用、校验阻断）。
 *
 * ## 为什么这一层单测照不到
 *
 * 7.6 的表单把「数据模型字段」翻译成「控件 + 权限上下文 + 错误码」，中间还夹着 7.3 的历史栈
 * 与 7.4 的 `host:patch` 热更新。单测只能验其中一段；而这一段恰好是作者 90% 的时间所在，
 * 界面上少一个错误码、预览不跟着变，作者无从察觉。
 *
 * 因此这里的每条断言都尽量同时指向两端：**控件上显示了什么** + **预览（真实运行时）里变成了什么**。
 */
import type { Page } from '@playwright/test'

import { expect, importExampleProject, importProjectFile, previewFrame, readDownload, test, waitForPreviewReady, writeTempJson } from './fixtures.js'

/** 生成器「矿机（g1）」的购买价格表达式字段（7.6 的成本行）。 */
const PRICE_FIELD = '购买价格 1 · 数量'

/** 打开功能区并选中一行（`EntryList` 的选中态与中间表单双向绑定，7.5）。 */
async function selectEntry(page: Page, nav: string, id: string): Promise<void> {
  await page.getByTestId(nav).click()
  await page.getByTestId(`entry-${id}`).click()
}

/** 包住某个表达式字段的整个 `.numexpr` 容器（错误码、合法徽标、片段都在里面）。 */
function fieldBox(page: Page, label: string) {
  return page.locator('.numexpr').filter({ has: page.getByRole('textbox', { name: label }) })
}

/**
 * 表达式字段的输入框。
 *
 * 用 `getByRole('textbox')` 而不是 `getByLabel`：`NumExprField` 的**模式切换组**也带同一个
 * `aria-label`（`.segmented` 的 `role="group"`），`getByLabel` 会同时命中两者并报 strict mode violation。
 * `textbox` 角色只落在 `<textarea>` 上，因此它是唯一无歧义的定位方式。
 */
function exprField(page: Page, label: string) {
  return fieldBox(page, label).getByRole('textbox')
}

test.describe('编辑器编写链路（7.5 四类列表 / 7.6 四类表单 / 5.8 表达式字段 / 7.7 设置页）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
  })

  test('价格上下文里写随机函数，编译期就报 E_RAND_DISABLED（5.5、PRD 补充 1）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-generators', 'g1')

    const price = exprField(page, PRICE_FIELD)
    await expect(price).toHaveValue('10 * 1.15 ^ gen.g1.bought')
    // `10 * rand()` 不是数值字面量 → 字段自动切到表达式模式（7.6 末条）。
    await price.fill('10 * rand()')

    // 5.5 的权限表在**编译期**拒绝随机函数：红框里必须出现错误码，而不只是“无效”。
    await expect(fieldBox(page, PRICE_FIELD).locator('.field-error')).toHaveText(/E_RAND_DISABLED/)
    await expect(price).toHaveAttribute('aria-invalid', 'true')
    // 7.6 的校验失败形态是**只给错误码、不给试算框**（试一块算不出来的表达式没有意义）。
    await expect(fieldBox(page, PRICE_FIELD).getByText('试算')).toHaveCount(0)
  })

  test('表达式字段实时校验：语法错误给出错误码，改回合法表达式后出现试算值（5.8）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-generators', 'g1')
    const price = exprField(page, PRICE_FIELD)
    const box = fieldBox(page, PRICE_FIELD)

    await price.fill('1 +')
    // 5.8「输入时实时校验」：错误码直接可见，作者不必等运行时才发现。
    await expect(box.locator('.field-error')).toHaveText(/^E_[A-Z_]+/)

    // 改回合法表达式：徽标翻转成“表达式合法”，并给出影子运行时的试算值 + 耗时（5.8 末条）。
    // `g1.bought = 0` → `10 * 1.15^0 = 10`，因此这里断言的是**试算出的具体数字**，
    // 不是“出现了一个试算框”——后者在试算失败时同样满足。
    await price.fill('10 * 1.15 ^ gen.g1.bought')
    await expect(box.getByText('表达式合法')).toBeVisible()
    await expect(box.getByText(/试算：10（\d+\.\d+ms/)).toBeVisible({ timeout: 15_000 })
    await expect(box.locator('.field-error')).toHaveCount(0)
  })

  test('常用片段一键插入到表达式末尾（5.8）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-generators', 'g1')
    const price = exprField(page, PRICE_FIELD)
    const box = fieldBox(page, PRICE_FIELD)
    await price.fill('')
    // 空文本按“数值字面量”处理（7.6 末条），因此要先手动切到表达式模式，片段区才会出现。
    await box.getByRole('button', { name: '表达式' }).click()

    // 5.8「常用片段快捷插入」：片段按当前条目的 pathPrefix 生成。
    await box.locator('details').click()
    await box.getByRole('button', { name: '自身已购买' }).click()
    await expect(price).toHaveValue('gen.g1.bought')

    await box.getByRole('button', { name: '等比价格 10·1.15^bought' }).click()
    await expect(price).toHaveValue('gen.g1.bought10 * 1.15 ^ gen.g1.bought')
  })

  test('批量购买三档切换即时改变预览里的购买按钮（8.6 表、8.11）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-generators', 'g1')

    // 17.2 的 p1 上既有生成器（g1）也有升级（u1），两者都有“购买”按钮，
    // 因此按卡片定位而不是按 `buy-button` 定位。
    const buy = previewFrame(page).getByTestId('card-generator').getByTestId('buy-button')
    // 17.2 的 g1 是 `buyAmount: "1"` → 8.6 的“固定次数”档。
    await expect(buy).toHaveAttribute('data-mode', 'count')

    // 切到“最大购买”（`buyAmount = 0`）：同一个按钮的形态随之变化（8.11 的 BuyButton）。
    await page.getByRole('button', { name: '最大购买', exact: true }).click()
    await expect(page.getByText(/buyAmount = 0/)).toBeVisible()
    await expect(buy).toHaveAttribute('data-mode', 'max')
    await expect(buy).toHaveText('最大购买')

    // 切到“自动最大（免费）”（`buyAmount < 0`）：不扣材料，7.4 的热更新同样要跟上。
    await page.getByRole('button', { name: '自动最大（免费）', exact: true }).click()
    await expect(buy).toHaveAttribute('data-mode', 'free')
    await expect(buy).toHaveText('免费购买')

    // 撤销回到固定次数：预览跟着回退（7.3 + 7.4 的反向 patches）。
    await page.getByTestId('titlebar-undo').click()
    await expect(buy).toHaveAttribute('data-mode', 'count')
  })

  test('删除被引用的资源时列出受影响引用，并由 E_DANGLING_REF 阻断保存（7.5、D-38、6.4）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    const row = page.getByTestId('entry-r1')

    await row.getByRole('button', { name: /^删除/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // D-38：确认前列出**谁**引用了它、引用在哪（`references.ts` 的四种来源）。
    await expect(dialog).toContainText('矿机 · 购买价格[0]')
    await expect(dialog).toContainText('矿机 · 产出资源[0]')
    await expect(dialog).toContainText('双倍产量 · 购买价格[0]')
    // 页面归属也要提示（确认后从该页面移除）。
    await expect(dialog).toContainText('工厂')

    // 取消不删任何东西。
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(row).toBeVisible()

    // 真删：条目本体与页面归属一起消失（D-38「不做级联，引用方保留原文本」）。
    await row.getByRole('button', { name: /^删除/ }).click()
    await page.getByTestId('confirm-delete').click()
    await expect(row).toHaveCount(0)

    // 引用方的文本还在，因此保存必须被 `E_DANGLING_REF` 拦下（7.5 表最后一行）。
    await page.getByTestId('titlebar-save').click()
    await expect(page.getByRole('dialog')).toContainText('E_DANGLING_REF')
  })

  test('页面禁用开关热更新到预览，且可撤销（8.4、7.3、7.4）', async ({ page }) => {
    await importExampleProject(page)
    // 17.2 的 p2「实验区」是 `disabled: true`。
    const clicker = previewFrame(page).getByTestId('card-clicker')
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    await expect(clicker.getByTestId('click-button')).toHaveCount(0)

    await selectEntry(page, 'nav-pages', 'p2')
    await page.getByLabel('是否禁用').setChecked(false)

    // 7.4：改字段 → `host:patch` → 预览里那条被解锁（8.4：禁用只挡购买/产出，不挡可见）。
    await expect(clicker.getByTestId('click-button')).toBeVisible({ timeout: 10_000 })
    await expect(clicker).toHaveAttribute('data-disabled', 'false')

    // 7.3：撤销把反向 patches 发回预览，预览同步回退。
    await page.getByTestId('titlebar-undo').click()
    await expect(clicker.getByTestId('click-button')).toHaveCount(0)
  })

  test('升级的“效果数值”是只读值，两条模板可一键写入效果内容（7.6、D-47）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-upgrades', 'u1')

    // D-47：效果数值**不是**输入框——它是运行时的 `effValue`，给输入框会把它变成设计期常量。
    await expect(page.getByTestId('effect-value-0')).toHaveText('0')
    await expect(page.getByText('无运行态时为 0').first()).toBeVisible()
    await expect(page.locator('.badge.readonly').first()).toHaveText('只读')
    // 三条效果各自有独立的效果数值位（6.3 的 `effectValues[i]`）。
    await expect(page.getByTestId('effect-value-2')).toHaveText('0')

    // 7.6 末条第 3 项：两条快捷插入模板。
    // 模板是“切换式”的：点一下写入 `= 0`，再点一下写入真实的自身数量。
    const row0 = page.getByTestId('effect-0')
    await row0.getByRole('button', { name: '插入 effValue = <表达式>' }).click()
    await expect(exprField(page, '1. 效果内容')).toHaveValue('effValue = 0')
    await row0.getByRole('button', { name: '插入 effValue = <表达式>' }).click()
    await expect(exprField(page, '1. 效果内容')).toHaveValue('effValue = gen.u1.owned')

    const row1 = page.getByTestId('effect-1')
    await row1.getByRole('button', { name: '插入 up.<id>.effectValues[i] = <表达式>' }).click()
    await expect(exprField(page, '2. 效果内容')).toHaveValue('up.u1.effectValues[1] = 0')
    await row1.getByRole('button', { name: '插入 up.<id>.effectValues[i] = <表达式>' }).click()
    await expect(exprField(page, '2. 效果内容')).toHaveValue('up.u1.effectValues[1] = gen.u1.owned')
  })

  test('设置页改项目名同步标题栏与预览，恢复默认设置复位游戏默认设置（7.7、D-22）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-settings').click()

    // 7.7 第 2 行：改项目名**立即**同步标题栏与预览。
    await page.getByLabel('项目名称').fill('改名后的项目')
    await expect(page.locator('.title-bar-project')).toHaveText('改名后的项目')
    await expect(previewFrame(page).getByTestId('game-title')).toHaveText('改名后的项目')

    // PRD 设置页 5：四项只读信息（创建/修改时间、引擎版本、当前引擎）不可编辑。
    for (const label of ['创建时间', '最后修改', '引擎版本', '当前引擎']) {
      await expect(page.getByLabel(label)).toBeVisible()
    }

    // PRD 设置页 6：游戏默认设置 + 来源徽标（8.10 的强制 UI 元素，不可配置隐藏）。
    const format = page.getByLabel('数字显示格式')
    await format.selectOption('layered')
    await expect(format).toHaveValue('layered')
    await expect(page.locator('.setting-row[data-setting="数字显示格式"] .badge.source')).toHaveText('项目默认')

    await page.getByRole('button', { name: '恢复默认设置' }).click()
    await expect(format).toHaveValue('standard')
  })

  test('键盘可达：↑↓ 选择 / Alt+↑↓ 排序 / Ctrl+D 复制 / Delete 删除（7.5、7.1）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    const rows = page.locator('[role="option"]')
    const before = await rows.count()

    await page.getByTestId('add-resource').click()
    await page.getByTestId('add-resource').click()
    await expect(rows).toHaveCount(before + 2)
    // `addEntry` 之后选中新条目（7.5「选中行高亮」），因此焦点所在行是最后一行。
    expect(await rows.last().getAttribute('aria-selected')).toBe('true')

    // `EntryList` 的键盘处理挂在 `role="listbox"` 容器上（7.5 的“键盘可达”行）。
    await page.locator('ul[role="listbox"]').focus()
    await page.keyboard.press('ArrowUp')
    await expect(rows.nth(before)).toHaveAttribute('aria-selected', 'true')

    // Alt+↑ 与点击“上移”按钮走同一条 store 动作（7.1 末条：无旁路实现）。
    const orderBefore = await rows.locator('.entry-row-name').allTextContents()
    await page.keyboard.press('Alt+ArrowUp')
    const orderAfter = await rows.locator('.entry-row-name').allTextContents()
    expect(orderAfter).not.toEqual(orderBefore)
    expect(orderAfter[before - 1]).toBe(orderBefore[before])

    // Ctrl+D 复制：新增一行（7.5「复制」行）。
    const afterMove = await rows.count()
    await page.keyboard.press('Control+d')
    await expect(rows).toHaveCount(afterMove + 1)

    // Delete 走的是同一个删除确认弹窗（7.5 的 D-38）。
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
  })

  test('导出的项目文件可以原样再导入回来（10.2、D-33）', async ({ page }) => {
    await importExampleProject(page)
    // 先改一个字段，确保往返的是“改过”的那份，而不是原样进原样出。
    await page.getByTestId('nav-settings').click()
    await page.getByLabel('项目作者').fill('往返测试作者')

    const text = await readDownload(page, async () => {
      await page.getByTestId('titlebar-export').click()
    })
    expect((JSON.parse(text) as { meta: { author: string } }).meta.author).toBe('往返测试作者')

    // 改回别的作者，再导入刚才导出的文件：项目应整体回到导出时的样子（含预览重建）。
    await page.getByLabel('项目作者').fill('临时作者')
    await importProjectFile(page, await writeTempJson('round-trip.json', text))
    await page.getByTestId('nav-settings').click()
    await expect(page.getByLabel('项目作者')).toHaveValue('往返测试作者')
    await expect(page.locator('.title-bar-project')).toHaveText('示例：矿石工厂')
  })

  test('打包前校验不通过时给出问题清单，而不是产出一个坏产物（11.1、6.4）', async ({ page }) => {
    await importExampleProject(page)
    await selectEntry(page, 'nav-generators', 'g1')

    // 写一个编译不过的价格表达式：编辑器允许保存这种“半成品”，但打包必须拦住（11.1 第 1 条）。
    await exprField(page, PRICE_FIELD).fill('10 * (1 +')

    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))
    await page.getByTestId('titlebar-package').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog.locator('li code').first()).toHaveText(/^E_[A-Z_]+/)
    await expect(downloads, '校验没过时不应产出下载文件').toEqual([])
  })

  test('“新建”有未保存改动时先确认，确认后换回默认模板（7.9）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    await page.locator('[role="option"]').first().click()
    await page.getByLabel('名称').fill('改过的资源')
    await expect(page.locator('.dirty-dot')).toBeVisible()

    await page.getByTestId('titlebar-new').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('未保存')
    // 取消：什么都不该变。
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(page.locator('.title-bar-project')).toHaveText('示例：矿石工厂')
    await expect(page.getByLabel('名称')).toHaveValue('改过的资源')

    await page.getByTestId('titlebar-new').click()
    await page.getByRole('dialog').getByRole('button', { name: '确认' }).click()
    // 默认模板（7.9）：没有资源，预览也重建为空项目。
    await expect(page.locator('.title-bar-project')).toHaveText('未命名项目')
    await expect(page.locator('[role="option"]')).toHaveCount(0)
    await expect(previewFrame(page).getByTestId('game-title')).toHaveText('未命名项目')
  })

  test('页面条目分配：一个条目只能属于一个页面，重复分配被拒并指出原页面（PRD 补充 7）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()
    await page.getByTestId('add-resource').click()

    // 分配到 `p1`：从“未分配”列表消失，并出现在页面的条目网格里。
    await page.getByTestId('nav-pages').click()
    await page.getByTestId('entry-p1').click()
    const unassigned = page.locator('.assign-list li', { hasText: '新资源' })
    await unassigned.getByRole('button', { name: '分配条目' }).click()
    await expect(page.locator('.entry-grid-cell', { hasText: '新资源' })).toBeVisible()
    await expect(unassigned).toHaveCount(0)

    // 换到 `p2` 再分配同一条：弹窗指出原页面，且**不自动搬家**（PRD 补充 7）。
    const messages: string[] = []
    page.on('dialog', (dialog) => {
      messages.push(dialog.message())
      void dialog.accept()
    })
    await page.getByTestId('entry-p2').click()
    await page.locator('.assign-list li', { hasText: '新资源' }).getByRole('button', { name: '分配条目' }).click()
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(messages.join('|')).toContain('工厂')
    await expect(page.getByTestId('entry-p1').locator('.entry-grid-cell', { hasText: '新资源' })).toHaveCount(0)
  })

  test('页面主题切换立刻改变预览的配色，条目主题可改为跟随页面（PRD 页面编辑器 6/8、8.11）', async ({ page }) => {
    await importExampleProject(page)
    const pageSection = previewFrame(page).locator('.game-page')
    const card = previewFrame(page).getByTestId('card-resource')

    // 默认是 `page-dark`（17.4 的内置主题），底色取它的 `--iforge-page-bg`。
    await expect(pageSection).toHaveCSS('background-color', 'rgb(20, 22, 26)')
    await expect(pageSection).toHaveAttribute('data-theme', 'builtin:page-dark')

    await selectEntry(page, 'nav-pages', 'p1')
    await page.getByRole('button', { name: 'page-light', exact: true }).click()

    // 7.4 的热更新把主题带进预览；`--iforge-page-bg` 换成 light 档的 `#f4f5f7`。
    await expect(pageSection).toHaveAttribute('data-theme', 'builtin:page-light', { timeout: 10_000 })
    await expect(pageSection).toHaveCSS('background-color', 'rgb(244, 245, 247)')
    // 17.2 的 p1 条目**显式**写了 `entry-dark`，所以卡片底色不跟随页面（PRD 页面编辑器 8 的“显式值优先”）。
    await expect(card).toHaveCSS('background-color', 'rgb(28, 31, 37)')

    // 改成“跟随页面主题”：缺省状态由渲染期解析，数据模型里不存隐式值（M3 的取舍）。
    //
    // 注意 `view-model` 把条目主题**折叠**成页面级的一个值（8.11 的“跟随页面 theme 为默认”），
    // 因此要让整页的卡片跟着页面主题走，每条条目都得去掉显式值。
    const cells = page.locator('.entry-grid-cell')
    for (let i = 0; i < (await cells.count()); i += 1) {
      await cells.nth(i).getByRole('button', { name: '跟随页面主题' }).click()
    }
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)', { timeout: 10_000 })
  })
})
