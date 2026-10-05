/**
 * 项目指纹（TECH_DESIGN 11.1 末条：写入 `engineVersion`、打包时间、项目指纹）。
 *
 * ## 指纹用来做什么
 *
 * 17.3 的产物结构里有 `"fingerprint":"..."`，11.1 说它“用于**存档兼容判断**”。落地成三件事：
 *
 * 1. **存档键**：打包态没有 IndexedDB 的 `projectId`（`local-sink.ts` 用指纹派生 `pkg-<前 12 位>`），
 *    保证“同一份产物两次打开读到同一份存档”“两份不同产物不互相覆盖进度”；
 * 2. **可观测性**：玩家把产物发给别人时，双方一眼能看出是不是同一份构建；
 * 3. **回归测试**：E2E 断言“改了项目名/条目后指纹变化”，等于给打包管线加了一个
 *    “内容变了必须产出新产物”的门禁。
 *
 * ## 为什么是 FNV-1a 而不是 SHA
 *
 * 产物要**离线单文件**运行，而指纹在这里只需要“内容变了就变”的**弱**等价性——
 * 真正的完整性校验由浏览器/文件系统负责。用 Node 的 `crypto` 会让 `build` 变成
 * “浏览器可跑”的包做不到的事（编辑器要在**浏览器里**打包，见 `packageGame` 的说明）。
 *
 * FNV-1a 32 位对“不同内容不同指纹”的要求足够，且实现只有 6 行、跨环境结果一致。
 * 注意它是**非密码学**哈希：能被人为构造碰撞，因此绝不能用它做安全判断。
 */
import type { ProjectFile } from '@iforge/model'

/** 32 位 FNV-1a 偏移基。 */
const FNV_OFFSET = 0x811c9dc5

/** 32 位 FNV-1a 素数（2^24 + 2^8 + 0x93）。 */
const FNV_PRIME = 0x01000193

/** 对一段 UTF-8 文本求 32 位 FNV-1a，返回 8 位十六进制。 */
export function fingerprintText(text: string): string {
  let hash = FNV_OFFSET
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    hash ^= byte
    // `Math.imul` 是 32 位乘法：`hash * PRIME` 在 JS 里会先变成 53 位浮点再取低 32 位，
    // 结果与整数乘法**不一致**（丢高位）。`hash | 0` 也不能替代 `Math.imul`。
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 项目文件的**规范化**指纹。
 *
 * ## 为什么先规范化再算
 *
 * 直接对 `JSON.stringify(project)` 求哈希会把 `meta.modifiedAt` 也算进去，于是
 * “只点了一次保存”的两次构建指纹不同——11.1 的本意是“项目内容变了才换指纹”。
 * 被排除的字段只有两个：
 *
 * | 字段 | 理由 |
 * | --- | --- |
 * | `meta.modifiedAt` | 纯时间戳，与游戏内容无关（PRD 设置页 5） |
 * | `meta.createdAt` | 同上；跨机器导入导出时它必然不同 |
 *
 * `engineVersion` **保留**：引擎升级会改变运行时语义，即使项目文本没变，存档兼容性也可能变。
 *
 * 键的顺序按固定顺序（`Object.keys` 的插入序 → 显式列出）输出，避免
 * “同一份项目在不同机器上因为 JSON 键序不同而得到不同指纹”。
 */
export function projectFingerprint(project: ProjectFile): string {
  const canonical = {
    format: project.format,
    version: project.version,
    engineVersion: project.engineVersion,
    meta: {
      name: project.meta.name,
      author: project.meta.author,
      description: project.meta.description,
    },
    settings: {
      numberFormat: project.settings.numberFormat,
      tickRate: project.settings.tickRate,
      maxFrameStep: project.settings.maxFrameStep,
      autosaveInterval: project.settings.autosaveInterval,
      offlineEnabled: project.settings.offlineEnabled,
      offlineCap: project.settings.offlineCap,
    },
    resources: project.resources,
    generators: project.generators,
    upgrades: project.upgrades,
    pages: project.pages,
    assets: project.assets ?? {},
  }
  return fingerprintText(JSON.stringify(canonical))
}

/** 产物文件名（`名称.html`，非法文件名字符替换为 `_`）。 */
export function gameFileName(project: ProjectFile): string {
  const safe = project.meta.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'game'
  return `${safe}.html`
}
