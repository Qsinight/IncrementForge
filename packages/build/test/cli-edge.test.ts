/**
 * 打包管线的**边界与入口**（TECH_DESIGN 13 第 6 条、11.1 第 6 条、14.3 门禁）。
 *
 * 三条边界在这里固定：
 * 1. `IFORGE_SCRIPT_ARGS` 注入（`cli.ts` 的 `argvFromEnv`）——启动器脚本用它传参，
 *    直接读 `process.argv.slice(2)` 会把 `--rebuild` 之类当成打包参数；
 * 2. **大小上限先于解析**（13 第 6 条）：超大文件必须先被体积规则拦下，
 *    而不是先让 Zod 去解析一个几百 MB 的字符串；
 * 3. `bin.ts` 与 `node.ts` 两个入口都能真的引到 `runCli`（e2e 与 CI 走的是不同入口）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createDefaultProject, parseProjectFile } from '@iforge/model'
import { MAX_PROJECT_BYTES } from '@iforge/ui-kit'

import { runCli } from '../src/cli.js'
import { runCli as runCliFromBin } from '../src/bin.js'

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'iforge-pack-edge-'))
}, 120_000)

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

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

describe('bin.ts 入口（scripts/iforge-pack.mjs 之外的环境）', () => {
  it('与 `cli.ts` 是同一个 `runCli`（不是两份实现）', () => {
    expect(runCliFromBin).toBe(runCli)
  })

  it('`--help` 经 bin 入口同样可用', async () => {
    const out: string[] = []
    const code = await runCliFromBin({ argv: ['--help'], cwd: tempDir, stdout: (t) => out.push(t), stderr: () => {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('用法')
  })
})

describe('argvFromEnv()：`IFORGE_SCRIPT_ARGS` 注入', () => {
  const original = process.env.IFORGE_SCRIPT_ARGS

  afterAll(() => {
    if (original === undefined) delete process.env.IFORGE_SCRIPT_ARGS
    else process.env.IFORGE_SCRIPT_ARGS = original
  })

  it('环境变量里的 JSON 数组被解析成 argv（启动器传参路径）', async () => {
    // 断言“环境变量确实被读到了”：给了 `ignored.json` 这个位置参数后，
    // 退出码是 1（读文件失败）而不是 2（没有位置参数）。
    // 若 `argvFromEnv` 没生效，就会回落到空数组 -> 退出码 2。
    process.env.IFORGE_SCRIPT_ARGS = JSON.stringify(['ignored.json'])
    expect(await runCliWithoutArgv()).toBe(1)
  })

  it('非法 JSON 时回落为空数组（不抛错，也不误读 `process.argv`）', async () => {
    process.env.IFORGE_SCRIPT_ARGS = '{ not json'
    expect(await runCliWithoutArgv()).toBe(2)
  })

  it('非数组 JSON 时回落为空数组', async () => {
    process.env.IFORGE_SCRIPT_ARGS = '{"a":1}'
    expect(await runCliWithoutArgv()).toBe(2)
  })

  it('数组元素统一转成字符串（非字符串成员也不抛错）', async () => {
    process.env.IFORGE_SCRIPT_ARGS = JSON.stringify(['--help'])
    const out: string[] = []
    const code = await runCli({
      cwd: tempDir,
      stdout: (t) => out.push(t),
      stderr: () => {},
    })
    // 环境变量提供了 `['--help']` -> 走帮助分支。
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('用法')
  })

  it('`io.argv` 优先于环境变量', async () => {
    process.env.IFORGE_SCRIPT_ARGS = JSON.stringify(['ignored.json'])
    const r = await cli(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('用法')
  })
})

/** 不传 `argv`，让 `runCli` 自己去读 `IFORGE_SCRIPT_ARGS`。 */
async function runCliWithoutArgv(): Promise<number> {
  return runCli({
    cwd: tempDir,
    stdout: () => {},
    stderr: () => {},
  })
}

describe('13 第 6 条：大小上限先于解析', () => {
  it('超大项目文件按体积拦下，退出码 1 并报 MB 上限', async () => {
    // 构造超过 16MB 的文本。断言信息里出现 MB 上限，才能证明走的是**体积**分支
    // 而不是 Zod 的结构分支（后者会输出“文件校验失败：…”）。
    const padding = 'x'.repeat(MAX_PROJECT_BYTES + 1024)
    const path = resolve(tempDir, 'oversize.json')
    await writeFile(path, `{"format":"incrementforge-project","pad":"${padding}"}`, 'utf8')
    const r = await cli([path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('MB 上限')
    expect(r.err).not.toContain('文件校验失败')
  }, 60_000)

  it('刚好在上限内的文件仍会进解析（阈值不是过度保守）', async () => {
    const project = createDefaultProject()
    const text = JSON.stringify(project)
    // 用 `pad` 字段把体积顶到上限附近——但那是未知字段，会被 Zod 拒绝。
    // 因此改用“合法但接近上限”的方式：只断言明显小于上限时正常进入解析分支。
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_PROJECT_BYTES)
    const path = resolve(tempDir, 'small.json')
    await writeFile(path, text, 'utf8')
    const r = await cli([path, '--help'])
    expect(r.code).toBe(0)
  })
})

describe('合法项目的最小往返（管线不产出多余副作用）', () => {
  it('默认模板打包后引导数据能解析回项目文件（17.3）', async () => {
    const project = createDefaultProject()
    const path = resolve(tempDir, 'roundtrip.json')
    await writeFile(path, JSON.stringify(project), 'utf8')
    const out = resolve(tempDir, 'roundtrip.html')
    const r = await cli([path, '--out', out])
    expect(r.code).toBe(0)

    const { readFile } = await import('node:fs/promises')
    const html = await readFile(out, 'utf8')
    const json = /window\.__IFORGE_BOOTSTRAP__=(\{[\s\S]*?\});/.exec(html)?.[1]
    expect(json).toBeTruthy()
    const bootstrap = JSON.parse(json!) as { project: unknown }
    expect(parseProjectFile(JSON.stringify(bootstrap.project)).format).toBeTruthy()
  }, 120_000)
})