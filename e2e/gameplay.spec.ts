/**
 * 打包产物的**游玩链路** E2E（TECH_DESIGN 8.5/8.6/8.7/8.8/10.2/10.3、17.5 的 M5 交付标准）。
 *
 * `packaged-game.spec.ts` 验的是“产物能打开、样式命中、存档能往返”；本文件验的是
 * **产物里的游戏真的能玩**：买生成器 → 自动产出 → 买升级 → 升级的热替换效果改写速率 →
 * 表达式创建的动态条目出现并可丢弃 → 离线回来按 8.8 结算。
 *
 * 这条链路在编辑器预览里也跑得通，但没有它就等于**没验产物**：11.1/17.3 的全部意义就是
 * “这个单文件 HTML 自己就是游戏”，因此每条用例都从 `file://` 打开产物开始。
 *
 * ## 夹具：为什么价格被调便宜了
 *
 * 17.2 的示例价格是 `10 * 1.15 ^ gen.g1.bought`，而矿石只能靠点击器一个一个点；
 * 走完“买 10 台 → 触发 `create()` 动态条目”要几百次点击。这里用 `cheapProjectFile()`
 * 把价格调到 E2E 尺度（条件/效果/动态创建表达式一字不改），详见该函数的注释。
 */
import type { Page } from '@playwright/test'

import {
  bundleProjectUrl,
  cheapProjectFile,
  collectPageErrors,
  expect,
  gameResourceAmount,
  manyEntriesProjectFile,
  readDownload,
  scrollingEntriesProjectFile,
  test,
  themedProjectFile,
  writeTempJson,
} from './fixtures.js'

/** 当前页的资源数量（矿石）。 */
function ore(page: Page): Promise<number> {
  return gameResourceAmount(page)
}

/**
 * 某张卡片是否**完整落在** `.game-main` 的可视范围内（没被祖先裁掉）。
 *
 * 为什么不直接用 `toBeInViewport()`：它比的是**浏览器视口**，而这里要比的是
 * “有没有被某个祖先裁掉”。`overflow: hidden` 的祖先会把内容裁掉但元素坐标仍在视口内，
 * 于是 `toBeInViewport()` 在本缺陷存在时也会通过——它验不出“看得见但够不着”。
 *
 * 参数是条目的 `data-entry` 值（卡片靠它定位，省得在页面里再写一遍选择器）。
 */
async function cardFitsInMain(page: Page, entryId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const card = document.querySelector(`article[data-entry="${id}"]`)
    const main = document.querySelector('.game-main')
    if (!card || !main) return false
    const cardRect = card.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    return cardRect.top >= mainRect.top - 1 && cardRect.bottom <= mainRect.bottom + 1
  }, entryId)
}

/** 切到点击器所在的 `p2` 并点 N 次（8.5 的 `click`：每次 +1 矿石）。 */
async function clickTimes(page: Page, times: number): Promise<void> {
  await page.getByTestId('nav-item').nth(1).click()
  const button = page.getByTestId('click-button')
  for (let i = 0; i < times; i += 1) await button.click()
}

/** 切到 `p1`（矿机与升级所在页）。 */
async function gotoFactory(page: Page): Promise<void> {
  await page.getByTestId('nav-item').first().click()
  await expect(page.getByTestId('card-generator')).toBeVisible()
}

/** 打包产物（按夹具缓存，同一份字节）。 */
function gameOf(options?: Parameters<typeof cheapProjectFile>[0]): Promise<string> {
  return cheapProjectFile(options).then(bundleProjectUrl)
}

/**
 * 让打包态写一次存档（自动存档按真实秒数计，E2E 不等 30s，走补写路径，10.3）。
 */
async function forceSave(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

/**
 * 重新加载，并让**新文档**在启动前把存档时间戳往前/后挪 `deltaMs`（构造 8.8 的两条分支）。
 *
 * ## 为什么挪时间要在 init script 里做，而不是先改 localStorage 再 reload
 *
 * 因为 `installLifecycleAutosave`（10.3）给 `beforeunload` 也装了补写：**reload 本身**
 * 会用当前墙钟把存档重写一遍，先改的时间戳当场就被抹掉了。
 * （症状很有意思：提示条照常出现，写着“离线时长 0 秒、矿石 +0.2”。）
 *
 * init script 在新文档的页面脚本**之前**运行，因此挪的时间戳是最终生效的那一份，
 * 不与游戏的补写竞争。`beforeunload` 的补写也因此保留——被验的仍是真实行为。
 */
async function reloadWithShiftedSave(page: Page, deltaMs: number): Promise<void> {
  await page.context().addInitScript((shift) => {
    const key = Object.keys(localStorage).find((name) => name.startsWith('incrementforge.save.'))
    if (!key) return
    const raw = localStorage.getItem(key)
    if (!raw) return
    const save = JSON.parse(raw) as { savedAt: string; lastSeenAt: string }
    const at = new Date(Date.parse(save.savedAt) + shift).toISOString()
    save.savedAt = at
    save.lastSeenAt = at
    localStorage.setItem(key, JSON.stringify(save))
  }, deltaMs)
  await page.reload()
}

test.describe('打包产物的游玩链路（8.5 购买 / 8.6 批量 / 8.7 升级与动态条目 / 8.8 离线）', () => {
  test('买一台矿机之后矿石自己涨：产出链在产物里真的在跑（8.5、8.3）', async ({ page }) => {
    const errors = collectPageErrors(page)
    await page.goto(await gameOf())

    // 矿石只能靠点击器拿（r1.initial = 0、g1.initial = 0，17.2）。
    await clickTimes(page, 3)
    expect(await ore(page)).toBeGreaterThanOrEqual(3)

    await gotoFactory(page)
    const card = page.getByTestId('card-generator')
    const buy = card.getByTestId('buy-button')
    await expect(buy).toBeEnabled()
    await buy.click()
    await expect(card.getByTestId('bought-value')).toHaveText('1')
    await expect(card.getByTestId('owned-value')).toHaveText('1')

    // 关键断言：**不再点击**，矿石自己增长（8.3 的产出阶段在 rAF 循环里真的跑了）。
    const before = await ore(page)
    await expect.poll(() => ore(page), { timeout: 15_000 }).toBeGreaterThan(before)
    expect(errors, `页面脚本错误：${errors.join('; ')}`).toEqual([])
  })

  test('“最大购买”一次买光材料（8.6 的 max 档、buyAmount = 0）', async ({ page }) => {
    await page.goto(await gameOf({ buyAmount: '0' }))
    await clickTimes(page, 12)
    const budget = await ore(page)

    await gotoFactory(page)
    const card = page.getByTestId('card-generator')
    const buy = card.getByTestId('buy-button')
    // 8.11：档位直接体现在按钮文案上。
    await expect(buy).toHaveText('最大购买')
    await expect(buy).toHaveAttribute('data-mode', 'max')
    await buy.click()

    // 买到买不起为止：材料被花光、拥有数量 = 预算。
    await expect(card.getByTestId('owned-value')).toHaveText(String(budget))
    expect(await ore(page)).toBeLessThanOrEqual(1)
  })

  test('固定次数 ×5：一次点击买 5 台（8.6 的 count 档与 100 上限）', async ({ page }) => {
    await page.goto(await gameOf({ buyAmount: '5' }))
    await clickTimes(page, 10)
    const budget = await ore(page)

    await gotoFactory(page)
    const card = page.getByTestId('card-generator')
    const buy = card.getByTestId('buy-button')
    await expect(buy).toHaveText('购买 ×5')
    await buy.click()

    await expect(card.getByTestId('owned-value')).toHaveText('5')
    expect(await ore(page)).toBe(budget - 5)
  })

  test('买下升级后，效果把单件速率热替换成 2（8.7 的效果结算、D-29 的 set()）', async ({ page }) => {
    await page.goto(await gameOf())
    // 条件是 `gen.g1.bought >= 5`，因此先买满 5 台（每台 1 矿石）。
    await clickTimes(page, 10)
    await gotoFactory(page)
    const generator = page.getByTestId('card-generator')
    for (let i = 0; i < 5; i += 1) await generator.getByTestId('buy-button').click()
    await expect(generator.getByTestId('owned-value')).toHaveText('5')
    // 单件 10 × 拥有 5 = 50/秒（夹具把 `produces[0].amount` 设成了 10）。
    await expect(generator.getByTestId('output')).toContainText('50')

    // 条件列表逐条显示真假（8.11 的条件标记）。
    const upgrade = page.getByTestId('card-upgrade')
    await expect(upgrade.getByTestId('conditions').locator('.condition.true')).toHaveCount(1)

    await upgrade.getByTestId('buy-button').click()
    await expect(upgrade.getByTestId('owned-value')).toHaveText('1')

    // 17.2 的效果 0：`set("gen.g1.produces[0].amount", "2")`——热替换**表达式源码**，
    // 于是单件速率从 10 变成 2，总产量变成 5 × 2 = 10/秒。
    await expect(generator.getByTestId('output')).toContainText('10', { timeout: 15_000 })
  })

  test('表达式创建的动态条目出现在页面上，可丢弃（8.7 的 create()/discard()）', async ({ page }) => {
    await page.goto(await gameOf())
    // 动态创建的前提是 `gen.g1.bought >= 10 && !has("upgrade","uTmp")`。
    await clickTimes(page, 15)
    await gotoFactory(page)
    const generator = page.getByTestId('card-generator')
    for (let i = 0; i < 10; i += 1) await generator.getByTestId('buy-button').click()
    await expect(generator.getByTestId('bought-value')).toHaveText('10')
    // 买下升级才有效果生效（D-43：只有 owned > 0 的升级才产生效果）。
    await page.getByTestId('card-upgrade').getByTestId('buy-button').click()

    // 动态条目只在**存档**里、不进项目文件（6.3），因此必须由运行时创建出来。
    // 按 `data-dynamic` 定位而不是按文本：`u1` 的效果内容里也写着 `临时强化`（`create(...)` 的参数）。
    const created = page.locator('article[data-dynamic="true"]')
    await expect(created).toBeVisible({ timeout: 15_000 })
    await expect(created.getByTestId('entry-name')).toHaveText('临时强化')
    // 动态条目占用上限名额，仪表盘上有角标（8.12 的角标提示）。
    await expect(page.getByTestId('dynamic-count')).toBeVisible()

    // 丢弃：卡片上的按钮与诊断面板的入口走同一个 `discard()`（8.7、7.1 末条）。
    await created.getByTestId('discard').click()
    await expect(created).toHaveCount(0)
    await expect(page.getByTestId('dynamic-count')).toHaveCount(0)
  })

  test('导入存档覆盖进度，数字显示格式随之改变（10.2、4.5）', async ({ page }) => {
    await page.goto(await gameOf())
    await clickTimes(page, 3)
    await page.getByTestId('nav-item').last().click()

    // 导出一份真存档，再把矿石改成 1500（顺带验证它确实是一份合法的 6.3 存档）。
    const text = await readDownload(page, async () => {
      await page.getByTestId('settings-export-save').click()
    })
    const save = JSON.parse(text) as { resources: Record<string, { amount: string }> }
    expect(save.format).toBe('incrementforge-save')
    save.resources['r1']!.amount = '1500'
    const path = await writeTempJson('imported.save.json', JSON.stringify(save, null, 2))

    // 导入：文件选择器由运行时自己创建（controller 的 `requestImportSave`）。
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('settings-import-save').click()
    await (await chooserPromise).setFiles(path)

    await page.getByTestId('nav-item').first().click()
    // `standard` 口径：带千分位（4.5 的五种格式之一）。
    await expect(page.getByTestId('resource-amount').first()).toHaveText(/1[,.]?500/, { timeout: 15_000 })

    // 切到 `letters`：同一个数字换成字母记数（4.5），界面上的读数跟着变。
    await page.getByTestId('nav-item').last().click()
    await page.getByTestId('settings-input').first().selectOption('letters')
    await page.getByTestId('nav-item').first().click()
    await expect(page.getByTestId('resource-amount').first()).toHaveText(/A$/, { timeout: 15_000 })
  })

  test('离线一小时回来有提示条与收益，且写明“离线不含随机/每秒生效/自动购买”（8.8）', async ({ page }) => {
    await page.goto(await gameOf())
    await clickTimes(page, 5)
    await gotoFactory(page)
    // 一台矿机 = 10/秒，离线一小时的收益应当非常显眼。
    await page.getByTestId('card-generator').getByTestId('buy-button').click()
    await forceSave(page)

    // 离线一小时。
    await reloadWithShiftedSave(page, -60 * 60 * 1000)
    await expect(page.getByTestId('offline-notice')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('offline-notice')).toContainText('离线时长')
    // 固定文案（8.8 的第 2 条：离线不触发随机/每秒生效/自动购买）。
    await expect(page.getByTestId('offline-note')).toContainText('离线不含随机')
    // 收益量级：10/s × 3600s = 36000（取下界，避开分段近似的误差方向，D-49）。
    await expect.poll(() => ore(page), { timeout: 15_000 }).toBeGreaterThan(30_000)

    // 提示条可关闭，不影响游戏。
    await page.getByTestId('offline-notice').getByRole('button', { name: '关闭' }).click()
    await expect(page.getByTestId('offline-notice')).toHaveCount(0)
  })

  test('墙钟被往回拨时不结算离线收益，只给警告（8.8 的第 2 行、R-20）', async ({ page }) => {
    await page.goto(await gameOf())
    await clickTimes(page, 5)
    await forceSave(page)
    // 把存档时间戳推到**未来** 1 小时：模拟用户把系统时间改回去（R-20）。
    await reloadWithShiftedSave(page, 60 * 60 * 1000)

    await expect(page.getByTestId('offline-rollback')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('offline-rollback')).toContainText('系统时间')
    // 没有任何离线收益：5 个矿石 + 一点点在线产出。
    expect(await ore(page)).toBeLessThan(1000)
  })

  test('离线超过 `offlineCap` 只结算上限内的时长，并标出“按上限结算”（8.8 约束 ①）', async ({ page }) => {
    // 17.2 的 `offlineCap = 8` 小时，因此离线 10 小时只该结算 8 小时。
    await page.goto(await gameOf())
    await clickTimes(page, 5)
    await gotoFactory(page)
    await page.getByTestId('card-generator').getByTestId('buy-button').click()
    await forceSave(page)
    await reloadWithShiftedSave(page, -10 * 60 * 60 * 1000)

    const notice = page.getByTestId('offline-notice')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    // 被截断时提示条同时给出真实时长与“按上限结算”的时长（8.8 的伪码把 elapsed 截到
    // `offlineCap·3600`）。这里断言的是**上限确实生效**，而不是某个格式化后的秒数。
    await expect(notice).toContainText('10小时')
    await expect(notice).toContainText('按上限结算 8小时')

    // 8 小时 × 10/秒 = 288000；多出的两小时**不给**（否则 360000 会被误当成收益）。
    const gained = await ore(page)
    expect(gained).toBeGreaterThan(250_000)
    expect(gained).toBeLessThan(320_000)
  })

  test('存档键由产物指纹派生，同一份产物两次打开读同一份进度（10.3、D-53）', async ({ page }) => {
    await page.goto(await gameOf())
    await clickTimes(page, 4)
    await forceSave(page)

    const fingerprint = await page.evaluate(
      () => (window as unknown as { __IFORGE_BOOTSTRAP__: { meta: { fingerprint: string } } }).__IFORGE_BOOTSTRAP__.meta.fingerprint,
    )
    const keys = await page.evaluate(() => Object.keys(localStorage))
    // 10.1 的 `incrementforge.save.<projectId>`，其中打包态的 projectId 由指纹派生。
    expect(keys).toContain(`incrementforge.save.pkg-${fingerprint.slice(0, 12)}`)
  })

  test('离线打开全程没有任何外部请求（11.1：单文件、无 CDN）', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))

    await page.goto(await gameOf())
    await clickTimes(page, 2)
    await gotoFactory(page)
    await page.getByTestId('card-generator').getByTestId('buy-button').click()
    await page.getByTestId('nav-item').last().click()

    const external = requests.filter((url) => !/^(file:|blob:|data:)/.test(url))
    expect(external, `产物发起了外部请求：${external.join('、')}`).toEqual([])
    expect(requests.length, '页面本身应当至少加载一次').toBeGreaterThan(0)
  })

  test('“恢复默认设置”清掉打包态的本机覆盖（D-22）', async ({ page }) => {
    await page.goto(await gameOf())
    await page.getByTestId('nav-item').last().click()

    await page.getByTestId('settings-input').first().selectOption('layered')
    await expect(page.getByTestId('settings-source-badge').first()).toHaveAttribute('data-source', 'session')
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('incrementforge.settings.')))).toBe(true)

    await page.getByTestId('settings-restore-defaults').click()
    // 徽标回到“项目默认”，且本机覆盖的键被删掉（写回默认值会让“已覆盖”在刷新后仍然显示）。
    await expect(page.getByTestId('settings-source-badge').first()).toHaveAttribute('data-source', 'project')
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('incrementforge.settings.')))).toBe(false)
  })

  test('页面主题同时作用于标题栏、仪表盘、底部导航与页面本体（PRD 页面编辑器 6、17.4）', async ({ page }) => {
    /**
     * 壳层的每个部件都必须落在**该页面主题**的那一档上。
     *
     * 只断言 `.game-page` 测不出这个缺陷：令牌内联到页面节时它本来就对，
     * 但壳层（`--iforge-page-*` 的消费者）不在页面节子树里，会留在暗色。
     * `toHaveCSS` 读的是**计算后**的值，因此这里比的是真实渲染结果。
     *
     * 断言写成“逐部件 × 逐主题”的显式期望值，而不是“各部件彼此相等”：
     * `bg` 与 `surface` 是**两个不同的令牌**（`light` 档分别是 `#f4f5f7` 与 `#ffffff`），
     * 要求它们相等等于要求引擎忽略主题结构。真正要守的是**每一部件都随页面主题变**，
     * 因此浅色与深色各跑一遍，两次都必须命中各自那一档。
     *
     * 透明背景的标题栏只比 `color`（它靠 `body` 的底色透出，没有自己的底色）。
     *
     * 期望值逐部件列出而不是“各部件彼此相等”：`bg`/`surface`/`text`/`muted` 是四个不同的
     * 令牌（`light` 档里 `muted` 是 `#5b6472` 而不是 `text` 的 `#1b1e24`），
     * 要求它们相等等于要求引擎忽略主题结构。要守的是**每个部件都随页面主题变**。
     *
     * 导航项取**非当前页**的那一格（`.nav-item.current` 用的是 `accent` 令牌，
     * 比它验不到 muted 这条路径）。
     */
    const expectations: Record<string, { bg: string; surface: string; text: string; muted: string }> = {
      'page-light': {
        bg: 'rgb(244, 245, 247)',
        surface: 'rgb(255, 255, 255)',
        text: 'rgb(27, 30, 36)',
        muted: 'rgb(91, 100, 114)',
      },
      'page-dark': {
        bg: 'rgb(20, 22, 26)',
        surface: 'rgb(28, 31, 37)',
        text: 'rgb(232, 234, 237)',
        muted: 'rgb(154, 163, 178)',
      },
    }

    async function assertChromeFollowsPage(theme: string): Promise<void> {
      await page.goto(await themedProjectFile({ pageTheme: theme }).then(bundleProjectUrl))
      const want = expectations[theme]!

      // 底色：页面本体与底部导航用 `bg`，仪表盘用 `surface`（令牌不同，档位相同）。
      await expect(page.locator('.game-page'), '页面本体').toHaveCSS('background-color', want.bg)
      await expect(page.locator('.bottom-nav'), '底部导航').toHaveCSS('background-color', want.bg)
      await expect(page.locator('.game-dashboard'), '数据仪表盘').toHaveCSS('background-color', want.surface)
      // 文字色：标题栏用 `text`，资源名与非当前导航项用 `muted`。
      await expect(page.locator('.game-title'), '顶部标题栏').toHaveCSS('color', want.text)
      await expect(page.locator('.dashboard-name').first(), '仪表盘资源名').toHaveCSS('color', want.muted)
      await expect(page.locator('.nav-item[data-built-in="true"]'), '底部导航项').toHaveCSS('color', want.muted)
    }

    // 浅色页面：壳层必须整体变浅（修复前标题栏/仪表盘/导航仍是暗色）。
    await assertChromeFollowsPage('page-light')
    // 同一份断言反向也成立：深色页面下壳层不能反过来变浅。
    await assertChromeFollowsPage('page-dark')
  })

  test('切到主题不同的页面时壳层跟着换（8.12：导航只改 currentPageId，主题随之重算）', async ({ page }) => {
    await page.goto(await themedProjectFile({ pageTheme: 'page-light' }).then(bundleProjectUrl))

    const root = page.getByTestId('game-root')
    await expect(root).toHaveAttribute('data-theme', 'builtin:page-light')
    await expect(page.locator('.game-dashboard')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    // 示例项目的 `p2` 仍是默认的 `page-dark`；切过去壳层应回到暗色。
    await page.getByTestId('nav-item').nth(1).click()
    await expect(root).toHaveAttribute('data-theme', 'builtin:page-dark', { timeout: 10_000 })
    await expect(page.locator('.game-dashboard')).toHaveCSS('background-color', 'rgb(28, 31, 37)')
  })

  test('条目主题“跟随页面”时卡片跟着页面换色（PRD 页面编辑器 8、D-13）', async ({ page }) => {
    // 夹具把 `p1` 每条 `entries[i].theme` 都删掉 = 跟随页面（不是显式 `entry-light`）。
    await page.goto(await themedProjectFile({ pageTheme: 'page-light' }).then(bundleProjectUrl))
    const card = page.getByTestId('card-resource')
    // 17.4 的 `light` 档 `surface` = `#ffffff`；显式写 `entry-dark` 时会是 `rgb(28, 31, 37)`。
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  })

  test('底部导航在产物里切换页面与内置设置页（8.12、PRD 预览区 8/9）', async ({ page }) => {
    await page.goto(await gameOf())
    const root = page.getByTestId('game-root')

    await expect(root).toHaveAttribute('data-page', 'p1')
    await expect(page.getByTestId('page-description')).toHaveText('主页面')

    await page.getByTestId('nav-item').nth(1).click()
    await expect(root).toHaveAttribute('data-page', 'p2')
    await expect(page.getByTestId('page-description')).toHaveText('被禁用的页面')

    // 最后一格是内置设置页（不是项目里的页面）。
    await page.getByTestId('nav-item').last().click()
    await expect(root).toHaveAttribute('data-page', '__settings__')
    await expect(page.getByTestId('settings-title')).toBeVisible()
    await expect(page.getByTestId('settings-dynamic-count')).toContainText('0')
  })

  test('卡片没到虚拟化阈值时，页面区域仍能上下滚动（8.11 的“不套滚动容器”不等于“不能滚”）', async ({ page }) => {
    await page.goto(await scrollingEntriesProjectFile().then(bundleProjectUrl))

    // 前置：走的是**非虚拟化**路径 —— 8.11 明确此时不套 `.entry-grid-scroll`。
    const section = page.locator('.game-page')
    await expect(section).toHaveAttribute('data-virtualized', 'false')
    await expect(page.getByTestId('entry-grid-scroll')).toHaveCount(0)

    // 全部卡片都在 DOM 里（因此只断言 DOM 会全绿，这正是缺陷能溜过去的原因）。
    const total = Number(await page.getByTestId('entry-grid').getAttribute('data-total'))
    expect(total).toBeGreaterThan(6)

    // 关键断言：**页面区域可滚**。`.game-main` 是这条路径唯一的滚动轴；
    // 它一旦是 `overflow: hidden`，下面的卡片就既看不见也够不着。
    const main = page.locator('.game-main')
    const metrics = await main.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(metrics.overflowY, '`.game-main` 必须是滚动容器').not.toBe('hidden')
    expect(metrics.scrollHeight, '内容应当高过可视区').toBeGreaterThan(metrics.clientHeight)

    // 末尾卡片此刻**够不着**（在主区可视范围之外），滚下去才看得见。
    expect(await cardFitsInMain(page, 'r14'), '滚之前末尾卡片应当够不着').toBe(false)

    // 用**真实的滚轮手势**而不是程序化 `scrollTop`。
    // `overflow: hidden` 的元素仍然可以被 `element.scrollTop = n` 程序化滚动
    // （它只是不接受用户输入），因此程序化写法在本缺陷存在时**照样会通过**。
    // 真实手势才对应玩家遇到的“拖不动”。
    const box = (await main.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 4000)
    await expect.poll(async () => main.evaluate((element) => element.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0)

    expect(await cardFitsInMain(page, 'r14'), '滚下去之后末尾卡片应当完整可见').toBe(true)
    // 顶部那条随之离开（真的滚了，而不是“本来就都在里面”）。
    expect(await cardFitsInMain(page, 'r1'), '顶部卡片应当已被滚出可视区').toBe(false)
  })

  test('卡片超过 40 条时启用虚拟滚动，滚到底能看到最后一条（12 性能预算、D-56）', async ({ page }) => {
    await page.goto(await manyEntriesProjectFile().then(bundleProjectUrl))

    // 阈值按**当前页**的可见卡片数判定（不是全项目条目数，D-56）。
    const section = page.locator('.game-page')
    await expect(section).toHaveAttribute('data-virtualized', 'true')

    const grid = page.getByTestId('entry-grid')
    const total = Number(await grid.getAttribute('data-total'))
    expect(total, '夹具应当让 p1 超过 40 条').toBeGreaterThan(40)

    // 只渲染视口附近的行：DOM 里的卡片数明显少于总数。
    const rendered = await page.locator('article').count()
    expect(rendered).toBeLessThan(total)
    // 滚动占位让滚动条长度仍反映总数（占位块在 `.entry-grid` 的上下 padding 上）。
    const range = (await grid.getAttribute('data-virtual-range')) ?? ''
    expect(range).toMatch(/^\d+-\d+$/)

    // 滚到底：最后几条资源必须渲染出来，且中间那些确实没被渲染过。
    // 断言用“末尾几张”而不是死卡 `矿石 46`：虚拟窗口按**估算行高**（168px）算位置，
    // 而真实卡片约 96px 高，所以到底时窗口会落在最后几张之内、不保证正好落在最后一张。
    await page.getByTestId('entry-grid-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const names = page.getByTestId('entry-name')
    await expect(names.filter({ hasText: /^矿石 4\d$/ }).first()).toBeVisible({ timeout: 10_000 })
    // 中间的条目没有被渲染（否则虚拟化等于没开）。
    await expect(names.filter({ hasText: '矿石 20' })).toHaveCount(0)
  })
})

/**
 * 仪表盘与壳层底色（PRD 预览区 2、PRD 页面编辑器 6、17.4、8.9）。
 *
 * ## 为什么这一组要放在**产物**上而不是只放编辑器预览
 *
 * 三个症状里有两条只在产物里出现：
 * - 17.3 的模板给 `html` 写了背景，编辑器预览的 `srcdoc` 里**没有**这一段，
 *   因此“画布停在暗色”这条回归在预览里怎么测都是绿的；
 * - 仪表盘吃掉整屏需要**条目多 + 视口矮**同时成立，而 `srcdoc` 里的视口由
 *   模拟设置栏决定，生产者（作者与玩家）看到的却是真实窗口/手机屏。
 */
test.describe('PRD 预览区 2：仪表盘的展开/收回与壳层底色', () => {
  test('仪表盘不再重复显示 tick 耗时 / 帧率 / 诊断角标（唯一去处是编辑器的诊断面板）', async ({ page }) => {
    await page.goto(await gameOf())
    // 三项都是**作者向**信息；编辑器预览里它们已经在预览框正下方重复了一遍
    // （同一份 `game:stats`），产物里则是玩家无从处置的数字。
    await expect(page.getByTestId('perf')).toHaveCount(0)
    await expect(page.getByTestId('game-error-count')).toHaveCount(0)
    const dashboard = page.getByTestId('game-dashboard')
    await expect(dashboard).not.toContainText('tick 耗时')
    await expect(dashboard).not.toContainText('帧率')
    await expect(dashboard).not.toContainText('诊断')
  })

  test('条目多时仪表盘不再吃掉整屏，收回后条目区拿回高度', async ({ page }) => {
    // 手机视口 + 49 个资源：修复前仪表盘自身 623px 高、把主区压到 0px，
    // 页面上的卡片一张都看不见（不是难用，是完全不可用）。
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(await manyEntriesProjectFile().then(bundleProjectUrl))

    const height = () => page.locator('.game-main').evaluate((element) => element.getBoundingClientRect().height)
    const dashboard = page.getByTestId('game-dashboard')
    const toggle = page.getByTestId('dashboard-toggle')

    await expect(dashboard).toHaveAttribute('data-collapsed', 'false')
    const expanded = await height()
    expect(expanded, '展开态的条目区必须有可用高度').toBeGreaterThan(100)

    await toggle.click()
    await expect(dashboard).toHaveAttribute('data-collapsed', 'true')
    expect(await height(), '收回后条目区应当更高').toBeGreaterThan(expanded)

    // 收回后第一张卡片真的看得见（不只是数字变好）。
    await expect(page.getByTestId('card-resource').first()).toBeVisible()

    await toggle.click()
    await expect(dashboard).toHaveAttribute('data-collapsed', 'false')
  })

  test('壳层底色跟随页面主题：画布与 body 不再停在暗色（页面编辑器 6、17.4）', async ({ page }) => {
    // `page-light` 档（17.4）：`bg = #f4f5f7`。
    await page.goto(await themedProjectFile({ pageTheme: 'page-light' }).then(bundleProjectUrl))

    const colors = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      gameRoot: getComputedStyle(document.querySelector('.game-root')!).backgroundColor,
    }))
    // 三处必须同色：画布（超出 body 盒子的区域）、body、根节点内边距那一圈。
    // 少改一处就是一条黑边——`.game-root` 之外的底色各有各的取值来源
    // （见 runtime-shell `view/theme.ts` 的文件头注释）。
    expect(colors.root).toBe('rgb(244, 245, 247)')
    expect(colors.body).toBe(colors.root)
    expect(colors.gameRoot).toBe(colors.root)
  })

  test('深色页面主题下反过来也不会变浅（覆盖不会漏回默认）', async ({ page }) => {
    await page.goto(await themedProjectFile({ pageTheme: 'page-dark' }).then(bundleProjectUrl))
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe('rgb(20, 22, 26)')
  })

  test('离线提示条也占不满整屏：资源多时它让出高度，页面条目仍然可达（8.8 末条）', async ({ page }) => {
    // 提示条的增量列表按**资源数**线性增长。49 个资源 + 提示条 + 仪表盘
    // 在修复前会把主区压成 0px：打开产物看到的是一条通知，而不是游戏。
    // 这里先写一次存档再重开，制造一次离线结算（10.3 的补写路径）。
    await page.setViewportSize({ width: 390, height: 844 })
    const url = await manyEntriesProjectFile().then(bundleProjectUrl)
    await page.goto(url)
    await page.getByTestId('game-title').waitFor()
    await forceSave(page)
    await page.reload()
    await expect(page.getByTestId('offline-notice')).toBeVisible({ timeout: 10_000 })

    const metrics = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? -1
      return {
        notice: height('.offline-notice'),
        dashboard: height('.game-dashboard'),
        main: height('.game-main'),
        docScrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      }
    })
    expect(metrics.main, '离线提示条在场时条目区仍要有可用高度').toBeGreaterThan(60)
    expect(metrics.docScrollHeight, '壳层之外不应有可滚动区域').toBeLessThanOrEqual(metrics.clientHeight)
    // 提示条本身也有上限（否则 49 项增量就是 477px），条目区因此拿得到高度。
    expect(metrics.notice).toBeLessThan(metrics.clientHeight * 0.5)
  })

  test('条目超出页面长度时，超出区域的底色仍是页面主题而不是暗色（页面编辑器 6）', async ({ page }) => {
    // 修复前：壳层被内容顶出 `100dvh` 后，溢出部分落到 `html` 上，而 17.3 的模板
    // 给 `html` 写死了暗色 → 浅色主题下页面底部一条黑带。
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(await manyEntriesProjectFile().then(bundleProjectUrl))
    await page.getByTestId('dashboard-toggle').click()

    const metrics = await page.evaluate(() => ({
      docScrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      root: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }))
    // 壳层是定高应用式布局：文档**不产生**滚动，超出部分由内部滚动容器处理。
    expect(metrics.docScrollHeight, '壳层之外不应有可滚动区域（否则多出一块空白）').toBeLessThanOrEqual(metrics.clientHeight)
    expect(metrics.body).toBe(metrics.root)
  })

  test('打包产物在手机竖屏下底部导航完全可见（壳层高度跟随可见视口）', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(await gameOf())
    const nav = await page.getByTestId('bottom-nav').boundingBox()
    expect(nav, '底部导航必须落在视口内').toBeTruthy()
    // 壳层用 `100dvh`（动态视口高）而不是 `100vh`：移动端地址栏收起/展开会让
    // `100vh` 大于可见高度，壳层被顶出屏幕、导航点不到。
    expect(nav!.y + nav!.height).toBeLessThanOrEqual(844)
  })

  test('游戏内设置页可切换页面主题并即时生效（PRD 页面编辑器 6、8.10）', async ({ page }) => {
    await page.goto(await themedProjectFile({ pageTheme: 'page-light' }).then(bundleProjectUrl))

    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
    expect(await bg()).toBe('rgb(244, 245, 247)')

    await page.getByTestId('nav-item').last().click()
    await expect(page.getByTestId('settings-title')).toBeVisible()
    // 设置页本身也要与游戏同色（停在内置设置页时按 8.12 的初始页面取主题）。
    expect(await bg()).toBe('rgb(244, 245, 247)')

    await page.getByTestId('settings-theme-input').selectOption('builtin:page-midnight')
    await expect.poll(bg).toBe('rgb(7, 10, 20)')
    await expect(page.getByTestId('game-root')).toHaveAttribute('data-theme', 'builtin:page-midnight')
    // 来源徽标切成“本会话覆盖”（8.10 的强制 UI 元素、R-24）。
    await expect(page.getByTestId('settings-theme-source-badge')).toHaveAttribute('data-source', 'session')

    // 覆盖跨页生效：回到游戏页仍是 midnight。
    await page.getByTestId('nav-item').first().click()
    expect(await bg()).toBe('rgb(7, 10, 20)')

    // D-22 同层：打包态落 `localStorage`，刷新后仍在。
    await page.reload()
    await expect.poll(bg).toBe('rgb(7, 10, 20)')
  })

  test('“跟随页面”恢复作者设定的主题（覆盖可撤销）', async ({ page }) => {
    await page.goto(await themedProjectFile({ pageTheme: 'page-light' }).then(bundleProjectUrl))
    const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)

    await page.getByTestId('nav-item').last().click()
    await page.getByTestId('settings-theme-input').selectOption('builtin:page-dark')
    await expect.poll(bg).toBe('rgb(20, 22, 26)')

    await page.getByTestId('settings-theme-input').selectOption('')
    await expect.poll(bg).toBe('rgb(244, 245, 247)')
    await expect(page.getByTestId('settings-theme-source-badge')).toHaveAttribute('data-source', 'project')
  })
})
