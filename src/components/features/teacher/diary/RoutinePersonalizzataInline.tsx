'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { BottoneEliminaRegistrazione } from '@/components/features/teacher/diary/BottoneEliminaRegistrazione';
import { MAX_TESTO, type RoutinePersonalizzata } from '@/lib/diary/routine';

/**
 * IL PANNELLO DI UNA ROUTINE AGGIUNTA DALLA SCUOLA (2026-09-28).
 *
 * Una riga per bambino, col controllo del tipo di risposta scelto dalla segreteria:
 *  · spunta  → «Fatto», acceso o spento; più «Fatto per tutti» sopra la lista;
 *  · scelta  → le opzioni della segreteria; una sola, o più d'una se la routine lo consente;
 *  · orario  → un'ora;
 *  · testo   → una riga scritta a mano (al massimo `MAX_TESTO` caratteri).
 *
 * Il valore «niente» è sempre `null`: spegnere «Fatto», togliere l'ultima opzione, svuotare l'ora
 * o il testo. Con `null` il bambino non finisce nel salvataggio (`voceDaMostrare`), e per togliere
 * una registrazione già salvata c'è il cestino — come per il bagno e i pasti.
 */

interface Studente { id: string; firstName: string; lastName: string }

interface Props {
    def: RoutinePersonalizzata;
    students: Studente[];
    studentStates: Record<string, Record<string, unknown>>;
    savedStudentIds: Set<string>;
    noteBambino: Record<string, string>;
    onValore: (studentId: string, valore: unknown) => void;
    onTuttiFatto: () => void;
    onElimina: (studentId: string) => void;
}

const itemVariants = {
    hidden: { opacity: 0, y: 8 },
    visible: (i: number) => ({
        opacity: 1,
        y: 0,
        transition: { delay: i * 0.04, duration: 0.25, ease: 'easeOut' as const },
    }),
};

/** Le opzioni scelte per un bambino, lette dallo stato. */
function scelte(valore: unknown): string[] {
    return Array.isArray(valore) ? valore.filter((v): v is string => typeof v === 'string') : [];
}

export function RoutinePersonalizzataInline({
    def, students, studentStates, savedStudentIds, noteBambino, onValore, onTuttiFatto, onElimina,
}: Props) {
    const t = useTranslations('teacherDiario');

    /** Tocco su un'opzione: singola la sostituisce (o la toglie), multipla la aggiunge o la toglie. */
    const toccaOpzione = (studentId: string, opzione: string) => {
        const prima = scelte(studentStates[studentId]?.valore);
        const dopo = prima.includes(opzione)
            ? prima.filter((o) => o !== opzione)
            : def.multipla ? [...prima, opzione] : [opzione];
        // L'ordine è quello della segreteria, non quello dei tocchi: il genitore legge sempre la
        // stessa sequenza.
        const ordinate = def.opzioni.filter((o) => dopo.includes(o));
        onValore(studentId, ordinate.length > 0 ? ordinate : null);
    };

    return (
        <>
            {def.risposta === 'spunta' && students.length > 0 && (
                <button
                    type="button"
                    onClick={onTuttiFatto}
                    className="w-full mb-1 py-2.5 rounded-2xl bg-kidville-green-soft border border-kidville-green/30 text-kidville-green font-maven font-semibold text-sm flex items-center justify-center gap-2 transition-colors"
                >
                    <Check size={14} strokeWidth={2} /> {t('routineFattoPerTutti')}
                </button>
            )}
            {students.length > 0 && (
                <p className="font-maven text-[11px] text-kidville-sub text-center mb-1 px-2">
                    {t('routineAiutoCompilazione')}
                </p>
            )}

            {students.map((student, idx) => {
                const valore = studentStates[student.id]?.valore;
                const isSaved = savedStudentIds.has(student.id);
                const nomeIntero = `${student.firstName} ${student.lastName}`;
                const etichettaCampo = `${def.nome} — ${nomeIntero}`;
                return (
                    <motion.div
                        key={student.id}
                        data-testid={`routine-riga-${student.id}`}
                        custom={idx}
                        variants={itemVariants}
                        initial="hidden"
                        animate="visible"
                        className="rounded-2xl border border-kidville-line bg-white shadow-sm px-4 py-3"
                    >
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs bg-kidville-cream text-kidville-green">
                                {student.firstName[0]}{student.lastName[0]}
                            </div>
                            <span className="font-maven font-medium text-sm text-kidville-green flex-1">
                                {nomeIntero}
                                {isSaved && <span className="ml-1.5 text-kidville-success">✅</span>}
                            </span>
                            {isSaved && (
                                <BottoneEliminaRegistrazione
                                    nome={nomeIntero}
                                    evento={def.nome}
                                    haNota={Boolean(noteBambino[student.id]?.trim())}
                                    onElimina={() => onElimina(student.id)}
                                />
                            )}
                        </div>

                        {def.risposta === 'spunta' && (
                            <button
                                type="button"
                                aria-pressed={valore === true}
                                onClick={() => onValore(student.id, valore === true ? null : true)}
                                className={`w-full rounded-xl border-2 px-3 py-2 font-maven text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
                                    valore === true
                                        ? 'border-kidville-green bg-kidville-green text-kidville-yellow'
                                        : 'border-kidville-line bg-white text-kidville-green'
                                }`}
                            >
                                {valore === true && <Check size={14} strokeWidth={2.5} />}
                                {t('routineFatto')}
                            </button>
                        )}

                        {def.risposta === 'scelta' && (
                            <div className="flex flex-wrap gap-1.5">
                                {def.opzioni.map((opzione) => {
                                    const attiva = scelte(valore).includes(opzione);
                                    return (
                                        <button
                                            key={opzione}
                                            type="button"
                                            aria-pressed={attiva}
                                            onClick={() => toccaOpzione(student.id, opzione)}
                                            className={`rounded-pill border px-3 py-1.5 font-maven text-sm transition-all ${
                                                attiva
                                                    ? 'border-kidville-green bg-kidville-green text-kidville-yellow font-semibold'
                                                    : 'border-kidville-line bg-white text-kidville-green'
                                            }`}
                                        >
                                            {opzione}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {def.risposta === 'orario' && (
                            <input
                                type="time"
                                aria-label={etichettaCampo}
                                value={typeof valore === 'string' ? valore : ''}
                                onChange={(e) => onValore(student.id, e.target.value || null)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/30"
                            />
                        )}

                        {def.risposta === 'testo' && (
                            <input
                                type="text"
                                aria-label={etichettaCampo}
                                maxLength={MAX_TESTO}
                                value={typeof valore === 'string' ? valore : ''}
                                placeholder={t('routineTestoPlaceholder', { nome: student.firstName })}
                                onChange={(e) => onValore(student.id, e.target.value === '' ? null : e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/30"
                            />
                        )}
                    </motion.div>
                );
            })}
        </>
    );
}
