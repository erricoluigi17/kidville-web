'use client';

import { useState, useEffect, useCallback } from 'react';
import {
    Package, RefreshCw, ChevronDown, ChevronRight,
    PlusCircle, MinusCircle, Table2, Truck, ChevronLeft,
    ChevronRight as ChevronRightIcon, Settings,
} from 'lucide-react';
import Link from 'next/link';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';
import { MonthlyLockerTable, type StudentInfo } from '@/components/features/teacher/locker/MonthlyLockerTable';

const SEZIONE = 'Girasoli';

function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(ym: string, delta: number) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Tipi ────────────────────────────────────────────────────────────────────

interface StockItem  { materiale: string; stock: number; }
interface StockAlunno { id: string; nome: string; cognome: string; stocks: StockItem[]; }
interface CaricoDayStudent { id: string; nome: string; cognome: string; inventario: any[]; }

// ─────────────────────────────────────────────────────────────────────────────

export default function TeacherLockerPage() {
    // 'carico' | 'consumo' | 'mensile'
    const [view, setView]   = useState<'carico' | 'consumo' | 'mensile'>('carico');
    const [month, setMonth] = useState(currentYearMonth());

    // Carico state
    const [caricoStudents, setCaricoStudents] = useState<CaricoDayStudent[]>([]);
    const [caricoLoading,  setCaricoLoading]  = useState(false);
    const [expandedCarico, setExpandedCarico] = useState<string | null>(null);
    const [showModal,      setShowModal]      = useState(false);
    const [preStudent,     setPreStudent]     = useState('');
    const [preMat,         setPreMat]         = useState('');

    // Consumo state
    const [consumoStudents, setConsumoStudents] = useState<StockAlunno[]>([]);
    const [consumoLoading,  setConsumoLoading]  = useState(false);
    const [expandedConsumo, setExpandedConsumo] = useState<string | null>(null);
    // inline consumo form: { studentId, materiale }
    const [consumoForm, setConsumoForm]         = useState<{sid: string; mat: string} | null>(null);
    const [consumoQty,  setConsumoQty]          = useState(1);
    const [consumoSaving, setConsumoSaving]     = useState(false);

    // Mensile state
    const [mensileStudents, setMensileStudents] = useState<StudentInfo[]>([]);
    const [mensileLoading,  setMensileLoading]  = useState(false);

    // ── Fetch Carico ─────────────────────────────────────────────────────────
    const fetchCarico = useCallback(async () => {
        setCaricoLoading(true);
        try {
            const today = new Date().toISOString().slice(0, 10);
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${SEZIONE}&mode=carico&month=${today.slice(0, 7)}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                // Filtra solo record di OGGI
                const todayData = data.map((s: any) => ({
                    ...s,
                    inventario: (s.inventario ?? []).filter((r: any) => r.date === today),
                }));
                setCaricoStudents(todayData);
                if (todayData.length > 0 && !expandedCarico) setExpandedCarico(todayData[0].id);
            }
        } catch (e) { console.error(e); }
        finally { setCaricoLoading(false); }
    }, [expandedCarico]);

    // ── Fetch Consumo (stock aggregato) ──────────────────────────────────────
    const fetchConsumo = useCallback(async () => {
        setConsumoLoading(true);
        try {
            const res = await fetch(`/api/locker/inventory?classe_sezione=${SEZIONE}&mode=stock`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setConsumoStudents(data);
                if (data.length > 0 && !expandedConsumo) setExpandedConsumo(data[0].id);
            }
        } catch (e) { console.error(e); }
        finally { setConsumoLoading(false); }
    }, [expandedConsumo]);

    // ── Fetch Mensile ─────────────────────────────────────────────────────────
    const fetchMensile = useCallback(async (ym: string) => {
        setMensileLoading(true);
        try {
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${SEZIONE}&mode=carico&month=${ym}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                setMensileStudents(data.map((s: any) => ({
                    id: s.id, nome: s.nome, cognome: s.cognome,
                    inventario: (s.inventario ?? []).map((r: any) => ({
                        id:        r.nome_oggetto + r.date,
                        alunno_id: s.id,
                        materiale: r.materiale ?? r.nome_oggetto,
                        quantita:  r.quantita ?? 0,
                        date:      r.date ?? '',
                        portato:   true,
                    })),
                })));
            }
        } catch (e) { console.error(e); }
        finally { setMensileLoading(false); }
    }, []);

    // Carica entrambi subito (Carico odierno + stock totale per confronto)
    useEffect(() => { fetchCarico(); fetchConsumo(); }, []);
    useEffect(() => { if (view === 'mensile') fetchMensile(month); }, [view, month]);

    // ── Azioni ────────────────────────────────────────────────────────────────
    const handleLoadStock = async (body: { alunno_id: string; materiale: string; quantita: number }) => {
        const res = await fetch('/api/locker/inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        // Aggiorna SEMPRE entrambi i tab per coerenza dei numeri
        fetchCarico();
        fetchConsumo();
    };

    const handleConsumo = async () => {
        if (!consumoForm) return;
        setConsumoSaving(true);
        try {
            const res = await fetch('/api/locker/inventory', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    alunno_id: consumoForm.sid,
                    materiale: consumoForm.mat,
                    quantita_usata: consumoQty,
                }),
            });
            if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
            setConsumoForm(null);
            setConsumoQty(1);
            fetchConsumo();
        } catch (e: any) { alert('❌ ' + e.message); }
        finally { setConsumoSaving(false); }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
                <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase flex items-center gap-2">
                    <Package size={28} /> Armadietto
                </h1>
                <div className="flex items-center gap-2">
                    <Link href="/teacher/settings/locker"
                        className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                        title="Impostazioni materiali">
                        <Settings size={18} />
                    </Link>
                    <button
                        id="refresh-btn"
                        onClick={() => { fetchCarico(); if (view === 'consumo') fetchConsumo(); if (view === 'mensile') fetchMensile(month); }}
                        className="p-2 border rounded-xl text-gray-400 hover:text-gray-600"
                    >
                        <RefreshCw size={18} />
                    </button>
                </div>
            </div>

            {/* Toggle 3 viste */}
            <div className="flex bg-zinc-100 rounded-2xl p-1 gap-1 mb-6">
                {([
                    { key: 'carico',  icon: <Truck size={14} />,    label: 'Carico Genitore' },
                    { key: 'consumo', icon: <MinusCircle size={14} />, label: 'Consumo' },
                    { key: 'mensile', icon: <Table2 size={14} />,   label: 'Mensile' },
                ] as const).map(({ key, icon, label }) => (
                    <button
                        key={key}
                        id={`view-${key}-btn`}
                        onClick={() => setView(key)}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-semibold transition-all
                            ${view === key ? 'bg-white shadow text-kidville-green' : 'text-gray-500 hover:text-kidville-green'}`}
                    >
                        {icon} {label}
                    </button>
                ))}
            </div>

            {/* ══════════════════════ CARICO ══════════════════════════════════ */}
            {view === 'carico' && (
                <>
                    <button
                        id="new-carico-btn"
                        onClick={() => { setPreStudent(''); setPreMat(''); setShowModal(true); }}
                        className="w-full mb-5 py-3 bg-kidville-green text-kidville-yellow rounded-2xl font-barlow font-black uppercase shadow-lg hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                    >
                        <PlusCircle size={20} /> Registra Carico Odierno
                    </button>

                    {caricoLoading ? (
                        <div className="text-center py-10 text-gray-400">Caricamento...</div>
                    ) : (
                        <div className="space-y-3">
                            {caricoStudents.map(student => {
                                const isOpen = expandedCarico === student.id;
                                const todayCount = student.inventario.length;
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                                        <button
                                            onClick={() => setExpandedCarico(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-gray-50"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-gray-400">
                                                    {todayCount > 0 ? `${todayCount} consegne oggi` : 'Nessuna consegna oggi'}
                                                </p>
                                            </div>
                                            {todayCount > 0 && (
                                                <span className="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                                                    ✓ {todayCount}
                                                </span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-gray-300" /> : <ChevronRight size={18} className="text-gray-300" />}
                                        </button>

                                        {isOpen && (() => {
                                            // Recupera lo stock totale per questo alunno dal tab Consumo (già caricato)
                                            const studentStocks = consumoStudents.find(s => s.id === student.id)?.stocks ?? [];
                                            return (
                                                <div className="p-4 bg-gray-50/50 border-t border-gray-100 space-y-3">

                                                    {/* Stock totale attuale */}
                                                    {studentStocks.length > 0 && (
                                                        <div className="rounded-xl bg-kidville-green/5 border border-kidville-green/10 px-3 py-2">
                                                            <p className="text-[10px] font-bold text-kidville-green uppercase tracking-wide mb-1.5">📦 Stock Totale Attuale</p>
                                                            <div className="flex gap-3 flex-wrap">
                                                                {studentStocks.map((s: any) => (
                                                                    <span key={s.materiale} className="text-xs font-maven font-semibold text-gray-700">
                                                                        {s.materiale}: <strong className="text-kidville-green">{s.stock} pz</strong>
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Consegne di oggi */}
                                                    {todayCount > 0 ? (
                                                        <div className="space-y-1.5">
                                                            <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide">✅ Consegnato oggi</p>
                                                            {student.inventario.map((item: any, idx: number) => {
                                                                const matStock = studentStocks.find((s: any) => s.materiale === (item.materiale ?? item.nome_oggetto))?.stock ?? 0;
                                                                return (
                                                                    <div key={idx} className="flex items-center justify-between bg-white rounded-xl px-4 py-2 border border-emerald-100">
                                                                        <span className="font-maven font-semibold text-kidville-green text-sm">
                                                                            {item.materiale ?? item.nome_oggetto}
                                                                        </span>
                                                                        <div className="text-right">
                                                                            <span className="font-barlow font-black text-emerald-600 block">+{item.quantita} pz</span>
                                                                            <span className="text-[10px] text-gray-400">Totale: {matStock} pz</span>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <p className="text-center text-gray-400 text-sm py-2">Nessuna consegna registrata oggi</p>
                                                    )}

                                                    <button
                                                        onClick={() => { setPreStudent(student.id); setPreMat(''); setShowModal(true); }}
                                                        className="w-full py-2 border-2 border-dashed border-kidville-green/30 rounded-xl text-kidville-green text-xs font-bold hover:bg-kidville-green/5 transition-colors flex items-center justify-center gap-1"
                                                    >
                                                        <PlusCircle size={14} /> Aggiungi carico per {student.nome}
                                                    </button>
                                                </div>
                                            );
                                        })()}

                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <LoadStockModal
                        isOpen={showModal}
                        onClose={() => setShowModal(false)}
                        students={caricoStudents.map(s => ({ id: s.id, nome: s.nome, cognome: s.cognome }))}
                        preselectedStudent={preStudent}
                        preselectedMateriale={preMat}
                        classeSezione={SEZIONE}
                        onConfirm={handleLoadStock}
                    />
                </>
            )}

            {/* ══════════════════════ CONSUMO ══════════════════════════════════ */}
            {view === 'consumo' && (
                <>
                    <div className="mb-4 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs text-amber-700 font-maven">
                        <strong>👆 Tocca un materiale</strong> per registrare che l'hai utilizzato. Lo stock si aggiorna in tempo reale.
                    </div>

                    {consumoLoading ? (
                        <div className="text-center py-10 text-gray-400">Caricamento stock...</div>
                    ) : (
                        <div className="space-y-3">
                            {consumoStudents.map(student => {
                                const isOpen = expandedConsumo === student.id;
                                const hasStock = student.stocks.some(s => s.stock > 0);
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                                        <button
                                            onClick={() => setExpandedConsumo(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-gray-50"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-gray-400">{student.stocks.length} materiali in stock</p>
                                            </div>
                                            {!hasStock && (
                                                <span className="bg-red-100 text-red-500 text-[10px] font-bold px-2 py-0.5 rounded-full">ESAURITO</span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-gray-300" /> : <ChevronRight size={18} className="text-gray-300" />}
                                        </button>

                                        {isOpen && (
                                            <div className="p-4 bg-gray-50/50 border-t border-gray-100 space-y-2">
                                                {student.stocks.length === 0 ? (
                                                    <p className="text-center text-gray-400 text-sm py-3">Nessun materiale in stock</p>
                                                ) : student.stocks.map(item => {
                                                    const isFormOpen = consumoForm?.sid === student.id && consumoForm?.mat === item.materiale;
                                                    return (
                                                        <div key={item.materiale}>
                                                            {/* Riga materiale */}
                                                            <button
                                                                onClick={() => {
                                                                    if (isFormOpen) { setConsumoForm(null); return; }
                                                                    setConsumoForm({ sid: student.id, mat: item.materiale });
                                                                    setConsumoQty(1);
                                                                }}
                                                                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all
                                                                    ${isFormOpen
                                                                        ? 'border-orange-300 bg-orange-50'
                                                                        : item.stock === 0
                                                                            ? 'border-red-100 bg-red-50 opacity-60'
                                                                            : 'border-gray-100 bg-white hover:border-orange-200 hover:bg-orange-50/50'}`}
                                                            >
                                                                <span className="font-maven font-semibold text-sm text-kidville-green">{item.materiale}</span>
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`font-barlow font-black text-lg ${item.stock === 0 ? 'text-red-500' : 'text-kidville-green'}`}>
                                                                        {item.stock} pz
                                                                    </span>
                                                                    <MinusCircle size={18} className={item.stock > 0 ? 'text-orange-400' : 'text-gray-300'} />
                                                                </div>
                                                            </button>

                                                            {/* Form consumo inline */}
                                                            {isFormOpen && (
                                                                <div className="mt-1 px-4 py-3 bg-orange-50 border border-orange-200 rounded-xl space-y-3">
                                                                    <p className="text-xs text-orange-700 font-maven">
                                                                        Quante unità di <strong>{item.materiale}</strong> hai utilizzato?
                                                                    </p>
                                                                    <div className="flex items-center gap-3">
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.max(1, q - 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-orange-200 flex items-center justify-center text-orange-500 font-black hover:bg-orange-100"
                                                                        >-</button>
                                                                        <span className="font-barlow font-black text-2xl text-kidville-green w-8 text-center">{consumoQty}</span>
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.min(item.stock, q + 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-orange-200 flex items-center justify-center text-orange-500 font-black hover:bg-orange-100"
                                                                        >+</button>
                                                                        <button
                                                                            onClick={handleConsumo}
                                                                            disabled={consumoSaving || consumoQty > item.stock}
                                                                            className="flex-1 h-9 bg-orange-500 text-white rounded-xl font-barlow font-black text-sm disabled:opacity-50 hover:bg-orange-600 active:scale-95 transition-all"
                                                                        >
                                                                            {consumoSaving ? '...' : '✓ Conferma'}
                                                                        </button>
                                                                        <button onClick={() => setConsumoForm(null)} className="text-gray-400 text-xs">Annulla</button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            {/* ══════════════════════ MENSILE ══════════════════════════════════ */}
            {view === 'mensile' && (
                <div className="bg-white rounded-3xl p-5">
                    <div className="flex items-center justify-between mb-5">
                        <button id="prev-month-btn" onClick={() => setMonth(m => shiftMonth(m, -1))}
                            className="p-2 rounded-xl text-gray-500 hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-semibold text-kidville-green/70">Consegne mensili</span>
                        <button id="next-month-btn" onClick={() => setMonth(m => shiftMonth(m, 1))}
                            className="p-2 rounded-xl text-gray-500 hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronRightIcon size={18} />
                        </button>
                    </div>
                    {mensileLoading ? (
                        <div className="flex items-center justify-center py-16 gap-3">
                            <div className="w-5 h-5 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin" />
                            <span className="text-gray-500 text-sm">Caricamento...</span>
                        </div>
                    ) : (
                        <MonthlyLockerTable students={mensileStudents} month={month} hideStudentColumn={false} />
                    )}
                </div>
            )}
        </div>
    );
}
