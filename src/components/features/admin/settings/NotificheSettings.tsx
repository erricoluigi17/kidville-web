'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, ShieldAlert } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint } from './ui';
import { CheckField, SaveRow } from './fields';
import { TIPI_NOTIFICA, useTipoNotifica, type GruppoNotifica } from '@/lib/notifiche/tipi';

// Pannello Impostazioni → Notifiche: un toggle per ogni tipo del catalogo
// (src/lib/notifiche/tipi.ts). Toggle assente = attiva; il gate server-side è
// isNotificaAbilitata(). I tipi `sicurezza` mostrano un avviso dedicato.
// NB: le label/descrizioni dei singoli tipi vengono da TIPI_NOTIFICA (lib
// condivisa) e NON sono tradotte qui: avranno un namespace dedicato.

interface NotificheConfig {
    toggles?: Record<string, boolean>;
}

// `labelKey`/`subKey` sono chiavi i18n del namespace adminSettings.
const GRUPPI: { id: GruppoNotifica; labelKey: string; subKey: string }[] = [
    { id: 'genitore', labelKey: 'ntGruppoGenitore', subKey: 'ntGruppoGenitoreSub' },
    { id: 'docente', labelKey: 'ntGruppoDocente', subKey: 'ntGruppoDocenteSub' },
    { id: 'staff', labelKey: 'ntGruppoStaff', subKey: 'ntGruppoStaffSub' },
];

export function NotificheSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const notifica = useTipoNotifica();
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const salvati = ((settings.notifiche_config ?? {}) as NotificheConfig).toggles ?? {};
    const toggles = draft ?? salvati;
    const attiva = (tipo: string) => toggles[tipo] !== false;
    const set = (tipo: string, v: boolean) => { setMsg(''); setDraft({ ...toggles, [tipo]: v }); };

    const salva = async () => {
        // Si salva la mappa completa (true espliciti inclusi): il merge shallow
        // lato server sostituisce l'intero oggetto `toggles`.
        const complete: Record<string, boolean> = {};
        for (const tipo of Object.keys(TIPI_NOTIFICA)) complete[tipo] = attiva(tipo);
        const ok = await save({ notifiche_config: { toggles: complete } });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <>
            {GRUPPI.map((gruppo) => {
                const voci = Object.entries(TIPI_NOTIFICA).filter(([, def]) => def.gruppo === gruppo.id);
                return (
                    <section key={gruppo.id} className={card}>
                        <h3 className={h3}><BellRing size={16} /> {t(gruppo.labelKey)}</h3>
                        <p className="font-maven text-xs text-kidville-muted -mt-3 mb-4">{t(gruppo.subKey)}</p>
                        <div className="space-y-3">
                            {voci.map(([tipo, def]) => {
                                const info = notifica(tipo);
                                return (
                                <div key={tipo}>
                                    <CheckField checked={attiva(tipo)} onChange={(v) => set(tipo, v)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            {info.label}
                                            {def.sicurezza && (
                                                <span className="inline-flex items-center gap-1 text-[10px] bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full">
                                                    <ShieldAlert size={11} /> {t('ntSicurezza')}
                                                </span>
                                            )}
                                        </span>
                                    </CheckField>
                                    {info.descrizione && <p className="font-maven text-[11px] text-kidville-muted ml-6">{info.descrizione}</p>}
                                    {def.sicurezza && !attiva(tipo) && (
                                        <p className="font-maven text-[11px] text-kidville-warn ml-6 mt-0.5">
                                            {t('ntSicurezzaAvviso')}
                                        </p>
                                    )}
                                </div>
                                );
                            })}
                        </div>
                        <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
                    </section>
                );
            })}
            <p className={hint}>
                {t('ntHint')}
            </p>
        </>
    );
}
