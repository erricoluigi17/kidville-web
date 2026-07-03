'use client';

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';

const CLASSE_SEZIONE = '3A'; // TODO: dal contesto utente

interface Alunno {
    id: string;
    nome: string;
    cognome: string;
}

interface Nota {
    id: string;
    alunno_id: string;
    categoria: string;
    testo: string;
    richiede_firma: boolean;
    firmata_il: string | null;
    creato_il: string;
    alunni?: { nome: string; cognome: string; classe_sezione: string } | null;
}

const CATEGORIA_LABELS: Record<string, { label: string; color: string }> = {
    disciplinare: { label: 'Disciplinare', color: 'bg-kidville-error-soft text-kidville-error border-kidville-error/25' },
    didattica: { label: 'Didattica', color: 'bg-kidville-info-soft text-kidville-info border-kidville-info/30' },
    compiti_non_svolti: { label: 'Compiti non svolti', color: 'bg-kidville-warn-soft text-orange-700 border-kidville-warn/30' },
};

export default function NotesTab() {
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [note, setNote] = useState<Nota[]>([]);
    const [loading, setLoading] = useState(true);

    // Form state
    const [selectedStudents, setSelectedStudents] = useState<string[]>([]);
    const [categoria, setCategoria] = useState('disciplinare');
    const [testo, setTesto] = useState('');
    const [richiedeFirma, setRichiedeFirma] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [saveSuccess, setSaveSuccess] = useState(false);

    const loadData = useCallback(async () => {
        try {
            // Carica alunni della classe
            const alunniRes = await fetch(`/api/diary/students?classeSezione=${CLASSE_SEZIONE}&onlyPresent=true`);
            const alunniJson = await alunniRes.json();
            if (alunniJson.success && alunniJson.data) {
                setAlunni(alunniJson.data);
            }

            // Carica note esistenti
            const noteRes = await fetch('/api/notes');
            const noteJson = await noteRes.json();
            if (noteJson.success && noteJson.data) {
                setNote(noteJson.data);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // Errori di rete ingoiati al call-site (pattern set-state-in-effect).
        loadData().catch(() => {});
    }, [loadData]);

    const toggleStudent = (id: string) => {
        setSelectedStudents(prev =>
            prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
        );
    };

    const selectAll = () => {
        if (selectedStudents.length === alunni.length) {
            setSelectedStudents([]);
        } else {
            setSelectedStudents(alunni.map(a => a.id));
        }
    };

    const handleSubmit = async () => {
        if (selectedStudents.length === 0 || !testo.trim()) {
            setSaveError('Seleziona almeno un alunno e inserisci il testo della nota');
            return;
        }

        setSaving(true);
        setSaveError('');
        setSaveSuccess(false);

        try {
            const res = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alunnoIds: selectedStudents,
                    categoria,
                    testo: testo.trim(),
                    richiedeFirma,
                }),
            });

            const json = await res.json();
            if (!res.ok || !json.success) {
                setSaveError(json.error || 'Errore nel salvataggio');
                return;
            }

            // Aggiorna lista locale
            if (json.data) {
                setNote(prev => [...json.data, ...prev]);
            }

            setSaveSuccess(true);
            setSelectedStudents([]);
            setTesto('');
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (err) {
            console.error('Errore salvataggio nota:', err);
            setSaveError('Errore di rete. Riprova.');
        } finally {
            setSaving(false);
        }
    };

    const getAlunnoName = (id: string) => {
        const a = alunni.find(a => a.id === id);
        return a ? `${a.cognome} ${a.nome}` : '—';
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-32">
                <div className="w-8 h-8 border-4 border-kidville-green border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div>
            <h2 className="font-barlow font-bold text-2xl text-kidville-green mb-4">Note Disciplinari e Didattiche</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Selezione Alunni */}
                <div className="border border-kidville-line rounded-xl p-4">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="font-maven font-semibold text-kidville-ink">Seleziona Alunni</h3>
                        <button onClick={selectAll} className="text-sm text-kidville-green underline font-maven">
                            {selectedStudents.length === alunni.length ? 'Deseleziona Tutti' : 'Seleziona Tutti'}
                        </button>
                    </div>
                    <div className="flex flex-col gap-1.5 max-h-[280px] overflow-y-auto">
                        {alunni.map(student => (
                            <label
                                key={student.id}
                                className={`flex items-center gap-3 p-2.5 rounded-xl cursor-pointer transition-colors ${
                                    selectedStudents.includes(student.id)
                                        ? 'bg-kidville-cream border border-kidville-green/30'
                                        : 'hover:bg-kidville-cream border border-transparent'
                                }`}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedStudents.includes(student.id)}
                                    onChange={() => toggleStudent(student.id)}
                                    className="w-5 h-5 accent-kidville-green"
                                />
                                <span className="font-maven text-sm">{student.cognome} {student.nome}</span>
                            </label>
                        ))}
                        {alunni.length === 0 && (
                            <p className="text-sm text-kidville-muted font-maven text-center py-4">Nessun alunno trovato</p>
                        )}
                    </div>
                </div>

                {/* Form Inserimento */}
                <div className="flex flex-col gap-4">
                    <div>
                        <label className="block font-maven text-sm font-semibold text-kidville-ink mb-1.5">Categoria Nota</label>
                        <div className="flex flex-col gap-2">
                            {Object.entries(CATEGORIA_LABELS).map(([val, { label, color }]) => (
                                <button
                                    key={val}
                                    onClick={() => setCategoria(val)}
                                    className={`py-2 px-3 rounded-xl font-maven text-sm font-medium text-left border transition-all ${
                                        categoria === val
                                            ? color + ' font-semibold'
                                            : 'bg-white text-kidville-ink border-kidville-line hover:bg-kidville-cream'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block font-maven text-sm font-semibold text-kidville-ink mb-1.5">Testo della nota</label>
                        <textarea
                            value={testo}
                            onChange={(e) => setTesto(e.target.value)}
                            className="w-full border border-kidville-line p-3 rounded-xl font-maven text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                            placeholder="Descrivi l'accaduto..."
                        />
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={richiedeFirma}
                            onChange={(e) => setRichiedeFirma(e.target.checked)}
                            className="w-4 h-4 accent-kidville-green"
                        />
                        <span className="font-maven text-sm text-kidville-ink">Richiedi Firma per Presa Visione</span>
                    </label>

                    {saveError && (
                        <p className="text-sm text-kidville-error font-maven bg-kidville-error-soft p-3 rounded-xl">{saveError}</p>
                    )}

                    {saveSuccess && (
                        <div className="flex items-center gap-2 bg-kidville-success-soft border border-green-200 text-kidville-success p-3 rounded-xl font-maven text-sm">
                            <CheckCircle size={16} /> Note salvate con successo!
                        </div>
                    )}

                    <button
                        onClick={handleSubmit}
                        disabled={selectedStudents.length === 0 || !testo.trim() || saving}
                        className="h-12 w-full font-barlow font-bold text-xl rounded-pill bg-kidville-error text-white hover:bg-red-700 disabled:opacity-50 transition-colors mt-auto flex items-center justify-center gap-2"
                    >
                        {saving ? (
                            <><div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Salvataggio...</>
                        ) : (
                            <><AlertCircle size={18} /> Assegna Nota ({selectedStudents.length})</>
                        )}
                    </button>
                </div>
            </div>

            {/* Storico Note */}
            {note.length > 0 && (
                <div className="mt-6 border-t border-kidville-line pt-6">
                    <h3 className="font-barlow font-bold text-lg text-kidville-green mb-3">Note Recenti</h3>
                    <div className="flex flex-col gap-2">
                        {note.slice(0, 10).map(n => {
                            const cat = CATEGORIA_LABELS[n.categoria] || { label: n.categoria, color: 'bg-kidville-cream text-kidville-ink border-kidville-line' };
                            return (
                                <div key={n.id} className="border border-kidville-line rounded-xl p-3 flex items-start gap-3">
                                    <span className={`text-xs px-2 py-1 rounded-full border font-maven font-semibold flex-shrink-0 mt-0.5 ${cat.color}`}>
                                        {cat.label}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-maven text-sm font-semibold text-kidville-ink">
                                            {n.alunni ? `${n.alunni.cognome} ${n.alunni.nome}` : getAlunnoName(n.alunno_id)}
                                        </p>
                                        <p className="font-maven text-sm text-kidville-muted truncate">{n.testo}</p>
                                    </div>
                                    <div className="flex-shrink-0 flex items-center gap-1">
                                        {n.firmata_il ? (
                                            <span className="text-xs text-kidville-success font-maven flex items-center gap-1">
                                                <CheckCircle size={12} /> Firmata
                                            </span>
                                        ) : n.richiede_firma ? (
                                            <span className="text-xs text-kidville-warn font-maven">In attesa</span>
                                        ) : null}
                                        <span className="text-xs text-kidville-muted font-maven ml-2">
                                            {new Date(n.creato_il).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
