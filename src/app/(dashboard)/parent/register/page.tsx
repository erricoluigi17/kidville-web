'use client';

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Award, AlertTriangle, CheckCircle, FileText, RefreshCw } from 'lucide-react';

// ID alunno collegato al genitore loggato
// TODO: in produzione recuperare da sessione/JWT
const ALUNNO_ID_PLACEHOLDER = 'parent-child-id'; // Viene gestito dalla GET alunni
const CLASSE_SEZIONE = '3A';

interface LezioneEntry {
    id: string;
    ora_lezione: number;
    materia: string | null;
    argomento: string | null;
    compiti: string | null;
    data_consegna_compiti: string | null;
}

interface Valutazione {
    id: string;
    materia: string;
    tipo: string;
    voto_numerico: number | null;
    giudizio_testo: string | null;
    creato_il: string;
}

interface Nota {
    id: string;
    categoria: string;
    testo: string;
    richiede_firma: boolean;
    firmata_il: string | null;
    creato_il: string;
}

const CATEGORIA_LABELS: Record<string, string> = {
    disciplinare: 'Nota Disciplinare',
    didattica: 'Nota Didattica',
    compiti_non_svolti: 'Compiti Non Svolti',
};

export default function ParentRegisterPage() {
    const oggi = new Date().toISOString().split('T')[0];

    const [lezioni, setLezioni] = useState<LezioneEntry[]>([]);
    const [valutazioni, setValutazioni] = useState<Valutazione[]>([]);
    const [note, setNote] = useState<Nota[]>([]);
    const [loading, setLoading] = useState(true);
    const [alunnoId, setAlunnoId] = useState<string | null>(null);
    const [signingNoteId, setSigningNoteId] = useState<string | null>(null);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            // 1. Carica alunni della classe per trovare l'alunno del genitore
            //    In produzione questo sarà filtrato per genitore loggato
            const alunniRes = await fetch(`/api/diary/students?classeSezione=${CLASSE_SEZIONE}`);
            const alunniJson = await alunniRes.json();
            let targetAlunnoId: string | null = null;
            if (alunniJson.success && alunniJson.data && alunniJson.data.length > 0) {
                // Per il test usiamo il primo alunno della classe
                targetAlunnoId = alunniJson.data[0].id;
                setAlunnoId(targetAlunnoId);
            }

            // 2. Lezioni di oggi
            const lezioniRes = await fetch(`/api/register/lessons?classeSezione=${CLASSE_SEZIONE}&data=${oggi}`);
            const lezioniJson = await lezioniRes.json();
            if (lezioniJson.success && lezioniJson.data) {
                setLezioni(lezioniJson.data.filter((l: LezioneEntry) => l.materia));
            }

            // 3. Valutazioni dell'alunno
            if (targetAlunnoId) {
                const gradesRes = await fetch(`/api/grades?alunnoId=${targetAlunnoId}`);
                const gradesJson = await gradesRes.json();
                if (gradesJson.success && gradesJson.data) {
                    setValutazioni(gradesJson.data);
                }

                // 4. Note dell'alunno
                const noteRes = await fetch(`/api/notes?alunnoId=${targetAlunnoId}`);
                const noteJson = await noteRes.json();
                if (noteJson.success && noteJson.data) {
                    setNote(noteJson.data);
                }
            }
        } catch (err) {
            console.error('Errore caricamento dashboard genitore:', err);
        } finally {
            setLoading(false);
        }
    }, [oggi]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const handleSign = async (notaId: string) => {
        setSigningNoteId(notaId);
        try {
            const res = await fetch('/api/notes/sign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notaId }),
            });
            const json = await res.json();
            if (json.success) {
                setNote(prev => prev.map(n =>
                    n.id === notaId
                        ? { ...n, firmata_il: new Date().toISOString() }
                        : n
                ));
            }
        } catch (err) {
            console.error('Errore firma nota:', err);
        } finally {
            setSigningNoteId(null);
        }
    };

    const formatVoto = (v: Valutazione) => {
        if (v.voto_numerico !== null) return v.voto_numerico.toString();
        return v.giudizio_testo || '—';
    };

    const getVotoStyle = (v: Valutazione) => {
        if (v.giudizio_testo) return 'bg-kidville-yellow text-kidville-green';
        const n = v.voto_numerico ?? 0;
        if (n >= 8) return 'bg-green-500 text-white';
        if (n >= 6) return 'bg-kidville-green text-white';
        return 'bg-kidville-error text-white';
    };

    // Note non ancora firmate e che richiedono firma
    const noteDaFirmare = note.filter(n => n.richiede_firma && !n.firmata_il);

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto p-4 sm:p-6">
                <div className="flex items-center justify-center h-48">
                    <div className="w-10 h-10 border-4 border-kidville-green border-t-transparent rounded-full animate-spin" />
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto p-4 sm:p-6 flex flex-col gap-6">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="font-barlow font-bold text-3xl text-kidville-green uppercase tracking-wide">
                        Diario e Valutazioni
                    </h1>
                    <p className="font-maven text-gray-500 mt-1">
                        Classe {CLASSE_SEZIONE} • Primaria
                    </p>
                </div>
                <button
                    onClick={loadData}
                    className="h-9 px-3 bg-kidville-cream text-kidville-green rounded-pill font-maven text-sm flex items-center gap-1.5 hover:bg-gray-200 transition-colors"
                >
                    <RefreshCw size={14} /> Aggiorna
                </button>
            </div>

            {/* Note da firmare — sezione prioritaria */}
            {noteDaFirmare.length > 0 && (
                <div>
                    {noteDaFirmare.map(nota => (
                        <div key={nota.id} className="bg-white border-2 border-kidville-error rounded-card p-5 shadow-sm mb-3">
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 rounded-full bg-red-100 text-kidville-error flex items-center justify-center flex-shrink-0">
                                    <AlertTriangle size={24} />
                                </div>
                                <div className="flex-1">
                                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-1">
                                        {CATEGORIA_LABELS[nota.categoria] || nota.categoria}
                                    </h2>
                                    <p className="font-maven text-gray-700 text-sm mb-3">&quot;{nota.testo}&quot;</p>
                                    <div className="text-xs font-maven text-gray-400 mb-4">
                                        {new Date(nota.creato_il).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })}
                                    </div>
                                    <button
                                        onClick={() => handleSign(nota.id)}
                                        disabled={signingNoteId === nota.id}
                                        className="h-12 px-6 font-barlow font-bold text-lg rounded-pill bg-kidville-yellow text-kidville-green hover:opacity-90 w-full sm:w-auto transition-opacity disabled:opacity-50"
                                    >
                                        {signingNoteId === nota.id ? 'Firma in corso...' : 'Firma per Presa Visione'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Diario Lezioni di Oggi */}
                <div className="bg-kidville-white rounded-card shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <BookOpen className="text-kidville-green" />
                        <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase">Diario di Oggi</h2>
                    </div>

                    {lezioni.length === 0 ? (
                        <p className="font-maven text-sm text-gray-400 italic py-4 text-center">
                            Nessuna lezione registrata oggi.
                        </p>
                    ) : (
                        <div className="border-l-2 border-kidville-cream ml-3 pl-4 flex flex-col gap-5">
                            {lezioni.map((lezione) => (
                                <div key={lezione.id} className="relative">
                                    <div className="absolute -left-[23px] top-1 w-3 h-3 rounded-full bg-kidville-yellow" />
                                    <h3 className="font-maven font-semibold text-kidville-green">
                                        {lezione.ora_lezione}ª ora — {lezione.materia}
                                    </h3>
                                    {lezione.argomento && (
                                        <p className="font-maven text-sm text-gray-600 mt-1">{lezione.argomento}</p>
                                    )}
                                    {lezione.compiti && (
                                        <div className="mt-2 bg-yellow-50 p-3 rounded-xl border border-yellow-100">
                                            <strong className="font-maven text-sm text-kidville-green block mb-1">
                                                📋 Compiti
                                                {lezione.data_consegna_compiti && (
                                                    <span className="text-gray-400 font-normal ml-2">
                                                        (entro {new Date(lezione.data_consegna_compiti).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })})
                                                    </span>
                                                )}
                                            </strong>
                                            <span className="font-maven text-sm text-gray-700">{lezione.compiti}</span>
                                        </div>
                                    )}
                                    {!lezione.argomento && !lezione.compiti && (
                                        <button className="mt-2 text-sm font-maven text-kidville-green underline flex items-center gap-1">
                                            <FileText size={14} /> Vedi dettagli
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Valutazioni Recenti */}
                <div className="bg-kidville-white rounded-card shadow-sm p-5">
                    <div className="flex items-center gap-2 mb-4">
                        <Award className="text-kidville-green" />
                        <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase">Voti Recenti</h2>
                    </div>

                    {valutazioni.length === 0 ? (
                        <p className="font-maven text-sm text-gray-400 italic py-4 text-center">
                            Nessuna valutazione disponibile.
                        </p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {valutazioni.slice(0, 8).map(v => (
                                <div key={v.id} className="flex justify-between items-center p-3 hover:bg-gray-50 rounded-xl border border-gray-50 transition-colors">
                                    <div>
                                        <div className="font-maven font-semibold text-kidville-green">
                                            {v.materia} — <span className="font-normal capitalize text-gray-500 text-sm">{v.tipo}</span>
                                        </div>
                                        <div className="text-xs text-gray-400 font-maven mt-0.5">
                                            {new Date(v.creato_il).toLocaleDateString('it-IT', { day: '2-digit', month: 'long' })}
                                        </div>
                                    </div>
                                    <div className={`min-w-[40px] h-10 px-3 rounded-xl flex items-center justify-center font-maven font-bold text-sm ${getVotoStyle(v)}`}>
                                        {formatVoto(v)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Note firmate (storico) */}
            {note.filter(n => n.firmata_il).length > 0 && (
                <div className="bg-kidville-white rounded-card shadow-sm p-5">
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-4">Note Archiviate</h2>
                    <div className="flex flex-col gap-2">
                        {note.filter(n => n.firmata_il).map(n => (
                            <div key={n.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                                <CheckCircle size={16} className="text-kidville-success mt-0.5 flex-shrink-0" />
                                <div>
                                    <p className="font-maven text-sm font-semibold text-gray-700">
                                        {CATEGORIA_LABELS[n.categoria] || n.categoria}
                                    </p>
                                    <p className="font-maven text-sm text-gray-500">{n.testo}</p>
                                    <p className="text-xs text-gray-400 mt-1">
                                        Firmata il {new Date(n.firmata_il!).toLocaleDateString('it-IT')}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
