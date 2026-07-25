'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NotebookPen } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, label, hint } from './ui';
import { CheckField, TimeField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';

interface DiarioConfig {
    routine_attive: string[];
    orario_compilazione_da: string;
    orario_compilazione_a: string;
    visibile_genitori_da: string;
    buffer_visibilita_min: number;
    note_libere_abilitate: boolean;
    diario_primaria_visibile: boolean;
}

export function DiarioSettings({ userId }: { userId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<DiarioConfig | null>(null);
    const [msg, setMsg] = useState('');

    const ROUTINE = [
        { id: 'pasto', label: t('diRoutinePasto') },
        { id: 'sonno', label: t('diRoutineSonno') },
        { id: 'cambio', label: t('diRoutineCambio') },
        { id: 'attivita', label: t('diRoutineAttivita') },
        { id: 'umore', label: t('diRoutineUmore') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.diario_config ?? {}) as DiarioConfig);
    const set = (patch: Partial<DiarioConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ diario_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><NotebookPen size={16} /> {t('diTitolo')} <ComingSoonBadge /></h3>
            <p className="font-maven text-xs text-kidville-muted mb-4">{t('diDesc')}</p>

            <label className={label}>{t('diRoutineAttive')}</label>
            <PillMultiSelect options={ROUTINE} selected={cfg.routine_attive ?? []} onChange={(v) => set({ routine_attive: v })} />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                <TimeField value={cfg.orario_compilazione_da ?? '08:00'} onChange={(v) => set({ orario_compilazione_da: v })}>{t('diCompilazioneDalle')}</TimeField>
                <TimeField value={cfg.orario_compilazione_a ?? '18:00'} onChange={(v) => set({ orario_compilazione_a: v })}>{t('diCompilazioneFinoAlle')}</TimeField>
                <TimeField value={cfg.visibile_genitori_da ?? '16:00'} onChange={(v) => set({ visibile_genitori_da: v })}>{t('diVisibileGenitoriDalle')}</TimeField>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                <NumberField value={cfg.buffer_visibilita_min ?? 10} min={0} max={120} onChange={(v) => set({ buffer_visibilita_min: v })}>
                    {t('diRitardoVisibilita')}
                </NumberField>
            </div>
            <p className="font-maven text-xs text-kidville-muted mt-1">{t('diRitardoHint')}</p>

            <div className="mt-4">
                <CheckField checked={cfg.note_libere_abilitate ?? true} onChange={(v) => set({ note_libere_abilitate: v })}>
                    {t('diNoteLibere')}
                </CheckField>
            </div>

            <div className="mt-2">
                <CheckField checked={cfg.diario_primaria_visibile ?? false} onChange={(v) => set({ diario_primaria_visibile: v })}>
                    {t('diEsponiPrimaria')}
                </CheckField>
                <p className="font-maven text-xs text-kidville-muted mt-1">{t('diEsponiPrimariaHint')}</p>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('diHint')}</p>
        </section>
    );
}
