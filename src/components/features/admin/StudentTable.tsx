'use client';

import React, { useState } from 'react';
import { ArrowUpDown, AlertTriangle } from 'lucide-react';
import { labelRuolo } from '@/lib/auth/ruoli';
import { StudentRowCard } from './StudentRowCard';

export interface Student {
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
        case 'iscritto': return 'bg-kidville-success-soft text-kidville-success-strong border-kidville-success/30';
        case 'ritirato': return 'bg-kidville-line text-kidville-muted border-kidville-line';
        case 'sospeso': return 'bg-kidville-warn-soft text-kidville-warn-strong border-kidville-warn/30';
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

    // Opzioni di ordinamento per il select compatto della lista mobile — riusano
    // gli stessi campi delle intestazioni cliccabili della tabella.
    const sortOptions: { field: SortField; label: string }[] = currentTypeFilter === 'child'
        ? [
            { field: 'cognome', label: 'Cognome' },
            { field: 'nome', label: 'Nome' },
            { field: 'classe_sezione', label: 'Classe' },
            { field: 'stato', label: 'Stato' },
            { field: 'data_nascita', label: 'Nascita' },
        ]
        : [
            { field: 'cognome', label: 'Cognome' },
            { field: 'nome', label: 'Nome' },
        ];

    return (
        <div className="bg-kidville-white rounded-card shadow-sm overflow-hidden">
            {/* ≥sm: tabella con scroll orizzontale rifinito. */}
            <div className="hidden sm:block kv-table-scroll overflow-x-auto">
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
                                        {/* Staff: niente "Sezione:" (il personale non è raggruppato per classe) e conteggio in "membri". */}
                                        {currentTypeFilter === 'staff' ? 'Personale' : `Sezione: ${section}`} <span className="text-xs font-normal text-kidville-muted">({sectionStudents.length} {currentTypeFilter === 'staff' ? (sectionStudents.length === 1 ? 'membro' : 'membri') : 'alunni'})</span>
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

            {/* <sm: la tabella diventa una lista di card (stessi dati della riga). */}
            {students.length > 0 && (
                <div data-testid="student-cards-mobile" className="sm:hidden p-3">
                    <div className="mb-3 flex items-center gap-2">
                        <label htmlFor="student-sort-mobile" className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-muted">
                            Ordina
                        </label>
                        <select
                            id="student-sort-mobile"
                            value={sortField}
                            onChange={(e) => setSortField(e.target.value as SortField)}
                            className="min-h-[44px] flex-1 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-sm text-kidville-green"
                        >
                            {sortOptions.map(opt => (
                                <option key={opt.field} value={opt.field}>{opt.label}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                            aria-label={sortDir === 'asc' ? 'Ordine crescente, tocca per invertire' : 'Ordine decrescente, tocca per invertire'}
                            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-pill border-[1.5px] border-kidville-line bg-kidville-white text-kidville-green"
                        >
                            <ArrowUpDown size={16} />
                            <span className="ml-0.5 font-maven text-xs font-bold">{sortDir === 'asc' ? 'A-Z' : 'Z-A'}</span>
                        </button>
                    </div>
                    <div className="space-y-2">
                        {sorted.map(student => (
                            <StudentRowCard
                                key={student.id}
                                student={student}
                                isSelected={selectedIds.has(student.id)}
                                onToggleSelect={onToggleSelect}
                                onClick={onStudentClick}
                                currentTypeFilter={currentTypeFilter}
                            />
                        ))}
                    </div>
                </div>
            )}

            {students.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">
                        {currentTypeFilter === 'staff' ? '🧑‍🏫' : '🧒'}
                    </div>
                    <h3 className="font-barlow font-bold text-lg text-kidville-green uppercase mb-1">
                        {currentTypeFilter === 'staff' ? 'Nessun membro dello staff trovato' : 'Nessun alunno trovato'}
                    </h3>
                    <p className="font-maven text-sm text-kidville-muted max-w-xs">
                        Prova a modificare i filtri o la ricerca.
                    </p>
                </div>
            )}
        </div>
    );
}
