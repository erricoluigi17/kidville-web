'use client';

import { useState, useEffect } from 'react';
import { ShoppingBag, CheckCircle2, Clock, ChevronDown, Package, Bell } from 'lucide-react';

// In produzione, questi verranno dal contesto auth
const ALUNNO_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // Sofia Esposito (dev)

interface InventoryItem {
    id: string;
    quantita: number;
    locker_catalog: {
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
        bg: 'bg-gradient-to-br from-red-50 to-red-100',
        border: 'border-red-200',
        text: 'text-red-700',
        icon: '🔴',
        label: 'Esaurito!',
        barColor: 'bg-red-500',
    };
    if (qty <= gialla) return {
        bg: 'bg-gradient-to-br from-amber-50 to-amber-100',
        border: 'border-amber-200',
        text: 'text-amber-700',
        icon: '🟡',
        label: 'In esaurimento',
        barColor: 'bg-amber-400',
    };
    return {
        bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100',
        border: 'border-emerald-200',
        text: 'text-emerald-700',
        icon: '🟢',
        label: 'Ok',
        barColor: 'bg-emerald-500',
    };
}

export default function ParentLockerPage() {
    const [inventory, setInventory] = useState<InventoryItem[]>([]);
    const [requests, setRequests] = useState<LockerRequest[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showHistory, setShowHistory] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [showToast, setShowToast] = useState(false);
    const [toastMessage, setToastMessage] = useState('');

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [invRes, reqRes] = await Promise.all([
                fetch(`/api/locker/inventory?alunno_id=${ALUNNO_ID}`),
                fetch(`/api/locker/requests?alunno_id=${ALUNNO_ID}`),
            ]);

            const invData = await invRes.json();
            const reqData = await reqRes.json();

            if (Array.isArray(invData)) setInventory(invData);
            if (Array.isArray(reqData)) setRequests(reqData);
        } catch (err) {
            console.error('Errore caricamento:', err);
        } finally {
            setIsLoading(false);
        }
    };

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

    const pendingRequests = requests.filter(r => r.stato === 'pending');
    const acknowledgedRequests = requests.filter(r => r.stato === 'acknowledged');
    const completedRequests = requests.filter(r => r.stato === 'fulfilled');

    if (isLoading) {
        return (
            <div className="max-w-lg mx-auto p-4 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-gray-500">Caricamento armadietto...</p>
            </div>
        );
    }

    return (
        <div className="max-w-lg mx-auto p-4 sm:p-6">
            {/* Header */}
            <div className="mb-6">
                <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                    <ShoppingBag size={28} /> Armadietto
                </h1>
                <p className="font-maven text-gray-500 mt-1">
                    Materiale scolastico di Sofia
                </p>
            </div>

            {/* Richieste Pendenti (alert) */}
            {pendingRequests.length > 0 && (
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-3">
                        <Bell size={16} className="text-red-500" />
                        <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide">
                            Da portare a scuola
                        </h2>
                        <span className="bg-red-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                            {pendingRequests.length}
                        </span>
                    </div>

                    <div className="space-y-2">
                        {pendingRequests.map(req => (
                            <div
                                key={req.id}
                                className={`rounded-2xl border-2 p-4 ${
                                    req.livello_alert === 'rosso'
                                        ? 'bg-red-50 border-red-200'
                                        : 'bg-amber-50 border-amber-200'
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
                                            req.livello_alert === 'rosso' ? 'text-red-600' : 'text-amber-600'
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
                        <CheckCircle2 size={14} className="text-emerald-500" />
                        Preso in carico
                    </h2>
                    <div className="space-y-2">
                        {acknowledgedRequests.map(req => (
                            <div key={req.id} className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-3 flex items-center gap-3">
                                <span className="text-xl">{req.locker_catalog.icona}</span>
                                <div className="flex-1">
                                    <p className="font-maven font-bold text-sm text-kidville-green">{req.locker_catalog.nome}</p>
                                    <p className="font-maven text-xs text-emerald-600">
                                        ✅ Portare a scuola — Preso il {new Date(req.preso_in_carico_il!).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Panoramica inventario */}
            <div className="mb-6">
                <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide mb-3 flex items-center gap-2">
                    <Package size={14} />
                    Situazione Materiale
                </h2>

                {inventory.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {inventory.map(item => {
                            const cat = item.locker_catalog;
                            const sem = getSemaforoUI(item.quantita, cat.soglia_gialla, cat.soglia_rossa);
                            const maxBar = Math.max(cat.soglia_gialla * 4, item.quantita + 2);
                            const pct = Math.min(100, (item.quantita / maxBar) * 100);

                            return (
                                <div key={item.id} className={`rounded-2xl border-2 ${sem.border} ${sem.bg} p-4 text-center`}>
                                    <div className="text-3xl mb-2">{cat.icona}</div>
                                    <p className="font-maven font-bold text-sm text-kidville-green mb-1">{cat.nome}</p>
                                    <p className={`font-barlow font-black text-3xl ${sem.text}`}>
                                        {item.quantita}
                                    </p>
                                    <p className="font-maven text-xs text-gray-400 mb-2">{cat.unita}</p>
                                    {/* Mini barra */}
                                    <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                                        <div className={`h-full ${sem.barColor} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <p className={`font-maven text-xs mt-1 ${sem.text}`}>{sem.icon} {sem.label}</p>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="text-center py-8 bg-white rounded-2xl">
                        <Package size={40} className="mx-auto text-gray-300 mb-2" />
                        <p className="font-maven text-gray-400 text-sm">Nessun materiale tracciato</p>
                    </div>
                )}
            </div>

            {/* Storico completate */}
            {completedRequests.length > 0 && (
                <div>
                    <button
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

            {/* Toast */}
            {showToast && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] bg-emerald-600 text-white font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-bounce">
                    {toastMessage}
                </div>
            )}
        </div>
    );
}
