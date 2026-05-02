'use client';

import { DiaryEventType } from '@/lib/offline/db';
import { EVENT_CONFIG } from './eventConfig';

interface EventTypeButtonProps {
    type: DiaryEventType;
    disabled?: boolean;
    onClick: (type: DiaryEventType) => void;
}

export function EventTypeButton({ type, disabled = false, onClick }: EventTypeButtonProps) {
    const config = EVENT_CONFIG[type];

    return (
        <button
            onClick={() => onClick(type)}
            disabled={disabled}
            className={`
                flex flex-col items-center justify-center gap-2
                w-full aspect-square rounded-2xl border-2
                font-maven font-medium text-sm
                transition-all duration-150
                ${config.color} ${config.accentColor}
                ${disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:scale-105 hover:shadow-md active:scale-95 cursor-pointer'
                }
            `}
            aria-label={`Registra ${config.label}`}
        >
            <span className="text-3xl leading-none">{config.emoji}</span>
            <span className="font-barlow font-semibold text-xs uppercase tracking-wide">
                {config.label}
            </span>
        </button>
    );
}
