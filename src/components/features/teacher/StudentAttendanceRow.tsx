'use client';

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { User, Clock, CheckCircle, Timer, LogOut, X } from 'lucide-react';

export type AttendanceStato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';

export interface AttendanceRecord {
    id?: string;
    alunno_id: string;
    data: string;
    stato: AttendanceStato;
    orario_entrata: string | null;
    orario_uscita: string | null;
}

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

interface Props {
    student: Student;
    record?: AttendanceRecord;
    onSetStato: (studentId: string, stato: AttendanceStato) => void;
    onCheckoutClick: (studentId: string) => void;
    isLoading?: boolean;
}

const STATO_CONFIG: Record<AttendanceStato, { label: string; color: string; bg: string; border: string }> = {
    presente: {
        label: 'Presente',
        color: 'text-white',
        bg: 'bg-kidville-success',
        border: 'border-kidville-success',
    },
    assente: {
        label: 'Assente',
        color: 'text-white',
        bg: 'bg-kidville-neutral',
        border: 'border-kidville-neutral',
    },
    ritardo: {
        label: 'Ritardo',
        color: 'text-white',
        bg: 'bg-kidville-warn',
        border: 'border-kidville-warn',
    },
    uscita_anticipata: {
        label: 'Uscita Ant.',
        color: 'text-white',
        bg: 'bg-kidville-info',
        border: 'border-kidville-info',
    },
};

/**
 * I 3 bottoni di stato dell'appello 0-6 restano SEMPRE visibili: il docente può
 * rettificare (es. assente→presente) finché il server accetta la modifica (revoca
 * della notifica entro il buffer di 10'). Il bottone attivo è evidenziato con i token
 * Clay Village e porta aria-pressed="true"; click sull'attivo = no-op (vedi onClick).
 */
const STATI_BOTTONI: {
    key: Extract<AttendanceStato, 'presente' | 'ritardo' | 'assente'>;
    label: string;
    icon: ReactNode;
    activeCls: string;
    idleCls: string;
}[] = [
    {
        key: 'presente',
        label: 'Presente',
        icon: <CheckCircle size={15} />,
        // attivo: bianco su green #006A5F = 6,5:1 · inattivo: green su success-soft #E7F3E8 = 5,7:1
        activeCls: 'bg-kidville-green text-white border-kidville-green',
        idleCls: 'bg-kidville-success-soft text-kidville-green border-kidville-success/30 hover:bg-kidville-green hover:text-white',
    },
    {
        key: 'ritardo',
        label: 'Ritardo',
        icon: <Timer size={15} />,
        // attivo: bianco su warn-strong #A64F09 = 5,6:1 · inattivo: warn-strong su warn-soft #FBEFE2 = 5,0:1
        activeCls: 'bg-kidville-warn-strong text-white border-kidville-warn-strong',
        idleCls: 'bg-kidville-warn-soft text-kidville-warn-strong border-kidville-warn/30 hover:bg-kidville-warn-strong hover:text-white',
    },
    {
        key: 'assente',
        label: 'Assente',
        icon: <X size={15} />,
        // attivo: bianco su sub #55615C = 6,5:1 · inattivo: sub su cream #FEF1E4 = 5,8:1
        activeCls: 'bg-kidville-sub text-white border-kidville-sub',
        idleCls: 'bg-kidville-cream text-kidville-sub border-kidville-line hover:bg-kidville-sub hover:text-white',
    },
];

function formatTime(isoString: string | null): string | null {
    if (!isoString) return null;
    try {
        return new Date(isoString).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return isoString;
    }
}

export function StudentAttendanceRow({ student, record, onSetStato, onCheckoutClick, isLoading }: Props) {
    const stato = record?.stato ?? null;
    const isPresente = stato === 'presente';
    const isRitardo = stato === 'ritardo';
    const isUscitaAnticipata = stato === 'uscita_anticipata';
    const isAssente = stato === 'assente';

    const checkInTime = formatTime(record?.orario_entrata ?? null);
    const checkOutTime = formatTime(record?.orario_uscita ?? null);

    const borderColor = isPresente
        ? '#22c55e'
        : isRitardo
        ? '#f59e0b'
        : isUscitaAnticipata
        ? '#3b82f6'
        : isAssente
        ? '#9ca3af'
        : 'transparent';

    return (
        <motion.div
            layout
            className="kv-appello-row bg-white p-4 rounded-2xl shadow-sm flex flex-wrap items-center justify-between gap-y-2 border-l-4 transition-colors hover:bg-kidville-cream"
            style={{ borderLeftColor: borderColor }}
        >
            {/* Avatar + Info studente */}
            <div className="flex items-center gap-3 min-w-0">
                <div className="bg-kidville-cream w-10 h-10 rounded-full flex items-center justify-center text-kidville-green flex-shrink-0">
                    <User size={20} />
                </div>
                <div className="min-w-0">
                    <h3 className="font-barlow font-semibold text-lg text-kidville-green uppercase tracking-wide truncate">
                        {student.firstName} {student.lastName}
                    </h3>
                    <div className="flex items-center gap-3 text-xs text-kidville-muted font-maven">
                        {checkInTime && (
                            <span className="flex items-center gap-1">
                                <Clock size={11} /> Ingresso: {checkInTime}
                            </span>
                        )}
                        {checkOutTime && (
                            <span className="flex items-center gap-1">
                                <LogOut size={11} /> Uscita: {checkOutTime}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Controlli stato — wrap sotto il nome sugli schermi stretti (320px) */}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {isLoading ? (
                    <div className="w-6 h-6 border-2 border-kidville-green border-t-transparent rounded-full animate-spin" />
                ) : (
                    <>
                        {/* 3 bottoni di stato SEMPRE visibili: consentono la rettifica.
                            Attivo → aria-pressed="true" + token pieno; click sull'attivo = no-op. */}
                        {STATI_BOTTONI.map((b) => {
                            const active = stato === b.key;
                            return (
                                <button
                                    key={b.key}
                                    id={`btn-${b.key}-${student.id}`}
                                    aria-pressed={active}
                                    onClick={() => {
                                        if (!active) onSetStato(student.id, b.key);
                                    }}
                                    className={`min-h-11 px-3 font-maven font-medium text-sm rounded-xl border transition-all flex items-center gap-1.5 ${active ? b.activeCls : b.idleCls}`}
                                >
                                    {b.icon} {b.label}
                                </button>
                            );
                        })}

                        {/* Badge informativo per lo stato uscita anticipata (non ha un bottone dedicato). */}
                        {isUscitaAnticipata && (
                            <span
                                className={`min-h-11 px-3 font-maven font-semibold text-sm rounded-xl flex items-center gap-1.5 ${STATO_CONFIG.uscita_anticipata.bg} ${STATO_CONFIG.uscita_anticipata.color}`}
                            >
                                <LogOut size={15} /> {STATO_CONFIG.uscita_anticipata.label}
                            </span>
                        )}

                        {/* Bottone Uscita Anticipata — solo per presenti/ritardo (condizioni invariate) */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-uscita-${student.id}`}
                                onClick={() => onSetStato(student.id, 'uscita_anticipata')}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-info-soft text-kidville-info-strong border border-kidville-info/30 hover:bg-kidville-info hover:text-white transition-all flex items-center gap-1.5"
                            >
                                <LogOut size={15} /> Uscita Ant.
                            </button>
                        )}

                        {/* Bottone checkout delegato — condizioni invariate */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-checkout-${student.id}`}
                                onClick={() => onCheckoutClick(student.id)}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-yellow text-kidville-green-dark border border-kidville-yellow hover:opacity-90 transition-all"
                            >
                                Uscita
                            </button>
                        )}
                    </>
                )}
            </div>
        </motion.div>
    );
}
