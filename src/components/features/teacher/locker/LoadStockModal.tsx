'use client';

import { useState } from 'react';
import { X, Plus, Minus, Package } from 'lucide-react';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    students: Array<{ id: string; nome: string; cognome: string }>;
    preselectedStudent?: string;
    preselectedMateriale?: string;
    onConfirm: (data: { alunno_id: string; materiale: string; quantita: number }) => void;
}

const MATERIALI_DEFAULT = [
    { nome: 'Pannolini', icona: '🧷' },
    { nome: 'Salviette', icona: '🧻' },
    { nome: 'Crema', icona: '🧴' },
    { nome: 'Cambio', icona: '👕' },
];

export function LoadStockModal({
    isOpen,
    onClose,
    students,
    preselectedStudent,
    preselectedMateriale,
    onConfirm,
}: Props) {
    const [selectedStudent, setSelectedStudent] = useState(preselectedStudent ?? '');
    const [selectedMateriale, setSelectedMateriale] = useState(preselectedMateriale ?? 'Pannolini');
    const [quantity, setQuantity] = useState(10);
    const [isSaving, setIsSaving] = useState(false);

    if (!isOpen) return null;

    const handleConfirm = async () => {
        if (!selectedStudent || !selectedMateriale || quantity <= 0) return;
        setIsSaving(true);
        try {
            await onConfirm({
                alunno_id: selectedStudent,
                materiale: selectedMateriale,
                quantita: quantity,
            });
            onClose();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
            <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-w-md mx-auto bg-white rounded-3xl shadow-2xl p-6">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="font-barlow font-black text-xl text-kidville-green uppercase">Registra Carico</h2>
                    <button onClick={onClose} className="text-gray-400"><X size={20} /></button>
                </div>

                <div className="mb-4">
                    <label className="text-xs font-bold text-kidville-green mb-1 block">Alunno</label>
                    <select
                        value={selectedStudent}
                        onChange={e => setSelectedStudent(e.target.value)}
                        className="w-full border-2 border-gray-100 rounded-xl p-2.5 text-sm"
                    >
                        <option value="">Seleziona...</option>
                        {students.map(s => <option key={s.id} value={s.id}>{s.nome} {s.cognome}</option>)}
                    </select>
                </div>

                <div className="mb-4">
                    <label className="text-xs font-bold text-kidville-green mb-1 block">Materiale</label>
                    <div className="grid grid-cols-2 gap-2">
                        {MATERIALI_DEFAULT.map(m => (
                            <button
                                key={m.nome}
                                onClick={() => setSelectedMateriale(m.nome)}
                                className={`p-3 rounded-xl border-2 text-sm font-bold ${
                                    selectedMateriale === m.nome ? 'border-kidville-green bg-kidville-green/5' : 'border-gray-50'
                                }`}
                            >
                                {m.icona} {m.nome}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="mb-6">
                    <label className="text-xs font-bold text-kidville-green mb-1 block text-center">Quantità</label>
                    <div className="flex items-center justify-center gap-4">
                        <button onClick={() => setQuantity(q => Math.max(1, q - 5))} className="p-2 border rounded-lg"><Minus size={16} /></button>
                        <span className="text-3xl font-black text-kidville-green">{quantity}</span>
                        <button onClick={() => setQuantity(q => q + 5)} className="p-2 border rounded-lg"><Plus size={16} /></button>
                    </div>
                </div>

                <button
                    onClick={handleConfirm}
                    disabled={isSaving}
                    className="w-full bg-kidville-green text-kidville-yellow py-3 rounded-pill font-black uppercase tracking-widest"
                >
                    {isSaving ? 'Salvataggio...' : 'Conferma'}
                </button>
            </div>
        </>
    );
}
