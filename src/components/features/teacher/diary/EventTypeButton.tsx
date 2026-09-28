'use client';

import { useTranslations } from 'next-intl';
import { DiaryEventType } from '@/lib/offline/db';
import { configDiVoce, useEventLabel, type FonteRoutine } from './eventConfig';

interface EventTypeButtonProps {
    type: DiaryEventType;
    disabled?: boolean;
    /** Tessera attualmente selezionata: bordo pieno + aria-pressed. */
    selected?: boolean;
    onClick: (type: DiaryEventType) => void;
    /**
     * Per una routine della scuola (`routine:<id>`): la sua definizione, da cui vengono nome e
     * icona. Senza, la tessera direbbe «Evento» 📝 (2026-09-28).
     */
    fonte?: FonteRoutine | null;
}

export function EventTypeButton({ type, disabled = false, selected = false, onClick, fonte }: EventTypeButtonProps) {
    const t = useTranslations('teacherDiario');
    const eventLabel = useEventLabel();
    const config = configDiVoce(type, fonte);
    const etichetta = eventLabel(type, fonte);
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
            aria-label={`${t('registra')} ${etichetta}`}
        >
            <span className="text-3xl leading-none">{config.emoji}</span>
            <span className="font-barlow font-semibold text-[10px] leading-tight px-1 text-center uppercase tracking-wide">
                {etichetta}
            </span>
        </button>
    );
}
