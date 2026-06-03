'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search, AlertCircle, Users, ThumbsUp, ThumbsDown, Eye, HelpCircle } from 'lucide-react';
import { Avviso } from './AvvisoCard';

interface Props {
    open: boolean;
    avviso: Avviso | null;
    onClose: () => void;
    availableClasses?: string[];
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

export function AvvisoDetailsDrawer({ open, avviso, onClose, availableClasses = ['Girasoli', 'Margherite', 'Tulipani', '3A', '4B'] }: Props) {
    const [risposte, setRisposte] = useState<RispostaDettaglio[]>([]);
    const [targetStudents, setTargetStudents] = useState<StudentBasic[]>([]);
    const [loading, setLoading] = useState(false);
    
    // Elenchi separati: letture (Stato Lettura) vs risposte (Adesioni)
    const [mainTab, setMainTab] = useState<'letture' | 'adesioni'>('letture');
    const [readSubTab, setReadSubTab] = useState<'letti' | 'non_letti'>('letti');
    
    // Filtri
    const [selectedClass, setSelectedClass] = useState<string>('all');
    const [selectedResponse, setSelectedResponse] = useState<string>('given'); // 'given' | 'si' | 'no' | 'attesa'
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        if (!open || !avviso) return;

        const loadDetails = async () => {
            setLoading(true);
            try {
                // 1. Carica le risposte/letture reali registrate nel database
                const risposteRes = await fetch(`/api/avvisi/${avviso.id}/risposte`);
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
                        const res = await fetch(`/api/diary/students?sezione=${classe}`);
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
        
        // Reset stati filtri e viste al cambio avviso
        setMainTab('letture');
        setReadSubTab('letti');
        setSelectedClass('all');
        setSelectedResponse('given');
        setSearchQuery('');
    }, [open, avviso, availableClasses]);

    if (!avviso) return null;

    const isAdesione = avviso.tipo === 'adesione';

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

    return (
        <AnimatePresence>
            {open && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-kidville-green/30 backdrop-blur-sm z-50"
                    />

                    {/* Drawer */}
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                        className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white/95 backdrop-blur-xl shadow-2xl z-50 flex flex-col h-full border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="px-6 py-5 border-b border-gray-100 flex items-start justify-between bg-white">
                            <div>
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-barlow font-bold uppercase tracking-wider ${
                                    isAdesione ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
                                }`}>
                                    {isAdesione ? 'Adesione Interattiva' : 'Presa Visione'}
                                </span>
                                <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide mt-1.5 line-clamp-1">
                                    {avviso.titolo}
                                </h2>
                                <p className="font-maven text-xs text-gray-400 mt-0.5">
                                    Target: {avviso.target_scope === 'globale' ? 'Tutto l\'Istituto' : `Classi (${avviso.target_classes?.join(', ') || ''})`}
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                className="w-8 h-8 rounded-xl bg-gray-50 hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                            >
                                <X size={16} strokeWidth={1.5} />
                            </button>
                        </div>

                        {/* Macro Tabs: Lettura vs Adesione (se applicabile) */}
                        {isAdesione && (
                            <div className="flex border-b border-gray-100 px-6 bg-white gap-4">
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
                        )}

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {loading ? (
                                <div className="flex flex-col items-center justify-center py-20 gap-3">
                                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                                    <p className="font-maven text-xs text-gray-400">Analisi risposte in corso...</p>
                                </div>
                            ) : (
                                <>
                                    {/* STATS AREA */}
                                    {mainTab === 'letture' ? (
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="bg-gradient-to-br from-blue-50 to-indigo-50/30 border border-blue-100/60 p-4 rounded-3xl">
                                                <div className="flex items-center gap-2 text-blue-600 mb-1">
                                                    <Eye size={16} strokeWidth={1.5} />
                                                    <span className="font-maven text-[10px] font-bold uppercase tracking-wider">Letti</span>
                                                </div>
                                                <div className="flex items-baseline gap-1.5">
                                                    <span className="font-barlow font-black text-2xl text-blue-900">{readCount}</span>
                                                    <span className="font-maven text-xs text-blue-700/60">su {totalTarget} ({readPercentage}%)</span>
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
                                        <div className="bg-purple-50/50 border border-purple-100/60 p-4 rounded-3xl space-y-3">
                                            <h4 className="font-barlow font-bold text-xs text-purple-800 uppercase tracking-wide flex items-center gap-1.5">
                                                <Users size={14} strokeWidth={1.5} /> Dettaglio Adesioni
                                            </h4>
                                            <div className="grid grid-cols-3 gap-2">
                                                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-purple-100/30">
                                                    <div className="flex items-center justify-center text-emerald-600 gap-1 mb-0.5">
                                                        <ThumbsUp size={12} strokeWidth={1.5} />
                                                        <span className="font-maven text-[9px] font-bold uppercase">Sì</span>
                                                    </div>
                                                    <span className="font-barlow font-black text-lg text-emerald-700">{siCount}</span>
                                                </div>
                                                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-purple-100/30">
                                                    <div className="flex items-center justify-center text-gray-500 gap-1 mb-0.5">
                                                        <ThumbsDown size={12} strokeWidth={1.5} />
                                                        <span className="font-maven text-[9px] font-bold uppercase">No</span>
                                                    </div>
                                                    <span className="font-barlow font-black text-lg text-gray-600">{noCount}</span>
                                                </div>
                                                <div className="bg-white/80 rounded-2xl p-2.5 text-center border border-purple-100/30">
                                                    <div className="flex items-center justify-center text-amber-600 gap-1 mb-0.5">
                                                        <HelpCircle size={12} strokeWidth={1.5} />
                                                        <span className="font-maven text-[9px] font-bold uppercase">Attesa</span>
                                                    </div>
                                                    <span className="font-barlow font-black text-lg text-amber-700">{pendingAnswers}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* FILTERS AREA */}
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

                                    {/* LIST VIEW */}
                                    <div className="space-y-3 pt-2">
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
                                                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
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
                                                                    <span className="flex items-center gap-1 font-maven text-[9px] font-bold text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">
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

                                                <div className="space-y-2 max-h-[350px] overflow-y-auto pr-1">
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
                                                                        ? 'bg-emerald-50 border-emerald-100 text-emerald-700' 
                                                                        : item.risposta === 'no' 
                                                                            ? 'bg-gray-100 border-gray-200 text-gray-600' 
                                                                            : 'bg-amber-50 border-amber-100 text-amber-700'
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
                                </>
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
