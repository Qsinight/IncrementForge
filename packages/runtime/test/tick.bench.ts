/**
 * 性能基准（TECH_DESIGN 12、17.5）。
 *
 * ```
 * pnpm --filter @iforge/runtime run bench
 * ```
 *
 * 17.5 的交付标准是“可在无 UI 下跑通示例项目 1000 tick”，8.8 写明
 * “单次离线模拟应 < 300ms”，12 写明“单 tick 求值 ≤ 1e5 次”。
 * 这些数字用 `bench` 量，而不是靠墙钟猜测。
 */
import { bench, describe } from 'vitest'

import { Num } from '@iforge/num'
import { createExampleProject } from '@iforge/model'

import { settleOffline } from '../src/offline.js'
import { Harness, assignToPage, createDefaultProject, withGenerator } from './helpers/harness.js'

/** 只有一个资源 + 一个生成器的项目，便于聚焦价格求解与产出结算。 */
function economy(
  generator: Parameters<typeof withGenerator>[0],
  resources: { id: string; name: string; initial?: string; max?: string }[] = [{ id: 'r1', name: '矿石' }],
): Harness {
  const project = createDefaultProject()
  project.resources = resources.map((r, index) => ({
    kind: 'resource' as const,
    id: r.id,
    order: index + 1,
    name: r.name,
    description: '',
    icon: { kind: 'builtin' as const, value: 'gem' },
    initial: r.initial ?? '0',
    max: r.max ?? 'Infinity',
    visible: true,
  }))
  return new Harness({ project: assignToPage(withGenerator(generator, project), 'p1', [...resources.map((r) => r.id), generator.id]) })
}

/** 示例项目 + 1000 tick（= 50 游戏秒）：17.5 的交付基准。 */
describe('17.5 示例项目 1000 tick', () => {
  bench('示例项目 1000 tick', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1e6)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<bench>')
    h.state.buy('u1')
    h.runTicks(1000)
  })

  bench('示例项目 1 tick（求值量级参考）', () => {
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1e6)
    h.runTicks(1)
  })
})

describe('8.6 批量购买', () => {
  bench('等比价格：闭式求解（10 件/次）', () => {
    const h = economy({ id: 'g1', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }] })
    h.grant('r1', 1e9)
    h.state.batch('g1')
  })

  bench('等比价格：自动最大（`buyAmount < 0`）', () => {
    const h = economy({ id: 'g1', buyAmount: '-1', costs: [{ materialId: 'r1', amount: '10 * 1.15 ^ gen.g1.bought' }] })
    h.grant('r1', 1e9)
    h.state.batch('g1')
  })

  bench('未知价格形状：降级逐级累加（受 1e5/tick 预算约束）', () => {
    const h = economy({ id: 'g1', buyAmount: '0', costs: [{ materialId: 'r1', amount: '10 * (1 + sin(gen.g1.bought)) ^ gen.g1.bought' }] })
    h.grant('r1', 1e6)
    h.state.batch('g1')
  })
})

describe('8.8 离线模拟', () => {
  bench('8 小时离线（几何分段，PRD 补充 1 的目标 < 300ms）', () => {
    const h = economy({ id: 'g1', initial: '100', costs: [], produces: [{ materialId: 'r1', amount: '5' }] })
    settleOffline(h.state, 0, 0, 8 * 3600 * 1000)
  })
})

describe('存档往返', () => {
  bench('序列化 + 读档（示例项目）', async () => {
    const { serializeSave, restoreSave } = await import('../src/save.js')
    const h = new Harness({ project: createExampleProject() })
    h.grant('r1', 1e6)
    h.state.buy('g1')
    const save = serializeSave(h.state, { projectId: 'p1', projectName: 'bench', engineVersion: '1.0.0' })
    restoreSave(h.state, save, { project: h.state.project })
  })
})
