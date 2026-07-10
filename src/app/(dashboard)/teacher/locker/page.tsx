'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
    Package, RefreshCw, ChevronDown, ChevronRight,
    PlusCircle, MinusCircle, Table2, Truck, ChevronLeft,
    ChevronRight as ChevronRightIcon, Settings,
} from 'lucide-react';
import Link from 'next/link';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';
import { MonthlyLockerTable, type StudentInfo } from '@/components/features/teacher/locker/MonthlyLockerTable';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

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
interface InventarioRecord { date: string; nome_oggetto: string; materiale?: string; quantita?: number; }
interface CaricoDayStudent { id: string; nome: string; cognome: string; inventario: InventarioRecord[]; }

// ─────────────────────────────────────────────────────────────────────────────

function TeacherLockerInner() {
    const search = useSearchParams();
    const pathname = usePathname();
    const userId = getCurrentTeacherId(search);
    // Link impostazioni base-path-aware: dentro il cockpit (/admin) resta nella shell;
    // sotto /teacher invariato. Evita una fuga dalla cornice Direzione/Segreteria.
    const uid = search.get('userId');
    const settingsHref = pathname?.startsWith('/admin')
        ? `/admin/impostazioni?sezione=armadietto${uid ? `&userId=${uid}` : ''}`
        : '/teacher/settings/locker';
    // 'carico' | 'consumo' | 'mensile'
    const [view, setView]   = useState<'carico' | 'consumo' | 'mensile'>('carico');
    const [month, setMonth] = useState(currentYearMonth());

    // Carico state
    const [caricoStudents, setCaricoStudents] = useState<CaricoDayStudent[]>([]);
    const [caricoLoading,  setCaricoLoading]  = useState(true);
    const [expandedCarico, setExpandedCarico] = useState<string | null>(null);
    const [showModal,      setShowModal]      = useState(false);
    const [preStudent,     setPreStudent]     = useState('');
    const [preMat,         setPreMat]         = useState('');

    // Consumo state
    const [consumoStudents, setConsumoStudents] = useState<StockAlunno[]>([]);
    const [consumoLoading,  setConsumoLoading]  = useState(true);
    const [expandedConsumo, setExpandedConsumo] = useState<string | null>(null);
    // inline consumo form: { studentId, materiale }
    const [consumoForm, setConsumoForm]         = useState<{sid: string; mat: string} | null>(null);
    const [consumoQty,  setConsumoQty]          = useState(1);
    const [consumoSaving, setConsumoSaving]     = useState(false);

    // Mensile state
    const [mensileStudents, setMensileStudents] = useState<StudentInfo[]>([]);
    const [mensileLoading,  setMensileLoading]  = useState(true);

    // Sezioni reali del docente (utenti_sezioni via /api/educator-sections):
    // niente più sezione hardcoded; con più sezioni compare il selettore a pill.
    const [availableSections, setAvailableSections] = useState<string[]>([]);
    const [sezione, setSezione] = useState('');

    useEffect(() => {
        if (!userId) return;
        fetch(`/api/educator-sections?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                const secs: string[] = d?.sectionNames ?? [];
                setAvailableSections(secs);
                setSezione(prev => prev || secs[0] || '');
                // Nessuna sezione assegnata: niente da caricare → chiudo gli spinner.
                if (secs.length === 0) { setCaricoLoading(false); setConsumoLoading(false); }
            })
            .catch(() => { setCaricoLoading(false); setConsumoLoading(false); });
    }, [userId]);

    // ── Fetch Carico ─────────────────────────────────────────────────────────
    const fetchCarico = useCallback(async () => {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=carico&month=${today.slice(0, 7)}&userId=${userId}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                // Filtra solo record di OGGI
                const todayData = data.map((s: CaricoDayStudent) => ({
                    ...s,
                    inventario: (s.inventario ?? []).filter((r) => r.date === today),
                }));
                setCaricoStudents(todayData);
                if (todayData.length > 0 && !expandedCarico) setExpandedCarico(todayData[0].id);
            }
        } finally { setCaricoLoading(false); }
    }, [expandedCarico, userId, sezione]);

    // ── Fetch Consumo (stock aggregato) ──────────────────────────────────────
    const fetchConsumo = useCallback(async () => {
        try {
            const res = await fetch(`/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=stock&userId=${userId}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setConsumoStudents(data);
                if (data.length > 0 && !expandedConsumo) setExpandedConsumo(data[0].id);
            }
        } finally { setConsumoLoading(false); }
    }, [expandedConsumo, userId, sezione]);

    // ── Fetch Mensile ─────────────────────────────────────────────────────────
    const fetchMensile = useCallback(async (ym: string) => {
        try {
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=carico&month=${ym}&userId=${userId}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                setMensileStudents(data.map((s: CaricoDayStudent) => ({
                    id: s.id, nome: s.nome, cognome: s.cognome,
                    inventario: (s.inventario ?? []).map((r) => ({
                        id:        r.nome_oggetto + r.date,
                        alunno_id: s.id,
                        materiale: r.materiale ?? r.nome_oggetto,
                        quantita:  r.quantita ?? 0,
                        date:      r.date ?? '',
                        portato:   true,
                    })),
                })));
            }
        } finally { setMensileLoading(false); }
    }, [userId, sezione]);

    // Carica Carico odierno + stock totale quando la sezione reale è nota.
    useEffect(() => { if (sezione) { fetchCarico(); fetchConsumo(); } }, [sezione]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (view === 'mensile' && sezione) fetchMensile(month); }, [view, month, sezione, fetchMensile]);

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
        if (!consumoForm || !userId) return;
        setConsumoSaving(true);
        try {
            const res = await fetch(`/api/locker/inventory?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
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
        } catch (e) { alert('❌ ' + (e instanceof Error ? e.message : String(e))); }
        finally { setConsumoSaving(false); }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Header verde (DR) */}
            <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">Strumenti</p>
                        <h1 className="flex items-center gap-2 font-barlow text-3xl font-black uppercase tracking-wide text-white">
                            <Package size={26} className="text-kidville-yellow" /> Armadietto
                        </h1>
                        <p className="mt-1.5 font-maven text-xs text-white/80">Scorte e consegne · Sezione {sezione || '…'}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Link href={settingsHref}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
                            title="Impostazioni materiali">
                            <Settings size={17} />
                        </Link>
                        <button
                            id="refresh-btn"
                            onClick={() => { fetchCarico(); if (view === 'consumo') fetchConsumo(); if (view === 'mensile') fetchMensile(month); }}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
                        >
                            <RefreshCw size={17} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Selettore sezione (solo con più sezioni assegnate al docente) */}
            {availableSections.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                    {availableSections.map(s => (
                        <button key={s} onClick={() => { setSezione(s); setExpandedCarico(null); setExpandedConsumo(null); }}
                            className={`rounded-pill border px-3 py-1.5 font-maven text-xs font-semibold transition-colors ${
                                sezione === s ? 'border-kidville-green/20 bg-kidville-green text-kidville-yellow' : 'border-kidville-line bg-white text-kidville-muted'
                            }`} aria-pressed={sezione === s}>
                            {s}
                        </button>
                    ))}
                </div>
            )}

            {/* Toggle 3 viste */}
            <div className="mt-5 mb-6 flex gap-1 rounded-2xl bg-white p-1 shadow-sm">
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
                            ${view === key ? 'bg-white shadow text-kidville-green' : 'text-kidville-muted hover:text-kidville-green'}`}
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
                        <div className="text-center py-10 text-kidville-muted">Caricamento...</div>
                    ) : (
                        <div className="space-y-3">
                            {caricoStudents.map(student => {
                                const isOpen = expandedCarico === student.id;
                                const todayCount = student.inventario.length;
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-kidville-line overflow-hidden">
                                        <button
                                            onClick={() => setExpandedCarico(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-kidville-cream"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-kidville-muted">
                                                    {todayCount > 0 ? `${todayCount} consegne oggi` : 'Nessuna consegna oggi'}
                                                </p>
                                            </div>
                                            {todayCount > 0 && (
                                                <span className="bg-kidville-success-soft text-kidville-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                                                    ✓ {todayCount}
                                                </span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-kidville-muted" /> : <ChevronRight size={18} className="text-kidville-muted" />}
                                        </button>

                                        {isOpen && (() => {
                                            // Recupera lo stock totale per questo alunno dal tab Consumo (già caricato)
                                            const studentStocks = consumoStudents.find(s => s.id === student.id)?.stocks ?? [];
                                            return (
                                                <div className="p-4 bg-kidville-cream/50 border-t border-kidville-line space-y-3">

                                                    {/* Stock totale attuale */}
                                                    {studentStocks.length > 0 && (
                                                        <div className="rounded-xl bg-kidville-green/5 border border-kidville-green/10 px-3 py-2">
                                                            <p className="text-[10px] font-bold text-kidville-green uppercase tracking-wide mb-1.5">📦 Stock Totale Attuale</p>
                                                            <div className="flex gap-3 flex-wrap">
                                                                {studentStocks.map((s) => (
                                                                    <span key={s.materiale} className="text-xs font-maven font-semibold text-kidville-ink">
                                                                        {s.materiale}: <strong className="text-kidville-green">{s.stock} pz</strong>
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Consegne di oggi */}
                                                    {todayCount > 0 ? (
                                                        <div className="space-y-1.5">
                                                            <p className="text-[10px] font-bold text-kidville-success uppercase tracking-wide">✅ Consegnato oggi</p>
                                                            {student.inventario.map((item, idx) => {
                                                                const matStock = studentStocks.find((s) => s.materiale === (item.materiale ?? item.nome_oggetto))?.stock ?? 0;
                                                                return (
                                                                    <div key={idx} className="flex items-center justify-between bg-white rounded-xl px-4 py-2 border border-kidville-success/20">
                                                                        <span className="font-maven font-semibold text-kidville-green text-sm">
                                                                            {item.materiale ?? item.nome_oggetto}
                                                                        </span>
                                                                        <div className="text-right">
                                                                            <span className="font-barlow font-black text-kidville-success block">+{item.quantita} pz</span>
                                                                            <span className="text-[10px] text-kidville-muted">Totale: {matStock} pz</span>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <p className="text-center text-kidville-muted text-sm py-2">Nessuna consegna registrata oggi</p>
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
                        classeSezione={sezione}
                        onConfirm={handleLoadStock}
                    />
                </>
            )}

            {/* ══════════════════════ CONSUMO ══════════════════════════════════ */}
            {view === 'consumo' && (
                <>
                    <div className="mb-4 bg-kidville-warn-soft border border-kidville-warn/30 rounded-2xl px-4 py-3 text-xs text-kidville-warn font-maven">
                        <strong>👆 Tocca un materiale</strong> per registrare che l&apos;hai utilizzato. Lo stock si aggiorna in tempo reale.
                    </div>

                    {consumoLoading ? (
                        <div className="text-center py-10 text-kidville-muted">Caricamento stock...</div>
                    ) : (
                        <div className="space-y-3">
                            {consumoStudents.map(student => {
                                const isOpen = expandedConsumo === student.id;
                                const hasStock = student.stocks.some(s => s.stock > 0);
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-kidville-line overflow-hidden">
                                        <button
                                            onClick={() => setExpandedConsumo(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-kidville-cream"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-kidville-muted">{student.stocks.length} materiali in stock</p>
                                            </div>
                                            {!hasStock && (
                                                <span className="bg-kidville-error-soft text-kidville-error text-[10px] font-bold px-2 py-0.5 rounded-full">ESAURITO</span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-kidville-muted" /> : <ChevronRight size={18} className="text-kidville-muted" />}
                                        </button>

                                        {isOpen && (
                                            <div className="p-4 bg-kidville-cream/50 border-t border-kidville-line space-y-2">
                                                {student.stocks.length === 0 ? (
                                                    <p className="text-center text-kidville-muted text-sm py-3">Nessun materiale in stock</p>
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
                                                                        ? 'border-kidville-warn bg-kidville-warn-soft'
                                                                        : item.stock === 0
                                                                            ? 'border-kidville-error/20 bg-kidville-error-soft opacity-60'
                                                                            : 'border-kidville-line bg-white hover:border-kidville-warn/30 hover:bg-kidville-warn-soft/50'}`}
                                                            >
                                                                <span className="font-maven font-semibold text-sm text-kidville-green">{item.materiale}</span>
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`font-barlow font-black text-lg ${item.stock === 0 ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                                                        {item.stock} pz
                                                                    </span>
                                                                    <MinusCircle size={18} className={item.stock > 0 ? 'text-kidville-warn' : 'text-kidville-muted'} />
                                                                </div>
                                                            </button>

                                                            {/* Form consumo inline */}
                                                            {isFormOpen && (
                                                                <div className="mt-1 px-4 py-3 bg-kidville-warn-soft border border-kidville-warn/30 rounded-xl space-y-3">
                                                                    <p className="text-xs text-kidville-warn font-maven">
                                                                        Quante unità di <strong>{item.materiale}</strong> hai utilizzato?
                                                                    </p>
                                                                    <div className="flex items-center gap-3">
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.max(1, q - 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-kidville-warn/30 flex items-center justify-center text-kidville-warn font-black hover:bg-kidville-warn-soft"
                                                                        >-</button>
                                                                        <span className="font-barlow font-black text-2xl text-kidville-green w-8 text-center">{consumoQty}</span>
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.min(item.stock, q + 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-kidville-warn/30 flex items-center justify-center text-kidville-warn font-black hover:bg-kidville-warn-soft"
                                                                        >+</button>
                                                                        <button
                                                                            onClick={handleConsumo}
                                                                            disabled={consumoSaving || consumoQty > item.stock}
                                                                            className="flex-1 h-9 bg-kidville-warn text-white rounded-xl font-barlow font-black text-sm disabled:opacity-50 hover:bg-kidville-warn-dark active:scale-95 transition-all"
                                                                        >
                                                                            {consumoSaving ? '...' : '✓ Conferma'}
                                                                        </button>
                                                                        <button onClick={() => setConsumoForm(null)} className="text-kidville-muted text-xs">Annulla</button>
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
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-semibold text-kidville-green/70">Consegne mensili</span>
                        <button id="next-month-btn" onClick={() => setMonth(m => shiftMonth(m, 1))}
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronRightIcon size={18} />
                        </button>
                    </div>
                    {mensileLoading ? (
                        <div className="flex items-center justify-center py-16 gap-3">
                            <div className="w-5 h-5 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                            <span className="text-kidville-muted text-sm">Caricamento...</span>
                        </div>
                    ) : (
                        <MonthlyLockerTable students={mensileStudents} month={month} hideStudentColumn={false} />
                    )}
                </div>
            )}
        </div>
    );
}

export default function TeacherLockerPage() {
    return (
        <Suspense fallback={null}>
            <TeacherLockerInner />
        </Suspense>
    );
}
