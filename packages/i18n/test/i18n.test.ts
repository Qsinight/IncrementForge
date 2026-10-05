import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCALE, localeRegistry, missingKeysProbe, resetLocales, setLocale, t, zhCN } from '../src/index.js'

describe('@iforge/i18n（PRD 补充 9 / TECH_DESIGN 7.8、15）', () => {
  it('V1.0 只注册 zh-CN，且相对基准无缺键', () => {
    expect(localeRegistry.locales()).toEqual([DEFAULT_LOCALE])
    expect(localeRegistry.isComplete('zh-CN')).toBe(true)
  })

  it('缺键返回可见的 ⚠ 前缀而不是裸键名', () => {
    expect(t('not.a.key')).toBe('⚠not.a.key')
  })

  it('切换到未登记的 locale 会被拒绝，当前 locale 不变', () => {
    expect(setLocale('en-US')).toBe(false)
    expect(t('app.title')).toBe('增量工坊')
    localeRegistry.register('en-US', { 'app.title': 'IncrementForge' })
    expect(setLocale('en-US')).toBe(true)
    // 未翻译的键回落到基准 locale，而不是变成 ⚠（否则切语言会把整个界面变成告警）。
    expect(t('sideNav.resources')).toBe('资源')
    expect(t('app.title')).toBe('IncrementForge')
    resetLocales()
    expect(t('app.title')).toBe('增量工坊')
  })

  it('missingKeys 能把“漏翻译”变成可执行检查（15 的多语言预留接口）', () => {
    localeRegistry.register('fr-FR', { 'app.title': 'Forge Incrémental' })
    expect(localeRegistry.missingKeys('fr-FR').length).toBe(Object.keys(zhCN).length - 1)
    expect(localeRegistry.missingKeys('fr-FR')).not.toContain('app.title')
    expect(localeRegistry.isComplete('fr-FR')).toBe(false)
    resetLocales()
  })

  it('占位符替换；缺参数时保留原文', () => {
    expect(t('delete.pageAssignment', { page: '主页面' })).toBe('页面归属：主页面（将从该页面移除）')
    expect(t('delete.pageAssignment')).toContain('{page}')
  })

  it('missingKeysProbe 暴露给测试与文档校验脚本', () => {
    expect(missingKeysProbe()).toEqual([])
  })
})
