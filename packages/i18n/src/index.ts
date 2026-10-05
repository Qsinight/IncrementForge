/**
 * `@iforge/i18n` —— 国际化（PRD 补充 9：当前版本仅中文，预留多语言框架；TECH_DESIGN 7.8、15）。
 *
 * ## 预留接口
 *
 * `LocaleRegistry.register(locale, dict)`（15 表「多语言」行）就是多语言的全部预留：
 * V1.0 只注册 `zh-CN`，不提供语言切换入口（15「UI 暴露口径」明确禁止提前暴露，
 * 否则会锁定数据模型）。
 *
 * ## 为什么文案以 TS 模块而非 JSON 交付
 *
 * 7.7 末条要求文案“集中在一处”，交付格式是 JSON；但 JSON 无法让键集合参与类型推导，
 * 打错键名只能运行时暴露。用 TS 模块 + `as const` 拿到同样的一条集中点，
 * 外加 `missingKeys()` 这个可执行检查（见下），比 JSON 严格而不增加维护成本。
 */
import { zhCN } from './locales/zh-CN.js'
import type { MessageKey } from './locales/zh-CN.js'

export type { MessageKey }
export { zhCN }

/** 文案表：键 -> 文案。`{name}` 形式的占位符在 `t()` 时替换。 */
export type LocaleDict = Readonly<Record<string, string>>

/** 插值参数（值必须是字符串或数字，避免 `t()` 内部拿到对象）。 */
export type MessageParams = Readonly<Record<string, string | number>>

/** V1.0 唯一注册的 locale（PRD 补充 9）。 */
export const DEFAULT_LOCALE = 'zh-CN'

/**
 * locale 注册表（15 的多语言预留接口）。
 *
 * 只做三件事：登记、查表、比对键集合。**不**做语言协商、回落链或按 key 懒加载——
 * 那些只有在真的存在第二种语言时才有意义（避免 YAGNI）。
 */
export class LocaleRegistry {
  private readonly dicts = new Map<string, LocaleDict>()

  /** 登记一个 locale 的文案表；重复登记同 key 视为覆盖（便于测试替换）。 */
  register(locale: string, dict: LocaleDict): void {
    this.dicts.set(locale, dict)
  }

  has(locale: string): boolean {
    return this.dicts.has(locale)
  }

  locales(): readonly string[] {
    return [...this.dicts.keys()]
  }

  /** 取文案表；未登记时返回 `undefined`（由 `t()` 决定回落策略）。 */
  get(locale: string): LocaleDict | undefined {
    return this.dicts.get(locale)
  }

  /**
   * 比对 `locale` 相对 `base` 缺失的键（多语言框架的回归入口）。
   *
   * 新增 locale 时用它把“漏翻译”变成 CI 失败，而不是界面上出现裸键名。
   */
  missingKeys(locale: string, base: string = DEFAULT_LOCALE): string[] {
    const baseDict = this.dicts.get(base)
    const dict = this.dicts.get(locale)
    if (!baseDict || !dict) return []
    return Object.keys(baseDict).filter((key) => !(key in dict))
  }

  /** locale 是否已登记且相对 `base` 无缺键。 */
  isComplete(locale: string, base: string = DEFAULT_LOCALE): boolean {
    return this.has(locale) && this.missingKeys(locale, base).length === 0
  }
}

/** 进程内共享的注册表（单例；测试可用 `resetLocales()` 复位）。 */
export const localeRegistry = new LocaleRegistry()

localeRegistry.register(DEFAULT_LOCALE, zhCN)

/** 当前 locale。V1.0 恒为 `zh-CN`，但接口保留（15）。 */
let currentLocale = DEFAULT_LOCALE

/** 切换 locale；返回是否切换成功（未登记时不切换，保持原 locale）。 */
export function setLocale(locale: string): boolean {
  if (!localeRegistry.has(locale)) return false
  currentLocale = locale
  return true
}

export function getLocale(): string {
  return currentLocale
}

/** 测试用：清空注册表与当前 locale（`t()` 的回落行为需要在测试里可复现）。 */
export function resetLocales(): void {
  localeRegistry.register(DEFAULT_LOCALE, zhCN)
  currentLocale = DEFAULT_LOCALE
}

/**
 * 当前 locale 相对 `zh-CN` 缺失的键（测试与 `docs:check` 的探针）。
 *
 * V1.0 只有一种语言，因此它恒为空数组——但**保留这个出口**是有意的：
 * 多语言真正落地时，“新键忘了写文案”需要有地方能自动失败（15）。
 */
export function missingKeysProbe(locale: string = currentLocale, base: string = DEFAULT_LOCALE): string[] {
  return localeRegistry.missingKeys(locale, base)
}

/**
 * 缺失键的可见标记。
 *
 * 缺键**必须**在界面上显眼：`⚠` 前缀让“漏翻译”在截图/走查里立刻可见，
 * 而不是默默显示裸键名（`resource.initial` 与 label 混在一起很难排查）。
 */
const MISSING_PREFIX = '⚠'

/**
 * 取文案。
 *
 * @param key 文案键（类型受 `MessageKey` 约束；运行时也接受任意字符串，便于 `t(keyFromData)`）
 * @param params `{name}` 占位符的替换值
 * @returns 查到的文案；缺键返回 `⚠<key>`；缺参数时保留占位符原文
 */
export function t(key: MessageKey | string, params?: MessageParams): string {
  const template = localeRegistry.get(currentLocale)?.[key] ?? zhCN[key as MessageKey]
  if (template === undefined) return `${MISSING_PREFIX}${key}`
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}
