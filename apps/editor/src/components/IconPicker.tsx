/**
 * 图标选择器（TECH_DESIGN 7.6「IconPicker：内置图标网格 + 上传 + 裁剪」、13 第 4 条、10.1）。
 *
 * 上传链路（10.1「上传落库」）：`File` → `ui-kit` 的过滤（白名单 + 体积）→ 资产库
 * → 项目内以 `{kind:'asset', value: assetId}` 引用。**数据 URL 不内联进项目模型**（D-12）；
 * `onUpload` 缺席时（单测、未接数据库的降级路径）直接用 data URL，功能不缺失。
 *
 * “裁剪”按 PRD 只做到**重新编码压缩**（≤ 32KB，11.2）：真正的交互裁剪框属于 M5 的打磨项，
 * 当前用缩放 + 质量递减达到同等目的（`imageFileToDataUrl` 内部实现）。
 */
import { useRef, useState } from 'react'

import { t } from '@iforge/i18n'
import { ICON_GROUPS, assertAllowedMime, iconsOfGroup, imageFileToDataUrl, renderIconSvg, sanitizeSvg } from '@iforge/ui-kit'
import type { IconGroup } from '@iforge/ui-kit'
import type { IconRef } from '@iforge/model'

import { Field } from './fields.js'

/** 分组的中文名（PRD 语境：资源/生成器/点击器/升级/页面/系统图标，17.4 表）。 */
const GROUP_LABEL: Readonly<Record<IconGroup, string>> = {
  resource: '资源图标',
  generator: '生成器图标',
  clicker: '点击器图标',
  upgrade: '升级图标',
  page: '页面图标',
  system: '系统图标',
  app: '应用图标',
}

export interface IconPickerProps {
  label?: string
  value: IconRef
  onChange(value: IconRef): void
  /** 上传成功后拿到的已过滤资产（编辑器把它写入资产库，10.1「上传落库」）。 */
  onUpload?(asset: { mime: string; data: string; name: string }): void
  hint?: string
  /** 只显示某几个分组（表单按条目类型给出推荐分组）。 */
  groups?: readonly IconGroup[]
  disabled?: boolean
}

export function IconPicker({ label = t('field.icon'), value, onChange, onUpload, hint, groups, disabled }: IconPickerProps) {
  const [error, setError] = useState<string | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)
  const visible = groups ?? ICON_GROUPS.filter((group) => group !== 'app')

  const handleFile = async (file: File): Promise<void> => {
    try {
      assertAllowedMime(file.type)
      // SVG 走白名单过滤，位图走重编码压缩（13 第 4 条 / 11.2）。
      const data = file.type === 'image/svg+xml' ? await svgToDataUrl(file) : await imageFileToDataUrl(file)
      onUpload?.({ mime: file.type, data, name: file.name })
      onChange({ kind: 'data', value: data })
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const previewId = value.kind === 'builtin' ? value.value : 'star'

  return (
    <Field label={label} hint={hint} error={error}>
      {({ id }) => (
        <div className="icon-picker" id={id}>
          <div className="icon-picker-preview">
            {value.kind === 'data' ? (
              <img src={value.value} alt="" width={32} height={32} />
            ) : (
              <span dangerouslySetInnerHTML={{ __html: renderIconSvg(previewId, { size: 32 }) }} />
            )}
          </div>
          <div className="icon-picker-grid">
            {visible.map((group) => (
              <div key={group} className="icon-group">
                <span className="icon-group-title">{GROUP_LABEL[group]}</span>
                <div className="icon-group-items">
                  {iconsOfGroup(group).map((icon) => (
                    <button
                      key={icon.id}
                      type="button"
                      disabled={disabled}
                      className={value.kind === 'builtin' && value.value === icon.id ? 'icon-cell active' : 'icon-cell'}
                      aria-label={icon.label}
                      aria-pressed={value.kind === 'builtin' && value.value === icon.id}
                      title={icon.label}
                      onClick={() => onChange({ kind: 'builtin', value: icon.id })}
                      dangerouslySetInnerHTML={{ __html: renderIconSvg(icon.id, { size: 20 }) }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="icon-picker-upload">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              aria-label={t('common.upload')}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
                event.target.value = ''
              }}
            />
            <span className="muted">{t('common.upload')}（png/jpeg/webp/svg，≤64KB）</span>
          </div>
        </div>
      )}
    </Field>
  )
}

/** SVG 上传：白名单过滤后转 data URL（13 第 4 条）。 */
async function svgToDataUrl(file: File): Promise<string> {
  const text = await file.text()
  const sanitized = sanitizeSvg(text, 'icon')
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(sanitized)))}`
}
