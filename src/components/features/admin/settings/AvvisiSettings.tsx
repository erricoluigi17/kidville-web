'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Megaphone } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface AvvisiConfig {
    ruoli_pubblicazione: string[];
    conferma_lettura_abilitata: boolean;
    allegati_max_mb: number;
    scadenza_default_giorni: number;
}

export function AvvisiSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<AvvisiConfig | null>(null);
    const [msg, setMsg] = useState('');

    const RUOLI = [
        { id: 'admin', label: t('ruoloSegreteriaAdmin') },
        { id: 'teacher', label: t('ruoloDocenti') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.avvisi_config ?? {}) as AvvisiConfig);
    const set = (patch: Partial<AvvisiConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ avvisi_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><Megaphone size={16} /> {t('avTitolo')}</h3>

            <label className={label}>{t('avChiPubblica')}</label>
            <PillMultiSelect options={RUOLI} selected={cfg.ruoli_pubblicazione ?? ['admin', 'teacher']} onChange={(v) => set({ ruoli_pubblicazione: v })} />

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.allegati_max_mb ?? 10} min={1} max={100} onChange={(v) => set({ allegati_max_mb: v })}>
                    {t('avAllegatiMax')}
                </NumberField>
                <NumberField value={cfg.scadenza_default_giorni ?? 30} min={1} max={365} onChange={(v) => set({ scadenza_default_giorni: v })}>
                    <>{t('avScadenzaDefault')} <ComingSoonBadge /></>
                </NumberField>
            </div>

            <div className="mt-4">
                <CheckField checked={cfg.conferma_lettura_abilitata ?? true} onChange={(v) => set({ conferma_lettura_abilitata: v })}>
                    {t('avConfermaLettura')}
                </CheckField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('avHint')}</p>
        </section>
    );
}
