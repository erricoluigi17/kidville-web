'use client'

import { useTranslations } from 'next-intl'
import type { LocalGalleryMedia } from '@/lib/offline/db'
import { intlDateTime } from '@/i18n/config'

export function CodaFoto({ rows, now = 0, onRetryAll, onRetryRow, onDiscard, onAssignSchool }: {
    rows: LocalGalleryMedia[]
    now?: number
    onRetryAll: () => void
    onRetryRow: (id: string) => void
    onDiscard: (id: string) => void
    onAssignSchool: (id: string) => void
}) {
    const t = useTranslations('teacherServizi')
    if (rows.length === 0) return null
    const senzaSede = rows.filter(row => !row.scuola_id).length
    const sospese = rows.filter(row => row.scuola_id && row.next_attempt_at && row.next_attempt_at > now).length
    const errori = rows.filter(row => row.scuola_id && row.sync_status === 'error' && !(row.next_attempt_at && row.next_attempt_at > now)).length
    const inAttesa = rows.length - senzaSede - sospese - errori
    return (
        <section aria-label={t('galleryCodaTitolo')} className="mt-4 rounded-2xl border border-kidville-line bg-white p-4 shadow-sm">
            <h2 className="font-barlow text-sm font-bold uppercase text-kidville-green">{t('galleryCodaTitolo')}</h2>
            <p className="mt-1 font-maven text-xs text-kidville-sub">
                {t('galleryCodaConteggi', { attesa: inAttesa, errori, sospese, senzaSede })}
            </p>
            <button type="button" onClick={onRetryAll}
                className="mt-3 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-xs font-bold text-kidville-white">
                {t('galleryCodaRiprovaTutti')}
            </button>
            <ul className="mt-3 space-y-2">
                {rows.map(row => {
                    const ripresa = typeof row.next_attempt_at === 'number' && row.next_attempt_at > now
                        ? intlDateTime('it', { dateStyle: 'short', timeStyle: 'short' }).format(row.next_attempt_at)
                        : null
                    const sospesa = ripresa !== null
                    const stato = !row.scuola_id ? t('galleryCodaSenzaSede')
                        : sospesa ? t('galleryCodaSospesa', { ora: ripresa })
                            : row.phase === 'preparing' ? t('galleryCodaErroreElaborazione')
                                : row.phase === 'publishing' ? t('galleryCodaInPubblicazione')
                                : row.last_error === 'privacy' ? t('galleryCodaErrorePrivacy')
                                    : row.last_error === 'deleted' ? t('galleryCodaErroreEliminata')
                                        : row.last_error === 'conflict' ? t('galleryCodaErroreConflitto')
                                            : row.sync_status === 'error' ? t('galleryCodaErroreGenerico') : t('galleryCodaInAttesa')
                    return (
                        <li key={row.id} className="rounded-xl border border-kidville-line p-3 font-maven text-xs">
                            <p className="truncate font-bold text-kidville-ink" title={row.caption ?? row.file_name}>{row.caption ?? row.file_name}</p>
                            <p className="mt-1 text-kidville-sub">{stato}</p>
                            {sospesa && row.phase === 'publishing' && (
                                <p className="mt-1 text-kidville-sub">{t('galleryCodaInPubblicazione')}</p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-2">
                                {!row.scuola_id ? (
                                    <button type="button" onClick={() => onAssignSchool(row.id)} className="rounded-pill border border-kidville-green px-3 py-1 text-kidville-green">
                                        {t('galleryCodaAssegnaSede')}
                                    </button>
                                ) : (
                                    <>
                                        {row.sync_status === 'error' && !sospesa && (
                                            <button type="button" onClick={() => onRetryRow(row.id)} className="rounded-pill border border-kidville-green px-3 py-1 text-kidville-green">
                                                {t('galleryCodaRiprovaFoto')}
                                            </button>
                                        )}
                                        <button type="button" onClick={() => onDiscard(row.id)} disabled={row.phase === 'publishing'}
                                            className="rounded-pill border border-kidville-line px-3 py-1 text-kidville-sub disabled:cursor-not-allowed disabled:opacity-50">
                                            {t('galleryCodaScartaFoto')}
                                        </button>
                                    </>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
