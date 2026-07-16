'use client';

import { Users, ChevronDown, UtensilsCrossed } from 'lucide-react';

interface Props {
    selectedCount: number;
    availableClasses: string[];
    targetClass: string;
    onTargetClassChange: (cls: string) => void;
    onAssign: () => void;
    onClear: () => void;
    isAssigning: boolean;
    // P5.4 (DL-050): assegnazione massiva a gruppo mensa (opzionale, retro-compatibile).
    mensaGroups?: { id: string; nome: string }[];
    targetMensa?: string;
    onTargetMensaChange?: (id: string) => void;
    onAssignMensa?: () => void;
}

export function BulkAssignBar({
    selectedCount,
    availableClasses,
    targetClass,
    onTargetClassChange,
    onAssign,
    onClear,
    isAssigning,
    mensaGroups,
    targetMensa = '',
    onTargetMensaChange,
    onAssignMensa,
}: Props) {
    if (selectedCount === 0) return null;
    const showMensa = !!mensaGroups && mensaGroups.length > 0 && !!onAssignMensa;

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-4 space-y-2">
            {showMensa && (
                <div className="bg-kidville-green/95 rounded-2xl shadow-xl p-3 flex items-center gap-3">
                    <UtensilsCrossed size={16} className="text-kidville-yellow" />
                    <div className="relative flex-1">
                        <select
                            value={targetMensa}
                            onChange={e => onTargetMensaChange?.(e.target.value)}
                            className="w-full bg-kidville-white/10 border-2 border-kidville-yellow/30 rounded-input px-3 py-2 font-maven text-sm text-kidville-white appearance-none focus:outline-none focus:border-kidville-yellow cursor-pointer"
                        >
                            <option value="" className="text-kidville-green">Gruppo mensa…</option>
                            {mensaGroups!.map(g => (
                                <option key={g.id} value={g.id} className="text-kidville-green">{g.nome}</option>
                            ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-kidville-yellow/60 pointer-events-none" />
                    </div>
                    <button
                        onClick={onAssignMensa}
                        disabled={!targetMensa || isAssigning}
                        className="h-9 px-4 rounded-pill bg-kidville-yellow text-kidville-green font-barlow font-black uppercase tracking-wide text-xs hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
                    >
                        Assegna mensa
                    </button>
                </div>
            )}
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
                            className="w-full bg-kidville-white/10 border-2 border-kidville-yellow/30 rounded-input px-3 py-2 font-maven text-sm text-kidville-white appearance-none focus:outline-none focus:border-kidville-yellow cursor-pointer"
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
