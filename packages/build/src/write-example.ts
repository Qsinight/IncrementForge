/**
 * 把 `17.2` 的示例项目写到磁盘（`iforge-pack` / `e2e/` 的输入，见
 * `scripts/write-example-project.mjs` 的说明）。
 *
 * ## 输出为什么是“格式化 JSON”而不是压缩 JSON
 *
 * 这是 `10.2「导出项目」` 的原话（“序列化为格式化 JSON”）。e2e 与 CI 都把它当**输入文件**读，
 * 格式化让失败时的 diff 可读——CI 里一条报错如果是一整行 minified JSON，
 * 没人能从中看出问题在哪。
 *
 * ## 为什么要过一遍 `prepareForSave`
 *
 * 7.9 规定“保存时写入 `engineVersion` 与 `modifiedAt`”，而 11.1 的产物元信息
 * （17.3 的 `meta`）正是从项目文件里读的这两项。跳过它的话，这个脚本产出的文件
 * 会比编辑器真正保存出来的“旧一档”，打包产物的元信息也就不再反映真实保存状态。
 */
import { writeFile } from 'node:fs/promises'

import { createExampleProject, ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

/**
 * 写出示例项目文件。
 *
 * @param target 目标路径
 * @returns 目标路径（便于调用方打印）
 */
export async function writeExampleProject(target: string): Promise<string> {
  const now = new Date().toISOString()
  await writeFile(target, `${JSON.stringify(prepareForSave(createExampleProject(), now), null, 2)}\n`, 'utf8')
  return target
}

/**
 * 7.9 的“保存时写入 `engineVersion` / `modifiedAt`”。
 *
 * 与 `persist` 的 `prepareForSave` 同语义，但**不 import 它**：`persist` 依赖
 * IndexedDB（3.2 的例外），把它拖进 CLI 的依赖图会让 Node 侧的打包脚本带上浏览器 API。
 * 两条字段规则太短，短到重复的成本低于违反依赖方向的成本——因此这里显式注明它们等价。
 */
function prepareForSave(project: ProjectFile, now: string): ProjectFile {
  return {
    ...project,
    engineVersion: ENGINE_VERSION,
    meta: { ...project.meta, modifiedAt: now },
  }
}
