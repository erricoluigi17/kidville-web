'use client';

import { LocalDiaryEntry, DiaryEventType } from '@/lib/offline/db';
import { EVENT_CONFIG } from './eventConfig';
import { AlertTriangle } from 'lucide-react';

interface Student {
    id: string;
    firstName: string;
    lastName: string;
    allergie?: string[];
}

interface StudentDiaryRowProps {
    student: Student;
    lastEntry?: LocalDiaryEntry;
    isSelected: boolean;
    isPranzoActive?: boolean; // evidenziazione allergie durante il pranzo
    onSelect: (id: string) => void;
}

export function StudentDiaryRow({
    student,
    lastEntry,
    isSelected,
    isPranzoActive = false,
    onSelect,
}: StudentDiaryRowProps) {
    const hasAllergie = (student.allergie?.length ?? 0) > 0;
    const showAllergyWarning = isPranzoActive && hasAllergie;
    const lastEventConfig = lastEntry ? EVENT_CONFIG[lastEntry.tipo_evento as DiaryEventType] : null;

    return (
        <div
            onClick={() => onSelect(student.id)}
            className={`
                flex items-center gap-3 p-3 rounded-xl cursor-pointer
                border-2 transition-all duration-150 select-none
                ${isSelected
                    ? 'border-kidville-green bg-kidville-green/5'
                    : showAllergyWarning
                        ? 'border-kidville-error bg-kidville-error/5'
                        : 'border-gray-100 bg-white hover:border-gray-200'
                }
            `}
            role="checkbox"
            aria-checked={isSelected}
            aria-label={`${student.firstName} ${student.lastName}`}
        >
            {/* Checkbox visuale */}
            <div className={`
                w-6 h-6 flex-shrink-0 rounded-md border-2 flex items-center justify-center transition-colors
                ${isSelected
                    ? 'bg-kidville-green border-kidville-green'
                    : 'border-gray-300 bg-white'
                }
            `}>
                {isSelected && (
                    <svg className="w-4 h-4 text-kidville-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                )}
            </div>

            {/* Avatar iniziali */}
            <div className={`
                w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center font-barlow font-bold text-sm
                ${showAllergyWarning
                    ? 'bg-kidville-error text-white'
                    : 'bg-kidville-cream text-kidville-green'
                }
            `}>
                {student.firstName[0]}{student.lastName[0]}
            </div>

            {/* Nome e info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className={`font-maven font-medium text-sm truncate ${showAllergyWarning ? 'text-kidville-error' : 'text-kidville-green'}`}>
                        {student.firstName} {student.lastName}
                    </span>
                    {showAllergyWarning && (
                        <AlertTriangle size={14} className="flex-shrink-0 text-kidville-error" />
                    )}
                </div>
                {showAllergyWarning && (
                    <p className="font-maven text-xs text-kidville-error truncate">
                        ⚠️ {student.allergie!.join(', ')}
                    </p>
                )}
                {!showAllergyWarning && lastEventConfig && (
                    <p className="font-maven text-xs text-gray-400 truncate">
                        Ultimo: {lastEventConfig.emoji} {lastEventConfig.label}
                    </p>
                )}
            </div>

            {/* Badge ultimo evento */}
            {lastEventConfig && (
                <div className={`flex-shrink-0 px-2 py-1 rounded-full text-xs font-maven font-medium border ${lastEventConfig.accentColor} ${lastEventConfig.color}`}>
                    {lastEventConfig.emoji}
                </div>
            )}
        </div>
    );
}
