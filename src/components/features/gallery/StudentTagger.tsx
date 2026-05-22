'use client';

import { motion } from 'framer-motion';
import { Lock, Check } from 'lucide-react';

interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy: boolean;
}

interface Props {
    students: Student[];
    selectedIds: string[];
    onToggle: (studentId: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
}

export function StudentTagger({ students, selectedIds, onToggle, onSelectAll, onDeselectAll }: Props) {
    const selectableCount = students.filter(s => s.consenso_privacy).length;
    const allSelected = selectedIds.length === selectableCount;

    return (
        <div className="space-y-3">
            {/* Header with bulk actions */}
            <div className="flex items-center justify-between">
                <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">
                    Tagga i bambini presenti nella foto
                </p>
                <div className="flex gap-2">
                    <button onClick={allSelected ? onDeselectAll : onSelectAll}
                        className="px-3 py-1 rounded-xl font-maven text-xs text-kidville-green bg-kidville-cream hover:bg-kidville-yellow/30 transition-colors">
                        {allSelected ? 'Deseleziona tutti' : 'Seleziona tutti'}
                    </button>
                </div>
            </div>

            {/* Student list */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {students.map((student, idx) => {
                    const isSelected = selectedIds.includes(student.id);
                    const hasPrivacy = student.consenso_privacy;
                    const initials = `${student.nome[0]}${student.cognome[0]}`.toUpperCase();

                    return (
                        <motion.button
                            key={student.id}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.02, duration: 0.2 }}
                            onClick={() => hasPrivacy && onToggle(student.id)}
                            disabled={!hasPrivacy}
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-2xl text-left transition-all ${
                                !hasPrivacy
                                    ? 'bg-gray-100 opacity-50 cursor-not-allowed'
                                    : isSelected
                                        ? 'bg-kidville-green text-white shadow-md shadow-kidville-green/20'
                                        : 'bg-white/80 hover:bg-kidville-cream/40 border border-gray-100'
                            }`}
                        >
                            {/* Avatar / Check */}
                            <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-barlow font-bold ${
                                !hasPrivacy
                                    ? 'bg-gray-200 text-gray-400'
                                    : isSelected
                                        ? 'bg-white/20 text-white'
                                        : 'bg-kidville-cream text-kidville-green'
                            }`}>
                                {!hasPrivacy ? (
                                    <Lock size={12} strokeWidth={1.5} />
                                ) : isSelected ? (
                                    <Check size={14} strokeWidth={2} />
                                ) : (
                                    initials
                                )}
                            </div>

                            {/* Name */}
                            <div className="min-w-0 flex-1">
                                <p className={`font-maven font-medium text-xs truncate ${
                                    isSelected ? 'text-white' : 'text-kidville-green'
                                }`}>
                                    {student.nome} {student.cognome}
                                </p>
                                {!hasPrivacy && (
                                    <p className="font-maven text-[10px] text-gray-400">Senza liberatoria</p>
                                )}
                            </div>
                        </motion.button>
                    );
                })}
            </div>

            {/* Privacy info */}
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-xl border border-amber-100">
                <Lock size={12} className="text-amber-500 flex-shrink-0" strokeWidth={1.5} />
                <p className="font-maven text-[11px] text-amber-600">
                    I bambini senza liberatoria privacy non possono essere taggati.
                </p>
            </div>
        </div>
    );
}
