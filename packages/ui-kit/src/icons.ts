/**
 * 内置图标集（TECH_DESIGN 7.8「内置资源」、17.4 内置图标清单、ADR-10）。
 *
 * ## 为什么是 path 数据而不是图片
 *
 * 17.4 末条与 11.2 都要求：内置图标全部为**内联 SVG path**，不产生网络请求、
 * 打包时不占体积。因此本文件只存几何描述，`renderIcon()` 在运行时拼成
 * `<svg viewBox="0 0 24 24">`，既能进 DOM（列表行、卡片）也能进字符串
 * （导出 HTML、快照测试）。
 *
 * ## id 是稳定契约
 *
 * 17.4 表末条：内置图标 id **不得变更**（项目文件与存档里以 id 引用）。
 * `tools/docs-check.ts` 会把本文件的 id 集合与 17.4 表格逐项比对。
 *
 * 视觉规格统一为 24×24 视框、描边式图标（`fill:none; stroke:currentColor`），
 * 这样图标颜色跟随文字颜色令牌（`--iforge-text` / `--iforge-muted`），
 * 主题切换时无需为每个图标单独配色。
 */

/** 图标分组（17.4 表的六个用途 + 应用图标）。 */
export const ICON_GROUPS = ['resource', 'generator', 'clicker', 'upgrade', 'page', 'system', 'app'] as const
export type IconGroup = (typeof ICON_GROUPS)[number]

/** 一个 SVG 形状（只开放安全标签，见 `sanitize.ts` 的白名单同源）。 */
export interface IconShape {
  tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline'
  /** 属性表（`d` / `cx` / `cy` / `r` / `x` / `y` / `width` / `height` / `points`）。 */
  attrs: Readonly<Record<string, string | number>>
  /** 是否填充（默认描边；实心图标如 logo 置 true）。 */
  fill?: boolean
}

/** 图标定义。 */
export interface IconDefinition {
  id: string
  group: IconGroup
  /** 无障碍标签（编辑器按钮的 `aria-label` 走 `t()`，这里只作为图标本身的可读名）。 */
  label: string
  viewBox: string
  shapes: readonly IconShape[]
}

const p = (d: string): IconShape => ({ tag: 'path', attrs: { d } })
const circle = (cx: number, cy: number, r: number): IconShape => ({ tag: 'circle', attrs: { cx, cy, r } })
const rect = (x: number, y: number, width: number, height: number): IconShape => ({
  tag: 'rect',
  attrs: { x, y, width, height },
})
const line = (x1: number, y1: number, x2: number, y2: number): IconShape => ({
  tag: 'line',
  attrs: { x1, y1, x2, y2 },
})

/**
 * 内置图标清单（17.4 的“必备清单”，顺序与表格一致，便于逐项比对）。
 *
 * 增补图标必须遵守同名规则（id 不变更、新增需同步文档）。
 */
export const ICONS: readonly IconDefinition[] = [
  // ---- 资源图标 ----
  {
    id: 'gem',
    group: 'resource',
    label: '宝石',
    viewBox: '0 0 24 24',
    shapes: [p('M12 3 4 9l8 12 8-12-8-6Z'), p('M4 9h16'), p('M12 3 9 9l3 6 3-6-3-6')],
  },
  { id: 'coin', group: 'resource', label: '金币', viewBox: '0 0 24 24', shapes: [circle(12, 12, 8), p('M12 8v8'), p('M9.5 10h5'), p('M9.5 14h5')] },
  { id: 'crystal', group: 'resource', label: '水晶', viewBox: '0 0 24 24', shapes: [p('M7 3h10l3 6-8 12L4 9l3-6Z'), p('M4 9h16'), p('M12 3v18')] },
  { id: 'energy', group: 'resource', label: '能量', viewBox: '0 0 24 24', shapes: [p('M13 2 4 14h6l-1 8 9-12h-6l1-8Z')] },
  { id: 'ingot', group: 'resource', label: '金属锭', viewBox: '0 0 24 24', shapes: [p('M3 16 7 9h10l4 7v3H3v-3Z'), p('M7 13h10')] },

  // ---- 生成器图标 ----
  {
    id: 'factory',
    group: 'generator',
    label: '工厂',
    viewBox: '0 0 24 24',
    shapes: [p('M3 21V10l6 4V10l6 4V7h6v14H3Z'), p('M6.5 21v-3H9v3'), p('M11 21v-3h2.5v3'), p('M16 21v-3h2.5v3')],
  },
  {
    id: 'drill',
    group: 'generator',
    label: '钻机',
    viewBox: '0 0 24 24',
    shapes: [p('M3 21l6-6'), p('M10 14 8 6.5l6-3.5 4 4L14.5 13l-4.5 1Z'), p('M13 6l4 4')],
  },
  {
    id: 'mine',
    group: 'generator',
    label: '矿井',
    viewBox: '0 0 24 24',
    shapes: [p('M4 20 13 11'), p('M5 8c3.5-3 9-2 14 3'), p('M19 8c-3.5-3-9-2-14 3')],
  },
  {
    id: 'lab',
    group: 'generator',
    label: '实验室',
    viewBox: '0 0 24 24',
    shapes: [p('M9 3h6'), p('M10 3v6L5 19a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 19l-5-10V3'), p('M7 16h10')],
  },
  {
    id: 'reactor',
    group: 'generator',
    label: '反应堆',
    viewBox: '0 0 24 24',
    shapes: [circle(12, 12, 7), circle(12, 12, 2.6), p('M12 5V2.6'), p('M18.5 14.2l2.2 1.3'), p('M5.5 14.2l-2.2 1.3')],
  },

  // ---- 点击器图标 ----
  {
    id: 'hand',
    group: 'clicker',
    label: '手',
    viewBox: '0 0 24 24',
    shapes: [
      p(
        'M8 11V5.6a1.5 1.5 0 0 1 3 0V11m0-1V4.6a1.5 1.5 0 0 1 3 0V11m0-.6V6.6a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-3.6a1.5 1.5 0 0 1 3 0V13',
      ),
    ],
  },
  { id: 'hammer', group: 'clicker', label: '锤子', viewBox: '0 0 24 24', shapes: [p('M14 3l7 7-3 3-7-7 3-3Z'), p('M11 10 3 18l3 3 8-8')] },
  { id: 'pick', group: 'clicker', label: '镐', viewBox: '0 0 24 24', shapes: [p('M4 20 14 10'), p('M5 8c5-2 9 1 11 6'), p('M20 11c-2-5-6-9-11-6')] },
  { id: 'click', group: 'clicker', label: '点击', viewBox: '0 0 24 24', shapes: [p('M5 3l7 17 2-7 7-2L5 3Z')] },

  // ---- 升级图标 ----
  {
    id: 'star',
    group: 'upgrade',
    label: '星标',
    viewBox: '0 0 24 24',
    shapes: [p('M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z')],
  },
  { id: 'arrow-up', group: 'upgrade', label: '上升', viewBox: '0 0 24 24', shapes: [p('M12 20V5'), p('M6 11l6-6 6 6')] },
  { id: 'bolt', group: 'upgrade', label: '电力', viewBox: '0 0 24 24', shapes: [p('M13 3 5 14h5l-1 7 8-11h-5l1-7Z')] },
  { id: 'shield', group: 'upgrade', label: '护盾', viewBox: '0 0 24 24', shapes: [p('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z')] },

  // ---- 页面图标 ----
  {
    id: 'grid',
    group: 'page',
    label: '网格',
    viewBox: '0 0 24 24',
    shapes: [rect(4, 4, 6, 6), rect(14, 4, 6, 6), rect(4, 14, 6, 6), rect(14, 14, 6, 6)],
  },
  { id: 'map', group: 'page', label: '地图', viewBox: '0 0 24 24', shapes: [p('M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z'), p('M9 4v14'), p('M15 6v14')] },
  {
    id: 'book',
    group: 'page',
    label: '书',
    viewBox: '0 0 24 24',
    shapes: [p('M4 5a2 2 0 0 1 2-2h6v18H6a2 2 0 0 1-2-2V5Z'), p('M20 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2V5Z')],
  },
  {
    id: 'gear',
    group: 'page',
    label: '设置',
    viewBox: '0 0 24 24',
    shapes: [
      circle(12, 12, 3),
      p(
        'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.9H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.6 7.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
      ),
    ],
  },

  // ---- 系统图标（顶部标题栏、列表按钮与模拟设置栏）----
  { id: 'plus', group: 'system', label: '添加', viewBox: '0 0 24 24', shapes: [line(12, 5, 12, 19), line(5, 12, 19, 12)] },
  { id: 'copy', group: 'system', label: '复制', viewBox: '0 0 24 24', shapes: [rect(9, 9, 11, 11), p('M5 15H4V4h11v1')] },
  {
    id: 'trash',
    group: 'system',
    label: '删除',
    viewBox: '0 0 24 24',
    shapes: [p('M3 6h18'), p('M8 6V4h8v2'), p('M19 6l-1 14H6L5 6'), p('M10 11v6'), p('M14 11v6')],
  },
  { id: 'sort-up', group: 'system', label: '上移', viewBox: '0 0 24 24', shapes: [p('M12 19V5'), p('M6 11l6-6 6 6')] },
  { id: 'sort-down', group: 'system', label: '下移', viewBox: '0 0 24 24', shapes: [p('M12 5v14'), p('M6 13l6 6 6-6')] },
  { id: 'undo', group: 'system', label: '撤销', viewBox: '0 0 24 24', shapes: [p('M9 14 4 9l5-5'), p('M4 9h11a5 5 0 0 1 0 10h-3')] },
  { id: 'redo', group: 'system', label: '重做', viewBox: '0 0 24 24', shapes: [p('M15 14l5-5-5-5'), p('M20 9H9a5 5 0 0 0 0 10h3')] },
  { id: 'save', group: 'system', label: '保存', viewBox: '0 0 24 24', shapes: [p('M5 3h11l3 3v15H5V3Z'), p('M8 3v6h7V3'), rect(8, 14, 8, 7)] },
  { id: 'import', group: 'system', label: '导入', viewBox: '0 0 24 24', shapes: [p('M12 3v12'), p('M8 11l4 4 4-4'), line(4, 19, 20, 19)] },
  { id: 'export', group: 'system', label: '导出', viewBox: '0 0 24 24', shapes: [p('M12 15V3'), p('M8 7l4-4 4 4'), line(4, 19, 20, 19)] },
  {
    id: 'package',
    group: 'system',
    label: '打包',
    viewBox: '0 0 24 24',
    shapes: [p('M21 8 12 3 3 8v8l9 5 9-5V8Z'), p('M3 8l9 5 9-5'), p('M12 13v8')],
  },
  { id: 'menu', group: 'system', label: '菜单', viewBox: '0 0 24 24', shapes: [line(4, 7, 20, 7), line(4, 12, 20, 12), line(4, 17, 20, 17)] },
  { id: 'play', group: 'system', label: '播放', viewBox: '0 0 24 24', shapes: [p('M7 4l12 8-12 8V4Z')] },
  { id: 'pause', group: 'system', label: '暂停', viewBox: '0 0 24 24', shapes: [line(8, 5, 8, 19), line(16, 5, 16, 19)] },
  { id: 'restart', group: 'system', label: '重新开始', viewBox: '0 0 24 24', shapes: [p('M20 12a8 8 0 1 1-2.3-5.7'), p('M20 4v5h-5')] },

  // ---- 应用图标（顶部标题栏左侧）----
  {
    id: 'iforge-logo',
    group: 'app',
    label: 'IncrementForge',
    viewBox: '0 0 24 24',
    shapes: [
      { tag: 'path', attrs: { d: 'M3 20h18' } },
      { tag: 'path', attrs: { d: 'M7 20l1-6h8l1 6' } },
      { tag: 'path', attrs: { d: 'M6 14h12l-1.2-3.5H7.2L6 14Z' } },
      { tag: 'path', attrs: { d: 'M12 10.5V5' } },
      { tag: 'path', attrs: { d: 'M9 5h6' } },
    ],
  },
]

/** `id -> 定义` 索引。 */
export const ICON_MAP: ReadonlyMap<string, IconDefinition> = new Map(ICONS.map((icon) => [icon.id, icon]))

/** 内置图标 id 清单（17.4 必备清单的可执行副本，`docs:check` 会与文档表格比对）。 */
export const BUILTIN_ICON_IDS: readonly string[] = ICONS.map((icon) => icon.id)

/** 按分组取图标（`IconPicker` 的分组数据源）。 */
export function iconsOfGroup(group: IconGroup): IconDefinition[] {
  return ICONS.filter((icon) => icon.group === group)
}

/** 未知内置 id 的兜底图标（导入的项目文件可能引用旧版本/外部分组图标）。 */
export const FALLBACK_ICON_ID = 'star'

/** 按 id 取定义；未知 id 回退 `FALLBACK_ICON_ID`（界面不因脏数据崩溃）。 */
export function iconOf(id: string): IconDefinition {
  return ICON_MAP.get(id) ?? ICON_MAP.get(FALLBACK_ICON_ID)!
}
