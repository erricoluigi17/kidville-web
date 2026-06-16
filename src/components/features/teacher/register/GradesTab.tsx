'use client';

// ⛔ DEPRECATO — Tab voti "legacy" (voti numerici 1-10 + scala Base/Intermedio/Avanzato),
// NON conforme O.M. 3/2025. Non più referenziato (la pagina /teacher/register reindirizza
// a /teacher/primaria). Conservato come storico; la valutazione conforme vive in
// /teacher/primaria/[sectionId]/valutazioni (giudizi sintetici Allegato A). NON usare in nuove UI.

import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Award } from 'lucide-react';

const CLASSE_SEZIONE = '3A'; // TODO: dal contesto utente

const MATERIE = [
    'Italiano', 'Matematica', 'Storia', 'Geografia', 'Scienze',
    'Inglese', 'Arte e Immagine', 'Musica', 'Educazione Fisica', 'Tecnologia', 'Religione',
];

const TIPI = [
    { value: 'scritto', label: 'Scritto' },
    { value: 'orale', label: 'Orale' },
    { value: 'pratico', label: 'Pratico' },
];

const GIUDIZI = ['Base', 'Intermedio', 'Avanzato'];

interface Alunno {
    id: string;
    nome: string;
    cognome: string;
}

interface Valutazione {
    id: string;
    alunno_id: string;
    materia: string;
    tipo: string;
    voto_numerico: number | null;
    giudizio_testo: string | null;
    creato_il: string;
    alunni?: { nome: string; cognome: string } | null;
}

type ModoVoto = 'numerico' | 'giudizio';

export default function GradesTab() {
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [valutazioni, setValutazioni] = useState<Valutazione[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);

    // Form state
    const [selectedAlunnoId, setSelectedAlunnoId] = useState('');
    const [selectedMateria, setSelectedMateria] = useState('');
    const [selectedTipo, setSelectedTipo] = useState('scritto');
    const [modoVoto, setModoVoto] = useState<ModoVoto>('numerico');
    const [votoNumerico, setVotoNumerico] = useState('');
    const [giudizioTesto, setGiudizioTesto] = useState('');
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

            // Carica valutazioni esistenti
            const gradesRes = await fetch('/api/grades');
            const gradesJson = await gradesRes.json();
            if (gradesJson.success && gradesJson.data) {
                setValutazioni(gradesJson.data);
            }
        } catch (err) {
            console.error('Errore caricamento dati GradesTab:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const openModal = () => {
        setSelectedAlunnoId('');
        setSelectedMateria('');
        setSelectedTipo('scritto');
        setModoVoto('numerico');
        setVotoNumerico('');
        setGiudizioTesto('');
        setSaveError('');
        setSaveSuccess(false);
        setShowModal(true);
    };

    const handleSave = async () => {
        if (!selectedAlunnoId || !selectedMateria) {
            setSaveError('Seleziona alunno e materia');
            return;
        }
        if (modoVoto === 'numerico' && !votoNumerico) {
            setSaveError('Inserisci il voto');
            return;
        }
        if (modoVoto === 'giudizio' && !giudizioTesto) {
            setSaveError('Seleziona un giudizio');
            return;
        }

        setSaving(true);
        setSaveError('');

        try {
            const res = await fetch('/api/grades', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alunnoId: selectedAlunnoId,
                    materia: selectedMateria,
                    tipo: selectedTipo,
                    votoNumerico: modoVoto === 'numerico' ? parseFloat(votoNumerico) : null,
                    giudizioTesto: modoVoto === 'giudizio' ? giudizioTesto : null,
                }),
            });

            const json = await res.json();
            if (!res.ok || !json.success) {
                setSaveError(json.error || 'Errore nel salvataggio');
                return;
            }

            setSaveSuccess(true);
            // Aggiorna lista locale
            setValutazioni(prev => [json.data, ...prev]);
            setTimeout(() => setShowModal(false), 1200);
        } catch (err) {
            console.error('Errore salvataggio voto:', err);
            setSaveError('Errore di rete. Riprova.');
        } finally {
            setSaving(false);
        }
    };

    const getAlunnoName = (id: string) => {
        const a = alunni.find(a => a.id === id);
        return a ? `${a.cognome} ${a.nome}` : id;
    };

    const formatVoto = (v: Valutazione) => {
        if (v.voto_numerico !== null) return v.voto_numerico.toString();
        return v.giudizio_testo || '—';
    };

    const getVotoStyle = (v: Valutazione) => {
        if (v.giudizio_testo) {
            return 'bg-kidville-yellow text-kidville-green';
        }
        const n = v.voto_numerico ?? 0;
        if (n >= 8) return 'bg-kidville-success text-white';
        if (n >= 6) return 'bg-kidville-green text-white';
        return 'bg-kidville-error text-white';
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
                <div className="flex justify-between items-center mb-4">
                    <h2 className="font-barlow font-bold text-2xl text-kidville-green">Valutazioni</h2>
                    <button
                        onClick={openModal}
                        className="h-10 px-4 font-maven font-medium rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90 flex items-center gap-1.5"
                    >
                        <Plus size={16} /> Aggiungi Voto
                    </button>
                </div>

                {valutazioni.length === 0 ? (
                    <div className="text-center py-12 text-gray-400 font-maven">
                        <Award size={32} className="mx-auto mb-2 opacity-30" />
                        <p>Nessuna valutazione registrata.</p>
                        <p className="text-sm mt-1">Usa il pulsante &quot;Aggiungi Voto&quot; per inserire la prima.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b-2 border-gray-100">
                                    <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Alunno</th>
                                    <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Materia</th>
                                    <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Tipo</th>
                                    <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Voto</th>
                                    <th className="py-3 px-2 font-barlow text-kidville-green text-lg">Data</th>
                                </tr>
                            </thead>
                            <tbody>
                                {valutazioni.map(v => (
                                    <tr key={v.id} className="border-b border-gray-50 hover:bg-kidville-cream/30 transition-colors">
                                        <td className="py-3 px-2 font-maven font-semibold text-gray-800">
                                            {v.alunni ? `${v.alunni.cognome} ${v.alunni.nome}` : getAlunnoName(v.alunno_id)}
                                        </td>
                                        <td className="py-3 px-2 font-maven text-gray-600">{v.materia}</td>
                                        <td className="py-3 px-2 font-maven text-gray-500 capitalize">{v.tipo}</td>
                                        <td className="py-3 px-2">
                                            <span className={`inline-flex items-center justify-center min-w-[36px] h-8 px-2 rounded-lg font-maven font-bold text-sm ${getVotoStyle(v)}`}>
                                                {formatVoto(v)}
                                            </span>
                                        </td>
                                        <td className="py-3 px-2 font-maven text-gray-400 text-sm">
                                            {new Date(v.creato_il).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <p className="text-xs text-gray-500 mt-6 bg-yellow-50 p-3 rounded-xl border border-yellow-100">
                    <strong>Nota:</strong> I voti inseriti diventano visibili ai genitori dopo 10 minuti (Buffer Notifica), permettendo eventuali correzioni.
                </p>
            </div>

            {/* MODAL INSERIMENTO VOTO */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-kidville-green/30 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                        <div className="bg-kidville-green p-5 flex items-center justify-between">
                            <div>
                                <h3 className="font-barlow font-bold text-xl text-kidville-yellow">Inserisci Valutazione</h3>
                                <p className="font-maven text-white/70 text-sm mt-0.5">Classe {CLASSE_SEZIONE} • Primaria</p>
                            </div>
                            <button onClick={() => setShowModal(false)} className="text-white/70 hover:text-white">
                                <X size={22} />
                            </button>
                        </div>

                        <div className="p-5 flex flex-col gap-4">
                            {saveSuccess ? (
                                <div className="text-center py-6">
                                    <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <Award size={30} className="text-kidville-success" />
                                    </div>
                                    <p className="font-barlow font-bold text-xl text-kidville-green">Voto salvato!</p>
                                    <p className="font-maven text-gray-500 text-sm mt-1">Visibile al genitore dopo 10 minuti.</p>
                                </div>
                            ) : (
                                <>
                                    {/* Alunno */}
                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">Alunno</label>
                                        <select
                                            value={selectedAlunnoId}
                                            onChange={(e) => setSelectedAlunnoId(e.target.value)}
                                            className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                        >
                                            <option value="">Seleziona alunno...</option>
                                            {alunni.map(a => (
                                                <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Materia */}
                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">Materia</label>
                                        <select
                                            value={selectedMateria}
                                            onChange={(e) => setSelectedMateria(e.target.value)}
                                            className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                        >
                                            <option value="">Seleziona materia...</option>
                                            {MATERIE.map(m => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Tipo valutazione */}
                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">Tipo</label>
                                        <div className="flex gap-2">
                                            {TIPI.map(t => (
                                                <button
                                                    key={t.value}
                                                    onClick={() => setSelectedTipo(t.value)}
                                                    className={`flex-1 py-2 px-3 rounded-xl font-maven text-sm font-medium border transition-all ${
                                                        selectedTipo === t.value
                                                            ? 'bg-kidville-green text-white border-kidville-green'
                                                            : 'bg-white text-gray-600 border-gray-200 hover:border-kidville-green'
                                                    }`}
                                                >
                                                    {t.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Modo voto */}
                                    <div>
                                        <label className="block font-maven text-sm font-semibold text-gray-700 mb-1.5">Tipo di Voto</label>
                                        <div className="flex gap-2 mb-3">
                                            <button
                                                onClick={() => setModoVoto('numerico')}
                                                className={`flex-1 py-2 rounded-xl font-maven text-sm font-medium border transition-all ${
                                                    modoVoto === 'numerico'
                                                        ? 'bg-kidville-yellow text-kidville-green border-kidville-yellow'
                                                        : 'bg-white text-gray-600 border-gray-200'
                                                }`}
                                            >
                                                Numerico (1-10)
                                            </button>
                                            <button
                                                onClick={() => setModoVoto('giudizio')}
                                                className={`flex-1 py-2 rounded-xl font-maven text-sm font-medium border transition-all ${
                                                    modoVoto === 'giudizio'
                                                        ? 'bg-kidville-yellow text-kidville-green border-kidville-yellow'
                                                        : 'bg-white text-gray-600 border-gray-200'
                                                }`}
                                            >
                                                Giudizio
                                            </button>
                                        </div>

                                        {modoVoto === 'numerico' ? (
                                            <input
                                                type="number"
                                                min="1"
                                                max="10"
                                                step="0.5"
                                                value={votoNumerico}
                                                onChange={(e) => setVotoNumerico(e.target.value)}
                                                placeholder="Es. 7.5"
                                                className="w-full border border-gray-200 rounded-xl p-3 font-maven text-sm focus:outline-none focus:ring-2 focus:ring-kidville-green/30 focus:border-kidville-green"
                                            />
                                        ) : (
                                            <div className="flex gap-2">
                                                {GIUDIZI.map(g => (
                                                    <button
                                                        key={g}
                                                        onClick={() => setGiudizioTesto(g)}
                                                        className={`flex-1 py-2 rounded-xl font-maven text-sm font-medium border transition-all ${
                                                            giudizioTesto === g
                                                                ? 'bg-kidville-green text-white border-kidville-green'
                                                                : 'bg-white text-gray-600 border-gray-200 hover:border-kidville-green'
                                                        }`}
                                                    >
                                                        {g}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {saveError && (
                                        <p className="text-sm text-red-500 font-maven bg-red-50 p-3 rounded-xl">{saveError}</p>
                                    )}

                                    <button
                                        onClick={handleSave}
                                        disabled={saving}
                                        className="h-12 w-full font-barlow font-bold text-lg rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {saving ? (
                                            <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> Salvataggio...</>
                                        ) : 'Salva Voto'}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
