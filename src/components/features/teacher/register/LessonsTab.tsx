'use client';

import { useState, useEffect, useCallback } from 'react';
import { PenTool, Upload, CheckCircle, X, BookOpen, ClipboardList } from 'lucide-react';

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8];

const MATERIE = [
    'Italiano',
    'Matematica',
    'Storia',
    'Geografia',
    'Scienze',
    'Inglese',
    'Arte e Immagine',
    'Musica',
    'Educazione Fisica',
    'Tecnologia',
    'Religione',
];

const CLASSE_SEZIONE = '3A'; // TODO: prendere dal contesto utente

interface RegistroEntry {
    id: string;
    ora_lezione: number;
    materia: string | null;
    argomento: string | null;
    compiti: string | null;
    data_consegna_compiti: string | null;
    firme_docenti?: { id: string }[];
}

type Step = 'materia' | 'contenuto';

export default function LessonsTab() {
    const [oggi] = useState(() => new Date().toISOString().split('T')[0]);
    const [registroEntries, setRegistroEntries] = useState<Record<number, RegistroEntry>>({});
    const [loading, setLoading] = useState(true);

    // Modal state
    const [modalHour, setModalHour] = useState<number | null>(null);
    const [step, setStep] = useState<Step>('materia');
    const [selectedMateria, setSelectedMateria] = useState('');
    const [argomento, setArgomento] = useState('');
    const [compiti, setCompiti] = useState('');
    const [dataConsegna, setDataConsegna] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');

    // Carica le firme del giorno
    const loadRegistro = useCallback(async () => {
        try {
            const res = await fetch(`/api/register/lessons?classeSezione=${CLASSE_SEZIONE}&data=${oggi}`);
            const json = await res.json();
            if (json.success && json.data) {
                const byHour: Record<number, RegistroEntry> = {};
                json.data.forEach((entry: RegistroEntry) => {
                    byHour[entry.ora_lezione] = entry;
                });
                setRegistroEntries(byHour);
            }
        } catch (err) {
            console.error('Errore caricamento registro:', err);
        } finally {
            setLoading(false);
        }
    }, [oggi]);

    useEffect(() => {
        loadRegistro();
    }, [loadRegistro]);

    const openModal = (hour: number) => {
        const existing = registroEntries[hour];
        setModalHour(hour);
        if (existing) {
            // Modifica: pre-popola con i dati esistenti
            setSelectedMateria(existing.materia || '');
            setArgomento(existing.argomento || '');
            setCompiti(existing.compiti || '');
            setDataConsegna(existing.data_consegna_compiti || '');
            setStep('contenuto');
        } else {
            setSelectedMateria('');
            setArgomento('');
            setCompiti('');
            setDataConsegna('');
            setStep('materia');
        }
        setSaveError('');
    };

    const closeModal = () => {
        setModalHour(null);
        setSaveError('');
    };

    const handleConfirmMateria = () => {
        if (!selectedMateria) return;
        setStep('contenuto');
    };

    const handleSave = async () => {
        if (!modalHour || !selectedMateria) return;
        setSaving(true);
        setSaveError('');

        try {
            const res = await fetch('/api/register/lessons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    classeSezione: CLASSE_SEZIONE,
                    data: oggi,
                    oraLezione: modalHour,
                    materia: selectedMateria,
                    argomento: argomento || null,
                    compiti: compiti || null,
                    dataConsegnaCompiti: dataConsegna || null,
                }),
            });

            const json = await res.json();
            if (!res.ok || !json.success) {
                setSaveError(json.error || 'Errore nel salvataggio');
                return;
            }

            // Aggiorna stato locale
            setRegistroEntries(prev => ({
                ...prev,
                [modalHour]: {
                    ...json.data,
                    firme_docenti: [{ id: 'local' }],
                },
            }));
            closeModal();
        } catch (err) {
            console.error('Errore salvataggio lezione:', err);
            setSaveError('Errore di rete. Riprova.');
        } finally {
            setSaving(false);
        }
    };

    const isSigned = (hour: number) => {
        const entry = registroEntries[hour];
        return !!(entry && entry.firme_docenti && entry.firme_docenti.length > 0);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-32">
                <div className="w-8 h-8 border-4 border-kidville-green border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <>
            <div>
                <h2 className="font-barlow font-bold text-2xl text-kidville-green mb-1">Orario e Firme</h2>
                <p className="font-maven text-sm text-gray-400 mb-4">
                    {new Date(oggi).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
                <div className="flex flex-col gap-3">
                    {HOURS.map((hour) => {
                        const signed = isSigned(hour);
                        const entry = registroEntries[hour];
                        return (
                            <div
                                key={hour}
                                className="border border-gray-100 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 hover:shadow-sm transition-shadow"
                            >
                                <div className="w-12 h-12 bg-kidville-cream text-kidville-green rounded-full flex items-center justify-center font-barlow font-bold text-xl flex-shrink-0">
                                    {hour}°
                                </div>

                                <div className="flex-1">
                                    {signed && entry ? (
                                        <div>
                                            <div className="font-maven font-semibold text-kidville-green">{entry.materia}</div>
                                            {entry.argomento && (
                                                <div className="text-sm text-gray-600 font-maven mt-1 flex items-start gap-1">
                                                    <BookOpen size={13} className="mt-0.5 flex-shrink-0 text-gray-400" />
                                                    <span><strong>Argomento:</strong> {entry.argomento}</span>
                                                </div>
                                            )}
                                            {entry.compiti && (
                                                <div className="mt-1 bg-yellow-50 border border-yellow-100 rounded-lg px-3 py-1.5">
                                                    <div className="flex items-center gap-1">
                                                        <ClipboardList size={13} className="text-yellow-600 flex-shrink-0" />
                                                        <span className="text-sm font-maven text-gray-700">
                                                            <strong>Compiti:</strong> {entry.compiti}
                                                        </span>
                                                    </div>
                                                    {entry.data_consegna_compiti && (
                                                        <p className="text-xs text-yellow-600 font-maven mt-0.5 ml-4">
                                                            Consegna: {new Date(entry.data_consegna_compiti).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="text-gray-400 italic text-sm">Nessuna firma registrata per quest&apos;ora.</div>
                                    )}
                                </div>

                                <div className="flex gap-2 flex-shrink-0">
                                    {!signed ? (
                                        <button
                                            onClick={() => openModal(hour)}
                                            className="h-10 px-4 font-maven font-medium rounded-pill bg-kidville-green text-kidville-yellow flex items-center gap-2 hover:opacity-90"
                                        >
                                            <PenTool size={16} /> Firma
                                        </button>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => openModal(hour)}
                                                className="h-10 px-3 font-maven rounded-pill bg-kidville-cream text-kidville-green flex items-center gap-2 hover:bg-gray-200 text-sm"
                                            >
                                                Modifica
                                            </button>
                                            <button className="h-10 px-3 font-maven rounded-pill bg-kidville-cream text-kidville-green flex items-center gap-2 hover:bg-gray-200">
                                                <Upload size={16} /> Allegato
                                            </button>
                                            <span className="flex items-center gap-1 text-kidville-success text-sm font-semibold">
                                                <CheckCircle size={16} /> Firmato
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* MODAL */}
            {modalHour !== null && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                        {/* Header */}
                        <div className="bg-kidville-green p-5 flex items-center justify-between">
                            <div>
                                <h3 className="font-barlow font-bold text-xl text-kidville-yellow">
                                    {step === 'materia' ? 'Seleziona Materia' : 'Dettaglio Lezione'}
                                </h3>
                                <p className="font-maven text-white/70 text-sm mt-0.5">{modalHour}ª Ora</p>
                            </div>
                            <button onClick={closeModal} className="text-white/70 hover:text-white transition-colors">
                                <X size={22} />
                            </button>
                        </div>

                        <div className="p-5">
                            {/* STEP 1: Selezione Materia */}
                            {step === 'materia' && (
                                <div className="flex flex-col gap-4">
                                    <p className="font-maven text-gray-500 text-sm">
                                        Seleziona la materia insegnata in questa ora per procedere con la firma.
                                    </p>
                                    <div className="grid grid-cols-2 gap-2">
                                        {MATERIE.map((m) => (
                                            <button
                                                key={m}
                                                onClick={() => setSelectedMateria(m)}
                                                className={`py-2.5 px-3 rounded-xl font-maven text-sm font-medium text-left transition-all border ${
                                                    selectedMateria === m
                                                        ? 'bg-kidville-green text-white border-kidville-green'
                                                        : 'bg-white text-gray-700 border-gray-200 hover:border-kidville-green hover:text-kidville-green'
                                                }`}
                                            >
                                                {m}
                                            </button>
                                        ))}
                                    </div>
                                    <button
                                        onClick={handleConfirmMateria}
                                        disabled={!selectedMateria}
                                        className="h-12 w-full font-barlow font-bold text-lg rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90 disabled:opacity-40 transition-all mt-2"
                                    >
                                        Continua →
                                    </button>
                                </div>
                            )}

                            {/* STEP 2: Argomento + Compiti */}
                            {step === 'contenuto' && (
                                <div className="flex flex-col gap-4">
                                    <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                                        <span className="font-maven font-semibold text-kidville-green">{selectedMateria}</span>
                                        {registroEntries[modalHour] ? null : (
                                            <button
                                                onClick={() => setStep('materia')}
                                                className="ml-auto text-xs text-gray-400 underline"
                                            >
                                                Cambia
                                            </button>
                                        )}
                                    </div>

                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">
                                            <BookOpen size={14} className="inline mr-1 text-gray-400" />
                                            Argomento svolto in classe
                                        </label>
                                        <textarea
                                            value={argomento}
                                            onChange={(e) => setArgomento(e.target.value)}
                                            rows={3}
                                            placeholder="Es. Introduzione a I Promessi Sposi, Cap. 1..."
                                            className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm resize-none focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                        />
                                    </div>

                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">
                                            <ClipboardList size={14} className="inline mr-1 text-gray-400" />
                                            Compiti per casa
                                        </label>
                                        <textarea
                                            value={compiti}
                                            onChange={(e) => setCompiti(e.target.value)}
                                            rows={2}
                                            placeholder="Es. Leggere pag. 12-15 e fare il riassunto..."
                                            className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm resize-none focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                        />
                                    </div>

                                    {compiti && (
                                        <div>
                                            <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">
                                                📅 Data di consegna compiti
                                            </label>
                                            <input
                                                type="date"
                                                value={dataConsegna}
                                                min={oggi}
                                                onChange={(e) => setDataConsegna(e.target.value)}
                                                className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                            />
                                        </div>
                                    )}

                                    {saveError && (
                                        <p className="text-sm text-red-500 font-maven bg-red-50 p-3 rounded-xl">{saveError}</p>
                                    )}

                                    <button
                                        onClick={handleSave}
                                        disabled={saving}
                                        className="h-12 w-full font-barlow font-bold text-lg rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                                    >
                                        {saving ? (
                                            <>
                                                <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                                                Salvataggio...
                                            </>
                                        ) : (
                                            <>
                                                <PenTool size={18} /> Salva e Firma
                                            </>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
