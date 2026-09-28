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
import { invalidaDiarioConfigCache } from '@/lib/diary/config-cache';

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

interface Problema { chiave: string; nome: string }

/**
 * Il primo problema delle routine della scuola, o `null` se si possono salvare. Dice QUALE routine
 * (seconda revisione, 2026-09-28): con venti righe, «qualcosa non va» non basta a trovarla.
 */
function problemaRoutine(bozze: RoutineInBozza[]): Problema | null {
    const r = zRoutinePersonalizzate.safeParse(bozze);
    if (r.success) return null;
    const issue = r.error.issues[0];
    const indice = issue?.path[0];
    const campo = issue?.path[1];
    const nome = typeof indice === 'number' ? (bozze[indice]?.nome ?? '').trim() : '';
    if (campo === 'nome') return { chiave: issue?.code === 'custom' ? 'diPersErrNomeDoppio' : 'diPersErrNome', nome };
    if (campo === 'emoji') return { chiave: 'diPersErrIcona', nome };
    // `[i, 'opzioni', j]` è un'opzione vuota; `[i, 'opzioni']` una scelta con meno di due opzioni.
    if (campo === 'opzioni') return { chiave: (issue?.path.length ?? 0) > 2 ? 'diPersErrOpzioneVuota' : 'diPersErrOpzioni', nome };
    return { chiave: 'diPersErr', nome };
}

/** Un valore JSON in una forma confrontabile: chiavi in ordine. */
function stabile(v: unknown): string {
    const ordina = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(ordina);
        if (x && typeof x === 'object') {
            return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, ordina((x as Record<string, unknown>)[k])]));
        }
        return x ?? null;
    };
    return JSON.stringify(ordina(v));
}

export function DiarioSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error, letturaFallita } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<DiarioConfig | null>(null);
    const [msg, setMsg] = useState('');
    const [problema, setProblema] = useState<Problema | null>(null);

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
        // Configurazione salvata non letta: il pannello è partito da `{}`, e salvare riscriverebbe
        // da zero le routine della scuola. Il pulsante è spento; questa è la cintura.
        if (letturaFallita) return;
        const errore = problemaRoutine(bozze);
        if (errore) { setMsg(''); setProblema(errore); return; }
        // SOLO CIÒ CHE È CAMBIATO (seconda revisione, 2026-09-28), più com'era quando il pannello
        // l'ha letto. Il server unisce le chiavi, quindi quelle vecchie e inerti restano dove sono;
        // e se nel frattempo un'altra operatrice ha cambiato una chiave che qui si sta salvando,
        // risponde 409 invece di cancellarle il lavoro.
        // Un numero svuotato (`NaN`, vedi `NumberField`) non si manda: vale «non cambiato».
        const chiavi = new Set([...Object.keys(cfg), ...Object.keys(salvato)]);
        const cambiato = Object.fromEntries(
            [...chiavi]
                .filter((k) => !Number.isNaN((cfg as unknown as Record<string, unknown>)[k]))
                .filter((k) => stabile((cfg as unknown as Record<string, unknown>)[k]) !== stabile((salvato as unknown as Record<string, unknown>)[k]))
                .map((k) => [k, (cfg as unknown as Record<string, unknown>)[k]]),
        );
        // La bozza MANDATA: se mentre la PATCH è in volo si cambia ancora qualcosa, la bozza è un
        // oggetto nuovo, e a salvataggio riuscito non va buttata (prima spariva con «Salvato»).
        const inviata = draft;
        const ok = await save({ diario_config: cambiato, diario_config_letto: salvato });
        if (ok) {
            // Le maestre (e il cockpit, in questa stessa sessione) rileggono le routine.
            invalidaDiarioConfigCache();
            setDraft((d) => (d === inviata ? null : d));
        }
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
                <NumberField vuotoNonZero value={cfg.buffer_visibilita_min ?? 10} min={0} max={120} onChange={(v) => set({ buffer_visibilita_min: v })}>
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
                <p role="alert" className="mt-4 font-maven text-sm text-kidville-error">{t(problema.chiave, { nome: problema.nome })}</p>
            )}
            {letturaFallita && (
                <p className="mt-4 font-maven text-sm text-kidville-error">{t('diLetturaFallitaBlocco')}</p>
            )}
            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} bloccato={letturaFallita} />
            <p className={hint}>{t('diHint')}</p>
        </section>
    );
}
