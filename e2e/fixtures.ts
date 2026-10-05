/**
 * E2E 夹具（TECH_DESIGN 14.1 的端到端层）。
 *
 * ## 为什么用夹具而不是在每个 spec 里各写一遍
 *
 * E2E 最贵的不是断言而是**准备**：编辑器要等 `game:ready`、要导入示例项目。
 * 这些步骤在多个 spec 里完全相同，一旦某个 spec 少等了一步，失败信息会指向断言而不是
 * “你还没等到预览就绪”。因此把等待条件集中成 `waitForPreviewReady()` 等具名函数，
 * 让每个用例只写**自己在验什么**。
 *
 * ## 示例项目怎么进编辑器
 *
 * 走**真实 UI 路径**：顶部标题栏的“导入”（PRD 工作页面一览），用文件选择器喂一份
 * 由 `scripts/write-example-project.mjs` 生成的 `.json`。
 *
 * 为什么不直接往 `projectStore` 里塞数据：那会把编辑器自己的导入链路（Zod 校验 →
 * 迁移 → 覆盖确认 → 重建预览）整段漏掉，而 E2E 恰恰要验这条链路。
 * 为什么不点“用示例项目新建”：`newExampleProject()` 只在单测里用，没有 UI 入口
 * （V1.0 的顶部标题栏只有 PRD 规定的六个按钮，加一个“示例”按钮等于超出 PRD 范围）。
 *
 * ## 存储隔离
 *
 * 编辑器用 IndexedDB 持久化（10.1）。Playwright 默认给每个用例独立的 `BrowserContext`，
 * IndexedDB 自然隔离，因此用例之间不会互相读到上一个用例留下的项目。
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { expect, test as base } from '@playwright/test'
import type { Page } from '@playwright/test'

export const test = base
// `describe` 在两个地方都能拿到（`test.describe` 与顶层导出），但顶层导出在
// `@playwright/test` 的 ESM 互操作下不可用（"does not provide an export named"），
// 因此统一走 `test.describe`，spec 里不再单独 import。
export { expect }

/**
 * 预览 iframe 的挂载点（9.1 的不透明源 sandbox iframe）。
 *
 * 必须指向 **iframe 元素本身**而不是外层容器 div：Playwright 的 `frameLocator`
 * 遇到非 iframe 节点会报 “resolved to `<div>`, `<iframe>` was expected”。
 */
const PREVIEW_FRAME = '[data-testid="preview-iframe"]'

/** 示例项目文件的缓存目录（每个 worker 一份，避免并发写同一个文件）。 */
let examplePathPromise: Promise<string> | null = null

/**
 * 备好示例项目文件（17.2 的示例，10.2「导出项目」的格式）。
 *
 * 走**生产的生成脚本**（`write-example-project.mjs` -> `writeExampleProject()`，
 * 它内部再走 `@iforge/model` 的 `createExampleProject()`）。因此 E2E 用的示例项目
 * 与单测、文档里的是**同一份**，不会各自漂移。
 */
export async function exampleProjectFile(): Promise<string> {
  examplePathPromise ??= (async () => {
    // 复用生产脚本的执行机制（`run-ts.mjs` 的注释解释了为什么 Node 需要 esbuild 现场打包）。
    const { runTs } = (await import('../packages/build/scripts/run-ts.mjs')) as {
      runTs(entry: string, args?: string[]): Promise<Record<string, unknown>>
    }
    const entry = fileURLToPath(new URL('../packages/build/src/write-example.ts', import.meta.url))
    const { writeExampleProject } = (await runTs(entry)) as {
      writeExampleProject(target: string): Promise<string>
    }
    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-'))
    const target = join(dir, 'example.json')
    await writeExampleProject(target)
    return target
  })()
  return examplePathPromise
}

/** 读取示例项目文件的内容（用于断言导入后的项目确实落盘成同一份）。 */
export async function exampleProjectJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await exampleProjectFile(), 'utf8')) as Record<string, unknown>
}

/**
 * 一个**可玩**的示例项目文件（把 `p2` 的 `disabled` 置假）。
 *
 * ## 为什么需要它
 *
 * `17.2` 的示例项目里 `p2`（实验区）是 `disabled: true` —— 它的用途是**演示页面禁用的继承**
 * （PRD 页面编辑器 4：禁用时其下生成器/升级不可购买、不可点击），因此那条页面上的点击器
 * **没有“点击”按钮**（8.11：`ClickerCard` 只在 `!disabled` 时渲染按钮）。
 *
 * 但示例项目的矿石只能由那个点击器或升级产出（`r1.initial = 0`、`g1.initial = 0`），
 * 所以**原样的示例项目开局无事可做**——它是一份文档夹具，不是可玩演示。
 *
 * 于是把它拆成两个用途各自的夹具：
 *
 * | 夹具 | 用途 | 断言 |
 * | --- | --- | --- |
 * | `exampleProjectFile()` | 页面禁用/可见继承、导航、布局 | 禁用页的条目确实不可交互 |
 * | `playableProjectFile()` | 真正的游玩链路（点击/购买/存档/导入） | 产物能玩 |
 *
 * 两者的差异**只有 `p2.disabled` 这一个布尔**，因此“产物可离线游玩”的结论仍然建立在
 * 同一份项目内容上。
 */
let playablePathPromise: Promise<string> | null = null

export async function playableProjectFile(): Promise<string> {
  playablePathPromise ??= (async () => {
    const project = (await exampleProjectJson()) as {
      pages: { id: string; disabled: boolean }[]
    }
    for (const page of project.pages) page.disabled = false

    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-play-'))
    const target = join(dir, 'playable.json')
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
    return target
  })()
  return playablePathPromise
}

/**
 * 一个**可玩**且**价格便宜**的示例项目（把 `p2` 的 `disabled` 置假，并把价格调到“点几下就买得起”）。
 *
 * ## 为什么还需要第二个可玩变体
 *
 * `playableProjectFile()` 只解决了“开局有事可做”，但 17.2 的示例价格是
 * `10 * 1.15 ^ gen.g1.bought`：第 10 台矿机累计要 ~270 矿石，而唯一的来路是**点一下得 1 个**的点击器。
 * 于是“买第一台生成器 → 自动产出 → 满足升级条件 → 触发动态创建”这条主链路在 E2E 里要花几百次点击，
 * 那不是 E2E 该付的代价（也正是真实浏览器测试相对单测的**唯一**优势被浪费掉的地方）。
 *
 * 因此这里把三处价格/产出改到 E2E 尺度（默认值见 `CheapProjectOptions`）：
 *
 * | 字段 | 原值 | 默认夹具 | 目的 |
 * | --- | --- | --- | --- |
 * | `generators[g1].costs[0].amount` | `10 * 1.15 ^ gen.g1.bought` | `1` | 一次点击买一台 |
 * | `upgrades[u1].costs[0].amount` | `100` | `2` | 买完 5 台就能买升级 |
 * | `generators[g1].produces[0].amount` | `1` | `10` | 10 台 = 100/s，两秒内跨过“千”这个格式阈值 |
 *
 * **条件、效果、动态创建表达式一律不动**（`gen.g1.bought >= 5 / >= 10 / >= 20`、`set(...)`、
 * `create(...)`），所以这条夹具验的仍然是 17.2 的那套语义，只是把等待时间从“几百次点击”压到“十几次点击”。
 */
export interface CheapProjectOptions {
  /** `g1.buyAmount`：8.6 的三档（`1`=固定次数、`0`=最大购买、`5`=一次买 5 台）。 */
  buyAmount?: string
  /** `g1.produces[0].amount`（单件速率）。 */
  produces?: string
  /** `g1.costs[0].amount`（单件价格）。 */
  cost?: string
  /** `u1.costs[0].amount`（升级价格）。 */
  upgradeCost?: string
}

const cheapCache = new Map<string, Promise<string>>()

/** 便宜夹具（默认参数就是上面那张表）。同一组参数只生成一次文件。 */
export function cheapProjectFile(options: CheapProjectOptions = {}): Promise<string> {
  const settings: Required<CheapProjectOptions> = {
    buyAmount: options.buyAmount ?? '1',
    produces: options.produces ?? '10',
    cost: options.cost ?? '1',
    upgradeCost: options.upgradeCost ?? '2',
  }
  const key = JSON.stringify(settings)
  const cached = cheapCache.get(key)
  if (cached) return cached
  const pending = (async () => {
    const project = (await exampleProjectJson()) as {
      generators: { id: string; buyAmount: string; costs: { amount: string }[]; produces: { amount: string }[] }[]
      upgrades: { costs: { amount: string }[] }[]
      pages: { disabled: boolean }[]
    }
    for (const page of project.pages) page.disabled = false
    for (const generator of project.generators) {
      if (generator.id !== 'g1') continue
      generator.buyAmount = settings.buyAmount
      for (const cost of generator.costs) cost.amount = settings.cost
      for (const produce of generator.produces) produce.amount = settings.produces
    }
    for (const upgrade of project.upgrades) {
      for (const cost of upgrade.costs) cost.amount = settings.upgradeCost
    }

    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-cheap-'))
    const target = join(dir, 'cheap.json')
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
    return target
  })()
  cheapCache.set(key, pending)
  return pending
}

/**
 * 一个**条目不少但没到虚拟化阈值**的页面（`p1` 上 14 条资源），用来验页面区域能上下滚动。
 *
 * ## 为什么单独造一个夹具（`manyEntriesProjectFile` 不够用）
 *
 * | 夹具 | 条目数 | 路径 | 能验什么 |
 * | --- | --- | --- | --- |
 * | `manyEntriesProjectFile` | > 40 | **虚拟化**，自带 `.entry-grid-scroll` | 虚拟窗口随滚动移动 |
 * | 本夹具 | 14（< 40） | **非虚拟化**，刻意**不套**滚动容器 | 滚动轴必须是祖先 `.game-main` |
 *
 * 后者正是缺陷的现场：8.11 明确“未超阈值时渲染全部且不套滚动容器”，因此页面上唯一的
 * 滚动轴是 `.game-main`。它一旦写成 `overflow: hidden`，第 8 张卡片以后的卡片就
 * 既看不见也够不着——**界面元素全都在 DOM 里、断言全绿、真机上滚不动**。
 *
 * 14 条是刻意选的：单列布局下每张资源卡片约 96px，14 张足以超出任何桌面/手机视口的
 * 主区高度，又远低于 40，不会误入虚拟化路径。
 */
let scrollingEntriesPromise: Promise<string> | null = null

export async function scrollingEntriesProjectFile(): Promise<string> {
  scrollingEntriesPromise ??= (async () => {
    const project = (await exampleProjectJson()) as {
      resources: { id: string; name: string; order: number }[]
      pages: { id: string; disabled: boolean; entries: { id: string; order: number }[] }[]
    }
    for (const page of project.pages) page.disabled = false

    const first = project.resources[0]!
    let order = project.resources.length
    for (let i = 2; i <= 14; i += 1) {
      order += 1
      project.resources.push({ ...structuredClone(first), id: `r${i}`, name: `矿石 ${i}`, order })
    }
    const page = project.pages.find((item) => item.id === 'p1')!
    let entryOrder = page.entries.length
    for (const resource of project.resources) {
      if (page.entries.some((entry) => entry.id === resource.id)) continue
      entryOrder += 1
      page.entries.push({ id: resource.id, order: entryOrder })
    }

    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-scroll-'))
    const target = join(dir, 'scroll.json')
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
    return target
  })()
  return scrollingEntriesPromise
}

/**
 * 一个**条目很多**的页面（`p1` 上 45 条资源 + 原有 3 条），用来验卡片虚拟化（12 性能预算）。
 *
 * 阈值 `VIRTUALIZE_THRESHOLD = 40` 按**当前页可见卡片数**判定，因此必须让**一页**超过 40 条；
 * 把条目分散到多个页面反而验不到（那正是该口径要避免的情形，见 README 的 D-56 说明）。
 */
let manyEntriesPromise: Promise<string> | null = null

export async function manyEntriesProjectFile(): Promise<string> {
  manyEntriesPromise ??= (async () => {
    const project = (await exampleProjectJson()) as {
      resources: { id: string; name: string; order: number }[]
      pages: { id: string; disabled: boolean; entries: { id: string; order: number }[] }[]
    }
    for (const page of project.pages) page.disabled = false

    const first = project.resources[0]!
    let order = project.resources.length
    for (let i = 2; i <= 46; i += 1) {
      order += 1
      project.resources.push({ ...structuredClone(first), id: `r${i}`, name: `矿石 ${i}`, order })
    }
    const page = project.pages.find((item) => item.id === 'p1')!
    let entryOrder = page.entries.length
    for (const resource of project.resources) {
      if (page.entries.some((entry) => entry.id === resource.id)) continue
      entryOrder += 1
      page.entries.push({ id: resource.id, order: entryOrder })
    }

    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-many-'))
    const target = join(dir, 'many.json')
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
    return target
  })()
  return manyEntriesPromise
}

/** 页面主题替换选项（PRD 页面编辑器 6、17.4）。 */
export interface PageThemeOptions {
  /** `p1` 的页面主题（内置 id 或自定义 CSS）。缺省不动。 */
  pageTheme?: string
  /** `p1` 里每条页面条目的条目主题。缺省**移除**显式值，即“跟随页面主题”。 */
  entryTheme?: string | null
}

/**
 * 一个只改**页面/条目主题**的可玩夹具（其余字段与 `playableProjectFile` 逐字相同）。
 *
 * ## 为什么主题要单独一个夹具
 *
 * PRD 页面编辑器 6 的“页面主题”管的是**整页**的观感：页面底色、顶部标题栏、数据仪表盘、
 * 底部导航栏必须与它一致。令牌在 `--iforge-page-*` 命名空间里，而壳层三个部件是
 * `.game-root` 的直接子节点——**不是** `.game-page` 的后代。令牌只内联到页面节时，
 * 作者把页面换成浅色主题就会看到“上面一栏深色、下面一片浅色”。
 *
 * 只断言 `.game-page` 的背景色**测不出来**：那一半本来就对。要验的是四处的
 * `background-color` 属于同一档（`toHaveCSS` 读的是**计算后**的值，
 * 且这些变量由 React 以行内样式施加，真浏览器里确实参与计算）。
 */
const themeCache = new Map<string, Promise<string>>()

export function themedProjectFile(options: PageThemeOptions = {}): Promise<string> {
  const settings: Required<PageThemeOptions> = {
    pageTheme: options.pageTheme ?? 'page-light',
    entryTheme: options.entryTheme === undefined ? null : options.entryTheme,
  }
  const key = JSON.stringify(settings)
  const cached = themeCache.get(key)
  if (cached) return cached
  const pending = (async () => {
    const project = (await exampleProjectJson()) as {
      pages: { id: string; disabled: boolean; theme: { kind: string; value: string }; entries: { theme?: unknown }[] }[]
    }
    for (const page of project.pages) page.disabled = false
    const first = project.pages[0]!
    first.theme = { kind: 'builtin', value: settings.pageTheme }
    for (const entry of first.entries) {
      // `null` = 删掉这个键 = “跟随页面主题”（PRD 页面编辑器 8，M3 的取舍）。
      if (settings.entryTheme === null) delete entry.theme
      else entry.theme = { kind: 'builtin', value: settings.entryTheme }
    }

    const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-theme-'))
    const target = join(dir, 'theme.json')
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
    return target
  })()
  themeCache.set(key, pending)
  return pending
}

/**
 * 把一份项目文件走**生产管线**（`iforge-pack`）打成单文件 HTML，返回它的 `file://` URL。
 *
 * 走 `runCli` 而不是编辑器里的 `packageGame()`：这里的被测对象是**产物字节**（11.1/17.3），
 * 与 `packaged-game.spec.ts` 用的是同一条命令，因此“编辑器打包”和“命令行打包”验的是同一份东西。
 *
 * 按项目文件路径缓存：同一个 worker 内多份用例共用一份产物，既省掉 ~1s 的编译，
 * 又保证“这批用例验的是同一份字节”（11.1 的体积/指纹断言才有意义）。
 */
const bundleCache = new Map<string, Promise<string>>()

export async function bundleProjectUrl(projectPath: string): Promise<string> {
  const cached = bundleCache.get(projectPath)
  if (cached) return cached
  const pending = (async () => {
    // 复用生产脚本的执行机制（`run-ts.mjs` 的注释解释了为什么 Node 需要 esbuild 现场打包）。
    const { runTs } = (await import('../packages/build/scripts/run-ts.mjs')) as {
      runTs(entry: string, args?: string[]): Promise<Record<string, unknown>>
    }
    const cliEntry = fileURLToPath(new URL('../packages/build/src/cli.ts', import.meta.url))
    const { runCli } = (await runTs(cliEntry)) as {
      runCli(io?: { argv?: string[] }): Promise<number>
    }

    const dir = await mkdtemp(join(tmpdir(), 'iforge-game-'))
    const out = join(dir, 'game.html')
    const exitCode = await runCli({ argv: [projectPath, '--out', out] })
    if (exitCode !== 0) throw new Error(`iforge-pack 退出码 ${exitCode}`)

    const html = await readFile(out, 'utf8')
    // 顺手把原始 HTML 落到 e2e/.artifacts，方便失败时人工查看。
    const artifact = join(process.cwd(), 'e2e', '.artifacts', `${basename(projectPath, '.json')}.html`)
    await mkdir(dirname(artifact), { recursive: true }).catch(() => undefined)
    await writeFile(artifact, html, 'utf8').catch(() => undefined)
    return pathToFileURL(out).href
  })()
  bundleCache.set(projectPath, pending)
  return pending
}

/**
 * 把文本写进一个临时 `.json` 并返回路径（喂给文件选择器）。
 *
 * 用于“导出 → 再导入”这类需要在**用例里中转一次字节**的场景：
 * 导出得到的是下载流，导入要的是文件路径，中间必须有落盘这一步。
 */
export async function writeTempJson(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iforge-e2e-io-'))
  const target = join(dir, name)
  await writeFile(target, text, 'utf8')
  return target
}

/** 预览 iframe 的 frame handle（9.1 的不透明源 sandbox iframe）。 */
export function previewFrame(page: Page) {
  return page.frameLocator(PREVIEW_FRAME)
}

/**
 * 等编辑器预览区就绪。
 *
 * 断言两件事，缺一不可：
 *
 * 1. `game:ready` 已到达（`preview-status` 这个“连接中”占位消失）；
 * 2. 预览 iframe **内部**真的渲染出了游戏视图（标题栏可见）。
 *
 * 只等 (1) 会在 iframe 内容还没渲染时就继续；只等 (2) 会在宿主还没收到 `game:ready`
 * 时就继续——此时“打包”按钮仍是禁用的（9.3 第 2 步）。
 */
export async function waitForPreviewReady(page: Page): Promise<void> {
  await expect(page.getByTestId('preview-status')).toHaveCount(0, { timeout: 30_000 })
  await expect(previewFrame(page).getByTestId('game-title')).toBeVisible({ timeout: 30_000 })
}

/**
 * 导入示例项目（走顶部标题栏的“导入”）。
 *
 * 编辑器的文件选择器是**动态创建**的（`document.createElement('input')` + `.click()`），
 * 不在 DOM 里，因此必须用 Playwright 的 `filechooser` 事件接住它；
 * 随后的“覆盖当前项目”确认对话框要点确认（10.2 / D-33）。
 */
export async function importExampleProject(page: Page): Promise<void> {
  await importProjectFile(page, await exampleProjectFile())
}

/**
 * 导入任意一份项目文件（走顶部标题栏的“导入”，10.2 的真实链路）。
 *
 * 编辑器的文件选择器是**动态创建**的（`document.createElement('input')` + `.click()`），
 * 不在 DOM 里，因此必须用 Playwright 的 `filechooser` 事件接住它；
 * 随后的“覆盖当前项目”确认对话框要点确认（10.2 / D-33）。
 *
 * @param waitReady 导入后是否等预览重新就绪。换项目会重建 iframe（9.3 第 4 步），
 *   因此默认要等；只想验“校验没过”的用例可以关掉。
 */
export async function importProjectFile(page: Page, filePath: string, waitReady = true): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('titlebar-import').click()
  const chooser = await chooserPromise
  await chooser.setFiles(filePath)

  const confirm = page.getByTestId('confirm-import')
  await expect(confirm).toBeVisible({ timeout: 10_000 })
  await confirm.click()

  // 换项目会重建 iframe：等它重新就绪。
  if (waitReady) await waitForPreviewReady(page)
}

/** 读取预览 iframe 内某个 `data-testid` 的文本（与宿主看到的数字对照）。 */
export async function frameText(page: Page, testId: string): Promise<string> {
  return (await previewFrame(page).getByTestId(testId).first().textContent()) ?? ''
}

/** 触发一次下载并返回其内容（打包版的“导出存档”、编辑器的“导出项目”）。 */
export async function readDownload(page: Page, trigger: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()])
  const stream = await download.createReadStream()
  if (!stream) throw new Error('下载没有可读流')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 当前页面里第一个资源的数量（仪表盘数据，PRD 预览区 2）。
 *
 * 断言**资源**而不是生成器的拥有数量：8.5 的 `click` 走 `applyProduces`，增加的是产出目标；
 * 点击器自身的 `owned` 只受 `max` 约束、点击不变。
 *
 * 读数用 `textContent` 再转数字：仪表盘的数字会带千分位/字母记数/科学计数，
 * `toHaveText` 走字符串精确比较，不适合这种“比大小”的断言。
 */
export async function gameResourceAmount(page: Page): Promise<number> {
  const text = await page.getByTestId('resource-amount').first().textContent()
  return Number((text ?? '0').replace(/[^\d.e+-]/g, ''))
}

/** 收集页面脚本错误（“功能断言全绿、真机上一片裸文字”这类失效只有 `pageerror` 能看见）。 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}
