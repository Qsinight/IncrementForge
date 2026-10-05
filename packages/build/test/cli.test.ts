/**
 * `iforge-pack` 命令行入口（TECH_DESIGN 11.1 的管线、CLI 形态、14.3 的门禁命令）。
 *
 * CLI 存在的三个理由（见 `cli.ts` 头注释）里，最要紧的是**能被脚本调用**：
 * 14.3 的“打包产物冒烟测试”与 M5 的 e2e 都靠它产出产物。因此本文件按
 * “退出码契约”来测——`0` 成功 / `1` 校验或打包失败 / `2` 用法错误——
 * 并覆盖参数解析里最容易错的那条：`--out` 的**值**不能被当成输入项目。
 *
 * 这些用例真的跑 esbuild（`compileRuntimeBundle`），所以放在 node 环境的
 * `build` 项目里（见 `vitest.config.ts` 的注释），且给足超时。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PROJECT_FORMAT, createDefaultProject, createExampleProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { runCli } from '../src/cli.js'
import { writeExampleProject } from '../src/write-example.js'

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'iforge-pack-cli-'))
}, 120_000)

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** 把项目写成临时文件，返回绝对路径。 */
async function projectFile(project: ProjectFile, name: string): Promise<string> {
  const path = resolve(tempDir, name)
  await writeFile(path, JSON.stringify(project, null, 2), 'utf8')
  return path
}

/** 收集 stdout/stderr，并返回退出码。 */
async function cli(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli({
    argv: args,
    cwd: tempDir,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('用法与参数解析（退出码 0 / 2）', () => {
  it('`--help` 打印用法并返回 0', async () => {
    const r = await cli(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('iforge-pack')
    expect(r.out).toContain('--out')
    expect(r.out).toContain('--sizes')
  })

  it('`-h` 与 `--help` 等价', async () => {
    const r = await cli(['-h'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('用法')
  })

  it('`--help` 优先于位置参数（带项目文件也只打印帮助）', async () => {
    const path = await projectFile(createExampleProject(), 'help-project.json')
    const r = await cli([path, '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('用法')
    expect(r.err).toBe('')
  })

  it('没有位置参数 -> 退出码 2 并把用法写 stderr', async () => {
    const r = await cli([])
    expect(r.code).toBe(2)
    expect(r.err).toContain('用法')
    expect(r.out).toBe('')
  })

  it('只有开关没有输入文件 -> 退出码 2', async () => {
    const r = await cli(['--sizes'])
    expect(r.code).toBe(2)
  })
})

describe('读取与解析失败（退出码 1）', () => {
  it('项目文件不存在 -> 1 并给出可读错误', async () => {
    const r = await cli(['no-such-project.json'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('读取或解析项目文件失败')
  })

  it('非法 JSON -> 1', async () => {
    const path = resolve(tempDir, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    const r = await cli([path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('读取或解析项目文件失败')
  })

  it('Schema 不符（缺 `format`）-> 1', async () => {
    const path = await projectFile({ version: 1 } as unknown as ProjectFile, 'schema-bad.json')
    const r = await cli([path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('读取或解析项目文件失败')
  })

  it('空文件 -> 1', async () => {
    const path = resolve(tempDir, 'empty.json')
    await writeFile(path, '', 'utf8')
    const r = await cli([path])
    expect(r.code).toBe(1)
  })
})

describe('打包前校验拦下（11.1 的 7 条，退出码 1）', () => {
  it('未内联的 `kind:asset` 引用 -> 1 且进的是**打包校验**分支（11.1 第 7 条）', async () => {
    // Zod 放行、只有 `validateForPack` 能拦住的缺陷——这才是 CLI 里
    // “先单独跑一遍校验，不通过就不必编译运行时（约 300ms）”那段代码的覆盖面。
    const project = createExampleProject()
    project.resources[0]!.icon = { kind: 'asset', value: 'missing.png' }
    const path = await projectFile(project, 'uninlined-asset.json')
    const r = await cli([path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('打包前校验未通过')
    expect(r.err).toContain('E_ASSET_TOO_LARGE')
  })

  it('表达式语法错误 / 悬空引用 / 非法 id 在**解析阶段**就被拦下（早于打包校验）', async () => {
    // 这三类同时被 Zod refinement 覆盖，因此走的是 `读取或解析项目文件失败` 那条路径——
    // 记录这个分层，避免以后误以为“打包校验”是唯一的拦截点。
    const defects: Array<(p: ProjectFile) => void> = [
      (p) => {
        p.generators[0]!.costs[0]!.amount = '10 *'
      },
      (p) => {
        p.generators[0]!.costs[0]!.materialId = 'rNope'
      },
      (p) => {
        p.resources[0]!.id = 'my-resource'
      },
    ]
    for (const [i, mutate] of defects.entries()) {
      const project = createExampleProject()
      mutate(project)
      const path = await projectFile(project, `parse-stage-${i}.json`)
      const r = await cli([path])
      expect(r.code, `缺陷 ${i} 应返回 1`).toBe(1)
      expect(r.err).toContain('读取或解析项目文件失败')
    }
  })

  it('不合法 id -> 1', async () => {
    const project = createExampleProject()
    project.resources[0]!.id = 'my-resource'
    const path = await projectFile(project, 'bad-id.json')
    const r = await cli([path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('E_ID_INVALID')
  })

  it('校验不过时**不产出文件**（不留下半成品）', async () => {
    const project = createExampleProject()
    project.resources[0]!.id = 'bad-id'
    const path = await projectFile(project, 'no-partial.json')
    const out = resolve(tempDir, 'no-partial.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(1)
    expect(existsSync(out)).toBe(false)
  })
})

describe('成功打包（退出码 0）', () => {
  it('写出单文件 HTML 并打印指纹/引擎版本/打包时间', async () => {
    const path = await projectFile(createExampleProject(), 'ok-project.json')
    const out = resolve(tempDir, 'ok-game.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('已打包')
    expect(r.out).toContain('指纹')
    expect(r.out).toContain('引擎版本')
    expect(r.out).toContain('打包时间')
    expect(existsSync(out)).toBe(true)
    const html = await readFile(out, 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  }, 120_000)

  it('`--out` 的值不会被当成输入项目（`cli.ts` 里显式摘掉的那条）', async () => {
    // 若 `--out` 的值没被摘掉，`game.html` 会排到 `ok-project.json` 前面成为输入项目，
    // 于是报“读取或解析项目文件失败”而不是成功。
    const path = await projectFile(createExampleProject(), 'positional-project.json')
    const out = resolve(tempDir, 'positional-game.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(0)
    expect(r.out).toContain(out)
    expect(existsSync(out)).toBe(true)
  }, 120_000)

  it('省略 `--out` 时用项目名 + `.html`，与项目文件同目录', async () => {
    const path = await projectFile(createExampleProject(), 'named-project.json')
    const r = await cli([path])
    expect(r.code).toBe(0)
    expect(r.out).toContain('已打包')
    // 默认名由 `gameFileName(project)` 决定，落在 cwd（= tempDir）。
    const produced = r.out.match(/已打包：(.+)/)?.[1]
    expect(produced).toBeTruthy()
    expect(existsSync(produced!.trim())).toBe(true)
  }, 120_000)

  it('`--sizes` 打印 raw/gzip 体积与 11.2 的预算判定', async () => {
    const path = await projectFile(createExampleProject(), 'sizes-project.json')
    const out = resolve(tempDir, 'sizes-game.html')
    const r = await cli([path, '--out', out, '--sizes'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('体积')
    expect(r.out).toContain('gzip')
    expect(r.out).toContain('预算')
  }, 120_000)

  it('不带 `--sizes` 时不打印体积行', async () => {
    const path = await projectFile(createExampleProject(), 'no-sizes-project.json')
    const out = resolve(tempDir, 'no-sizes-game.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('体积')
  }, 120_000)

  it('默认模板（7.9）也能打包', async () => {
    const path = await projectFile(createDefaultProject(), 'default-project.json')
    const out = resolve(tempDir, 'default-game.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(0)
    expect(existsSync(out)).toBe(true)
  }, 120_000)
})

describe('writeExampleProject()：17.2 的示例项目落盘', () => {
  it('写出格式化 JSON（10.2「序列化为格式化 JSON」），末尾带换行', async () => {
    const target = resolve(tempDir, 'example.json')
    const returned = await writeExampleProject(target)
    expect(returned).toBe(target)
    const text = await readFile(target, 'utf8')
    // 格式化：不是一整行 minified。
    expect(text.split('\n').length).toBeGreaterThan(50)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('内容是合法且能解析回项目文件的 `ProjectFile`', async () => {
    const target = resolve(tempDir, 'example-parseable.json')
    await writeExampleProject(target)
    const parsed = JSON.parse(await readFile(target, 'utf8')) as ProjectFile
    expect(parsed.format).toBe(PROJECT_FORMAT)
    expect(Array.isArray(parsed.resources)).toBe(true)
    expect(Array.isArray(parsed.generators)).toBe(true)
    expect(parsed.pages.length).toBeGreaterThan(0)
  })

  it('写入 `engineVersion` 与 `modifiedAt`（7.9 的保存规则）', async () => {
    const target = resolve(tempDir, 'example-meta.json')
    await writeExampleProject(target)
    const parsed = JSON.parse(await readFile(target, 'utf8')) as ProjectFile
    // 11.1 的产物元信息正是从这两项读的。
    expect(parsed.engineVersion).toBe('1.0.0')
    expect(Number.isNaN(Date.parse(parsed.meta.modifiedAt))).toBe(false)
  })

  it('示例项目本身能通过 11.1 的打包前校验', async () => {
    const target = resolve(tempDir, 'example-valid.json')
    await writeExampleProject(target)
    const r = await cli([target, '--out', resolve(tempDir, 'example-game.html')])
    expect(r.code).toBe(0)
  }, 120_000)
})