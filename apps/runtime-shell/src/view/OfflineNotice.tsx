/**
 * 离线收益提示条（8.8 末条、8.10，R-14、D-49、R-20）。
 *
 * ## 为什么必须显式写出“离线不含随机/每秒生效/自动购买”
 *
 * PRD 设置页 9 给出的“离线收益低于在线”的**理由**就是这三项机制不触发（8.8 的第 2 条）。
 * 不把这句话写进提示条，玩家（和作者）看到收益偏低会以为引擎算错了；而实际上离线**可能高估**
 * （速率递减/非单调时分段结算 ≥ 逐 tick 真值，D-49）。因此提示条同时给出：
 *
 * - 离线时长 / 实际结算时长（截断后）；
 * - 各资源增量；
> - `clockRollback`（墙钟回拨，本次未结算，R-20）；
 * - `approximate`（近似结算，误差方向可能为正，D-49）；
 * - `truncated`（被 `offlineCap` 截断或段数预算顺延，8.8 约束 ①）；
 * - **固定文案**：“离线不含随机、每秒生效与自动购买”。
 */
import type { OfflineNoticeView } from '@iforge/runtime'
import { t } from '@iforge/i18n'

export interface OfflineNoticeProps {
  notice: OfflineNoticeView
  onDismiss(): void
}

export function OfflineNotice({ notice, onDismiss }: OfflineNoticeProps) {
  return (
    <aside className="offline-notice" data-testid="offline-notice" role="status">
      <div className="offline-head">
        <strong>{t('game.offlineTitle')}</strong>
        <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onDismiss}>
          ✕
        </button>
      </div>
      {notice.clockRollback ? (
        <p className="offline-warn" data-testid="offline-rollback">
          {t('game.offlineRollback')}
        </p>
      ) : (
        <>
          <p className="offline-times">
            {t('game.offlineRaw', { duration: notice.rawSeconds })}
            {notice.truncated ? t('game.offlineSettled', { duration: notice.settledSeconds }) : null}
          </p>
          <ul className="offline-gains">
            {notice.gains.map((gain) => (
              <li key={gain.id}>
                <span className="offline-gain-name">{gain.name}</span>
                <span className="offline-gain-value">+{gain.gained}</span>
              </li>
            ))}
          </ul>
          {notice.approximate ? (
            <p className="offline-warn" data-testid="offline-approx">
              {t('game.offlineApprox')}
            </p>
          ) : null}
          {notice.deferred ? (
            <p className="muted small" data-testid="offline-deferred">
              {t('game.offlineDeferred')}
            </p>
          ) : null}
        </>
      )}
      <p className="muted small offline-note" data-testid="offline-note">
        {t('game.offlineNote')}
      </p>
    </aside>
  )
}
