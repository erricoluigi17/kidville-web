'use client';

import { X } from 'lucide-react';
import { MEAL_QUANTITIES, BATHROOM_TYPES, EVENT_CONFIG } from './eventConfig';
import { DiaryEventType } from '@/lib/offline/db';

interface Student {
    id: string;
    firstName: string;
    lastName: string;
    allergie?: string[];
}

interface MealDetailModalProps {
    eventType: DiaryEventType;
    selectedStudents: Student[];
    onConfirm: (dettagli: Record<string, unknown>, note: string) => void;
    onClose: () => void;
}

export function MealDetailModal({ eventType, selectedStudents, onConfirm, onClose }: MealDetailModalProps) {
    const config = EVENT_CONFIG[eventType];
    const isMeal = eventType === 'pranzo' || eventType === 'merenda';
    const isBathroom = eventType === 'bagno';
    const isActivity = eventType === 'attivita';

    // Studenti con allergie (rilevante solo durante il pasto)
    const studentWithAllergie = isMeal
        ? selectedStudents.filter(s => s.allergie && s.allergie.length > 0)
        : [];

    const handleMealSelect = (quantita: string) => {
        onConfirm({ quantita }, '');
    };

    const handleBathroomSelect = (tipo: string) => {
        onConfirm({ tipo }, '');
    };

    const handleActivitySubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        const note = (form.elements.namedItem('note') as HTMLTextAreaElement).value;
        onConfirm({}, note);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] overflow-y-auto">

                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-gray-100">
                    <div className="flex items-center gap-3">
                        <span className="text-3xl">{config.emoji}</span>
                        <div>
                            <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase tracking-wide">
                                {config.label}
                            </h2>
                            <p className="font-maven text-sm text-gray-500">
                                {selectedStudents.length === 1
                                    ? `${selectedStudents[0].firstName} ${selectedStudents[0].lastName}`
                                    : `${selectedStudents.length} bambini selezionati`
                                }
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors text-gray-400"
                        aria-label="Chiudi"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Allarme Allergie (solo durante pasto) */}
                {studentWithAllergie.length > 0 && (
                    <div className="mx-5 mt-4 p-3 rounded-xl bg-kidville-error/10 border border-kidville-error/30">
                        <p className="font-barlow font-bold text-kidville-error uppercase text-sm tracking-wide mb-1">
                            ⚠️ Attenzione Allergie!
                        </p>
                        {studentWithAllergie.map(s => (
                            <p key={s.id} className="font-maven text-kidville-error text-sm">
                                <strong>{s.firstName} {s.lastName}:</strong> {s.allergie!.join(', ')}
                            </p>
                        ))}
                    </div>
                )}

                {/* Body — Selezione quantità pasto */}
                {isMeal && (
                    <div className="p-5">
                        <p className="font-maven font-medium text-kidville-green mb-4">
                            Quanto ha mangiato?
                        </p>
                        <div className="grid grid-cols-5 gap-2">
                            {MEAL_QUANTITIES.map(q => (
                                <button
                                    key={q.value}
                                    onClick={() => handleMealSelect(q.value)}
                                    className="flex flex-col items-center gap-1 p-3 rounded-xl border-2 border-gray-100 hover:border-kidville-green hover:bg-kidville-cream transition-all active:scale-95"
                                >
                                    <span className="text-2xl">{q.icon}</span>
                                    <span className="font-maven text-xs text-kidville-green font-medium">{q.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Body — Selezione tipo bagno */}
                {isBathroom && (
                    <div className="p-5">
                        <p className="font-maven font-medium text-kidville-green mb-4">
                            Tipo di cambio:
                        </p>
                        <div className="grid grid-cols-3 gap-3">
                            {BATHROOM_TYPES.map(b => (
                                <button
                                    key={b.value}
                                    onClick={() => handleBathroomSelect(b.value)}
                                    className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-sky-100 bg-sky-50 hover:border-sky-400 transition-all active:scale-95"
                                >
                                    <span className="text-3xl">{b.icon}</span>
                                    <span className="font-maven text-sm text-sky-700 font-medium">{b.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Body — Nota attività / testo libero */}
                {(isActivity || (!isMeal && !isBathroom)) && (
                    <form onSubmit={handleActivitySubmit} className="p-5">
                        <label className="block font-maven font-medium text-kidville-green mb-2">
                            Note (opzionale)
                        </label>
                        <textarea
                            name="note"
                            rows={4}
                            placeholder="Descrivi l'attività o aggiungi una nota..."
                            className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm focus:outline-none focus:border-kidville-green focus:ring-1 focus:ring-kidville-green resize-none text-kidville-green"
                        />
                        <button
                            type="submit"
                            className="w-full mt-4 h-12 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-bold text-lg uppercase tracking-wide hover:opacity-90 transition-opacity"
                        >
                            Conferma {config.label}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
