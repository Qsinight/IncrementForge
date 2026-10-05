/**
 * `@iforge/runtime` —— 游戏运行时（TECH_DESIGN 8、9 的运行侧、10 的序列化路径）。
 *
 * 依赖规则（3.2）：`num ← expr ← model ← runtime ← (persist | build)`。
 * 本包不导入任何 DOM API——主循环的**时间累积**（8.2）已抽成纯算术的 `FrameClock`，
 * `requestAnimationFrame` 由 M4 的预览 iframe / M5 的打包版提供 `now` 即可。
 *
 * ## 模块地图
 *
 * | 模块 | 职责 | 文档 |
 * | --- | --- | --- |
 * | `keys` | 属性键的构造与解析（与 `expr` 的 `formatPathKey` 同源） | 5.6、5.9 |
 * | `attribute-store` | 属性当前值、`Scope.read`、副作用写入、版本号、赋值审计 | 5.6、5.7、5.9.3、6.3 |
 * | `expression-runtime` | 五个上下文的求值器 + `EffectSink` + 随机源 | 5.5~5.7、8.3 第 1 步 |
 * | `visibility` | `pageOf`/`isVisible`/`isDisabled`/`canBuy`… 的**唯一**判定入口 | 8.4、D-21 |
 * | `production` | 产出结算与点击器点击（单件口径 D-30） | 8.3 第 3~4 步、8.5 |
 * | `purchase` | 价格求值（只读等级视图）、`buyOne`、条件前缀语义 | 8.5、8.6.1、8.6.2 |
 * | `batch` | 批量/最大/自动最大求解：形状识别 + 二分 + 逐级降级 | 8.6、ADR-08、D-48 |
 * | `upgrade-effect` | `applyEffect`（`owned > 0` 前置、不短路、写入同生共死） | 8.7、D-23、D-43 |
 * | `dynamic-registry` | `create()`/`destroy()` 的落地、上限、孤儿口径 | 8.7、D-32、D-44 |
 * | `game-state` | tick 时序（1~8 步）、导航、复位、解锁全部 | 8.1~8.3、8.12 |
 * | `clock` | 帧时间累积与步数计划（纯算术） | 8.2 |
 * | `dashboard` | 增长速度与下一个可购买条目的预测时间 | 8.9 |
 * | `offline` | 分段几何步长、墙钟回拨、误差方向 | 8.8、D-49、R-20 |
 * | `save` | 存档序列化与 ①~⑦ 读档顺序 | 6.3、6.4、D-25、R-28、R-33 |
 * | `protocol` | 预览 ↔ 宿主的消息信封与校验（**运行侧**，宿主侧在 `editor/preview`） | 9.2、9.3、13 第 3 条、R-19 |
 * | `view-model` | 视图模型：把生效值派生成可序列化的卡片/仪表盘/导航/设置页 | 8.8~8.12 |
 *
 * ## 为什么协议与视图模型也归本包
 *
 * - **协议（9.2）** 是双向契约：编辑器与预览 iframe 必须引用**同一份** `kind` 枚举与
 *   校验规则，否则会出现“宿主认为合法、运行时丢弃”的静默不同步（R-19）。放进编辑器
 *   会让打包产物（ADR-05）反向依赖编辑器应用，违反 3.2 的依赖方向。
 * - **视图模型（8.9/8.11）** 是“预览与运行时数据一致（17.5 的 M4 交付标准）”的可断言中间层：
 *   展示逻辑只在这里存在一次，React 视图与测试都消费它，因此不存在“两套逻辑”。
 */
export * from './keys.js'
export * from './attribute-store.js'
export * from './expression-runtime.js'
export * from './dynamic-registry.js'
export * from './visibility.js'
export * from './production.js'
export * from './purchase.js'
export * from './batch.js'
export * from './upgrade-effect.js'
export * from './interactions.js'
export * from './clock.js'
export * from './game-state.js'
export * from './dashboard.js'
export * from './offline.js'
export * from './save.js'
export * from './protocol.js'
export * from './patch.js'
export * from './view-model.js'
