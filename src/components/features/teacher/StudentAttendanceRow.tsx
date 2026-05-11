'use client';

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
        bg: 'bg-gray-400',
        border: 'border-gray-400',
    },
    ritardo: {
        label: 'Ritardo',
        color: 'text-white',
        bg: 'bg-amber-500',
        border: 'border-amber-500',
    },
    uscita_anticipata: {
        label: 'Uscita Ant.',
        color: 'text-white',
        bg: 'bg-blue-500',
        border: 'border-blue-500',
    },
};

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
    const hasStato = stato !== null;

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
            className="bg-white p-4 rounded-2xl shadow-sm flex items-center justify-between border-l-4 transition-colors hover:bg-gray-50/80"
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
                    <div className="flex items-center gap-3 text-xs text-gray-400 font-maven">
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

            {/* Controlli stato */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
                {isLoading ? (
                    <div className="w-6 h-6 border-2 border-kidville-green border-t-transparent rounded-full animate-spin" />
                ) : !hasStato ? (
                    /* Stato iniziale: 3 bottoni principali */
                    <>
                        <button
                            id={`btn-presente-${student.id}`}
                            onClick={() => onSetStato(student.id, 'presente')}
                            className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-success/10 text-kidville-success border border-kidville-success/30 hover:bg-kidville-success hover:text-white transition-all flex items-center gap-1.5"
                        >
                            <CheckCircle size={15} /> Presente
                        </button>
                        <button
                            id={`btn-ritardo-${student.id}`}
                            onClick={() => onSetStato(student.id, 'ritardo')}
                            className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5"
                        >
                            <Timer size={15} /> Ritardo
                        </button>
                        <button
                            id={`btn-assente-${student.id}`}
                            onClick={() => onSetStato(student.id, 'assente')}
                            className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-gray-100 text-gray-500 border border-gray-200 hover:bg-gray-400 hover:text-white transition-all flex items-center gap-1.5"
                        >
                            <X size={15} /> Assente
                        </button>
                    </>
                ) : (
                    /* Stato già impostato: badge + possibilità di cambio */
                    <>
                        {/* Badge stato attuale */}
                        <span
                            className={`h-9 px-3 font-maven font-semibold text-sm rounded-xl flex items-center gap-1.5 ${STATO_CONFIG[stato!].bg} ${STATO_CONFIG[stato!].color}`}
                        >
                            {stato === 'presente' && <CheckCircle size={15} />}
                            {stato === 'ritardo' && <Timer size={15} />}
                            {stato === 'uscita_anticipata' && <LogOut size={15} />}
                            {stato === 'assente' && <X size={15} />}
                            {STATO_CONFIG[stato!].label}
                        </span>

                        {/* Bottone Uscita Anticipata — solo per presenti/ritardo */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-uscita-${student.id}`}
                                onClick={() => onSetStato(student.id, 'uscita_anticipata')}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-500 hover:text-white transition-all flex items-center gap-1.5"
                            >
                                <LogOut size={15} /> Uscita Ant.
                            </button>
                        )}

                        {/* Bottone checkout delegato */}
                        {(isPresente || isRitardo) && !record?.orario_uscita && (
                            <button
                                id={`btn-checkout-${student.id}`}
                                onClick={() => onCheckoutClick(student.id)}
                                className="h-9 px-3 font-maven font-medium text-sm rounded-xl bg-kidville-yellow text-kidville-green border border-kidville-yellow hover:opacity-90 transition-all"
                            >
                                Uscita
                            </button>
                        )}

                        {/* Reset stato */}
                        <button
                            id={`btn-reset-${student.id}`}
                            onClick={() => onSetStato(student.id, 'assente')}
                            title="Cambia stato"
                            className="h-9 w-9 flex items-center justify-center rounded-xl bg-gray-100 text-gray-400 hover:bg-gray-200 transition-all"
                        >
                            <X size={14} />
                        </button>
                    </>
                )}
            </div>
        </motion.div>
    );
}
