# IncrementForge 技术设计文档
- **文档版本**：V1.0
- **对应需求**：[产品需求文档](./PRD.md) V1.0
- **文档状态**：已定稿，与 PRD V1.0 一一对应；PRD 中未明确的事项统一记入 [16. 风险与措施](#16-风险与措施)
- **结构约定**：新增/修改设计时同步维护 [6.5 PRD 字段映射总表](#65-prd-字段映射总表)、[14.2 关键用例清单](#142-关键用例清单抽样) 与 [17.6 需求追溯矩阵](#176-需求追溯矩阵prd--tech-章节--实现包--测试)
- **内容归属原则**：每条设计只在一处完整展开，其余位置用交叉引用指向它——PRD 字段映射在 [6.5](#65-prd-字段映射总表)、表达式权限在 [5.9](#59-属性读写矩阵)、PRD 未明确事项的**决策**在 [16.1](#161-决策记录prd-未明确事项)、实现期**风险**在 [16.2](#162-风险清单)；正文不重复展开 16.1/16.2 的内容，反之 16.1/16.2 只写决策与落点、不重述正文

## 目录
> 阅读顺序建议：先看 [2 架构总览](#2-架构总览) 建立全局观，再按“数值 → 表达式 → 数据模型 → 编辑器 → 运行时 → 预览 → 持久化 → 打包”推进；评审 PRD 覆盖度时直接查 [17.6 需求追溯矩阵](#176-需求追溯矩阵prd--tech-章节--实现包--测试)。

- [1. 文档说明](#1-文档说明)
  - [1.1 目标](#11-目标)
  - [1.2 范围](#12-范围)
  - [1.3 读者](#13-读者)
  - [1.4 术语表](#14-术语表)
  - [1.5 文档约定与阅读指引](#15-文档约定与阅读指引)
- [2. 架构总览](#2-架构总览)
  - [2.1 技术栈选型](#21-技术栈选型)
  - [2.2 分层架构](#22-分层架构)
  - [2.3 核心设计决策（ADR 摘要）](#23-核心设计决策adr-摘要)
- [3. 工程结构](#3-工程结构)
  - [3.1 目录树](#31-目录树)
  - [3.2 包依赖规则](#32-包依赖规则)
- [4. 数值系统设计](#4-数值系统设计)
  - [4.1 需求映射](#41-需求映射)
  - [4.2 分层表示](#42-分层表示)
  - [4.3 Num 数值层 API](#43-num-数值层-api)
  - [4.4 溢出/下溢策略（饱和语义）](#44-溢出下溢策略饱和语义)
  - [4.5 显示格式](#45-显示格式)
- [5. 表达式沙箱](#5-表达式沙箱)
  - [5.1 语言定位](#51-语言定位)
  - [5.2 语法](#52-语法)
  - [5.3 内置变量](#53-内置变量)
  - [5.4 内置函数](#54-内置函数)
  - [5.5 上下文（Context）与权限](#55-上下文context与权限)
  - [5.6 编译与执行](#56-编译与执行)
  - [5.7 求值调度与性能](#57-求值调度与性能)
  - [5.8 表达式编辑器交互](#58-表达式编辑器交互)
  - [5.9 属性读写矩阵](#59-属性读写矩阵)
    - [5.9.1 条目属性](#591-条目属性)
    - [5.9.2 页面属性](#592-页面属性)
    - [5.9.3 读写实现约定](#593-读写实现约定)
- [6. 数据模型与文件格式](#6-数据模型与文件格式)
  - [6.1 公共字段](#61-公共字段)
  - [6.2 项目文件 Schema（`*.json`）](#62-项目文件-schemajson)
  - [6.3 存档文件 Schema（`*.save.json`）](#63-存档文件-schemasavejson)
  - [6.4 校验与迁移](#64-校验与迁移)
  - [6.5 PRD 字段映射总表](#65-prd-字段映射总表)
    - [6.5.1 资源（PRD 资源编辑器 1–6）](#651-资源prd-资源编辑器-16)
    - [6.5.2 生成器（PRD 生成器编辑器 1–11）](#652-生成器prd-生成器编辑器-111)
    - [6.5.3 升级（PRD 升级编辑器 1–12）](#653-升级prd-升级编辑器-112)
    - [6.5.4 页面（PRD 页面编辑器 1–8）](#654-页面prd-页面编辑器-18)
    - [6.5.5 设置页面（PRD 设置页面 1–6）](#655-设置页面prd-设置页面-16)
- [7. 编辑器架构与界面交互](#7-编辑器架构与界面交互)
  - [7.1 界面总体布局（PRD 工作页面一览）](#71-界面总体布局prd-工作页面一览)
  - [7.2 状态管理](#72-状态管理)
  - [7.3 撤销/重做](#73-撤销重做)
  - [7.4 同步到预览](#74-同步到预览)
  - [7.5 条目列表交互规格](#75-条目列表交互规格)
  - [7.6 工作区实现要点](#76-工作区实现要点)
  - [7.7 设置页面实现要点](#77-设置页面实现要点)
  - [7.8 主题、图标与国际化](#78-主题图标与国际化)
  - [7.9 项目生命周期（新建、保存、导入、导出）](#79-项目生命周期新建保存导入导出)
- [8. 运行时与游戏循环](#8-运行时与游戏循环)
  - [8.1 核心状态](#81-核心状态)
  - [8.2 主循环（请求动画帧驱动）](#82-主循环请求动画帧驱动)
  - [8.3 单 tick 顺序（固定时序，可预测）](#83-单-tick-顺序固定时序可预测)
    - [8.3.1 交互事件与 tick 边界](#831-交互事件与-tick-边界)
  - [8.4 可见性与禁用的有效状态（页面继承）](#84-可见性与禁用的有效状态页面继承)
  - [8.5 购买结算](#85-购买结算)
  - [8.6 批量 / 最大 / 自动最大购买求解](#86-批量--最大--自动最大购买求解)
    - [8.6.1 只读等级视图：价格与条件按第 j 级求值](#861-只读等级视图价格与条件按第-j-级求值)
    - [8.6.2 升级购买条件的前缀语义 solveByConditionPrefix](#862-升级购买条件的前缀语义-solvebyconditionprefix)
  - [8.7 升级效果与动态条目](#87-升级效果与动态条目)
  - [8.8 离线模拟](#88-离线模拟)
  - [8.9 仪表盘数据](#89-仪表盘数据)
  - [8.10 游戏内设置页与存档操作（PRD 预览区 9）](#810-游戏内设置页与存档操作prd-预览区-9)
  - [8.11 游戏视图与卡片字段映射（PRD 预览区 1–8）](#811-游戏视图与卡片字段映射prd-预览区-18)
  - [8.12 页面导航与当前页面（PRD 预览区 8）](#812-页面导航与当前页面prd-预览区-8)
- [9. 预览与宿主通信](#9-预览与宿主通信)
  - [9.1 沙箱模型](#91-沙箱模型)
  - [9.2 消息协议](#92-消息协议)
  - [9.3 生命周期](#93-生命周期)
- [10. 存档与持久化](#10-存档与持久化)
  - [10.1 IndexedDB 结构](#101-indexeddb-结构)
  - [10.2 导入 / 导出](#102-导入--导出)
  - [10.3 存档时机](#103-存档时机)
- [11. 游戏打包](#11-游戏打包)
  - [11.1 构建管线](#111-构建管线)
  - [11.2 体积与优化](#112-体积与优化)
- [12. 性能预算与优化](#12-性能预算与优化)
- [13. 安全与沙箱](#13-安全与沙箱)
- [14. 测试与质量保障](#14-测试与质量保障)
  - [14.1 测试分层](#141-测试分层)
  - [14.2 关键用例清单（抽样）](#142-关键用例清单抽样)
  - [14.3 质量门禁](#143-质量门禁)
- [15. 扩展框架预留](#15-扩展框架预留)
- [16. 风险与措施](#16-风险与措施)
  - [16.1 决策记录（PRD 未明确事项）](#161-决策记录prd-未明确事项)
  - [16.2 风险清单](#162-风险清单)
- [17. 附录](#17-附录)
  - [17.1 错误码表](#171-错误码表)
  - [17.2 示例项目（节选）](#172-示例项目节选)
  - [17.3 打包产物结构](#173-打包产物结构)
  - [17.4 内置图标与主题清单](#174-内置图标与主题清单)
  - [17.5 实施里程碑（建议）](#175-实施里程碑建议)
  - [17.6 需求追溯矩阵（PRD → TECH 章节 → 实现包 → 测试）](#176-需求追溯矩阵prd--tech-章节--实现包--测试)

## 1. 文档说明
### 1.1 目标
本文档把 PRD V1.0 的产品需求翻译为可实现、可测试、可演进的技术方案，明确：模块划分与边界、数据结构、核心算法（数值、表达式、购买、离线）、运行时时序、文件格式、通信协议、性能与安全约束，以及 PRD 未明确事项的自主决策。

### 1.2 范围
- **包含**：Web 编辑器（React）、表达式沙箱、增量游戏运行时、预览沙箱、项目/存档持久化、单文件 HTML 打包。
- **不包含**：服务端、后端账号体系、联网排行榜、支付、原生/移动端打包、多语言实际文案（仅预留框架）、多项目管理实际实现（仅预留框架）。
- **单存档、单项目、单语言**：V1.0 只落地一套实现，全部通过接口抽象预留扩展位（见 [15. 扩展框架预留](#15-扩展框架预留)）。

### 1.3 读者
前端开发、运行时开发、测试、后续维护者。

### 1.4 术语表
| 术语 | 含义 |
| --- | --- |
| 条目 | 资源 / 生成器 / 升级三者的统称，拥有 `id`、`order`、图标、名称、描述等公共属性 |
| 已购买数量 `bought` | 由“购买”行为累加的数量，下限为零，参与价格成长计算 |
| 拥有数量 `owned` | 已购买数量 + 其它条目产出的数量，下限为零，受数量上限约束 |
| 初始数量 `initial` | 新开局时的值（生成器/升级计入已购买数量） |
| 数量上限 `max` | 硬上限，必定大于零，超出部分丢弃 |
| 数值属性 | 可被表达式读写、存档持久化的字段（`amount/max/visible/disabled/buyAmount/bought/owned/perSecond` 等） |
| 上下文 Context | 表达式求值环境，决定可见变量、可用函数与副作用权限（价格、产出、条件、效果、离线） |
| last-good | 表达式求值失败时沿用的上一次成功值 |
| tick | 逻辑帧，运行时最小时间单位，默认 20 tick/s |
| 动态条目 | 运行时由表达式创建、不进入项目文件、仅存于游戏存档的生成器/升级 |
| 引擎版本 | 编辑器自身的语义化版本号 |
| `NumExpr` | 字符串型数值字段：内容是纯数字字面量（支持 `1e1e10` 分层指数）或表达式源码，运行时按所属上下文求值 |
| 常量/条件/赋值表达式 | PRD 定义的三类表达式：`initial`/`max`/`buyAmount` 等字段值为常量表达式（默认 `true` 之外）、升级购买条件与效果前提为条件表达式、升级效果内容为赋值表达式（[5.1](#51-语言定位)） |
| 项目默认设置 | 项目文件 `settings`（游戏默认设置），只在编辑器设置页修改，随“保存”落盘（D-22） |
| 会话覆盖 | 运行时对游戏内设置的临时覆盖（预览态存内存、打包态存 `localStorage`），不回写项目文件（D-22） |
| `forceUnlock` | “解锁全部”一次性动作给属性打的标记，被表达式覆盖后清除（D-16） |
| 饱和（saturate） | 运算结果超出 [4.4](#44-溢出下溢策略饱和语义) 上下界时钳到边界值并打标记，不抛异常 |
| 前缀语义 | 升级批量购买“连续购买直到不满足条件/价格”的求解语义：`count`/`max` 逐级校验（第 `j` 次购买发生在等级 `bought + j` 上），`free` 只校验末级（[8.6](#86-批量--最大--自动最大购买求解)） |

### 1.5 文档约定与阅读指引
- **章节编号**：`N.M.K` 三级。调整既有小节号时必须同步更新全文档锚点引用；新增需求先改本文档，再改代码与用例。
- **PRD 引用**：正文中的“PRD 资源编辑器 4”“补充 7”等写法指向 [PRD.md](./PRD.md) 的对应条目，检索关键字是该小节的首句标题；PRD 未规定的实现细节一律以 [16.1](#161-决策记录prd-未明确事项) 的 `D-xx` 记录理由。
- **编号体系**：`ADR-xx` 架构决策（[2.3](#23-核心设计决策adr-摘要)）、`D-xx` PRD 未明确事项的自主决策（[16.1](#161-决策记录prd-未明确事项)）、`R-xx` 技术风险（[16.2](#162-风险清单)）、`E_*` 错误码（[17.1](#171-错误码表)）。
- **唯一事实源分层**：PRD 定义“做什么” → 本文档定义“怎么做” → 代码实现；本文档与 PRD 冲突时以 PRD 为准，并在 [16.1 决策记录](#161-决策记录prd-未明确事项) 与 [16.2 风险清单](#162-风险清单) 记录差异与处理。
- **覆盖度自查**：任何新增/修改设计都要在 [17.6 需求追溯矩阵](#176-需求追溯矩阵prd--tech-章节--实现包--测试) 补一行“PRD 需求 → TECH 章节 → 实现包 → 测试落点”，并在 [14.2](#142-关键用例清单抽样) 补至少一条可执行用例。
- **PRD 未明确事项的处理**：不外推、不猜测，一律在 [16.1](#161-决策记录prd-未明确事项) 记一条 `D-xx`（议题 + 决策 + 落点），正文相应位置引用编号；不把自主决策伪装成 PRD 要求。
- **字段新增的联动清单**：新增/修改任何条目或页面字段时，必须同步四处——[6.1/6.2 Schema](#62-项目文件-schemajson)、[6.3 存档 Schema](#63-存档文件-schemasavejson)、[5.9 权限矩阵](#59-属性读写矩阵)、[6.5 字段映射总表](#65-prd-字段映射总表)；新增错误码还要同步 [17.1](#171-错误码表)，新增语义还要在 [14.2](#142-关键用例清单抽样) 补用例、在 [17.6](#176-需求追溯矩阵prd--tech-章节--实现包--测试) 补对应 PRD 行。`docs:check`（[14.3](#143-质量门禁)）会在 CI 中自动比对，漏改即失败。

## 2. 架构总览
### 2.1 技术栈选型
1. **前端框架**：React 19 + TypeScript + Vite
2. **代码工程结构**：pnpm monorepo + 核心包复用
3. **状态管理**：Zustand + immer
4. **主题样式**：CSS 变量主题令牌
5. **大数运算**：break_eternity.js
6. **表达式沙箱**：自研 Pratt 解析器 + 闭包树编译器 + 受限沙箱
7. **项目保存**：IndexedDB
8. **数据校验**：Zod + JSON Schema
9. **运行时预览**：iframe + postMessage
10. **游戏打包**：Vite + vite-plugin-singlefile，内联 JSON/图标/CSS
11. **测试框架**：Vitest + 快照 + Playwright

### 2.2 分层架构
```
┌──────────────────────────────────────────────────────────────┐
│ Editor Shell (React 19 + Zustand/immer)                     │
│  顶部标题栏 │ 左侧功能区 │ 中间工作区 │ 右侧预览区(容器)        │
│  列表/编辑器表单/设置页/撤销重做/导入导出/打包触发             │
└───────────────┬──────────────────────────┬───────────────────┘
                │ 共享核心包(纯逻辑,无 DOM) │ postMessage 协议
                ▼                          ▼
┌──────────────────────────────┐  ┌───────────────────────────────┐
│ @iforge/num      数值层      │  │ iframe 预览沙箱 (sandbox=allow-│
│ @iforge/expr     表达式沙箱   │  │ scripts, 不含 same-origin)    │
│ @iforge/model    数据模型     │  │ ┌───────────────────────────┐ │
│ @iforge/runtime  游戏循环     │─▶│ │ @iforge/runtime 内核      │ │
│  (编辑态复用同一份逻辑)       │  │ │ tick/产出/购买/升级/离线   │ │
└──────────────────────────────┘  │ └───────────────────────────┘ │
                │                   └───────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│ @iforge/persist (IndexedDB)   │ @iforge/build (vite 单文件打包)│
│ projects / assets / saves     │ runtime + project JSON + CSS   │
└──────────────────────────────────────────────────────────────┘
```
关键约束：**编辑器与运行时共用 `@iforge/num`、`@iforge/expr`、`@iforge/model`、`@iforge/runtime`**。编辑器内嵌一个“影子运行时”（Shadow Runtime）用于属性即时校验、预览刷新与撤销重做后的状态重算，打包产物只包含运行时，不含编辑器代码。

### 2.3 核心设计决策（ADR 摘要）
| 编号 | 决策 | 理由 | 关联风险 |
| --- | --- | --- | --- |
| ADR-01 | 数值层统一使用 break_eternity.js 的 `Decimal`，并封装饱和（saturate）语义 | 支持分层指数（幂塔级），且无需自行实现对数/幂运算 | R-01 |
| ADR-02 | 表达式不用 `eval`/`new Function`，自研 Pratt 解析器编译为闭包树 | 项目文件含用户代码，必须可控、可静态校验、可限制上下文 | R-05 |
| ADR-03 | 运行时与编辑器共用核心包，编辑器内跑影子运行时 | 避免“两套逻辑”导致的预览与成品不一致 | R-12 |
| ADR-04 | 预览用 sandbox iframe + postMessage 隔离 | 表达式死循环/内存暴涨不拖垮编辑器 | R-11 |
| ADR-05 | 打包产物不使用 iframe，运行时直接挂载 | 单文件、体积小、无跨窗口通信开销 | — |
| ADR-06 | 撤销重做基于 immer patches，非全量快照 | 项目级条目多时内存与耗时可控 | R-09 |
| ADR-07 | 表达式求值按 tick 记忆化 + 属性版本号脏标记 | 每秒数十次全量重算在数百条目下会掉帧 | R-06 |
| ADR-08 | 批量/最大购买用“价格形状识别 + 闭式求和（等比/指数+常数/指数+线性/线性）+ 二分”求解，`free` 模式因只校验末价只需 `P` 单调即可二分；仍不可闭式时迭代并按 tick 分摊 | 避免无上限批量购买退化为 O(k) 循环 | R-03 |
| ADR-09 | 项目文件与存档文件严格分离，运行时赋值只进存档 | 满足 PRD 补充 6 | R-08 |
| ADR-10 | 上传图标/主题在导出与打包时内联为 `data:` 字符串 | 单文件产物可离线运行 | R-10 |

## 3. 工程结构
### 3.1 目录树
```
IncrementForge/
├─ apps/
│  ├─ editor/                  # 编辑器（React 19 + Vite）
│  │  ├─ src/
│  │  │  ├─ app/               # 布局壳：TitleBar / SideNav / Workspace / PreviewPane
│  │  │  ├─ features/
│  │  │  │  ├─ resources/      # 资源工作区（列表 + 编辑器表单）
│  │  │  │  ├─ generators/     # 生成器工作区
│  │  │  │  ├─ upgrades/       # 升级工作区
│  │  │  │  ├─ pages/          # 页面工作区（含条目布局编辑器）
│  │  │  │  ├─ settings/       # 设置页面
│  │  │  │  ├─ shell/          # 顶部栏、撤销重做、导入导出、打包（packageGame.ts）
│  │  │  │  └─ preview/        # 预览容器 + 模拟设置栏 + 诊断面板 + 通信适配
│  │  │  ├─ components/        # 通用组件（字段控件、表达式输入框、图标选择器）
│  │  │  └─ styles/            # 主题令牌、CSS 变量、布局样式
│  │  └─ index.html
│  └─ runtime-shell/           # 游戏运行时（React 19 + Vite），**唯一**的结算 + 游戏视图实现
│     ├─ src/
│     │  ├─ controller.ts      # 主循环、host:* 分发、交互与设置的结算入口（时钟/帧可注入）
│     │  ├─ bridge.ts          # postMessage 收发与校验（运行时侧）
│     │  ├─ boot.ts            # 装配：预览（桥）与直挂（bootstrap）两种启动方式
│     │  ├─ local-sink.ts      # 打包态存储：存档/会话覆盖写 localStorage（10.3、D-53）
│     │  ├─ iframe-entry.ts    # 入口之一：注入 srcdoc（esbuild 打成单文件 IIFE）
│     │  ├─ standalone-entry.ts# 入口之二：打包产物（直挂，读 __IFORGE_BOOTSTRAP__，17.3）
│     │  ├─ main.ts            # 入口之三：直挂调试页（window.__IFORGE_BOOTSTRAP__，17.3）
│     │  └─ view/              # 游戏视图组件：只渲染 GameViewModel / CardView，不另算数值
│     └─ index.html            # 直挂调试页
├─ packages/
│  ├─ num/                     # 数值层：Num 运算、饱和、格式化
│  ├─ expr/                    # 词法/Pratt 解析/静态校验/闭包编译器/求值器
│  ├─ model/                   # Zod Schema、默认工厂、ID/排序、迁移、类型、docs:gen
│  ├─ runtime/                 # 游戏状态、tick、产出、购买、升级效果、离线、存档序列化
│  │                           # ＋ 9.2 协议（protocol.ts）、8.11 视图模型（view-model.ts）、
│  │                           #   7.4 热更新补丁（patch.ts）：三者均不依赖 DOM（D-52）
│  ├─ persist/                 # IndexedDB 仓储（projects/assets/saves）
│  ├─ ui-kit/                  # 主题令牌、主题注册表、图标集、通用控件
│  ├─ i18n/                    # t() + LocaleRegistry + zh-CN 文案
│  └─ build/                   # 单文件打包：打包前校验、产物指纹、HTML 模板、esbuild 编译、CLI
│     └─ scripts/              # Node 侧脚本（iforge-pack / docs:gen / run-ts 机制）
├─ e2e/                        # Playwright 用例与 fixtures（14.1 端到端层）
├─ docs/                       # PRD.md / TECH_DESIGN.md / ADR/
└─ tools/                      # 脚本（校验、性能基准、示例项目生成）
```

`apps/editor` 通过一个 Vite 插件（`apps/editor/vite/iforge-runtime-shell.ts`）用 esbuild 把 `apps/runtime-shell/src/iframe-entry.ts` 打成单文件 IIFE，经虚拟模块 `virtual:iforge-runtime-shell` 注入 `srcdoc`。因此 `apps/*` 之间**没有 import 依赖**：`editor` 只在**构建期**消费 `runtime-shell` 的产物，`runtime-shell` 不认识编辑器；两者的共享部分（协议、视图模型）都在 `packages/runtime`（D-52）。

同一份虚拟模块产物也是 M5 打包的运行时来源（D-54）：编辑器不在浏览器里跑 esbuild，“打包”直接复用这段已在构建期编好的文本，因此“预览能跑”与“产物能跑”不可能分叉。打包产物走**另一个入口** `standalone-entry.ts`（直挂，等 `host:init` 的 `iframe-entry.ts` 在产物里会永远停在空白页），入口差异之外两者共用 `boot.ts` 与同一棵 `AppView`（ADR-03）。
### 3.2 包依赖规则
- 依赖必须单向：`num ← expr ← model ← runtime ← (persist | build)`；`model` 不依赖 `runtime`。
- `packages/*` 一律 ESM + `tsc --noEmit` 类型检查，不允许导入 DOM API（`persist`、`ui-kit` 除外）。
- 编辑器只通过 `@iforge/model` 的 Schema 读写数据，禁止直接操作裸对象字面量。

## 4. 数值系统设计
### 4.1 需求映射
PRD 要求「指数级乃至幂塔级」运算且「防止上下溢出」，并要支持 `1e1e10` 量级的购买、产出与效果结算。

### 4.2 分层表示
| 层级 | 数量级示例 | 表示 |
| --- | --- | --- |
| L0 | ≤ 1e15 | `Decimal`（break_eternity 内部双精度尾数） |
| L1 | 1e100、1e1e10 | `Decimal` 单层指数（mantissa + layer0 exponent） |
| L2 | 1e1e1e10 | `Decimal` 分层指数（layer = 1） |
| L3+ | 1e1e1e1e10 … | `Decimal` 分层指数（layer ≥ 2） |

`Decimal` 原生支持加减乘除、幂、tetrate、slog、`fromString`/`toStringWithDecimalPlaces`，可覆盖上表。禁止在核心逻辑中把 `Decimal` 转成 JS `number`，除格式化与非数值比较（如布局计算）外。

### 4.3 Num 数值层 API
```ts
// packages/num
import { Decimal } from 'break_eternity.js'

export const NUM_MAX_LAYER = 1e15      // 允许的最大指数层层数
export const NUM_MAX: Decimal           // 饱和上界：10 ↑↑ (1e15)
export const NUM_MIN: Decimal           // 数量类下界：0
export const NUM_INF: Decimal           // “无上限”哨兵：Infinity 字面量的运行时表示（不参与饱和钳制，见 4.4 第 6 条）

export const Num = {
  // 算术（全部内部 saturate）
  add(a, b), sub(a, b), mul(a, b), div(a, b), mod(a, b),
  pow(base, exp),                 // exp 可为 Decimal，走分层幂
  neg(a), abs(a), sign(a): -1 | 0 | 1,
  // 比较
  cmp(a, b): -1 | 0 | 1, eq, lt, lte, gt, gte, isZero, isPos, isInf,  // isInf：是否 NUM_INF 哨兵（比较时等同 +∞）
  // 取整与函数
  floor(a), ceil(a), round(a), trunc(a), sqrt(a), ln(a), log10(a), log(a, base), exp(a),
  min(...), max(...), clamp(a, lo, hi), lerp(a, b, t),
  // 转换与格式化
  toNumber(a): number,            // 不安全时夹到 ±Number.MAX_VALUE 并置饱和标记
  isSafeNumber(a): boolean,
  format(a, format, opts): string,     // NUM_INF 统一格式化为 "∞"
  // 诊断
  saturate(a): Decimal, isSaturated(a): boolean, resetDiagnostics(),
}
```
### 4.4 溢出/下溢策略（饱和语义）
1. **饱和上界**：`NUM_MAX = Decimal.tetrate(10, 1e15)`；任何运算结果层数超过 `NUM_MAX_LAYER` 时饱和为 `NUM_MAX`，并标记 `saturated = true`。
2. **饱和下界**：数量类结果 < 0 一律经 `clampLower0` 截断为 0（下限为零，PRD 补充 3）；纯数学结果（如 `exp(-1e308)`）下溢到 `1e-323` 以下时饱和为 0。
3. **标记可观测**：`saturated` 通过 `WeakSet` 挂在值上，UI 在资源卡片与诊断面板显示 `∞` 提示，PRD「防止上下溢出」由此可观测而非静默出错。
4. **数量上限应用**：统一走 `applyCap(value, max) = isInf(max) ? value : min(value, max)`，且 `max` 表达式求值后若 ≤ 0 则按 1 处理（PRD：必定大于零），并在诊断面板记录 `E_CAP_NON_POSITIVE`；求值为 `NaN`（如 `0/0`）时同样按 1 处理——`NaN` 不满足任何比较，必须显式拦截，否则会绕过 `≤ 0` 判定进入夹取路径。
5. **取整退化**：`floor/ceil/round/trunc` 对超 `Number.MAX_SAFE_INTEGER` 的值直接返回自身（其本身已是整数），避免精度灾难。
6. **“无上限”的表示（`Infinity` 字面量，D-46）**：`Infinity` 是 [5.2](#52-语法) 的合法数字字面量，解析为哨兵值 `NUM_INF`（[4.3](#43-num-数值层-api)），与饱和上界 `NUM_MAX` **区分开**——前者是语义哨兵（不钳制），后者是数值边界。项目文件与 `create()` 缺省值里的 `max="Infinity"`（[8.7](#87-升级效果与动态条目)）就走这条字面量，因此该字面量必须在编译期可解析，不能落到 `E_UNKNOWN_IDENT`：

   | 场景 | 语义 |
   | --- | --- |
   | `max` 字段 | `isInf(max)` → `applyCap` **完全跳过钳制**，即“硬上限不存在”。与 `max === NUM_MAX` 的最终效果一致（数值层本就饱和在 `NUM_MAX`），两种写法都表示“无实际上限”，但 `Infinity` 不引入任何比较与夹取开销 |
   | 价格 `costs[i].amount` | 折算为 `NUM_MAX` 并记 `E_OVERFLOW` 诊断 → 该材料**永远买不起**，语义确定、不抛异常（D-02） |
   | 产出 `produces[i].amount`、数量类属性（`initial`/`amount`/`bought`/`owned`/`effectValues[i]`） | 折算为 `NUM_MAX` 并记 `E_OVERFLOW`（下界方向为 `NUM_MIN`），即“立即爆表/取到顶” |
   | `buyAmount` | 归一化第 ② 步的有限性检查已拒绝非有限值 → `E_BUY_AMOUNT_INVALID` 并保持 last-good（[5.9.3](#593-读写实现约定)、D-36） |
   | 条件与比较表达式 | 作为 `+∞` 参与比较（`x < Infinity` 为真、`x >= Infinity` 为假），**不**折算、不饱和 |

   `NUM_INF` 参与算术（`+ - * / pow` 等）一律按饱和语义折算为 `NUM_MAX`（向负方向运算时折算为 `NUM_MIN`）并打 `saturated` 标记；`Num.format` 对 `NUM_INF` 输出 `∞`。**不为此新增错误码**：无穷的唯一合法用途“无上限”已有确定语义，其余场景复用饱和（`E_OVERFLOW`）与既有的 `E_BUY_AMOUNT_INVALID`，避免为一个哨兵值扩张错误表与 UI 分支。

### 4.5 显示格式
| 格式枚举 | 行为 |
| --- | --- |
| `standard`（默认） | < 1e6 直接整数；之后按量级切换 K/M/B/T/Qa/Qi…；再大用科学计数，幂塔级用分层记法 |
| `scientific` | 统一科学计数 `1.23e456` |
| `engineering` | 指数取 3 的倍数 `123e456` |
| `letters` | 字母记数 `1.5A`、`2.3B`、`1.1Za`… |
| `layered` | 分层指数 `1.23e4.56e7.89`，用于展示幂塔量级 |

格式化有节流缓存，缓存键必须是能唯一还原数值状态的**完整指纹**（仅 `mantissa+layer+format` 会漏掉符号与低阶指数）：`fmt(sign|mag|layer|mantissa|places|format)`，上限 4096 条，LRU 淘汰；同值同格式只算一次（每 tick 数千个条目时，格式化是主要 CPU 开销之一）。

## 5. 表达式沙箱
### 5.1 语言定位
用户可编写三类表达式：**常量表达式**（`initial`/`max`/`buyAmount` 等字段值）、**条件表达式**（默认 `true`）、**赋值表达式**（升级效果的内容）。语言为类 JavaScript 的表达式子集，无语句、无循环、无函数声明。

### 5.2 语法
```ebnf
program    = assignment ;
assignment = or [ ("=" | "+=" | "-=" | "*=" | "/=") assignment ] ;
or         = and { "||" and } ;
and        = equality { "&&" equality } ;
equality   = relational { ("=="|"!="|"==="|"!==") relational } ;
relational = additive { ("<"|"<="|">"|">=") additive } ;
additive   = multiplicative { ("+"|"-") multiplicative } ;
multiplicative = power { ("*"|"/"|"%") power } ;
power      = unary [ ("^"|"**") power ] ;        // 右结合
unary      = ("-"|"+"|"!") unary | postfix ;
postfix    = primary { "." ident [ "(" args ")" ] | "[" expression "]" } ;
primary    = number | string | "true" | "false" | "null"
            | path | ident [ "(" args ")" ] | "(" expression ")" | object | array ;
object     = "{" [ pair { "," pair } ] "}" ;          // 仅允许出现在 create() 的 spec 实参内（见下）
array      = "[" [ assignment { "," assignment } ] "]" ; // 同上
pair       = key ":" assignment ;                      // 键必须是字符串字面量或标识符
path       = ("res"|"gen"|"up"|"page") "." id "." attr ;
args       = [ assignment { "," assignment } ] ;
```
- 数字字面量：`123`、`1.5`、`1e10`、`1e1e10`（分层指数，PRD 补充 2）、`-2.5e-3`、`Infinity`（表示“无上限”，解析为哨兵 `NUM_INF`；各上下文的语义见 [4.4 第 6 条](#44-溢出下溢策略饱和语义)、D-46。项目文件字段与 `create()` 缺省值 `max="Infinity"` 都必须能编译通过，不得报 `E_UNKNOWN_IDENT`；不提供 `inf()`/`Inf` 等别名写法，避免同一语义出现多种拼写）。
- 字符串字面量：`"文本"`（**只用双引号**，单引号不是字符串定界符），支持 `\"`、`\\`、`\n`。用于所有字符串类型属性（`description`、`costs[i].materialId`、`produces[i].materialId`）与**表达式文本属性**（`costs[i].amount`、`produces[i].amount`、`conditions[i]`、`effects[i].condition`/`action`）的赋值，以及 `create()` 的 `name`/`description` 等字符串字段；字符串不参与算术运算（`+` 不做字符串拼接，语言无 `str()`，见 [5.9.3](#593-读写实现约定)）。
- 标识符：内置变量与函数（下表），未知标识符在**编译期**报错 `E_UNKNOWN_IDENT`。
- **对象/数组字面量是受限语法**（服务于 `create()`，PRD 升级编辑器 12）。它们不是通用数据结构语法，约束如下，全部在**编译期**静态判定，规则与 [5.9 属性读写矩阵](#59-属性读写矩阵)、[6.2 项目文件 Schema](#62-项目文件-schemajson)、[13 安全与沙箱](#13-安全与沙箱) 共用同一份字段白名单，不允许实现期临时放宽：

  | 约束 | 规则 | 违反时 |
  | --- | --- | --- |
  | 出现位置 | **仅**允许作为 `create(kind, spec)` 的 `spec` 实参，或嵌套在这些 spec 内部（`costs`/`produces`/`conditions`/`effects` 等数组元素）；出现在价格、条件、产出、`set()` 等任何其他位置 | 编译期 `E_LITERAL_NOT_ALLOWED`（V1.0 的内置函数表中**没有任何函数以列表为实参**，[5.4](#54-内置函数)，因此不存在第二个允许位置；将来若新增这类函数，必须同时在此增加受限例外并复用同一套深度/长度/元素校验） |
  | 键名 | 必须是 [8.7](#87-升级效果与动态条目) 的“字段集合”白名单 + `page`；与 `GeneratorDef`/`UpgradeDef` 字段一致 | 编译期 `E_CREATE_FIELD_INVALID`（运行期不再兜底） |
  | 键形式 | 只允许字符串字面量或标识符（不支持计算键名、变量键、展开运算符 `...`）；允许尾逗号 | `E_PARSE` |
  | 嵌套深度 | 计入总深度上限 64，并额外限制字面量自身嵌套 ≤ 4 层 | `E_PARSE_DEPTH` |
  | 数组长度 | 单个数组字面量 ≤ 64 项（与动态条目总数 2000 上限配合，见 D-32） | `E_BUDGET` |
  | 求值 | 静态折叠为常量值；`create()` 在副作用提交阶段（[5.6](#56-编译与执行)）构造 `spec`，走与项目文件同一套 Zod Schema 与跨条目一致性校验 | — |

### 5.3 内置变量
| 变量 | 类型 | 读写 | 含义 |
| --- | --- | --- | --- |
| `res.<id>.amount` | 数量 | 读/写 | 资源当前数量（资源无 `bought`，读取报 `E_UNKNOWN_ATTR`） |
| `res.<id>.owned` | 数量 | 读/写 | **`amount` 的别名**（PRD 补充 3：“资源/生成器/升级条目还具有属性‘拥有数量’”）。读写都落到同一份 `amount` 存储，不产生第二份副本、不单独存档；写入同样经 `applyCap` 夹到 `max` |
| `res.<id>.initial` / `.max` / `.visible` / `.description` | 数值/布尔/字符串 | 读/写 | 资源属性（资源无 `disabled`）；`description` 为字符串赋值（PRD 资源编辑器 3） |
| `gen.<id>.bought` / `.owned` / `.initial` / `.max` / `.visible` / `.disabled` / `.buyAmount` / `.isClicker` / `.description` | 数量/布尔/字符串 | 读/写 | 生成器属性 |
| `gen.<id>.perSec` | 数量 | 读 | 该生成器当前每秒产出合计（**只读**，派生值，不存档，每 tick 重算） |
| `gen.<id>.buyDelay` | 数量 | 读 | 自动最大购买的间隔 tick 数（**只读**，[6.5.2](#652-生成器prd-生成器编辑器-111) 的实现细节字段） |
| `gen.<id>.costs[i].materialId` / `.amount` | 字符串/表达式 | 读/写 | 第 `i` 条购买价格（改 `materialId` 会使该材料的价格缓存失效并重新编译 `amount`） |
| `gen.<id>.produces[i].materialId` / `.amount` | 字符串/表达式 | 读/写 | 第 `i` 条产出（`materialId` 可指向资源或生成器；`amount` 是**单件产出速率**表达式，总产出 = `owned × Σ produces[i].amount`，见 8.3 与 D-30） |
| `up.<id>.bought` / `.owned` / `.initial` / `.max` / `.visible` / `.disabled` / `.buyAmount` / `.perSecond` / `.description` | 数量/布尔/字符串 | 读/写 | 升级属性 |
| `up.<id>.buyDelay` | 数量 | 读 | 自动最大购买的间隔 tick 数（**只读**，实现细节字段，与生成器同构） |
| `up.<id>.costs[i].materialId` / `.amount` | 字符串/表达式 | 读/写 | 同生成器 |
| `up.<id>.conditions[i]` | 表达式文本 | 读/写 | 购买条件（赋值即热替换该条条件文本，重新编译；AND 语义，PRD 补充 4） |
| `up.<id>.effects[i].condition` / `.action` | 表达式文本 | 读/写 | 效果前提与效果内容（赋值即热替换，重新编译；PRD 升级编辑器 12） |
| `up.<id>.effectValues[i]` | 数值 | 读/写 | 第 `i` 条效果的持久化数值，默认 `0`，用户可自行赋值；同一 tick 内被效果重算覆盖 |
| `page.<id>.visible` / `.disabled` / `.description` | 布尔/字符串 | 读/写 | 页面属性 |
| `res/gen/up/page.<id>.id` / `.order` / `.name` / `.icon` | 字符串/数值/图标 | 读 | 条目与页面的**标识与展示属性**（创建后不变的 `id`、`order`、`name`、`icon`），**一律只读**；布局属性 `page.<id>.theme` / `.columns` / `.entries` 同样只读（见 [5.9](#59-属性读写矩阵)） |
| `effValue` | 数值 | 读/写 | 仅 `effect` 上下文的局部别名，等于当前效果的 `up.<id>.effectValues[i]`；在 `action` 中对它赋值即写回该效果数值 |
| `tick` | 数值 | 读 | 当前逻辑帧序号 |
| `time` | 数值 | 读 | 当前游戏内时间（秒） |
| `dt` | 数值 | 读 | 当前 tick 时长（秒） |
| `elapsed` | 数值 | 读 | 距上次存档的秒数（离线时为离线秒数） |
| `offline` | 布尔 | 读 | 是否处于离线模拟 |
| `started` | 布尔 | 读 | 是否已开局（第一次 tick 后为真） |

属性读写权限的完整矩阵（类型、可读/可写上下文、持久化位置、重置行为）见 [5.9 属性读写矩阵](#59-属性读写矩阵)；本表只列出表达式可直接引用的路径。

属性访问统一走 `AttributeStore` 的读写接口，因此表达式对属性的任何写入都会自动触发版本号递增与脏标记传播（见 [5.7](#57-求值调度与性能)）。

### 5.4 内置函数
| 函数 | 说明 | 价格上下文 | 离线 |
| --- | --- | --- | --- |
| `min/max/clamp/lerp/abs/sign` | 基础函数 | ✅ | ✅ |
| `floor/ceil/round/trunc` | 取整（超安全整数退化） | ✅ | ✅ |
| `sqrt/ln/log10/log/exp/pow` | 对数与指数 | ✅ | ✅ |
| `if(cond, a, b)` | 惰性分支 | ✅ | ✅ |
| `rand()` | `[0,1)` 随机数 | ❌ 禁用 | ❌ 禁用 |
| `randInt(min, max)` | 整数随机 `[min,max]` | ❌ | ❌ |
| `randChance(p)` | `rand() < p` | ❌ | ❌ |
| `set(path, expr)` | 赋值到可写属性的显式函数写法，等价于 `path = expr` | ❌ 禁用 | ✅ |
| `create(kind, spec)` | 动态创建生成器/升级（`kind` ∈ `{'generator','upgrade'}`，`spec` 为受限对象字面量且必须含 `page`；`spec.id` 可选，给出后新条目可用**字面量路径**在后续 tick 被赋值/丢弃）。返回值即新条目 id，**只能直接作为 `destroy()` 实参**串联使用，不能用作 `set()` 路径（见 [8.7](#87-升级效果与动态条目)、D-44） | ❌ 禁用 | ✅ |
| `destroy(id)` | 丢弃动态条目（预览区“丢弃”按钮同款能力） | ❌ 禁用 | ✅ |
| `has(kind, id)` | 判断动态条目是否存在 | ✅ | ✅ |
| `count(kind)` | 某类条目数量 | ✅ | ✅ |

PRD 补充 1 的落地：随机函数**编译期**在价格类表达式中出现即报 `E_RAND_DISABLED`（编辑器红框，表达式不生效）；**运行期**在离线上下文调用同样抛该错误，由 last-good 机制兜底并在诊断面板列出。

**表的读法（消除“离线 ✅”的歧义）**：“价格上下文”列指 [5.5](#55-上下文context与权限) 的 `price` 上下文，“离线”列指 `runtime.offline = true` 期间；**两列都不放宽 5.5 的权限**，只是把 5.5 的两行投影到本表，便于逐函数查阅：
- 随机函数（`rand`/`randInt`/`randChance`）两列都 ❌：价格表达式与离线一律禁用（PRD 补充 1）。
- `set/create/destroy` 的“离线 ✅”**仅指 `effect` 上下文**——它们是副作用函数，离线时若出现在 `price`/`production`/`condition`/`field` 上下文同样报 `E_SIDE_EFFECT_FORBIDDEN`；再叠加一条实现事实：离线结算跳过升级“每秒生效”与自动购买、期间也不发生任何购买（[8.8](#88-离线模拟)），因此离线中实际不存在 `effect` 求值，这三个函数在离线属**登记但不构成可达路径**，以免实现期误读成“离线可随意创建/销毁条目”。

**随机函数集合的边界**（V1.0 只给三条标量函数）：语言没有列表与变量类型，除 `create()` 的 `spec` 外任何位置都不允许出现数组字面量（[5.2](#52-语法)、[13](#13-安全与沙箱) 第 2 条），因此**不提供接收列表的随机取值函数**——这类函数在 V1.0 没有可传入的实参、必然不可调用，列进函数表只会制造“可写却写不出”的死接口。需要“多个候选中随机取一个”时用 `randInt(min, max)` 映射到序号，或用 `if(randChance(p), a, b)` 表达分支。

赋值的两种写法（仅 `effect` 上下文可用）：赋值运算符 `path = expr`（支持 `+= -= *= /=`）与显式函数 `set(path, expr)`。`set()` 的第一个参数**必须是字面量路径**（`"gen.g1.produces[0].amount"`），不接受变量或表达式拼接，以便编译期完成目标解析、权限校验与依赖收集。这条约束同时意味着 `create()` 的返回值无法充当赋值目标——动态条目要在创建后被修改，必须在 `spec` 里给出稳定 `id`（D-44、见 [8.7](#87-升级效果与动态条目)）。

赋值目标必须是 [5.3](#53-内置变量) 中标记为可写的属性，共四类：**数值**（`initial`、`max`、`amount`、`bought`、`owned`（资源侧 `res.<id>.owned` 为 `amount` 的别名）、`buyAmount`、`costs[i].amount`、`produces[i].amount`、`effectValues[i]`，在 `action` 内也可用 `effValue` 简写）、**布尔**（`visible`、`disabled`、`isClicker`、`perSecond`）、**字符串**（条目与页面的 `description`、`costs[i].materialId`、`produces[i].materialId`）、**表达式文本**（`up.<id>.conditions[i]`、`up.<id>.effects[i].condition`、`.action`）。逐项的可读/可写上下文、存档位置与重置行为见 [5.9](#59-属性读写矩阵)；**写入形态与取值规则**（三类目标各自的求值与落盘方式、D-29 的“右侧先求值、不回写源码”、`buyAmount` 归一化、“可做/不可做”对照表）统一由 [5.9.3](#593-读写实现约定) 承载，本节不重复。

- 写只读属性（`id`、`order`、`name`、`icon`、`perSec`、`buyDelay`，页面的 `theme`/`columns`/`entries`）在编译期报 `E_READONLY_TARGET`；写入类型不匹配（如给布尔属性赋字符串、给 `effectValues[i]` 赋非数值）报 `E_ASSIGN_TYPE`。字符串与表达式文本赋值一律走 [5.9.3](#593-读写实现约定) 的热替换路径，并把 `{ value, expr }` 写入存档 `assignments`（PRD 补充 6）。

### 5.5 上下文（Context）与权限
| 上下文 | 用于 | 可读 | 随机 | 副作用（set/create/destroy） | 读取自身条目属性 |
| --- | --- | --- | --- | --- | --- |
| `field` | `initial`/`max`/`buyAmount`/`perSecond` 等常量字段 | ✅ | ✅ | ❌ | ✅ |
| `price` | 购买价格、批量购买材料数量 | ✅ | ❌ | ❌ | ✅（自身 `bought`） |
| `production` | 产出数量 | ✅ | ✅ | ❌ | ✅ |
| `condition` | 升级购买条件、效果前提 | ✅ | ✅ | ❌ | ✅ |
| `effect` | 升级效果内容（赋值表达式） | ✅ | ✅ | ✅ | ✅ |
| `offline` | 离线模拟期间的一切求值 | ✅ | ❌ | 仅 `effect` | ✅ |

`offline` 是横切标记：`runtime.offline = true` 时所有上下文随机函数不可用，其余权限继承其原上下文。

写权限由“副作用”列决定：只有 `effect` 上下文（或离线时的 `effect`）允许写入，且写入目标还必须在 [5.9](#59-属性读写矩阵) 中标为可写；两者任一不满足即在编译期报 `E_SIDE_EFFECT_FORBIDDEN` 或 `E_READONLY_TARGET`。读取权限无差别，所有上下文均可读取 [5.3](#53-内置变量) 列出的全部可读路径（`effValue` 除外，它只在 `effect` 上下文存在）。

### 5.6 编译与执行
```
源码 → Lexer → Parser(Pratt) → AST → StaticChecker → ClosureCompiler → CompiledExpr
CompiledExpr: { text, hash, deps: string[], fn(scope) }
```
- **编译缓存**：`Map<hash(contextKind + '\u0000' + text), CompiledExpr>`，上限 8192 条；表达式文本变更即失效（hash 含文本）。
- **闭包树**：每个 AST 节点编译为 `(scope) => value`，节点值在编译期直接内联（常量折叠），不做每 tick 递归解释。
- **变量解析**：静态检查阶段把 `res.gold.amount` 解析为 `{kind, id, attr}` 写入 `deps`；运行时 `deps` 用于脏标记与循环检测。
- **副作用**：`set/create/destroy` 通过 `EffectSink` 收集，**不在表达式内立即生效**，而是在本 tick 的固定提交阶段按书写顺序统一应用（保证可预测性与幂等性）。提交阶段唯一，tick 之间发生的交互事件所产生的副作用也进同一队列、在**下一个**提交阶段应用，不另开即时提交旁路（[8.3.1](#831-交互事件与-tick-边界)）。
- **求值失败时的回滚**：`EffectSink` 按“表达式实例”分桶。若某条表达式求值过程中抛错（类型错误、下标越界、目标不存在、`E_CYCLE`、预算超限等），**丢弃该表达式本次已收集的全部副作用**（包括其前半段已成功求值的子树写入的 `set`/`create`/`destroy`），受影响属性沿用 last-good 并记诊断；**其它表达式**已收集的副作用不受影响，按原顺序照常提交。由此保证“一条表达式要么整体生效、要么完全不生效”，避免半条赋值污染状态。
- **`effValue` 的写回与所在分桶同生共死**（消除“局部别名是否绕过 `EffectSink`”的分叉）：`effValue` 是 `effect` 上下文的**局部变量**（[5.3](#53-内置变量)），对它的赋值**不直接写 `AttributeStore`**，而是在**当前这条效果的分桶**内登记一条等价于 `set("up.<id>.effectValues[i]", effValue)` 的写回（提交阶段才落地）。因此：① `action` 求值抛错 → 该写回与其收集的其它副作用**一并丢弃**，`effectValues[i]` 保持上次成功值（last-good）；② `action` 未对 `effValue` 赋值 → **不登记写回**，也不递增该属性 `version`（避免制造无意义的缓存失效），数值原样保留（8.7 的伪码按此实现）。
- **禁止项**：`eval`、`new Function`、`with`、全局对象访问、属性原型链（`__proto__`/`constructor`/`prototype` 直接在词法层拒绝，错误 `E_FORBIDDEN_TOKEN`）。
- **可读变量白名单**：作用域对象只暴露 `AttributeStore` 接口与内置函数表，`Object.create(null)` 构造，无原型污染路径。
- **资源上限**（与 [13](#13-安全与沙箱) 第 1/2 条同源）：单条表达式文本 ≤ 2000 字符、嵌套深度 ≤ 64、字面量自身嵌套 ≤ 4、单个数组字面量 ≤ 64 项；超限在**编译期**报 `E_PARSE_DEPTH` / `E_BUDGET`，不进入运行期。

### 5.7 求值调度与性能
- **每 tick 记忆化**：`tickCache: Map<exprHash, value>`，同一 tick 内同表达式只算一次。
- **属性版本号**：`AttributeStore` 为每个属性维护 `version`；表达式记录上次求值时的依赖版本快照，版本未变则复用缓存值。副作用在**提交阶段**写入时递增目标属性版本 → 下游自动失效（写入不发生在表达式求值阶段，见 5.6）。
- **依赖环检测**：求值节点入栈时打标，重入即抛 `E_CYCLE`，该属性取 last-good，诊断面板按环路径展示。
- **last-good**：任何表达式错误都不中断 tick；保留上次成功值、累加错误计数，并在预览诊断角标显示数量。
- **配额**：单个 tick 内表达式求值次数上限 20000，超出即本 tick 停止求值并报 `E_BUDGET`（保护 UI 不卡死）。

### 5.8 表达式编辑器交互
- 输入框内联语法高亮 + 悬浮提示（可用变量/函数按当前字段上下文过滤）；错误定位到列区间，红色下划线 + 悬浮错误原因。
- “实时校验”：失焦与输入停顿 300ms 时在影子运行时试算，右侧显示求值结果与耗时。
- 常用片段快捷插入（当前条目自身属性、其他条目引用、随机函数）。

### 5.9 属性读写矩阵
PRD 对属性统一采用“可被外部引用或赋值”的表述，但并非所有字段都允许写入。本节是实现期唯一的权限依据：表达式解析、编辑器表单校验、打包前检查、运行时 `set()` 全部以此表为准；表外属性一律只读。

#### 5.9.1 条目属性
| 属性路径 | 类型 | 可读 | 可写（仅 `effect` 上下文） | 存档位置 | 重新开始时 |
| --- | --- | --- | --- | --- | --- |
| `id` / `order` / `name` / `icon` | 字符串/数值/图标 | ✅ | ❌ | 项目文件（不随存档变化） | 回到项目文件值 |
| `description` | 字符串 | ✅ | ✅ | 顶层 `description` + `assignments` | 回到项目文件值 |
| `visible` / `disabled` | 布尔 | ✅ | ✅ | 顶层 + `assignments` | 回到项目文件值 |
| `initial` | 数值 | ✅ | ✅ | 顶层 `initial` + `assignments` | 回到项目文件值 |
| `max` | 数值 | ✅ | ✅ | 顶层 `max` + `assignments` | 回到项目文件值 |
| `amount`（资源） | 数值 | ✅ | ✅ | 顶层 `amount` | 回到 `initial` |
| `owned`（资源，= `amount` 的别名） | 数值 | ✅ | ✅ | 同 `amount`，**不单独存档**（PRD 补充 3） | 回到 `initial` |
| `bought` / `owned` | 数值 | ✅ | ✅ | 顶层 | 回到 `initial`（生成器/升级按 8.5 初始化规则） |
| `buyAmount` | 数值 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `isClicker`（生成器） | 布尔 | ✅ | ✅ | 顶层 + `assignments` | 回到项目文件值 |
| `perSecond`（升级） | 布尔 | ✅ | ✅ | 顶层 + `assignments` | 回到项目文件值 |
| `costs[i].materialId` | 字符串 | ✅ | ✅ | `assignments["costs[i].materialId"]`（列表字段不进顶层） | 回到项目文件值 |
| `costs[i].amount` | 表达式 | ✅ | ✅ | `assignments["costs[i].amount"]` | 回到项目文件值 |
| `produces[i].materialId` / `.amount` | 字符串/表达式 | ✅ | ✅ | `assignments["produces[i].materialId" / ".amount"]` | 回到项目文件值 |
| `conditions[i]`（升级） | 表达式 | ✅ | ✅ | `assignments["conditions[i]"]` | 回到项目文件值 |
| `effects[i].condition` / `.action` | 表达式 | ✅ | ✅ | `assignments["effects[i].condition" / ".action"]` | 回到项目文件值 |
| `effectValues[i]`（升级） | 数值 | ✅ | ✅ | 顶层 `effectValues[i]`（PRD 升级编辑器 12） | 清零为 `0` |
| `perSec`（生成器） | 数值 | ✅ | ❌ | 不存档（派生量，每 tick 重算） | — |
| `buyDelay`（生成器/升级） | 数值 | ✅ | ❌ | 顶层 `buyDelay`（实现细节，非 PRD 字段） | 回到项目文件值 |

逐字段的规范化清单（一个字段一行，供交叉校验与单测消费；人工表才是面向阅读的版本）：

<!-- docs:gen:5.9.1:start -->
<!-- 本块由 `pnpm docs:gen` 从 `packages/expr` 的 `PROPERTY_SPECS` 生成，请勿手改；
     上面的人工表才是面向阅读的版本，两者的字段集合必须一致（14.3 规则 1/2）。 -->
| 属性路径 | 适用 | 类型 | 可读 | 可写 | 存档位置 | 重新开始时 |
| --- | --- | --- | --- | --- | --- | --- |
| `id` | 资源/生成器/升级 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `order` | 资源/生成器/升级 | 数值 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `name` | 资源/生成器/升级 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `icon` | 资源/生成器/升级 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `description` | 资源/生成器/升级 | 字符串 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `visible` | 资源/生成器/升级 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `disabled` | 生成器/升级 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `initial` | 资源/生成器/升级 | 数值 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `max` | 资源/生成器/升级 | 数值 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `amount` | 资源 | 数值 | ✅ | ✅ | 顶层 | 回到 initial |
| `bought` | 生成器/升级 | 数值 | ✅ | ✅ | 顶层 | 回到 initial（生成器/升级按 8.5 初始化规则） |
| `owned` | 生成器/升级 | 数值 | ✅ | ✅ | 顶层 | 回到 initial（生成器/升级按 8.5 初始化规则） |
| `res.owned` | 资源 | 数值 | ✅ | ✅ | 顶层 | 回到 initial |
| `buyAmount` | 生成器/升级 | 数值 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `isClicker` | 生成器 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `perSecond` | 升级 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `perSec` | 生成器 | 数值 | ✅ | ❌ | 不存档（派生量） | — |
| `buyDelay` | 生成器/升级 | 数值 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `costs[i].materialId` | 生成器/升级 | 字符串 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `costs[i].amount` | 生成器/升级 | 数值 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `produces[i].materialId` | 生成器 | 字符串 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `produces[i].amount` | 生成器 | 数值 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `conditions[i]` | 升级 | 数值 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `effects[i].condition` | 升级 | 数值 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `effects[i].action` | 升级 | 数值 | ✅ | ✅ | 仅 `assignments` | 回到项目文件值 |
| `effectValues[i]` | 升级 | 数值 | ✅ | ✅ | 顶层 | 清零为 0 |
<!-- docs:gen:5.9.1:end -->

#### 5.9.2 页面属性
| 属性路径 | 类型 | 可读 | 可写 | 存档位置 | 重新开始时 |
| --- | --- | --- | --- | --- | --- |
| `visible` / `disabled` | 布尔 | ✅ | ✅ | 顶层 + `assignments` | 回到项目文件值 |
| `description` | 字符串 | ✅ | ✅ | 顶层 + `assignments` | 回到项目文件值 |
| `id` / `order` / `name` / `icon` | — | ✅ | ❌ | 项目文件 | — |
| `theme` / `columns` / `entries` | 主题/数值/列表 | ✅ | ❌（布局属性，PRD 未要求可赋值） | 项目文件 | — |

逐字段的规范化清单（供交叉校验与单测消费）：

<!-- docs:gen:5.9.2:start -->
<!-- 本块由 `pnpm docs:gen` 从 `packages/expr` 的 `PROPERTY_SPECS` 生成，请勿手改。 -->
| 属性路径 | 适用 | 类型 | 可读 | 可写 | 存档位置 | 重新开始时 |
| --- | --- | --- | --- | --- | --- | --- |
| `id` | 页面 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `order` | 页面 | 数值 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `name` | 页面 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `icon` | 页面 | 字符串 | ✅ | ❌ | 顶层 | 回到项目文件值 |
| `description` | 页面 | 字符串 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `visible` | 页面 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `disabled` | 页面 | 布尔 | ✅ | ✅ | 顶层 | 回到项目文件值 |
| `theme` | 页面 | 字符串 | ✅ | ❌ | 顶层 | — |
| `columns` | 页面 | 数值 | ✅ | ❌ | 顶层 | — |
| `entries` | 页面 | 数值 | ✅ | ❌ | 顶层 | — |
<!-- docs:gen:5.9.2:end -->

#### 5.9.3 读写实现约定
- **数值属性写入**：写入即递增该属性 `version`、清空其记忆化缓存与派生值（`amount` 同步刷新仪表盘速率），并按 [6.3](#63-存档文件-schemasavejson) 记录 `assignments`。
- **`NumExpr` 数值字段（`initial`/`max`/`buyAmount`）的写入形态**：这三类字段在数据模型里是**字符串字段**（[6.2](#62-项目文件-schemajson)），运行时按对应上下文求值。表达式赋值时与表达式文本属性**同规则**（D-29）：右侧先求值，再把结果的十进制字面量文本写入该字段，**不回写源码**。因此 `gen.g1.initial = 2 * gen.g1.owned` 得到的是常量文本 `10`，不是表达式；需要随运行时变化的 `initial`/`max` 应由升级效果按条件重新赋值多次，而非依赖“赋值即回写”。`max` 写入后仍按 [4.4](#44-溢出下溢策略饱和语义) 第 4 条处理（≤ 0 或 `NaN` 按 1 并记 `E_CAP_NON_POSITIVE`）；写入 `Infinity` 即“恢复为无上限”（第 6 条），因此升级效果可把曾被改小的 `max` 复位回无上限状态。

  **右侧为字符串/布尔/`null` 时的明确定义**（这三类字段既然与表达式文本属性“同规则”，就必须逐类型写死，避免实现期凭直觉选一种）：

  | 右侧结果类型 | 写入结果 | 示例与后续处理 |
  | --- | --- | --- |
  | 字符串 | 该字符串**原样成为该字段的新表达式源码**（这是运行时就地替换字段文本的唯一手段，与 `set(路径, "源码")` 等价） | `gen.g1.initial = "1e10"` → 字段文本变为 `1e10`；`gen.g1.max = "res.r1.amount * 10"` → 字段文本变为该引用式，它在 `field` 上下文按需重新求值（受 5.7 的记忆化与版本号约束），因而**随运行时状态变化**——这是取得“动态数值字段”的正确写法，与下方“表达式文本无法在运行时拼接”不矛盾：写进去的就是源码本身 |
  | 字符串但不是合法表达式 | 走与编辑器改文本相同的热替换路径：下一 tick 编译失败报 `E_PARSE` 并**保留旧文本**（last-good） | `gen.g1.initial = "abc"` → `E_PARSE`，`initial` 仍为上次成功值 |
  | 数值 | 该数值的十进制字面量文本作为新文本 | `gen.g1.initial = 2 * gen.g1.owned` → 新文本 `10` |
  | 布尔 / `null` | 报 `E_ASSIGN_TYPE`，**保留旧文本**（不写入） | `gen.g1.initial = true` → `E_ASSIGN_TYPE` |

  三类字段写入后都各自走一次后处理：`max` 走 [4.4](#44-溢出下溢策略饱和语义) 第 4/6 条，`buyAmount` 走下方归一化的 ①~④；`initial` 不做后处理。**运行时的写入只落在存档**（PRD 补充 6）：项目文件里的字段文本不被改写，读档不回放 `assignments.expr`；要改设计期文本只能在编辑器里改。

- **`buyAmount` 的求值归一化**（PRD 生成器 8 / 升级 9 要求整数、默认 1、上限 100、0 最大、负数自动最大；该字段可被外部赋值，故必须定义归一化）：

  | 步骤 | 规则 | 违反时 |
  | --- | --- | --- |
  | ① 求值 | 按 `field` 上下文求值（[5.5](#55-上下文context与权限)）；求值抛错（`E_PARSE`/`E_UNKNOWN_ATTR`/last-good） | 记诊断，字段保持上次成功值（不写入） |
  | ② 有限性检查 | 结果必须是有限实数（拒绝 `NaN` 与 `±∞`，如 `ln(0)`、`0/0` 一类写法） | 报 `E_BUY_AMOUNT_INVALID`，保持上次成功值（不写入） |
  | ③ 取整 | `floor`（沿用 [4.4](#44-溢出下溢策略饱和语义) 第 5 条的超安全整数退化：超 `MAX_SAFE_INTEGER` 本身已是整数，原样返回） | — |
  | ④ 夹取 | `n ≥ 1` 时夹到 `100`（PRD 的 100 上限，`n = 0` 与 `n < 0` 两种语义无上限，不再夹取） | — |

  归一化后的值才参与 [8.6](#86-批量--最大--自动最大购买求解) 的模式判定；编辑器表单提交与打包前检查（[11.1](#111-构建管线)）对 `buyAmount` 用同一函数试算，非整数/非法值给出红框提示。
- **字符串属性写入**（`description`、`costs[i].materialId`、`produces[i].materialId`）：直接替换运行时值；`description` 变更需触发 UI 重渲染（PRD 要求名称/图标/描述修改立即同步到列表与预览）。
- **表达式文本写入**（`costs[i].amount`、`produces[i].amount`、`conditions[i]`、`effects[i].condition`/`action`）：赋值右侧**先求值**，再把结果的字符串形式作为**新文本整体替换**该字段（不回写右侧源码，D-29）：

  | 右侧结果类型 | 新文本 | 示例 |
  | --- | --- | --- |
  | 字符串 | 该字符串原样作为新表达式源码 | `gen.g1.produces[0].amount = "2"` → 新文本 `2`（单件 2/秒） |
  | 数值 | 该数值的十进制字面量文本（常量） | `gen.g1.produces[0].amount = 2 * gen.g1.owned` → 新文本 `10`（常量 10/秒） |
  | 布尔 / `null` | 报 `E_ASSIGN_TYPE`，保留旧文本 | — |

  随后走与编辑器改文本完全相同的热替换路径——编译（失败则报 `E_PARSE`/`E_RAND_DISABLED` 并保留旧文本，last-good）、更新 `deps`、递增字段版本、下一个 tick 生效。运行时文本**不进项目文件**，只进存档 `assignments`。
- **表达式文本无法在运行时拼接**：语言不提供字符串拼接与 `str()`，因此新文本只能是**常量源码字符串或数值字面量文本**。需要“随运行时状态变化的速率/价格”时，正确做法是赋一段引用运行时属性的常量源码，让它自己去读活跃状态：`set("gen.g1.produces[0].amount", "1.5 * res.r1.amount / 1000")`（新文本本身是常量，但它在运行时读取活跃状态，因此速率仍随游戏进程变化）；只有当需要按条件动态拼出**结构不同**的表达式时才无能为力，此时拆成多条效果、各自用互斥的 `condition` 分别赋值（见 8.7 的多条效果语义）。
- **“可做 / 不可做”对照**（作者引导，避免把 D-29 的赋值语义误当作字符串拼接；编辑器 `NumExprField` 与表达式文本字段旁直接引用本表）：

  | 意图 | ✅ 可以这样写 | ❌ 不能这样写（原因） |
  | --- | --- | --- |
  | 把表达式文本换成常量 | `set("gen.g1.produces[0].amount", "2")` | `gen.g1.produces[0].amount = "2" + gen.g1.owned` —— `+` 不做字符串拼接、语言无 `str()`，字符串参与算术报 `E_TYPE`（[5.2](#52-语法)、[17.1](#171-错误码表)） |
  | 让表达式随运行时状态变化 | 新文本写成**引用活跃属性**的常量源码：`set("gen.g1.produces[0].amount", "1.5 * res.r1.amount / 1000")`，它在求值时自己读状态 | 指望“赋一段源码、源码再被赋值”形成自指——写入的是**结果文本**、不回写源码（D-29） |
  | 按条件切换表达式结构 | 拆成多条效果，各用互斥 `condition` 分别 `set(...)`（[8.7](#87-升级效果与动态条目)） | 在一条 `action` 里拼出不同结构的源码——单表达式、无语句、无 `;`、无循环（[5.2](#52-语法)、[13](#13-安全与沙箱)） |
  | 改变数值大小 | `gen.g1.initial = 100`、`up.u1.effectValues[0] = 1.5 * gen.g1.owned` | 期望数值字段“赋值即回写表达式、从而持续自动求值”——`NumExpr` 数值字段与表达式文本属性同规则，写入的是常量文本（[5.9.3](#593-读写实现约定) 上文） |
- **`effectValues[i]` 写入**：三条等价路径——`action` 内对局部变量 `effValue` 赋值、`up.<id>.effectValues[i] = x`、`set("up.<id>.effectValues[i]", x)`。升级“每秒生效”或购买结算重算某条效果时，该效果的动作会把 `effValue` 覆写为本次计算结果（PRD 升级编辑器 11/12）。
- **越界与下标**：`costs[i]`/`produces[i]`/`conditions[i]`/`effects[i]` 的下标越界时读写分别报 `E_INDEX_OUT_OF_RANGE`（写）与 `E_UNKNOWN_ATTR`（读），不做隐式扩容；增删行是编辑器/动态创建的操作，不是赋值。
- **校验时机**：编辑器表单提交、打包前检查（见 [11.1](#111-构建管线)）各跑一次矩阵校验，发现把只读属性写进表达式的文本立即报 `E_READONLY_TARGET`。

## 6. 数据模型与文件格式
### 6.1 公共字段
按 PRD 的编辑器定义，字段分三级继承（资源无「是否禁用」，页面无「初始数量/数量上限」）：

```ts
interface VisualDef {   // 资源/生成器/升级/页面共有
  id: string            // 'r1' | 'g7' | 'u23' | 'p2'，项目内唯一，创建后不变（复制条目生成新 id）；命名约束见下方 D-45
  order: number         // 同类条目内升序，稳定排序（PRD 补充 5）
  name: string; description: string
  icon: IconRef
  visible: boolean      // 游戏可见
}
interface EntryDef extends VisualDef {   // 资源/生成器/升级
  initial: string       // NumExpr：字面量或表达式文本，支持科学计数法
  max: string           // NumExpr，必定大于零的硬上限；缺省/无上限写 "Infinity"（D-46、4.4 第 6 条）
}
interface ResourceDef extends EntryDef { kind: 'resource' }                       // 无 disabled
interface GeneratorDef extends EntryDef { /* disabled, buyAmount, costs, produces, isClicker, buyDelay */ }
interface UpgradeDef extends EntryDef { /* disabled, buyAmount, costs, conditions, perSecond, effects, buyDelay */ }
interface PageDef extends VisualDef { /* disabled, theme, columns, entries */ }
```
其中 `initial`、`max`、`buyAmount`、成本/产出/条件/效果的 `amount` 与文本均为**字符串字段**（`NumExpr` = 纯数字字面量或表达式源码），运行时统一按对应上下文求值；条目的 `id`、`order`、`name`、`icon`、`perSec`、`buyDelay` 以及页面的 `theme`/`columns`/`entries` 不可被表达式赋值（只读），其余字段是否可赋值以 [5.9 属性读写矩阵](#59-属性读写矩阵) 为准。

**条目 `id` 的命名约束（D-45）**：静态条目的 `id` 必须匹配 `ID_PATTERN = /^[rgup][A-Za-z0-9_]{0,31}$/`——首字符限定条目类型前缀（`r` 资源 / `g` 生成器 / `u` 升级 / `p` 页面），其余字符只允许字母、数字与下划线，总长 ≤ 32；**禁止以 `dyn` 开头**（该前缀保留给 `create()` 自动生成的动态条目，见 [8.7](#87-升级效果与动态条目)、D-44）。项目内所有静态 `id` 全局唯一（跨资源/生成器/升级/页面四类）。

| 项 | 规则 |
| --- | --- |
| 为什么必须约束 | 路径语法 `path = ("res"\|"gen"\|"up"\|"page") "." id "." attr`（[5.2](#52-语法)）依赖 `id` 能被词法分析成**单个标识符**。允许连字符/点号/空格/中文会让 `gen.my-gen.produces[0].amount` 被解析成减法、`gen.a.b.amount` 与属性路径混淆，`set()` 字面量路径解析（D-27）、复制、导出与 `create()` 冲突检查一并失真；`dyn_<序号>` 也可能与用户自取的静态 id 撞名，使 [8.7](#87-升级效果与动态条目) 的“不冲突”保证失效 |
| 单一事实源 | `ID_PATTERN`、`RESERVED_ID_PREFIXES = ['dyn']` 与动态 id 规则由 `packages/model` 的 `id.ts` 统一导出；Zod Schema、表达式路径解析器（`packages/expr`）、复制生成（[7.5](#75-条目列表交互规格)）、`create()` 冲突检查（[8.7](#87-升级效果与动态条目)）共用同一份常量，**不得各写一套正则** |
| 校验位置 | 新建/复制只生成合规 id（类型前缀 + 首个可用序号）；导入时不合规 id 报 `E_ID_INVALID` 并定位到条目路径，**不自动改 id**（[6.4](#64-校验与迁移)、[17.1](#171-错误码表)）；存档中动态条目沿用动态 id 规则，读档时非法或重复报 `E_CREATE_ID_CONFLICT` |
| 历史文件兼容 | 本约束是 V1.0 的 Schema 不变式；旧版本文件由迁移器在 `migrations` 中改写 id 并同步替换全部引用点（`costs[i].materialId`、`produces[i].materialId`、`PageDef.entries[].id`、存档 `assignments` 路径键），无法迁移按 `E_MIGRATION_FAIL` 进入只读兼容模式（[6.4](#64-校验与迁移)） |

`icon` 结构：
```ts
type IconRef = { kind: 'builtin'; value: string }        // 系统图标 id
            | { kind: 'data'; value: string }           // data:image/png;base64,...
            | { kind: 'asset'; value: string }          // 资产库 id，导出/打包时内联为 data
```
`theme`（页面主题、条目主题、编辑器主题）结构：`{ kind: 'builtin'; value: string } | { kind: 'data'; value: string /* CSS 文本 */ }`，自定义主题要求以 `:root{--iforge-*}` 变量声明，缺变量时回退默认令牌。

### 6.2 项目文件 Schema（`*.json`）
```ts
interface ProjectFile {
  format: 'incrementforge-project'
  version: 1                       // Schema 版本，用于迁移
  engineVersion: string            // 最后修改时记录的编辑器版本（PRD 设置页“引擎版本”）
  meta: {
    name: string; author: string; description: string
    createdAt: string              // ISO8601
    modifiedAt: string
  }
  settings: {
    numberFormat: 'standard' | 'scientific' | 'engineering' | 'letters' | 'layered'
    tickRate: number               // 逻辑帧率，默认 20
    maxFrameStep: number           // 单帧最大步长（ms），默认 250
    autosaveInterval: number       // 自动存档间隔（秒），默认 30
    offlineEnabled: boolean
    offlineCap: number             // 离线收益上限（小时），默认 8
  }
  resources: ResourceDef[]
  generators: GeneratorDef[]
  upgrades: UpgradeDef[]
  pages: PageDef[]
  assets: Record<string, { kind: 'icon' | 'theme'; mime: string; data: string }>  // 已内联的资产
}
```
`GeneratorDef` / `UpgradeDef` 的专有字段：
```ts
interface CostEntry { materialId: string; amount: string }   // amount 为 NumExpr
interface GeneratorDef extends EntryDef {
  kind: 'generator'
  buyAmount: string           // NumExpr，整数，>0 默认 1，≤100 为上限，0=最大，<0=自动最大
  costs: CostEntry[]          // 购买价格
  produces: CostEntry[]       // 产出资源（materialId 可指向资源或生成器）
  isClicker: boolean          // 是否点击器
  buyDelay: number            // 自动最大购买的间隔 tick 数（见 8.6）
}
interface EffectEntry { condition: string; action: string }   // 效果前提 / 效果内容（赋值表达式）
interface UpgradeDef extends EntryDef {
  kind: 'upgrade'
  buyAmount: string
  costs: CostEntry[]
  conditions: string[]         // AND 组合（PRD 补充 4）
  perSecond: boolean          // 每秒生效
  effects: EffectEntry[]      // 每条独立判断，独立效果数值
  buyDelay: number            // 自动最大购买的间隔 tick 数（PRD 升级 9「可隔 N tick 一次」，见 8.6）
}
interface PageDef extends VisualDef {
  kind: 'page'
  theme: ThemeRef
  columns: number              // 网格列数
  entries: Array<{ id: string; theme: ThemeRef; order: number }>  // 条目只能属于一个页面（PRD 补充 7）
}
```
> `entries` 中同时放资源/生成器/升级 id；编辑器的“排序/复制/删除”操作通过改 `order` 生效。动态条目不属于 `PageDef.entries` 静态数组，其归属记录在存档中。

### 6.3 存档文件 Schema（`*.save.json`）
```ts
interface SaveFile {
  format: 'incrementforge-save'
  version: 1
  engineVersion: string
  projectId: string; projectName: string
  slotId: string                // 存档位；V1.0 固定 'main'（单存档），字段先落地以预留多存档（PRD 补充 8、见 [15](#15-扩展框架预留)）
  savedAt: string; lastSeenAt: string
  playtime: number             // 秒
  gameTime: number             // 游戏内累计秒数（含离线）
  offlineAccum: number         // 已结算的离线收益秒数
  resources: Record<string, {
    amount: string; max: string; initial: string; visible: boolean; description: string   // 资源无 bought/disabled
    assignments: Record<string, Assignment>          // 值 + 表达式文本（PRD 补充 6）
  }>
  generators: Record<string, {
    bought: string; owned: string; max: string; initial: string
    visible: boolean; disabled: boolean; isClicker: boolean; buyAmount: string; buyDelay: number; description: string
    assignments: Record<string, Assignment>
  }>
  upgrades: Record<string, {
    bought: string; owned: string; max: string; initial: string
    visible: boolean; disabled: boolean; buyAmount: string; buyDelay: number; perSecond: boolean; description: string
    effectValues: Record<string, string>          // 每个效果独立持久化（PRD 升级编辑器 12）
    assignments: Record<string, Assignment>
  }>
  pages: Record<string, {
    visible: boolean; disabled: boolean; description: string   // 页面无 initial/max/bought
    assignments: Record<string, Assignment>      // 页面 description 的赋值审计（PRD 补充 6）
  }>
  dynamic: {                   // 动态条目（不写项目文件，仅存档）
    generators: Array<GeneratorDef & { createdAt: string; pageId: string }>
    upgrades: Array<UpgradeDef & { createdAt: string; pageId: string }>
  }
}
// 列表与表达式文本属性（costs/produces/conditions/effects）不进顶层字段，
// 其被赋值后的“当前文本”由 assignments 中对应路径的 value 承载，读档时按路径回填。
interface Assignment { value: string; expr: string; tick: number }
```

**`Assignment` 的 `value` / `expr` 语义**（消除数值属性与文本属性共用同一结构时的歧义）：键 `path` 本身已经编码了目标类型，**不需要额外的 `targetType` 字段**；`value` 与 `expr` 的含义按目标类型查下表：

| 目标类型 | `value` | `expr` | 读档回填方式 |
| --- | --- | --- | --- |
| 数值属性（`initial`/`max`/`buyAmount`/`amount`/`bought`/`owned`/`effectValues[i]`） | 求值结果的十进制字面量文本（已按 [5.9.3](#593-读写实现约定) 取整/夹取） | 赋值右侧的**源码文本**（仅审计用） | **以顶层字段为准**，本条不参与恢复 |
| 布尔属性（`visible`/`disabled`/`isClicker`/`perSecond`） | `"true"` / `"false"` | 右侧源码（仅审计用） | **以顶层字段为准** |
| 字符串属性（`description`） | 字符串内容 | 右侧源码（仅审计用） | 回填到顶层 `description` |
| 表达式文本属性与列表字段（`costs[i].amount`、`produces[i].materialId`/`.amount`、`conditions[i]`、`effects[i].condition`/`.action`） | **热替换后的当前文本**（唯一权威副本） | 右侧源码（仅审计用） | 按 `path` 回填为该字段的当前文本 |

`value` 一律是**字符串**（统一十进制序列化规则，见下）；`expr` 只读不解释，读档不回放（见下文“冲突裁决”）。

数值以**十进制字符串**序列化（`Decimal.toString()`），避免 JSON 精度丢失；读取用 `Decimal.fromString` 解析。`assignments` 记录“运行时被赋值过的属性”，同时保存最终值与表达式原文（PRD 补充 6：值和表达式文本都持久化）；`重新开始` 时整个 `assignments`、`effectValues`、`dynamic` 一并丢弃。

**四类实体的顶层字段集合**（上面 `SaveFile` 各记录类型的字段清单的权威副本，由 `docs:gen` 从 Zod Schema 生成）：

<!-- docs:gen:6.3.fields:start -->
<!-- 本块由 `pnpm docs:gen` 从 `packages/model` 的 Zod Schema 生成，请勿手改；
     它是 6.3 顶部那些 `SaveFile` 类型的字段清单的权威副本（R-33）。 -->
| 实体 | 顶层字段 |
| --- | --- |
| `resource` | `amount`、`max`、`initial`、`visible`、`description`、`assignments` |
| `generator` | `bought`、`owned`、`max`、`initial`、`visible`、`disabled`、`isClicker`、`buyAmount`、`buyDelay`、`description`、`assignments` |
| `upgrade` | `bought`、`owned`、`max`、`initial`、`visible`、`disabled`、`buyAmount`、`buyDelay`、`perSecond`、`description`、`effectValues`、`assignments` |
| `page` | `visible`、`disabled`、`description`、`assignments` |
<!-- docs:gen:6.3.fields:end -->

**顶层字段与 `assignments` 的分工**（避免双写来源歧义）：
- **顶层字段 = 当前生效值**。资源 `amount/max/initial/visible/description`（`res.<id>.owned` 是 `amount` 的别名，不产生独立字段）、生成器/升级的 `bought/owned/max/initial/visible/disabled/isClicker/buyAmount/buyDelay/perSecond/description`、页面 `visible/disabled/description` 以顶层字段为准，是这些属性的唯一权威副本。
- **顶层字段必须覆盖 [5.9.1](#591-条目属性)/[5.9.2](#592-页面属性) 中所有“存档位置含顶层”的可写属性**（含 `isClicker`），这是本 Schema 的完整性不变式：漏写一个字段（例如只把 `isClicker` 留在 `assignments` 里）就等于该属性的运行时赋值在读档后**静默丢失**——读档顺序 ③ 只按顶层字段回填，而布尔属性明确“不以 `assignments` 为准”。四类实体（`resources`/`generators`/`upgrades`/`pages`）都必须自带 `assignments` 容器，否则列表/文本属性与 `description` 无处落地。该不变式由 [14.3](#143-质量门禁) 的文档交叉校验脚本守护。
- **`assignments` = 赋值审计记录 + 列表/文本属性的取值载体**。`assignments[path] = { value, expr, tick }` 记录该属性最后一次被表达式赋值时的取值、表达式原文与 tick。其中 `costs[i].materialId/amount`、`produces[i].materialId/amount`、`conditions[i]`、`effects[i].condition/action` **只有 `assignments` 这一处持久化**，读档时按路径回填为该字段的当前文本（这是“值”的恢复，不是表达式回放）。
- **不回放表达式**：读档不重新执行 `assignments[path].expr`（回放会产生不可重复的副作用，`set/create/destroy` 无法保证幂等）。
- **冲突裁决**：若顶层字段与 `assignments[path].value` 冲突（存档被手改或旧版本格式差异），以**顶层字段**为权威并记诊断 `E_SAVE_FIELD_CONFLICT`；若 `assignments` 引用了已不存在的条目/属性，读档时丢弃该键。
- **读档顺序**：① 用项目文件构建静态 `AttributeStore`（静态默认值）→ ② 按 `dynamic` 重建动态条目定义到 `AttributeStore`（含其 `costs`/`produces`/`conditions`/`effects` 列表结构），并校验其 `pageId` 存在（不存在则该条目降级为“不显示”并记 `E_PAGE_UNKNOWN`，但**仍完整保留在存档中**、仍可被 `destroy(id)` 丢弃，完整口径见 [8.7](#87-升级效果与动态条目) 的“孤儿动态条目”）→ ③ 顶层字段逐项覆盖静态与动态条目的当前生效值（缺失项回落项目文件值，动态条目回落其 `spec` 默认值；**动态条目同样有 `generators[id]`/`upgrades[id]` 顶层记录**，`dynamic[]` 只额外承载列表结构、`id`、`createdAt` 与 `pageId`，静态与动态一视同仁）→ ④ 按 `assignments` 路径回填列表/文本字段与 `description` → ⑤ 恢复 `effectValues` → ⑥ 合并未知字段（进 `extra` 并在下次写回时保留）→ ⑦ 全部表达式重新编译（编译失败的字段：静态条目取项目文件文本，动态条目保留存档文本并记 `E_PARSE`）。
  - **必须先重建动态条目、再回填 `assignments`（第 ② 步先于第 ④ 步）**：动态条目的当前值与被赋值的列表/文本字段都只存在于存档。若顺序颠倒，①③ 阶段顶层 `generators[动态id]`/`upgrades[动态id]` 无处落地、④ 阶段指向动态条目的 `assignments` 键（`gen.dyn1.produces[0].amount` 等）会因目标条目尚不存在而被“丢弃不存在的属性”规则误删，造成动态条目的进度与赋值静默丢失。
- **游戏内设置不进入存档**：数字格式/帧率等属于 UI 偏好，不是条目属性，按 D-22 单独持久化；导出存档不携带它们。

### 6.4 校验与迁移
- 写入前用 Zod Schema 校验项目文件；非法字段报错并定位路径 `generators[3].costs[0].amount`。
- **跨条目一致性校验**（`superRefine`，不通过则阻断保存/打包）：
  - **条目页面唯一性**（PRD 补充 7）：所有静态条目 id 在全部 `PageDef.entries` 中合计最多出现一次，重复报 `E_DUPLICATE_PAGE_ENTRY`；
  - **引用完整性**：`PageDef.entries[].id` 必须存在于 `resources/generators/upgrades`；`costs[i].materialId`、`produces[i].materialId` 必须指向存在的资源或生成器（产出可指向生成器，购买材料只指向资源），悬空引用报 `E_DANGLING_REF`；
  - **`id` 命名规范**（D-45）：四类条目的 `id` 必须匹配 [6.1](#61-公共字段) 的 `ID_PATTERN`、不以 `dyn` 开头、且跨四类全局唯一；不合规报 `E_ID_INVALID` 并定位到具体条目路径（如 `generators[3].id`）。该校验与表达式路径解析同源，**不做“自动改 id”**——改 id 会连带 `costs/produces` 的 `materialId`、`PageDef.entries[].id` 与存档 `assignments` 路径键，静默改名比报错更危险（需要改名时由迁移器显式执行，见 [6.1](#61-公共字段) 的历史文件兼容条款）；
  - **表达式目标合法**：按 [5.9](#59-属性读写矩阵) 校验每条表达式的赋值目标与下标，写只读属性报 `E_READONLY_TARGET`，类型不匹配报 `E_ASSIGN_TYPE`；
  - **动态条目页面存在性**：`create()` 的 `page` 参数与存档中动态条目的 `pageId` 必须存在于 `pages`，否则报 `E_PAGE_UNKNOWN`（读档时降级为不显示，但**保留存档**、计入动态条目上限，处置口径见 [8.7](#87-升级效果与动态条目)）；`create()` 的 `spec` 键名走与项目文件同一份字段白名单（[5.2](#52-语法)），未知键报 `E_CREATE_FIELD_INVALID`；`spec.id` 给出时按 [8.7](#87-升级效果与动态条目) 校验前缀/长度/全局唯一性，冲突报 `E_CREATE_ID_CONFLICT`（读档时若存档中动态条目 `id` 重复，以先出现者保留、其余丢弃并记 `E_CREATE_ID_CONFLICT`）；
  - `max` 表达式结果 ≤ 0 时不阻断保存，运行期按 1 处理并记 `E_CAP_NON_POSITIVE`。
- 打包时额外用 JSON Schema 生成产物内嵌校验数据，游戏加载时先校验再运行（防止用户手改存档导致崩溃）。
- 迁移器 `migrations[from: number]: (file) => file`，按 `version` 逐级执行；无法迁移时进入“兼容模式”：只读打开并提示导出原始文件，错误码 `E_MIGRATION_FAIL`。
- 未知字段一律保留在 `extra` 中并回写（向前兼容，避免新引擎字段被旧编辑器丢弃）。

### 6.5 PRD 字段映射总表
PRD“页面说明与交互细节”按工作区逐条列出了条目字段，本节把它们一对一映射到 Schema 字段、表达式路径与读写权限。它与 [5.9 属性读写矩阵](#59-属性读写矩阵)互为索引：**本节按 PRD 排版，5.9 按表达式路径排版**，两者内容必须一致；编辑器表单实现、表达式静态校验、打包前检查（[11.1](#111-构建管线)）三处都以本节为对照。

约定：类型缩写 `S` = 字符串（`NumExpr` 或普通文本）、`N` = 数值、`B` = 布尔、`L` = 列表、`R` = `IconRef` / `ThemeRef`；“可赋值”列即 [5.9.1](#591-条目属性) 的可写性（仅 `effect` 上下文，`E_*` 校验）；“列表操作”（添加/排序/复制/删除）统一按 [7.5](#75-条目列表交互规格) 实现，四类工作区行为一致。

#### 6.5.1 资源（PRD 资源编辑器 1–6）
| # | PRD 字段 | Schema 字段 | 类型 | 表达式路径（读 / 写） | 可赋值 | 运行时要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 图标 | `resources[].icon` | `R` | `res.<id>.icon` / — | ❌ | 内置图标或上传，上传走 [13](#13-安全与沙箱) 过滤；改后立即同步列表与预览 |
| 2 | 名称 | `resources[].name` | 文本 | `res.<id>.name` / — | ❌ | 改后立即同步左侧列表与预览（PRD 资源编辑器 2） |
| 3 | 描述 | `resources[].description` | 文本 | `res.<id>.description` | ✅ | 持久化到顶层 + `assignments`（补充 6） |
| 4 | 初始数量 | `resources[].initial` | `S` | `res.<id>.initial` | ✅ | 支持科学计数法与常量表达式；`amount` 初始化为其值（[8.5](#85-购买结算)） |
| 5 | 数量上限 | `resources[].max` | `S` | `res.<id>.max` | ✅ | 硬上限，≤ 0 按 1 并记 `E_CAP_NON_POSITIVE`（[4.4](#44-溢出下溢策略饱和语义)） |
| 6 | 游戏可见 | `resources[].visible` | `B` | `res.<id>.visible` | ✅ | 为假时卡片不渲染，且不参与仪表盘统计 |
| — | （PRD 未列）数量 | `SaveFile.resources[id].amount` | `S` | `res.<id>.amount`、`res.<id>.owned`（别名） | ✅ | 资源无 `disabled`、无 `bought`（D-20、D-37） |

#### 6.5.2 生成器（PRD 生成器编辑器 1–11）
| # | PRD 字段 | Schema 字段 | 类型 | 表达式路径（读 / 写） | 可赋值 | 运行时要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 图标 | `generators[].icon` | `R` | `gen.<id>.icon` / — | ❌ | 同 6.5.1 第 1 行 |
| 2 | 名称 | `generators[].name` | 文本 | `gen.<id>.name` / — | ❌ | 改后立即同步 |
| 3 | 描述 | `generators[].description` | 文本 | `gen.<id>.description` | ✅ | 同 6.5.1 第 3 行 |
| 4 | 初始数量 | `generators[].initial` | `S` | `gen.<id>.initial` | ✅ | 计入“已购买数量”，影响价格（初始化表见 [8.5](#85-购买结算)） |
| 5 | 数量上限 | `generators[].max` | `S` | `gen.<id>.max` | ✅ | 硬上限，`owned` 达上限后不可购买 |
| 6 | 是否禁用 | `generators[].disabled` | `B` | `gen.<id>.disabled` | ✅ | 禁用时不产出、不生效（与页面 `disabled` 取或，[8.4](#84-可见性与禁用的有效状态页面继承)） |
| 7 | 游戏可见 | `generators[].visible` | `B` | `gen.<id>.visible` | ✅ | 不可见时不产出、不生效、不参与仪表盘 |
| 8 | 批量购买 | `generators[].buyAmount` | `S` | `gen.<id>.buyAmount` | ✅ | 归一化（求值→有限性→`floor`→`n≥1` 夹 100）后决定 `count`/`max`/`free` 模式（D-36、[5.9.3](#593-读写实现约定)） |
| 9 | 购买价格 | `generators[].costs[]` | `L` | `gen.<id>.costs[i].materialId` / `.amount` | ✅ | `amount` 是**单件**价格表达式，通常引用 `bought`；材料只能是资源 |
| 10 | 产出资源 | `generators[].produces[]` | `L` | `gen.<id>.produces[i].materialId` / `.amount` | ✅ | `amount` 是**单件产出速率**，总产出 = `owned × Σ`（D-30）；目标可为资源或生成器 |
| 11 | 是否点击器 | `generators[].isClicker` | `B` | `gen.<id>.isClicker` | ✅ | 切换语义见 [8.4](#84-可见性与禁用的有效状态页面继承)；不可购买为运行时硬约束（D-28）；运行时赋值持久化在存档顶层字段 `SaveFile.generators[id].isClicker`（[6.3](#63-存档文件-schemasavejson)） |
| — | （实现细节）购买间隔 | `generators[].buyDelay` | `N` | `gen.<id>.buyDelay` / — | ❌ | 自动最大购买每隔 N tick 尝试一次（D-04） |

#### 6.5.3 升级（PRD 升级编辑器 1–12）
| # | PRD 字段 | Schema 字段 | 类型 | 表达式路径（读 / 写） | 可赋值 | 运行时要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 图标 | `upgrades[].icon` | `R` | `up.<id>.icon` / — | ❌ | 同 6.5.1 第 1 行 |
| 2 | 名称 | `upgrades[].name` | 文本 | `up.<id>.name` / — | ❌ | 改后立即同步 |
| 3 | 描述 | `upgrades[].description` | 文本 | `up.<id>.description` | ✅ | 同 6.5.1 第 3 行 |
| 4 | 初始数量 | `upgrades[].initial` | `S` | `up.<id>.initial` | ✅ | 计入“已购买数量”，影响价格 |
| 5 | 数量上限 | `upgrades[].max` | `S` | `up.<id>.max` | ✅ | 硬上限 |
| 6 | 是否禁用 | `upgrades[].disabled` | `B` | `up.<id>.disabled` | ✅ | 禁用时不购买、不生效 |
| 7 | 游戏可见 | `upgrades[].visible` | `B` | `up.<id>.visible` | ✅ | 不可见时不购买、不生效 |
| 8 | 购买条件 | `upgrades[].conditions[]` | `L`（表达式文本） | `up.<id>.conditions[i]` | ✅ | 列表整体 **AND**（补充 4）；需 OR 由用户在表达式内自行实现；默认 `true` |
| 9 | 批量购买 | `upgrades[].buyAmount` | `S` | `up.<id>.buyAmount` | ✅ | 同 6.5.2 第 8 行；批量只结算**最后一级**效果（D-06） |
| 10 | 购买价格 | `upgrades[].costs[]` | `L` | `up.<id>.costs[i].materialId` / `.amount` | ✅ | 同 6.5.2 第 9 行 |
| 11 | 每秒生效 | `upgrades[].perSecond` | `B` | `up.<id>.perSecond` | ✅ | 按 `gameTime` 每游戏秒触发一次、**重算不叠加**、离线不触发（PRD 补充 5、D-35） |
| 12 | 升级效果 | `upgrades[].effects[]` + `effectValues[]` | `L` + `L` | `up.<id>.effects[i].condition` / `.action`、`up.<id>.effectValues[i]`（局部别名 `effValue`） | ✅ | 每条效果独立判断、独立数值、全部满足前提者**都**生效不短路（D-23）；动作文本只能整体替换（D-29） |
| — | （实现细节）购买间隔 | `upgrades[].buyDelay` | `N` | `up.<id>.buyDelay` / — | ❌ | 自动最大购买每隔 N tick 尝试一次（PRD 升级 9“隔 N tick 一次”、D-04） |

#### 6.5.4 页面（PRD 页面编辑器 1–8）
| # | PRD 字段 | Schema 字段 | 类型 | 表达式路径（读 / 写） | 可赋值 | 运行时要点 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 图标 | `pages[].icon` | `R` | `page.<id>.icon` / — | ❌ | 用于底部导航按钮（PRD 预览区 8） |
| 2 | 名称 | `pages[].name` | 文本 | `page.<id>.name` / — | ❌ | 改后立即同步列表、导航与预览 |
| 3 | 描述 | `pages[].description` | 文本 | `page.<id>.description` | ✅ | 页面描述区渲染（PRD 预览区 7） |
| 4 | 是否禁用 | `pages[].disabled` | `B` | `page.<id>.disabled` | ✅ | 其下生成器/升级不可购买、产出、生效；**仍可跳转**；资源卡片不置灰（[8.4](#84-可见性与禁用的有效状态页面继承)） |
| 5 | 游戏可见 | `pages[].visible` | `B` | `page.<id>.visible` | ✅ | 其下**所有**条目（含资源）不可见，不渲染导航按钮但仍可 `nav()` 直达 |
| 6 | 页面主题 | `pages[].theme` | `ThemeRef` | `page.<id>.theme` / — | ❌ | 内置或上传 CSS 文本；缺 `--iforge-page-*` 令牌回退默认（D-13） |
| 7 | 页面布局 | `pages[].columns` | `N` | `page.<id>.columns` / — | ❌ | 网格列数；实际列数 = `min(columns, 设备断点列数)`（[9.1](#91-沙箱模型)） |
| 8 | 页面条目 | `pages[].entries[]` | `L`（`{ id, theme, order }`） | `page.<id>.entries[i]` / — | ❌ | 条目只能属于一个页面（补充 7）；`order` 决定排列布局；`theme` 缺省跟随页面主题 |

#### 6.5.5 设置页面（PRD 设置页面 1–6）
| # | PRD 字段 | 存储位置 | 类型 | 可赋值/可改 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | 编辑器主题 | `settingsStore`（编辑器偏好） | `ThemeRef` | ✅ 可改 | 不进项目文件；只影响编辑器与预览容器 |
| 2 | 项目名称 | `ProjectFile.meta.name` | 文本 | ✅ 可改 | 改后立即同步顶部标题栏与预览标题（PRD 设置页 2） |
| 3 | 项目作者 | `ProjectFile.meta.author` | 文本 | ✅ 可改 | — |
| 4 | 项目描述 | `ProjectFile.meta.description` | 文本 | ✅ 可改 | — |
| 5 | 创建时间 / 最后修改 / 引擎版本 / 当前引擎 | `meta.createdAt` / `meta.modifiedAt` / `ProjectFile.engineVersion` / 构建期常量 `ENGINE_VERSION` | 文本 | ❌ 只读 | “引擎版本”在每次保存时写入；“当前引擎”为编辑器自身版本（PRD 设置页 5） |
| 6 | 游戏默认设置 | `ProjectFile.settings`（`numberFormat`/`tickRate`/`maxFrameStep`/`autosaveInterval`/`offlineEnabled`/`offlineCap`） | `S`/`N`/`B` | ✅ 可改 | 项目级默认；游戏内修改只产生**会话覆盖**（D-22、[8.10](#810-游戏内设置页与存档操作prd-预览区-9)） |

## 7. 编辑器架构与界面交互
本节描述编辑器自身：**布局骨架**（PRD 工作页面一览 + 预览区模拟设置栏，7.1）、**列表交互**（添加/排序/复制/删除，7.5）、**工作区表单**（四类条目 + 设置页，7.6/7.7）、**主题与图标**（7.8）、**状态与事务**（7.2/7.3/7.4）、**项目生命周期**（7.9）。编辑器只做“编辑与预览”，游戏逻辑一律由 [8. 运行时](#8-运行时与游戏循环) 提供，二者通过共享核心包 + postMessage 保持一致（ADR-03）。

### 7.1 界面总体布局（PRD 工作页面一览）
PRD 把编辑器工作面划分为四个分区，实现时一一对应到 `apps/editor/src/app/` 下的四个壳组件：

| 分区 | PRD 规定的内容 | 组件 | 实现要点 |
| --- | --- | --- | --- |
| 顶部标题栏 | 左侧：应用图标 + 产品标题；中间：项目名称；右侧：新建、保存、导入、导出、撤销/重做、打包 | `TitleBar` | 应用图标用内置 SVG（[17.4](#174-内置图标与主题清单)）；项目名称显示 `meta.name`，与设置页共用同一字段（[6.5.5](#655-设置页面prd-设置页面-16)）。“新建/保存/导入/导出”走 [7.9](#79-项目生命周期新建保存导入导出)；撤销/重做按钮按 `historyStore` 可用性置灰并显示快捷键提示（键位见本节末尾的全局快捷键表）；“打包”仅在 `game:ready` 后启用（[9.3](#93-生命周期)）；有未保存改动时在项目名后显示圆点标记 |
| 左侧功能区 | 自上而下依次：资源、生成器、升级、页面、设置 | `SideNav` | 当前功能区写入 `editorStore.activeSection`，**不进历史栈**（D-14）；切换只换中间工作区内容，不触碰项目数据与预览；窄屏折叠为图标栏 |
| 中间工作区 | 内容随当前功能区变化 | `Workspace` | 由 `features/<section>` 按 [7.6](#76-工作区实现要点) 装配；切换功能区时未提交的文本按 400ms 合并窗口提交为一次事务（[7.3](#73-撤销重做)），不丢输入 |
| 右侧预览区 | 游戏预览内容，可模拟与交互 | `PreviewPane` | 由“顶部模拟设置栏 + 游戏视图 + 诊断角标”三块组成；面板宽度可拖拽，宽度与折叠状态属 UI 偏好，不进历史；卸载项目时销毁 iframe 释放 tick（[9.3](#93-生命周期)） |

**顶部模拟设置栏（PRD 预览区顶部，明确“不属于游戏内容”）**：

| 位置 | 控件 | 行为 | 协议/决策 |
| --- | --- | --- | --- |
| 左侧 | 手机 / 平板 / 自适应（三选一） | 只改预览容器宽度与 `pointer: coarse`，不改页面 `columns` 定义；实际列数 = `min(columns, 断点列数)` | `host:control{action:'device'}`、D-41、[9.1](#91-沙箱模型) |
| 中间 | 暂停 / 继续 / 重新开始（三个图标按钮） | 暂停只停 tick 推进、保留渲染；重新开始 = `GameState.reset()`（二次确认） | `host:control{action:'pause'/'resume'/'restart'}`、[8.10](#810-游戏内设置页与存档操作prd-预览区-9) |
| 右侧 | 时间倍速下拉框 | `1× / 2× / 5× / 10×`，只加速在线 tick 推进 | D-31、[8.2](#82-主循环请求动画帧驱动) |
| 右侧 | “解锁全部”按钮 | 一次性把全部页面/条目的 `visible` 置真、`disabled` 置假；后续仍可被表达式覆盖 | D-16、[8.4](#84-可见性与禁用的有效状态页面继承) |

- 该栏属于**编辑器外壳**，不进入打包产物（D-42）；打包版只含游戏视图，暂停/倍速/解锁全部等调试能力不随成品发布。
- “重新开始”按 `GameState.reset()` 语义执行（复位属性、丢弃 `assignments`/`effectValues`/`dynamic`、重置 `gameTime`/`playtime`，PRD 补充 6），并把当前页面复位到 [8.12](#812-页面导航与当前页面prd-预览区-8) 的初始页面。
- 暂停期间：tick、`每秒生效`、自动购买、离线结算都不推进；DOM 仍按需重绘，保证静态状态正确。
- 诊断面板挂在预览区右下角，点击入口展开，它**不只在出错时可见**：`E_BUDGET`、饱和标记、降级建议等需要时弹出（[8.8](#88-离线模拟)、[9.3](#93-生命周期)）。**0 错误时入口也保留**（不带计数），因为 [12](#12-性能预算与优化) 要求诊断面板**常驻**显示 tick 耗时、求值次数、缓存命中率、格式化次数——若入口只在出错时出现，“一切正常但很慢”的场景就永远看不到那四个数字。面板内含：① 错误明细列表（错误码 + 位置 + 次数）；② 孤儿动态条目的**唯一**处置入口：`E_PAGE_UNKNOWN` 的动态条目（页面被删除）卡片不渲染、拿不到“丢弃”按钮，只在此处列出并提供“丢弃”（走 `host:control{action:'discard'}`，条目住在运行时里，只删宿主这份列表会让卡片下次重建又出现），其存储/恢复规则见 [8.7](#87-升级效果与动态条目)；③ 降级建议条目（[8.6](#86-批量--最大--自动最大购买求解) 末条）；④ 12 的四项性能采样与 `E_BUDGET` 标记；⑤ 最近一次打包的产物名、体积与指纹（[11.2](#112-体积与优化)）。打包产物不含该面板（D-42）。

**全局快捷键**（PRD 顶部标题栏要求撤销/重做为图标按钮并提供提示，此处固定 V1.0 的键位与作用范围）：

| 快捷键 | 作用 | 作用范围 |
| --- | --- | --- |
| `Ctrl+S` | 保存项目（拦截浏览器默认保存） | 编辑器全局 |
| `Ctrl+Z` / `Ctrl+Shift+Z`、`Ctrl+Y` | 撤销 / 重做 | 编辑器全局（仅项目数据，[7.3](#73-撤销重做)） |
| `Ctrl+O` / `Ctrl+E` | 导入项目 / 导出项目 | 编辑器全局（[7.9](#79-项目生命周期新建保存导入导出)） |
| `Ctrl+P` | 打包（仅 `game:ready` 后可用） | 编辑器全局（[9.3](#93-生命周期)） |
| `↑` / `↓` | 列表选中上/下一行 | 四类左侧列表（[7.5](#75-条目列表交互规格)） |
| `Alt+↑` / `Alt+↓` | 条目上移 / 下移（改 `order`） | 四类左侧列表、页面内条目网格 |
| `Ctrl+D` / `Delete` | 复制 / 删除选中条目 | 四类左侧列表 |
| `Space` | 暂停 / 继续预览 | 预览区容器聚焦时（模拟设置栏，**不进入打包产物**，D-42） |
| `Esc` | 关闭当前对话框 / 取消拖拽 | 编辑器全局 |

- 键位文案走 `t()`（PRD 补充 9），按钮同时提供 `aria-keyshortcuts`；游戏视图运行在 iframe 内，其键盘事件不冒泡到编辑器，因此预览区快捷键仅在容器获得焦点时生效。
- 快捷键与 [7.3](#73-撤销重做) 的事务合并窗口共用同一入口：快捷键触发的保存/撤销/重做与按钮点击走同一条 store 事务，不存在旁路实现。

**可访问性基线**（PRD 未要求，但编辑器与预览区已实现键盘可达，故一并固定为实现要求）：① 列表行、表单控件、对话框与预览卡片全部可键盘操作，`Tab` 顺序与视觉顺序一致；② 表达式字段的校验错误用 `aria-invalid` + `aria-describedby` 关联悬浮错误文案，不只用颜色传达；③ 对话框打开时焦点移入并锁定在其中（焦点陷阱），关闭后归还触发元素；④ 所有纯图标按钮有 `aria-label`（文案走 `t()`，PRD 补充 9）；⑤ 焦点环使用主题令牌 `--iforge-focus`，不得被自定义主题抹除。

### 7.2 状态管理
| Store | 内容 | 说明 |
| --- | --- | --- |
| `projectStore` | 项目文件全量（Zustand + immer） | 唯一事实源；所有写入走 `mutate(draft => ...)` 事务 |
| `historyStore` | 撤销/重做栈（immer patches） | 事务提交时自动记录 |
| `editorStore` | 当前功能区、选中条目 id、列表滚动、对话框、拖拽态 | 不进历史 |
| `previewStore` | 连接状态、暂停/倍速/解锁全部、当前会话的游戏设置覆盖、统计快照、诊断角标 | 与 iframe 通信的镜像（设置覆盖不进历史、不写项目文件，见 [8.10](#810-游戏内设置页与存档操作prd-预览区-9)） |
| `settingsStore` | 编辑器偏好（主题、面板宽度、最近项目路径） | 与项目 `settings` 分离 |

### 7.3 撤销/重做
- 事务粒度：一次用户操作 = 一个事务。文本输入类操作按 `(entityId, field)` 在 400ms 窗口内合并为一次撤销；排序、删除、复制、批量表达式编辑各自为独立事务。
- 栈容量 200 条；超出丢弃最旧。跨项目切换时清空。
- 与预览同步：撤销后把反向 patches 发送到影子运行时/预览，使预览状态与编辑器一致（PRD：撤销/重做图标位于顶部标题栏，[7.1](#71-界面总体布局prd-工作页面一览)）。

### 7.4 同步到预览
- 编辑器变更 → `projectStore` 订阅 → 序列化 diff（条目级 patch：`upsert` / `remove` / `settings` / `meta`）→ postMessage `host:patch` → 运行时热更新。
- 名称/图标修改立即同步左侧列表与预览（PRD 明确要求）；表达式字段修改标记对应节点为脏，下一 tick 生效。
- 运行时反向通道：动态条目创建事件上报编辑器仅用于诊断（编辑器 UI 不显示动态条目，符合 PRD 升级编辑器 12）。

**热更新的逐字段仲裁规则**（`host:patch` 与 `host:init` 的唯一区别就在这里：前者必须**保留本局进度**）：

| 字段类别 | 仲裁 | 为什么 |
| --- | --- | --- |
| 运行态数值（`EntryState.values` 中的全部：`amount` / `bought` / `owned`、升级 `effectValues[i]`、`perSecond`、`costs[i].amount`…） | **无条件保留** | 作者在编辑器里改一个名字/图标，不该清空预览者已经攒下的进度（这是 `host:patch` 与 `host:init` 的分界）。`initial` / `max` 例外：它们只读、不进 `values`，改结构后**按项目新值**生效 |
| 求值缓存与脏标记（`lastGood`、每属性的 `version`） | 与数值一起保留 | 否则表达式缓存与 [5.7](#57-求值调度与性能) 的脏标记会与新文本错位，把一次热替换变成隐性 stale |
| 标量（`visible` / `disabled` / `description` / `buyDelay`） | **看是否被运行期赋值过**：未赋值 → 取 patch 的新值；已赋值 → 保留运行态值 | `visible`/`disabled` 可以被表达式改（D-26），但作者在编辑器里改它就是明确要改它 |
| 表达式文本（`costs[i].amount`、`produces[i].amount`、`conditions[i]`、`effects[i].condition/action`、`buyAmount`…） | **同样按 `assignments` 的键逐个仲裁** | 运行时的 `set()` 是玩家的操作，作者改文本不该抹掉它（D-29 明确 `set()` 是唯一入口）；未赋值时热替换必须立刻生效（PRD 升级编辑器 12 的“表达式热替换”，见 [14.2](#142-关键用例清单抽样) 的同名用例） |
| `remove` | 移除该条目的定义、`PageDef.entries` 里的归属与运行态；**保留**指向它的 `costs[i].materialId` / `produces[i].materialId` 文本并记 `E_DANGLING_REF`；若删掉的是当前页面则回到 [8.12](#812-页面导航与当前页面prd-预览区-8) 的初始页面 | 不做级联（D-38）：静默改写引用会让作者的表达式无声变形；悬空引用交给保存/打包时的 `E_DANGLING_REF` 阻断 |
| `meta` | 整体替换 | 纯设计期数据 |
| `settings` | 整体替换**项目默认值**，但**不**清会话覆盖 | 会话覆盖是玩家在本会话的选择（D-22），作者改默认值不应抹掉它 |

- 仲裁在 `@iforge/runtime` 的 `patch.ts`（`diffProject` / `applyProjectPatch`）里实现：编辑器只负责**算 diff**（`diffProject`，逐条 `JSON.stringify` 指纹比对），运行时只负责**按上表应用**（`applyProjectPatch`）。两端各写一份仲裁规则，等价于两套“保留进度”的定义。
- **补丁为空时不发消息**：`diffProject` 返回空数组时宿主直接跳过 `host:patch`，避免一次“内容没变”的往返让运行时做无谓的全量比较。

### 7.5 条目列表交互规格
PRD 对四类工作区（资源、生成器、升级、页面）的左侧列表给出统一结构：**顶部栏左侧为列表标题（“资源列表 / 生成器列表 / 升级列表 / 页面列表”），右侧为“添加”按钮；条目行左侧图标、中间名称、右侧为“排序、复制、删除”三个图标按钮**。实现上四类列表共用同一套 `EntryList` 组件，仅标题文案与“添加”后的默认字段不同。

| 区域 | 规格 |
| --- | --- |
| 列表标题栏 | 左侧固定标题文案；右侧“添加”按钮。PRD 未要求搜索/过滤/分组，V1.0 不实现（避免超出需求范围） |
| 条目行 | 左 `icon`、中 `name`、右“排序（上移/下移）· 复制 · 删除”三图标按钮；选中行高亮，与中间工作区表单双向绑定（改名称 → 列表立即同步，PRD 各编辑器第 2 条） |
| 排序 | 上移/下移（或拖拽）改 `order`，并把同类条目的 `order` 重排为 `1..N` 连续整数，避免长期存在重复 `order`（保证 PRD 补充 5 的稳定排序，D-40）；页面内**条目**排序只改 `PageDef.entries[i].order`，不改动条目自身的 `order` |
| 复制 | 生成新 `id`（`r/g/u/p` 前缀 + 递增序号）、`order` 插入源条目之后并重排、其余字段逐字复制；**页面复制不复制 `entries`**（一个条目只能属于一个页面，PRD 补充 7），新页面条目为空并在结果提示中说明；复制的资源/生成器/升级不自动加入页面（D-39） |
| 删除 | 二次确认并列出受影响引用（见下表）；确认后从列表、`PageDef.entries` 与预览中移除，同一事务内完成（D-38） |
| 键盘可达 | `↑/↓` 选行、`Alt+↑/Alt+↓` 排序、`Ctrl+D` 复制、`Delete` 删除，与 `DragList` 行为一致；键位总表见 [7.1](#71-界面总体布局prd-工作页面一览) |
| 运行时联动 | 任一列表操作都立即通过 `host:patch` 同步预览（[7.4](#74-同步到预览)）；删除静态条目时其存档侧记录随之失效，读档按 [6.3](#63-存档文件-schemasavejson) 丢弃悬空 `assignments` |

**删除时的引用处理**（PRD 只给出“删除”图标，未定义级联，故不做级联，D-38）：

| 被删对象被谁引用 | 处理 |
| --- | --- |
| `costs[i].materialId`（生成器/升级的购买价格） | 确认弹窗中列出“条目名 + 成本行号”；确认后删除该条目本身，引用方**保留原文本**，保存/打包时若仍悬空由 `E_DANGLING_REF` 阻断（[6.4](#64-校验与迁移)） |
| `produces[i].materialId`（产出目标） | 同上 |
| 页面 `entries[]`（条目已分配到页面） | 从该页面 `entries` 中移除该 `id`；页面因此变空是合法状态 |
| `create()` 的 `page` 参数指向被删页面 | 删除页面时报 `E_PAGE_UNKNOWN`；运行时该 `create` 降级为“不显示”并记诊断（[8.4](#84-可见性与禁用的有效状态页面继承)） |
| 动态条目 | 静态条目的删除**不影响**动态条目；动态条目只能由 `destroy(id)` 丢弃（[8.7](#87-升级效果与动态条目)） |

### 7.6 工作区实现要点
| 工作区 | 组件 | 要点 |
| --- | --- | --- |
| 资源 | `ResourceList` + `ResourceForm` | 数量上限强制 > 0；`initial` 支持科学计数法与表达式；游戏可见开关 |
| 生成器 | `GeneratorList` + `GeneratorForm` | 批量购买分段控件（1..100 / 0 最大 / 负数自动最大）；点击器开启时隐藏自动生产相关项并提示；成本/产出双列表编辑器（增删行、拖拽排序、引用选择器） |
| 升级 | `UpgradeList` + `UpgradeForm` | 条件列表 AND 语义提示；效果列表每条含“前提/内容/效果数值”三列；**“效果数值”列是只读展示、不是可编辑字段**（PRD 升级编辑器 12：“空白数字变量，默认为零，由用户自行赋值”）：显示影子运行时/预览中的 `effectValues[i]`（无运行态时显示 `0`），**不提供初始值输入框、不写入 `ProjectFile`**（[6.2](#62-项目文件-schemajson) 的 `UpgradeDef` 无 `effectValues` 字段）、不进撤销栈、不参与项目文件差异比对；其值只能由表达式赋值产生（`action` 内的 `effValue` 或 `up.<id>.effectValues[i]`，默认 `0`、运行时重算会覆写），持久化在存档（[6.3](#63-存档文件-schemasavejson)），“重新开始”后清零；**PRD 12 的“由用户自行赋值”在本设计中的落点是运行时表达式赋值**（`action` 内写 `effValue = …` 或 `up.<id>.effectValues[i] = …`），不是编辑器里的初始值输入框（D-47）——输入框会把它变成项目文件里的设计期常量，与 PRD 补充 6“被赋值的更改写入游戏存档、**不写入项目文件**”以及 PRD 12 原文“一般为对应效果表达式的计算结果”相冲突。为免作者找不到入口，“效果数值”列同时给出：当前运行时值、无运行态时 `0` 的占位说明、只读徽标（悬浮提示“数值在运行时由效果赋值产生，不存于项目文件”），以及两条**快捷插入模板**（`effValue = <表达式>` / `up.<id>.effectValues[i] = <表达式>`）一键写入对应效果的“效果内容”；“每秒生效”开关说明离线不触发、且只对已拥有（`owned > 0`）的升级触发（D-43）；条件/效果字段明确提示“赋值写入的是**常量结果文本**，要换表达式请在效果里用字符串字面量 `set(\"路径\", \"源码\")`”（D-29、5.9.3）。**只读徽标、无运行态时的 `0` 占位说明、两条快捷插入模板这三项是强制 UI 元素**，不可配置隐藏、不可按平台或分辨率条件移除，缺失即视为实现偏差（单测以 DOM 断言其存在，与 8.10 的设置来源徽标同级要求）；PRD 12 的“由用户自行赋值”即由这三条入口共同承担可发现性 |
| 页面 | `PageList` + `PageForm` + `EntryGridEditor` | 网格列数实时预览（`columns`）；条目从资源/生成器/升级“分配到页面”（一个条目仅一个页面，已分配者在原页面标记；重复分配在提交时报 `E_DUPLICATE_PAGE_ENTRY`）；条目在页面内的**排列布局**由 `entries[i].order` 承载，拖拽即改该字段（[7.5](#75-条目列表交互规格)）；“页面禁用/不可见影响全部条目”提示文案（PRD 页面编辑器 4/5），并**额外注明“禁用只让生成器/升级置灰，资源卡片不受影响；不可见才隐藏全部条目”**（对齐 [8.4](#84-可见性与禁用的有效状态页面继承) 的判定，避免玩家误判资源为何未变灰） |
| 设置 | `SettingsPage` | 见 [7.7](#77-设置页面实现要点)（单独成节，因为“游戏默认设置 / 会话覆盖 / 只读字段”的分层规则较复杂） |

通用控件：`NumExprField`（科学计数法输入 + 表达式切换 + 实时试算）、`IconPicker`（内置图标网格 + 上传 + 裁剪）、`ThemePicker`、`RefPicker`（条目引用搜索）、`BatchBuyEditor`、`DragList`。四类工作区的列表行（图标 + 名称 + 排序/复制/删除）由共用组件 `EntryList` 渲染，行为见 [7.5](#75-条目列表交互规格)，键位见 [7.1](#71-界面总体布局prd-工作页面一览) 的全局快捷键表。`NumExprField` 必须把“数值模式”与“表达式模式”做成**显式切换**，并在表达式模式下于字段旁显示“运行时赋值将写入求值后的常量文本（D-29）”提示，避免把 D-29 的语义当成热替换源码；表达式文本字段旁额外挂载 [5.9.3 的“可做/不可做”对照表](#593-读写实现约定)作为常驻提示（折叠可收起，但默认展开）。

### 7.7 设置页面实现要点
PRD 设置页面共 6 组字段，字段与存储的完整映射见 [6.5.5](#655-设置页面prd-设置页面-16)；本节补充交互与联动要求。

| PRD 字段组 | 控件 | 存储与联动 |
| --- | --- | --- |
| 编辑器主题 | `ThemePicker`（内置 + 上传 CSS） | 存 `settingsStore`（编辑器偏好，**不写项目文件**）；切换后写 `<html data-theme>` 并同步预览 iframe |
| 项目名称 / 作者 / 描述 | 文本框 / 文本域 | 写 `ProjectFile.meta.*`；项目名称改后**立即**同步顶部标题栏与预览标题（PRD 设置页 2、7.1） |
| 创建时间 / 最后修改 / 引擎版本 / 当前引擎 | 只读文本（不可手动输入） | `meta.createdAt` / `meta.modifiedAt` / `ProjectFile.engineVersion`（保存时写入）/ 构建期常量 `ENGINE_VERSION`；只读字段不产生历史记录 |
| 游戏默认设置 | 6 个控件：数字格式下拉、逻辑帧率、最大步长、存档间隔、离线收益开关、离线收益上限 | 写 `ProjectFile.settings` 并立即 `host:control{action:'settings'}` 热更新预览；每项旁显示来源徽标（“项目默认” / “本会话覆盖”）并提供“恢复默认设置”（D-22） |

- **游戏默认设置的字段与默认值**：`numberFormat = standard`、`tickRate = 20`、`maxFrameStep = 250(ms)`、`autosaveInterval = 30(s)`、`offlineEnabled = true`、`offlineCap = 8(h)`（D-03）；打包前校验要求 `tickRate > 0`、`maxFrameStep > 0`、`autosaveInterval > 0`、`offlineCap ≥ 0`（[11.1](#111-构建管线)）。
- **与游戏内设置页的关系**：本节改的是“项目默认”，游戏内设置页改的是“当前会话覆盖”，二者分层不互相回写（D-22、[8.10](#810-游戏内设置页与存档操作prd-预览区-9)）。
- 全部文案走 `t()` key（PRD 补充 9），字段 label 与单位文案集中在 `packages/i18n/locales/zh-CN.json`。

### 7.8 主题、图标与国际化
- **令牌**：`--iforge-bg/-surface/-text/-accent/-danger/...`，自定义主题注入 `:root` 变量；页面主题与条目主题使用同一套令牌命名空间（`--iforge-page-*` / `--iforge-entry-*`）以便任意组合。
- **主题切换**写 `<html data-theme>`，运行时 iframe 同步该属性。
- **页面主题的三个注入点**：`AppView` 把 `--iforge-page-*` 内联到 `.game-root`（壳层与页面同色的前提，见 [8.11](#811-游戏视图与卡片字段映射prd-预览区-18)），并额外写到 `document.documentElement` 与 `document.body`。
  - `documentElement`：17.3 的模板给 `html` 写了背景，于是 `body` 的背景不再向画布传播，画布（超出 `body` 盒子的区域）由 `html` 决定；`html` 是根，往它身上写令牌是唯一能影响画布的办法。
  - `body`（`.iforge-game`）：`game.css` 里它的 `background` 读 `--iforge-page-bg`，而它**自己**声明了同名变量的缺省值（永远是暗色），从 `html` 继承来的同名令牌会被自己盖住；行内样式是同元素上优先级最高的，才压得住。

  少写任何一处都会留下一圈黑边：只写根节点时 `body` 读到自己的暗色缺省值（根节点 8px 内边距那一圈），只写 `body` 时画布仍是模板里的暗色（溢出壳层盒子的那段）。这两条正是“切换页面主题为白色后背景底色仍为黑色”的两个来源。
- **停在内置设置页时**生效主题取 [8.12](#812-页面导航与当前页面prd-预览区-8) 的**初始页面**主题（设置页没有 `PageDef.theme`，而它是壳层的一部分，必须与游戏同色）；视图若在缺省路径上回落到 `page-dark`，症状是“点进设置、整屏跳成暗色”。
- **内置资源**：编辑器主题 `dark`/`light`/`midnight`，页面主题与条目主题各 `page-*`/`entry-*` 三档；条目主题缺省跟随页面主题（PRD 页面编辑器 8“默认跟随契合页面主题的样式”），`create()` 未指定 `theme` 时同样跟随。完整清单见 [17.4](#174-内置图标与主题清单)。
- **内置图标**：按资源/生成器/点击器/升级/页面/系统六组维护 SVG path 集，`IconRef{ kind:'builtin' }` 引用；打包时 path 内联，不占体积（[11.2](#112-体积与优化)）。上传图标走 [13](#13-安全与沙箱) 第 4 条过滤与体积上限。
- **自定义主题**：只接受 CSS 文本，缺 `--iforge-*` 变量回退默认令牌（D-13）；安全过滤见 [13](#13-安全与沙箱) 第 5 条。
- **国际化**：所有 UI 文案走 `t('resource.initial')`，文案集中在 `packages/i18n/locales/zh-CN.json`；V1.0 只注册 `zh-CN`（PRD 补充 9）。

### 7.9 项目生命周期（新建、保存、导入、导出）
- **新建**（PRD 顶部标题栏“新建”）：当前项目有未保存改动或正在预览时弹确认；新建后写入默认模板：
  - `meta`：`name = "未命名项目"`、`author = ""`、`description = ""`、`createdAt = modifiedAt = now`；
  - 一个默认页面 `p1`（`name = "主页面"`、`visible = true`、`disabled = false`、`columns = 1`、`entries = []`）；游戏内“设置”页是**运行时内置页面**，不属于 `pages`，不参与条目分配与可见/禁用继承（PRD 预览区 8/9）；
  - `resources/generators/upgrades = []`、`assets = {}`；
  - `settings` 取默认值（见 [6.2](#62-项目文件-schemajson)），`engineVersion` 写入当前编辑器版本；
  - `projectId = crypto.randomUUID()`，`projectStore` 重建，清空 `historyStore`，重建影子运行时与预览（`host:init`），`previewStore` 复位；运行时按 [8.12](#812-页面导航与当前页面prd-预览区-8) 的初始页面规则选中 `p1`。V1.0 单项目管理，旧项目在新建前已落盘（见 [10.2](#102-导入--导出)）。
- **保存**：写入 IndexedDB `projects`（Zod 校验 → 跨条目一致性校验 → 事务写），更新 `modifiedAt` 与 `engineVersion`；预览中的运行时赋值不参与保存（PRD 补充 6）。
- **导入 / 导出**：统一走 [10.2](#102-导入--导出) 的同一条序列化路径，导出前跑一次完整校验。

## 8. 运行时与游戏循环
### 8.1 核心状态
```ts
class GameState {
  project: ProjectFile                 // 只读结构 + 可热更新
  settingsOverride: Partial<ProjectSettings>  // 会话覆盖：effective = project.settings ⊕ 本字段（D-22，见 8.10）
  attrs: AttributeStore                // 资源/生成器/升级/页面属性值（含运行时赋值）
  dynamic: DynamicRegistry             // 动态条目
  effects: EffectSink                  // 待提交副作用
  flags: { paused, speed, offline, started }
  stats: { playtime, lastTickAt, lastSaveAt, tick, realElapsed }  // realElapsed = 真实经过秒数（自动存档间隔用）
  gameTime: Decimal          // 游戏内累计秒数（倍速下加速），= 存档字段 gameTime，见 6.3
  offlineAccum: number       // 已结算的离线收益秒数（= 存档字段 offlineAccum，见 8.8）
  lastPerSecondAt: number    // 上次“每秒生效”触发时的 gameTime（秒），见 8.3 第 2 步
  currentPageId: string      // 当前所在页面；内置设置页用哨兵 '__settings__'，见 8.12
}
```
### 8.2 主循环（请求动画帧驱动）
> 本节与 [8.8](#88-离线模拟) 中的 `settings.*` 一律指 `project.settings ⊕ settingsOverride` 的**有效值**（[8.10](#810-游戏内设置页与存档操作prd-预览区-9)）；脏标记由 `AttributeStore` 的属性 `version` 承担（[5.7](#57-求值调度与性能)），不再单设 `dirtyTick` 标志。
```
frame(now):                                  // now = rAF 提供的真实墙钟时间戳
  if paused → 仅渲染，返回
  realDt   = min(now - lastFrameAt, settings.maxFrameStep)   // 单帧最大步长，防后台回来暴走
  acc     += realDt * flags.speed                             // 时间倍速
  step     = 1000 / settings.tickRate
  nPlan    = min(floor(acc / step), MAX_STEPS_PER_FRAME(=512))
  realShare = nPlan > 0 ? realDt / nPlan : realDt             // 本帧真实时间在各个 tick 间均摊
  for i in 1..nPlan:  stepTick(step, realShare); acc -= step
  if nPlan === MAX_STEPS_PER_FRAME: acc = min(acc, step)      // 丢弃积压，防死亡螺旋
  if nPlan === 0:  advanceRealTime(realDt)                   // 本帧没有任何 tick：真实时间仍要推进
  render()

stepTick(stepMs, realDtMs):                   // 每个逻辑帧都要执行的时间推进
  stats.tick += 1
  gameTime        += stepMs / 1000            // 游戏内时间：随倍速加速（表达式 time / dt / 升级“每秒生效”都以此为准）
  stats.realElapsed += realDtMs / 1000        // 真实时间：不随倍速放大（自动存档间隔、elapsed 用）
  执行 8.3 的 1~8 步
```
- **`nPlan === 0` 的那一帧不是“什么都没发生”**：`realElapsed` 只在 `stepTick` 里累加，因此一帧内没有任何 tick 时（默认 `tickRate = 20` 下 60fps 的帧约有 2/3 落在这一类）真实时间会被**整段丢掉**——最直接的后果是按真实秒数计的自动存档间隔（[8.3](#83-单-tick-顺序固定时序可预测) 第 8 步）实际按 3 倍时长触发。因此 `nPlan === 0` 时必须单独走一次 `advanceRealTime(realDt)`：只推进 `stats.realElapsed` 与 `stats.playtime`，**不动** `gameTime`（没有游戏内时间流逝）、不跑 8.3 的任何一步。速率采样（[8.9](#89-仪表盘数据)）等按 tick 计的过程同样只在一个 tick 结束时更新（[8.3](#83-单-tick-顺序固定时序可预测) 第 7 步），不补记。
- **两套时间基准必须分开**：`gameTime`（游戏内时间，随 `flags.speed` 放大，供 `time` 变量、升级“每秒生效”、产出推进使用）与 `stats.realElapsed`（真实时间，不放大，供自动存档间隔、`elapsed` 使用，PRD 预览区 9 的“存档间隔”与 D-31 保持“按真实秒数计”）。任何“每秒/每 N 秒”的周期性逻辑**一律以 `gameTime` 为准**，禁止使用 rAF 的 `now`，否则倍速下周期触发次数会与游戏内时间脱节（详见 8.3 第 2 步）。
- **时间倍速档位**（PRD 预览区顶部“时间倍速”下拉框，PRD 未规定取值，D-31）：`1× / 2× / 5× / 10×`。倍速**只加速在线 tick 推进**，不改变 `tickRate` 本身、不改变离线结算时长（离线按真实墙钟秒数）、不改变自动存档间隔（按真实秒数计）；倍速过高导致单帧步数触顶时，按 `MAX_STEPS_PER_FRAME` 丢弃积压并在 UI 提示。宿主通过 `host:control{action:'speed'}` 下发（见 [9.2](#92-消息协议)），运行时在 `game:stats` 回传当前倍速。

### 8.3 单 tick 顺序（固定时序，可预测）
1. **每 tick 归零缓存**：`tickCache.clear()`，刷新随机上下文（`rand` 使用 `tick` 派生的确定性伪随机源，保证同 tick 结果一致）。
2. **每秒触发阶段**：按**游戏内时间**判定——`if (gameTime >= lastPerSecondAt + 1)`，则触发一次并把 `lastPerSecondAt += floor(gameTime - lastPerSecondAt)`（跳过多余秒，保证单帧内跑多个 tick 时每游戏秒最多触发一次）。再按 `order` 稳定排序依次处理 `perSecond` 升级（PRD 补充 5）：只处理**有效可见、有效未禁用且已拥有**（`ownsUpgrade(e)`，即 `owned > 0`）的升级（见 [8.4](#84-可见性与禁用的有效状态页面继承) 与 D-43），逐条重新计算其效果表达式的“效果内容”，写入各自 `effectValues`。离线时跳过本阶段。
   - **判定基准必须是 `gameTime`（随倍速推进），不能是 rAF 的真实墙钟**：PRD 升级编辑器 11 只说“每秒触发一次”，未限定真实时间或游戏时间；而倍速（PRD 预览区顶部）只加速在线 tick 推进（[8.2](#82-主循环请求动画帧驱动)、D-31）。若按真实墙钟判定，`10×` 倍速下游戏内已过 10 秒却只触发 1 次，周期逻辑与产出速率、`time` 变量三者互相矛盾。统一为 `gameTime` 后：`10×` 下每真实秒触发 10 次、`time` 与实际产出同步，离线（按真实秒数结算但跳过本阶段）的差异由 PRD 设置页 9 的说明文案承担。
   - **`lastPerSecondAt` 的持久化**：它由 `gameTime` 单调推导，读档时用存档 `gameTime` 重新初始化为 `floor(gameTime)` 即可，不单独存档。
3. **产出结算**：对每个**有效可见、有效未禁用、非点击器**的生成器（判定含所属页面）。`produces[i].amount` 是**单件产出速率**，本步增量为 `owned × Σ produces[i].amount`（**只乘一次 `owned`**，D-30）；产出目标可以是资源（加该增量并受 `max` 约束）也可以是其它生成器（加该增量到 `owned` 并受其 `max` 约束，不影响价格）。
4. **点击器**：不参与自动产出；点击事件即时结算一次产出，受 `initial`（初始即拥有数量）与 `max` 约束；不可见/禁用（含页面）时按钮不渲染且点击事件被拒绝。
5. **自动购买**：`buyAmount < 0` 的生成器/升级在有效可见、有效未禁用且满足间隔 `buyDelay`（默认 N=1 tick，可配置为 N tick 一次）时执行“自动最大购买”（见 [8.6](#86-批量--最大--自动最大购买求解)）。**点击器一律跳过**（`isClicker` 生成器不可购买，否则“免费自动最大购买”会把它当免费产出来白嫖，见 8.5 的 `E_CLICKER_NOT_BUYABLE`）。离线时不触发。
6. **副作用提交**：把 `EffectSink` 中本 tick 收集的 `set/create/destroy` 按顺序应用（`destroy` 先于 `create`；队列中可能还含**上一次** tick 之后由交互事件收集的副作用，处理规则见 [8.3.1](#831-交互事件与-tick-边界)）。
7. **统计与快照**：更新仪表盘所需的增长率与“下一个可购买条目预测时间”。
8. **自动存档**：累计 `stats.realElapsed` 达到 `autosaveInterval` 秒后写存档（**按真实秒数计**，不随倍速加速，D-31；写 IndexedDB，打包版写 `localStorage` 并可手动导出）。

#### 8.3.1 交互事件与 tick 边界
玩家操作（点击器点击、购买/批量购买、丢弃动态条目、页面跳转、游戏内设置变更）由 DOM 事件触发，落在**两次 tick 之间**——JS 单线程保证一个 tick 执行过程中不会被插入交互事件：`frame()` 先把本帧的 tick 批次跑完再回到事件循环（[8.2](#82-主循环请求动画帧驱动)）。PRD 未规定“交互发生在 tick 之间时如何结算”，本节把它固定下来，避免实现期出现“交互即时提交副作用”“交互副作用被丢弃/重复提交”两条分叉路径。

| 交互 | 条目状态字段 | 副作用（`set/create/destroy`） |
| --- | --- | --- |
| 点击器点击 `click()` | **即时**结算产出（经 `applyProduces`/`applyCap`） | 不经 `EffectSink`：产出走 `produces[i].materialId` 指定的存储，不是表达式副作用 |
| 购买 `buyOne()` / 批量购买 `solveBatch()` | **即时**扣材料并推进 `bought/owned`（[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解)） | 由 `applyEffect` 收集的 `set/create/destroy`（含 `effValue` 写回）与 tick 内产生的副作用**同池入队**，在**下一个提交阶段**（8.3 第 6 步）统一应用 |
| 丢弃动态条目（卡片“丢弃”按钮） | **即时**移除条目并级联清理其 `assignments`/`effectValues`/页面归属（[8.7](#87-升级效果与动态条目)） | 不经 `EffectSink`：这是玩家的直接操作，不是表达式副作用，因此**不排到下一 tick**——卡片必须立刻从视图消失 |
| 页面跳转 `nav()` / 设置变更 | **即时**改 UI 会话状态（均不进存档，D-22/D-50） | 无 |

- **唯一提交点**：任何来源的副作用都只经 `EffectSink`、只在 8.3 第 6 步的提交阶段应用；交互事件的副作用既不单独即时提交，也不跨提交阶段保留（提交时无条件清空队列）。由此，`isClicker`、`visible` 等经 `set()` 改写的属性同样“**下一 tick 起生效**”（[8.4](#84-可见性与禁用的有效状态页面继承)），与 5.6 的统一提交一致。
- **提交顺序与可见性**：队列严格 FIFO（`destroy` 先于 `create`）；提交时递增目标属性 `version`，因此写入值只对**下一个** tick 的 1~5 步可见，本 tick 已执行过的阶段不再回读它。
- **暂停态**：暂停只停 tick 推进、保留渲染与交互（[7.1](#71-界面总体布局prd-工作页面一览)），因此交互的状态字段**仍然即时结算**；但暂停期间没有提交阶段，其副作用在**恢复后第一个 tick** 的第 6 步才应用。结论是“暂停时购买升级，其效果不会立刻显现”——这是 5.6 单一提交点的必然结果，**不得**为交互另开即时提交旁路；预览的诊断面板可据此提示“已暂停，副作用待恢复后生效”。
- **自动购买与批量购买**：自动购买在 tick 内被调用（8.3 第 5 步），其副作用在**同一 tick** 的第 6 步提交；卡片按钮触发的 `solveBatch` 落在 tick 之间，按上表处理。批量求解跨 tick 分摊续算期间（[8.6](#86-批量--最大--自动最大购买求解)）每个分摊段各自走一次“即时结算 + 下一提交阶段应用”，不得把已结算的件数重复入队。
- **离线**：离线结算跳过“每秒生效”、自动购买，且不发生任何购买，`effect` 上下文不可达，因此离线期间不产生任何副作用（与 [5.4](#54-内置函数) 的“离线 ✅”读法说明一致）。

### 8.4 可见性与禁用的有效状态（页面继承）
PRD 页面编辑器 4/5 规定：页面禁用时其下所有生成器/升级条目**不可购买、不可产出、不生效**，但页面仍可跳转；页面不可见时其下**所有条目**不可见，同样不可购买、产出、生效，可见时恢复。为避免各阶段各自判断而遗漏，运行时只暴露两个判定函数，所有阶段（购买、产出、点击、每秒生效、效果应用、自动购买、UI 渲染、仪表盘预测）**必须**调用它们：

```ts
// 条目 → 所属页面（静态条目查 PageDef.entries，动态条目查存档里的 pageId；无归属时按“不可见且禁用”处理并记 E_PAGE_UNKNOWN）
function pageOf(entryId): PageDef | undefined
function isVisible(entryId): boolean        // 自身 visible && 页面 visible（PRD 页面 5）
function isDisabled(entryId): boolean       // 资源恒 false（PRD 未定义资源的禁用态）；生成器/升级 = 自身 disabled || 页面 disabled（PRD 页面 4）
// 派生便捷函数
function isEffectivelyVisible(e)   { return  isVisible(e) }
function isEffectivelyDisabled(e)  { return isDisabled(e) || !isVisible(e) }  // 不可见 ⇒ 不参与任何结算
function isClicker(e)              { return attrs(e,'kind') === 'generator' && attrs(e,'isClicker') === true }
function canProduce(e)             { return isVisible(e) && !isDisabled(e) }
function canBuy(e)                 { return isVisible(e) && !isDisabled(e) && attrs(e,'owned') < attrs(e,'max')
                                       && !isClicker(e) }                       // 点击器不可购买（PRD 生成器 11）
function canTick(e)                { return isVisible(e) && !isDisabled(e) }  // 每秒生效与点击
function ownsUpgrade(e)            { return attrs(e,'kind') === 'upgrade' && attrs(e,'owned') > 0 }  // 已拥有才产生效果（D-43）
```
- **点击器不可购买是运行时硬约束**：`isClicker === true` 的生成器 `canBuy` 恒假，`buyOne`/`solveBatch`/自动购买阶段一律拒绝（[8.5](#85-购买结算)）。UI 只渲染无“购买”按钮的 `ClickerCard`（[8.11](#811-游戏视图与卡片字段映射prd-预览区-18)）是**表现层**结果，不是约束本身——不得因为“按钮没画出来”就认为路径已被堵死。
- **升级“已拥有”是效果的唯一门槛**（D-43）：所有 `applyEffect` 调用点（购买结算、批量结算、每秒生效阶段）都必须先过 `ownsUpgrade(e)`，即 `owned > 0`；`owned` 每次**实时读取**、不做缓存，以便同一 tick 内被别的升级改写后立即反映。可见/禁用由各调用点自行按 `isVisible`/`isDisabled` 过滤（8.3 第 2 步、8.6 前置判定），`ownsUpgrade` 只负责“是否拥有”这一层，不与其重复。
- **资源没有“禁用”态**：PRD 页面编辑器 4 只要求页面禁用影响其下的**生成器/升级**，因此 `isDisabled(resource)` 恒 `false`，页面禁用**不**把资源卡片置灰（否则会造成“页面禁用 → 资源被灰掉”的错误视觉与误导性的“不可用”暗示）。页面 `visible = false` 则对**所有**条目生效（含资源），因为 PRD 页面编辑器 5 明确写的是“所有条目”。
- **页面跳转不受影响**：页面禁用只影响其条目，不影响底部导航跳转（PRD 页面 4 明确“仍可跳转”）；页面不可见时其导航按钮也不渲染，但可直接通过 `nav(pageId)` 到达（便于解锁逻辑与调试）。
- **继承方向单向**：条目不能反向解锁页面；条目自身的 `visible=false` 也不会影响同页面其它条目。
- **判定时机**：每个阶段在遍历前取一次快照（`pageOf/isVisible/isDisabled` 在阶段内不再变化，避免同 tick 内半途改页面导致结算不一致），并在 [14.2](#142-关键用例清单抽样) 用例中断言各阶段均调用了这两个函数。
- **“解锁全部”**（D-16）是一次性把页面与条目的 `visible` 置真、`disabled` 置假；后续被表达式覆盖后 `forceUnlock` 清除，判定函数只读属性值，因此自动继承关系仍然成立。`forceUnlock` 的存储与生命周期：**纯运行时内存标记**，不写入项目文件、不写入存档（[5.9](#59-属性读写矩阵) 与 [6.3](#63-存档文件-schemasavejson) 的可写/落盘清单里都没有它，PRD 补充 6 只要求“被赋值属性的更改”落盘）；`GameState.reset()`、读档、载入/新建项目后一律清空。它只用于区分“被强制解锁”与“被表达式覆盖”，**不参与任何结算判定**（判定只看 `visible`/`disabled` 的当前值），因此删掉它不会改变任何游戏行为。
- **`isClicker` 运行时切换语义**（[5.9.1](#591-条目属性) 与 D-26 允许 `isClicker` 被赋值，PRD 生成器 11 说“可被外部引用或赋值”），切换遵循“只改判定与 UI、不改进度”：
  | 项 | 语义 |
  | --- | --- |
  | 生效时机 | 切换发生在副作用提交阶段，因此**下一 tick** 起生效（与 5.6 的统一提交一致） |
  | 进度 | **不重置** `bought`/`owned`/`max`，不改变已购价格成长；切换前后 `owned` 原样保留 |
  | 切为点击器 | 立即停止参与 8.3 第 3 步的自动产出结算；被 8.3 第 5 步自动购买跳过；任何 `buyOne`/`solveBatch` 报 `E_CLICKER_NOT_BUYABLE`；`canBuy` 恒假；卡片由 `GeneratorCard` 切换为 `ClickerCard`；单次点击获得量按新形态生效（`owned × Σ produces[i].amount`，见 8.5） |
  | 切回生成器 | 立即恢复按 `owned × Σ 速率` 的自动产出结算、正常购买与自动最大购买；卡片切回 `GeneratorCard` |
  | 上限 | `owned >= max` 时点击与购买同样被 `E_CAP` 拒绝（[8.5](#85-购买结算)） |
  | 价格 | `costs` 始终保留在数据模型中，但因 `canBuy` 恒假而不会被求值参与结算；切回生成器后立即按当前 `bought` 生效 |

### 8.5 购买结算
```
buyable(target, k):                    // 前置判定，等价于 8.4 的 canBuy(target) && 成本足够
  isVisible(target) && !isDisabled(target) && attrs(target,'owned') < attrs(target,'max')
  !isClicker(target)                    // 点击器不可购买（PRD 生成器 11），硬约束不依赖 UI 是否画按钮
  升级额外要求 conditions 全部为真（AND，PRD 补充 4）
  Σ cost(k) 可支付（免费模式只校验最后一件的价格，升级还校验最后一级条件，见 8.6）

buyOne(target):                      // 单件购买
  if isClicker(target) → E_CLICKER_NOT_BUYABLE      // 点击器没有购买路径
  cost = evaluateCosts(target)       // 每种材料的 amount 表达式，用 target.bought 求值
  if !affordable(cost) → E_NOT_ENOUGH
  subtract(cost); target.bought += 1; target.owned += 1
  if target is upgrade: applyEffect(target)         // 升级：购买成功即结算自身全部效果（8.7 触发点 ①）

click(generator):                    // 点击器：点击不是购买，不走 buyable，也不报 E_CLICKER_NOT_BUYABLE
  if !isVisible(generator) → E_HIDDEN; if isDisabled(generator) → E_DISABLED
  if owned >= max → E_CAP
  applyProduces(generator, 1)        // 单次获得量 = owned × Σ produces[i].amount（与 8.3 同一公式，只乘一次 owned）
```
- 数量上限是**硬上限**：`owned` 达 `max` 后不可购买，直到 `owned` 再次低于 `max`（PRD 补充 3），因此产出/购买的写入一律经 `applyCap`。
- **`buyOne`/`click` 的生效时机**：两者都是**同步函数**，被卡片按钮在 tick 之间直接调用，其状态字段（材料、`bought/owned`、产出量）**即时**生效；`buyOne` 内部 `applyEffect` 收集的 `set/create/destroy` 走统一提交阶段，在**下一提交阶段**应用（[8.3.1](#831-交互事件与-tick-边界)）。同一函数也被 8.3 第 5 步的自动购买在 tick 内调用，此时副作用在**同一 tick** 的第 6 步提交。
- “已购买数量/拥有数量”均可被表达式重置为 `initial`（PRD 补充 3）。
- **`bought` 与 `owned` 独立可写**（PRD 补充 3“可被外部引用或重置为初始数量”）：写 `bought` 只改变价格成长的自变量（`owned` 不随之变化）；写 `owned` 只改变拥有数量并立即经 `applyCap` 夹到 `max`（不改 `bought`、不影响价格）。二者都可写成 `gen.<id>.initial` / `up.<id>.initial` 来实现“重置为初始数量”。点击器的 `bought` 虽可被表达式写成非 0（数据模型保留该字段），但购买路径仍被 `E_CLICKER_NOT_BUYABLE` 拒绝——PRD 生成器 11 只允许“点击”获取产出。
- **初始化规则**（新开局与“重新开始”重建时一次性执行，之后不再重复）：

| 条目类型 | `bought` 初值 | `owned` 初值 | 说明 |
| --- | --- | --- | --- |
| 资源 | —（不可读，`E_UNKNOWN_ATTR`） | —（资源用 `amount`；`res.<id>.owned` 是同一份存储的别名，PRD 补充 3） | `amount = initial`（PRD 资源编辑器 4） |
| 生成器（非点击器） | `initial` | `initial` | 初始数量计入已购买数量并影响价格（PRD 生成器编辑器 4） |
| 生成器（点击器） | `0` | `initial` | 初始数量只作为拥有数量，不影响价格（D-19，PRD 生成器编辑器 11“受初始数量影响”） |
| 升级 | `initial` | `initial` | 初始数量计入已购买数量并影响价格（PRD 升级编辑器 4） |
| 动态条目 | `0` | `0` | 继承自其 `spec` 的 `initial`，无 `spec.initial` 时为 0 |

  “重新开始”后按上表用项目文件的 `initial` 重建（`amount` 回到 `initial`，`max`/`visible`/`description` 等回到项目文件值），并丢弃 `assignments`/`effectValues`/`dynamic`（PRD 补充 6、D-18）。

### 8.6 批量 / 最大 / 自动最大购买求解
`buyAmount` 语义（PRD 生成器 8、升级 9；求值后先按 [5.9.3](#593-读写实现约定) 的归一化规则取整/夹取）：
| 值 | 行为 |
| --- | --- |
| `n ≥ 1` | 连续购买直到不满足条件或价格，或达到 `min(n, 100)` 次 |
| `n = 0` | 最大购买（无 100 上限），需支付材料 |
| `n < 0` | 自动最大购买（无 100 上限、**免费**，只校验**最后一件/最后一级**：生成器为价格、升级为条件与价格——PRD 生成器 8 / 升级 9 原文），每 `buyDelay` tick 尝试一次，离线不触发 |

前置判定（任一不满足直接返回 0 件，不进入求解）：`canBuy`（可见/禁用/上限/非点击器，含页面继承）；升级还需 `conditions` 全真。**点击器（`isClicker`）无条件返回 0 件**——`buyAmount` 可被表达式写成 0 或负数，但点击器不可购买，三种模式（`count`/`max`/`free`）都不适用（D-28）。求解算法（ADR-08）：

```
// mode: 'count'（n ≥ 1）/ 'max'（n = 0）/ 'free'（n < 0，自动最大、免费）；cap = 数量上限表达式结果
solveBatch(target, mode):
  // 1) 多材料：每种材料独立求最大可负担件数，取最小值
  kAll = [ solveForMaterial(target, m, mode) for m in target.costs ]
  k = min(kAll)
  // 2) 夹到硬上限与模式上限
  k = min(k, max(0, ceil(cap − owned)))        // 数量上限（PRD 补充 3）
  if mode == 'count': k = min(k, buyAmount, 100)   // PRD 生成器 8 / 升级 9
  // 3) 升级条件求解（count/max 用前缀语义；free 按 PRD 只校验最后一级，见下方与 [8.6.2](#862-升级购买条件的前缀语义-solvebyconditionprefix)）
  if target is upgrade:
     k = (mode == 'free') ? checkLastLevelOnly(target, k) : solveByConditionPrefix(target, k, mode)
  // 4) 结算
  if k == 0 → return 0
  if mode != 'free': 一次性扣除各材料 cost(k)
  target.bought += k; target.owned += k; return k
```

单材料求解 `solveForMaterial(target, m, mode)`：
```
  P(j) = 求值 m.amount（ctx=price，j = target.bought + 等级偏移）    // 单件价格；j 由“只读等级视图”注入，见 [8.6.1](#861-只读等级视图价格与条件按第-j-级求值)
  C(k) = Σ_{i=0..k-1} P(i)                                        // 前 k 件总价（单调递增假设）
  // A. 形状识别：在采样点 j ∈ {0, h, 2h, 5h, 8h}（h = max(1, 采样跨度)）上拟合，
  //    命中下列“可闭式求和族”之一即给出 C(k) 的 O(1) 闭式（D-48）：
  //      ① 等比       P(j) = A·q^j           → C(k) = A·(q^k − 1)/(q − 1)（q ≈ 1 退化为 A·k）
  //      ② 指数+常数  P(j) = A·q^j + B       → C(k) = A·(q^k − 1)/(q − 1) + B·k
  //      ③ 指数+线性  P(j) = A·q^j + B·j + C → C(k) = A·(q^k − 1)/(q − 1) + B·k(k+1)/2 + C·k
  //      ④ 线性       P(j) = A·j + B         → C(k) = A·k(k+1)/2 + B·k（① 在 q ≈ 1 时的特例）
  //    拟合后必须在**未被采样的 j**（如 3h、11h）复验残差（相对容差 1e-9），任一复验点超差即判“未知形状”；
  //    采样点出现递减（P(j) < P(j−1)，含负价格）一律记 E_BATCH_MONOTONE，闭式再准也不使用
  // B. 「倍增上界 + 二分」定位最大可负担 k（闭式下求值次数 O(log k)；搜索域上界取 ceil(cap − owned)，
  //    cap 为 Infinity 时用倍增试探）
  //    可负担判定：mode ∈ {'count','max'} → C(k) ≤ m.amount
  //               mode == 'free'        → P(k−1) ≤ m.amount（只校验最后一件的价格）
  // C. 迭代降级：形状未知且 P 非单调（或含负价格）时逐级累加求 C(k)，上限 1e5 次/tick；
  //    超预算则本 tick 部分结算并在 UI 显示「计算中…」，下一 tick 从断点续算（保证 1e1e10 级数量不卡死）
```

- **多材料**：`k = min_m k_m`。材料之间不可互换、各来自不同资源，故必须逐材料求解后取最小值（如价格 `[r1: 10·1.15^bought, r2: 5·1.20^bought]` 时 `r2` 常先耗尽）。
- **“降级”与“还在算”是两件事，不可混用**：求解结果同时给出 `degraded`（走了 C 段迭代路径：形状不可闭式 / 非单调 / 非单调条件）与 `truncated`（**单 tick 求值预算被用光**，`k` 只是已确认的前缀）。卡片上的“计算中…”**只由 `truncated` 驱动**（数据源 `GameState.pendingSolves()`，由每次求解结果自我更新）；`degraded` 只用于本节末条的“连续 60 tick”作者提示。
  混用二者的后果是确定的：迭代路径通常只花百量级求值、`truncated` 恒为假；而交互购买每次点击都拿一份**全新**预算、根本不存在“等下一 tick 续算”——于是早期实现里任何一次降级购买都会把按钮永久钉在“计算中…”，而那一刻的求解其实已经算完了。
- **`free` 模式不需要闭式求和**（消除“长期计算中”的关键点，D-48）：自动最大购买只校验**最后一件**的价格 `P(k−1) ≤ m.amount`，不需要 `C(k)`。只要采样判定 `P` **单调非减**，谓词“`P(k−1) ≤ amount`”对 `k` 就是单调的（假→真），因此**无论是否等比**都可直接对 `P` 做「倍增 + 二分」，O(log k) 收敛（典型 ≤ 20 次求值）；闭式族 ①–④ 只在需要 `C(k)` 的 `count`/`max` 付费模式才有意义。效果：把价格写成 `10 * 1.15 ^ gen.g1.bought + 5` 这类“非纯等比但仍单调”的常见写法时，`free` 模式**不会**退化成逐级累加，只有付费 `max` 模式仍可能需要。
- **`free` 的其余语义**：`mode == 'free'` 时不真实扣费，`k` 定义为“使 `P(k−1) ≤ m.amount` 的**最大整数**”，并按 PRD 只校验**最后一级**的购买条件与价格（升级），同时满足 `canBuy` 与 `owned < max`（为何不做前缀语义见 [8.6.2](#862-升级购买条件的前缀语义-solvebyconditionprefix)）；免费购买仍推进 `bought/owned`，价格成长继续生效，后续 tick 能买的件数自然减少；求解超出迭代预算时按预算分摊并在后续 tick 续算（离线不触发），分摊期间卡片显示“计算中…”并可暂停/重新开始取消（[8.2](#82-主循环请求动画帧驱动)）。
- **形状识别只作加速，不作正确性前提**：识别成功仍须按上文的未见采样点复验；`q < 1`（价格递减）时闭式在数学上仍成立，但单调性不满足，一律记 `E_BATCH_MONOTONE` 并走 C 分支。识别与复验的结论随价格表达式的 `hash` 记忆化，文本热替换时重新识别。
- **持续降级时的作者提示**：`free`/`max` 模式连续 60 tick 达到迭代预算仍未收敛时，除 `E_BATCH_MONOTONE` 诊断外，在诊断面板与该条目卡片上追加固定提示文案：“价格形状无法闭式求解，已按 tick 分摊；建议改写为等比或指数+线性形式（如 `10 * 1.15 ^ gen.g1.bought`）”，可立即获得闭式求解。PRD 未规定该提示，但它是本节降级路径**可被作者自行修复**的必要反馈，缺失时作者只会看到长期“计算中…”而不知成因。计数只在本 tick **真的尝试求解过**时累加（`failure === undefined` 且确实降级）；`k = 0`（材料不够）或前置判定失败会清零——“连续”是提示的前提。
- **两处提示的数据同源**：`GameState.rewriteAdvice()` 同时喂给两处——卡片上的 `CardView.rewriteAdvice`（随视图模型，8.11）与宿主诊断面板的 `game:stats.advice`（[9.2](#92-消息协议)）。后者是必需的：卡片只覆盖**当前页面**，作者切到别的页面就看不到自己写坏的条目。打包产物没有诊断面板（D-42），因此那条路径上只有卡片提示。
- **升级批量购买只结算最后一级的效果**（PRD 升级 9）：先 `bought += k; owned += k`，再求值全部效果（通常覆盖中间结果），避免不可逆副作用累积（D-06、8.7 触发点 ②；因 `k ≥ 1`，`owned > 0` 恒成立，D-43 的前置自动满足）。生成器无此语义。
- **副作用一致性**：批量结算期间收集的 `set/create/destroy` 仍在 [8.3](#83-单-tick-顺序固定时序可预测) 第 6 步统一提交，顺序与书写顺序一致。

#### 8.6.1 只读等级视图：价格与条件按第 j 级求值

批量求解要回答的是“**第 `j` 级**的价格 / 购买条件”，而表达式里写的是当前属性路径（`gen.g1.bought`）。因此求解器必须能“看见”一个临时等级值。做法是**只读等级视图（level overlay）**——在作用域中覆盖读取值，**绝不修改 `AttributeStore`**：

| 项 | 规则 |
| --- | --- |
| 生效范围 | 仅在批量求解的单次求值期间生效（`solveForMaterial` / `solveByConditionPrefix` / `checkLastLevelOnly`）；求值返回即撤销，`applyEffect` 与第 4 步结算阶段看不到覆盖层 |
| 注入方式 | 求值作用域中把 **`target.bought` 的读取值**覆盖为 `j`（`target` 为正在求解的条目）；`owned`、`max` 及其余所有属性的读写仍为真值 |
| 无副作用 | 不递增属性 `version`、不触发脏标记与下游失效、不写 `assignments`、不落存档——否则一次批量求解会污染存档并把整批结果记成“最后一次赋值” |
| 只影响读 | 覆盖层内不存在对 `bought` 的写入路径：`price`/`condition` 上下文本就禁止副作用（[5.5](#55-上下文context与权限)，编译期 `E_SIDE_EFFECT_FORBIDDEN`）；`bought` 的真实写入只发生在第 4 步结算 |
| **记忆化隔离（易错点）** | 覆盖层求值**不共享** [5.7](#57-求值调度与性能) 的 `tickCache`：缓存键必须附加覆盖层段（`hash(ctx + '\u0000' + text + '\u0000' + overlayKey)`），否则同一段表达式在不同 `j` 处会命中彼此缓存值，导致 `P(1) == P(5)` 这类静默错误 |
| 嵌套 | 价格表达式内再读另一条目的价格时各自持有自己的覆盖层，按栈式进出；同一 `target` 的嵌套以最内层为准 |
| 越界语义 | `j` 从 `target.bought + i`（`i` 为 0 基偏移）取值，允许超过 `max`——批量候选件数尚未夹到硬上限（夹取在第 2 步），此时价格仍按表达式原样求值 |

示例：价格文本 `"10 * 1.15 ^ gen.g1.bought"`，`bought = 0`，求第 5 级价格 → 覆盖层取 `j = 5` → 得 `10 · 1.15⁵`；求解结束后断言 `bought` 仍为 `0`、其 `version` 未变、`assignments` 无新键（用例见 [14.2](#142-关键用例清单抽样)）。

#### 8.6.2 升级购买条件的前缀语义 solveByConditionPrefix

PRD 升级编辑器 9 要求“**连续购买直到不满足购买条件**或价格”，这是**前缀语义**而非“末级语义”：允许购买的最大件数是

```
k* = max { k | 对每个 j ∈ [0, k−1]：condition(bought + j) 为真 ∧ 第 j 级价格可支付 }
```

`j` 是“第 `j` 次购买”的序号，它**发生在**等级 `bought + j` 这个状态上——条件与价格都按**成交时**的状态判定，而不是按成交之后的状态。这与本节伪码第 1 步的 `atLevel = bought + k − 1`、`free` 模式的 `checkLastLevelOnly`、以及卡片件数 `affordableInCountMode`（`bought + level`，`level ∈ [0, limit)`）**同一套等级口径**；四处必须一致，否则会出现“按钮写 ×N、点下去买到 0 件”的“按钮说谎”缺陷。

因此**只校验最后一级 `bought + k − 1` 仍是不正确的**：条件形如 `gen.g1.bought == 0 || gen.g1.bought >= 5` 时，末级为真会**越过中间为假的等级**（`bought = 1..4`）。求解分两步，先快后验：

> **适用模式**：前缀语义只适用于 `count`（`n ≥ 1`）与 `max`（`n = 0`），二者都受“连续购买直到不满足购买条件或价格”约束。`free`（`n < 0`，自动最大购买）**按 PRD 的字面规定只校验最后一件**——PRD 生成器 8 写“仍要满足最后一件的购买价格”，PRD 升级 9 写“仍要满足最后一级的购买条件和价格”，即免费模式本身就是**末级语义**，中间等级的跳过由“免费 + 不扣费”换取，确定性由末级条件与价格保证。因此 `free` 模式走 `checkLastLevelOnly`（末级条件 + 末级价格 + `canBuy` + `owned < max`），**不做前缀回退**，也不得在此模式下顺带施加比 PRD 更严的前缀约束（否则等于把“免费模式仍要满足最后一级”的规定偷换成逐级判定，与 PRD 文本不符）。

```
solveByConditionPrefix(target, k, mode):            // 仅 count / max 模式
  // 第 1 步：候选上界。用「末级校验 + 二分」把 k 收敛到 condition(bought + k − 1) 为真的最大 k
  while k > 0 && !conditionsAllTrue(target, atLevel = target.bought + k − 1):
     k = bisectDown(k)                       // 每步重校验末级
  // 第 2 步：逐级确认（正确性保证，成本 O(k)，只在“单调条件”或预算内完成）
  confirmLevelByLevel(target, k):
     for j in 0..k−1:
        if !conditionsAllTrue(target, atLevel = target.bought + j) 或 该级价格不可支付:
           return solveByConditionPrefix(target, j, mode)   // 回退到首个违例之前再二分收敛
     return k
```

- **下标从 0 起不是细节，而是正确性的一部分**。早先的实现按 `bought + j`（`j ∈ [1, k]`）判定，即把条件读在**成交之后**一级，于是两种最常见的条件写法全被打歪：

  | 条件写法 | 按 `bought + j`（`j ∈ [1, k]`，错） | 按 `bought + j`（`j ∈ [0, k−1]`，对） |
  | --- | --- | --- |
  | 阈值型 `up.u1.bought >= 5` | `bought = 4` 时末级 `>= 5` 为真 -> **一次买满 10 件** | `bought = 4` 时第 0 级 `>= 5` 为假 -> 买 0 件；`bought = 5` 时才买 |
  | “下一档”型 `(up.u2.bought==k && gen.gN.bought>=1) \|\| …` | 要求**再往后一档**的生成器 -> 最后一档的条件永远不成立，`up.u2` 永远到不了 `max` | 第 `k` 件按 `bought == k` 判定 -> 能买满 `max` |

  第二行是真实项目（「反物质维度」里的 `购买维度`）踩到的坑：它同时导致该升级**买不了**（按钮写 `购买 ×1`、点下去结算 0 件），以及所有引用 `up.u2.effectValues[i]` 的**产出表达式**永远乘不上那个倍率。
- **单调条件快路径（默认，O(log k)）**：若编译期能把该升级的 `conditions` 判定为**单调条件**——“对 `bought` 一旦为真则持续为真”，即条件为若干 `阈值型比较` 的 `&&`（形如 `gen.g1.bought >= 5`、`res.r1.amount >= a + b * gen.g1.bought`，运算符为 `>=`/`>`，左侧是 `bought` 的单调非减线性式；`==`/`!=`/`<`/`<=`、`||`、条件中引用会随本批次变化的其它可变属性等一律**不算**单调）——则“末级为真 ⇒ 全程为真”成立，第 1 步的收敛结果**严格正确**，第 2 步只需抽查首、中、末三级即可通过（O(1)），无需全量逐级确认。单调性判定结果随表达式 `hash` 记忆化，文本热替换时重新判定。**抽查未通过时必须退回全量逐级确认**：单调只保证“后面的不会比前面的更假”，从“中段为假”推不出“中段之前都可买”，按探针位置直接回退会多买。
- **非单调条件（正确性优先，降级逐级）**：未判定为单调时，第 2 步的全量逐级确认是**唯一正确解**，`O(k)` 的成本按本节单材料求解 C 分支的 tick 预算分摊（上限 1e5 次/tick），跨 tick 续算；预算内无法完成确认时本 tick 只结算已确认的前缀并显示“计算中…”，同时记 `E_BATCH_CONDITION`（诊断级，不中断），提示作者把条件改写为单调形式以恢复快路径。
- **价格也按前缀判定**：`C(k) = Σ P(i)` 在“单件价格均 ≥ 0”时天然随 `k` 单调不减，因此二分定位最大可负担件数是可靠的；风险只在两处——① 单件价格为**负**（用户用负价格返还材料）会破坏单调性，此时记 `E_BATCH_MONOTONE` 并强制逐级累加求 `C`；② 闭式求和族（[8.6](#86-批量--最大--自动最大购买求解) 的 ①–④）只是 `C(k)` 的 O(1) 近似优化，形状识别失败时改为逐级累加，但二分/前缀语义本身不变。
- **单调假设只是性能优化，不是正确性前提**：`count`/`max` 模式下任何情况下都不允许“因为末级成立就整批成交”，逐级确认（或其严格等价的单调性证明）必须先于本节第 4 步的 `bought += k`。
- **`atLevel` 与价格的 `j` 用同一套等级视图**（见 [8.6.1](#861-只读等级视图价格与条件按第-j-级求值)）：`conditionsAllTrue(target, atLevel)` 在求值 `conditions` 时把 `target.bought` 的读取值临时覆盖为 `atLevel`，因此条件里写 `gen.g1.bought` 就能正确表达“第几级”；两侧必须共用同一个覆盖层入口，否则会出现“价格按第 `j` 级、条件按真实 `bought`”的错位。覆盖层在逐级确认的每一次求值后立即撤销，不跨调用残留。

### 8.7 升级效果与动态条目
```
applyEffect(upgrade):
  if upgrade.owned <= 0 → return                     // 生效前提：必须已拥有（D-43），未购买的升级一律不生效
  // 遍历全部效果，每条独立判断（PRD 升级编辑器 12：“每个效果都要进行判断”）
  for i, e of upgrade.effects:
    if evaluate(e.condition, ctx=condition):        // 前提默认为 true
      bucket = effects.startBucket(upgrade, i)      // 本条效果独占一个分桶（5.6 的“表达式实例”）
      scope.effValue = upgrade.effectValues[i]       // 载入该效果持久化的数值（默认 0）
      run(e.action, ctx=effect)                      // 对 effValue 的赋值即登记写回；set() 副作用入 EffectSink
      bucket.commitEffValue(scope.effValue)          // 登记写回（= set("up.<id>.effectValues[i]", v)），不立即生效
      // action 抛错 → 整个 bucket 丢弃：写回与其它副作用都不应用，effectValues[i] 保持上次成功值（5.6）
    // 前提不满足 → 跳过本条，继续判断下一条；不 break、不短路
```
- **生效前提：必须已拥有**（D-43）：`owned <= 0` 时 `applyEffect` 直接返回——效果是“拥有该升级”之后才成立的特权；判定用 `owned > 0` 而非 `bought > 0`，才能覆盖被其它升级产出的升级（`bought = 0`、`owned > 0`），`initial > 0` 的升级则由 [8.5](#85-购买结算) 初始化表保证 `bought = owned = initial`。反例与完整理由见 D-43，判定入口见 [8.4](#84-可见性与禁用的有效状态页面继承) 的 `ownsUpgrade`。
- **三个触发点**（统一走同一个 `applyEffect`，都必须带上述前置）：
  1. **单件购买成功后立即结算**（[8.5](#85-购买结算) `buyOne`，`subtract → bought/owned += 1` 之后调用）——效果本就是购买结果；PRD 升级编辑器 9 之所以只对批量购买特别说明“直接结算最后一级的升级效果”，正是因为单件购买本来就结算自身效果；
  2. **批量 / 最大 / 自动最大购买**在 `bought/owned += k` 之后结算**最后一级的全部效果**（D-06，[8.6](#86-批量--最大--自动最大购买求解) 第 4 步）；`k = 0` 时不结算；
  3. **每秒生效阶段**只对已拥有（`owned > 0`）、有效可见、有效未禁用的升级重算（[8.3](#83-单-tick-顺序固定时序可预测) 第 2 步）。

  三条路径都不得跳过 `owned > 0` 前置：触发点 ② 因为结算后 `k ≥ 1` 故 `owned > 0` 恒成立；触发点 ①③ 才是本条约束真正生效的地方。三个触发点里的“结算”统一指**调用 `applyEffect` 求值**，其写入一律按 [5.6](#56-编译与执行) 的统一提交阶段落地：tick 内触发（②③、tick 内的 ①）在**同一 tick** 的第 6 步提交，tick 之间触发（卡片按钮的 ①）在**下一提交阶段**提交（[8.3.1](#831-交互事件与-tick-边界)）。
- **不 `break`**：PRD 明确要求每个效果都要判断，满足前提的效果**全部**生效，只有不满足的那条被跳过。若项目需要“首个命中生效”的语义，必须由用户在效果条件里自行用互斥条件表达（例如把 `up.<id>.effects[0].condition` 赋成命中即置位的状态表达式，后续条件再引用该状态），本引擎不隐式引入短路语义。
- **前提求值失败**：某条效果的条件报错（last-good 机制）时按“前提不成立”处理该条，继续判断后续效果，并记诊断。
- **`effectValues[i]` 的写入路径**：`action` 内对局部变量 `effValue` 赋值 ⇔ 写 `up.<id>.effectValues[i]`（见 [5.9.3](#593-读写实现约定)）；未赋值时保持上次数值（默认 `0`）。**提交模型**：写回不直接改存储，而是登记进该条效果的分桶，与它的其它副作用同生共死（[5.6](#56-编译与执行)）——`action` 抛错则不写回（`effectValues[i]` 取 last-good），`action` 未赋值则不写回且不递增 `version`；写回在提交阶段落地，因此**下一 tick** 起其它表达式才读到新值（触发点 ① 的“购买成功即结算效果”在语义上仍成立，延迟上限为一个 tick）。
- 动态创建：`create(kind, spec)` 的 `kind ∈ {"generator","upgrade"}`（V1.0 **两类都支持**：PRD 升级编辑器 12 只要求升级，作为对称扩展同时支持生成器，见 D-34），`spec` 规则如下：
  | 规则 | 内容 |
  | --- | --- |
  | 字面量语法 | `spec` 必须是 [5.2](#52-语法) 定义的**受限对象字面量**（键名白名单、深度 ≤ 4、单数组 ≤ 64 项、不支持展开运算符），字符串一律用双引号 |
  | 字段集合 | `spec` 必须是 `GeneratorDef` / `UpgradeDef` 的**子集**（见 [6.2](#62-项目文件-schemajson)）：公共字段 `id`（可选，见下行）/`name`/`description`/`icon`/`initial`/`max`/`visible`/`order`，专有字段 `disabled`/`buyAmount`/`costs`/`produces`/`isClicker`（生成器）或 `disabled`/`buyAmount`/`costs`/`conditions`/`effects`/`perSecond`（升级）；`kind`/`buyDelay` 由运行时接管，`spec` 中出现即报 `E_CREATE_FIELD_INVALID`。键名在**编译期**即按此白名单校验（[5.2](#52-语法)），保证 `create` 的静态检查、权限校验与沙箱黑名单与项目文件字段定义一致 |
  | 字段形态 | 数值/表达式字段仍传**字符串**（如 `costs: [{ materialId: "r1", amount: "10 * 1.15 ^ gen.g1.bought" }]`），走与项目文件同一套 Zod Schema 与跨条目一致性校验（[6.4](#64-校验与迁移)），语法错误报 `E_PARSE`、悬空引用报 `E_DANGLING_REF` |
  | 必填 | `page` 必填（PRD 补充 7）且写在 `spec` 内：`create("upgrade", { name: "x", page: "p1", costs: [{ materialId: "r1", amount: "10" }] })`。缺失报 `E_CREATE_NO_PAGE`，指向不存在的页面报 `E_PAGE_UNKNOWN` |
  | 缺省 | 未给出的字段取 `GeneratorDef`/`UpgradeDef` 默认工厂值（`initial="0"`、`max="Infinity"`（无上限：合法字面量、解析为哨兵 `NUM_INF`，见 [4.4 第 6 条](#44-溢出下溢策略饱和语义)、D-46）、`buyAmount="1"`、`buyDelay=1`、`visible=true`、`disabled=false`、`isClicker=false`、`costs/produces/conditions/effects=[]`），并按 [8.5](#85-购买结算) 初始化表把 `bought/owned` 置为 `initial` |
  | id | **可选**（D-44）：`spec` 省略时由运行时生成 `dyn_<递增序号>`——静态 `id` 已被 [6.1](#61-公共字段) 禁止使用 `dyn` 前缀（D-45），故该自动 id 与静态条目及既有动态条目都不冲突；`spec` 给出时必须以 `g`/`u` 开头、后接字母/数字/下划线、长度 ≤ 32（与静态 `ID_PATTERN` 同源，见 [6.1](#61-公共字段)），且与**任何**静态条目、其它动态条目、`dyn_*` 都不冲突，否则报 `E_CREATE_ID_CONFLICT`（整体拒绝、不做部分创建）。作者给出的 `id` 随存档持久化，因此后续 tick 可用**字面量路径**为其赋值或丢弃：`up.<id>.description = "…"`、`set("up.<id>.disabled", true)`、`destroy("<id>")` |
  | 返回值 | `create()` 返回新条目 id（字符串）。语言无变量绑定（[5.2](#52-语法)），因此返回值**只**能直接作为 `destroy()` 的实参在同一表达式内串联：`destroy(create("upgrade", { … }))`；**不能**用作 `set()` 的路径参数或赋值左侧（`set()` 的路径必须是字面量，见 [5.4](#54-内置函数)、D-27）。因此“创建后继续逐字段赋值”只能通过上行的可选稳定 `id` 实现（D-44） |
  | 排序 | 动态条目不写入 `PageDef.entries`，归属只记在存档 `dynamic[].pageId`；页面内排序为 `order` 升序（缺省取递增序号保证稳定），同 `order` 时按 `createdAt` 升序（PRD 补充 5 的稳定排序语义） |
  | 上限 | V1.0 动态条目总数硬上限 2000（D-32），超限**拒绝本次 `create`** 并报 `E_DYNAMIC_LIMIT`（不做部分创建） |
  - **创建成功**：写入 `DynamicRegistry`，**不写项目文件**，只进存档（[6.3](#63-存档文件-schemasavejson)）；预览中该卡片右上角显示“丢弃”按钮（[8.11](#811-游戏视图与卡片字段映射prd-预览区-18)），编辑器列表不显示。
  - **`create()` 必须对重复求值幂等**（易错点）：同一条 `action` 会被反复求值（“每秒生效”每游戏秒一次、每次购买一次），因此**前提条件必须自带守卫**，否则：给了 `spec.id` → 第二次求值报 `E_CREATE_ID_CONFLICT`（整体拒绝、`has(kind, id)` 仍为真）；省略 `spec.id` → 每次求值都新建一个 `dyn_<序号>`，最终撞上 2000 上限报 `E_DYNAMIC_LIMIT`。标准写法是在 `condition` 里加 `!has("upgrade", "<id>")`（[5.4](#54-内置函数) 的 `has()`）；`destroy(create(…))` 这种“创建即丢弃”的串联天然幂等，不受此约束。
  - **`destroy(id)` 只能销毁动态条目**：传入静态条目 id 报 `E_DESTROY_STATIC`（静态条目的增删只能通过编辑器，PRD 未提供运行时删除能力）。销毁时级联清理该条目的 `assignments`、`effectValues` 与页面归属记录。两条触发路径的生效时机不同：表达式内的 `destroy()` 与 `set/create` 一样经 `EffectSink` 在 8.3 第 6 步提交阶段生效（若由 tick 之间的交互触发，则在下一提交阶段生效，见 [8.3.1](#831-交互事件与-tick-边界)）；预览卡片上的“丢弃”按钮是玩家直接操作，**立即生效**且不经 `EffectSink`。
  - **`pageId` 失效的“孤儿”动态条目**（页面在编辑器里被删除、`create()` 指向的页面已不存在、或读档时 `dynamic[].pageId` 找不到对应页面——[6.3](#63-存档文件-schemasavejson) 读档顺序 ②、[7.5](#75-条目列表交互规格) 的删除处理、[6.4](#64-校验与迁移)）：`pageOf()` 返回 `undefined` 时按 `isVisible = false` 且 `isDisabled = true` 处理并记 `E_PAGE_UNKNOWN`（[8.4](#84-可见性与禁用的有效状态页面继承)）。完整口径：
    - **仍保留在内存与存档中**：`dynamic[].pageId` 原样保留、仍占 2000 上限名额（D-32），下次写档不删除它——删档会让“页面被临时改名/删除”的玩家在恢复后丢掉进度；
    - **不渲染、不参与任何结算**：不进入页面卡片、仪表盘统计、产出/购买/“每秒生效”判定（`isEffectivelyVisible` 为假）；
    - **状态字段仍可被表达式读写**（如把它的 `owned` 置正），但因不可见不产生任何效果；
    - **唯一移除路径**是 `destroy(id)`（表达式）或玩家在**预览诊断面板**的“孤儿动态条目”列表里点“丢弃”（[7.1](#71-界面总体布局prd-工作页面一览)）——卡片不渲染，拿不到卡片右上角的丢弃按钮（PRD 预览区 6）。打包产物中页面结构静态、不会产生孤儿条目，该入口只存在于编辑器外壳；
    - **自动恢复**：`pageId` 重新存在（如页面被改回同名 id）后条目立即重新出现，玩家无需任何操作。
- “每秒生效”阶段触发的是**重新计算赋值表达式**，不做叠加（PRD 升级编辑器 11），且只对已拥有（`ownsUpgrade`）、有效可见、有效未禁用的升级触发（[8.3](#83-单-tick-顺序固定时序可预测) 第 2 步、[8.4](#84-可见性与禁用的有效状态页面继承)）。

### 8.8 离线模拟
```
settleOffline(savedAt):
  now = wallClock()
  if now < max(savedAt, lastSeenAt) → 记诊断 E_CLOCK_ROLLBACK；不结算；只把 lastSeenAt 推到 now；return   // 墙钟回拨（R-20）
  if !settings.offlineEnabled → 只更新时间戳
  elapsed = clamp(now − savedAt, 0, offlineCap·3600)
  // 分段推进：前 10% 时间用正常 tickRate，后 90% 用几何增长的粗粒度步长
  segments = geometricSegments(elapsed, baseStep=1000/tickRate, maxSegments=2000, totalStepBudget=20000)
  offline = true
  for seg in segments:
     dt = seg.ms / 1000
     runProductionPhase(dt)                     // 产出结算（含页面继承判定，见 8.4）
     skipPerSecondUpgrades()                    // 离线不触发升级“每秒生效”（PRD 设置页 9）
     skipAutoBuy()                             // 离线不触发自动最大购买
  offline = false
  gameTime += elapsed; offlineAccum += elapsed
```
- 离线时随机函数禁用（PRD 补充 1），价格/产出改用分段线性外推，保证 `8h` 离线在数百条目下结算耗时 < 300ms（基准见 [12](#12-性能预算与优化)）。
- **墙钟回拨直接不结算**（R-20 的落点，伪码第 2 行）：在线时长用 `performance.now()`（单调、不受改系统时间影响，[8.2](#82-主循环请求动画帧驱动)），但离线时长只能用墙钟差值。若 `now < max(savedAt, lastSeenAt)` 说明系统时间被往回改，此时 `clamp(now − savedAt, 0, …)` 要么得到 `0`（白跑一次结算），要么在“改回—再改前”的往复中反复吃到同一段时间；因此实现固定为：**本次不结算任何离线收益、不推进 `gameTime`/`offlineAccum`、只把 `lastSeenAt` 推到 `now`，并记诊断 `E_CLOCK_ROLLBACK`**（[17.1](#171-错误码表)）。读档后立即推进 `lastSeenAt`，避免正常情况下也误判。
- 离线收益上限截断后，剩余时间不累计到 `elapsed`（避免下次再结算同一段时间）。
- 载入后展示“离线收益”提示条：离线时长、实际结算时长（截断后）、各资源增量，并标注“离线不含随机、每秒生效与自动购买”（PRD 设置页 9 与 R-14）。
- **近似来源与误差边界**：分段只引入“段内产出速率不变”的假设。当 `produces[i].amount` 依赖随离线推进而变化的属性（自身或他人的 `owned`、`res.<id>.amount` 等）时，段内取段首速率，段越粗误差越大。约束：① 段数上限 2000、总步数预算 20000（超预算时本段截断、剩余时间顺延到下次结算）；② 单段时长上限 = `offlineCap·3600 / 2000`，并把前 10% 时间保持 `baseStep` 不加速；③ 实现期用性质测试对比“逐 tick 模拟 vs 分段结算”（见 [14.2](#142-关键用例清单抽样)）。
- **“离线收益低于在线”的成立依据，与分段精度是两个独立问题**（修正原表述）：PRD 设置页 9 给出的原因是离线**不触发随机函数、升级“每秒生效”与自动最大购买**，这一点由上方伪码的三处显式 `skip` 保证；本文档**不**因此引入 PRD 未定义的额外打折系数（D-11），也**不**把“离线收益低于在线”说成由分段精度保证。分段精度的方向性结论是：速率**单调递增** → 分段结果恒 ≤ 逐 tick 真值（下界）；速率**单调递减** → 分段结果 ≥ 逐 tick 真值（上界/高估）；速率**非单调**（先增后减）→ 无方向保证。据此：
  1. 对递减 / 非单调速率记诊断 `E_OFFLINE_APPROX`（诊断级，不中断结算），并在离线提示条上向作者标注“本次为近似结算，误差方向取决于速率变化趋势，可能为正”；
  2. “离线 vs 逐 tick”的对照只在**编辑器预览态的诊断面板**提供：对同一场景跑逐 tick 基线并给出相对误差，上限 20000 tick，超出则按采样基线标注“对照已截断”。**不进打包产物**——`8h × 20 tick/s = 576000` tick 的基线无法在玩家载入时实时计算；
  3. 随机函数、`perSecond` 升级、自动最大购买三类机制离线不触发的事实**始终**成立，因此即便分段高估，离线也不会因为这三类机制而超过在线收益；作者若需要严格单调的离线曲线，应把速率写成非递减形式。

### 8.9 仪表盘数据
- 增长速度：对每个资源维护 `rate` = 最近 20 tick 的 `amount` 线性回归斜率（Decimal 差分），展示 `+x/s`。
- “下一个可购买条目预测时间”：**只对当前可购买的条目预测**——先过 8.4 的 `canBuy`（可见、未禁用、未达数量上限、非点击器），升级还需 `conditions` 全部为真；再对每个候选计算 `dt = max_m ( cost_m − res(m).amount ) / rate(m)`（多材料取各材料 `dt` 的最大值，即“全部材料都能付得起”的时刻），取所有候选的最小 `dt`，支持大数除法。
  - **`cost_m` 取“下一件”的单件价格，不是当前件**：按 [8.6.1](#861-只读等级视图价格与条件按第-j-级求值) 的只读等级视图取 `j = target.bought + 1` 求值（与 [8.6](#86-批量--最大--自动最大购买求解) 里的 `P(bought + 1)` 同一公式，同一覆盖层、同一记忆化隔离规则）。用 `bought` 级价格会让预测早于真实可购买时刻——`bought = 0` 时 `P(0)` 与 `P(1)` 在陡峭价格下相差一个数量级。
  - **免费模式直接显示“现在”**：`buyAmount < 0`（自动最大购买、免费，[8.6](#86-批量--最大--自动最大购买求解)）不消耗材料，`dt` 恒为 `0`，不参与价格与速率推算；`buyAmount ≥ 1`（`count`）与 `0`（`max`）才按上式计算。归一化按 [5.9.3](#593-读写实现约定) 的 ①~④ 执行，因此 `buyAmount` 求值失败时沿用上次成功值，不影响本项。
  - 以下情形显示 `—`：无任何可购买条目、相关材料产出速率为 0（永远不会买得起）、已达数量上限（提示“已达上限”）、升级购买条件不满足（悬浮提示“条件未满足”）、以及**点击器**（不可购买，不参与预测，否则会给出永远无法兑现的倒计时）。

### 8.10 游戏内设置页与存档操作（PRD 预览区 9）
- **只读信息**：`meta.name / author / description`、游戏时间（`gameTime` + `offlineAccum`）、最后存档时间（`savedAt`）。
- **可改设置**：数字格式、逻辑帧率、最大步长、存档间隔、是否开启离线收益、离线收益上限。这组值在编辑器设置页叫“游戏默认设置”（项目级，写项目文件），在游戏内是**玩家偏好**，两者分层处理（D-22）：
  - 项目默认值：项目文件 `settings`，只在编辑器设置页修改，随“保存”落盘；
  - 运行时有效值 = 项目默认值 ⊕ 当前会话覆盖（`settingsOverride`）；
  - 预览态：游戏内改设置通过 `game:event{type:'settings'}` 上报，编辑器**只更新 `previewStore` 中的会话覆盖并发 `host:control` 热更新运行时，不写 `projectStore`**（PRD 中它们是“游戏默认设置”，玩一次预览不应改写作者的设计默认值）；`previewStore` 不进历史栈；
  - 打包态：覆盖值随 `localStorage` 键 `incrementforge.settings.<projectId>` 持久化（跨会话保留），不回传编辑器、不进存档文件；页面主题偏好走**另一个**键 `incrementforge.ui.<projectId>`（同上）；
  - 切换项目/“重新开始”均**不**清除覆盖值（属 UI 偏好而非游戏进度），设置页提供“恢复默认设置”按钮清除覆盖。
  - **UI 标注**：每个可改设置旁显示来源徽标（“项目默认” / “本会话覆盖”），已被覆盖的项高亮并提示“仅本会话有效，不会改写作者的项目默认设置”，避免玩家/作者误以为游玩行为会写回项目（D-22）。该徽标是**强制 UI 元素**：不可配置隐藏、不可按平台/分辨率条件移除，缺失即视为实现偏差（单测以 DOM 断言其存在，R-24 的界面侧防线）。
- **“页面主题”开关**：与上面六项同属**玩家偏好层**（D-22），但不是 `ProjectSettings` 的字段，因此单列：
  - 取值为“跟随页面”（空串，默认）或 [17.4](#174-内置图标与主题清单) 的三档内置页面主题（`builtin:page-dark/-light/-midnight`）。**只接受内置 id**：自定义主题是 CSS 文本，让玩家在设置页里随手切换一段未经 `sanitizeTheme` 的 CSS 会绕开 [13](#13-安全与沙箱) 第 5 条的安全过滤，非法值按“不写入、保持 last-good 并记诊断”处理。
  - 生效值 = 覆盖值 ⊕ 作者设定的当前页面主题，停在内置设置页时“当前页面”取 [8.12](#812-页面导航与当前页面prd-预览区-8) 的初始页面。覆盖**只影响本次游玩/预览的观感**，绝不回写作者的页面主题；因此它复用同一套来源徽标（`data-testid="settings-theme-source-badge"`）。
  - 条目主题缺省跟随**生效**的页面主题（[7.8](#78-主题图标与国际化)）：作者没显式配条目主题时，卡片要跟随玩家看到的页面主题，否则“换了页面主题、页面变白、卡片还是暗的”。作者显式配的条目主题不随覆盖而变。
  - 打包态落在 `incrementforge.ui.<projectId>`（**独立于** `incrementforge.settings.`：后者读回来直接当 `settingsOverride` 用，多一个键会让项目默认值凭空多出一个字段）；选“跟随页面”时**删键**而不是写空串；“恢复默认设置”连带清掉它。
- **存档操作**：
  - `导出存档` → 序列化为 `SaveFile`（见 [6.3](#63-存档文件-schemasavejson)）→ 下载 `*.save.json`；
  - `导入存档` → Zod 校验 → 提示「覆盖当前进度」→ 按 [6.3](#63-存档文件-schemasavejson) 的读档顺序完整重建 `GameState`（含 `dynamic`、`assignments`、`effectValues`）→ 触发一次离线结算预览；
  - `重新开始` → 二次确认 → `GameState.reset()`：按 [8.5](#85-购买结算) 的初始化规则用项目文件把全部属性复位、清空 `assignments`/`effectValues`/`dynamic`、重置 `gameTime`/`playtime`（PRD 补充 6、D-18）。若存在“重新开始后无法恢复”的运行时改动，弹窗中明确提示不可撤销。

### 8.11 游戏视图与卡片字段映射（PRD 预览区 1–8）
> 页面跳转的状态与规则见 [8.12](#812-页面导航与当前页面prd-预览区-8)；本节只定义视图结构与卡片字段。
运行时视图组件树与数据来源一一对应，卡片字段全部取自 `AttributeStore` 的生效值（经 [8.4](#84-可见性与禁用的有效状态页面继承) 过滤），不在 UI 层另算一套逻辑：

```
AppView
├─ GameTitleBar          项目名称 meta.name（PRD 预览区 1）
├─ Dashboard             各可见资源的 数量/增长速度 + 下一个可购买条目预测时间（PRD 预览区 2，数据见 8.9）
│                         带展开/收回；展开态正文封顶 30vh 并内部滚动
├─ PageView(pageId)
│  ├─ PageDescription   page.description（PRD 预览区 7）
│  ├─ EntryGrid         columns = min(page.columns, 设备断点列数)（PRD 预览区 5/页面编辑器 7）
│  │  ├─ ResourceCard   图标｜名称｜描述｜右侧数量（PRD 预览区 3）
│  │  ├─ ClickerCard    图标｜名称｜描述｜产量 + “点击”按钮（PRD 预览区 4）
│  │  ├─ GeneratorCard  图标｜名称｜描述｜价格｜产量｜右侧 已购买/拥有 + “购买”按钮（PRD 预览区 5）
│  │  └─ UpgradeCard    图标｜名称｜描述｜条件｜价格｜效果｜右侧 已购买/拥有 + “购买”按钮；
│  │                    动态条目右上角额外渲染“丢弃”按钮（PRD 预览区 6，discard → destroy(id)）
│  └─ （条目 theme 取自 page.entries[i].theme，跟随页面 theme 为默认）
└─ BottomNav             按 page.order 渲染图标+名称；**最后一格固定为内置“设置”页**（PRD 预览区 8），
                         设置页不是 PageDef，不参与可见/禁用继承、不进底部导航数据源；
                         按钮点击一律走 nav()，跳转规则见 8.12
```
- 卡片显隐：`isEffectivelyVisible` 为假不渲染；`isEffectivelyDisabled` 为真时保留卡片但置灰、隐藏“购买/点击”按钮（PRD 页面编辑器 4/5 要求不可购买而非不可见）。
- **仪表盘带展开/收回，且不渲染性能与诊断指标**（PRD 预览区 2）：
  - 仪表盘列出**当前页之外**的全部资源，条目一多就能吃掉整屏——实测 49 个资源时仪表盘自身 623px 高、主区被 flex 压到 `0px`，页面上的卡片**一张都看不见也够不着**（不是难用，是完全不可用），且溢出 `100dvh` 壳层的那部分会落到文档画布上变成一块能滚动的空白。因此仪表盘提供展开/收回开关，展开态正文封顶 `30vh` 并内部滚动；收回后只剩一行标题。离线提示条（[8.8](#88-离线模拟) 末条）同受此约束：它的增量列表按资源数线性增长，`max-height: 18vh`。
  - `tick 耗时` / `帧率` / `诊断` 三项**不在游戏视图里渲染**：它们是作者向信息，唯一去处是编辑器的诊断面板（[7.1](#71-界面总体布局prd-工作页面一览) 末条、[12](#12-性能预算与优化)）。编辑器预览时它们已在预览框正下方重复了一遍（同一份 `game:stats`），打包产物里则是玩家无从处置的数字。数据本身仍在 `GameViewModel` 与 [9.2](#92-消息协议) 的 `game:stats` 里，只是不由游戏视图渲染。
- 卡片上的价格/产量/条件/效果文本均为**格式化后的当前生效值**，随 tick 增量更新（仅变化卡片重渲染，见 [12](#12-性能预算与优化)）。
- **“购买”按钮写的是“点下去会发生什么”，不是“作者配置了什么”**：`count` 模式下按钮上的件数是**当前买得起**的件数（`CardView.buyCount`，由 `batch.affordableInCountMode` 求出，与 `solveBatch` 同一条算术），配置值另存为 `CardView.buyRequest` 供悬浮提示对照；价格行显示的消耗与该件数**一致**，一件也买不起时显示“配置件数的合计”让作者看到还差多少。
  - 由此 `canBuy` 在 [8.4](#84-可见性与禁用的有效状态页面继承) 的**结构性**判定之外还要判**材料**：一件也买不起时按钮禁用、原因写“材料不足”。否则作者看到的是一个亮着、点下去结算 0 件的**死按钮**——而这正是“第二个及以后的生成器买不了”的观感来源。
  - 价格合计的记忆化键必须覆盖结果的**每一个**可变输入：条目自身的 `bought` 版本、每条价格行 `deps`（5.6）里每个属性键的版本、每条价格行的 `materialId` 与对应 `res.<id>.amount` 版本，以及（表达式读了 `time`/`tick` 等内建变量时）当前 `tick`。键不完整的代价不是“多算几次”，而是**永久显示旧价**：维度跃迁类项目把 `g2` 及以后的价格挂在 `gen.g1.bought` 上（`100 * (10000 ^ floor(gen.g1.bought / 10))`），一旦漏掉 `deps`，价格就永远停在开局那个便宜档位。
- 资源卡片无“购买”按钮（资源不可被购买，D-20）；生成器卡片在 `isClicker = true` 时渲染 `ClickerCard` 而非 `GeneratorCard`。
- 底部导航不因页面 `disabled` 隐藏按钮（禁用仍可跳转，PRD 页面编辑器 4），但 `visible = false` 的页面不渲染按钮。

### 8.12 页面导航与当前页面（PRD 预览区 8）
PRD 预览区 8 要求底部导航栏提供“前往各页面的按钮”，但未规定当前页面的初值、跳转约束与是否持久化，本节把这三项收敛为实现规则。

| 项 | 规则 | 依据 |
| --- | --- | --- |
| 状态 | `GameState.currentPageId`（[8.1](#81-核心状态)）；内置设置页不是 `PageDef`，用哨兵 `'__settings__'` 表示，不占用页面 id 空间 | [7.9](#79-项目生命周期新建保存导入导出)（设置页不进 `pages`） |
| 跳转入口 | 唯一入口 `nav(pageId)`：校验 `pages[pageId]` 存在，否则 `E_PAGE_UNKNOWN`；**不**校验 `visible/disabled`——页面禁用仍可跳转（PRD 页面编辑器 4），不可见页面也允许 `nav()` 直达（供“解锁全部”与调试） | [8.4](#84-可见性与禁用的有效状态页面继承) |
| 初始页面 | 载入、新建、重新开始后取 `order` 最小且 `isVisible` 为真的页面；无任何可见页面时取 `order` 最小的页面（**不报错**，“全部页面不可见”是合法中间态）；`pages` 为空时直接停在内置设置页 | PRD 页面编辑器 5 |
| 持久化 | **不写入存档**（D-50）：导航是 UI 会话状态，与 `editorStore`/`previewStore` 口径一致（[7.2](#72-状态管理)），每次载入回到初始页面；`currentPageId` 也不是表达式可写属性，因此不进 [5.9](#59-属性读写矩阵) | 与 [10.3](#103-存档时机) 的存档内容划分一致 |
| 切换副作用 | 切页**不重置**任何条目状态、不改变 tick 时序、不触发/终止自动购买或“每秒生效”；仅改变渲染的 `PageView(pageId)` | [8.3](#83-单-tick-顺序固定时序可预测) |
| 入口收敛 | 底部导航按钮点击、`game:event{type:'nav'}` 回传、运行时内部跳转一律经 `nav()`，不直接写 `currentPageId`，避免出现绕过 [8.4](#84-可见性与禁用的有效状态页面继承) 判定的跳转路径 | [9.2](#92-消息协议) |

## 9. 预览与宿主通信
### 9.1 沙箱模型
- 预览内容运行在 `<iframe sandbox="allow-scripts allow-pointer-lock" srcdoc="...">`（**不加** `allow-same-origin`），iframe 处于不透明源，运行时无法访问编辑器 DOM/存储。
- 运行时脚本通过构建产物注入 `srcdoc`；消息一律带 `sessionId`（随机 16 字节）与 `kind`，宿主校验后才处理。
- **`sessionId` 的传递方式**：由**宿主**生成，随 `srcdoc` 的挂载点一起下发（`<div id="iforge-root" data-session-id="…">`），运行时在 `DOMContentLoaded` 时读取。原因：`srcdoc` 与 `src` 互斥，且宿主发出的第一条消息必然早于运行时注册监听（见 [9.3](#93-生命周期) 第 1 步），没有第二个可用注入口。两端必须共用**同一个** id——各自生成会让运行时把 `host:init` 当成伪造消息丢弃（`reason: 'session'`），表现为预览永远停在“连接中”。
- 运行时与游戏视图代码放在独立 app `apps/runtime-shell`（[3.1](#31-目录树)），由编辑器的构建插件打成单文件 IIFE 注入；该 app 只有这一份入口，`iframe-entry.ts`（注入 `srcdoc`）与 `main.ts`（直挂调试页，注入 `window.__IFORGE_BOOTSTRAP__`）共用同一套装配代码，因此预览与打包产物走同一条路径（ADR-05）。
- **两处“运行时”不是一回事**：预览区里跑的是 `apps/runtime-shell` 的**真实运行时**（渲染 + 结算）；编辑器表达式框背后的“影子运行时”只做试算与校验、不渲染（[5.8](#58-表达式编辑器交互)、[7.6](#76-工作区实现要点)）。两者复用同一个 `@iforge/runtime` 包，因此不存在“两份结算规则”。
- **设备模拟**（PRD 预览区“手机/平板/自适应”）：`host:control{action:'device', value}` 设置预览容器宽度与 `pointer: coarse` 模拟。

  | 档位 | 视口宽度 | 行为 |
  | --- | --- | --- |
  | `phone` | 390×844 | 单列网格、底部导航固定、卡片纵向排列 |
  | `tablet` | 834×1112 | 两列网格、导航可横排 |
  | `auto` | 容器宽度 | 按容器断点切换（< 640 / < 1024 / ≥ 1024） |

  布局差异只由 CSS 断点 + 网格列数覆盖实现，不做第二套渲染逻辑；页面 `columns` 与设备断点取较小值作为实际列数。

### 9.2 消息协议
所有消息 `{ v: 1, sessionId, kind, payload }`，`kind` 枚举与方向：

| kind | 方向 | payload | 说明 |
| --- | --- | --- | --- |
| `host:init` | H→R | `{ project, save?, settings, theme, locale }` | 初始化运行时；`currentPageId` 不在 payload 中，由运行时按 [8.12](#812-页面导航与当前页面prd-预览区-8) 的初值规则自选 |
| `host:patch` | H→R | `{ patches: Array<{ op: 'upsert'/'remove'/'meta'/'settings', target, id?, data? }> }` | 增量热更新 |
| `host:control` | H→R | `{ action: 'pause'/'resume'/'restart'/'speed'/'unlockAll'/'device'/'settings'/'discard', value? }` | 模拟设置栏与真机设置；`settings` 用于把游戏内设置页产生的**会话覆盖**下发给运行时（不改项目文件）；`discard`（`value` 是动态条目 id）供预览诊断面板丢弃**孤儿动态条目**——它们的卡片不渲染（[6.3](#63-存档文件-schemasavejson) 读档顺序 ②、[8.7](#87-升级效果与动态条目)），因此宿主是唯一能触达 `destroy(id)` 的路径 |
| `host:save` | H→R | `{ silent }` | 请求运行时导出存档（经 postMessage 回传） |
| `game:ready` | R→H | `{ engineVersion, warnings[] }` | 运行时就绪 |
| `game:stats` | R→H | `{ rates, nextBuy, tickMs, fps, perf?, orphans?, advice? }` | 仪表盘数据节流上报（≤10Hz）。三个可选字段都走这条通道而不另开 `kind`（它们都是“给宿主看的低频快照”，开新 kind 只会让本表与两端的 `switch` 都膨胀）：`perf` 是 [12](#12-性能预算与优化) 要求的四项性能采样、`orphans` 是孤儿动态条目 id（[7.1](#71-界面总体布局prd-工作页面一览) 末条的丢弃入口）、`advice` 是需提示作者改写价格形状的实体键（[8.6](#86-批量--最大--自动最大购买求解) 末条）。**可选**：旧宿主忽略即退化为 M4 行为（与 `game:save.intent` 的可选策略一致，D-51） |
| `game:event` | R→H | `{ type: 'click'/'buy'/'nav'/'discard'/'settings'/'theme', target, payload? }` | 用户交互回传；这四类交互的**结算时机**（状态即时、副作用在下一提交阶段）见 [8.3.1](#831-交互事件与-tick-边界)，`nav` 仅为跳转事件回传（跳转本身已在运行时经 `nav()` 完成，宿主不回写页面状态，见 [8.12](#812-页面导航与当前页面prd-预览区-8)）；`settings` 仅为当前会话的设置覆盖值，宿主只写 `previewStore`（见 [8.10](#810-游戏内设置页与存档操作prd-预览区-9)），不写项目文件；`theme` 是内置设置页“页面主题”开关产生的会话偏好（`payload: { theme }`，被拒时带 `rejected: true`），它与 `settings` 同层但**不是** `ProjectSettings` 的字段，因此单列一个 type 而不是塞进 `settings` 的 payload——后者会让 `settingsOverride` 长出一个项目文件里不存在的键 |
| `game:save` | R→H | `{ save, intent? }` | 运行时产出存档，交由编辑器持久化。`intent` 为**可选**字段（D-51）：缺省或 `'autosave'` = 自动存档 → 宿主写入 IndexedDB；`'export'` = 玩家点了“导出存档”（PRD 预览区 9）→ 宿主下载 `*.save.json`。没有它宿主无法区分两者（自动存档会弹下载框，或“导出存档”永远不下载） |
| `game:error` | R→H | `{ code, message, where, tick }` | 运行错误与诊断 |

安全校验：未知 `kind`、错误 `sessionId`、超大 payload（> 8MB）一律丢弃并计数；宿主不解析 `game:*` 之外的结构。

协议常量与校验函数（`kind` 枚举、方向、`buildMessage`/`acceptMessage`、`sessionId` 生成、payload 上限）实现在 `@iforge/runtime`（`src/protocol.ts`），宿主与运行时**引用同一份**而不是各写一次：两份校验迟早会出现“宿主认为合法、运行时丢弃”的静默不同步，而这种失效在界面上没有任何提示。

### 9.3 生命周期
1. 编辑器挂载 → 创建 iframe → 立即发 `host:init`，**并在 iframe 的 `load` 事件上再发一次同一条**。原因：`append` 之后 `iframe.contentWindow` 立刻可用（指向同步创建的 `about:blank`），而 `srcdoc` 的解析与脚本执行在后续任务里才发生——此刻投递的消息送进的是那个即将被替换掉的空文档，运行时听不到，表现为“预览一直显示连接中”。`load` 保证脚本已执行。重复送达幂等：`applyInit` 整体重置本局（[8.5](#85-购买结算)），且补发只发生在启动窗口内。
2. 运行时读到 `host:init` → 装入项目与存档 → 挂载游戏视图、启动渲染循环 → 回 `game:ready`；宿主收到后解锁交互、启用“打包”按钮。`host:init` 到达**之前**运行时**不挂载任何 DOM**：没有项目就没有可显示的状态，早挂一帧会闪一个不是运行态的“空页面”。
3. 编辑器改动 → `host:patch`；运行时报 `game:error` → 诊断角标（可点击展开错误列表）。
4. 关闭项目/卸载 → `host:control{restart}` 或直接销毁 iframe，释放 tick。

## 10. 存档与持久化
### 10.1 IndexedDB 结构
数据库 `incrementforge`（版本 1）：
| Object Store | Key | Value | 索引 |
| --- | --- | --- | --- |
| `projects` | `projectId` | `ProjectFile` | `by-modifiedAt` |
| `assets` | `assetId` | `{ mime, blob, name }` | — |
| `saves` | `${projectId}:${slotId}` | `SaveFile` | `by-projectId` |
| `meta` | `key` | 编辑器偏好、当前项目指针 | — |

- 项目“保存”写 `projects`（Zod 校验后事务写），并更新 `modifiedAt` 与 `engineVersion`（PRD 设置页 5）。
- 打包与“导出存档”走同一条序列化路径，保证编辑器与游戏一致。
- **存档位**：V1.0 固定 `slotId = 'main'`（PRD 补充 8 单存档），存档文件的 `slotId` 字段（[6.3](#63-存档文件-schemasavejson)）与本键保持一致；多存档只需放开 `slotId` 枚举并让 UI 选择，不改序列化格式。

**资产解析链路**（`IconRef`/`ThemeRef` 的 `kind: 'asset'` 与 `ProjectFile.assets` 之间的完整流程，[6.1](#61-公共字段) 定义了结构，此处定义流转）：

| 阶段 | 行为 |
| --- | --- |
| 上传落库 | `IconPicker`/`ThemePicker` 上传的图标与主题先经 [13](#13-安全与沙箱) 第 4/5 条过滤，写入 `assets` store（键 `assetId`）；项目内一律以 `{ kind: 'asset', value: assetId }` 引用，**不在项目模型内联 data URL** |
| 载入 | 打开项目时按 `assets` store 把 `kind: 'asset'` 解析为内存中的 data URL 供预览与打包使用；`kind: 'builtin'` 不查库（[17.4](#174-内置图标与主题清单)） |
| 保存 / 导出规范化 | 把**被引用**的资产记录内联进 `ProjectFile.assets`（[6.2](#62-项目文件-schemajson)），并把引用重写为 `{ kind: 'data', value }`；未被任何条目引用的资产从 `ProjectFile` 剔除（仍保留在 `assets` store 供后续复用） |
| 打包 | 与导出同一条路径；`kind: 'builtin'` 的 SVG path 直接内联，上传资产转 `data:`（[11.1](#111-构建管线)、[11.2](#112-体积与优化)） |
| 体积约束 | 单资产 ≤ 64KB（`E_ASSET_TOO_LARGE`），项目文件整体 ≤ 16MB（[13](#13-安全与沙箱) 第 6 条），打包前逐项校验（[11.1](#111-构建管线)） |

### 10.2 导入 / 导出
| 操作 | 行为 | 校验 |
| --- | --- | --- |
| 导入项目 | 读取 `.json` → Zod 校验 → 迁移 → 冲突处理：V1.0 为单项目管理，只提供“**覆盖当前项目**”与“**取消导入**”两个选项（[1.2](#12-范围)、[15](#15-扩展框架预留)）；“另存为新项目”属多项目管理预留接口，不在 V1.0 实现（D-33） | `E_SCHEMA` / `E_MIGRATION_FAIL` |
| 导出项目 | 序列化为格式化 JSON，资产内联为 `data:` | 导出前跑一次校验 |
| 导入存档 | 校验 `format/version`，按 [6.3](#63-存档文件-schemasavejson) 的读档顺序重建，可选“覆盖当前进度” | 版本不兼容 → 只读模式；悬空引用 → `E_DANGLING_REF` 降级为不显示 |
| 导出存档 | 下载 `*.save.json` | — |
| 新建项目 | 见 [7.9](#79-项目生命周期新建保存导入导出)，写默认模板并落盘 | Zod + 跨条目一致性校验 |

### 10.3 存档时机
- 自动存档间隔（默认 30s）、页面 `visibilitychange → hidden`、`beforeunload`、进入离线结算前。
- 打包版无 IndexedDB 权限隔离问题，使用 `localStorage`（键 `incrementforge.save.<projectId>`）并保留导出/导入按钮。

## 11. 游戏打包
### 11.1 构建管线
```
项目内存模型
  → 序列化 ProjectFile（资产内联为 data: URL，自定义主题内联为 CSS 文本）
  → 运行时产物 runtime.iife.js（esbuild 单文件 IIFE，无外部依赖）
  → 模板 index.html + <script> 注入 project JSON
  → 模板拼装：JS/CSS 文本直接内联，无外链
  → dist/<项目名>.html（单文件、离线可玩）
```
- **运行时产物的来源只有一个约束**：必须是 [9.1](#91-沙箱模型) 注入预览的那份字节，不允许打包再编一次（D-54）。编辑器侧取自构建期插件产出的字符串常量（虚拟模块 `virtual:iforge-runtime-shell`），因此浏览器里**不跑** esbuild；Node 侧（CLI / E2E）取 `@iforge/build/node` 的 `compileRuntimeBundle()`。两端都用 `format: 'iife'` + `target: es2022` + `minify` + `drop: ['console']` + CSS 以文本内联，保证“预览能跑”与“产物能跑”不分叉（ADR-03）。
- 运行时在单文件内直接挂载（不使用 iframe 与 postMessage，ADR-05）：模板中以 `window.__IFORGE_BOOTSTRAP__` 注入项目数据，运行时 `boot()` 后替换 `#app`。
- 打包前校验（任一失败即中止并列出问题位置）：
  1. **表达式**：全部字段可编译（语法、未知变量、禁用函数、`set()` 目标为字面量路径）；**静态依赖环**检查——对项目文件内全部表达式的 `deps` 建有向图（被引用者 → 引用者），检出环即报 `E_CYCLE` 并给出环路径。**静态/运行期分层**（与 D-08 不冲突）：仅由项目文件静态表达式构成的依赖环在此静态拦截；凡涉及动态创建、运行时改 `materialId`、表达式文本热替换的依赖，静态图天然不完整，由运行期求值重入检测兜底（[5.7](#57-求值调度与性能)）；
  2. **赋值权限**：按 [5.9](#59-属性读写矩阵) 校验，无 `E_READONLY_TARGET` / `E_ASSIGN_TYPE`；
  3. **条目引用完整性**：价格材料、产出目标、`PageDef.entries[].id` 无悬空引用（`E_DANGLING_REF`）；**`id` 命名**符合 [6.1](#61-公共字段) 的 `ID_PATTERN` 且不以 `dyn` 开头（`E_ID_INVALID`，D-45）；
  4. **页面唯一性**：同一条目未被分配到多个页面（`E_DUPLICATE_PAGE_ENTRY`，PRD 补充 7）；
  5. **动态创建**：`create()` 调用点的 `spec` 键名必须在白名单内（[5.2](#52-语法)、[8.7](#87-升级效果与动态条目)，未知键 `E_CREATE_FIELD_INVALID`），`page` 参数必须为已知页面（未知报 `E_PAGE_UNKNOWN`）；
  6. **资产**：体积与格式合规（`E_ASSET_TOO_LARGE`）；
  7. **设置**：`tickRate > 0`、`maxFrameStep > 0`、`autosaveInterval > 0`、`offlineCap ≥ 0`。
- 产物元信息：写入 `engineVersion`、打包时间、项目指纹（对 ProjectFile 求哈希），用于存档兼容判断。

### 11.2 体积与优化
- 图标：内置图标用 SVG 内联 path（不占体积）；上传图标压缩为 ≤ 32KB 的 PNG/WebP data URL，超限提示用户更换（`E_ASSET_TOO_LARGE`，64KB 硬上限，与 [10.1](#101-indexeddb-结构) 的资产约束一致）。
- 代码分割不可行（单文件），通过 `minify` + `drop: ['console']` 控制体积；目标产物 < 1.5MB（gzip < 500KB）。

## 12. 性能预算与优化
| 指标 | 目标 | 手段 |
| --- | --- | --- |
| 单 tick（200 生成器 + 100 升级 + 50 资源） | p95 < 4ms | tick 记忆化 + 属性版本脏标记 + 稳定排序 + 预编译闭包 |
| 表达式编译 | < 1ms/条，缓存命中 ~0 | 编译缓存（8192）+ 常量折叠 |
| 批量最大购买（1e1e10 量级） | 单次 < 8ms | 形状识别 + 闭式求和（等比 / 指数+常数 / 指数+线性 / 线性）+ 二分；多材料逐材料求解取 `min`；升级条件在 `count`/`max` 下按前缀语义求解（单调条件二分快路径，非单调条件逐级确认并按 tick 预算分摊）；`free` 只校验末级、只需 `P` 单调，典型 ≤ 20 次求值收敛（[8.6](#86-批量--最大--自动最大购买求解)） |
| 批量购买降级最坏情况（形状未知 / 递减或负价格 / 非单调条件） | 单 tick ≤ 1e5 次求值，跨 tick 分摊；`free` 模式在 `P` 单调时**不降级** | 按预算分摊 + 卡片显示“计算中…” + 作者改写建议文案；诊断码与 UI 行为见 [8.6](#86-批量--最大--自动最大购买求解)（`E_BATCH_MONOTONE`）与 [8.6.2](#862-升级购买条件的前缀语义-solvebyconditionprefix)（`E_BATCH_CONDITION`） |
| 离线结算（8h，300 条目） | < 300ms | 分段几何步长 + 关闭随机/每秒生效/自动购买 |
| 渲染 | 60fps | 卡片列表虚拟化（当前页 > 40 张可见卡片时启用，D-56）+ 增量 DOM diff（仅变化卡片更新） |
| 撤销/重做 | < 16ms | immer patches + 合并窗口 |
| 表达式求值预算 | 20000 次/tick | 硬上限 + 诊断告警 |
| 格式化 | ≥ 10000 次/s | LRU 缓存 |
| 打包产物 | < 1.5MB | 内联压缩 + tree-shaking |

监控：预览诊断面板显示 tick 耗时、求值次数、缓存命中率、格式化次数；性能回归由基准测试守护（`tools/bench`）。三项计数都由**运行侧**算好再随 `game:stats.perf` 上报（9.2）：宿主只有消息、没有求值器，让编辑器自己复算就得把 `ExpressionRuntime` 再实例化一份——那正是 ADR-03 要避免的“两套逻辑”。

## 13. 安全与沙箱
1. **表达式**：不使用 `eval`/`Function`；词法层黑名单 `__proto__`、`constructor`、`prototype`、`import`、`await`、`=>`、`;`、`(` 无限嵌套（嵌套深度上限 64，超限 `E_PARSE_DEPTH`）；表达式总长度上限 2000 字符。
2. **对象/数组字面量**（[5.2](#52-语法)）：仅允许作为 `create()` 的 `spec` 实参及其内部嵌套，其它位置出现 `{`/`}`/`[`/`]` 一律编译期 `E_LITERAL_NOT_ALLOWED`——不允许通过“数据字面量”绕过白名单作用域构造任意对象。键名走与 `GeneratorDef`/`UpgradeDef` 同一份字段白名单（未知键 `E_CREATE_FIELD_INVALID`，**编译期**判定，不留到运行期）；不支持展开运算符 `...`、计算键名与变量键；字面量自身嵌套 ≤ 4 层（计入总深度 64），单数组 ≤ 64 项；字面量在编译期静态折叠为常量，不在运行期生成任意深结构。
3. **预览隔离**：iframe 不带 `same-origin`，运行时无法读写编辑器存储；消息协议带 `sessionId` 与长度上限。
4. **资产**：上传图片仅接受 `png/jpeg/webp/svg+xml`，解码后重编码为 data URL，禁用外部引用 URL。SVG 按**白名单**过滤：只保留形状/文本/渐变/描边类标签与安全属性，剔除 `<script>`、`<foreignObject>`、`<use>`（含 `xlink:href`/`href` 外部引用）、`<image>`、`<animate*>`、`<set>`、全部 `on*` 事件属性，以及 `style` 中的 `url()`/`javascript:`；元素嵌套深度与体积超限报 `E_ASSET_INVALID`。
5. **自定义主题**：只接受 CSS 文本，注入到 `style` 标签。过滤规则：剔除 `@import`、`expression()`、`javascript:`/`vbscript:`（含 `url(java\script:...)` 这类注释绕过），**禁止一切非 `data:` 的 `url()`**（自定义主题不得引用外部图片/字体，只能用 `data:` 或内置令牌），并对 `<`/`>` 做转义以防闭合 `</style>` 逃逸；过滤后仍做令牌完整性校验，缺 `--iforge-*` 变量回退默认（D-13）。
6. **导入文件**：大小上限 16MB，Zod 严格模式解析，拒绝 `__proto__` 键（Zod + `Object.create(null)` 双保险）。
7. **循环与死循环**：表达式无循环语法；递归风险通过深度上限与 `E_BUDGET` 兜底。

## 14. 测试与质量保障
### 14.1 测试分层
| 层级 | 工具 | 覆盖 |
| --- | --- | --- |
| 单元 | Vitest | `num` 饱和/格式化/分层比较；解析器与静态校验错误码；表达式求值（各上下文）；购买结算与批量求解；tick 时序；离线分段；存档序列化往返 |
| 快照 | Vitest snapshot | 项目/存档 Schema 序列化格式、表达式 AST、格式化输出、错误文案 |
| 属性/性质 | fast-check | 大数运算满足交换律/结合律（可交换集）、`applyCap` 单调性、求解器与暴力解一致 |
| 集成 | Vitest + jsdom | 影子运行时与编辑器 store 同步、撤销重做一致性、协议消息往返 |
| 端到端 | Playwright | 编辑器加载示例项目 → 预览模拟 → 点击/购买 → 保存 → 导出项目 → 打包 → 打开单文件 HTML 游玩 → 导出存档 → 重新导入 |
| 基准 | Vitest bench | tick、批量购买、离线结算、格式化吞吐 |

### 14.2 关键用例清单（抽样）
- 购买 `1e1e10` 数量生成器：价格闭式求和不超时，数量上限正确截断。
- **数值饱和边界**（P2/R-01）：`NUM_MAX = 10 ↑↑ 1e15` 可构造、可比较（`NUM_MAX > 1e1e1e10`）、可格式化（五种格式都不抛异常、不输出 `NaN`/`undefined`），`NUM_MAX + 1`、`NUM_MAX * 2`、`NUM_MAX ^ 2` 饱和为 `NUM_MAX` 且 `isSaturated() === true`；饱和值参与购买/产出/价格求解时结果有限且不超时；`toNumber()` 在超界时夹到 `±Number.MAX_VALUE`（[4.3](#43-num-数值层-api)）。
- 价格表达式使用 `rand()` → 编辑器报 `E_RAND_DISABLED`，运行时不生效。
- 离线 8h：随机函数不触发、每秒生效升级不触发、自动最大购买不触发、资源增长低于在线。
- 升级批量最大购买：只结算最后一级的效果数值。
- 多材料批量购买：`costs = [r1: 10·1.15^b, r2: 5·1.20^b]`，`k = min(k_r1, k_r2)`，与暴力逐件模拟结果一致（fast-check 性质测试）。
- **批量求解的只读等级视图（8.6）**：价格文本 `10 * 1.15 ^ gen.g1.bought`、`bought = 0` → 求第 5 级价格得 `10 · 1.15⁵`；求解结束后 `bought` 仍为 `0`、该属性 `version` 未变、`assignments` 无新键；同一 tick 内连续求 `j = 1..10` 的结果互不相同（验证记忆化缓存按覆盖层隔离，不互相命中）；条件侧 `atLevel` 与价格侧 `j` 用同一覆盖层（条件按真实 `bought` 求值会得到错误件数，用例断言二者对齐）。
- 升级批量购买条件逐级生效：条件依赖 `bought` 时，买到的每一级都满足条件；条件在中间变为假时停止扩张。
- **升级批量购买条件的“中间为假”反例**（前缀语义，8.6）：`count` 与 `max` 模式下，条件为 `gen.g1.bought == 0 || gen.g1.bought >= 5`、`bought = 0` 时执行购买 → 断言只买到 1 件（`bought = 1`），**不能越过等级 1~4 这个空洞**（只校验末级会买到 10 件）；对同一条件做 fast-check 与暴力逐件模拟比对；**阈值型** `gen.g1.bought >= 5` 在 `bought = 4` 时必须买 0 件（早先按“成交之后一级”判定会在这里一次买满 10 件），`bought = 5` 时才按 `buyAmount` 买满；“下一档”型 `(up.u2.bought==k && gen.gN.bought>=1) || …` 必须能一路买满 `up.u2.max`（否则 `up.u2.effectValues[i]` 永远为 0，引用它的**产出表达式**乘不上倍率）；单调条件 `gen.g1.bought >= 5` 的快路径结果与逐级模拟完全一致；`free`（自动最大）模式按 PRD 只校验末级，断言结果与“末级语义”暴力解一致而非与前缀解一致。
- **每秒生效的时间基准**：同一 `perSecond` 升级在 `1×` 下每真实 10 秒触发 10 次、在 `10×` 下触发约 100 次（断言 `触发次数 ≈ gameTime 增量`，允许单 tick 至多一次的量化误差）；倍速切换时 `gameTime` 连续不跳变；暂停/恢复后不重复触发；离线结算不触发但 `gameTime` 按离线时长推进。
- 升级多条效果：两条前提同时为真 → 两条都生效（不 `break`）；第一条为假、第二条为真 → 只有第二条生效。
- **升级效果生效前提（D-43）**：`initial = 0`、未购买、`effects[*].condition = "true"` 的升级 → 每秒阶段与 `applyEffect` 均不生效（`effectValues[*]` 保持 `0`，其它属性无变化）；`buyOne` 购买成功后**立即**结算自身全部效果，下一 tick 的每秒阶段再次重算（重算不叠加）；批量购买在 `owned += k` 后只结算最后一级的全部效果；`k = 0` 时不结算；被其它升级把 `owned` 置正（`bought` 仍为 `0`）后，下一 tick 该升级开始生效（验证判定用 `owned` 而非 `bought`）。
- 页面禁用/不可见继承：页面禁用后该页生成器不产出、升级不每秒生效、不可购买，但底部导航仍可跳转；恢复后行为恢复。
- **页面导航（8.12、D-50）**：新建/重新开始/读档后停在 `order` 最小且可见的页面；全部页面不可见时回退到 `order` 最小的页面而不报错；`pages` 为空时停在内置设置页；页面 `disabled = true` 时导航按钮仍可跳转，`visible = false` 时按钮不渲染但 `nav(pageId)` 仍可直达；切换页面不重置任何条目状态；导航状态不写入存档（导出存档中无当前页面字段）。
- 初始化规则：非点击器生成器 `bought = initial` 且价格受其影响；点击器 `bought = 0`、`owned = initial`；升级 `bought = initial`。
- `effectValues` 用户赋值：`action` 内 `effValue = 3` 后 `up.<id>.effectValues[0] = 3` 并落存档；重新开始后回到 `0`。
- 表达式文本热替换：运行时把 `effects[0].action` 赋为新文本 → 下一 tick 用新文本；赋为语法错误文本 → 报 `E_PARSE` 且保留旧文本。
- 写只读属性（`gen.g1.perSec = 1`、`page.p1.columns = 3`）→ 编译期 `E_READONLY_TARGET`。
- 动态创建升级：`page` 缺失报错；`page` 不存在报 `E_PAGE_UNKNOWN`；正常创建后项目导出文件不含该条目，存档含。
- 条目页面唯一性：把同一条目分配到两个页面 → 保存时报 `E_DUPLICATE_PAGE_ENTRY` 并定位到两个 `entries` 下标。
- 撤销“重命名” → 左侧列表与预览同步回退。
- 游戏内设置页改设置 → 预览态只更新会话覆盖，项目文件的 `settings` 不变；打包态刷新后覆盖值仍在。
- 导入旧版本项目文件 → 迁移成功；损坏文件 → 明确错误路径。
- **点击器不可购买（硬约束）**：`isClicker` 生成器 `canBuy` 恒假；`buyOne`/`solveBatch` 报 `E_CLICKER_NOT_BUYABLE`；把点击器的 `buyAmount` 写成 `-1` 后连续 100 tick，自动购买阶段始终跳过它；卡片无“购买”按钮，同时断言运行时路径同样被拒绝（不能只测 UI）。
- **产出结算不含 `owned²`**：单件速率 `1`、`owned = 10`，10 tick 后资源增量 = 100；把 `produces[0].amount` 热替换为 `"2"` 后增量 = 200；表达式里已乘过 `owned` 的写法不得被再乘一次。
- **表达式文本属性的赋值语义**：`= "2"` → 字段变为常量 `2`；`= 2 * gen.g1.owned` → 字段变为常量文本 `10`（不是表达式）；`= true` → `E_ASSIGN_TYPE` 且保留旧文本；`= "2" + gen.g1.owned` → `E_TYPE`（无字符串拼接）；热替换后 `assignments` 记录 `{ value, expr }`（`expr` 为右侧源码、仅审计，读档不回放）；[5.9.3](#593-读写实现约定) 的“可做/不可做”对照表中每个 ❌ 示例都断言为上述对应错误码或常量写入行为。
- **NumExpr 数值字段的赋值形态**：`gen.g1.initial = 2 * gen.g1.owned` → `initial` 字段文本变为常量 `10`（不回写源码）；`gen.g1.initial = "1e10"` → 字段文本变为 `1e10`（字符串**原样成为新源码**，与 `set("gen.g1.initial","1e10")` 等价）；`= "res.r1.amount * 10"` → 字段文本变为该引用式并随运行时状态变化；`= "abc"` → 下一 tick 报 `E_PARSE` 且**保留旧文本**；`= true` / `= null` → `E_ASSIGN_TYPE` 且保留旧文本；`gen.g1.max = 0` → 按 1 处理并记 `E_CAP_NON_POSITIVE`；数值属性的 `assignments.value` 为归一化后的十进制文本，读档以顶层字段为准（`value` 与顶层一致，无 `E_SAVE_FIELD_CONFLICT`）。
- **动态条目读档顺序**：存档含 1 个动态升级、其 `conditions[0]` 被赋值过、`bought/owned/effectValues` 非零 → 读档后动态条目存在、`pageId` 正确、条件文本为赋值后的新文本、数值全部恢复，无 `E_SAVE_FIELD_CONFLICT`。
- **`pageId` 失效的动态条目（8.7）**：动态升级的 `pageId` 指向已删除的页面 → 读档后条目**仍在存档与内存中**（`pageId` 原样保留、计入 2000 上限）、不渲染、不产出/不参与仪表盘，记 `E_PAGE_UNKNOWN`；预览诊断面板的“孤儿动态条目”列表可见该条目并提供“丢弃”；把页面 id 改回后条目自动重新出现，无需玩家操作；`destroy(id)` 与面板“丢弃”两条路径都能彻底移除它。
- **页面禁用对资源无影响**：页面 `disabled=true` 时资源卡片不置灰、`amount` 仍随存量生成器增长、底部导航可跳转；生成器停止产出、升级不每秒生效。页面 `visible=false` 时资源一并隐藏。
- **`isClicker` 动态切换**：生成器→点击器后停止自动产出、`canBuy` 恒假、卡片变 `ClickerCard`、`bought/owned` 未被重置；切回后产出与购买恢复。
- **存档往返覆盖全部可写属性（6.3，重点回归曾遗漏的 `isClicker`）**：把 5.9.1/5.9.2 中每个可写属性在运行时改写一遍（条目的 `description/visible/disabled/initial/max/amount/bought/owned/buyAmount/isClicker/perSecond/effectValues[i]/costs[i].materialId|amount/produces[i].materialId|amount/conditions[i]/effects[i].condition|action`，页面的 `visible/disabled/description`；静态条目与动态条目各一轮）→ 导出 `SaveFile` → 断言**每个顶层字段与 `assignments` 键都落盘**（逐字段 diff Schema 键集合，并断言 `resources`/`generators`/`upgrades`/`pages` 四类实体都带 `assignments` 容器，缺一即失败）→ 重新导入后逐项等值、`bought/owned` 未被重置、无 `E_SAVE_FIELD_CONFLICT`；`重新开始` 后全部回到项目文件值且 `assignments/effectValues/dynamic` 清空。
- **`Infinity` 字面量与“无上限”（D-46、R-36）**：项目文件 `max = "Infinity"` 与 `create()` 缺省 `max` 均编译通过（**不得**报 `E_UNKNOWN_IDENT`/`E_PARSE`），运行期 `applyCap` 完全跳过钳制（把 `amount` 写到 `1e1e10` 不被截断）；`isInf(max)` 与 `max === NUM_MAX` 两种写法效果一致；`Infinity` 用作 `costs[i].amount` 时折算为 `NUM_MAX` 并记 `E_OVERFLOW`（该材料永远买不起）、用作 `produces[i].amount`/`effectValues[i]` 时折算为 `NUM_MAX`、`Infinity < x` 比较按 `+∞` 判定且不饱和、`buyAmount` 求值为 `Infinity` 时按 `E_BUY_AMOUNT_INVALID` 保持 last-good；`max` 求值为 `NaN`（`0/0`）按 1 处理并记 `E_CAP_NON_POSITIVE`；`Num.format(INF)` 输出 `∞`。
- **静态 `id` 命名约束（D-45、R-35）**：导入含 `my-gen`、`a.b`、`中文id`、`dyn_1`、长度 > 32、缺类型前缀（`x1`）或跨四类重名的项目文件 → 逐个报 `E_ID_INVALID` 并定位到具体条目路径（如 `generators[3].id`）；合规 id（`r1`/`g7`/`u23`/`p2`/`uTmp`）的表达式路径、`set()` 字面量路径、复制与导出均正常；静态 `id` 禁用 `dyn` 前缀后，`create()` 省略 `spec.id` 生成的 `dyn_<序号>` 永不与静态条目冲突；条目 `id` 出现在四类列表中顺序无关且复制生成的新 id 同样合规。
- **批量求解的闭式族与 `free` 免闭式二分（D-48、R-03）**：价格 `A·q^j`、`A·q^j+B`、`A·q^j+B·j+C`、`A·j+B` 四族各取随机参数，闭式 `C(k)` 与暴力逐级求和一致（fast-check）；同一价格文本在采样点与**未见采样点**（`3h`/`11h`）上拟合一致，改动未被采样的系数后必须识别失败并降级；`free` 模式下价格写成 `10 * 1.15 ^ gen.g1.bought + 5`（非纯等比但单调）时，求值次数 ≤ 20 且结果等于“末价 ≤ amount 的最大整数”的暴力解，不触发迭代分摊；递减价格记 `E_BATCH_MONOTONE` 且不误用闭式；付费 `max` 模式遇到不可闭式形状时按 1e5 次/tick 分摊并显示“计算中…”、连续 60 tick 未收敛时出现作者改写提示文案。
- **离线近似误差的方向性（D-49、R-14）**：同一场景下“逐 tick 模拟”与“分段结算”对比——单调**递增**速率分段结果 ≤ 逐 tick 结果且相对误差 ≤ 1%；单调**递减**速率分段结果 ≥ 逐 tick 结果（高估方向）并记 `E_OFFLINE_APPROX`；先增后减的非单调速率不抛错、记诊断且不承诺方向；随机函数/每秒生效/自动购买三类机制在任一场景下都不触发。
- **`effectValues` 的编辑器语义（7.6、PRD 升级编辑器 12、D-47）**：升级效果列表“效果数值”列为只读（无输入框、DOM 中不存在可聚焦的数值输入元素、不产生历史记录、不参与项目文件比对），显示影子运行时的当前值、无运行态时为 `0`；提供两条快捷插入模板（`effValue = <表达式>` / `up.<id>.effectValues[i] = <表达式>`）可一键写入“效果内容”；导出项目文件不含 `effectValues`；导出存档含 `effectValues` 且读档还原。
- **`bought`/`owned` 独立可写**：写 `owned` 不改变下一件价格；写 `bought` 立刻改变下一件价格；`owned` 超 `max` 被 `applyCap` 截断；点击器 `bought` 可写但购买仍被拒。
- **`create()` 的 spec 校验与重复求值幂等**：缺 `page` → `E_CREATE_NO_PAGE`；未知 `page` → `E_PAGE_UNKNOWN`；`spec` 含 `kind`/`buyDelay` → `E_CREATE_FIELD_INVALID`（`id` 是可选字段，见下）；省略 `costs` 时取默认空列表且可正常创建；`destroy(静态id)` → `E_DESTROY_STATIC`；动态条目总数超 2000 → `E_DYNAMIC_LIMIT`；带 `spec.id` 的 `create()` 在同一条 `action` 被重复求值（每秒阶段 × 2 次）后**只存在一个条目**（`condition` 带 `!has("upgrade","uTmp")` 守卫），去掉守卫则第二次报 `E_CREATE_ID_CONFLICT`；省略 `id` 连续重复求值按次新建并在超 2000 时报 `E_DYNAMIC_LIMIT`。
- **动态条目创建后赋值（D-44）**：`create("upgrade", { id: "uTmp", name: "临时", page: "p1", … })` → 后续 tick 的 `set("up.uTmp.description", "强化版")` 与 `up.uTmp.disabled = true` 生效；导出/导入存档后 `id` 仍为 `uTmp` 且可继续赋值；省略 `id` 时生成 `dyn_<序号>`，且 `destroy(create("upgrade", { … }))` 在同一表达式内成功丢弃（返回值可直接作 `destroy` 实参）；`spec.id` 与静态条目 `u1` 冲突 → `E_CREATE_ID_CONFLICT` 且条目**未被创建**（无部分落地）；`spec.id` 写成 `p1` 前缀 → `E_CREATE_ID_CONFLICT`。
- **对象/数组字面量的语法边界**：`create("upgrade", { name: "x", page: "p1", costs: [{ materialId: "r1", amount: "10" }] })` 可正常编译并创建；把字面量写在价格/条件/`set()` 里 → 编译期 `E_LITERAL_NOT_ALLOWED`；`spec` 含未知键 → 编译期 `E_CREATE_FIELD_INVALID`（不进入运行期）；嵌套 > 4 层 → `E_PARSE_DEPTH`；单数组 > 64 项 → `E_BUDGET`；含 `...` 展开 → `E_PARSE`。
- **`res.<id>.owned` 别名**：读写 `res.r1.owned` 等价于 `res.r1.amount`（同一存储）；写后立即经 `applyCap` 夹到 `max`；导出存档只出现 `amount`、不出现 `owned`；两者互相赋值不产生覆盖冲突（无 `E_SAVE_FIELD_CONFLICT`）。
- **`buyAmount` 归一化**：赋 `3.7` → 按 `floor` 取 `3`；赋 `1e1e10` → 夹到 `100`；赋 `0` → 最大购买模式；赋 `-1` → 自动最大（免费）模式；赋 `Infinity` → 非有限实数被拒，报 `E_BUY_AMOUNT_INVALID` 且保持上次成功值（D-46、`Infinity` 语义见 4.4 第 6 条）；赋产生 `NaN` 的表达式（如 `ln(0)`、`0/0`） → 同样报 `E_BUY_AMOUNT_INVALID`；赋无法编译/无法求值的表达式 → 保持上次成功值并记诊断、**且不报 `E_BUY_AMOUNT_INVALID`**（与 5.9.3 归一化第 ① 步一致，17.1 同步）；编辑器表单对非整数输入给出红框提示。
- **副作用回滚**：`action` 内 `effValue = 1` 后半段再抛错的表达式 → 该表达式本次收集的副作用**与 `effValue` 写回**全部丢弃（`effectValues[i]` 保持上次成功值），同 tick 内其它表达式已收集的副作用照常提交；`action` 未对 `effValue` 赋值时 `effectValues[i]` 原样保留且该属性 `version` 不递增；写回只在提交阶段落地，下一 tick 才可被其它表达式读到。
- **交互事件与 tick 边界（8.3.1）**：两次 tick 之间点击“购买”一个带 `set()` 效果的升级 → `bought/owned` 与卡片**立即**更新，但被赋值的属性要到**下一个 tick 的第 6 步**才变化（断言不存在“即时提交旁路”）；点击器点击后 `res` 数量立即增长；点“丢弃”后卡片**立刻**消失（不经 `EffectSink`）；暂停状态下购买 → 状态字段即时结算、副作用在恢复后第一个 tick 提交（诊断面板可见提示）；自动购买（tick 内）产生的副作用在**同一 tick** 的提交阶段落地。
- **热更新保留进度（7.4）**：编辑器改资源名/图标/描述后同步预览，断言该条目的 `amount/bought/owned` 与升级 `effectValues[i]` **一字不变**；把价格表达式在运行时 `set()` 赋值后再由编辑器改写同一字段 → 预览**保留运行期文本**（作者改不回来之前先能改回来）；未被赋值过的表达式字段热替换 → **下一 tick 立即生效**；删除条目 → 其 `PageDef.entries` 归属被清掉、指向它的价格/产出文本被保留并记 `E_DANGLING_REF`；删除当前页面 → 视图回到初始页面。
- **“无 tick 的帧”也要推进真实时间（8.2）**：`tickRate = 20` 下以 16ms/帧推进 10 秒 → `stats.realElapsed ≈ 10s`（而不是只按“产生了 tick 的帧”折算的 ~3.3s），且 `autosaveInterval` 到期时**恰好**产出一份 `game:save`（含 `intent: 'autosave'`）；同一区间内 `nPlan === 0` 的帧**不**推进 `gameTime`、不触发每秒阶段、速率采样不更新。
- **注入物端到端（9.1/9.2、M4 交付标准）**：把 esbuild 的**真实产物**注入 `srcdoc` 并在 jsdom 中执行（不 mock），注入 `host:init` → 断言顶部标题、仪表盘资源数量、三类卡片、点击器**无**购买按钮、底部导航、注入的 `<style>` 全部出现，且数字与运行时算出的值一致；握手后收到带同一个 `sessionId` 的 `game:ready`；`host:control{action:'pause'}` 后仪表盘出现“已暂停”；错误 `sessionId` 的消息只产出 `game:error` 且界面不崩。
- **打包产物离线可玩（M5 交付标准、11.1、17.3、D-53、R-38）**：用生产管线（`iforge-pack`）把示例项目打成**单文件** HTML，以 **`file://`** 协议在浏览器里打开 → 断言游戏视图渲染完整、**样式真的命中**（`display: flex` 而不只是 `<style>` 存在）、页面脚本零错误；点击器可玩（点击使产出目标的资源增长）；存档写 `localStorage` 且刷新后进度仍在（10.3 的补写路径）；“导出存档”下载的 `*.save.json` 符合 6.3 且 `slotId='main'`；“重新开始”按 8.5 的初始化表复位；游戏内设置覆盖刷新后仍在（D-22）。走 `file://` 而不是 HTTP 是**前提**：产物里残留任何外部引用时它立刻失效，而 HTTP 会掩盖这类事故。
- **单文件产物的结构自检（11.1/11.2、R-38）**：产物无 `<script src>`、无 `<link rel=stylesheet>`、无会被浏览器去取的 `http(s)` 引用；体积 < 1.5MB、gzip < 500KB（12 的预算）；引导数据能 `parseProjectFile` 解析回项目文件；产物里**不含**模拟设置栏的“解锁全部/时间倍速/自适应”（D-42、R-32）。
- **打包前校验拦截（11.1 的 7 条）**：不合法 id（含 `dyn` 前缀）、悬空引用、条目跨页面重复、`tickRate<=0`、超限资产、未内联的 `kind:'asset'` 引用都必须在打包**前**被拦下并给出问题位置；合法示例项目零问题。
- **虚拟化不影响数值（12、D-56）**：当前页 > 40 张卡片时 DOM 里只渲染视口附近的几行，而 `data-total` 仍等于全部条目数；首屏卡片的数量文本与视图模型逐字一致（视图不算第二遍，8.11 末条）；未超阈值时渲染全部且不套滚动容器。
- **编辑器侧性能面板与打包结果（7.1 末条、11.1 末条、12）**：诊断面板常驻可见（0 错误时入口也在），显示求值次数、tick 缓存命中率、编译缓存命中率、格式化次数；打包后在同一面板显示产物名、体积与指纹。
- **打包态的存储分层（10.3、D-22、D-53、R-37）**：存档与会话覆盖都落 `localStorage` 且刷新后仍在；“改回项目默认值”撤销该项覆盖（不把默认值写回去）；归一化失败的项**不落盘**；存档损坏（非法 JSON / Schema 不符）时按“没有存档”处理而不抛错。
- **`sessionId` 的宿主唯一性与 `host:init` 补发（9.1、9.3、R-19）**：`srcdoc` 的挂载点带 `data-session-id`，与宿主发出的信封同一个值；iframe 的 `load` 事件上**补发**一条同 `sessionId` 的 `host:init`（早于脚本执行时发出的那条可能落进空的 `about:blank`）；会话销毁后 `load` 监听被摘掉、不再补发；两端 `sessionId` 不一致时运行时的入站信封**全部**被拒（`reason: 'session'`）且不挂载视图。
- **仪表盘预测时间**：已达上限的条目、点击器、条件不满足的升级均显示 `—`；可购买条目给出有限的 `dt`，且 `dt` 不早于“按当前速率实际买到”的时刻；价格陡峭时断言 `dt` 用的是**下一件**价格（只读等级视图 `j = bought + 1`，[8.6.1](#861-只读等级视图价格与条件按第-j-级求值)）——与“按当前件价格预测”给出的偏早值不同；`buyAmount < 0`（自动最大、免费）的条目 `dt` 为 `0`（显示“现在”），不因材料不足而递增。
- **格式化缓存键**：负值、0、饱和值，以及 `mantissa` 相同但 `layer` 不同的值分别格式化，断言互不命中彼此的缓存条目。
- **离线墙钟回拨（R-20）**：`now < lastSeenAt`（伪造系统时间）时载入 → 本次**不结算任何离线收益**、`gameTime`/`offlineAccum` 不推进、记 `E_CLOCK_ROLLBACK`；`lastSeenAt` 被推到当前 `now`，时间恢复后下次载入只结算“回拨之后”的真实间隔（不重复结算同一段时间）；正常存档（`now > lastSeenAt`）不受影响。
- **强制解锁标记的生命周期（D-16）**：“解锁全部”后 `visible/disabled` 被置真/置假；表达式覆盖某条目后该项恢复覆盖结果（`forceUnlock` 清除）；`forceUnlock` **不写入项目文件、不写入存档**（导出存档/项目文件中无该键），并断言 `重新开始`、读档、载入新项目后标记清空（此后再次“解锁全部”才重新置位），且其有无不改变任何结算判定结果。
- **离线近似**：同一 8h 场景下“逐 tick 模拟”与“分段结算”对比，单调递增速率下分段结果 ≤ 逐 tick 结果且相对误差 ≤ 1%，耗时 < 300ms（递减/非单调的方向性断言见上一条）。
- **依赖环分层**：两个升级的效果互相引用 → 打包前静态检查报 `E_CYCLE` 并给出环路径；由动态创建/热替换造成的环在运行期报 `E_CYCLE`，tick 不中断、界面不崩溃。
- **列表增删改复制（7.5、D-38/D-39/D-40）**：四类列表“添加”分别生成不冲突的 `id`（`r2`/`g8`/`u3`/`p2`）并落默认字段；复制条目生成**新 id**、字段逐字相同、`order` 紧跟源条目；**复制页面不复制 `entries`**，条目仍在原页面且不重复归属；删除被价格引用的资源时弹窗列出引用条目，确认后 `PageDef.entries` 同步移除且保存成功；上移/下移后同类条目 `order` 为 `1..N` 无重复；页面内拖拽只改 `entries[i].order`。
- **页面布局联动（PRD 页面编辑器 7/8、核心功能 7）**：改 `columns` 即预览网格列数变化；改 `entries[i].order` 即卡片排列顺序变化；`E_DUPLICATE_PAGE_ENTRY` 在重复分配时报错并定位下标。
- **模拟设置栏（7.1、D-41/D-42）**：三档设备切换后预览容器宽度分别为 390/834/容器宽度且断点列数生效；暂停后 `tick` 计数与资源量均不再增长、渲染仍可用；重新开始二次确认后按项目文件复位；“解锁全部”后全部页面/条目可见可用，随后被表达式覆盖的项恢复覆盖结果；**打包产物中不含设备/暂停/倍速/解锁全部控件**。
- **编辑器设置页（7.7、D-22）**：改 `meta.name` 后顶部标题栏与预览标题同时更新；创建时间/最后修改/引擎版本/当前引擎四项不可编辑；游戏默认设置 6 项改动即热更新预览并显示来源徽标，“恢复默认设置”清除会话覆盖但项目默认值不变。

### 14.3 质量门禁
- CI：`lint`（ESLint + Prettier）、`typecheck`、`test`、`bench:ci`（性能阈值回归）、`build`、`e2e`。
- 合并门禁：单测覆盖率 ≥ 80%（`num`/`expr`/`runtime` ≥ 90%）；打包产物冒烟测试必须通过。
- **文档一致性校验（`docs:check`，与 `lint` 同级）**：用脚本抽取本文档的表格做交叉比对，防止 [5.9 属性读写矩阵](#59-属性读写矩阵) / [6.3 存档 Schema](#63-存档文件-schemasavejson) / [6.5 字段映射总表](#65-prd-字段映射总表) / [17.6 追溯矩阵](#176-需求追溯矩阵prd--tech-章节--实现包--测试) 之间出现“改了一处漏了另一处”（R-33 的直接防线）：
  1. 5.9.1/5.9.2 中“存档位置含顶层”的**可写**属性，必须在 6.3 的 `SaveFile` 对应记录里出现同名字段（`isClicker` 曾因此漏过，见 R-33）；
  2. 6.5 各表中标 ✅ 可赋值的字段，必须在 5.9 中有对应行，且可写性一致；
  3. 6.5 引用的每个 `E_*` 错误码必须在 17.1 中已定义；8.7/6.4 引用的每个 `D-xx`/`R-xx` 必须在 16.1/16.2 中已定义；
  4. 17.6 每一行的“测试落点”不得为空，且必须能在 14.2 中找到同关键词的用例；
  5. [8.12](#812-页面导航与当前页面prd-预览区-8) 定义的 `nav()` 与 `currentPageId` 规则必须在 8.1 的 `GameState` 与 8.11 的 `BottomNav` 中都有对应落点；`currentPageId` **不得**出现在 [6.3](#63-存档文件-schemasavejson) 的 `SaveFile` 中（导航状态不持久化，D-50），也不得出现在 [5.9](#59-属性读写矩阵)（它不是表达式属性）。
  6. [6.1](#61-公共字段) 的 `ID_PATTERN` 与 [8.7](#87-升级效果与动态条目) 的动态 id 前缀/长度必须一致，且 `dyn` 确实被静态 id 占用为保留前缀（否则动态自动 id 可能与静态条目撞名，R-35）；4.4 的“无上限”语义条目必须与 5.2 的数字字面量清单互相引用（`Infinity` 字面量若从 5.2 漏掉，`max="Infinity"` 的默认值将不可编译，R-36）。
  7. **5.4 的“价格上下文/离线”两列必须与 5.5 的权限表逐行一致**（只做投影、不得放宽）：随机函数两列必须都是 ❌；`set/create/destroy` 的离线 ✅ 只表示 `effect` 上下文，若 5.5 的副作用列变化，5.4 的读法说明必须同步（这条专门防“离线任意上下文可用”的歧义回潮）。
  8. **5.2 的“字面量允许位置”必须覆盖 5.4 中所有以列表为实参的内置函数**：当前该集合为空（V1.0 无列表型内置函数）；一旦在 5.4 新增需要数组/对象实参的函数而 5.2 未同步增加受限例外，`docs:check` 失败——否则会再次出现“函数在表里却写不出可调用表达式”的死接口。
  9. 5.9.3 的 `buyAmount` 归一化步骤 ①/② 必须与 17.1 的 `E_BUY_AMOUNT_INVALID` 触发条件一致（“求值失败”不属于该错误码）；`E_CLOCK_ROLLBACK` 必须同时出现在 8.8 伪码首行、R-20 与 17.1，不得只写在风险表里。
  10. **`E_PAGE_UNKNOWN` 的孤儿动态条目口径必须在 6.3（读档顺序 ②）、6.4、7.1（诊断面板丢弃入口）、8.7 保持一致**：保留存档、不渲染、可丢弃、页面恢复后自动出现；任一处漏写即失败。
  11. 5.6 的 `effValue` 写回分桶规则必须在 8.7 的伪码与文字说明中都有落点（不得只在一处出现）；8.3.1 的“唯一提交点”必须与 5.6 的“固定提交阶段”互相引用。
- **Schema ↔ 实现的编译期对齐**：`model` 包从同一份字段白名单生成 Zod Schema 与 5.9 权限表，新增字段时漏改权限矩阵将在 `typecheck`/单测阶段即暴露，而不是留到运行时静默丢存档。
- **文档表格以生成产物为准（降低长期维护成本）**：`packages/model` 从同一份字段白名单生成 Zod Schema、[5.9](#59-属性读写矩阵) 权限表与 [6.3](#63-存档文件-schemasavejson) 的字段集合；`docs:gen` 负责把这三者回写进本文档的对应表格，`docs:check` 以**生成差异**作为阻断条件——手工改表格而未改字段白名单即 CI 失败。[6.5 字段映射总表](#65-prd-字段映射总表)的“PRD 字段编号”列与 [17.6 追溯矩阵](#176-需求追溯矩阵prd--tech-章节--实现包--测试)的 PRD 映射列属人工维护的**追溯信息**（PRD 条目与章节之间没有可推导的生成关系），不可生成，其一致性依赖上述各条交叉校验与规则 4 的用例存在性检查。
  - **落地形态（D-55、R-39）**：`docs:gen` **不整表重写** 5.9 / 6.3——那两张表是面向阅读的（同类属性合并成一行、存档位置列带说明文字），逐字段生成会抹平这些。改为在人工表之后放一个由 `<!-- docs:gen:5.9.1 -->` / `<!-- docs:gen:5.9.2 -->` / `<!-- docs:gen:6.3.fields -->` 标记圈出的**派生块**（一个字段一行），由 `packages/model/src/docgen.ts` 从 `PROPERTY_SPECS` 与 Zod Schema 产出；`pnpm docs:gen` 回写、`pnpm docs:gen --check` 校验。规则 1/2 的“文档 ↔ 代码”双向断言**保留**（它们读人工表），与“代码 ↔ 派生块”共同构成两道防线。

## 15. 扩展框架预留
> 本节只收录 PRD 明确要求“预留框架”的能力（核心功能 3 的多项目管理、补充 8 的多存档、补充 9 的多语言），以及 PRD 已要求实现、但需要留扩展位的**多主题**（资源/生成器/升级/页面编辑器第 1 条、页面编辑器 6/8、设置页 1）。[1.2](#12-范围) 已声明不做的服务端、账号体系、联网排行榜、支付、原生/移动端打包不进入本表，避免预留接口反过来锁定 V1.0 的数据模型。

| 能力 | PRD 依据 | V1.0 实现 | 预留接口 |
| --- | --- | --- | --- |
| 多项目管理 | 核心功能 3 | 单项目，`projectId` 固定 | `ProjectRegistry { list, open, create, remove }`，IndexedDB 已按 `projectId` 分键 |
| 多存档 | 补充 8 | 单存档 `slotId = 'main'` | `SaveSlot[]` + `saveId` 复合键；存档选择 UI 接口预留 |
| 多语言 | 补充 9 | 仅 `zh-CN` | `LocaleRegistry.register(locale, dict)`，文案全部走 key |
| 多主题 | 各编辑器第 1 条、页面编辑器 6/8、设置页 1 | 内置 + 自定义 CSS | `ThemeRegistry`，令牌命名空间统一 |

- **UI 暴露口径**：以上均为**接口级预留**。V1.0 的编辑器与游戏内**不显示任何对应入口**——不显示多项目管理/存档选择/语言切换按钮（`locale` 固定 `zh-CN`），不出现 `saveId` 选择、主题选择器以外的扩展入口。这些入口一旦提前暴露就会锁定 V1.0 的数据模型（`slotId='main'`、单 `projectId`），与 [1.2](#12-范围)、[7.9](#79-项目生命周期新建保存导入导出)、[10.2](#102-导入--导出) 的单项目/单存档约束冲突。

## 16. 风险与措施
> 本节同时承载 PRD 补充 10 的自主决策记录，以及实现阶段已识别的技术风险。
>
> 两表都是**索引而非正文**：只写“决定了什么 / 担心什么”与对应的**落点**，规则的完整展开在正文章节；正文中也不重复本节内容（见文首“内容归属原则”）。

### 16.1 决策记录（PRD 未明确事项）
> PRD 补充 10 明确“文档中没有明确的事项自行决策，并写入‘风险与措施’中”，且 PRD 状态为“已定稿，不再回填”。因此下表决策**由本文档自行拍板、无需产品确认**；若产品后续给出与本表冲突的结论，按 [1.5](#15-文档约定与阅读指引)“本文档与 PRD 冲突时以 PRD 为准”处理，并在本表**追加**一条差异记录（不改动既有编号，保证既有引用不失效）。
>
> 本表是**决策索引**，不是设计正文：只写“决定了什么”与“为什么不能照字面做”，规则的完整展开一律在“落点”列指向的章节，避免同一语义在正文与本表各写一遍。新增决策沿用 `D-<两位序号>` 递增。

| 编号 | 议题 | 决策 | 落点 |
| --- | --- | --- | --- |
| D-01 | 数值饱和的具体边界 | 上界 `10 ↑↑ 1e15`、数量类下界 0；溢出饱和为上界并在 UI 显示 `∞` | [4.4](#44-溢出下溢策略饱和语义)、[4.5](#45-显示格式) |
| D-02 | “禁止上下溢出”是否报错 | 不抛异常，饱和 + 诊断计数（避免大数游戏频繁中断） | [4.4](#44-溢出下溢策略饱和语义)、[5.7](#57-求值调度与性能) |
| D-03 | 逻辑帧率与单帧最大步长默认值 | `tickRate = 20`、`maxFrameStep = 250ms`、自动存档 30s、离线上限 8h | [6.2](#62-项目文件-schemajson)、[7.7](#77-设置页面实现要点)、[8.2](#82-主循环请求动画帧驱动) |
| D-04 | 自动最大购买的间隔 `N` | 默认每 tick 检查一次（`buyDelay = 1`），提供 1/5/10/50 tick 选项；离线不触发 | [6.5.2](#652-生成器prd-生成器编辑器-111)、[8.3](#83-单-tick-顺序固定时序可预测) 第 5 步 |
| D-05 | 随机函数在价格表达式的处理 | 编译期直接拒绝（编辑器红框），运行期兜底 last-good 并记诊断 | [5.4](#54-内置函数)、[5.5](#55-上下文context与权限) |
| D-06 | 升级批量购买的效果结算 | 只结算最后一级的效果（PRD 已定），实现上先加 `bought`/`owned` 再求值全部效果 | [8.6](#86-批量--最大--自动最大购买求解) 第 4 步、[8.7](#87-升级效果与动态条目) 触发点 ② |
| D-07 | 表达式求值失败的处理 | 保留 last-good + 诊断，不中断 tick | [5.7](#57-求值调度与性能) |
| D-08 | 表达式依赖环 | **分层**：仅由项目文件静态表达式构成的环在打包前静态拦截（对 `deps` 建图检出）；涉及动态创建、运行时改 `materialId`、表达式文本热替换的环无法在事前建全图，改由运行期重入检测兜底 | [5.7](#57-求值调度与性能)、[11.1](#111-构建管线) 第 1 条 |
| D-09 | 动态条目归属页面 | `create()` 必填 `page`；动态条目不写项目文件，只写存档 | [8.7](#87-升级效果与动态条目)、[6.3](#63-存档文件-schemasavejson) |
| D-10 | 离线是否启用随机 | 禁用（PRD 补充 1），价格/产出按分段线性外推 | [8.8](#88-离线模拟) |
| D-11 | 离线收益效率系数 | 不额外打折（PRD 只说明“低于在线”，原因是缺少随机/每秒生效/自动购买） | [8.8](#88-离线模拟)、[8.10](#810-游戏内设置页与存档操作prd-预览区-9) |
| D-12 | 资产存储 | 上传资产存 IndexedDB 资产库，项目保存/导出/打包时内联为 `data:`（单资产 ≤ 64KB），未被引用的资产不写入项目文件 | [10.1](#101-indexeddb-结构) 资产解析链路、[11.2](#112-体积与优化) |
| D-13 | 自定义主题 | CSS 文本令牌注入，缺 `--iforge-*` 变量回退默认 | [7.8](#78-主题图标与国际化)、[13](#13-安全与沙箱) 第 5 条 |
| D-14 | 撤销/重做范围 | 只覆盖项目数据，不覆盖 UI 状态与预览交互 | [7.2](#72-状态管理)、[7.3](#73-撤销重做) |
| D-15 | 预览与编辑器一致性 | 编辑器内影子运行时 + patch 同步；打包产物复用同一 runtime 代码 | [2.2](#22-分层架构)、[7.4](#74-同步到预览)、ADR-03 |
| D-16 | “解锁全部”语义 | 一次性动作，把所有页面/条目的 `visible` 置真、`disabled` 置假并打上 `forceUnlock` 标记；后续被表达式覆盖时 `forceUnlock` 清除。标记是**纯内存态**（不写项目文件、不写存档，重新开始/读档/新建即清空），且不参与任何判定——判定只看属性当前值 | [8.4](#84-可见性与禁用的有效状态页面继承)、[7.1](#71-界面总体布局prd-工作页面一览) |
| D-17 | 数字显示格式枚举 | `standard/scientific/engineering/letters/layered` | [4.5](#45-显示格式) |
| D-18 | “重新开始”语义 | 清空存档，按项目文件把全部属性重建为 `initial`，丢弃动态条目、`assignments` 与所有运行时赋值 | [8.5](#85-购买结算) 初始化表、[8.10](#810-游戏内设置页与存档操作prd-预览区-9) |
| D-19 | 点击器的“初始数量”语义 | 点击器以 `initial` 作为初始 `owned`（不计入 `bought`，不影响价格），点击产出受 `max` 约束；其余条目 `bought = owned = initial` | [8.5](#85-购买结算) 初始化表 |
| D-20 | 资源是否可被购买 | 资源无购买路径，`bought` 不可读（读取报 `E_UNKNOWN_ATTR`），数量由生成器产出或升级赋值 | [5.3](#53-内置变量)、[8.5](#85-购买结算) |
| D-21 | 页面可见/禁用的判定入口 | 统一为 `isVisible/isDisabled` 两个函数（自身 ∧ 页面），所有结算与渲染阶段必须调用；页面禁用不影响跳转 | [8.4](#84-可见性与禁用的有效状态页面继承) |
| D-22 | 游戏内设置改动的归属 | 分两层：项目文件 `settings` = 游戏默认设置（仅编辑器设置页修改）；游戏内修改只写运行时会话覆盖，打包态存 `localStorage`，不进存档、不回写项目 | [7.7](#77-设置页面实现要点)、[8.10](#810-游戏内设置页与存档操作prd-预览区-9) |
| D-23 | 升级多条效果的遍历语义 | 遍历全部效果、逐条独立判断，满足前提的全部生效，不短路；“首个命中”需用户自写互斥条件 | [8.7](#87-升级效果与动态条目) |
| D-24 | 批量购买的多材料与条件求解 | 每种材料独立求最大可负担件数后取 `min`；升级条件 `count`/`max` 按**前缀语义**（“末级校验 + 二分”定位候选，再逐级确认；单调条件走二分快路径并抽查首/中/末三级，此时“末级为真 ⇒ 全程为真”可证，**抽查未通过则退回全量逐级确认**；非单调条件逐级确认并按 tick 预算分摊，记 `E_BATCH_CONDITION`），`free` 按 PRD 字面只校验最后一级。**逐级确认的下标从 0 起**（第 `j` 次购买发生在等级 `bought + j` 上），并与卡片件数、`free` 末级校验共用同一口径 | [8.6](#86-批量--最大--自动最大购买求解)、[8.6.2](#862-升级购买条件的前缀语义-solvebyconditionprefix) |
| D-25 | `assignments` 与顶层字段的权威性 | 顶层字段为生效值，`assignments` 只承载列表/文本字段的当前值并作审计，读档不回放表达式；冲突以顶层为准并记 `E_SAVE_FIELD_CONFLICT` | [6.3](#63-存档文件-schemasavejson) |
| D-26 | 运行时赋值表达式的目标集合 | 以 [5.9 属性读写矩阵](#59-属性读写矩阵) 为唯一依据（含 `description`、`conditions[i]`、`effects[i].condition/action`、`effectValues[i]`、`perSecond`、`isClicker`、`produces[i].amount` 可写；`id/order/name/icon/columns/theme/entries/perSec/buyDelay` 只读） | [5.9](#59-属性读写矩阵)、[6.5](#65-prd-字段映射总表) |
| D-27 | `set(path, expr)` 的 `path` 形式 | 只接受字面量路径，禁止变量/拼接，以便编译期完成权限校验与依赖收集 | [5.2](#52-语法)、[5.4](#54-内置函数) |
| D-28 | 点击器“不可购买”的落地层级 | 运行时**硬约束**：`canBuy` 对 `isClicker` 生成器恒假，`buyOne`/`solveBatch` 报 `E_CLICKER_NOT_BUYABLE`，自动购买阶段无条件跳过；UI 只渲染无购买按钮的 `ClickerCard`（表现层），不得以“按钮没画出来”当作路径已堵死 | [8.4](#84-可见性与禁用的有效状态页面继承) `canBuy`、[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解) 前置判定 |
| D-29 | 运行时赋值到表达式文本属性的语义 | 右侧**先求值**：字符串原样作为新源码、数值取十进制字面量文本、布尔/`null` 报 `E_ASSIGN_TYPE`；**不回写源码**，也不提供字符串拼接与 `str()`。**设置表达式文本的唯一入口就是 `set(路径, "源码")`**（不设 `setExpr()` 之类的第二入口），编辑器 UI 把“输入数值”与“输入表达式文本”区分成两种模式 | [5.9.3](#593-读写实现约定)、[7.6](#76-工作区实现要点)、[17.2](#172-示例项目节选) |
| D-30 | `produces[i].amount` 的语义 | **单件产出速率**；总产出 = `owned × Σ produces[i].amount`，点击器单次点击同式，`owned` 只乘一次 | [5.3](#53-内置变量)、[8.3](#83-单-tick-顺序固定时序可预测) 第 3 步、[8.5](#85-购买结算) |
| D-31 | 时间倍速档位 | `1× / 2× / 5× / 10×`；只加速在线 tick 推进，不改变 `tickRate`、离线结算时长与自动存档间隔 | [7.1](#71-界面总体布局prd-工作页面一览) 模拟设置栏、[8.2](#82-主循环请求动画帧驱动) |
| D-32 | 动态条目数量上限 | V1.0 落地总数 2000 硬上限，超限拒绝本次 `create` 并报 `E_DYNAMIC_LIMIT` | [8.7](#87-升级效果与动态条目) |
| D-33 | 导入项目的冲突处理 | V1.0 单项目，只提供“覆盖当前项目 / 取消导入”；“另存为新项目”仅作为多项目管理预留接口，不实现 | [1.2](#12-范围)、[10.2](#102-导入--导出)、[15](#15-扩展框架预留) |
| D-34 | 动态创建的范围 | V1.0 **同时支持 `create("generator", …)` 与 `create("upgrade", …)`**；PRD 升级编辑器 12 只要求创建升级条目，生成器作为对称扩展一并落地，两侧共用同一 `create` 路径与字段白名单 | [6.3](#63-存档文件-schemasavejson) `dynamic.generators`、[8.7](#87-升级效果与动态条目) |
| D-35 | “每秒生效”的时间基准 | 以**游戏内时间 `gameTime`**（随倍速推进）判定，`gameTime >= lastPerSecondAt + 1` 时触发一次并跳过多余秒；`lastPerSecondAt` 不单独存档。自动存档间隔仍按**真实秒数**计 | [8.2](#82-主循环请求动画帧驱动)、[8.3](#83-单-tick-顺序固定时序可预测) 第 2 步 |
| D-36 | `buyAmount` 的求值归一化 | 求值 → 有限性检查（非有限报 `E_BUY_AMOUNT_INVALID` 并保持 last-good）→ `floor`（超安全整数退化）→ `n ≥ 1` 时夹到 `100`；`0`（最大）与 `<0`（自动最大）无 100 上限，不再夹取 | [5.9.3](#593-读写实现约定)、[8.6](#86-批量--最大--自动最大购买求解) |
| D-37 | 资源的“拥有数量”属性名 | 提供 `res.<id>.owned` 作为 `res.<id>.amount` 的**读写别名**（同一存储、同一 `applyCap`、不单独存档）；资源仍无 `bought`（读取报 `E_UNKNOWN_ATTR`，D-20） | [5.3](#53-内置变量)、[5.9.1](#591-条目属性) |
| D-38 | 删除条目时如何处理被引用关系 | **不做级联删除**：删除前列出受影响引用（价格/产出/页面归属）供确认，确认后移除条目及其页面归属；引用方保留原文本，残留悬空引用在保存/打包时被 `E_DANGLING_REF` 阻断 | [7.5](#75-条目列表交互规格)、[6.4](#64-校验与迁移) |
| D-39 | 复制条目的 id 与页面归属 | 复制必生成**新 id**，`order` 插入源条目之后并重排，字段逐字复制；**页面复制不复制 `entries`**（一个条目只能属于一个页面，PRD 补充 7），新页面条目为空并在提示中说明；复制的条目不自动加入页面 | [7.5](#75-条目列表交互规格) |
| D-40 | 排序操作的实现口径 | 上移/下移/拖拽把同类条目 `order` 重排为 `1..N` 连续整数（不允许长期重复）；页面内条目排序只改 `PageDef.entries[i].order`；三者写同一字段、同一事务 | [7.5](#75-条目列表交互规格) |
| D-41 | 设备模拟档位取值 | `phone = 390×844`、`tablet = 834×1112`、`auto = 容器宽度`（断点 <640 / <1024 / ≥1024）；只改预览容器宽度与 `pointer: coarse`，不改 `columns` 定义，实际列数 = `min(columns, 断点列数)` | [7.1](#71-界面总体布局prd-工作页面一览)、[9.1](#91-沙箱模型) |
| D-42 | 模拟设置栏的归属与打包形态 | 设备/暂停/继续/重新开始/倍速/解锁全部属于**编辑器外壳**，只存在于编辑器预览区，**不进入打包 HTML**（PRD 明确“不属于游戏内容”）；打包版只含游戏视图，成品侧的对应能力由游戏内设置页与页面跳转承担 | [7.1](#71-界面总体布局prd-工作页面一览)、[11.1](#111-构建管线) |
| D-43 | 升级效果的生效前提 | `applyEffect` 统一以 **`owned > 0`** 为前置（`ownsUpgrade`），`owned` 每次实时读取不缓存，三个触发点（单件购买后、批量购买后结算最后一级、每秒生效阶段）都必须过此前置。判定用 `owned` 而非 `bought` 才不会漏掉被其它升级产出的升级（`bought = 0`）；若完全不判定，`initial = 0` 且 `condition` 默认为真的升级会每秒改写全局状态 | [8.4](#84-可见性与禁用的有效状态页面继承) `ownsUpgrade`、[8.7](#87-升级效果与动态条目) |
| D-44 | 动态创建后的赋值能力 | `create()` 的 `spec` 是**唯一定义入口**（创建即完整定义）；因语言是单表达式、`set()` 只接受字面量路径（D-27），为让 PRD 升级编辑器 12 的“并通过表达式为其赋值”可实现，`spec` 新增**可选稳定 `id`**（`[gu]` 前缀、全局唯一，冲突报 `E_CREATE_ID_CONFLICT` 并整体拒绝创建），其值随存档持久化，后续 tick 可用字面量路径赋值/丢弃；`create()` 返回值只能直接作为 `destroy()` 实参串联使用 | [5.4](#54-内置函数)、[8.7](#87-升级效果与动态条目) |
| D-45 | 静态条目 `id` 的命名约束 | 静态 `id` 必须匹配 `/^[rgup][A-Za-z0-9_]{0,31}$/`（类型前缀 + 字母数字下划线、总长 ≤ 32），跨四类全局唯一，**禁止 `dyn` 前缀**（保留给动态条目自动 id）；不合规报 `E_ID_INVALID` 并定位到具体条目，不自动改 id（改名会连带 `materialId`、`entries[].id` 与存档 `assignments` 键，静默改名比报错更危险）；Schema、路径解析器、复制生成、`create()` 冲突检查共用同一份 `ID_PATTERN` | [6.1](#61-公共字段)、[6.4](#64-校验与迁移) |
| D-46 | “无上限”的写法（`Infinity` 字面量） | `Infinity` 定为**合法数字字面量**（解析为哨兵 `NUM_INF`，不新增函数别名）；`max` 字段读到它即完全跳过钳制；价格/产出/数量字段折算为 `NUM_MAX`/`NUM_MIN` 并记 `E_OVERFLOW`；`buyAmount` 沿用既有的 `E_BUY_AMOUNT_INVALID`；条件比较中等同 `+∞`。与饱和上界 `NUM_MAX` 区分但最终效果一致。选字面量而非 `inf()` 函数以减少拼写分歧；不为它新增错误码——无穷的唯一合法用途已有确定语义 | [4.4](#44-溢出下溢策略饱和语义) 第 6 条、[5.2](#52-语法) |
| D-47 | PRD 升级编辑器 12“由用户自行赋值”的落点 | 落点是**运行时表达式赋值**（`action` 内 `effValue = …` / `up.<id>.effectValues[i] = …`），编辑器“效果数值”列**只读展示**（当前运行时值 + 无运行态占位 `0` + 只读徽标 + 快捷插入模板），**不提供初始值输入框、不写 `ProjectFile`**。给输入框会让 `effectValues` 变成设计期常量，与 PRD 补充 6 的存档边界冲突 | [6.2](#62-项目文件-schemajson)（`UpgradeDef` 无 `effectValues`）、[7.6](#76-工作区实现要点) |
| D-48 | 非等比价格的求解与降级体验 | ① 闭式求和从“仅等比”扩展到四个可识别族：`A·q^j`、`A·q^j+B`、`A·q^j+B·j+C`、`A·j+B`，用采样拟合 + **未见采样点复验**确认，仅作加速不作正确性前提；② `free`（自动最大购买）只校验末价 `P(k−1)`，因此只要 `P` 单调非减即可二分，**不要求等比**，正常路径不再退化为逐级累加；③ 付费 `count`/`max` 仍不可闭式时按 1e5 次/tick 分摊、卡片显示“计算中…”，并连续 60 tick 未收敛时给出“建议改写为等比/指数+线性形式”的作者提示（PRD 未规定任何反馈，而“长期计算中”若无成因说明无法由作者自行修复） | [8.6](#86-批量--最大--自动最大购买求解)、[12](#12-性能预算与优化) |
| D-49 | 离线“收益低于在线”的保证边界（细化 D-11） | 该结论的依据是离线**不触发随机函数、升级“每秒生效”与自动最大购买**（PRD 设置页 9 给出的原因），**不是**分段精度；不引入额外打折系数（D-11 保持），也不声称分段永远偏低。方向性结论按速率趋势分三种：单调递增 → 下界；单调递减 → 上界；非单调 → 无方向保证。对递减/非单调速率记诊断 `E_OFFLINE_APPROX` 并在提示条标注误差方向；“逐 tick 对照”只在**编辑器预览态诊断面板**提供（上限 20000 tick），不进打包产物（`8h × 20 tick/s = 576000` tick 的基线无法在玩家载入时实时计算） | [8.8](#88-离线模拟) |
| D-50 | 当前页面的初值、跳转约束与持久化 | `currentPageId` 的唯一跳转入口是 `nav(pageId)`，**不**校验 `visible/disabled`（页面禁用仍可跳转 PRD 页面编辑器 4；不可见页面也允许 `nav()` 直达，供“解锁全部”与调试）；初值取 `order` 最小且可见的页面，无任何可见页面时取 `order` 最小的页面（**不报错**，“全部页面不可见”是合法中间态），`pages` 为空时停在内置设置页；**不写入存档**（属 UI 会话状态，与 [7.2](#72-状态管理) 的 `editorStore`/`previewStore` 口径一致）；内置设置页用哨兵 `'__settings__'` 表示 | [8.12](#812-页面导航与当前页面prd-预览区-8)、[8.1](#81-核心状态) |
| D-51 | `game:save` 如何区分“自动存档”与“玩家导出” | payload 增加**可选** `intent?: 'autosave' \| 'export'`（缺省按 `autosave` 处理，向后兼容）。自动存档 → 宿主写 IndexedDB（[10.3](#103-存档时机)）；`'export'` → 宿主下载 `*.save.json`（PRD 预览区 9）。**不能靠宿主自行判断**：对运行时而言两者是同一件事（“产出了一份存档”），只有运行时知道这次是否由玩家主动触发；不加该字段的结果只能是“一律持久化”（导出按钮永远不下载）或“一律下载”（每 30 秒弹一次下载框）。**导出必须走宿主**——`sandbox` 只给 `allow-scripts allow-pointer-lock`（[9.1](#91-沙箱模型)），沙箱内的下载会被浏览器拦下，因此 iframe 内只能“请求”宿主导出；“导入存档”方向相反，由运行时在自身文档里建 `<input type="file">` 并读取文本，不经宿主 | [9.2](#92-消息协议)、[10.3](#103-存档时机)、[8.10](#810-游戏内设置页与存档操作prd-预览区-9) |
| D-52 | 协议常量与游戏视图代码的归属 | 消息枚举、`kind` 方向、校验函数与**游戏视图模型**（`GameViewModel` / `CardView`、格式化）都放在 `@iforge/runtime`，游戏视图组件与主循环放独立 app `apps/runtime-shell`；宿主与运行时**共用同一份**协议与视图模型，React 组件只渲染不算。放在编辑器里会让运行时反向依赖编辑器（违反 [3.2](#32-包依赖规则)），两份视图模型则直接违背 [8.11](#811-游戏视图与卡片字段映射prd-预览区-18)“不在 UI 层另算一套逻辑” | [3.1](#31-目录树)、[3.2](#32-包依赖规则)、[8.11](#811-游戏视图与卡片字段映射prd-预览区-18)、[9.2](#92-消息协议) |
| D-53 | 打包态的存储与入口 | 打包版**不复用**预览的 `postMessage` 通道：读 `window.__IFORGE_BOOTSTRAP__`（17.3）后直接挂载，存档与会话覆盖写 `localStorage`（键 `incrementforge.save.<projectId>`，`projectId` 由产物指纹派生），保留导出/导入按钮（10.3）；预览态**不访问** `localStorage`（9.1 的不透明源会抛 `SecurityError`），两条路径在 `boot.ts` 里按 `direct` 显式分开 | [10.3](#103-存档时机)、[11.1](#111-构建管线)、[17.3](#173-打包产物结构)、ADR-05、R-37 |
| D-54 | 编辑器里如何得到打包用的运行时产物 | 编辑器**不在浏览器里跑 esbuild**：`apps/editor/vite` 的构建期插件（[9.1](#91-沙箱模型) 的同一套）已把运行时编译成字符串常量（虚拟模块 `virtual:iforge-runtime-shell`），“打包”直接复用**同一份字节**，`packageGame()` 因此只接受一个 `runtimeSource: string` 而不关心它从哪来；Node 侧（CLI / E2E）另走 `@iforge/build/node` 的 `compileRuntimeBundle()`。因此“预览能跑”与“产物能跑”不可能分叉（ADR-03） | [11.1](#111-构建管线) 第 1 步、[3.1](#31-目录树)、ADR-03 |
| D-55 | `docs:gen` 的生成粒度 | 14.3 末段的 `docs:gen` **不整表重写** [5.9](#59-属性读写矩阵) / [6.3](#63-存档文件-schemasavejson)：那两张表是面向阅读的（同类属性合并成一行、存档位置列带说明文字），逐字段生成会抹平这些。改为在人工表之后放一个由 `<!-- docs:gen:* -->` 标记圈出的**派生块**（一个字段一行），`pnpm docs:gen` 回写、`docs:check` 以生成差异阻断；人工表与 6.5/17.6 的 PRD 编号列仍由人工维护 | [14.3](#143-质量门禁) 末段、R-39 |
| D-56 | 卡片虚拟化的阈值口径 | 按**当前页可见卡片数** `> 40` 启用（12 性能预算的「> 40 条目启用」），而不是按全项目条目数：虚拟化的目的是减少 DOM 节点，把 20 个条目分散到 5 个页面的项目每个页面都很短，全局计数会让每页都被套上滚动容器反而更糟。实现用“滚动容器 + 上下占位 `padding`”，不用 `IntersectionObserver`：网格**行高是变的**（资源卡片两行、升级卡片七八行），IO 需要固定行高才能算位置 | [12](#12-性能预算与优化) 渲染一行、[8.11](#811-游戏视图与卡片字段映射prd-预览区-18) |

### 16.2 风险清单
> 与 [16.1](#161-决策记录prd-未明确事项) 配套：措施列只写**与既有设计的对应关系**，具体实现见“落点”，不重复正文。

| 编号 | 风险 | 触发条件 | 影响 | 措施 | 落点 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | break_eternity 分层上限外的运算（`pow` 层数爆炸） | 幂塔级表达式反复自乘 | 结果失真 | `NUM_MAX_LAYER` 饱和 + `saturated` 标记 + 单元测试覆盖边界 | [4.4](#44-溢出下溢策略饱和语义) | 已决策 |
| R-02 | 大数比较/取整精度问题 | 对 `1e1e10` 做 `floor/round` | 显示错误 | 取整超安全整数直接返回自身；比较全部走 `Decimal.cmp` | [4.4](#44-溢出下溢策略饱和语义) 第 5 条 | 已决策 |
| R-03 | 无上限批量购买退化为 O(k) | `buyAmount = 0`/`<0` 且价格不可闭式（如 `10·1.15^j + j^2`） | 卡死，或长期显示“计算中…” | 四个可闭式求和族 + 未见点复验；`free` 只需 `P` 单调即可二分；付费模式仍不可闭式时按 tick 预算分摊并给出改写提示 | [8.6](#86-批量--最大--自动最大购买求解)、D-48 | 已决策 |
| R-04 | 单调性假设不成立（单件价格为负，或闭式近似失效） | 用户写出递减/负价格 | 二分结果偏差或材料被扣成负数 | 采样点检测到递减/负价格即记 `E_BATCH_MONOTONE` 并强制逐级累加求 `C(k)`，此时不再使用二分；形状识别必须用未见采样点复验 | [8.6](#86-批量--最大--自动最大购买求解) 单材料求解 C 分支 | 已决策 |
| R-05 | 表达式沙箱逃逸 | 用户构造恶意表达式 | 编辑器/浏览器受威胁 | 自研解析器 + 白名单 + token 黑名单 + 深度/长度限制 + 无 `eval` | [5.2](#52-语法)、[13](#13-安全与沙箱) | 已决策 |
| R-06 | 表达式依赖链过长导致每 tick 全量重算 | 上百升级互相引用 | 帧率下降 | 版本号脏标记 + 记忆化 + 求值预算；基准守护 | [5.7](#57-求值调度与性能)、[12](#12-性能预算与优化) | 已决策 |
| R-07 | 依赖环导致无限递归 | 两条升级效果互相引用对方的属性（语言无语句，不会出现 `a = b + 1; b = a + 1` 这种写法） | 崩溃/栈溢出 | 重入检测 + last-good + `E_CYCLE` 诊断 + 打包前静态环检查 | [5.7](#57-求值调度与性能)、[11.1](#111-构建管线) 第 1 条、D-08 | 已决策 |
| R-08 | 运行时赋值污染项目文件 | 实现时把 `assignments` 合并进项目 | 破坏补充 6 语义 | Schema 分离 + 序列化白名单 + 单测断言 | [6.2](#62-项目文件-schemajson)、[6.3](#63-存档文件-schemasavejson)、D-25 | 已决策 |
| R-09 | 撤销栈内存膨胀 | 大量文本编辑 | 编辑器内存上升 | patches + 合并窗口 + 200 条上限 | [7.3](#73-撤销重做) | 已决策 |
| R-10 | 上传资产过大 | 用户上传大图 | 产物膨胀、卡顿 | 解码重编码 + 体积上限 + 打包前检查 | [11.2](#112-体积与优化)、[13](#13-安全与沙箱) 第 4 条 | 已决策 |
| R-11 | 预览表达式死循环/内存暴涨 | 用户表达式恶意构造 | 编辑器卡死 | iframe 隔离 + 求值预算 + 可随时“暂停/重新开始” | [9.1](#91-沙箱模型)、[5.7](#57-求值调度与性能) 配额 | 已决策 |
| R-12 | 编辑器与成品行为不一致 | 双实现漂移 | 预览不可信 | 共享 `@iforge/runtime` + 同一存档序列化路径 + E2E 校验 | [2.2](#22-分层架构) ADR-03、D-15 | 已决策 |
| R-13 | 自定义主题破坏可读性 | 用户主题对比度过低 | 难以使用 | 令牌缺失回退 + 编辑器提供对比度提示 | [7.8](#78-主题图标与国际化)、D-13 | 待实现 |
| R-14 | 离线结算与在线逻辑不一致 | 随机/每秒生效开关差异；或产出速率递减/非单调时分段结算高估 | 玩家困惑；作者误以为离线一定偏低 | 提示条说明“离线不含随机/每秒生效/自动购买”（PRD 设置页 9 给出的“低于在线”的真正依据）+ 递减/非单调速率记 `E_OFFLINE_APPROX` 并标注误差方向 | [8.8](#88-离线模拟)、[8.10](#810-游戏内设置页与存档操作prd-预览区-9)、D-49 | 已决策 |
| R-15 | 项目 Schema 演进破坏旧文件 | 版本升级 | 老项目打不开 | `version` + 逐级迁移 + 未知字段保留 + 只读兼容模式 | [6.4](#64-校验与迁移) | 已决策 |
| R-16 | 动态条目累积导致存档膨胀 | 表达式反复创建 | 存档变大、加载变慢 | 动态条目总数硬上限 2000（超限报 `E_DYNAMIC_LIMIT`）+ 预览角标提示 + 可丢弃 | [8.7](#87-升级效果与动态条目)、D-32 | 已决策 |
| R-17 | 长列表 DOM 过多 | 单页数百条目 | 渲染卡顿 | 虚拟列表（> 40 条目启用）+ 增量 diff | [12](#12-性能预算与优化) | 已决策 |
| R-18 | 表达式文本编辑体验 | 无高亮/无试算 | 上手门槛高 | 内联高亮 + 300ms 试算 + 片段插入 | [5.8](#58-表达式编辑器交互) | 已决策 |
| R-19 | postMessage 伪造/错序消息 | 同页其他脚本 | 状态错乱 | `sessionId` + 消息白名单 + 长度上限 | [9.2](#92-消息协议) | 已决策 |
| R-20 | 时钟漂移/系统时间被改 | 用户改系统时间 | 离线收益异常 | 在线时长用 `performance.now()`（单调、不受改表影响）；离线用墙钟并夹取 `offlineCap`，检测到墙钟回拨（`now < max(savedAt, lastSeenAt)`）则本次不结算离线、只推进 `lastSeenAt` 并记 `E_CLOCK_ROLLBACK`（判定落在 8.8 伪码首行，不依赖实现自觉） | [8.2](#82-主循环请求动画帧驱动)、[8.8](#88-离线模拟)、[17.1](#171-错误码表) | 已决策 |
| R-21 | 页面继承在各阶段遗漏 | 某阶段直接读 `entry.visible` 而未走判定函数 | 页面禁用仍产出/仍生效，违背 PRD 页面编辑器 4/5 | 判定入口收敛为 `isVisible/isDisabled` 两个函数 + 阶段内快照 + 每个阶段单测断言（含 E2E：页面禁用后 100 tick 资源不再增长） | [8.4](#84-可见性与禁用的有效状态页面继承)、D-21 | 已决策 |
| R-22 | 属性读写矩阵与实现漂移 | 新增字段时默认开放写入 | 写出 `perSec`/`columns` 等派生或布局属性，行为不可预期 | 矩阵表作为唯一依据 + 编译期 `E_READONLY_TARGET` + 打包前校验 | [5.9](#59-属性读写矩阵)、[11.1](#111-构建管线) 第 2 条、D-26 | 已决策 |
| R-23 | 多材料/条件批量购买买超 | 价格多材料，或条件随 `bought` 反复真假（如 `gen.g1.bought == 0 \|\| gen.g1.bought >= 5`） | 材料被扣成负数，或 `count`/`max` 模式买到不满足条件的等级（只校验末级会越过中间为假的等级） | `count`/`max` 前缀语义求解，**逐级确认覆盖 `bought .. bought+k−1` 的每一级**（单调快路径 + 抽查，未通过则退回全量；非单调逐级并按预算分摊）；`free` 按 PRD 只校验末级；与暴力逐件模拟做性质测试 | [8.6](#86-批量--最大--自动最大购买求解)、[8.6.2](#862-升级购买条件的前缀语义-solvebyconditionprefix)、D-24 | 已决策 |
| R-24 | 游戏内设置被写回项目文件 | 实现时把 `game:event{settings}` 直接落 `projectStore` | 作者的“游戏默认设置”被游玩行为改写 | 覆盖值与项目默认值分层 + 预览态只写 `previewStore` + 设置页标注来源徽标（强制 UI 元素）+ 单测断言项目文件不变 | [8.10](#810-游戏内设置页与存档操作prd-预览区-9)、D-22 | 已决策 |
| R-25 | 点击器仍可被购买 / 被自动购买白嫖 | 只在 UI 隐藏“购买”按钮，或 `solveBatch`、自动购买阶段未排除 `isClicker` | 点击器变成可无限白嫖的产出，破坏增量曲线与 PRD 生成器 11 | 运行时硬约束收敛到 `canBuy`，`buyOne`/`solveBatch`/自动购买三路径各显式拒绝 + `E_CLICKER_NOT_BUYABLE` | [8.4](#84-可见性与禁用的有效状态页面继承)、[8.5](#85-购买结算)、D-28 | 已决策 |
| R-26 | 产出速率被重复乘以 `owned` | 表达式里已乘 `owned`，结算时再乘一次 | 数值按 `owned²` 膨胀，与 PRD“生成器可拥有多个并影响产出”的直觉不符 | 明确单件语义并标注“只乘一次”；示例项目用 `"amount": "1"`；单测断言总量 = `owned × 单件速率` | [5.3](#53-内置变量)、[8.3](#83-单-tick-顺序固定时序可预测) 第 3 步、[17.2](#172-示例项目节选)、D-30 | 已决策 |
| R-27 | 表达式文本赋值语义被误解 | 实现时把赋值右侧**源码**回写为新表达式文本 | 用户写的 `= 2 * owned` 变成可无限自指的表达式，或与 5.2 语法/13 黑名单（`;`）冲突导致示例不可运行 | 求值后取结果的字符串形式；设置表达式文本统一走 `set(路径, "源码")`（不设第二入口）；编辑器 UI 区分“数值模式/表达式模式”；单测覆盖三种结果类型 | [5.9.3](#593-读写实现约定)、[17.2](#172-示例项目节选)、D-29 | 已决策 |
| R-28 | 动态条目读档丢失赋值 | 读档按“顶层字段 → assignments → 重建动态条目”顺序执行 | 指向动态条目的顶层值与 `assignments` 键被误删，进度静默丢失 | 读档顺序固定为“先建动态条目、再回填顶层与 assignments”，并显式说明顺序不可颠倒 + 读档专项单测 | [6.3](#63-存档文件-schemasavejson) 读档顺序 | 已决策 |
| R-29 | 周期逻辑（升级“每秒生效”）与倍速/游戏内时间脱节 | 用 rAF 的真实墙钟 `now` 判定“每秒”，或把游戏内时间与真实时间混用同一变量 | `10×` 倍速下游戏内过了 10 秒却只触发 1 次；产出速率、`time` 变量、周期效果三者互相矛盾，离线/在线行为进一步分叉 | 拆分 `gameTime`（随倍速）与 `stats.realElapsed`（真实秒数）+ 主循环显式把 `stepMs`/`realDtMs` 传给 `stepTick` + 周期性逻辑一律以 `gameTime` 为准 | [8.2](#82-主循环请求动画帧驱动)、[8.3](#83-单-tick-顺序固定时序可预测) 第 2 步、D-35/D-31 | 已决策 |
| R-30 | `create()` 的 `spec` 需要对象字面量，但原语法未定义字面量 | 实现期临时给表达式语言加“通用对象/数组”字面量 | 静态检查、权限校验、沙箱黑名单与项目文件 Schema 各自为政，出现绕过或不一致的动态创建 | 5.2 补受限字面量语法（仅 `spec` 位置、键名白名单、深度/长度上限、编译期校验），与 13 黑名单、11.1/6.4 复用同一份字段白名单 + 字面量边界用例 | [5.2](#52-语法) 约束表、[13](#13-安全与沙箱) 第 2 条 | 已决策 |
| R-31 | 列表增删复制破坏引用完整性与条目唯一归属 | 复制复用 `id`、页面复制连带复制 `entries`、删除静默留下悬空引用、`order` 出现长期重复 | 保存被 `E_DUPLICATE_PAGE_ENTRY`/`E_DANGLING_REF` 阻断，或运行时报错、顺序错乱 | 复制必发新 id、页面复制不复制 `entries`、删除前列出受影响引用、单事务提交 + 单测/E2E 各断言一次 | [7.5](#75-条目列表交互规格)、D-38/D-39/D-40 | 已决策 |
| R-32 | 编辑器调试控件泄漏到打包产物 | 打包模板复用了含模拟设置栏的 React 外壳 | 成品里出现“解锁全部/倍速/暂停”等 PRD 明确不属于游戏内容的控件 | 打包只引 `@iforge/runtime` + 游戏视图组件 + 产物冒烟测试断言不含这些控件 | [11.1](#111-构建管线) ADR-05、[7.1](#71-界面总体布局prd-工作页面一览)、D-42 | 已决策 |
| R-33 | 存档 Schema 漏掉可写属性的顶层字段 | 5.9.1 新增可写属性（如 `isClicker`）时只改了权限矩阵，6.3 的 `SaveFile` 未同步 | 运行时赋值只进 `assignments`，而布尔/数值属性读档以顶层为准 → 该属性赋值**静默丢失**且无任何报错 | 6.3 写明“顶层字段必须覆盖 5.9.1 中所有存档位置含顶层的可写属性”的完整性不变式 + `docs:check` 交叉校验脚本（矩阵 → Schema 自动比对）+ 存档往返单测逐属性断言 | [6.3](#63-存档文件-schemasavejson)、[14.3](#143-质量门禁) | 已决策 |
| R-34 | 未购买的升级也产生效果 | `applyEffect` / 每秒生效阶段只判可见与禁用，未判 `owned > 0` | `initial = 0`、未购买、`condition` 默认为真的升级每秒改写全局状态，玩家开局即被动获得一堆效果 | 门槛收敛到 `ownsUpgrade` + 三个触发点统一前置 + 单测断言“未购买不生效 / 购买后下一 tick 生效 / 被产出后生效” | [8.4](#84-可见性与禁用的有效状态页面继承)、[8.7](#87-升级效果与动态条目)、D-43 | 已决策 |
| R-35 | 静态 `id` 不可解析或与动态 id 撞名 | 导入含连字符/点号/空格/中文的 id，或静态条目取名 `dyn_1` | `gen.my-gen.produces[0].amount` 被解析成减法、`set()` 路径解析错位、`create()` 自动 id 与静态条目重名导致 `E_CREATE_ID_CONFLICT` 误报或误创建 | 6.1 定义 `ID_PATTERN` 与保留前缀 `dyn` 且为单一事实源 + 导入时 `E_ID_INVALID` 定位到条目 + 旧文件由迁移器显式改名并同步替换全部引用 | [6.1](#61-公共字段)、[6.4](#64-校验与迁移)、D-45 | 已决策 |
| R-36 | `Infinity` 字面量不可编译导致“无上限”无法表达 | 项目文件或 `create()` 缺省值写 `max="Infinity"`，而语法未收录该字面量 | 编译期 `E_UNKNOWN_IDENT`，动态条目根本创建不出来；用户想写“无上限”只能改用极大数字，与 D-46 语义割裂 | 5.2 收录 `Infinity` 字面量，4.4 第 6 条定义各上下文语义（`max` 免钳制、其余折算为 `NUM_MAX` + `E_OVERFLOW`、`buyAmount` 沿用 `E_BUY_AMOUNT_INVALID`、比较中等同 `+∞`）+ 单测覆盖编译与运行 | [4.4](#44-溢出下溢策略饱和语义) 第 6 条、[5.2](#52-语法)、D-46 | 已决策 |
| R-37 | 打包态沿用预览的 `postMessage` 通道 | 直挂模式仍走 `bridge.ts`，或反过来让预览访问 `localStorage` | 预览 iframe 是**不透明源**（9.1 未给 `allow-same-origin`），访问 `localStorage` 抛 `SecurityError`，预览每次存档都炸；直挂则永远等不到 `host:init` | 两条路径**显式分离**：`boot.ts` 仅在直挂时取 `localStorage` 并注入 `localStorage` sink（预览永远拿 `null`）；打包版不复用桥（ADR-05）；单测逐条覆盖 10.3 的存档时机与 D-22 的覆盖落盘，E2E 用 `file://` 打开产物验往返 | [10.3](#103-存档时机)、[11.1](#111-构建管线) 第 1 步、ADR-05、R-11 | 已决策 |
| R-38 | 单文件产物里残留外部引用 | 模板引用外部 CSS/JS，或资产仍是 `kind: 'asset'` 的库引用 | 离线打开时图标/样式/脚本全丢——**功能断言全绿而产物不可用**，因为开发环境一直有服务器兜底 | 打包前校验拦截未内联资产（`E_ASSET_TOO_LARGE`）+ 模板自检（无 `<script src>`/`<link rel=stylesheet>`）+ E2E 用 `file://` 打开产物并断言样式**真的命中**（`display: flex` 而不只是 `<style>` 存在） | [11.1](#111-构建管线) 第 6 条、[11.2](#112-体积与优化)、[13](#13-安全与沙箱) 第 6 条、R-10 | 已决策 |
| R-39 | `docs:gen` 把面向阅读的人工表改成机器生成的逐字段表 | 按字段白名单整表重写 5.9 / 6.3 | 同类属性的合并行与“存档位置”列的说明文字被抹平，文档反而更难读；作者不再信任文档 | 生成**派生块**（`<!-- docs:gen:* -->` 圈出）而非整表，人工表保持原样；`docs:check` 双向校验“代码 ↔ 派生块”与“文档 ↔ 代码”两对关系 | [14.3](#143-质量门禁) 末段、[5.9](#59-属性读写矩阵)、[6.3](#63-存档文件-schemasavejson)、R-33 | 已决策 |

## 17. 附录
### 17.1 错误码表
| 错误码 | 触发 | 提示文案方向 |
| --- | --- | --- |
| `E_PARSE` | 语法错误 | 指出 token 与位置 |
| `E_PARSE_DEPTH` | 嵌套超过 64 层（字面量自身嵌套超过 4 层） | 表达式过于复杂 |
| `E_FORBIDDEN_TOKEN` | 出现禁用 token：`;`、箭头函数 `=>`、`import`/`await`、属性原型链 `__proto__`/`constructor`/`prototype`（[5.6](#56-编译与执行)、[13](#13-安全与沙箱)） | 表达式中包含不允许的语法 |
| `E_LITERAL_NOT_ALLOWED` | 对象/数组字面量出现在 `create()` 的 `spec` 之外的位置 | 字面量仅可用于 `create()` 的 spec |
| `E_TYPE` | 类型不匹配（如字符串参与算术） | 期望数值 |
| `E_UNKNOWN_IDENT` | 未知变量/函数 | 可用变量提示 |
| `E_UNKNOWN_ATTR` | 引用不存在的属性（如资源的 `bought`） | 该条目无此属性 |
| `E_RAND_DISABLED` | 价格上下文或离线使用随机函数 | 随机函数在该场景不可用 |
| `E_SIDE_EFFECT_FORBIDDEN` | 价格/产出/条件上下文调用 `set/create` | 该场景不允许副作用 |
| `E_CYCLE` | 属性求值重入 | 存在循环引用 |
| `E_OVERFLOW` / `E_UNDERFLOW` | 饱和计数（诊断级，不中断）；也覆盖 `Infinity` 字面量在价格/产出/数量字段被折算为 `NUM_MAX` 的情形（[4.4](#44-溢出下溢策略饱和语义) 第 6 条、D-46） | 数值已达上限/下溢 |
| `E_CAP` | 已达数量上限，无法购买 | 已达上限 |
| `E_CAP_NON_POSITIVE` | 数量上限 ≤ 0 | 上限需大于零，按 1 处理 |
| `E_DISABLED` / `E_HIDDEN` | 条目禁用/不可见 | — |
| `E_NOT_ENOUGH` | 材料不足 | — |
| `E_CREATE_NO_PAGE` | 动态创建未指定页面 | 必须指定页面 |
| `E_CREATE_FIELD_INVALID` | `create()` 的 `spec` 含运行时不接管的字段（`kind`/`buyDelay`）或**未知键**（不在 8.7 字段集合内，编译期判定） | 动态创建的字段不合法 |
| `E_ID_INVALID` | 静态条目 `id` 不匹配 `ID_PATTERN`（首字符非 `r/g/u/p`、含非法字符、长度 > 32、以 `dyn` 开头）或跨四类重名，定位到具体条目路径（[6.1](#61-公共字段)、[6.4](#64-校验与迁移)、D-45） | 条目 id 需以类型字母开头、只含字母数字下划线且长度 ≤ 32 |
| `E_CREATE_ID_CONFLICT` | `create()` 的 `spec.id` 前缀/长度非法，或与静态条目、其它动态条目、`dyn_*` 冲突；读档时存档内动态条目 `id` 重复（[8.7](#87-升级效果与动态条目)、D-44） | 动态条目 id 需全局唯一，可省略 `id` 由运行时生成 |
| `E_BUY_AMOUNT_INVALID` | `buyAmount` **求值结果为非有限实数**（`NaN`/`±Infinity`），按 last-good 保持上次成功值（[5.9.3](#593-读写实现约定) 归一化第 ② 步）。注意：求值**失败**（`E_PARSE`/`E_UNKNOWN_ATTR` 等）与 last-good 回退**不属于**本码，只记诊断并保持旧值 | 批量购买次数需为有效数值 |
| `E_DESTROY_STATIC` | `destroy()` 试图销毁静态条目 | 静态条目只能在编辑器中删除 |
| `E_DYNAMIC_LIMIT` | 动态条目总数达到 2000 硬上限（D-32），本次 `create` 被拒绝 | 动态条目已达上限 |
| `E_PAGE_UNKNOWN` | 引用的页面不存在（`create()` 的 `page`、动态条目 `pageId`、`PageDef.entries[].id` 无归属） | 页面不存在或条目未分配页面 |
| `E_READONLY_TARGET` | 赋值到只读属性（`id/order/name/icon/perSec`、页面 `theme/columns/entries`、页面与条目 `name` 等），完整只读清单见 [5.9](#59-属性读写矩阵) | 该属性不可被表达式修改 |
| `E_ASSIGN_TYPE` | 赋值类型不匹配（布尔属性赋字符串、`effectValues[i]` 赋非数值、数值属性赋表达式文本、**表达式文本属性赋布尔或 `null`** 等） | 类型不匹配 |
| `E_CLICKER_NOT_BUYABLE` | 购买/批量购买/自动购买 `isClicker = true` 的生成器（PRD 生成器 11） | 点击器不可购买，请使用“点击”按钮 |
| `E_INDEX_OUT_OF_RANGE` | 写 `costs[i]/produces[i]/conditions[i]/effects[i]` 时下标越界 | 下标越界（增删行请用编辑器操作） |
| `E_DUPLICATE_PAGE_ENTRY` | 同一条目被分配到多个页面（PRD 补充 7） | 一个条目只能属于一个页面 |
| `E_DANGLING_REF` | 价格材料、产出目标、页面条目引用了不存在的条目 | 引用了已删除的条目 |
| `E_SAVE_FIELD_CONFLICT` | 存档顶层字段与 `assignments` 记录不一致（以顶层为准） | 已按顶层值恢复 |
| `E_BATCH_MONOTONE` | 价格非单调，降级迭代 | 建议使用单调价格 |
| `E_BATCH_CONDITION` | 升级购买条件无法走单调快路径（非单调），批量件数逐级确认并按 tick 预算分摊 | 建议用单调条件表达式（如 `bought >= n`） |
| `E_OFFLINE_APPROX` | 离线分段结算的速率序列递减或非单调，误差方向可能为正（[8.8](#88-离线模拟)、D-49） | 离线为近似结算；建议把产出速率写成非递减形式 |
| `E_CLOCK_ROLLBACK` | 离线结算时检测到墙钟回拨（`now < max(savedAt, lastSeenAt)`，系统时间被往回改）：本次不结算离线收益、不推进 `gameTime`/`offlineAccum`，只更新 `lastSeenAt`（[8.8](#88-离线模拟)、R-20） | 系统时间被回拨，本次未结算离线收益；请校准系统时间后重新载入 |
| `E_BUDGET` | 本 tick 求值次数超预算 | 已降频 |
| `E_SCHEMA` / `E_MIGRATION_FAIL` / `E_VERSION` | 文件校验/迁移/版本失败 | 路径与原因 |
| `E_ASSET_TOO_LARGE` | 资产超限 | 压缩或更换 |
| `E_ASSET_INVALID` | 资产被安全过滤拒绝（SVG 含禁止标签/事件属性、主题含 `@import`/外部 `url()` 等） | 资产不符合安全要求 |
| `E_MSG_INVALID` | postMessage 校验失败 | 忽略并计数 |

### 17.2 示例项目（节选）
```jsonc
{
  "format": "incrementforge-project",
  "version": 1,
  "engineVersion": "1.0.0",
  "meta": { "name": "示例：矿石工厂", "author": "IncrementForge", "description": "最小可玩示例", "createdAt": "2026-01-01T00:00:00.000Z", "modifiedAt": "2026-01-01T00:00:00.000Z" },
  "settings": { "numberFormat": "standard", "tickRate": 20, "maxFrameStep": 250, "autosaveInterval": 30, "offlineEnabled": true, "offlineCap": 8 },
  "resources": [
    { "id": "r1", "order": 1, "name": "矿石", "description": "基础资源", "icon": { "kind": "builtin", "value": "gem" }, "initial": "0", "max": "1e1e10", "visible": true }
  ],
  "generators": [
    {
      "id": "g1", "order": 1, "name": "矿机", "description": "自动产出矿石", "icon": { "kind": "builtin", "value": "factory" },
      "initial": "0", "max": "500", "visible": true, "disabled": false, "isClicker": false,
      "buyAmount": "1", "buyDelay": 1,
      "costs": [{ "materialId": "r1", "amount": "10 * 1.15 ^ gen.g1.bought" }],
      // produces[i].amount 是单件产出速率：总产出 = owned × 1（见 8.3 / D-30，此处不再乘 owned）
      "produces": [{ "materialId": "r1", "amount": "1" }]
    }
  ],
  "upgrades": [
    {
      "id": "u1", "order": 1, "name": "双倍产量", "description": "矿机产量 ×2", "icon": { "kind": "builtin", "value": "star" },
      "initial": "0", "max": "1", "visible": true, "disabled": false, "perSecond": true, "buyAmount": "1",
      "conditions": ["gen.g1.bought >= 5"],
      "costs": [{ "materialId": "r1", "amount": "100" }],
      // 两条效果都会被判断（PRD 升级编辑器 12）。
      // 表达式文本属性只能用“字符串字面量”给出新源码（右侧先求值，见 D-29）；一个 action 只能是一条
      // 赋值表达式（语法无语句、5.2 无 `;`、13 的 `;` 黑名单），需要多条写入时拆成多条效果。
      "effects": [
        // 效果 0：热替换单件速率——"2" 原样成为新的表达式源码（字符串字面量路径，见 5.4 的 set()）
        { "condition": "gen.g1.bought >= 5", "action": "set(\"gen.g1.produces[0].amount\", \"2\")" },
        // 效果 1：持久化效果数值——对 effValue 赋值即写回 up.u1.effectValues[1]，可被其它表达式读取
        { "condition": "gen.g1.bought >= 20", "action": "effValue = 1.5 * gen.g1.owned" }
      ]
    }
  ],
  "pages": [
    { "id": "p1", "order": 1, "name": "工厂", "description": "主页面", "icon": { "kind": "builtin", "value": "grid" }, "visible": true, "disabled": false, "theme": { "kind": "builtin", "value": "page-dark" }, "columns": 1, "entries": [ { "id": "r1", "order": 1, "theme": { "kind": "builtin", "value": "entry-dark" } }, { "id": "g1", "order": 2, "theme": { "kind": "builtin", "value": "entry-dark" } }, { "id": "u1", "order": 3, "theme": { "kind": "builtin", "value": "entry-dark" } } ] }
  ],
  "assets": {}
}
```

**补充片段（覆盖点击器、动态创建、页面禁用三条 PRD 场景，直接并入上方项目即可作为单测/E2E 夹具）**：

```jsonc
// ① 点击器（PRD 生成器编辑器 11）：isClicker = true → 取消自动生产、不可购买、bought = 0、owned = initial
//    （D-19/D-28）；costs 虽保留在数据模型中但 canBuy 恒假、永不被求值；单次点击 +owned×单件速率
{ "id": "g2", "order": 2, "name": "手动敲击", "description": "点击获得矿石", "icon": { "kind": "builtin", "value": "hand" },
  "initial": "1", "max": "10", "visible": true, "disabled": false, "isClicker": true,
  "buyAmount": "1", "buyDelay": 1,
  "costs": [],
  "produces": [{ "materialId": "r1", "amount": "1" }] }

// ② 动态创建（PRD 升级编辑器 12、补充 7）：追加到 upgrades[0].effects 的一条效果元素
//    效果前提成立时在 p1 上创建临时升级；写出稳定 id 便于后续 tick 用字面量路径赋值（D-44）。
//    前提必须带 !has(...) 幂等守卫，否则该效果每次重算都会重复创建并报 E_CREATE_ID_CONFLICT（见 8.7）
{ "condition": "gen.g1.bought >= 10 && !has(\"upgrade\", \"uTmp\")",
  "action": "create(\"upgrade\", { id: \"uTmp\", name: \"临时强化\", description: \"动态条目，不进项目文件\", page: \"p1\", initial: \"0\", max: \"1\", costs: [{ materialId: \"r1\", amount: \"50\" }], conditions: [\"true\"] })" }

// ③ 页面禁用（PRD 页面编辑器 4）：页面内条目不可购买/产出/生效，但资源卡片不置灰、导航仍可跳转（8.4）
{ "id": "p2", "order": 2, "name": "实验区", "description": "被禁用的页面", "icon": { "kind": "builtin", "value": "lab" },
  "visible": true, "disabled": true, "theme": { "kind": "builtin", "value": "page-dark" }, "columns": 1,
  "entries": [ { "id": "g2", "order": 1, "theme": { "kind": "builtin", "value": "entry-dark" } } ] }
```

- 片段 ① 的预期行为：`bought = 0`（`owned = 1`）、无“购买”按钮、`buyAmount` 写成 `-1` 也永远不会被自动购买触碰（[8.6](#86-批量--最大--自动最大购买求解) 前置判定）。
- 片段 ② 的预期行为：导出项目文件**不含** `uTmp`，存档含；卡片右上角出现“丢弃”按钮；重复触发不产生第二个条目（`has()` 守卫）；页面 `p1` 被删除后 `uTmp` 变成孤儿条目（仍存档、不渲染、诊断面板可丢弃，[8.7](#87-升级效果与动态条目)）。
- 片段 ③ 的预期行为：进入 `p2` 后 `g2` 卡片置灰且无“点击”按钮、`r1` 仍正常增长、底部导航仍可跳转（[8.4](#84-可见性与禁用的有效状态页面继承)）。

### 17.3 打包产物结构

产物里的第二段脚本是 `apps/runtime-shell/src/standalone-entry.ts` 的编译结果（**不是** `iframe-entry.ts`——后者等 `host:init` 才挂载，而产物没有宿主，会永远停在空白页；两者共用 `boot.ts` 与同一棵 `AppView`，ADR-03）。

```html
<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>示例：矿石工厂</title><style>/* 内联主题与布局样式 */</style></head>
<body><div id="app"></div>
<script>window.__IFORGE_BOOTSTRAP__={"project":{/* 内联 ProjectFile，资产为 data: URL */},"save":null,"meta":{"engineVersion":"1.0.0","builtAt":"...","fingerprint":"..."}};</script>
<script>/* 内联 runtime.iife.js：boot() → 挂载 #app → tick 循环 → localStorage 存档 */</script>
</body></html>
```

**基础样式的底色必须是 CSS 变量而不是字面量**：`html,body{background:var(--iforge-page-bg,#14161a)}`。写死颜色时 `html` 有了背景，`body` 的背景就**不再向画布传播**（CSS 背景传播规则），于是任何超出 `body` 盒子的区域——壳层被内容顶出视口时的那一段——都由 `html` 那个写死的值决定，浅色主题下表现为一条黑边。令牌本身由 `AppView` 写到 `documentElement` **与** `body` 两处（两处各有各的取值来源，见 [7.8](#78-主题图标与国际化)）。

### 17.4 内置图标与主题清单
PRD 在资源/生成器/升级/页面编辑器第 1 条、页面编辑器第 6/8 条、设置页第 1 条都要求“系统提供一系列图标/主题样式作为选择”，本节给出 V1.0 的内置清单；用户上传走 [13](#13-安全与沙箱) 的过滤与体积上限。

| 用途（对应 PRD 场景） | 内置图标 id（V1.0 必备清单） | 说明 |
| --- | --- | --- |
| 资源图标 | `gem`、`coin`、`crystal`、`energy`、`ingot` | 资源卡片左/中上图标（PRD 预览区 3） |
| 生成器图标 | `factory`、`drill`、`mine`、`lab`、`reactor` | 生成器卡片（PRD 预览区 5） |
| 点击器图标 | `hand`、`hammer`、`pick`、`click` | `isClicker = true` 时推荐使用（PRD 生成器 11） |
| 升级图标 | `star`、`arrow-up`、`bolt`、`shield` | 升级卡片（PRD 预览区 6） |
| 页面图标 | `grid`、`map`、`book`、`gear` | 页面列表与底部导航（PRD 预览区 8） |
| 系统图标 | `plus`、`copy`、`trash`、`sort-up`、`sort-down`、`undo`、`redo`、`save`、`import`、`export`、`package`、`menu`、`play`、`pause`、`restart` | 顶部标题栏、列表按钮与模拟设置栏（PRD 工作页面一览、预览区顶部） |
| 应用图标 | `iforge-logo` | 顶部标题栏左侧（PRD 工作页面一览） |

| 主题类型 | 内置 id | 令牌命名空间 | 说明 |
| --- | --- | --- | --- |
| 编辑器主题 | `dark`、`light`、`midnight` | `--iforge-*` | PRD 设置页 1；存 `settingsStore`，不进项目文件 |
| 页面主题 | `page-dark`、`page-light`、`page-midnight` | `--iforge-page-*` | PRD 页面编辑器 6；存 `PageDef.theme` |
| 条目主题 | `entry-dark`、`entry-light`、`entry-midnight` | `--iforge-entry-*` | PRD 页面编辑器 8；存 `PageDef.entries[i].theme`，缺省跟随页面主题 |

- 必需令牌清单：`--iforge-bg`、`--iforge-surface`、`--iforge-text`、`--iforge-accent`、`--iforge-danger`（页面/条目主题对应加 `page-`/`entry-` 前缀）；自定义主题缺任一必需变量时回退内置默认值（D-13、[7.8](#78-主题图标与国际化)）。
- **清单性质**：上表是 **V1.0 必备清单**（PRD 只要求“系统提供一系列图标/主题样式”，未规定数量），实现可增补，但必须**完整覆盖**本表 id 且 id 不得变更——项目文件与存档里以 `id` 引用内置资源，改名即破坏旧项目。增补的 id 同样遵守该规则并随文档更新。
- 内置图标全部为内联 SVG path，不产生网络请求；打包时与项目资产一并内联（[11.1](#111-构建管线)、[11.2](#112-体积与优化)）。

### 17.5 实施里程碑（建议）
| 阶段 | 内容 | 交付标准 |
| --- | --- | --- |
| M1 数值与表达式 | `@iforge/num`、`@iforge/expr`、错误码、单元测试 | 大数与表达式测试全绿，含 1e1e10 用例 |
| M2 模型与运行时 | `@iforge/model`、`@iforge/runtime`（tick/产出/购买/升级/存档） | 可在无 UI 下跑通示例项目 1000 tick |
| M3 编辑器骨架 | React 布局、四类工作区表单、撤销重做、IndexedDB 持久化 | 增删改查 + 保存/导入导出可用 |
| M4 预览与模拟 | iframe 沙箱、协议、仪表盘、离线结算、点击器/批量购买 | 预览与运行时数据一致（自动化断言） |
| M5 打包与打磨 | 单文件构建、主题/图标、错误面板、性能优化、Playwright | E2E 全流程通过，产物可离线游玩（`file://` 直接打开） |

### 17.6 需求追溯矩阵（PRD → TECH 章节 → 实现包 → 测试）
用于评审与回归自查：PRD 每条需求都应有技术落点与可执行用例；新增需求时先补本表，再改设计与用例。表内按 PRD 的结构分组（核心功能 → 工作页面 → 左侧列表 → 四类工作区 → 设置页 → 预览区 → 补充），分组只是排版需要，不改变 PRD 编号。

**PRD 核心功能（1–9）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 1 数学运算（防上下溢出、幂塔级） | [4.1](#41-需求映射)–[4.5](#45-显示格式) | `num` | 饱和/格式化/分层比较单测、格式化缓存键用例 |
| 2 表达式沙箱（常量/条件/赋值三类表达式） | [5.1](#51-语言定位)–[5.8](#58-表达式编辑器交互) | `expr` | 解析器与静态校验错误码单测、各上下文求值单测 |
| 3 项目管理（新建/保存/导入导出/打包，单项目，预留多项目） | [7.9](#79-项目生命周期新建保存导入导出)、[10.2](#102-导入--导出)、[11.1](#111-构建管线)、[15](#15-扩展框架预留)、[6.1](#61-公共字段)、D-45 | `editor/shell`、`persist`、`build` | 导入迁移用例（含**静态 `id` 命名约束 `E_ID_INVALID`**、V1.0 不暴露多项目入口）、E2E 全流程、打包冒烟 |
| 4 资源系统（增删改） | [6.1](#61-公共字段)、[6.5.1](#651-资源prd-资源编辑器-16)、[7.5](#75-条目列表交互规格)、[7.6](#76-工作区实现要点)、[8.11](#811-游戏视图与卡片字段映射prd-预览区-18) | `model`、`runtime` | 集成：影子运行时与 store 同步；列表增删复制 |
| 5 生成器系统（增删改） | [6.5.2](#652-生成器prd-生成器编辑器-111)、[8.3](#83-单-tick-顺序固定时序可预测)、[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解) | `model`、`runtime` | 购买结算、批量求解、点击器用例 |
| 6 升级系统（增删改） | [6.5.3](#653-升级prd-升级编辑器-112)、[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解)、[8.7](#87-升级效果与动态条目) | `model`、`runtime` | 条件前缀语义（含中间为假反例）、多效果不短路、`effectValues` 持久化 |
| 7 页面编辑（增删改、分配条目、排列布局） | [6.1](#61-公共字段)、[6.5.4](#654-页面prd-页面编辑器-18)、[7.5](#75-条目列表交互规格)、[7.6](#76-工作区实现要点)、[8.4](#84-可见性与禁用的有效状态页面继承) | `model`、`editor/pages` | 页面唯一性、布局联动、可见/禁用继承用例 |
| 8 预览与模拟 | [9.1](#91-沙箱模型)–[9.3](#93-生命周期)、[8.2](#82-主循环请求动画帧驱动)、[8.3.1](#831-交互事件与-tick-边界)、[8.9](#89-仪表盘数据)、[8.10](#810-游戏内设置页与存档操作prd-预览区-9)、[7.4](#74-同步到预览) | `runtime`（协议/视图模型/补丁）、`runtime-shell`（主循环 + 游戏视图）、`editor/preview` | 协议往返与**注入物端到端**（esbuild 真实产物在 jsdom 里执行，断言标题/仪表盘/卡片/导航与运行时算出的数字一致）、**交互事件与 tick 边界**（点击/购买即时结算、副作用下一提交阶段）、游戏内设置覆盖用例、倍速下周期触发用例、**热更新保留进度**（改名称不清空 `amount/bought/owned`、被赋值过的表达式文本不被覆盖）、错误 `sessionId` 丢弃、`nPlan === 0` 的帧仍推进真实时间（自动存档间隔按真实秒数触发） |
| 9 游戏打包（导出可运行 HTML） | [11.1](#111-构建管线)、[11.2](#112-体积与优化)、[17.3](#173-打包产物结构)、[10.3](#103-存档时机)、D-53/D-54 | `build`、`runtime-shell`（`local-sink`） | 打包前校验的 7 条拦截、产物结构自检（无外部引用 + 体积预算 + **基础样式的底色是 CSS 变量而非写死的暗色**）、**`file://` 打开的单文件 E2E**（可玩 + 存档往返 + 导出/重新导入）、**壳层底色跟随页面主题**（画布/body/根节点三处同色 + 文档不产生额外滚动） |

**PRD 工作页面一览（顶部标题栏 / 左侧功能区 / 中间工作区 / 右侧预览区）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 顶部标题栏（图标+标题 / 项目名称 / 新建·保存·导入·导出·撤销重做·打包） | [7.1](#71-界面总体布局prd-工作页面一览)、[7.3](#73-撤销重做)、[7.9](#79-项目生命周期新建保存导入导出)、[17.4](#174-内置图标与主题清单) | `editor/app`、`editor/shell` | 撤销“重命名”后列表与预览同步回退；打包按钮仅 `game:ready` 后可用 |
| 左侧功能区（资源/生成器/升级/页面/设置） | [7.1](#71-界面总体布局prd-工作页面一览)、[7.2](#72-状态管理) | `editor/app` | 切换功能区不改项目数据与预览、不产生历史记录 |
| 中间工作区（内容随功能区变化） | [7.6](#76-工作区实现要点)、[7.7](#77-设置页面实现要点) | `editor/features/*` | 切换时未提交文本不丢失（合并窗口） |
| 右侧预览区（游戏预览 + 模拟交互） | [7.1](#71-界面总体布局prd-工作页面一览)、[9.1](#91-沙箱模型)、[9.3](#93-生命周期)、D-42 | `editor/preview`、`runtime-shell` | 面板折叠/宽度调整不产生历史记录；卸载项目释放 tick；**`sandbox` 不含 `allow-same-origin`**；`host:init` 在 `load` 上补发；**注入物端到端**后**产物里不含设备/暂停/倍速/解锁全部**（D-42、R-32） |

**PRD 左侧列表（四类一致：标题 + 添加按钮；条目 = 图标 + 名称 + 排序/复制/删除）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 资源/生成器/升级/页面列表结构与增删改复制排序 | [7.5](#75-条目列表交互规格)、[6.4](#64-校验与迁移)、D-38、D-39、D-40 | `editor/features/*` | 列表增删改复制用例、引用提示弹窗、`order` 连续化 |

**PRD 四类工作区字段（资源 1–6 / 生成器 1–11 / 升级 1–12 / 页面 1–8）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 资源编辑器 1–6（图标、名称、描述、初始数量、上限、可见） | [6.5.1](#651-资源prd-资源编辑器-16)、[5.9.1](#591-条目属性)、[8.5](#85-购买结算)、[8.11](#811-游戏视图与卡片字段映射prd-预览区-18) | `model`、`runtime` | `applyCap` 单调性、`reset` 回项目值用例、改名/改图标即时同步 |
| 生成器编辑器 1–7（图标、名称、描述、初始数量、上限、是否禁用、游戏可见） | [6.5.2](#652-生成器prd-生成器编辑器-111)、[8.4](#84-可见性与禁用的有效状态页面继承) | `model`、`runtime` | 禁用/不可见时不产出、不生效用例 |
| 生成器编辑器 8（批量购买三态：正数 / `0` 最大 / 负数自动最大） | [8.6](#86-批量--最大--自动最大购买求解)、[5.9.3](#593-读写实现约定)、D-36、D-48 | `runtime` | fast-check：求解器与暴力解一致、`buyAmount` 归一化用例、`free` 免闭式二分（≤ 20 次求值）、闭式族四族与未见采样点复验、作者改写提示 |
| 生成器编辑器 9（购买价格，价格成长由已购买数量表达式实现） | [6.5.2](#652-生成器prd-生成器编辑器-111)、[8.5](#85-购买结算) | `model`、`runtime` | 多材料求解取 `min`、价格前缀求和用例 |
| 生成器编辑器 10（产出资源：单件产出速率表达式、可产出到其它生成器且不影响其价格） | [8.3](#83-单-tick-顺序固定时序可预测)、D-30 | `runtime` | 产出结算不含 `owned²`；产出到生成器不影响其价格 |
| 生成器编辑器 11（点击器：取消自动生产、不可购买、受初始数量影响、可多个；`isClicker` 可被赋值） | [8.3](#83-单-tick-顺序固定时序可预测)、[8.4](#84-可见性与禁用的有效状态页面继承)、[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解)、[6.3](#63-存档文件-schemasavejson)、D-19、D-28 | `runtime` | 点击器不可购买（自动购买/批量/UI 三路径）；点击器初始化 `bought=0`；**运行时切换 `isClicker` 后存档往返仍为点击器且 `bought/owned` 未重置** |
| 升级编辑器 1–7（图标、名称、描述、初始数量、上限、是否禁用、游戏可见） | [6.5.3](#653-升级prd-升级编辑器-112)、[8.4](#84-可见性与禁用的有效状态页面继承) | `model`、`runtime` | 同生成器 1–7 |
| 升级编辑器 8（购买条件列表，AND 判定，OR 由用户自写表达式） | [6.5.3](#653-升级prd-升级编辑器-112)、[8.5](#85-购买结算)、补充 4 | `model`、`runtime` | 条件全真才可购买、用双竖线 `\|\|` 自实现 OR 的用例 |
| 升级编辑器 9（批量购买直到不满足条件/价格；批量只结算最后一级的效果） | [8.6](#86-批量--最大--自动最大购买求解)、D-06、D-24 | `runtime` | 条件前缀语义反例（`bought == 0 \|\| bought >= 5` 停在空洞前）+ 阈值型条件不越买 + “下一档”条件能买满 `max` + 暴力解性质测试 + `free` 模式末级语义用例 |
| 升级编辑器 10（购买价格） | [6.5.3](#653-升级prd-升级编辑器-112)、[8.5](#85-购买结算) | `model`、`runtime` | 同生成器 9 |
| 升级编辑器 11（每秒生效：重新计算而非叠加、离线不触发） | [8.3](#83-单-tick-顺序固定时序可预测)、D-35、D-43 | `runtime` | 倍速下触发次数 ≈ `gameTime` 增量、离线不触发、**未拥有（`owned = 0`）的升级不触发** |
| 升级编辑器 12（效果前提/内容/效果数值；动态创建与丢弃条目） | [5.2](#52-语法)、[5.9.3](#593-读写实现约定)、[8.7](#87-升级效果与动态条目)、[7.6](#76-工作区实现要点)、[6.3](#63-存档文件-schemasavejson)、D-23、D-29、D-34、D-44、D-47 | `expr`、`runtime` | `create()` spec 校验、`E_CREATE_ID_CONFLICT`、动态条目创建后赋值与读档后继续赋值、字面量语法边界、`destroy` 静态保护、多效果不短路、`effectValues` 只读展示与快捷插入模板、**表达式文本赋值的“可做/不可做”对照（无字符串拼接 → `E_TYPE`）** |
| 页面编辑器 1–3、6–8（图标、名称、描述、页面主题、页面布局、页面条目主题） | [6.5.4](#654-页面prd-页面编辑器-18)、[7.6](#76-工作区实现要点)、[17.4](#174-内置图标与主题清单) | `model`、`editor/pages` | 布局联动、条目主题跟随页面主题、自定义主题令牌回退 |
| 页面编辑器 4/5（禁用/可见对条目的继承，禁用仍可跳转） | [8.4](#84-可见性与禁用的有效状态页面继承)、D-21 | `runtime` | 继承用例 + E2E：禁用后 100 tick 资源不再增长、资源卡片不置灰、导航可跳转 |

**PRD 设置页面（1–6）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 设置页 1 编辑器主题（内置 + 上传） | [7.7](#77-设置页面实现要点)、[7.8](#78-主题图标与国际化)、[13](#13-安全与沙箱)、D-13 | `editor/settings`、`ui-kit` | 主题切换同步 iframe；自定义主题过滤与令牌回退 |
| 设置页 2–4 项目名称 / 作者 / 描述 | [6.5.5](#655-设置页面prd-设置页面-16)、[7.7](#77-设置页面实现要点) | `editor/settings` | 改项目名称同步标题栏与预览 |
| 设置页 5 创建时间/最后修改/引擎版本/当前引擎（只读） | [6.2](#62-项目文件-schemajson)、[7.7](#77-设置页面实现要点)、[10.1](#101-indexeddb-结构) | `model`、`editor/settings` | 四项不可编辑；保存后 `engineVersion` 更新 |
| 设置页 6 游戏默认设置（数字格式/帧率/最大步长/存档间隔/离线收益开关/上限） | [6.5.5](#655-设置页面prd-设置页面-16)、[7.7](#77-设置页面实现要点)、[8.2](#82-主循环请求动画帧驱动)、[8.8](#88-离线模拟)、D-03、D-11、D-49 | `editor/settings`、`runtime` | 改动热更新预览、来源徽标与恢复默认、`tickRate>0` 等打包校验、**离线近似误差的方向性**（递增→下界、递减/非单调→`E_OFFLINE_APPROX`、三类机制不触发）、**离线墙钟回拨不结算**（`E_CLOCK_ROLLBACK`） |

**PRD 预览区（顶部模拟设置栏 + 游戏视图 1–9）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 顶部模拟设置栏（设备三选一、暂停/继续/重新开始、倍速、解锁全部；不属于游戏内容） | [7.1](#71-界面总体布局prd-工作页面一览)、[8.2](#82-主循环请求动画帧驱动)、[8.3.1](#831-交互事件与-tick-边界)、[9.2](#92-消息协议)、D-16、D-31、D-35、D-41、D-42 | `editor/preview`、`runtime` | 设备断点、暂停后不推进（暂停时交互仍即时结算、副作用待恢复后提交）、**强制解锁标记的生命周期**（不落盘、重置/读档即清空）、解锁全部可被覆盖；产物不含该栏 |
| 游戏视图 1–2（顶部标题栏、数据仪表盘） | [8.9](#89-仪表盘数据)、[8.11](#811-游戏视图与卡片字段映射prd-预览区-18) | `runtime` | 预测时间的 `—` 分支用例、预测按**下一件**价格（免费模式显示“现在”）、**展开/收回**与“条目多时主区不为 0”、**仪表盘不再渲染 tick 耗时/帧率/诊断** |
| 游戏视图 3–6（资源/点击器/生成器/升级卡片字段与按钮） | [8.11](#811-游戏视图与卡片字段映射prd-预览区-18)、[8.4](#84-可见性与禁用的有效状态页面继承)、[8.5](#85-购买结算) | `runtime` | 卡片字段映射 E2E、动态条目“丢弃”按钮 |
| 游戏视图 7–8（页面描述、底部导航，最后一格为设置） | [8.11](#811-游戏视图与卡片字段映射prd-预览区-18)、[8.12](#812-页面导航与当前页面prd-预览区-8)、[7.9](#79-项目生命周期新建保存导入导出) | `runtime` | 导航按 `order` 渲染、设置页为内置页不进 `pages`、页面跳转用例（`nav()` 入口、禁用仍可跳转、不可见可直达、初值规则） |
| 游戏视图 9（游戏内设置页：只读信息 + 可改设置 + 导出/导入存档 + 重新开始 + 页面主题开关） | [8.10](#810-游戏内设置页与存档操作prd-预览区-9)、[10.3](#103-存档时机)、[7.8](#78-主题图标与国际化)、D-18、D-22 | `runtime`、`persist` | 设置覆盖分层用例、存档往返、reset 回滚用例、**页面主题开关**（即时生效 + 打包态刷新后仍在 + 自定义 CSS 被拒） |

**PRD 补充（1–10）**

| PRD 需求 | TECH_DESIGN 章节 | 实现包 | 测试落点 |
| --- | --- | --- | --- |
| 补充 1（随机函数：价格表达式禁用、离线禁用） | [5.4](#54-内置函数)、[5.5](#55-上下文context与权限)、[8.8](#88-离线模拟) | `expr` | `E_RAND_DISABLED` 用例 |
| 补充 2（`1e1e10` 量级购买/产出/效果） | [4](#4-数值系统设计)、[8.6](#86-批量--最大--自动最大购买求解)、[12](#12-性能预算与优化) | `num`、`runtime` | 购买 `1e1e10` 用例、批量购买 bench、批量购买降级最坏情况（1e5 次/tick 分摊） |
| 补充 3（`bought`/`owned`/`max` 语义与重置为 `initial`） | [5.3](#53-内置变量)、[5.9.1](#591-条目属性)、[8.5](#85-购买结算)、[4.4](#44-溢出下溢策略饱和语义) 第 6 条、D-37、D-46 | `runtime` | `bought`/`owned` 独立可写用例、`res.owned` 别名用例、硬上限用例、`Infinity` 字面量与“无上限”（`max = "Infinity"` 免钳制、其余字段折算为 `NUM_MAX` + `E_OVERFLOW`） |
| 补充 4（升级购买条件列表 AND；需 OR 由用户自写表达式） | [6.2](#62-项目文件-schemajson)、[8.5](#85-购买结算)、[8.6](#86-批量--最大--自动最大购买求解) | `model`、`runtime` | 条件全真才可购买、用双竖线 `\|\|` 自实现 OR 的用例 |
| 补充 5（升级“每秒生效”按 `order` 稳定排序） | [8.3](#83-单-tick-顺序固定时序可预测)、[8.2](#82-主循环请求动画帧驱动)、D-35 | `runtime` | tick 时序用例、倍速下触发次数用例 |
| 补充 6（被赋值属性的更改持久化于单局存档、不写项目文件、“重新开始”复原） | [6.3](#63-存档文件-schemasavejson)、[5.9.3](#593-读写实现约定)、D-25、R-08、R-33 | `runtime`、`persist` | **存档往返覆盖全部可写属性（含 `isClicker`）**、导出项目文件不含运行时赋值、动态条目读档顺序用例、`reset` 复原用例 |
| 补充 7（一个条目只属于一个页面；动态条目创建时必须指定页面） | [6.2](#62-项目文件-schemajson)、[6.4](#64-校验与迁移)、[8.7](#87-升级效果与动态条目)、[7.5](#75-条目列表交互规格) | `model`、`runtime` | `E_DUPLICATE_PAGE_ENTRY`、`E_PAGE_UNKNOWN`、复制不跨页面、**`pageId` 失效的动态条目**（保留存档/不渲染/诊断面板可丢弃/页面恢复后自动出现） |
| 补充 8（游戏为单存档，预留多存档管理框架） | [6.3](#63-存档文件-schemasavejson)、[10.1](#101-indexeddb-结构)、[15](#15-扩展框架预留) | `persist` | `slotId='main'` 固定、存档键与导出导入往返用例 |
| 补充 9（当前版本仅中文，预留多语言框架） | [7.8](#78-主题图标与国际化)、[15](#15-扩展框架预留) | `i18n`、`editor` | 文案全部走 `t()` key，无散落硬编码文案 |
| 补充 10（未明确事项自行决策并写入“风险与措施”） | [16.1](#161-决策记录prd-未明确事项)、[16.2](#162-风险清单) | — | 决策记录逐条可回溯到本矩阵与 PRD 补充 10 |
