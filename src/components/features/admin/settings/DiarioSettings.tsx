'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NotebookPen } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint } from './ui';
import { CheckField, NumberField, SaveRow } from './fields';

// In questo pannello resta SOLO ciò che il codice applica (2026-09-28). Tolti, perché non li
// leggeva nessuno — né una rotta né il database:
//  · «Compilazione dalle / fino alle» e «Visibile ai genitori dalle»: l'unica regola di
//    visibilità è `buffer_visibilita_min`;
//  · «Note libere dei docenti abilitate» (`note_libere_abilitate`);
//  · le routine Pasto, Sonno, Cambio e Attività: di `routine_attive` si legge solo `umore`
//    (`umoreAttivo`, `@/lib/diary/umore`). Resta l'interruttore dell'Umore.
// Nelle sedi quelle chiavi possono essere ancora salvate in `diario_config`: sono inerti, e il
// salvataggio le riscrive com'erano — anche le altre voci di `routine_attive`.
interface DiarioConfig {
    routine_attive: string[];
    buffer_visibilita_min: number;
    diario_primaria_visibile: boolean;
}

export function DiarioSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<DiarioConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.diario_config ?? {}) as DiarioConfig);
    const set = (patch: Partial<DiarioConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const routine = cfg.routine_attive ?? [];
    const umoreAttivo = routine.includes('umore');
    const impostaUmore = (attivo: boolean) =>
        set({ routine_attive: attivo ? [...routine.filter((r) => r !== 'umore'), 'umore'] : routine.filter((r) => r !== 'umore') });

    const salva = async () => {
        const ok = await save({ diario_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><NotebookPen size={16} /> {t('diTitolo')}</h3>
            <p className="font-maven text-xs text-kidville-muted mb-4">{t('diDesc')}</p>

            <CheckField checked={umoreAttivo} onChange={impostaUmore}>
                {t('diUmore')}
            </CheckField>
            <p className="font-maven text-xs text-kidville-sub mt-1">{t('diUmoreHint')}</p>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                <NumberField value={cfg.buffer_visibilita_min ?? 10} min={0} max={120} onChange={(v) => set({ buffer_visibilita_min: v })}>
                    {t('diRitardoVisibilita')}
                </NumberField>
            </div>
            <p className="font-maven text-xs text-kidville-muted mt-1">{t('diRitardoHint')}</p>

            <div className="mt-4">
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
