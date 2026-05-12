'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, ChevronDown, CheckCircle } from 'lucide-react';

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
    allergie?: string[];
}

/** Una singola attività con partecipazione per-studente */
export interface ActivityItem {
    tipo: string;
    descrizione: string;
    /** studentId → livello partecipazione */
    studentPartecipazione: Record<string, string | null>;
}

const ACTIVITY_TYPES = [
    { value: 'pittura',  label: 'Pittura',      emoji: '🎨' },
    { value: 'musica',   label: 'Musica',        emoji: '🎵' },
    { value: 'lettura',  label: 'Lettura',       emoji: '📚' },
    { value: 'motoria',  label: 'Motoria',       emoji: '🏃' },
    { value: 'gioco',    label: 'Gioco libero',  emoji: '🧩' },
    { value: 'natura',   label: 'Natura',        emoji: '🌿' },
    { value: 'cucina',   label: 'Cucina',        emoji: '🍪' },
    { value: 'teatro',   label: 'Teatro',        emoji: '🎭' },
    { value: 'altro',    label: 'Altro',         emoji: '✨' },
] as const;

const PARTICIPATION_LEVELS = [
    { value: 'non_fatta',  label: 'Non fatta',      bg: 'bg-red-100/80',     text: 'text-red-700',     border: 'border-red-200/60' },
    { value: 'difficolta', label: 'Con difficoltà',  bg: 'bg-orange-100/80',  text: 'text-orange-700',  border: 'border-orange-200/60' },
    { value: 'aiuto',      label: 'Con aiuto',       bg: 'bg-yellow-100/80',  text: 'text-yellow-700',  border: 'border-yellow-200/60' },
    { value: 'autonomia',  label: 'In autonomia',    bg: 'bg-emerald-100/80', text: 'text-emerald-700', border: 'border-emerald-200/60' },
] as const;

function getActivityMeta(tipo: string) {
    return ACTIVITY_TYPES.find(a => a.value === tipo) ?? { emoji: '✨', label: tipo };
}

interface Props {
    students: Student[];
    activities: ActivityItem[];
    onActivitiesChange: (acts: ActivityItem[]) => void;
    savedStudentIds: Set<string>;
}

// ─── Single Activity Accordion ────────────────────────────────────────────────

function ActivityAccordion({
    activity,
    index,
    total,
    students,
    onChange,
    onRemove,
    savedStudentIds,
}: {
    activity: ActivityItem;
    index: number;
    total: number;
    students: Student[];
    onChange: (patch: Partial<ActivityItem>) => void;
    onRemove: () => void;
    savedStudentIds: Set<string>;
}) {
    const [open, setOpen] = useState(true);
    const meta = getActivityMeta(activity.tipo);

    // Quanti studenti hanno una partecipazione compilata per questa attività
    const compiledCount = students.filter(
        s => activity.studentPartecipazione[s.id] != null
    ).length;
    const isComplete = compiledCount === students.length;

    const setPartecipazione = (studentId: string, val: string | null) => {
        onChange({
            studentPartecipazione: {
                ...activity.studentPartecipazione,
                [studentId]: val,
            },
        });
    };

    return (
        <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-white/40 shadow-sm overflow-hidden">
            {/* ── Header accordion ── */}
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/60 transition-colors"
            >
                <span className="text-xl flex-shrink-0">{meta.emoji}</span>
                <div className="flex-1 text-left">
                    <p className="font-barlow font-bold text-sm text-kidville-green uppercase tracking-wide">
                        {index + 1}. {meta.label}
                    </p>
                    <p className="font-maven text-[11px] text-gray-400">
                        {compiledCount}/{students.length} bambini compilati
                    </p>
                </div>
                {isComplete && (
                    <CheckCircle size={16} className="text-emerald-500 flex-shrink-0" strokeWidth={1.5} />
                )}
                <motion.div
                    animate={{ rotate: open ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex-shrink-0"
                >
                    <ChevronDown size={15} className="text-gray-400" strokeWidth={1.5} />
                </motion.div>
                {total > 1 && (
                    <button
                        onClick={e => { e.stopPropagation(); onRemove(); }}
                        className="w-7 h-7 rounded-lg bg-red-50 hover:bg-red-100 flex items-center justify-center text-red-400 hover:text-red-600 transition-colors flex-shrink-0"
                    >
                        <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                )}
            </button>

            {/* ── Body accordion ── */}
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22 }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-50">

                            {/* Tipo attività */}
                            <div>
                                <p className="font-maven text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">Tipo</p>
                                <div className="flex flex-wrap gap-1.5">
                                    {ACTIVITY_TYPES.map(at => (
                                        <button
                                            key={at.value}
                                            onClick={() => onChange({ tipo: at.value })}
                                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-maven font-semibold border-2 transition-all duration-150 active:scale-95 ${
                                                activity.tipo === at.value
                                                    ? 'bg-purple-100/80 text-purple-700 border-purple-300/60'
                                                    : 'bg-gray-50/80 text-gray-400 border-gray-100 hover:border-gray-200'
                                            }`}
                                        >
                                            <span>{at.emoji}</span>
                                            <span>{at.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Descrizione */}
                            <div>
                                <p className="font-maven text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">Descrizione (facoltativa)</p>
                                <textarea
                                    value={activity.descrizione}
                                    onChange={e => onChange({ descrizione: e.target.value })}
                                    placeholder={`Descrivi l'attività di ${meta.label.toLowerCase()}...`}
                                    rows={2}
                                    className="w-full px-3 py-2.5 rounded-xl bg-gray-50/60 border border-gray-200/60 font-maven text-sm text-kidville-green placeholder:text-gray-300 resize-none focus:outline-none focus:ring-2 focus:ring-purple-400/40 focus:border-purple-300/60 transition-all duration-200"
                                />
                            </div>

                            {/* Partecipazione per studente */}
                            <div>
                                <p className="font-maven text-[11px] text-gray-400 uppercase tracking-wide mb-1.5">Partecipazione</p>
                                <div className="space-y-2">
                                    {students.map(student => {
                                        const sel = activity.studentPartecipazione[student.id] ?? null;
                                        const isSaved = savedStudentIds.has(student.id);
                                        return (
                                            <div key={student.id} className="bg-gray-50/60 rounded-xl px-3 py-2.5">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div className="w-6 h-6 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-barlow font-bold text-[10px] flex-shrink-0">
                                                        {student.firstName[0]}{student.lastName[0]}
                                                    </div>
                                                    <span className="font-maven text-xs text-kidville-green font-medium flex-1">
                                                        {student.firstName} {student.lastName}
                                                        {isSaved && <span className="ml-1 text-emerald-500">✅</span>}
                                                    </span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-1">
                                                    {PARTICIPATION_LEVELS.map(lv => (
                                                        <button
                                                            key={lv.value}
                                                            onClick={() => setPartecipazione(student.id, sel === lv.value ? null : lv.value)}
                                                            className={`py-2 rounded-lg border-2 text-[11px] font-maven font-semibold transition-all duration-150 active:scale-95 ${
                                                                sel === lv.value
                                                                    ? `${lv.bg} ${lv.text} ${lv.border}`
                                                                    : 'bg-white text-gray-400 border-gray-100 hover:border-gray-200'
                                                            }`}
                                                        >
                                                            {lv.label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ─── Componente principale ─────────────────────────────────────────────────────

export function ActivityDetailInline({ students, activities, onActivitiesChange, savedStudentIds }: Props) {

    const addActivity = () => {
        const initPart: Record<string, string | null> = {};
        students.forEach(s => { initPart[s.id] = null; });
        onActivitiesChange([
            ...activities,
            { tipo: 'pittura', descrizione: '', studentPartecipazione: initPart },
        ]);
    };

    const updateActivity = (idx: number, patch: Partial<ActivityItem>) => {
        onActivitiesChange(activities.map((a, i) => i === idx ? { ...a, ...patch } : a));
    };

    const removeActivity = (idx: number) => {
        onActivitiesChange(activities.filter((_, i) => i !== idx));
    };

    return (
        <div className="space-y-2">
            <AnimatePresence initial={false}>
                {activities.map((act, idx) => (
                    <motion.div
                        key={idx}
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                    >
                        <ActivityAccordion
                            activity={act}
                            index={idx}
                            total={activities.length}
                            students={students}
                            onChange={patch => updateActivity(idx, patch)}
                            onRemove={() => removeActivity(idx)}
                            savedStudentIds={savedStudentIds}
                        />
                    </motion.div>
                ))}
            </AnimatePresence>

            {/* Aggiungi attività */}
            <button
                onClick={addActivity}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed border-purple-200 hover:border-purple-400 hover:bg-purple-50/40 text-purple-400 hover:text-purple-600 transition-all duration-200 font-maven text-sm font-semibold"
            >
                <Plus size={15} strokeWidth={1.5} />
                Aggiungi attività
            </button>
        </div>
    );
}
