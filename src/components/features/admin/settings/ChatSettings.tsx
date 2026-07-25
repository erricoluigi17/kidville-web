'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircle } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, TimeField, TextField, PillMultiSelect, SaveRow } from './fields';

interface ChatConfig {
    abilitata_genitori: boolean;
    orario_docenti_da: string;
    orario_docenti_a: string;
    giorni_attivi: number[];
    broadcast_solo_admin: boolean;
    risposta_fuori_orario_msg: string;
}

export function ChatSettings({ userId }: { userId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<ChatConfig | null>(null);
    const [msg, setMsg] = useState('');

    const GIORNI = [
        { id: '1', label: t('giornoLun') }, { id: '2', label: t('giornoMar') }, { id: '3', label: t('giornoMer') },
        { id: '4', label: t('giornoGio') }, { id: '5', label: t('giornoVen') }, { id: '6', label: t('giornoSab') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.chat_config ?? {}) as ChatConfig);
    const set = (patch: Partial<ChatConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const giorni = (cfg.giorni_attivi ?? [1, 2, 3, 4, 5]).map(String);

    const salva = async () => {
        const ok = await save({ chat_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><MessageCircle size={16} /> {t('chTitolo')}</h3>

            <div className="space-y-2">
                <CheckField checked={cfg.abilitata_genitori ?? true} onChange={(v) => set({ abilitata_genitori: v })}>
                    {t('chAbilitataGenitori')}
                </CheckField>
                <CheckField checked={cfg.broadcast_solo_admin ?? true} onChange={(v) => set({ broadcast_solo_admin: v })}>
                    {t('chBroadcastSoloAdmin')}
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <TimeField value={cfg.orario_docenti_da ?? '08:00'} onChange={(v) => set({ orario_docenti_da: v })}>{t('chDocentiDalle')}</TimeField>
                <TimeField value={cfg.orario_docenti_a ?? '17:00'} onChange={(v) => set({ orario_docenti_a: v })}>{t('chDocentiFinoAlle')}</TimeField>
            </div>

            <div className="mt-4">
                <label className={label}>{t('chGiorniAttivi')}</label>
                <PillMultiSelect
                    options={GIORNI}
                    selected={giorni}
                    onChange={(v) => set({ giorni_attivi: v.map(Number).sort() })}
                />
            </div>

            <div className="mt-4">
                <TextField value={cfg.risposta_fuori_orario_msg ?? ''} onChange={(v) => set({ risposta_fuori_orario_msg: v })} placeholder={t('chMessaggioFuoriOrarioPlaceholder')}>
                    {t('chMessaggioFuoriOrario')}
                </TextField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('chHint')}</p>
        </section>
    );
}
