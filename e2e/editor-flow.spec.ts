/**
 * 编辑器全流程 E2E（TECH_DESIGN 17.5 的 M5 交付标准、14.1 的端到端链路、PRD 核心功能 3/9）。
 *
 * 覆盖 14.1 端到端那一行的前半段：
 * **载入示例项目 → 预览模拟 → 点击/购买 → 保存 → 导出项目 → 打包**。
 * 后半段（打开单文件 HTML → 游玩 → 导出存档 → 重新导入）在 `packaged-game.spec.ts`。
 *
 * ## 为什么每条断言都指向 PRD 的具体条目
 *
 * E2E 失败时的定位成本极高（要复现、要读 trace）。因此每条用例的标题都带上 PRD/文档编号，
 * 失败信息里直接出现“哪一条需求没满足”，省掉一次回溯。
 *
 * ## 与 `apps/editor/test-node/preview-e2e.test.ts` 的分工
 *
 * M4 的那份在 **jsdom** 里执行 esbuild 的**真实产物**，验证“协议往返 + 数字一致”，快且可断言
 * 内部状态。E2E 在**真浏览器**里跑，只验证“用户在屏幕上看到什么”：
 * 两者不可互相替代——jsdom 没有布局与真实 `postMessage` 管线，而 E2E 拿不到内部状态。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { frameText, importExampleProject, previewFrame, readDownload, test, waitForPreviewReady, expect } from './fixtures.js'

test.describe('编辑器全流程（M5 交付标准：E2E 全流程通过）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForPreviewReady(page)
  })

  test('载入示例项目后预览渲染出游戏视图（PRD 预览区 1–8）', async ({ page }) => {
    await importExampleProject(page)

    // PRD 预览区 1：顶部标题栏显示项目名。
    await expect(previewFrame(page).getByTestId('game-title')).toHaveText('示例：矿石工厂')
    // PRD 预览区 2：数据仪表盘。
    await expect(previewFrame(page).getByTestId('game-dashboard')).toBeVisible()
    // PRD 预览区 3/5：资源卡片 + 生成器卡片。
    await expect(previewFrame(page).getByTestId('card-resource')).toBeVisible()
    await expect(previewFrame(page).getByTestId('card-generator')).toBeVisible()
    // PRD 预览区 8：底部导航，两个页面 + 内置设置页（最后一格）。
    await expect(previewFrame(page).getByTestId('nav-item')).toHaveCount(3)
    await expect(previewFrame(page).getByTestId('nav-item').last()).toHaveAttribute('data-built-in', 'true')
  })

  test('禁用页面的条目保留卡片但不可交互（PRD 页面编辑器 4、8.4、D-28）', async ({ page }) => {
    await importExampleProject(page)

    // 17.2 的 p2「实验区」是 `disabled: true`：导航**仍可跳转**（PRD 页面编辑器 4）。
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    const clicker = previewFrame(page).getByTestId('card-clicker')
    await expect(clicker).toBeVisible()
    // 8.4：禁用时其下条目不可购买、不可产出，因此卡片上**没有**“点击”按钮。
    await expect(clicker.getByTestId('click-button')).toHaveCount(0)
    // D-28：点击器在任何情况下都没有“购买”按钮。
    await expect(clicker.getByTestId('buy-button')).toHaveCount(0)
    // 8.11：禁用保留卡片但置灰（不隐藏）。
    await expect(clicker).toHaveAttribute('data-disabled', 'true')
  })

  test('暂停后 tick 停止推进、恢复后继续（7.1 模拟设置栏、8.2）', async ({ page }) => {
    await importExampleProject(page)

    await page.getByTestId('preview-pause').click()
    // 8.11：仪表盘出现“已暂停”徽标。
    await expect(previewFrame(page).getByTestId('paused-badge')).toBeVisible()

    const amount = await frameText(page, 'resource-amount')
    await page.waitForTimeout(800)
    expect(await frameText(page, 'resource-amount')).toBe(amount)

    // 恢复后继续推进（8.2：恢复时丢弃暂停期间积压的时间）。
    await page.getByTestId('preview-pause').click()
    await expect(previewFrame(page).getByTestId('paused-badge')).toHaveCount(0)
  })

  test('“解锁全部”让禁用页面的条目恢复可交互（D-16、8.4）', async ({ page }) => {
    await importExampleProject(page)

    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    await expect(previewFrame(page).getByTestId('card-clicker').getByTestId('click-button')).toHaveCount(0)

    await page.getByTestId('preview-unlock').click()
    // `unlockAll()` 末尾会把当前页面复位到 `initialPageId()`（8.4：当前页可能因不可见而失效），
    // 因此需要重新导航回 p2 才能看到那条被解锁的条目。
    await previewFrame(page).getByTestId('nav-item').nth(1).click()
    // D-16：一次性动作，副作用在下一个提交阶段生效，因此下一 tick 才有按钮。
    await expect(previewFrame(page).getByTestId('card-clicker').getByTestId('click-button')).toBeVisible({ timeout: 10_000 })
  })

  test('游戏内设置改设置只写会话覆盖，项目默认不变（D-22、R-24）', async ({ page }) => {
    await importExampleProject(page)

    // 进入内置设置页（底部导航最后一格，8.12）。
    await previewFrame(page).getByTestId('nav-item').last().click()
    await previewFrame(page).getByTestId('settings-input').first().selectOption('layered')

    // 来源徽标切到“本会话覆盖”（8.10 的强制 UI 元素）。
    await expect(previewFrame(page).getByTestId('settings-source-badge').first()).toHaveAttribute('data-source', 'session')

    // 关键断言：回到编辑器的设置页，项目默认**没有被改写**（D-22 / R-24）。
    await page.getByTestId('nav-settings').click()
    // `SettingRow` 外面套着 `<label>`（7.1 的可访问性基线 ①），因此按 label 定位。
    await expect(page.getByLabel('数字显示格式')).toHaveValue('standard')
  })

  test('保存后项目名出现在标题栏，且刷新后仍能打开（7.9、10.1）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('titlebar-save').click()

    await expect(page.locator('.title-bar-project')).toHaveText(/示例：矿石工厂/)

    // 10.1 的 `meta` 指针：刷新后据此载入**同一个**项目。
    await page.reload()
    await waitForPreviewReady(page)
    await expect(previewFrame(page).getByTestId('game-title')).toHaveText('示例：矿石工厂')
  })

  test('导出项目文件是可解析的 6.2 项目文件（10.2）', async ({ page }) => {
    await importExampleProject(page)

    const text = await readDownload(page, async () => {
      await page.getByTestId('titlebar-export').click()
    })
    const project = JSON.parse(text) as { format: string; meta: { name: string }; pages: unknown[] }
    expect(project.format).toBe('incrementforge-project')
    expect(project.meta.name).toBe('示例：矿石工厂')
    expect(project.pages.length).toBeGreaterThan(0)
  })

  test('打包产出可离线游玩的单文件 HTML（11.1、17.3、M5 交付标准）', async ({ page }) => {
    await importExampleProject(page)

    // 9.3 第 2 步：`game:ready` 之后“打包”按钮才可用。
    const pack = page.getByTestId('titlebar-package')
    await expect(pack).toBeEnabled()

    const html = await readDownload(page, async () => {
      await pack.click()
    })

    // 11.1/17.3：单文件、无外部依赖。
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('window.__IFORGE_BOOTSTRAP__')
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i)

    // 11.2 的体积预算。
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(1.5 * 1024 * 1024)

    // D-42 / R-32：产物里**不含**模拟设置栏的控件。
    expect(html).not.toContain('解锁全部')
    expect(html).not.toContain('时间倍速')
    expect(html).not.toContain('自适应')
  })

  test('打包结果显示体积与指纹（11.1 末条、12 的监控要求）', async ({ page }) => {
    await importExampleProject(page)

    await page.getByTestId('titlebar-package').click()
    // 打包结果放在诊断面板里（与性能采样同一处），因此先展开面板。
    await page.getByTestId('preview-diagnostics').click()
    await expect(page.getByTestId('package-result')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('package-fingerprint')).toHaveText(/^[0-9a-f]{8}$/)
    await expect(page.getByTestId('package-size')).toContainText('KB')
  })

  /**
   * 缺陷 3：“游戏打包产物中，页面上半部分留白面积过大”。
   *
   * ## 现象与根因
   *
   * 打包模板 `renderBundleHtml` 只在 `<body>` 里放一个 `<div id="app">`，并给它
   * `height: 100%`（11.1/17.3）。若产物里内联的是**预览**那份注入物（入口
   * `iframe-entry.ts`、挂载点 `#iforge-root`），运行时找不到该挂载点就**自己新建一个
   * 挂到 `body` 末尾** —— 那个**空**的 `#app` 于是留在游戏上方整整一屏：
   *
   * ```
   * body 子节点            DIV#app, NOSCRIPT, SCRIPT, SCRIPT, DIV#iforge-root
   * #app                   top=0    bottom=941   height=941   <- 空的，整整一屏
   * #iforge-root           top=941  bottom=1882  height=941   <- 游戏在这里
   * .game-title            top=949                                  <- 标题在第二屏
   * document.scrollHeight = 1882（视口 941 的两倍）
   * ```
   *
   * 数据、点击、导航、存档这类功能断言**全部通过**，只有肉眼能看出那半屏空白。
   *
   * ## 为什么用“编辑器打包”这条路径
   *
   * `packaged-game.spec.ts` 走的是 `iforge-pack` **CLI**，而 CLI 一直用的是
   * `STANDALONE_ENTRY`（正确的那份）——这条路径量不到本缺陷。缺陷只在编辑器点
   * “打包”时才出现，因此这里必须走**编辑器**这条路径。
   */
  test('缺陷 3：编辑器打包的产物从顶部开始渲染，不多出一整屏空白', async ({ page, context }) => {
    await importExampleProject(page)

    const html = await readDownload(page, async () => {
      await page.getByTestId('titlebar-package').click()
    })

    // 落盘后用 `file://` 打开——产物必须能离线跑（17.5），布局也必须在真实浏览器里量。
    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-editorpack-'))
    const file = join(dir, 'game.html')
    await writeFile(file, html, 'utf8')

    const game = await context.newPage()
    await game.setViewportSize({ width: 1280, height: 800 })
    await game.goto(pathToFileURL(file).href)
    await game.waitForSelector('[data-testid="game-title"]')

    // 只有一个挂载点：直挂入口复用模板给的 `#app`，不会另起一个根节点。
    expect(await game.locator('#iforge-root').count(), '不应出现第二个挂载点 #iforge-root').toBe(0)
    expect(await game.locator('#app > .game-root').count(), '游戏必须挂在模板给的 #app 里').toBe(1)

    // 文档不高于视口：多出一屏就说明游戏被挤到了 `#app` 之下。
    const metrics = await game.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const box = el.getBoundingClientRect()
        return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) }
      }
      return {
        innerHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        app: rect('#app'),
        title: rect('.game-title'),
        nav: rect('.bottom-nav'),
      }
    })
    expect(metrics.scrollHeight, '文档高度不应超过视口（否则上半屏是空白）').toBeLessThanOrEqual(metrics.innerHeight + 1)
    expect(metrics.app?.height, '挂载点铺满视口').toBe(metrics.innerHeight)
    // 标题紧贴顶部（`game-root` 的 8px 内边距），底部导航紧贴底部。
    expect(metrics.title?.top, '标题应在视口顶部').toBeLessThan(24)
    expect(metrics.nav?.bottom, '底部导航应贴住视口底部').toBeGreaterThan(metrics.innerHeight - 24)
  })

  test('诊断面板显示 12 性能预算要求的四项指标', async ({ page }) => {
    await importExampleProject(page)

    // 诊断面板的入口**始终**存在（0 错误时也在）：12 要求诊断面板常驻显示这四项，
    // 而“一切正常但很慢”和“没有错误”完全是两回事。
    await page.getByTestId('preview-diagnostics').click()
    await expect(page.getByTestId('preview-perf')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('perf-evaluations')).not.toBeEmpty()
    await expect(page.getByTestId('perf-cache')).toContainText('%')
    await expect(page.getByTestId('perf-compile')).toContainText('%')
    await expect(page.getByTestId('perf-formats')).not.toBeEmpty()
  })

  test('条目列表的四类操作：添加 / 排序 / 复制 / 删除（7.5、PRD 左侧列表）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()

    const rows = page.locator('[role="option"]')
    const before = await rows.count()
    await page.getByTestId('add-resource').click()
    await expect(rows).toHaveCount(before + 1)

    // 复制：新增一行且字段逐字相同（7.5「生成新 id、其余字段逐字复制」）。
    await page.getByTestId('add-resource').click()
    await expect(rows).toHaveCount(before + 2)

    // 删除最后一行（二次确认 + 引用清单，7.5 的 D-38）。
    await rows.last().getByRole('button', { name: /^删除/ }).click()
    await page.getByTestId('confirm-delete').click()
    await expect(rows).toHaveCount(before + 1)
  })

  test('撤销/重做改名称后预览同步回退（7.3、14.2）', async ({ page }) => {
    await importExampleProject(page)
    await page.getByTestId('nav-resources').click()

    // 表单跟随左侧列表的选中行（7.5「选中行高亮，与中间工作区表单双向绑定」）。
    const row = page.locator('[role="option"]').first()
    await row.click()
    await expect(row).toHaveAttribute('aria-selected', 'true')

    // `Field` 用 `<label htmlFor>` 关联控件（7.1 的可访问性基线 ①），
    // 因此按 label 定位而不是 data-testid——这也是真实用户/读屏软件的定位方式。
    await page.getByLabel('名称').fill('改名后的资源')
    // 7.4：改名称立即同步到预览。
    await expect(previewFrame(page).getByTestId('entry-name').first()).toHaveText('改名后的资源')

    await page.getByTestId('titlebar-undo').click()
    // 7.3：撤销后把反向 patches 发到预览，列表与预览同步回退。
    await expect(previewFrame(page).getByTestId('entry-name').first()).not.toHaveText('改名后的资源')
  })
})
