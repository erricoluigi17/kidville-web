'use client';

import { useTranslations } from 'next-intl';
import { Plus, Trash2, X } from 'lucide-react';
import { input, label, hint, btnPrimary } from './ui';
import { CheckField } from './fields';
import {
    RISPOSTE,
    MAX_ROUTINE_PERSONALIZZATE,
    MAX_OPZIONI,
    MAX_NOME,
    MAX_OPZIONE,
    ID_ROUTINE_RE,
    type Risposta,
} from '@/lib/diary/routine';

/**
 * LE ROUTINE AGGIUNTE DALLA SCUOLA, NEL PANNELLO DEL DIARIO (2026-09-28).
 *
 * La segreteria sceglie nome, icona e tipo di risposta: spunta «fatto», scelta fra opzioni (una
 * sola o più d'una), orario, testo libero. Il TIPO DI RISPOSTA di una routine già salvata non si
 * cambia (il server lo rifiuta con `ROUTINE_RISPOSTA_NON_MODIFICABILE`): le voci già scritte
 * portano il tipo vecchio. Qui il campo è bloccato, e lo si dice.
 *
 * Lo stato è una BOZZA: finché si scrive, una routine può essere incompleta (nome vuoto, una sola
 * opzione). La validazione vera è quella di `zRoutinePersonalizzate`, al salvataggio.
 */

/** Una routine in bozza: la forma di quella salvata, ma coi campi ancora da riempire. */
export interface RoutineInBozza {
    id: string;
    nome: string;
    emoji: string;
    risposta: Risposta;
    opzioni: string[];
    multipla: boolean;
    attiva: boolean;
}

const ETICHETTA_RISPOSTA: Record<Risposta, string> = {
    spunta: 'diPersRispostaSpunta',
    scelta: 'diPersRispostaScelta',
    orario: 'diPersRispostaOrario',
    testo: 'diPersRispostaTesto',
};

const ALFABETO = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Un id nuovo di 8 caratteri, diverso da quelli già in lista. */
function nuovoId(esistenti: ReadonlySet<string>): string {
    for (;;) {
        const byte = crypto.getRandomValues(new Uint8Array(8));
        const id = Array.from(byte, (b) => ALFABETO[b % ALFABETO.length]).join('');
        if (ID_ROUTINE_RE.test(id) && !esistenti.has(id)) return id;
    }
}

interface Props {
    routine: RoutineInBozza[];
    /** Gli id già SALVATI in archivio: per loro il tipo di risposta è bloccato. */
    salvate: ReadonlySet<string>;
    onChange: (routine: RoutineInBozza[]) => void;
}

export function RoutinePersonalizzateEditor({ routine, salvate, onChange }: Props) {
    const t = useTranslations('adminSettings');

    const cambia = (id: string, patch: Partial<RoutineInBozza>) =>
        onChange(routine.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const aggiungi = () => {
        const id = nuovoId(new Set(routine.map((r) => r.id)));
        onChange([...routine, { id, nome: '', emoji: '⭐', risposta: 'spunta', opzioni: [], multipla: false, attiva: true }]);
    };

    const pieno = routine.length >= MAX_ROUTINE_PERSONALIZZATE;

    return (
        <div className="mt-5">
            <p className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide">{t('diPersTitolo')}</p>
            <p className={hint}>{t('diPersHint')}</p>

            <div className="mt-3 space-y-3">
                {routine.map((r) => {
                    const bloccata = salvate.has(r.id);
                    return (
                        <div key={r.id} data-testid="routine-scuola" className="rounded-2xl border border-kidville-line p-3">
                            <div className="flex items-end gap-2">
                                <div className="w-16 flex-shrink-0">
                                    <span className={label} aria-hidden="true">{t('diPersEmoji')}</span>
                                    <input
                                        aria-label={t('diPersEmoji')}
                                        value={r.emoji}
                                        maxLength={16}
                                        onChange={(e) => cambia(r.id, { emoji: e.target.value })}
                                        className={`${input} w-full text-center`}
                                    />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <span className={label} aria-hidden="true">{t('diPersNome')}</span>
                                    <input
                                        aria-label={t('diPersNome')}
                                        value={r.nome}
                                        maxLength={MAX_NOME}
                                        onChange={(e) => cambia(r.id, { nome: e.target.value })}
                                        className={`${input} w-full`}
                                    />
                                </div>
                                <button
                                    type="button"
                                    aria-label={`${t('diPersElimina')}: ${r.nome || '—'}`}
                                    onClick={() => onChange(routine.filter((x) => x.id !== r.id))}
                                    className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-kidville-line text-kidville-error"
                                >
                                    <Trash2 size={15} strokeWidth={1.8} />
                                </button>
                            </div>

                            <div className="mt-2">
                                <span className={label} aria-hidden="true">{t('diPersRisposta')}</span>
                                <select
                                    aria-label={t('diPersRisposta')}
                                    value={r.risposta}
                                    disabled={bloccata}
                                    onChange={(e) => cambia(r.id, { risposta: e.target.value as Risposta })}
                                    className={`${input} w-full disabled:opacity-60`}
                                >
                                    {RISPOSTE.map((v) => (
                                        <option key={v} value={v}>{t(ETICHETTA_RISPOSTA[v])}</option>
                                    ))}
                                </select>
                                {bloccata && <p className={hint}>{t('diPersRispostaBloccata')}</p>}
                            </div>

                            {r.risposta === 'scelta' && (
                                <div className="mt-2 space-y-1.5">
                                    {r.opzioni.map((opzione, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <input
                                                aria-label={`${t('diPersOpzione')} ${i + 1}`}
                                                value={opzione}
                                                maxLength={MAX_OPZIONE}
                                                onChange={(e) => cambia(r.id, { opzioni: r.opzioni.map((o, j) => (j === i ? e.target.value : o)) })}
                                                className={`${input} min-w-0 flex-1`}
                                            />
                                            <button
                                                type="button"
                                                aria-label={`${t('diPersOpzioneTogli')} ${i + 1}`}
                                                onClick={() => cambia(r.id, { opzioni: r.opzioni.filter((_, j) => j !== i) })}
                                                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-kidville-line text-kidville-sub"
                                            >
                                                <X size={13} strokeWidth={1.8} />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        disabled={r.opzioni.length >= MAX_OPZIONI}
                                        onClick={() => cambia(r.id, { opzioni: [...r.opzioni, ''] })}
                                        className="inline-flex items-center gap-1 font-maven text-sm font-semibold text-kidville-green disabled:opacity-45"
                                    >
                                        <Plus size={14} strokeWidth={2} /> {t('diPersOpzioneAggiungi')}
                                    </button>
                                    <CheckField checked={r.multipla} onChange={(v) => cambia(r.id, { multipla: v })}>
                                        {t('diPersMultipla')}
                                    </CheckField>
                                </div>
                            )}

                            <div className="mt-2">
                                <CheckField checked={r.attiva} onChange={(v) => cambia(r.id, { attiva: v })}>
                                    {t('diPersAttiva')}
                                </CheckField>
                            </div>
                        </div>
                    );
                })}
            </div>

            <button type="button" onClick={aggiungi} disabled={pieno} className={`${btnPrimary} mt-3`}>
                <Plus size={14} strokeWidth={2.2} /> {t('diPersAggiungi')}
            </button>
            {pieno && <p className={hint}>{t('diPersMax', { max: MAX_ROUTINE_PERSONALIZZATE })}</p>}
        </div>
    );
}
