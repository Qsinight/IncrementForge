/**
 * 页面视图（8.11 的 `PageView`/`EntryGrid`/`PageDescription`，PRD 预览区 5/7）。
 *
 * - **页面描述**（PRD 预览区 7）单独一行，用 `page.description`；
 * - **网格列数** = `view-model` 已算好的 `columns`（`min(page.columns, 设备断点列数)`，D-41）——
 *   组件不自己读 `pageDef.columns`，否则设备模拟的口径会与 8.9 的预测分叉；
 * - **卡片顺序** = `entriesOfCurrentPage()` 的 `order`/`createdAt` 稳定排序结果（8.7「排序」）。
 *
 * ## 虚拟化的位置与口径（12 性能预算「卡片列表虚拟化（> 40 条目启用）」）
 *
 * 阈值取 **40**，且判据是**当前页的可见卡片数**而不是全项目条目数——虚拟化的目的是
 * 减少 DOM 节点，而一个把 20 个条目分散到 5 个页面的项目每个页面都很短，全局计数会
 * 让每个页面都被套上滚动容器，反而更糟。
 *
 * 为什么用“滚动容器 + 上下占位块”而不是 `IntersectionObserver`：网格的**行高是变的**
 * （资源卡片两行、升级卡片七八行），IO 需要固定行高才能算位置；用占位块则由浏览器
 * 自己排版，代价只是占位高度与实际高度有偏差——这个偏差只影响滚动条的精确度，
 * 不影响任何数值（8.11：视图不另算逻辑）。
 *
 * ## 主题：这里只管条目主题
 *
 * `--iforge-page-*` 由 `AppView` 施加到根节点（壳层与页面同色，见 `theme.ts`），
 * 本组件只解析 `--iforge-entry-*` 并内联到网格容器（PRD 页面编辑器 8）。
 *
 * ## 非虚拟化路径的滚动轴不在这里
 *
 * 未超过 `VIRTUALIZE_THRESHOLD` 时**刻意不套** `.entry-grid-scroll`（8.11、D-56），
 * 滚动轴是祖先 `.game-main`（`overflow-y: auto`，见 `game.css`）。因此
 * `.game-page` 必须是 `height: 100%` 的定高盒子并让溢出上浮，否则多出来的卡片
 * 会被裁掉且无处可滚。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { CardView, PageView as PageViewModel } from '@iforge/runtime'

import { EntryCard } from './Cards.js'
import type { CardActions } from './Cards.js'
import { entryTokenStyle, themeRefOf } from './theme.js'

export interface PageViewProps {
  page: PageViewModel
  actions: CardActions
}

/** 超过这么多张卡片才启用虚拟化（12 性能预算的「> 40 条目启用」）。 */
export const VIRTUALIZE_THRESHOLD = 40

/** 视口高度上下各多渲染一张，避免滚动到边缘时露出空白。 */
const OVERSCAN = 1

/** 单张卡片的估算高度（px）。只用于占位，不影响任何数值。 */
const ESTIMATED_ROW_HEIGHT = 168

/** 行数 -> 高度。 */
const rowHeight = (): number => ESTIMATED_ROW_HEIGHT

export function PageView({ page, actions }: PageViewProps) {
  const entries = page.entries
  const virtual = entries.length > VIRTUALIZE_THRESHOLD
  // **页面**主题（`--iforge-page-*`）由 `AppView` 施加到根节点（见 `theme.ts`）：
  // 壳层（标题栏/仪表盘/底部导航）与页面必须同色，否则改主题只换半边界面。
  // 这里只解析**条目**主题（`--iforge-entry-*`，PRD 页面编辑器 8，缺省跟随页面）。
  const pageTheme = themeRefOf(page.theme)
  const entryStyle = entryTokenStyle(pageTheme, themeRefOf(page.entryTheme))

  return (
    <section
      className="game-page"
      data-page-id={page.id}
      aria-label={page.name}
      data-virtualized={virtual ? 'true' : 'false'}
      data-theme={page.theme}
    >
      {page.description ? (
        <p className="page-description" data-testid="page-description">
          {page.description}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="muted page-empty">{page.name}</p>
      ) : virtual ? (
        <VirtualEntryGrid cards={entries} columns={page.columns} actions={actions} entryStyle={entryStyle} />
      ) : (
        <div
          className="entry-grid"
          data-testid="entry-grid"
          data-total={entries.length}
          style={{ gridTemplateColumns: `repeat(${page.columns}, minmax(0, 1fr))`, ...entryStyle }}
        >
          {entries.map((card) => (
            <EntryCard key={card.key} card={card} actions={actions} />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * 虚拟化的条目网格。
 *
 * 只渲染视口附近的行，容器本身保持可滚动；上下各放一个高度为“已跳过行数 × 行高”的
 * 占位块，把被跳过的部分**留在布局里**。这样滚动条长度仍然反映条目总数
 * （否则用户会觉得“下面还有一大半”）。
 */
function VirtualEntryGrid({
  cards,
  columns,
  actions,
  entryStyle,
}: {
  cards: CardView[]
  columns: number
  actions: CardActions
  /** 条目主题的 CSS 变量（与非虚拟化路径同一份，见 `PageView`）。 */
  entryStyle: React.CSSProperties
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [firstRow, setFirstRow] = useState(0)
  const [visibleRows, setVisibleRows] = useState(() => initialRows(cards.length, columns))
  /**
   * 卡片集合的“身份”（换页/增删条目时复位滚动）。
   *
   * 用**首尾 key + 长度**而不是数组引用：`buildViewModel` 每次重建都产出新数组，
   * 按引用比较会把“每秒的数字刷新”当成“换了内容”，滚动位置会一直被复位到顶部。
   */
  const contentKey = contentKeyOf(cards)

  // 列数变化（切设备档位）会改变总行数，需要重新夹取当前窗口。
  useLayoutEffect(() => {
    const total = totalRows(cards.length, columns)
    setVisibleRows((rows) => clampRows(rows, total))
    setFirstRow((row) => Math.max(0, Math.min(row, Math.max(0, total - 1))))
  }, [cards.length, columns])

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      const height = rowHeight()
      const scrollTop = element.scrollTop
      const viewportRows = Math.ceil(element.clientHeight / height) + OVERSCAN * 2
      const total = totalRows(cards.length, columns)
      const first = Math.max(0, Math.min(total - 1, Math.floor(scrollTop / height) - OVERSCAN))
      setFirstRow(first)
      setVisibleRows(clampRows(viewportRows, total))
    },
    [cards.length, columns],
  )

  // 内容或列数变化后重新按**当前**容器位置校准：用户在长列表中途改列数时，
  // 保留旧的首行会让画面跳到别处。
  useEffect(() => {
    setFirstRow(0)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [contentKey, columns])

  const total = totalRows(cards.length, columns)
  const last = Math.min(total, firstRow + visibleRows)
  const height = rowHeight()
  const start = firstRow * columns
  const slice = cards.slice(start, Math.min(cards.length, last * columns))

  return (
    <div className="entry-grid-scroll" data-testid="entry-grid-scroll" ref={viewportRef} onScroll={onScroll}>
      <div
        className="entry-grid"
        data-testid="entry-grid"
        data-total={cards.length}
        data-virtual-range={`${start}-${start + slice.length}`}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          paddingTop: `${firstRow * height}px`,
          paddingBottom: `${(total - last) * height}px`,
          ...entryStyle,
        }}
      >
        {slice.map((card) => (
          <EntryCard key={card.key} card={card} actions={actions} />
        ))}
      </div>
    </div>
  )
}

/** 网格总行数。 */
function totalRows(count: number, columns: number): number {
  const safeColumns = Math.max(1, columns)
  return Math.ceil(count / safeColumns)
}

/** 首屏渲染的行数（视口高度未知时给一个保守值，避免首帧空白）。 */
function initialRows(count: number, columns: number): number {
  return clampRows(6, totalRows(count, columns))
}

function clampRows(rows: number, total: number): number {
  return Math.max(1, Math.min(rows, total))
}

/** 卡片集合的内容指纹（见 `contentKey` 的注释）。 */
function contentKeyOf(cards: readonly CardView[]): string {
  return `${cards.length}:${cards[0]?.key ?? ''}:${cards[cards.length - 1]?.key ?? ''}`
}
