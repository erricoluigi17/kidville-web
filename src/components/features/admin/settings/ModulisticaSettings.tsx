'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileSignature } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, input, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow } from './fields';

interface ModulisticaConfig {
    firma_otp_richiesta: boolean;
    promemoria_giorni: number;
    invio_ruoli: string[];
    export_formato: string;
}

export function ModulisticaSettings({ userId }: { userId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<ModulisticaConfig | null>(null);
    const [msg, setMsg] = useState('');

    const RUOLI = [
        { id: 'admin', label: t('ruoloSegreteriaAdmin') },
        { id: 'teacher', label: t('ruoloDocenti') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.modulistica_config ?? {}) as ModulisticaConfig);
    const set = (patch: Partial<ModulisticaConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ modulistica_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><FileSignature size={16} /> {t('moTitolo')}</h3>

            <label className={label}>{t('moChiInvia')}</label>
            <PillMultiSelect options={RUOLI} selected={cfg.invio_ruoli ?? ['admin']} onChange={(v) => set({ invio_ruoli: v })} />

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.firma_otp_richiesta ?? true} onChange={(v) => set({ firma_otp_richiesta: v })}>
                    {t('moFirmaOtp')}
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.promemoria_giorni ?? 3} min={1} max={30} onChange={(v) => set({ promemoria_giorni: v })}>
                    {t('moPromemoria')}
                </NumberField>
                <div>
                    <label className={label}>{t('moFormatoExport')}</label>
                    <select value={cfg.export_formato ?? 'csv'} onChange={(e) => set({ export_formato: e.target.value })} className={`${input} w-full`}>
                        <option value="csv">CSV</option>
                        <option value="xlsx">Excel (XLSX)</option>
                    </select>
                </div>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('moHint')}</p>
        </section>
    );
}
