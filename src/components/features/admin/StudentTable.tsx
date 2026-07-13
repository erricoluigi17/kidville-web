'use client';

import React, { useState } from 'react';
import { ArrowUpDown, AlertTriangle } from 'lucide-react';
import { labelRuolo } from '@/lib/auth/ruoli';

interface Student {
    id: string;
    nome?: string;
    cognome?: string;
    first_name?: string; // per parents
    last_name?: string; // per parents
    data_nascita?: string;
    classe_sezione?: string | null;
    stato?: string;
    note_mediche?: string | null;
    codice_fiscale?: string | null;
    fiscal_code?: string | null;
    bes?: boolean;
    note_bes?: string | null;
    emails?: string[];
    phone_numbers?: string[];
    ruolo?: string; // per staff (utenti)
    sede_nome?: string; // per staff (nome plesso)
    classi_count?: number; // per staff (n. classi assegnate)
}

interface Props {
    students: Student[];
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    onToggleSelectAll: () => void;
    onStudentClick: (student: Student) => void;
    currentTypeFilter?: 'adult' | 'child' | 'staff';
}

type SortField = 'cognome' | 'nome' | 'classe_sezione' | 'stato' | 'data_nascita';

function getStatoBadge(stato: string) {
    switch (stato) {
        case 'iscritto': return 'bg-kidville-success-soft text-kidville-success border-kidville-success/30';
        case 'ritirato': return 'bg-kidville-line text-kidville-muted border-kidville-line';
        case 'sospeso': return 'bg-kidville-warn-soft text-kidville-warn border-kidville-warn/30';
        default: return 'bg-kidville-line text-kidville-muted border-kidville-line';
    }
}

export function StudentTable({ students, selectedIds, onToggleSelect, onToggleSelectAll, onStudentClick, currentTypeFilter = 'child' }: Props) {
    const [sortField, setSortField] = useState<SortField>('cognome');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('asc');
        }
    };

    const sorted = [...students].sort((a, b) => {
        if (currentTypeFilter === 'child') {
            const aSec = a.classe_sezione || 'Senza Sezione';
            const bSec = b.classe_sezione || 'Senza Sezione';
            if (aSec !== bSec) return aSec.localeCompare(bSec, 'it');
        }

        const getSortVal = (obj: Student, f: SortField) => {
            if (f === 'cognome') return obj.cognome || obj.last_name || '';
            if (f === 'nome') return obj.nome || obj.first_name || '';
            return obj[f] || '';
        };

        const aVal = getSortVal(a, sortField) as string;
        const bVal = getSortVal(b, sortField) as string;
        const cmp = aVal.localeCompare(bVal, 'it');
        return sortDir === 'asc' ? cmp : -cmp;
    });

    const groupedStudents = sorted.reduce((acc, student) => {
        const sec = currentTypeFilter === 'child' ? (student.classe_sezione || 'Senza Sezione') : 'Anagrafica Generale';
        if (!acc[sec]) acc[sec] = [];
        acc[sec].push(student);
        return acc;
    }, {} as Record<string, Student[]>);

    const allSelected = students.length > 0 && selectedIds.size === students.length;

    const renderSortHeader = (field: SortField, label: string) => (
        <th
            className="px-3 py-3 text-left cursor-pointer select-none group"
            onClick={() => handleSort(field)}
        >
            <div className="flex items-center gap-1 font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">
                {label}
                <ArrowUpDown size={12} className={`transition-colors ${sortField === field ? 'text-kidville-green' : 'text-kidville-muted group-hover:text-kidville-muted'}`} />
            </div>
        </th>
    );

    return (
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full">
                    <thead className="bg-kidville-cream/50 border-b border-kidville-line">
                        <tr>
                            {/* Staff: nessuna selezione massiva (le azioni sono per-singolo). */}
                            {currentTypeFilter !== 'staff' && (
                                <th className="px-3 py-3 w-10">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        onChange={onToggleSelectAll}
                                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green cursor-pointer"
                                    />
                                </th>
                            )}
                            {renderSortHeader('cognome', 'Cognome')}
                            {renderSortHeader('nome', 'Nome')}
                            {currentTypeFilter === 'child' ? (
                                <>
                                    {renderSortHeader('data_nascita', 'Nascita')}
                                    {renderSortHeader('classe_sezione', 'Classe')}
                                    {renderSortHeader('stato', 'Stato')}
                                    <th className="px-3 py-3 text-left">
                                        <span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Info</span>
                                    </th>
                                </>
                            ) : currentTypeFilter === 'staff' ? (
                                <>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Email</span></th>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Ruolo</span></th>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Sede</span></th>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Classi</span></th>
                                </>
                            ) : (
                                <>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Email</span></th>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">Telefono</span></th>
                                    <th className="px-3 py-3 text-left"><span className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide">C. Fiscale</span></th>
                                </>
                            )}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-kidville-cream">
                        {Object.entries(groupedStudents).map(([section, sectionStudents]) => (
                            <React.Fragment key={section}>
                                {/* Group By Header — colSpan calcolato: child ha checkbox + 6 colonne = 7;
                                    genitori/staff hanno 6 celle (lo staff senza checkbox). */}
                                <tr className="bg-kidville-cream/20">
                                    <td colSpan={currentTypeFilter === 'child' ? 7 : 6} className="px-4 py-2 font-maven font-bold text-kidville-green">
                                        Sezione: {section} <span className="text-xs font-normal text-kidville-muted">({sectionStudents.length} {currentTypeFilter === 'staff' ? 'Personale' : 'alunni'})</span>
                                    </td>
                                </tr>
                                {sectionStudents.map(student => {
                                    const isSelected = selectedIds.has(student.id);
                                    const hasAllergie = !!student.note_mediche;
                                    const hasBes = !!student.bes;

                                    return (
                                        <tr
                                            key={student.id}
                                            className={`transition-colors cursor-pointer ${
                                                isSelected ? 'bg-kidville-green/5' : 'hover:bg-kidville-cream'
                                            }`}
                                            onClick={() => onStudentClick(student)}
                                        >
                                            {currentTypeFilter !== 'staff' && (
                                                <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => onToggleSelect(student.id)}
                                                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green cursor-pointer"
                                                    />
                                                </td>
                                            )}
                                            <td className="px-3 py-3 font-maven font-bold text-sm text-kidville-green">
                                                {student.cognome || student.last_name}
                                            </td>
                                            <td className="px-3 py-3 font-maven text-sm text-kidville-green">
                                                {student.nome || student.first_name}
                                            </td>
                                            {currentTypeFilter === 'child' ? (
                                                <>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted">
                                                        {student.data_nascita
                                                            ? new Date(student.data_nascita).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })
                                                            : '—'
                                                        }
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <span className="font-maven text-sm text-kidville-green font-semibold bg-kidville-cream px-2.5 py-1 rounded-full">
                                                            {student.classe_sezione ?? '—'}
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <span className={`font-maven text-xs font-bold px-2.5 py-1 rounded-full border capitalize ${getStatoBadge(student.stato || 'iscritto')}`}>
                                                            {student.stato || 'iscritto'}
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <div className="flex items-center gap-1.5">
                                                            {hasAllergie && (
                                                                <span className="text-kidville-error text-xs font-maven font-bold flex items-center gap-0.5" title={`Allergie: ${student.note_mediche}`}>
                                                                    <AlertTriangle size={12} /> Allergie
                                                                </span>
                                                            )}
                                                            {hasBes && (
                                                                <span className="text-kidville-warn text-xs font-maven font-bold bg-kidville-warn-soft px-1.5 py-0.5 rounded">
                                                                    BES
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                </>
                                            ) : currentTypeFilter === 'staff' ? (
                                                <>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted">
                                                        {student.emails && student.emails.length > 0 ? student.emails[0] : '—'}
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <span className="font-maven text-xs font-bold px-2.5 py-1 rounded-full bg-kidville-cream text-kidville-green">
                                                            {labelRuolo(student.ruolo || '')}
                                                        </span>
                                                    </td>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted">
                                                        {student.sede_nome || '—'}
                                                    </td>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-green font-semibold">
                                                        {student.classi_count ?? 0}
                                                    </td>
                                                </>
                                            ) : (
                                                <>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted">
                                                        {student.emails && student.emails.length > 0 ? student.emails[0] : '—'}
                                                    </td>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted">
                                                        {student.phone_numbers && student.phone_numbers.length > 0 ? student.phone_numbers[0] : '—'}
                                                    </td>
                                                    <td className="px-3 py-3 font-maven text-sm text-kidville-muted uppercase">
                                                        {student.fiscal_code || student.codice_fiscale || '—'}
                                                    </td>
                                                </>
                                            )}
                                        </tr>
                                    );
                                })}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>

            {students.length === 0 && (
                <div className="text-center py-12">
                    <p className="font-maven text-kidville-muted">
                        {currentTypeFilter === 'staff' ? 'Nessun membro dello staff trovato' : 'Nessun alunno trovato'}
                    </p>
                </div>
            )}
        </div>
    );
}
