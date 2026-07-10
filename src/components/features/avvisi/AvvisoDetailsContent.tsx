'use client';

import { useState, useEffect } from 'react';
import { Search, AlertCircle, Users, ThumbsUp, ThumbsDown, Eye, HelpCircle } from 'lucide-react';
import { Avviso } from './AvvisoCard';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

// Monitoraggio di un avviso (stato lettura + adesioni con filtri): contenuto
// condiviso tra il drawer mobile del docente (AvvisoDetailsDrawer) e la pagina
// cockpit /admin/avvisi/[id] (layout 'page': colonna filtri + colonna elenchi).

interface Props {
    avviso: Avviso;
    availableClasses?: string[];
    userId?: string | null;
    layout?: 'drawer' | 'page';
}

interface RispostaDettaglio {
    id: string;
    parent_id: string;
    student_id: string;
    letto_il: string | null;
    risposta: string | null;
    risposto_il: string | null;
    parent_name: string;
    student_name: string;
}

interface StudentBasic {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione: string;
}

export function AvvisoDetailsContent({ avviso, availableClasses = [], userId, layout = 'drawer' }: Props) {
    const [risposte, setRisposte] = useState<RispostaDettaglio[]>([]);
    const [targetStudents, setTargetStudents] = useState<StudentBasic[]>([]);
    const [loading, setLoading] = useState(true);

    // Elenchi separati: letture (Stato Lettura) vs risposte (Adesioni)
    const [mainTab, setMainTab] = useState<'letture' | 'adesioni'>('letture');
    const [readSubTab, setReadSubTab] = useState<'letti' | 'non_letti'>('letti');

    // Filtri
    const [selectedClass, setSelectedClass] = useState<string>('all');
    const [selectedResponse, setSelectedResponse] = useState<string>('given'); // 'given' | 'si' | 'no' | 'attesa'
    const [searchQuery, setSearchQuery] = useState('');

    // Reset stati filtri e viste al cambio avviso
    // (adjust-state-during-render, prior art: AvvisoForm.tsx / TaskForm.tsx)
    const [prevAvviso, setPrevAvviso] = useState<Avviso | null>(null);
    if (avviso !== prevAvviso) {
        setPrevAvviso(avviso);
        setLoading(true);
        setMainTab('letture');
        setReadSubTab('letti');
        setSelectedClass('all');
        setSelectedResponse('given');
        setSearchQuery('');
    }

    useEffect(() => {
        if (!avviso) return;
        const uid = userId ?? getCurrentTeacherId(null);

        const loadDetails = async () => {
            try {
                // 1. Carica le risposte/letture reali registrate nel database
                const risposteRes = await fetch(`/api/avvisi/${avviso.id}/risposte?userId=${uid}`);
                let risposteData: RispostaDettaglio[] = [];
                if (risposteRes.ok) {
                    risposteData = await risposteRes.json();
                    setRisposte(risposteData);
                }

                // 2. Determina le sezioni target
                const targetClasses = avviso.target_scope === 'globale'
                    ? availableClasses
                    : (avviso.target_classes || []);

                // 3. Carica tutti gli studenti per le sezioni target
                const studentsPromises = targetClasses.map(async (classe) => {
                    try {
                        const res = await fetch(`/api/diary/students?sezione=${encodeURIComponent(classe)}&userId=${uid}`);
                        if (res.ok) {
                            return (await res.json()) as StudentBasic[];
                        }
                    } catch (e) {
                        console.error(`Errore caricamento studenti per classe ${classe}:`, e);
                    }
                    return [];
                });

                const studentsLists = await Promise.all(studentsPromises);
                const mergedStudents = studentsLists.flat();

                // Rimuovi eventuali duplicati per sicurezza
                const uniqueStudents = mergedStudents.filter((student, index, self) =>
                    self.findIndex(s => s.id === student.id) === index
                );

                setTargetStudents(uniqueStudents);
            } catch (err) {
                console.error('Errore nel caricamento dei dettagli avviso:', err);
            } finally {
                setLoading(false);
            }
        };

        loadDetails();
    }, [avviso, availableClasses, userId]);

    const isAdesione = avviso.tipo === 'adesione';
    const isPage = layout === 'page';
    const listMaxH = isPage ? 'max-h-[58vh]' : 'max-h-[300px]';
    const listMaxHAdesioni = isPage ? 'max-h-[58vh]' : 'max-h-[350px]';

    // Sezioni/Classi target per l'avviso corrente
    const targetClasses = avviso.target_scope === 'globale'
        ? availableClasses
        : (avviso.target_classes || []);

    // Calcolo statistiche globali
    const totalTarget = targetStudents.length;
    const readMap = new Map(risposte.filter(r => r.letto_il).map(r => [r.student_id, r]));
    const readCount = targetStudents.filter(s => readMap.has(s.id)).length;
    const unreadCount = Math.max(0, totalTarget - readCount);
    const readPercentage = totalTarget > 0 ? Math.round((readCount / totalTarget) * 100) : 0;

    // Statistiche risposte per adesione
    const siCount = risposte.filter(r => r.risposta === 'si').length;
    const noCount = risposte.filter(r => r.risposta === 'no').length;
    const pendingAnswers = Math.max(0, totalTarget - (siCount + noCount));

    // Generazione liste raw
    const listLetti = targetStudents
        .filter(student => readMap.has(student.id))
        .map(student => {
            const resp = readMap.get(student.id);
            return {
                studentId: student.id,
                studentName: `${student.nome} ${student.cognome}`,
                classe: student.classe_sezione,
                parentName: resp?.parent_name || 'Genitore',
                lettoIl: resp?.letto_il ? new Date(resp.letto_il).toLocaleString('it-IT') : '-'
            };
        });

    const listNonLetti = targetStudents
        .filter(student => !readMap.has(student.id))
        .map(student => ({
            studentId: student.id,
            studentName: `${student.nome} ${student.cognome}`,
            classe: student.classe_sezione,
        }));

    const listAdesioni = targetStudents.map(student => {
        const resp = risposte.find(r => r.student_id === student.id);
        return {
            studentId: student.id,
            studentName: `${student.nome} ${student.cognome}`,
            classe: student.classe_sezione,
            parentName: resp?.parent_name || 'Genitore',
            risposta: resp?.risposta || 'attesa', // 'si' | 'no' | 'attesa'
            rispostoIl: resp?.risposto_il ? new Date(resp.risposto_il).toLocaleString('it-IT') : '-'
        };
    });

    // Ricerca testuale
    const filterQuery = (name: string) => name.toLowerCase().includes(searchQuery.toLowerCase());

    // Applicazione filtri per Stato Lettura
    const filteredLetti = listLetti.filter(item => {
        const matchClass = selectedClass === 'all' || item.classe === selectedClass;
        const matchSearch = filterQuery(item.studentName) || filterQuery(item.parentName);
        return matchClass && matchSearch;
    });

    const filteredNonLetti = listNonLetti.filter(item => {
        const matchClass = selectedClass === 'all' || item.classe === selectedClass;
        const matchSearch = filterQuery(item.studentName);
        return matchClass && matchSearch;
    });

    // Applicazione filtri per Stato Adesione
    const filteredAdesioni = listAdesioni.filter(item => {
        // Filtro Classe
        const matchClass = selectedClass === 'all' || item.classe === selectedClass;
        // Filtro Ricerca
        const matchSearch = filterQuery(item.studentName) || filterQuery(item.parentName);
        // Filtro Risposta
        let matchResponse = false;
        if (selectedResponse === 'given') {
            matchResponse = item.risposta === 'si' || item.risposta === 'no';
        } else if (selectedResponse === 'si') {
            matchResponse = item.risposta === 'si';
        } else if (selectedResponse === 'no') {
            matchResponse = item.risposta === 'no';
        } else if (selectedResponse === 'attesa') {
            matchResponse = item.risposta === 'attesa';
        }
        return matchClass && matchSearch && matchResponse;
    });

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
                <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-xs text-gray-400">Analisi risposte in corso...</p>
            </div>
        );
    }

    const tabsBlock = isAdesione ? (
        <div className="flex border-b border-gray-100 bg-white gap-4">
            <button
                onClick={() => {
                    setMainTab('letture');
                    setSelectedClass('all');
                }}
                className={`py-3 text-xs font-barlow font-bold uppercase tracking-wider border-b-2 transition-all ${
                    mainTab === 'letture'
                        ? 'border-kidville-green text-kidville-green'
                        : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
            >
                📖 Stato Lettura
            </button>
            <button
                onClick={() => {
                    setMainTab('adesioni');
                    setSelectedClass('all');
                    setSelectedResponse('given');
                }}
                className={`py-3 text-xs font-barlow font-bold uppercase tracking-wider border-b-2 transition-all ${
                    mainTab === 'adesioni'
                        ? 'border-kidville-green text-kidville-green'
                        : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
            >
                📋 Adesioni
            </button>
        </div>
    ) : null;

    const statsBlock = mainTab === 'letture' ? (
        <div className="grid grid-cols-2 gap-3">
            <div className="bg-gradient-to-br from-blue-50 to-kidville-info-soft border border-kidville-info/60 p-4 rounded-3xl">
                <div className="flex items-center gap-2 text-kidville-info mb-1">
                    <Eye size={16} strokeWidth={1.5} />
                    <span className="font-maven text-[10px] font-bold uppercase tracking-wider">Letti</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <span className="font-barlow font-black text-2xl text-blue-900">{readCount}</span>
                    <span className="font-maven text-xs text-kidville-info/60">su {totalTarget} ({readPercentage}%)</span>
                </div>
            </div>

            <div className="bg-gradient-to-br from-gray-50 to-gray-100/30 border border-gray-200/40 p-4 rounded-3xl">
                <div className="flex items-center gap-2 text-gray-500 mb-1">
                    <AlertCircle size={16} strokeWidth={1.5} />
                    <span className="font-maven text-[10px] font-bold uppercase tracking-wider">Non letti</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                    <span className="font-barlow font-black text-2xl text-gray-700">{unreadCount}</span>
                    <span className="font-maven text-xs text-gray-500/60">famiglie</span>
                </div>
            </div>
        </div>
    ) : (
        <div className="bg-kidville-info-soft/50 border border-kidville-info/60 p-4 rounded-3xl space-y-3">
            <h4 className="font-barlow font-bold text-xs text-kidville-info uppercase tracking-wide flex items-center gap-1.5">
                <Users size={14} strokeWidth={1.5} /> Dettaglio Adesioni
            </h4>
            <div className="grid grid-cols-3 gap-2">
                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                    <div className="flex items-center justify-center text-kidville-success gap-1 mb-0.5">
                        <ThumbsUp size={12} strokeWidth={1.5} />
                        <span className="font-maven text-[9px] font-bold uppercase">Sì</span>
                    </div>
                    <span className="font-barlow font-black text-lg text-kidville-success">{siCount}</span>
                </div>
                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                    <div className="flex items-center justify-center text-gray-500 gap-1 mb-0.5">
                        <ThumbsDown size={12} strokeWidth={1.5} />
                        <span className="font-maven text-[9px] font-bold uppercase">No</span>
                    </div>
                    <span className="font-barlow font-black text-lg text-gray-600">{noCount}</span>
                </div>
                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-kidville-info/30">
                    <div className="flex items-center justify-center text-kidville-warn gap-1 mb-0.5">
                        <HelpCircle size={12} strokeWidth={1.5} />
                        <span className="font-maven text-[9px] font-bold uppercase">Attesa</span>
                    </div>
                    <span className="font-barlow font-black text-lg text-kidville-warn">{pendingAnswers}</span>
                </div>
            </div>
        </div>
    );

    const filtersBlock = (
        <div className="bg-gray-50 border border-gray-100 p-4 rounded-3xl space-y-3">
            <div className="flex items-center justify-between">
                <span className="font-barlow font-bold text-xs text-gray-500 uppercase tracking-wider">Filtri</span>
                {(selectedClass !== 'all' || selectedResponse !== 'given' || searchQuery) && (
                    <button
                        onClick={() => {
                            setSelectedClass('all');
                            setSelectedResponse('given');
                            setSearchQuery('');
                        }}
                        className="font-maven text-[10px] text-kidville-green hover:underline font-bold"
                    >
                        Azzera
                    </button>
                )}
            </div>

            {mainTab === 'letture' ? (
                <div className="grid grid-cols-1 gap-2">
                    <div>
                        <label className="font-maven font-medium text-[9px] text-gray-400 uppercase tracking-wide mb-1 block">Classe</label>
                        <select
                            value={selectedClass}
                            onChange={e => setSelectedClass(e.target.value)}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="all">Tutte le classi</option>
                            {targetClasses.map(c => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="font-maven font-medium text-[9px] text-gray-400 uppercase tracking-wide mb-1 block">Classe</label>
                        <select
                            value={selectedClass}
                            onChange={e => setSelectedClass(e.target.value)}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="all">Tutte le classi</option>
                            {targetClasses.map(c => (
                                <option key={c} value={c}>{c}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="font-maven font-medium text-[9px] text-gray-400 uppercase tracking-wide mb-1 block">Risposta</label>
                        <select
                            value={selectedResponse}
                            onChange={e => setSelectedResponse(e.target.value)}
                            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 font-maven text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                        >
                            <option value="given">Risposte date (Sì/No)</option>
                            <option value="si">Aderito (Sì)</option>
                            <option value="no">Declinato (No)</option>
                            <option value="attesa">In attesa</option>
                        </select>
                    </div>
                </div>
            )}

            {/* Search */}
            <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Cerca alunno o genitore..."
                    className="w-full bg-white border border-gray-200 rounded-xl pl-9 pr-3 py-1.5 font-maven text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-kidville-green/20"
                />
            </div>
        </div>
    );

    const listsBlock = (
        <div className="space-y-3">
            {mainTab === 'letture' ? (
                <div className="space-y-3">
                    {/* Sub tabs Letti / Non letti */}
                    <div className="flex bg-gray-100 rounded-2xl p-1 gap-1">
                        <button
                            onClick={() => setReadSubTab('letti')}
                            className={`flex-1 py-2 font-maven text-xs font-semibold rounded-xl transition-all ${
                                readSubTab === 'letti' ? 'bg-white text-kidville-green shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`}
                        >
                            Letti ({filteredLetti.length})
                        </button>
                        <button
                            onClick={() => setReadSubTab('non_letti')}
                            className={`flex-1 py-2 font-maven text-xs font-semibold rounded-xl transition-all ${
                                readSubTab === 'non_letti' ? 'bg-white text-kidville-green shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`}
                        >
                            Non letti ({filteredNonLetti.length})
                        </button>
                    </div>

                    {/* List rendering for Letture */}
                    <div className={`space-y-2 ${listMaxH} overflow-y-auto pr-1`}>
                        {readSubTab === 'letti' ? (
                            filteredLetti.length === 0 ? (
                                <p className="font-maven text-xs text-gray-400 text-center py-6">Nessuna lettura corrispondente</p>
                            ) : (
                                filteredLetti.map(item => (
                                    <div key={item.studentId} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-2xl shadow-sm hover:border-gray-200 transition-colors">
                                        <div className="min-w-0">
                                            <p className="font-barlow font-bold text-xs text-kidville-green uppercase truncate">{item.studentName}</p>
                                            <p className="font-maven text-[10px] text-gray-400 mt-0.5 truncate">
                                                Genitore: {item.parentName} • Classe {item.classe}
                                            </p>
                                        </div>
                                        <span className="font-maven text-[9px] text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-2 py-1 flex-shrink-0 text-right">
                                            {item.lettoIl.split(',')[0]}
                                        </span>
                                    </div>
                                ))
                            )
                        ) : (
                            filteredNonLetti.length === 0 ? (
                                <p className="font-maven text-xs text-gray-400 text-center py-6">Tutte le famiglie hanno letto!</p>
                            ) : (
                                filteredNonLetti.map(item => (
                                    <div key={item.studentId} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-2xl shadow-sm hover:border-gray-200 transition-colors">
                                        <div>
                                            <p className="font-barlow font-bold text-xs text-kidville-green uppercase">{item.studentName}</p>
                                            <p className="font-maven text-[10px] text-gray-400 mt-0.5">Classe {item.classe}</p>
                                        </div>
                                        <span className="flex items-center gap-1 font-maven text-[9px] font-bold text-kidville-warn bg-kidville-warn-soft border border-kidville-warn/30 rounded-lg px-2 py-1">
                                            <AlertCircle size={10} /> Da leggere
                                        </span>
                                    </div>
                                ))
                            )
                        )}
                    </div>
                </div>
            ) : (
                // List rendering for Adesioni
                <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                        <span className="font-barlow font-bold text-[10px] text-gray-400 uppercase tracking-wider">
                            {selectedResponse === 'given' ? 'Risposte Ricevute' :
                             selectedResponse === 'si' ? 'Aderito (Sì)' :
                             selectedResponse === 'no' ? 'Declinato (No)' : 'Nessuna Risposta (In attesa)'}
                        </span>
                        <span className="font-maven text-[10px] text-gray-400 font-medium">Totale: {filteredAdesioni.length}</span>
                    </div>

                    <div className={`space-y-2 ${listMaxHAdesioni} overflow-y-auto pr-1`}>
                        {filteredAdesioni.length === 0 ? (
                            <p className="font-maven text-xs text-gray-400 text-center py-8">Nessuna adesione corrispondente</p>
                        ) : (
                            filteredAdesioni.map(item => (
                                <div key={item.studentId} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-2xl shadow-sm hover:border-gray-200 transition-colors">
                                    <div className="min-w-0">
                                        <p className="font-barlow font-bold text-xs text-kidville-green uppercase truncate">{item.studentName}</p>
                                        <p className="font-maven text-[10px] text-gray-400 mt-0.5 truncate">
                                            Genitore: {item.parentName} • Classe {item.classe}
                                        </p>
                                    </div>
                                    <span className={`flex items-center gap-1 font-maven text-[9px] font-bold rounded-lg px-2 py-1 flex-shrink-0 border ${
                                        item.risposta === 'si'
                                            ? 'bg-kidville-success-soft border-kidville-success/30 text-kidville-success'
                                            : item.risposta === 'no'
                                                ? 'bg-gray-100 border-gray-200 text-gray-600'
                                                : 'bg-kidville-warn-soft border-kidville-warn/30 text-kidville-warn'
                                    }`}>
                                        {item.risposta === 'si' && <><ThumbsUp size={10} /> Sì, Aderisco</>}
                                        {item.risposta === 'no' && <><ThumbsDown size={10} /> No</>}
                                        {item.risposta === 'attesa' && <><HelpCircle size={10} className="w-2.5 h-2.5" /> In attesa</>}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );

    if (isPage) {
        return (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                <div className="space-y-5">
                    {tabsBlock}
                    {statsBlock}
                    {filtersBlock}
                </div>
                <div>{listsBlock}</div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {tabsBlock}
            {statsBlock}
            {filtersBlock}
            {listsBlock}
        </div>
    );
}
