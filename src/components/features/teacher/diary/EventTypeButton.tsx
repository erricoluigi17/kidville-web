'use client';

import { DiaryEventType } from '@/lib/offline/db';
import { EVENT_CONFIG } from './eventConfig';

interface EventTypeButtonProps {
    type: DiaryEventType;
    disabled?: boolean;
    /** Tessera attualmente selezionata: bordo pieno + aria-pressed. */
    selected?: boolean;
    onClick: (type: DiaryEventType) => void;
}

export function EventTypeButton({ type, disabled = false, selected = false, onClick }: EventTypeButtonProps) {
    const config = EVENT_CONFIG[type];
    // Selezione: bordo pieno green al posto del border-…/25 di config — un anello
    // sul wrapper verrebbe coperto dallo sfondo opaco del bottone, mentre il bordo
    // resta visibile anche in alto contrasto (dove gli sfondi -soft diventano neri).
    const accent = selected
        ? config.accentColor.replace(/border-\S+/, 'border-kidville-green')
        : config.accentColor;

    return (
        <button
            onClick={() => onClick(type)}
            disabled={disabled}
            aria-pressed={selected}
            className={`
                flex flex-col items-center justify-center gap-1.5
                w-full aspect-square rounded-2xl border-2
                font-maven font-medium text-sm
                transition-all duration-150
                ${config.color} ${accent}
                ${disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:scale-[1.03] hover:shadow-md active:scale-95 cursor-pointer'
                }
            `}
            aria-label={`Registra ${config.label}`}
        >
            <span className="text-3xl leading-none">{config.emoji}</span>
            <span className="font-barlow font-semibold text-[10px] leading-tight px-1 text-center uppercase tracking-wide">
                {config.label}
            </span>
        </button>
    );
}
