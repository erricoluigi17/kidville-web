'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Minus, Settings } from 'lucide-react';
import Link from 'next/link';

interface MaterialeConfig {
    id: string;
    nome: string;
    icona: string;
    unita: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    students: Array<{ id: string; nome: string; cognome: string }>;
    preselectedStudent?: string;
    preselectedMateriale?: string;
    classeSezione?: string;
    onConfirm: (data: { alunno_id: string; materiale: string; quantita: number }) => Promise<void>;
    // Se fornito, abilita "assegna a tutta la sezione" (distribuisce a tutti gli alunni).
    onConfirmBulk?: (data: { alunno_ids: string[]; materiale: string; quantita: number }) => Promise<void>;
}

const MATERIALI_FALLBACK: MaterialeConfig[] = [
    { id: '1', nome: 'Pannolini', icona: '🧷', unita: 'pz' },
    { id: '2', nome: 'Salviette', icona: '🧻', unita: 'pz' },
    { id: '3', nome: 'Crema',     icona: '🧴', unita: 'pz' },
    { id: '4', nome: 'Cambio',    icona: '👕', unita: 'pz' },
];

export function LoadStockModal({
    isOpen,
    onClose,
    students,
    preselectedStudent,
    preselectedMateriale,
    classeSezione,
    onConfirm,
    onConfirmBulk,
}: Props) {
    const [selectedStudent,   setSelectedStudent]   = useState(preselectedStudent ?? '');
    const [selectedMateriale, setSelectedMateriale] = useState(preselectedMateriale ?? '');
    const [quantity,          setQuantity]          = useState(10);
    const [isSaving,          setIsSaving]          = useState(false);
    const [error,             setError]             = useState('');
    const [materiali,         setMateriali]         = useState<MaterialeConfig[]>(MATERIALI_FALLBACK);
    const [tuttaLaSezione,    setTuttaLaSezione]    = useState(false);

    // Aggiorna i valori preselezionati quando cambiano le prop
    // (adeguamento dello stato durante il render, con guardia sul valore precedente:
    // stesso effetto della vecchia useEffect ma senza setState-in-effect).
    const [prevPreselected, setPrevPreselected] = useState({ preselectedStudent, preselectedMateriale });
    if (prevPreselected.preselectedStudent !== preselectedStudent || prevPreselected.preselectedMateriale !== preselectedMateriale) {
        setPrevPreselected({ preselectedStudent, preselectedMateriale });
        if (preselectedStudent)   setSelectedStudent(preselectedStudent);
        if (preselectedMateriale) setSelectedMateriale(preselectedMateriale);
    }

    // Carica materiali configurati dall'API
    useEffect(() => {
        if (!isOpen) return;
        const params = classeSezione ? `?classe_sezione=${classeSezione}` : '';
        fetch(`/api/locker/materials${params}`)
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                    setMateriali(data);
                    // Preseleziona il primo se non c'è una preselection
                    setSelectedMateriale(prev => prev || data[0].nome);
                }
            })
            .catch(() => {/* usa fallback */});
    }, [isOpen, classeSezione]);

    if (!isOpen) return null;

    const bulkMode = tuttaLaSezione && !!onConfirmBulk;

    const handleConfirm = async () => {
        if (!bulkMode && !selectedStudent) { setError('Seleziona un alunno'); return; }
        if (bulkMode && students.length === 0) { setError('Nessun alunno nella sezione'); return; }
        if (!selectedMateriale) { setError('Seleziona un materiale'); return; }
        if (quantity <= 0)       { setError('Inserisci una quantità valida'); return; }

        setIsSaving(true);
        setError('');
        try {
            if (bulkMode) {
                await onConfirmBulk!({ alunno_ids: students.map(s => s.id), materiale: selectedMateriale, quantita: quantity });
            } else {
                await onConfirm({ alunno_id: selectedStudent, materiale: selectedMateriale, quantita: quantity });
            }
            onClose();
            setQuantity(10);
            setTuttaLaSezione(false);
        } catch (e) {
            setError((e as { message?: string }).message ?? 'Errore durante il salvataggio');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <>
            <div className="fixed inset-0 z-50 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />
            <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 max-w-md mx-auto bg-white rounded-3xl shadow-2xl p-6">

                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <h2 className="font-barlow font-black text-xl text-kidville-green uppercase">
                        Registra Carico
                    </h2>
                    <div className="flex items-center gap-2">
                        <Link href="/teacher/settings/locker" onClick={onClose}
                            title="Configura materiali"
                            className="p-1.5 text-kidville-muted hover:text-kidville-muted transition-colors">
                            <Settings size={16} />
                        </Link>
                        <button onClick={onClose} className="text-kidville-muted hover:text-kidville-ink">
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {/* Alunno */}
                <div className="mb-4">
                    <label className="text-xs font-bold text-kidville-green mb-1 block">Alunno</label>
                    <select
                        value={selectedStudent}
                        onChange={e => setSelectedStudent(e.target.value)}
                        disabled={bulkMode}
                        className="w-full border-2 border-kidville-line rounded-xl p-2.5 text-sm focus:border-kidville-green outline-none disabled:opacity-50"
                    >
                        <option value="">Seleziona...</option>
                        {students.map(s => (
                            <option key={s.id} value={s.id}>{s.nome} {s.cognome}</option>
                        ))}
                    </select>
                    {onConfirmBulk && (
                        <label className="mt-2 flex items-center gap-2 text-xs font-semibold text-kidville-green cursor-pointer">
                            <input type="checkbox" checked={tuttaLaSezione} onChange={e => setTuttaLaSezione(e.target.checked)} />
                            Assegna a tutta la sezione ({students.length} alunni)
                        </label>
                    )}
                </div>

                {/* Materiale */}
                <div className="mb-4">
                    <label className="text-xs font-bold text-kidville-green mb-2 block">Materiale</label>
                    <div className="grid grid-cols-2 gap-2">
                        {materiali.map(m => (
                            <button
                                key={m.nome}
                                onClick={() => setSelectedMateriale(m.nome)}
                                className={`p-3 rounded-xl border-2 text-sm font-bold transition-all
                                    ${selectedMateriale === m.nome
                                        ? 'border-kidville-green bg-kidville-green/5 text-kidville-green'
                                        : 'border-kidville-line text-kidville-ink hover:border-kidville-line'}`}
                            >
                                <span className="text-lg mr-1">{m.icona}</span> {m.nome}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Quantità */}
                <div className="mb-5">
                    <label htmlFor="locker-quantita" className="text-xs font-bold text-kidville-green mb-1 block text-center">Quantità da caricare</label>
                    <div className="flex items-center justify-center gap-4">
                        <button
                            type="button"
                            aria-label="Diminuisci quantità"
                            onClick={() => setQuantity(q => Math.max(1, q - 1))}
                            className="w-11 h-11 rounded-xl border-2 border-kidville-line flex items-center justify-center hover:border-kidville-green active:scale-95 transition-all"
                        >
                            <Minus size={16} />
                        </button>
                        {/* Input digitabile: min 1, valori non validi (vuoto/<1) clampati a 1.
                            font-size inline ≥16px = dimensione deliberata (no auto-zoom iOS e
                            indipendente dalla regola globale font-size: max(16px, 1em)). */}
                        <input
                            id="locker-quantita"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={quantity}
                            onChange={e => {
                                const n = parseInt(e.target.value, 10);
                                setQuantity(Number.isNaN(n) ? 1 : Math.max(1, n));
                            }}
                            style={{ fontSize: '28px' }}
                            className="w-20 py-1 text-center font-black text-kidville-green border-2 border-kidville-line rounded-xl outline-none focus:border-kidville-green [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <button
                            type="button"
                            aria-label="Aumenta quantità"
                            onClick={() => setQuantity(q => q + 1)}
                            className="w-11 h-11 rounded-xl border-2 border-kidville-line flex items-center justify-center hover:border-kidville-green active:scale-95 transition-all"
                        >
                            <Plus size={16} />
                        </button>
                    </div>
                </div>

                {/* Errore */}
                {error && (
                    <p className="text-kidville-error text-xs text-center mb-3 bg-kidville-error-soft rounded-xl py-2">
                        ❌ {error}
                    </p>
                )}

                {/* Conferma */}
                <button
                    onClick={handleConfirm}
                    disabled={isSaving}
                    className="w-full bg-kidville-green text-kidville-yellow py-3.5 rounded-2xl font-black uppercase tracking-widest shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50"
                >
                    {isSaving ? 'Salvataggio...' : '✓ Conferma Carico'}
                </button>
            </div>
        </>
    );
}
