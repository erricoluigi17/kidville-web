'use client';

import { X, Zap } from 'lucide-react';
import { DiaryEventType } from '@/lib/offline/db';
import { EVENT_CONFIG } from './eventConfig';

interface BulkSelectionBarProps {
    selectedCount: number;
    onClearSelection: () => void;
    onEventSelect: (type: DiaryEventType) => void;
}

const QUICK_EVENTS: DiaryEventType[] = ['pranzo', 'merenda', 'nanna_inizio', 'nanna_fine', 'bagno'];

export function BulkSelectionBar({ selectedCount, onClearSelection, onEventSelect }: BulkSelectionBarProps) {
    if (selectedCount === 0) return null;

    return (
        <div className="fixed bottom-0 left-0 right-0 z-40 p-4 sm:p-6">
            <div className="max-w-3xl mx-auto bg-kidville-green rounded-2xl shadow-2xl p-4 animate-in slide-in-from-bottom duration-300">
                {/* Header barra */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-kidville-yellow flex items-center justify-center">
                            <Zap size={14} className="text-kidville-green" />
                        </div>
                        <span className="font-barlow font-bold text-white text-lg uppercase tracking-wide">
                            {selectedCount} {selectedCount === 1 ? 'bambino' : 'bambini'} selezionati
                        </span>
                    </div>
                    <button
                        onClick={onClearSelection}
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors text-white"
                        aria-label="Deseleziona tutti"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Bottoni azione rapida */}
                <div className="flex gap-2 overflow-x-auto pb-1">
                    {QUICK_EVENTS.map(type => {
                        const cfg = EVENT_CONFIG[type];
                        return (
                            <button
                                key={type}
                                onClick={() => onEventSelect(type)}
                                className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-full bg-white/15 hover:bg-white/25 transition-colors text-white font-maven font-medium text-sm whitespace-nowrap active:scale-95"
                            >
                                <span>{cfg.emoji}</span>
                                <span>{cfg.label}</span>
                            </button>
                        );
                    })}
                </div>

                <p className="font-maven text-white/60 text-xs mt-2 text-center">
                    L'azione verrà applicata a tutti i bambini selezionati
                </p>
            </div>
        </div>
    );
}
