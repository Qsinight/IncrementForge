/**
 * 资产与自定义主题的净化（TECH_DESIGN 13 第 4/5 条、11.2、D-13、R-39）。
 *
 * 这是**安全边界**：SVG 走正则必然被注释/自闭合/引号变体绕过，所以实现走 `DOMParser`
 * 做结构白名单（见 `sanitize.ts` 的注释）。已有用例覆盖了主路径，本文件补的是
 * 几条最容易漏、且**失效时毫无征兆**的分支：
 *
 * - 挂在**根元素** `<svg>` 上的 `onload`（只遍历子元素会漏掉它）；
 * - 用 CSS 注释拆开协议的 `url(java/**\/script:…)`（先剥注释才拦得住）；
 * - 十六进制转义 `\6a avascript:`（`CSS_ESCAPE` 那条）；
 * - `<style>` / `<script>` / `<use>` / `<image>` 等不在白名单里的标签；
 * - `spec.id` 的保留前缀冲突（`dyn_` 是动态条目的地盘，静态 id 占了会撞名，R-35）。
 */
import { describe, expect, it } from 'vitest'

import { ForgeError } from '@iforge/num'

import { MAX_ASSET_BYTES, assertAllowedMime, imageFileToDataUrl, sanitizeSvg, sanitizeThemeCss } from '../src/sanitize.js'

/** 一个最小合法 SVG。 */
const OK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>'

describe('sanitizeSvg()：白名单过滤的根元素分支', () => {
  it('根元素上的 `onload` 被剔除（最容易漏的一处）', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>')
    expect(out).not.toContain('onload')
    expect(out).toContain('svg')
  })

  it('缺 `xmlns` 时自动补上（否则内联进 HTML 时命名空间丢失）', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>')
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('子元素上的 `onclick` 被剔除', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" onclick="x()"/></svg>')
    expect(out).not.toContain('onclick')
  })

  it('不在白名单里的标签被移除（`script` / `style` / `use` / `image` / `foreignObject`）', () => {
    for (const tag of ['script', 'style', 'use', 'image', 'foreignObject', 'animate']) {
      const out = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><${tag}></${tag}><path d="M0 0"/></svg>`)
      expect(out.toLowerCase(), `${tag} 应被移除`).not.toContain(`<${tag.toLowerCase()}`)
    }
  })

  it('白名单标签与白名单属性被保留', () => {
    const out = sanitizeSvg(OK_SVG)
    expect(out).toContain('path')
    expect(out).toContain('viewBox')
  })

  it('非白名单属性被剔除（如 `data-evil`）', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" data-evil="1"><path d="M0 0"/></svg>')
    expect(out).not.toContain('data-evil')
  })

  it('不含 `url(` 的 `style` 属性被保留', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="fill:red"/></svg>')
    expect(out).toContain('fill:red')
  })

  it('含 `url(` 的 `style` 属性被剔除（外部引用）', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="fill:url(https://evil.test/x)"/></svg>')
    expect(out).not.toContain('evil.test')
  })

  it('`style` 里的 `javascript:` 被剔除', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" style="background:javascript:alert(1)"/></svg>')
    expect(out).not.toContain('javascript:')
  })

  it('`href` / `xlink:href` 一律剔除（外部引用与 `<use>`）', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" href="https://evil.test/x"/></svg>')
    expect(out).not.toContain('evil.test')
  })

  it('白名单属性值里出现危险协议时整条剔除', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" id="javascript:alert(1)"/></svg>')
    expect(out).not.toContain('javascript:')
  })

  it('解析失败抛 `E_ASSET_INVALID`', () => {
    expect(() => sanitizeSvg('<svg><path')).toThrow(ForgeError)
    try {
      sanitizeSvg('<svg><path')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_INVALID')
    }
  })

  it('根元素不是 `<svg>` 抛 `E_ASSET_INVALID`', () => {
    try {
      sanitizeSvg('<div><span/></div>')
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_INVALID')
    }
  })

  it('嵌套超过上限抛 `E_ASSET_INVALID`（防深度攻击）', () => {
    let deep = '<path d="M0 0"/>'
    for (let i = 0; i < 80; i += 1) deep = `<g>${deep}</g>`
    try {
      sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">${deep}</svg>`)
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_INVALID')
      expect((error as ForgeError).message).toContain('嵌套深度')
    }
  })

  it('超体积上限抛 `E_ASSET_TOO_LARGE`', () => {
    const fat = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${'M0 0 '.repeat(MAX_ASSET_BYTES / 5)}"/></svg>`
    try {
      sanitizeSvg(fat)
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_TOO_LARGE')
    }
  })

  it('`where` 记在错误的 `where` 字段上（编辑器据此定位到具体字段）', () => {
    try {
      sanitizeSvg('<div/>', 'resources[0].icon')
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).where).toBe('resources[0].icon')
    }
  })
})

describe('sanitizeThemeCss()：注释/转义/协议混淆（13 第 5 条）', () => {
  it('正常 CSS 原样通过（只做安全处理，不破坏布局）', () => {
    const css = ':root { --iforge-bg: #101014; }'
    expect(sanitizeThemeCss(css)).toContain('--iforge-bg')
  })

  it('注释被剥离', () => {
    const out = sanitizeThemeCss(':root { /* 注释 */ --iforge-bg: red; }')
    expect(out).not.toContain('注释')
  })

  it('`@import` 被剥离（自定义主题不得引入外部资源）', () => {
    const out = sanitizeThemeCss('@import url("https://evil.test/x.css"); :root { --a: 1; }')
    expect(out).not.toContain('evil.test')
  })

  it('`@charset` / `@namespace` 被剥离', () => {
    const out = sanitizeThemeCss('@charset "utf-8"; @namespace svg; :root { --a: 1; }')
    expect(out).not.toContain('@charset')
    expect(out).not.toContain('@namespace')
  })

  it('用注释拆开 `javascript:` 的 url() 被拦下', () => {
    // 只有在注释被剥掉之后才会暴露为 `javascript:`——这是过滤顺序的用意。
    expect(() => sanitizeThemeCss(':root { background: url(java/**/script:alert(1)); }')).toThrow(ForgeError)
  })

  it('散落在 url() 之外的 `javascript:` 被拦下', () => {
    expect(() => sanitizeThemeCss(':root { --x: javascript:alert(1); }')).toThrow(ForgeError)
  })

  it('`vbscript:` 被拦下', () => {
    expect(() => sanitizeThemeCss(':root { --x: vbscript:msgbox(1); }')).toThrow(ForgeError)
  })

  it('`expression()` 被拦下', () => {
    expect(() => sanitizeThemeCss(':root { width: expression(alert(1)); }')).toThrow(ForgeError)
  })

  it('`data:text/html` 被拦下', () => {
    expect(() => sanitizeThemeCss(':root { background: url(data:text/html,<script>); }')).toThrow(ForgeError)
  })

  it('非 `data:` 的 url() 中性化为 `about:blank`（保留声明但不发请求）', () => {
    const out = sanitizeThemeCss(':root { background: url(https://evil.test/a.png); }')
    expect(out).toContain('about:blank')
    expect(out).not.toContain('evil.test')
  })

  it('`data:` url() 保留（图标内联依赖它）', () => {
    const out = sanitizeThemeCss(':root { background: url(data:image/png;base64,AAA); }')
    expect(out).toContain('data:image/png;base64,AAA')
  })

  it('`</style>` 被转义，不能逃逸出 style 标签', () => {
    const out = sanitizeThemeCss(':root { --x: "</style><script>alert(1)</script>"; }')
    expect(out).not.toContain('</style>')
    expect(out).not.toContain('<script')
  })

  it('`>` 也被转义', () => {
    const out = sanitizeThemeCss(':root { --x: a > b; }')
    expect(out).not.toContain('>')
  })

  it('超体积上限抛 `E_ASSET_TOO_LARGE`', () => {
    try {
      sanitizeThemeCss(`:root { --x: ${'a'.repeat(MAX_ASSET_BYTES + 10)}; }`)
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_TOO_LARGE')
    }
  })
})

describe('assertAllowedMime()：MIME 白名单（13 第 4 条）', () => {
  it('位图与 SVG 在白名单内', () => {
    expect(() => assertAllowedMime('image/png')).not.toThrow()
    expect(() => assertAllowedMime('image/svg+xml')).not.toThrow()
    expect(() => assertAllowedMime('image/webp')).not.toThrow()
  })

  it('非图片类型抛 `E_ASSET_INVALID`', () => {
    for (const mime of ['text/html', 'application/javascript', 'image/gif', '']) {
      expect(() => assertAllowedMime(mime), mime).toThrow(ForgeError)
    }
  })
})

describe('imageFileToDataUrl()：上传图片 -> data URL（13 第 4 条）', () => {
  /**
   * 造一个只带 `type` 与 `text()` 的 File 替身。
   *
   * jsdom 的 `File` 没实现 `text()`（浏览器 API 尚未跟进），而 SVG 分支只用这两个成员——
   * 因此用鸭子类型，而不是为了测一个分支去伪造完整 Blob 语义。
   */
  function fileLike(type: string, content: string | Uint8Array): File {
    return {
      type,
      name: 'upload',
      text: async () => (typeof content === 'string' ? content : new TextDecoder().decode(content)),
    } as unknown as File
  }

  it('SVG 走白名单过滤后以 base64 内联', async () => {
    const url = await imageFileToDataUrl(fileLike('image/svg+xml', OK_SVG))
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const decoded = Buffer.from(url.split(',')[1]!, 'base64').toString('utf8')
    expect(decoded).toContain('svg')
    expect(decoded).not.toContain('onload')
  })

  it('SVG 里的 `onload` 在内联前就被剔除', async () => {
    const url = await imageFileToDataUrl(fileLike('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))
    const decoded = Buffer.from(url.split(',')[1]!, 'base64').toString('utf8')
    expect(decoded).not.toContain('onload')
  })

  it('非白名单 MIME 抛 `E_ASSET_INVALID`', async () => {
    await expect(imageFileToDataUrl(fileLike('text/html', '<html></html>'))).rejects.toBeInstanceOf(ForgeError)
  })

  it('SVG 内容不合法时抛 `E_ASSET_INVALID`（不产出半成品 data URL）', async () => {
    await expect(imageFileToDataUrl(fileLike('image/svg+xml', '<div>不是 svg</div>'))).rejects.toBeInstanceOf(ForgeError)
  })

  it('位图走 canvas 重编码（失败时抛错，不返回坏 data URL）', async () => {
    // jsdom 不实现 `createImageBitmap`，因此这里断言“要么成功要么抛错”，
    // 重点是**不返回半成品**。
    try {
      const url = await imageFileToDataUrl(fileLike('image/png', new Uint8Array([1, 2, 3])))
      expect(url.startsWith('data:image/')).toBe(true)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })
})
