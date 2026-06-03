'use client';

import { useState, useMemo } from 'react';
import { CheckCircle2, XCircle, ChevronDown, CalendarDays } from 'lucide-react';

// ─── Tipi ────────────────────────────────────────────────────────────────────

export interface LockerRecord {
    id: string;
    alunno_id: string;
    materiale: string;
    quantita: number;
    date: string;       // YYYY-MM-DD
    portato: boolean;
}

export interface StudentInfo {
    id: string;
    nome: string;
    cognome: string;
    inventario: LockerRecord[];
}

interface MonthlyLockerTableProps {
    /** Lista studenti con i loro record di armadietto */
    students: StudentInfo[];
    /** Mese corrente nel formato YYYY-MM */
    month: string;
    /** Se true, nasconde la colonna studente (vista genitore) */
    hideStudentColumn?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDaysInMonth(yearMonth: string): number[] {
    const [y, m] = yearMonth.split('-').map(Number);
    const count = new Date(y, m, 0).getDate();
    return Array.from({ length: count }, (_, i) => i + 1);
}

function formatMonthLabel(yearMonth: string): string {
    const [y, m] = yearMonth.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('it-IT', {
        month: 'long',
        year: 'numeric',
    });
}

// ─── Componente principale ────────────────────────────────────────────────────

export function MonthlyLockerTable({
    students,
    month,
    hideStudentColumn = false,
}: MonthlyLockerTableProps) {
    const days = useMemo(() => getDaysInMonth(month), [month]);

    // Raccoglie tutti i materiali unici presenti nei dati
    const allMaterials = useMemo(() => {
        const set = new Set<string>();
        students.forEach(s => s.inventario.forEach(r => set.add(r.materiale)));
        return ['Tutti', ...Array.from(set).sort()];
    }, [students]);

    const [selectedMaterial, setSelectedMaterial] = useState<string>('Tutti');
    const [dropdownOpen, setDropdownOpen] = useState(false);

    // Filtra i record in base al materiale selezionato
    const filteredStudents = useMemo<StudentInfo[]>(() => {
        if (selectedMaterial === 'Tutti') return students;
        return students.map(s => ({
            ...s,
            inventario: s.inventario.filter(r => r.materiale === selectedMaterial),
        }));
    }, [students, selectedMaterial]);

    // Lookup rapido: alunno_id + materiale + date → record
    const lookup = useMemo(() => {
        const map = new Map<string, LockerRecord>();
        students.forEach(s =>
            s.inventario.forEach(r => {
                const day = parseInt(r.date.split('-')[2], 10);
                map.set(`${r.alunno_id}__${r.materiale}__${day}`, r);
            })
        );
        return map;
    }, [students]);

    // Materiali visibili per la griglia (tutti se "Tutti", altrimenti solo quello selezionato)
    const visibleMaterials = useMemo(() => {
        return selectedMaterial === 'Tutti'
            ? allMaterials.filter(m => m !== 'Tutti')
            : [selectedMaterial];
    }, [selectedMaterial, allMaterials]);

    if (students.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <CalendarDays className="w-12 h-12 mb-3 opacity-30" />
                <p className="text-sm">Nessun dato disponibile per {formatMonthLabel(month)}</p>
            </div>
        );
    }

    return (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* ── Header + filtro materiale ── */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                <div className="flex items-center gap-2">
                    <CalendarDays className="w-5 h-5 text-violet-400" />
                    <h2 className="text-lg font-semibold text-kidville-green capitalize">
                        {formatMonthLabel(month)}
                    </h2>
                </div>

                {/* Dropdown materiale */}
                <div className="relative">
                    <button
                        id="material-filter-btn"
                        onClick={() => setDropdownOpen(o => !o)}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl
                                   bg-kidville-cream border border-white/10 text-sm text-kidville-green/80
                                   hover:bg-kidville-cream hover:border-white/20
                                   transition-all duration-300 min-w-[180px]"
                    >
                        <span className="flex-1 text-left">
                            {selectedMaterial === 'Tutti' ? 'Tutti i materiali' : selectedMaterial}
                        </span>
                        <ChevronDown
                            className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${dropdownOpen ? 'rotate-180' : ''}`}
                        />
                    </button>

                    {dropdownOpen && (
                        <div
                            className="absolute right-0 z-50 mt-2 w-56 rounded-2xl
                                       bg-kidville-cream/95 backdrop-blur-xl border border-white/10
                                       shadow-2xl overflow-hidden"
                        >
                            {allMaterials.map(mat => (
                                <button
                                    key={mat}
                                    id={`material-opt-${mat.toLowerCase().replace(/\s+/g, '-')}`}
                                    onClick={() => {
                                        setSelectedMaterial(mat);
                                        setDropdownOpen(false);
                                    }}
                                    className={`w-full text-left px-4 py-2.5 text-sm
                                                transition-all duration-200
                                                ${selectedMaterial === mat
                                                    ? 'bg-violet-600/30 text-violet-300 font-semibold'
                                                    : 'text-kidville-green/80 hover:bg-kidville-cream'
                                                }`}
                                >
                                    {mat === 'Tutti' ? '— Tutti i materiali —' : mat}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Tabella scrollabile ── */}
            <div
                className="bg-kidville-cream0 backdrop-blur-xl border border-white/10
                           rounded-2xl overflow-hidden"
            >
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/10">
                                {!hideStudentColumn && (
                                    <th className="sticky left-0 z-10 bg-white/80 backdrop-blur-sm
                                                   text-left px-4 py-3 text-xs font-semibold
                                                   text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                        Studente
                                    </th>
                                )}
                                <th className="px-4 py-3 text-left text-xs font-semibold
                                               text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                    Materiale
                                </th>
                                {days.map(d => (
                                    <th
                                        key={d}
                                        className="px-2 py-3 text-center text-xs font-semibold
                                                   text-gray-500 uppercase tracking-wider w-8"
                                    >
                                        {d}
                                    </th>
                                ))}
                            </tr>
                        </thead>

                        <tbody className="divide-y divide-white/5">
                            {filteredStudents.map(student =>
                                visibleMaterials.map((mat, mIdx) => (
                                    <tr
                                        key={`${student.id}-${mat}`}
                                        className={`transition-colors duration-150
                                                    ${mIdx % 2 === 0 ? 'bg-white/[0.02]' : ''} 
                                                    hover:bg-white/[0.04]`}
                                    >
                                        {/* Colonna studente — solo sulla prima riga del materiale */}
                                        {!hideStudentColumn && (
                                            <td className="sticky left-0 z-10 bg-white/80 backdrop-blur-sm
                                                           px-4 py-3 whitespace-nowrap">
                                                {mIdx === 0 ? (
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-7 h-7 rounded-full bg-violet-600/20
                                                                        border border-violet-500/30 flex items-center
                                                                        justify-center text-xs font-bold text-violet-300">
                                                            {student.nome[0]}{student.cognome[0]}
                                                        </div>
                                                        <span className="font-medium text-kidville-green text-xs">
                                                            {student.nome} {student.cognome}
                                                        </span>
                                                    </div>
                                                ) : null}
                                            </td>
                                        )}

                                        {/* Colonna materiale */}
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            <span className="text-xs font-medium text-gray-500 bg-kidville-cream
                                                            border border-white/10 rounded-full px-2.5 py-1">
                                                {mat}
                                            </span>
                                        </td>

                                        {/* Celle giorni */}
                                        {days.map(day => {
                                            const record = lookup.get(`${student.id}__${mat}__${day}`);
                                            return (
                                                <td
                                                    key={day}
                                                    className="px-1 py-2 text-center"
                                                >
                                                    {record ? (
                                                        record.portato ? (
                                                            <CheckCircle2
                                                                className="w-5 h-5 text-emerald-400/90 mx-auto
                                                                           drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]"
                                                            />
                                                        ) : (
                                                            <XCircle
                                                                className="w-5 h-5 text-rose-500/90 mx-auto
                                                                           drop-shadow-[0_0_8px_rgba(244,63,94,0.5)]"
                                                            />
                                                        )
                                                    ) : (
                                                        <span className="text-gray-400 text-xs select-none">—</span>
                                                    )}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Legenda */}
                <div className="flex items-center gap-6 px-4 py-3 border-t border-white/5">
                    <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400/90 drop-shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
                        <span className="text-xs text-gray-500">Portato</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <XCircle className="w-4 h-4 text-rose-500/90 drop-shadow-[0_0_6px_rgba(244,63,94,0.5)]" />
                        <span className="text-xs text-gray-500">Non portato</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-gray-400 text-xs font-mono">—</span>
                        <span className="text-xs text-gray-500">Nessun dato</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
