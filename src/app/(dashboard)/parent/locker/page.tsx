'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
    CheckCircle2, Clock, ChevronDown, Package, Bell,
    Table2, ChevronLeft, ChevronRight, RefreshCw, Zap,
} from 'lucide-react';
import {
    MonthlyLockerTable,
    type StudentInfo,
} from '@/components/features/teacher/locker/MonthlyLockerTable';

// In produzione, questi verranno dal contesto auth
const ALUNNO_ID   = '28dbe4fc-a231-4b57-ab03-c7f205644205'; // Francesca Russo (ID corretto)
const CHILD_NAME  = 'Francesca';

interface InventoryItem {
    id?: string;
    alunno_id?: string;
    materiale: string;
    quantita: number;
    quantita_residua?: number;
    livello_allerta?: number;
    livello_emergenza?: number;
    nome_oggetto?: string;
    date?: string;
    portato?: boolean;
    // Legacy join structure (potrebbe non essere presente nello schema flat)
    locker_catalog?: {
        id: string;
        nome: string;
        icona: string;
        unita: string;
        soglia_gialla: number;
        soglia_rossa: number;
    };
}

interface LockerRequest {
    id: string;
    livello_alert: 'giallo' | 'rosso';
    quantita_residua: number;
    stato: 'pending' | 'acknowledged' | 'fulfilled';
    preso_in_carico_il: string | null;
    creato_il: string;
    locker_catalog: {
        id: string;
        nome: string;
        icona: string;
        unita: string;
    };
}

function getSemaforoUI(qty: number, gialla: number, rossa: number) {
    if (qty <= rossa) return {
        bg: 'bg-kidville-error-soft',
        border: 'border-kidville-error/30',
        text: 'text-kidville-error',
        icon: '🔴',
        label: 'Esaurito!',
        barColor: 'bg-kidville-error',
    };
    if (qty <= gialla) return {
        bg: 'bg-kidville-warn-soft',
        border: 'border-kidville-warn/30',
        text: 'text-kidville-warn',
        icon: '🟡',
        label: 'In esaurimento',
        barColor: 'bg-kidville-warn',
    };
    return {
        bg: 'bg-kidville-success-soft',
        border: 'border-kidville-success/30',
        text: 'text-kidville-success',
        icon: '🟢',
        label: 'Ok',
        barColor: 'bg-kidville-success',
    };
}

// ── Helper mesi ───────────────────────────────────────────────────────────────

function currentYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prevMonth(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ParentLockerPage() {
    const [activeTab, setActiveTab] = useState<'overview' | 'monthly'>('overview');
    const [month, setMonth]         = useState(currentYearMonth());

    const [stockData, setStockData]   = useState<{ materiale: string; stock: number }[]>([]);
    const [requests, setRequests]     = useState<LockerRequest[]>([]);
    const [monthlyData, setMonthlyData] = useState<StudentInfo[]>([]);

    const [isLoading, setIsLoading]               = useState(true);
    const [isMonthlyLoading, setIsMonthlyLoading] = useState(false);
    const [showHistory, setShowHistory]           = useState(false);
    const [savingId, setSavingId]                 = useState<string | null>(null);
    const [showToast, setShowToast]               = useState(false);
    const [toastMessage, setToastMessage]         = useState('');
    const [lastUpdated, setLastUpdated]           = useState<Date | null>(null);
    const [realtimePulse, setRealtimePulse]       = useState(false);
    const prevStockRef = useRef<string>('');

    // ── Fetch overview (usa mode=stock per numeri precisi) ──────────────────────────────
    const fetchData = useCallback(async (silent = false) => {
        if (!silent) setIsLoading(true);
        try {
            // mode=stock: ritorna [{materiale, stock}] con stock aggregato reale
            const [stockRes, reqRes] = await Promise.all([
                fetch(`/api/locker/inventory?alunno_id=${ALUNNO_ID}&mode=stock`),
                fetch(`/api/locker/requests?alunno_id=${ALUNNO_ID}`),
            ]);
            
            const stockJson = await stockRes.json();
            const reqData = await reqRes.json();

            if (Array.isArray(stockJson)) {
                const signature = JSON.stringify(stockJson);
                // Lampeggia solo se i dati sono EFFETTIVAMENTE cambiati
                if (signature !== prevStockRef.current) {
                    prevStockRef.current = signature;
                    setLastUpdated(new Date());
                    setRealtimePulse(true);
                    setTimeout(() => setRealtimePulse(false), 2000);
                }
                setStockData(stockJson);
            }
            if (Array.isArray(reqData)) setRequests(reqData);
        } catch (err) {
            console.error('Errore caricamento:', err);
        } finally {
            if (!silent) setIsLoading(false);
        }
    }, []);

    // ── Fetch tabella mensile (solo per il figlio corrente) ───────────────────
    const fetchMonthly = async (ym: string) => {
        setIsMonthlyLoading(true);
        try {
            // mode=carico → solo giorni in cui il genitore ha consegnato
            const res = await fetch(
                `/api/locker/inventory?alunno_id=${ALUNNO_ID}&mode=carico&month=${ym}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                setMonthlyData([
                    {
                        id: ALUNNO_ID,
                        nome: CHILD_NAME,
                        cognome: '',
                        inventario: data.map((item: any) => ({
                            id:        item.nome_oggetto + item.date,
                            alunno_id: ALUNNO_ID,
                            materiale: item.materiale ?? item.nome_oggetto ?? '',
                            quantita:  item.quantita ?? 0,
                            date:      item.date ?? '',
                            portato:   true, // mode=carico, quindi sempre true
                        })),
                    },
                ]);
            }
        } catch (err) {
            console.error('Errore caricamento mensile:', err);
        } finally {
            setIsMonthlyLoading(false);
        }
    };

    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        if (activeTab === 'monthly') fetchMonthly(month);
    }, [activeTab, month]);

    // ── Polling: aggiornamento ogni 20 secondi (affidabile, funziona sempre) ─────────
    useEffect(() => {
        const interval = setInterval(() => {
            fetchData(true); // silent=true: non mostra spinner
            if (activeTab === 'monthly') fetchMonthly(month);
        }, 20_000); // ogni 20 secondi
        return () => clearInterval(interval);
    }, [fetchData, activeTab, month]);

    const handleAcknowledge = async (requestId: string) => {
        setSavingId(requestId);
        try {
            const res = await fetch('/api/locker/requests', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: requestId, stato: 'acknowledged' }),
            });
            if (!res.ok) throw new Error('Errore');
            showToastMsg('✅ Preso in carico!');
            fetchData();
        } catch (err) {
            console.error('Errore:', err);
            showToastMsg('❌ Errore nel salvataggio');
        } finally {
            setSavingId(null);
        }
    };

    const showToastMsg = (msg: string) => {
        setToastMessage(msg);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2500);
    };

    const pendingRequests     = requests.filter(r => r.stato === 'pending');
    const acknowledgedRequests = requests.filter(r => r.stato === 'acknowledged');
    const completedRequests   = requests.filter(r => r.stato === 'fulfilled');

    if (isLoading) {
        return (
            <div className="max-w-lg mx-auto p-4 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-gray-500">Caricamento armadietto...</p>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
            {/* ── Header ── */}
            <div className="flex items-center justify-between mb-2">
                <div>
                    <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
                        Servizi
                    </p>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide leading-none">
                        Armadietto
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    {/* Badge LIVE */}
                    <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold transition-all
                        ${realtimePulse ? 'bg-kidville-success text-white scale-110' : 'bg-kidville-success-soft text-kidville-success'}`}>
                        <Zap size={10} className={realtimePulse ? 'animate-bounce' : ''} /> LIVE
                    </span>
                    <button
                        onClick={() => { fetchData(); if (activeTab === 'monthly') fetchMonthly(month); }}
                        className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                        title="Aggiorna">
                        <RefreshCw size={16} />
                    </button>
                </div>
            </div>
            <div className="flex items-center justify-between mb-5">
                <p className="font-maven text-gray-500">Materiale scolastico di {CHILD_NAME}</p>
                {lastUpdated && (
                    <p className="text-[10px] text-kidville-success font-maven">
                        Aggiornato alle {lastUpdated.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                )}
            </div>

            {/* ── Tab switcher ── */}
            <div className="flex bg-zinc-100 rounded-xl p-1 gap-1 mb-6 self-start w-fit">
                <button
                    id="tab-overview-btn"
                    onClick={() => setActiveTab('overview')}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
                                ${activeTab === 'overview'
                                    ? 'bg-white shadow text-kidville-green'
                                    : 'text-gray-500 hover:text-kidville-green'}`}
                >
                    <Package size={14} /> Panoramica
                </button>
                <button
                    id="tab-monthly-btn"
                    onClick={() => setActiveTab('monthly')}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
                                ${activeTab === 'monthly'
                                    ? 'bg-white shadow text-kidville-green'
                                    : 'text-gray-500 hover:text-kidville-green'}`}
                >
                    <Table2 size={14} /> Andamento Mensile
                </button>
            </div>

            {/* ══════════════════════════════════════════════════════════ */}
            {/* TAB: PANORAMICA                                           */}
            {/* ══════════════════════════════════════════════════════════ */}
            {activeTab === 'overview' && (
                <>
                    {/* Richieste Pendenti */}
                    {pendingRequests.length > 0 && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <Bell size={16} className="text-kidville-error" />
                                <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide">
                                    Da portare a scuola
                                </h2>
                                <span className="bg-kidville-error text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                                    {pendingRequests.length}
                                </span>
                            </div>
                            <div className="space-y-2">
                                {pendingRequests.map(req => (
                                    <div
                                        key={req.id}
                                        className={`rounded-2xl border-2 p-4 ${
                                            req.livello_alert === 'rosso'
                                                ? 'bg-kidville-error-soft border-kidville-error/30'
                                                : 'bg-kidville-warn-soft border-kidville-warn/30'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-sm">
                                                {req.locker_catalog.icona}
                                            </div>
                                            <div className="flex-1">
                                                <p className="font-maven font-bold text-kidville-green">
                                                    {req.locker_catalog.nome}
                                                </p>
                                                <p className={`font-maven text-sm ${
                                                    req.livello_alert === 'rosso' ? 'text-kidville-error' : 'text-kidville-warn'
                                                }`}>
                                                    {req.livello_alert === 'rosso' ? '🔴 Esaurito!' : '🟡 In esaurimento'} — Rimasti: {req.quantita_residua} {req.locker_catalog.unita}
                                                </p>
                                                <p className="font-maven text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                                                    <Clock size={10} />
                                                    {new Date(req.creato_il).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            id={`acknowledge-${req.id}-btn`}
                                            onClick={() => handleAcknowledge(req.id)}
                                            disabled={savingId === req.id}
                                            className="w-full mt-3 h-11 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                        >
                                            {savingId === req.id ? (
                                                <div className="w-4 h-4 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                                            ) : (
                                                <>
                                                    <CheckCircle2 size={16} />
                                                    Preso in carico
                                                </>
                                            )}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Richieste Prese in Carico */}
                    {acknowledgedRequests.length > 0 && (
                        <div className="mb-6">
                            <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide mb-3 flex items-center gap-2">
                                <CheckCircle2 size={14} className="text-kidville-success" />
                                Preso in carico
                            </h2>
                            <div className="space-y-2">
                                {acknowledgedRequests.map(req => (
                                    <div key={req.id} className="rounded-2xl border-2 border-kidville-success/30 bg-kidville-success-soft p-3 flex items-center gap-3">
                                        <span className="text-xl">{req.locker_catalog.icona}</span>
                                        <div className="flex-1">
                                            <p className="font-maven font-bold text-sm text-kidville-green">{req.locker_catalog.nome}</p>
                                            <p className="font-maven text-xs text-kidville-success">
                                                ✅ Portare a scuola — Preso il {new Date(req.preso_in_carico_il!).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Situazione Materiale — usa stockData da mode=stock (numeri precisi) */}
                    <div className="mb-6">
                        <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide mb-3 flex items-center gap-2">
                            <Package size={14} /> Situazione Materiale
                        </h2>
                        {stockData.length > 0 ? (
                            <div className="grid grid-cols-2 gap-3">
                                {stockData.map(item => {
                                    const n = item.materiale.toLowerCase();
                                    const icona = n.includes('pannolin') ? '🧷'
                                        : n.includes('salviet') ? '🧻'
                                        : n.includes('crema')   ? '🧴'
                                        : n.includes('cambio')  ? '👕' : '📦';
                                    const gialla = 5, rossa = 2;
                                    const qty = item.stock;
                                    const sem = getSemaforoUI(qty, gialla, rossa);
                                    const maxBar = Math.max(gialla * 4, qty + 2);
                                    const pct = Math.min(100, (qty / maxBar) * 100);
                                    return (
                                        <div key={item.materiale} className={`rounded-2xl border-2 ${sem.border} ${sem.bg} p-4 text-center`}>
                                            <div className="text-3xl mb-2">{icona}</div>
                                            <p className="font-maven font-bold text-sm text-kidville-green mb-1">{item.materiale}</p>
                                            <p className={`font-barlow font-black text-3xl ${sem.text}`}>{qty}</p>
                                            <p className="font-maven text-xs text-gray-400 mb-2">pz</p>
                                            <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                                                <div className={`h-full ${sem.barColor} rounded-full transition-all duration-700`}
                                                    style={{ width: `${pct}%` }} />
                                            </div>
                                            <p className={`font-maven text-xs mt-1 ${sem.text}`}>{sem.icon} {sem.label}</p>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-8 bg-white rounded-2xl">
                                <Package size={40} className="mx-auto text-gray-300 mb-2" />
                                <p className="font-maven text-gray-400 text-sm">Nessun materiale in stock</p>
                            </div>
                        )}
                    </div>

                    {/* Storico */}
                    {completedRequests.length > 0 && (
                        <div>
                            <button
                                id="toggle-history-btn"
                                onClick={() => setShowHistory(!showHistory)}
                                className="flex items-center gap-2 mb-2"
                            >
                                <h2 className="font-barlow font-bold text-gray-400 uppercase text-sm tracking-wide">
                                    Storico richieste ({completedRequests.length})
                                </h2>
                                <ChevronDown size={14} className={`text-gray-400 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
                            </button>
                            {showHistory && (
                                <div className="space-y-1.5">
                                    {completedRequests.map(req => (
                                        <div key={req.id} className="rounded-xl bg-gray-50 px-3 py-2 flex items-center gap-3 opacity-60">
                                            <span className="text-lg">{req.locker_catalog.icona}</span>
                                            <div className="flex-1">
                                                <p className="font-maven text-sm text-gray-500">{req.locker_catalog.nome}</p>
                                            </div>
                                            <span className="font-maven text-xs text-gray-400">
                                                {new Date(req.creato_il).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* ══════════════════════════════════════════════════════════ */}
            {/* TAB: ANDAMENTO MENSILE                                    */}
            {/* ══════════════════════════════════════════════════════════ */}
            {activeTab === 'monthly' && (
                <div className="bg-white rounded-3xl p-5">
                    {/* Navigazione mese */}
                    <div className="flex items-center justify-between mb-5">
                        <button
                            id="parent-prev-month-btn"
                            onClick={() => setMonth(m => prevMonth(m))}
                            className="p-2 rounded-xl text-gray-500 hover:text-kidville-green hover:bg-kidville-cream transition-all"
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-semibold text-kidville-green/70">Andamento mensile di {CHILD_NAME}</span>
                        <button
                            id="parent-next-month-btn"
                            onClick={() => setMonth(m => nextMonth(m))}
                            className="p-2 rounded-xl text-gray-500 hover:text-kidville-green hover:bg-kidville-cream transition-all"
                        >
                            <ChevronRight size={18} />
                        </button>
                    </div>

                    {isMonthlyLoading ? (
                        <div className="flex items-center justify-center py-16 gap-3">
                            <div className="w-6 h-6 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                            <span className="text-gray-500 text-sm">Caricamento...</span>
                        </div>
                    ) : (
                        <MonthlyLockerTable
                            students={monthlyData}
                            month={month}
                            hideStudentColumn={true}
                        />
                    )}
                </div>
            )}

            {/* Toast */}
            {showToast && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] bg-kidville-green text-white font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-bounce">
                    {toastMessage}
                </div>
            )}
        </div>
    );
}
