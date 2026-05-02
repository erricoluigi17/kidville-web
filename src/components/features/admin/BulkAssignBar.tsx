'use client';

import { Users, ChevronDown } from 'lucide-react';

interface Props {
    selectedCount: number;
    availableClasses: string[];
    targetClass: string;
    onTargetClassChange: (cls: string) => void;
    onAssign: () => void;
    onClear: () => void;
    isAssigning: boolean;
}

export function BulkAssignBar({
    selectedCount,
    availableClasses,
    targetClass,
    onTargetClassChange,
    onAssign,
    onClear,
    isAssigning,
}: Props) {
    if (selectedCount === 0) return null;

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4">
            <div className="bg-kidville-green rounded-2xl shadow-2xl p-4 flex items-center gap-4 animate-[slideUp_0.3s_ease-out]">
                {/* Conteggio */}
                <div className="flex items-center gap-2 bg-kidville-yellow/20 rounded-xl px-3 py-2">
                    <Users size={16} className="text-kidville-yellow" />
                    <span className="font-barlow font-black text-lg text-kidville-yellow">
                        {selectedCount}
                    </span>
                    <span className="font-maven text-xs text-kidville-yellow/80">
                        selezionati
                    </span>
                </div>

                {/* Freccia + Dropdown classe */}
                <div className="flex-1 flex items-center gap-2">
                    <span className="text-kidville-yellow/60 font-maven text-sm">→</span>
                    <div className="relative flex-1">
                        <select
                            value={targetClass}
                            onChange={e => onTargetClassChange(e.target.value)}
                            className="w-full bg-white/10 border-2 border-kidville-yellow/30 rounded-xl px-3 py-2 font-maven text-sm text-white appearance-none focus:outline-none focus:border-kidville-yellow cursor-pointer"
                        >
                            <option value="" className="text-kidville-green">Seleziona classe...</option>
                            {availableClasses.map(c => (
                                <option key={c} value={c} className="text-kidville-green">
                                    {c}
                                </option>
                            ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-kidville-yellow/60 pointer-events-none" />
                    </div>
                </div>

                {/* Pulsante Assegna */}
                <button
                    onClick={onAssign}
                    disabled={!targetClass || isAssigning}
                    className="h-10 px-5 rounded-pill bg-kidville-yellow text-kidville-green font-barlow font-black uppercase tracking-wide text-sm hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center gap-2"
                >
                    {isAssigning ? (
                        <div className="w-4 h-4 border-2 border-kidville-green/40 border-t-kidville-green rounded-full animate-spin" />
                    ) : (
                        'Assegna'
                    )}
                </button>

                {/* Annulla selezione */}
                <button
                    onClick={onClear}
                    className="text-kidville-yellow/60 hover:text-kidville-yellow text-xs font-maven underline"
                >
                    Annulla
                </button>
            </div>
        </div>
    );
}
