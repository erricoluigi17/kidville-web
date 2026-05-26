'use client';

import { motion } from 'framer-motion';
import { Lock, Check, EyeOff, Search, X } from 'lucide-react';
import { useState } from 'react';

interface Student {
    id: string;
    nome: string;
    cognome: string;
    consenso_privacy: boolean;
    parents?: { id: string; nome: string; cognome: string; email: string }[];
}

interface Props {
    students: Student[];
    selectedIds: string[];
    onToggle: (studentId: string) => void;
    onSelectAll: () => void;
    onDeselectAll: () => void;
}

export function StudentTagger({ students, selectedIds, onToggle, onSelectAll, onDeselectAll }: Props) {
    const [searchTerm, setSearchTerm] = useState('');
    
    const selectableCount = students.filter(s => s.consenso_privacy).length;
    
    // Controlla se c'è un alunno senza liberatoria selezionato
    const hasNoPrivacySelected = selectedIds.some(id => {
        const s = students.find(st => st.id === id);
        return s && !s.consenso_privacy;
    });

    const allSelected = selectedIds.length === selectableCount && !hasNoPrivacySelected;

    const handleStudentClick = (student: Student) => {
        if (!student.consenso_privacy) {
            // Se clicchiamo uno senza liberatoria, diventa una foto privata: deseleziona altri e seleziona solo lui
            if (selectedIds.includes(student.id)) {
                // Se era già selezionato, deseleziona
                onToggle(student.id);
            } else {
                onDeselectAll();
                onToggle(student.id);
            }
        } else {
            // Se clicchiamo uno con liberatoria, ma avevamo selezionato uno senza liberatoria, resettiamo prima
            if (hasNoPrivacySelected) {
                onDeselectAll();
                onToggle(student.id);
            } else {
                onToggle(student.id);
            }
        }
    };

    // Filtra gli alunni per nome, cognome o nome/cognome dei genitori
    const filteredStudents = students.filter(s => {
        const studentFullName = `${s.nome} ${s.cognome}`.toLowerCase();
        const parentsInfo = s.parents 
            ? s.parents.map(p => `${p.nome} ${p.cognome} ${p.email}`).join(' ').toLowerCase()
            : '';
        const query = searchTerm.toLowerCase().trim();
        return studentFullName.includes(query) || parentsInfo.includes(query);
    });

    return (
        <div className="space-y-3">
            {/* Header with bulk actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-100 pb-2">
                <p className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">
                    Tagga i bambini presenti nella foto
                </p>
                <div className="flex gap-2 self-end">
                    <button 
                        onClick={allSelected ? onDeselectAll : onSelectAll}
                        disabled={hasNoPrivacySelected}
                        className="px-3 py-1 rounded-xl font-maven text-xs text-kidville-green bg-kidville-cream hover:bg-kidville-yellow/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {allSelected ? 'Deseleziona tutti' : 'Seleziona tutti'}
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <Search size={14} />
                </div>
                <input
                    type="text"
                    placeholder="Cerca alunno o genitore (es. Sarah Pagano)..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-8 py-2 bg-gray-50 border border-gray-200 focus:outline-none focus:ring-1 focus:ring-kidville-green rounded-xl font-maven text-xs text-gray-700 transition-all placeholder:text-gray-400"
                />
                {searchTerm && (
                    <button
                        onClick={() => setSearchTerm('')}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Student list */}
            {filteredStudents.length === 0 ? (
                <div className="text-center py-4 text-xs font-maven text-gray-400">
                    Nessun alunno o genitore corrisponde alla ricerca.
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                    {filteredStudents.map((student, idx) => {
                        const isSelected = selectedIds.includes(student.id);
                        const hasPrivacy = student.consenso_privacy;
                        const initials = `${student.nome[0]}${student.cognome[0]}`.toUpperCase();

                        // Se c'è un utente senza liberatoria selezionato, disabilita gli altri
                        const isDisabledByNoPrivacyRule = hasNoPrivacySelected && !isSelected;
                        // Se c'è un utente con liberatoria selezionato, disabilita quelli senza liberatoria
                        const isDisabledByPrivacyRule = !hasPrivacy && selectedIds.length > 0 && !isSelected;

                        const isDisabled = isDisabledByNoPrivacyRule || isDisabledByPrivacyRule;

                        const parentNames = student.parents && student.parents.length > 0
                            ? student.parents.map(p => `${p.nome} ${p.cognome}`).join(', ')
                            : null;

                        return (
                            <motion.button
                                key={student.id}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: idx * 0.02, duration: 0.2 }}
                                onClick={() => !isDisabled && handleStudentClick(student)}
                                disabled={isDisabled}
                                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-2xl text-left transition-all ${
                                    isDisabled
                                        ? 'bg-gray-50 opacity-40 cursor-not-allowed border-transparent'
                                        : isSelected
                                            ? 'bg-kidville-green text-white shadow-md shadow-kidville-green/20'
                                            : 'bg-white/80 hover:bg-kidville-cream/40 border border-gray-100'
                                }`}
                            >
                                {/* Avatar / Check / EyeOff */}
                                <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-barlow font-bold ${
                                    isSelected
                                        ? 'bg-white/20 text-white'
                                        : !hasPrivacy
                                            ? 'bg-amber-100 text-amber-600'
                                            : 'bg-kidville-cream text-kidville-green'
                                 }`}>
                                    {!hasPrivacy && !isSelected ? (
                                        <EyeOff size={12} strokeWidth={1.5} />
                                    ) : isSelected ? (
                                        <Check size={14} strokeWidth={2} />
                                    ) : (
                                        initials
                                    )}
                                </div>

                                {/* Name & Parent */}
                                <div className="min-w-0 flex-1">
                                    <p className={`font-maven font-semibold text-xs truncate ${
                                        isSelected ? 'text-white' : 'text-kidville-green'
                                    }`}>
                                        {student.nome} {student.cognome}
                                    </p>
                                    {parentNames ? (
                                        <p className={`font-maven text-[9px] truncate ${
                                            isSelected ? 'text-white/70' : 'text-gray-400'
                                        }`}>
                                            Genitore: {parentNames}
                                        </p>
                                    ) : (
                                        <p className="font-maven text-[9px] text-gray-300 italic">Genitore non collegato</p>
                                    )}
                                    {!hasPrivacy && (
                                        <p className="font-maven text-[9px] text-amber-600 font-semibold mt-0.5">Solo genitori</p>
                                    )}
                                </div>
                            </motion.button>
                        );
                    })}
                </div>
            )}

            {/* Privacy info */}
            <div className={`flex items-start gap-2 px-3 py-2.5 rounded-2xl border text-xs leading-relaxed ${
                hasNoPrivacySelected 
                    ? 'bg-amber-50 border-amber-200 text-amber-700' 
                    : 'bg-kidville-cream/50 border-kidville-green/10 text-kidville-green'
            }`}>
                {hasNoPrivacySelected ? (
                    <>
                        <EyeOff size={14} className="text-amber-500 flex-shrink-0 mt-0.5" strokeWidth={2} />
                        <p className="font-maven">
                            <strong>Foto Privata:</strong> Hai selezionato un bambino senza liberatoria generale. Questa foto sarà visibile <strong>esclusivamente</strong> ai suoi genitori e nessun altro potrà essere taggato.
                        </p>
                    </>
                ) : (
                    <>
                        <Lock size={14} className="text-kidville-green flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="font-maven">
                            I bambini con la dicitura &ldquo;Solo genitori&rdquo; non hanno firmato la liberatoria generale. Taggarli limiterà la visibilità della foto solo alla loro famiglia.
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
