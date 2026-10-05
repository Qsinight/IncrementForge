/**
 * 产物指纹与 HTML 模板（TECH_DESIGN 11.1 末条、17.3、13 第 5 条）。
 *
 * 指纹与模板都是**纯函数**，因此全部断言都不需要浏览器也不需要编译运行时——
 * 这正是把它们从 `packageGame` 里拆出来的理由（可测性）。
 */
import { describe, expect, it } from 'vitest'

import { createDefaultProject, createExampleProject, ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { fingerprintText, gameFileName, projectFingerprint } from '../src/fingerprint.js'
import { bundleProjectId, escapeForScript, renderBundleHtml, renderThemeCss } from '../src/template.js'

describe('fingerprint：内容变了才变（11.1 末条）', () => {
  it('同一份项目两次求值结果一致', () => {
    expect(projectFingerprint(createExampleProject())).toBe(projectFingerprint(createExampleProject()))
  })

  it('改动条目名会改变指纹（内容变了一定要出新产物）', () => {
    const before = projectFingerprint(createExampleProject())
    const project = createExampleProject()
    project.resources[0]!.name = '改名了'
    expect(projectFingerprint(project)).not.toBe(before)
  })

  it('只改 modifiedAt / createdAt **不**改变指纹（纯时间戳，与内容无关）', () => {
    const project = createExampleProject()
    const before = projectFingerprint(project)
    project.meta.modifiedAt = '2030-01-01T00:00:00.000Z'
    project.meta.createdAt = '2030-01-01T00:00:00.000Z'
    expect(projectFingerprint(project)).toBe(before)
  })

  it('改引擎版本会改变指纹（运行时语义变了，存档兼容性可能变）', () => {
    const project = createExampleProject()
    const before = projectFingerprint(project)
    project.engineVersion = '9.9.9'
    expect(projectFingerprint(project)).not.toBe(before)
  })

  it('改 settings 会改变指纹', () => {
    const project = createExampleProject()
    const before = projectFingerprint(project)
    project.settings.tickRate = 60
    expect(projectFingerprint(project)).not.toBe(before)
  })

  it('fingerprintText 是稳定的 8 位十六进制', () => {
    expect(fingerprintText('')).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprintText('abc')).toBe(fingerprintText('abc'))
    expect(fingerprintText('abc')).not.toBe(fingerprintText('abd'))
  })

  it('非 ASCII 内容参与哈希（UTF-8 字节序列，不是 UTF-16 码元）', () => {
    expect(fingerprintText('矿')).toBe(fingerprintText('矿'))
    expect(fingerprintText('矿')).not.toBe(fingerprintText('矿石'))
  })
})

describe('gameFileName：非法文件名字符被替换', () => {
  it('保留中文名并把 `/ : * ? " < > |` 换成下划线', () => {
    // 17.2 的示例项目名是「示例：矿石工厂」，其中 `：` 是全角，不在替换表里。
    expect(gameFileName(createExampleProject())).toBe('示例：矿石工厂.html')
    const project = createDefaultProject()
    project.meta.name = 'a/b:c*d?e"f<g>h|i'
    expect(gameFileName(project)).toBe('a_b_c_d_e_f_g_h_i.html')
  })

  it('空名回落到 game', () => {
    const project = createDefaultProject()
    project.meta.name = '   '
    expect(gameFileName(project)).toBe('game.html')
  })
})

describe('escapeForScript：`<` 不再能逃逸（17.3、13 第 5 条）', () => {
  it('`<` 全部变成 \\u003c，因此 `</script` 与 `<!--` 都不成立', () => {
    const escaped = escapeForScript('{"d":"</script><!-- x"}')
    expect(escaped).not.toContain('<')
    expect(escaped).toContain('\\u003c/script')
    expect(escaped).toContain('\\u003c!--')
  })

  it('转义后的 JSON 仍是**合法** JSON 且值不变（`\\u003c` 解析回 `<`）', () => {
    // 这条是选 `\\u003c` 而不是 `\\/` 的原因：`\\!` 会让 JSON.parse 直接抛
    // “Bad escaped character”，等于把产物做坏了。
    const original = { description: '</script><!-- x', expr: 'a < b && c > d' }
    const parsed = JSON.parse(escapeForScript(JSON.stringify(original))) as typeof original
    expect(parsed.description).toBe(original.description)
    expect(parsed.expr).toBe(original.expr)
  })

  it('`>`/`&` 不转义（JS 里的 `>>` 与 `&` 是合法语法，转义会把脚本改坏）', () => {
    expect(escapeForScript('a>>b & c')).toBe('a>>b & c')
  })
})

describe('renderBundleHtml：单文件产物结构（17.3）', () => {
  const meta = {
    engineVersion: ENGINE_VERSION,
    builtAt: '2026-01-01T00:00:00.000Z',
    fingerprint: 'deadbeef',
    slotId: 'main',
    projectId: 'pkg-deadbeef',
  }

  function render(project: ProjectFile = createExampleProject(), runtimeSource = 'window.__X__=1;') {
    return renderBundleHtml({ project, meta, runtimeSource })
  }

  it('包含 doctype / charset / viewport / title', () => {
    const html = render()
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('<title>示例：矿石工厂</title>')
  })

  it('注入 window.__IFORGE_BOOTSTRAP__，含 project / save / meta 三段', () => {
    const html = render()
    expect(html).toContain('window.__IFORGE_BOOTSTRAP__=')
    const json = /window\.__IFORGE_BOOTSTRAP__=(\{[\s\S]*?\});/.exec(html)?.[1]
    expect(json).toBeTruthy()
    const parsed = JSON.parse(json!) as { project: ProjectFile; save: null; meta: typeof meta }
    expect(parsed.project.meta.name).toBe('示例：矿石工厂')
    // 产物**不携带存档**：玩家的进度在 `localStorage`（10.3），带存档等于替玩家做主。
    expect(parsed.save).toBeNull()
    expect(parsed.meta.fingerprint).toBe('deadbeef')
  })

  it('挂载点 id 是 app（17.3 的 `<div id="app">`）', () => {
    expect(render()).toContain('<div id="app"></div>')
  })

  it('引导数据里的 `</script>` 被转义，整份产物只有模板自己的两个结束标签', () => {
    const project = createExampleProject()
    project.meta.description = '</script><!-- x'
    const html = render(project)
    // 模板自己有两处 `</script>`（引导数据 + 运行时），数据里的那个已被转义。
    expect(html.split('</script').length - 1).toBe(2)
    expect(html).not.toContain('</script><!--')
  })

  it('项目描述里的 HTML 被转义（meta description 属性）', () => {
    const project = createExampleProject()
    project.meta.description = '"><script>alert(1)</script>'
    const html = render(project)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('项目名里的 HTML 被转义（<title>）', () => {
    const project = createDefaultProject()
    project.meta.name = '</title><script>x</script>'
    const html = render(project)
    expect(html).toContain('&lt;/title&gt;')
  })

  it('`<noscript>` 存在：禁用了 JS 也能看到提示而不是空白', () => {
    expect(render()).toContain('<noscript>')
  })
})

describe('renderThemeCss：自定义主题内联且不可逃逸 style（11.1 第 1 步、13 第 5 条）', () => {
  it('过滤空白主题', () => {
    expect(renderThemeCss(['', '   '])).toBe('')
  })

  it('保留合法 CSS', () => {
    expect(renderThemeCss([':root{--iforge-bg:#000}'])).toContain('--iforge-bg')
  })

  it('`<` 被转义成 CSS 转义序列，手改项目文件也无法闭合 <style> 注入脚本', () => {
    const css = ':root{--iforge-bg:#000}</style><script>alert(1)</script>'
    const out = renderThemeCss([css])
    expect(out).not.toContain('<')
    // CSS 的 `\3c ` 是一个 < —— 浏览器不会把它当成标签起始。
    expect(out).toContain('\\3c ')
  })
})

describe('bundleProjectId：由指纹派生存档键（10.1）', () => {
  it('同一指纹得到同一个 projectId（否则刷新会丢进度）', () => {
    expect(bundleProjectId('deadbeefcafe')).toBe('pkg-deadbeefcafe')
  })

  it('指纹不同则 projectId 不同（两份产物的进度不互相覆盖）', () => {
    expect(bundleProjectId('aaaa1111')).not.toBe(bundleProjectId('bbbb2222'))
  })
})
