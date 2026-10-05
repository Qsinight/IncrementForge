/**
 * 影子运行时的 React 订阅（TECH_DESIGN 7.4、D-15、D-47）。
 *
 * 用途：升级编辑器的“效果数值”只读列要显示**影子运行时的当前值**（7.6 末条）。
 * 该值不是项目数据（不进项目文件、不进撤销栈、PRD 补充 6），因此它既不该进
 * `projectStore`，也不该触发历史记录——这里用**局部 hook**按 `revision` 重算。
 *
 * “无运行态时显示 0”而不是空：作者需要一个确定的对照（默认 0，PRD 升级编辑器 12），
 * 而“无运行态”只作为占位说明出现在旁边（D-47 的三项强制 UI 元素之一）。
 */
import { useMemo } from 'react'

import { Num } from '@iforge/num'

import { useProjectStore } from './project.js'
import { getShadow, resetShadow } from '../lib/shadow.js'

/** 影子运行时的只读视图。 */
export interface ShadowApi {
  /** 某升级的 `effectValues[i]`（格式化后的字符串；无则 `undefined`）。 */
  effectValuesOf(upgradeId: string): Record<number, string>
  /** 某属性的当前值（试算面板用）。 */
  readValue(path: string): string | undefined
}

let cachedRevision = -1
let cachedApi: ShadowApi | undefined

/**
 * 取影子运行时视图。
 *
 * 依赖 `projectStore.revision`：每次提交（编辑/撤销/导入）都会 +1，从而重新读取。
 * 缓存键放在模块级，避免每次渲染重建对象导致子组件无谓重渲染。
 */
export function useShadow(): ShadowApi {
  const revision = useProjectStore((state) => state.revision)
  return useMemo(() => {
    if (cachedRevision !== revision || !cachedApi) {
      const shadow = getShadow(useProjectStore.getState().project)
      cachedApi = {
        effectValuesOf(upgradeId) {
          const state = shadow.state.attrs.find(`upgrade:${upgradeId}`)
          if (!state) return {}
          const out: Record<number, string> = {}
          state.values.forEach((value, key) => {
            const match = /^effectValues\[(\d+)\]$/.exec(key)
            if (!match) return
            out[Number(match[1])] = Num.format(value, 'standard')
          })
          return out
        },
        readValue: (path) => shadow.readValue(path),
      }
      cachedRevision = revision
    }
    return cachedApi
  }, [revision])
}

/** 丢弃影子缓存（新建/导入项目后调用，7.9）。 */
export function invalidateShadow(): void {
  resetShadow()
  cachedRevision = -1
  cachedApi = undefined
}
