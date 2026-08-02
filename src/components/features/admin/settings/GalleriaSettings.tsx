'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Images } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface GalleriaConfig {
    consenso_privacy_richiesto: boolean;
    upload_ruoli: string[];
    approvazione_admin_richiesta: boolean;
    download_genitori_abilitato: boolean;
    max_mb_per_file: number;
}

export function GalleriaSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<GalleriaConfig | null>(null);
    const [msg, setMsg] = useState('');

    const RUOLI = [
        { id: 'admin', label: t('ruoloSegreteriaAdmin') },
        { id: 'teacher', label: t('ruoloDocenti') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.galleria_config ?? {}) as GalleriaConfig);
    const set = (patch: Partial<GalleriaConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ galleria_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><Images size={16} /> {t('gaTitolo')}</h3>

            <label className={label}>{t('gaChiCarica')}</label>
            <PillMultiSelect options={RUOLI} selected={cfg.upload_ruoli ?? ['admin', 'teacher']} onChange={(v) => set({ upload_ruoli: v })} />

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.consenso_privacy_richiesto ?? true} onChange={(v) => set({ consenso_privacy_richiesto: v })}>
                    {t('gaConsensoPrivacy')}
                </CheckField>
                <CheckField checked={cfg.approvazione_admin_richiesta ?? false} onChange={(v) => set({ approvazione_admin_richiesta: v })}>
                    <>{t('gaApprovazioneAdmin')} <ComingSoonBadge /></>
                </CheckField>
                <CheckField checked={cfg.download_genitori_abilitato ?? true} onChange={(v) => set({ download_genitori_abilitato: v })}>
                    {t('gaDownloadGenitori')}
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.max_mb_per_file ?? 25} min={1} max={500} onChange={(v) => set({ max_mb_per_file: v })}>
                    {t('gaMaxMbFile')}
                </NumberField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('gaHint')}</p>
        </section>
    );
}
