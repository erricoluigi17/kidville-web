'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { NotebookPen } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, NumberField, SaveRow } from './fields';
import { RoutinePersonalizzateEditor, type RoutineInBozza } from './RoutinePersonalizzateEditor';
import {
    ROUTINE_BASE,
    routineBaseAttive,
    routinePersonalizzate,
    zRoutinePersonalizzate,
    type RoutineBase,
} from '@/lib/diary/routine';

// In questo pannello resta SOLO ciò che il codice applica. Tolti il 2026-09-28, perché non li
// leggeva nessuno — né una rotta né il database: «Compilazione dalle / fino alle», «Visibile ai
// genitori dalle» (l'unica regola di visibilità è `buffer_visibilita_min`) e «Note libere dei
// docenti abilitate». Nelle sedi quelle chiavi possono essere ancora salvate in `diario_config`:
// sono inerti, e il salvataggio le riscrive com'erano.
//
// Le ROUTINE invece dal 2026-09-28 FUNZIONANO (richiesta del titolare): ogni routine base accende
// o spegne i bottoni della maestra, e la segreteria aggiunge le sue. La regola è una sola, in
// `@/lib/diary/routine`, e la applicano anche le rotte che scrivono.
interface DiarioConfig {
    routine_attive?: unknown;
    routine_personalizzate?: unknown;
    buffer_visibilita_min: number;
    diario_primaria_visibile: boolean;
}

/** L'etichetta di ciascuna routine base. */
const ETICHETTE_BASE: Record<RoutineBase, string> = {
    attivita: 'diRoutineAttivita',
    pasto: 'diRoutinePasto',
    sonno: 'diRoutineSonno',
    cambio: 'diRoutineCambio',
    umore: 'diUmore',
};
const ORDINE_PANNELLO: readonly RoutineBase[] = ['pasto', 'sonno', 'cambio', 'attivita', 'umore'];

/** Il messaggio del primo problema delle routine della scuola, o `null` se si possono salvare. */
function problemaRoutine(bozze: RoutineInBozza[]): string | null {
    const r = zRoutinePersonalizzate.safeParse(bozze);
    if (r.success) return null;
    const campo = r.error.issues[0]?.path[1];
    if (campo === 'nome' || campo === 'emoji') return 'diPersErrNome';
    if (campo === 'opzioni') return 'diPersErrOpzioni';
    return 'diPersErr';
}

export function DiarioSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<DiarioConfig | null>(null);
    const [msg, setMsg] = useState('');
    const [problema, setProblema] = useState<string | null>(null);

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const salvato = (settings.diario_config ?? {}) as DiarioConfig;
    const cfg = draft ?? salvato;
    const set = (patch: Partial<DiarioConfig>) => { setMsg(''); setProblema(null); setDraft({ ...cfg, ...patch }); };

    // Le routine base accese: una sede che non ha mai scelto vede quelle di sempre, e non le si
    // scrive finché nessuno le tocca (`routine_attive` resta assente).
    const accese = routineBaseAttive(cfg.routine_attive);
    const imposta = (routine: RoutineBase, accesa: boolean) => {
        const nuove = new Set(accese);
        if (accesa) nuove.add(routine); else nuove.delete(routine);
        // Si scrivono sempre i NOMI, nell'ordine canonico: anche una sede che aveva i codici dei
        // tipi (il seed E2E) esce dal primo salvataggio col vocabolario delle sedi vere.
        set({ routine_attive: ROUTINE_BASE.filter((r) => nuove.has(r)) });
    };

    // Le routine della scuola: la bozza, e gli id già in archivio (per loro il tipo è bloccato).
    const bozze: RoutineInBozza[] = Array.isArray(cfg.routine_personalizzate)
        ? (cfg.routine_personalizzate as RoutineInBozza[])
        : [];
    const salvate = new Set(routinePersonalizzate(salvato.routine_personalizzate).map((r) => r.id));

    const salva = async () => {
        const errore = problemaRoutine(bozze);
        if (errore) { setMsg(''); setProblema(errore); return; }
        const ok = await save({ diario_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><NotebookPen size={16} /> {t('diTitolo')}</h3>
            <p className="font-maven text-xs text-kidville-muted mb-4">{t('diDesc')}</p>

            <p className={label}>{t('diRoutineTitolo')}</p>
            <div className="space-y-2">
                {ORDINE_PANNELLO.map((r) => (
                    <CheckField key={r} checked={accese.has(r)} onChange={(v) => imposta(r, v)}>
                        {t(ETICHETTE_BASE[r])}
                    </CheckField>
                ))}
            </div>
            <p className={hint}>{t('diRoutineHint')}</p>
            <p className="font-maven text-xs text-kidville-sub mt-1">{t('diUmoreHint')}</p>

            <RoutinePersonalizzateEditor
                routine={bozze}
                salvate={salvate}
                onChange={(routine) => set({ routine_personalizzate: routine })}
            />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-5">
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

            {problema && (
                <p role="alert" className="mt-4 font-maven text-sm text-kidville-error">{t(problema)}</p>
            )}
            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('diHint')}</p>
        </section>
    );
}
