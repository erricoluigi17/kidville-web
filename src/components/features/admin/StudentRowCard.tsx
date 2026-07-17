'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { labelRuolo } from '@/lib/auth/ruoli';
import type { Student } from './StudentTable';

/**
 * Card-riga dell'anagrafica per il layout mobile (`sm:hidden`) — sotto `sm` la
 * tabella di `StudentTable` cede il posto a una lista di queste card, nello stile
 * delle liste dell'app (cfr. `PagamentoCardMobile`). Mostra gli STESSI dati della
 * riga: nessuna logica dati nuova, solo un diverso impaginato. Marker `.kv-admin-rowcard`
 * per le regole di alto contrasto (globals.css).
 */

// Stessa mappa colori della riga tabella (StudentTable.getStatoBadge). Duplicata
// qui — e non importata — per non creare un ciclo di import a runtime tra i due file.
function getStatoBadge(stato: string) {
    switch (stato) {
        case 'iscritto': return 'bg-kidville-success-soft text-kidville-success-strong border-kidville-success/30';
        case 'ritirato': return 'bg-kidville-line text-kidville-muted border-kidville-line';
        case 'sospeso': return 'bg-kidville-warn-soft text-kidville-warn-strong border-kidville-warn/30';
        default: return 'bg-kidville-line text-kidville-muted border-kidville-line';
    }
}

interface Props {
    student: Student;
    isSelected: boolean;
    onToggleSelect: (id: string) => void;
    onClick: (student: Student) => void;
    currentTypeFilter: 'adult' | 'child' | 'staff';
}

export function StudentRowCard({ student, isSelected, onToggleSelect, onClick, currentTypeFilter }: Props) {
    const cognome = student.cognome || student.last_name || '—';
    const nome = student.nome || student.first_name || '';
    const hasAllergie = !!student.note_mediche;
    const hasBes = !!student.bes;
    const showCheckbox = currentTypeFilter !== 'staff';

    return (
        <div
            data-student-id={student.id}
            role="button"
            tabIndex={0}
            aria-label={`Apri scheda di ${cognome} ${nome}`.trim()}
            onClick={() => onClick(student)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick(student);
                }
            }}
            className={`kv-admin-rowcard rounded-card border-[1.5px] p-3 cursor-pointer transition-colors ${
                isSelected ? 'border-kidville-green bg-kidville-green/5' : 'border-kidville-line bg-kidville-white'
            }`}
        >
            <div className="flex items-start gap-2">
                {showCheckbox && (
                    // Tap target ≥44px attorno alla checkbox; stopPropagation così il
                    // toggle di selezione non apre anche la scheda.
                    <label
                        className="-m-1 flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onToggleSelect(student.id)}
                            className="h-5 w-5 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green cursor-pointer"
                        />
                    </label>
                )}

                <div className="min-w-0 flex-1">
                    <p className="truncate font-maven text-sm font-bold text-kidville-green">
                        {cognome} {nome}
                    </p>

                    {currentTypeFilter === 'child' && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 font-maven text-xs text-kidville-sub">
                            <span className="rounded-full bg-kidville-cream px-2.5 py-1 font-semibold text-kidville-green">
                                {student.classe_sezione ?? '—'}
                            </span>
                            <span>
                                {student.data_nascita
                                    ? new Date(student.data_nascita).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })
                                    : '—'}
                            </span>
                        </div>
                    )}

                    {currentTypeFilter === 'staff' && (
                        <div className="mt-1 space-y-0.5 font-maven text-xs text-kidville-sub">
                            <p className="truncate">{student.emails && student.emails.length > 0 ? student.emails[0] : '—'}</p>
                            <p className="truncate">{student.sede_nome || '—'}</p>
                            <p className="font-semibold text-kidville-green">
                                {student.classi_count ?? 0} {(student.classi_count ?? 0) === 1 ? 'classe' : 'classi'}
                            </p>
                        </div>
                    )}

                    {currentTypeFilter === 'adult' && (
                        <div className="mt-1 space-y-0.5 font-maven text-xs text-kidville-sub">
                            <p className="truncate">{student.emails && student.emails.length > 0 ? student.emails[0] : '—'}</p>
                            <p className="truncate">{student.phone_numbers && student.phone_numbers.length > 0 ? student.phone_numbers[0] : '—'}</p>
                            <p className="truncate uppercase">{student.fiscal_code || student.codice_fiscale || '—'}</p>
                        </div>
                    )}
                </div>

                <div className="shrink-0">
                    {currentTypeFilter === 'child' && (
                        <span className={`font-maven text-xs font-bold px-2.5 py-1 rounded-full border capitalize ${getStatoBadge(student.stato || 'iscritto')}`}>
                            {student.stato || 'iscritto'}
                        </span>
                    )}
                    {currentTypeFilter === 'staff' && (
                        <span className="rounded-full bg-kidville-cream px-2.5 py-1 font-maven text-xs font-bold text-kidville-green">
                            {labelRuolo(student.ruolo || '')}
                        </span>
                    )}
                </div>
            </div>

            {currentTypeFilter === 'child' && (hasAllergie || hasBes) && (
                <div className="mt-2 flex items-center gap-1.5">
                    {hasAllergie && (
                        // Solo un flag di presenza: la nota medica GREZZA (dato art. 9
                        // GDPR di un minore) non finisce mai in un attributo DOM — il
                        // dettaglio vive solo dietro la scheda alunno.
                        <span className="text-kidville-error text-xs font-maven font-bold flex items-center gap-0.5" title="Allergie/note mediche presenti">
                            <AlertTriangle size={12} /> Allergie
                        </span>
                    )}
                    {hasBes && (
                        <span className="text-kidville-warn-strong text-xs font-maven font-bold bg-kidville-warn-soft px-1.5 py-0.5 rounded">
                            BES
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
