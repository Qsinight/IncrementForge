/**
 * Playwright 配置（TECH_DESIGN 14.1 的“端到端”层、17.5 的 M5 交付标准）。
 *
 * ## 为什么 E2E 用 `vite preview` 而不是 `vite dev`
 *
 * E2E 要验的是**产物**，不是开发服务器：
 *
 * - M4 已证明“预览注入物在 jsdom 里可执行”，但 jsdom 没有真实布局、没有真实 `postMessage` 管线；
 * - 因此 M5 的关键一条（17.5 的交付标准：“**产物**可离线游玩”）必须在一个**真的浏览器**里打开
 *   一个**真的单文件 HTML**。
 *
 * dev server 会让被测对象变成“编辑器 + 预览 iframe”，那与产物无关；而 `vite preview`
 * 服务的是 `vite build` 的输出，与作者发布出去的东西同源。
 *
 * ## 两个 project 的分工
 *
 * | project | 被测对象 | 覆盖 14.1 端到端链路里的哪一段 |
 * | --- | --- | --- |
 * | `editor` | 编辑器静态产物（`apps/editor/dist`） | 载入示例项目 → 预览模拟 → 点击/购买 → 保存 → 导出项目 → 打包 |
 * | `packaged-game` | `iforge-pack` 产出的单文件 HTML（`file://` 协议） | 打开 → 游玩 → 导出存档 → 重新导入 |
 *
 * `packaged-game` 走 `file://` 而不是起服务器：**离线可玩**正是要验的东西，
 * 走 HTTP 就把它变成了“需要服务器的资源”，那正好漏掉最关键的一个失效模式
 * （产物里残留任何外部引用时，`file://` 下立刻失效）。
 */
import { defineConfig, devices } from '@playwright/test'

/** E2E 产物与报告目录（`e2e/.gitignore` 已忽略）。 */
const E2E_ARTIFACTS = 'e2e/.artifacts'

/**
 * 编辑器预览服务器地址。
 *
 * 显式用 `127.0.0.1`（IPv4 回环）而不是 `localhost`：Windows 上 `localhost`
 * 优先解析到 `::1`，而 `vite preview` 默认只监听 `localhost`，
 * 两边落到不同协议族上就永远连不通（症状是等 `webServer.url` 超时）。
 */
const PREVIEW_URL = 'http://127.0.0.1:4173'

/**
 * 属于 `packaged-game` project 的用例文件。
 *
 * 这两个 project 的被测对象不同（编辑器静态产物 vs `file://` 下的单文件 HTML），
 * 因此用**文件名**划分而不是标签：打包产物用例必须挂 `file://`，
 * 放进 `editor` project 会被 baseURL 劫持成编辑器页面。
 */
const PACKAGED_GAME_SPECS = /(?:packaged-game|gameplay)\.spec\.ts$/

export default defineConfig({
  testDir: './e2e',
  // 打包产物要真的编译（~1s），预览 iframe 的 tick 也要真的跑；
  // 默认 30s 对“打开产物并玩一会儿”偏紧，给到 60s。
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 串行：多个用例共用一个编辑器 profile 目录（IndexedDB 会互相污染）。
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: `${E2E_ARTIFACTS}/report` }]] : 'list',

  use: {
    baseURL: PREVIEW_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // 时区固定：打包态的自动存档与离线结算按墙钟算，宿主机的时区会让断言漂。
    timezoneId: 'Asia/Shanghai',
  },

  projects: [
    {
      name: 'editor',
      testIgnore: PACKAGED_GAME_SPECS,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'packaged-game',
      testMatch: PACKAGED_GAME_SPECS,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // 只服务**编辑器产物**；`packaged-game` 用例自己把单文件 HTML 挂到 `file://`，
    // 不需要这个服务器（对它是多余的启动开销与失败面）。
    //
    // `--host 127.0.0.1` 显式指定：vite 默认只监听 `localhost`，在 Windows 上它解析到
    // `::1`（IPv6 回环），而 `baseURL` 用的是 IPv4 回环 —— 两者不通，
    // 表现为 Playwright 等 `url` 等满 120s 超时，而服务器明明是活的。
    command: 'pnpm --filter @iforge/editor exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    cwd: '.',
    url: PREVIEW_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
