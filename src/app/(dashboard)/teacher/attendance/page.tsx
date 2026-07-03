'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutGrid, CalendarDays, Loader2, WifiOff, Users, RefreshCw, ChevronLeft, ChevronRight, Calendar, Check } from 'lucide-react';
import { LocalDelegate } from '@/lib/offline/db';
import { StudentAttendanceRow, AttendanceRecord, AttendanceStato } from '@/components/features/teacher/StudentAttendanceRow';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';
import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';

// ─── Costanti ─────────────────────────────────────────────────────────────────

const SEZIONE = 'Girasoli';

// Scala stati con i token brand (DR STATI). Sostituisce i colori off-token
// (blu/grigio) della versione glassmorphism precedente.
const STATI: Record<string, { label: string; tint: string; soft: string }> = {
    presente: { label: 'Presenti', tint: 'var(--color-kidville-success)', soft: 'var(--color-kidville-success-soft)' },
    ritardo: { label: 'Ritardo', tint: 'var(--color-kidville-warn)', soft: 'var(--color-kidville-warn-soft)' },
    uscita_anticipata: { label: 'Uscita', tint: 'var(--color-kidville-info)', soft: 'var(--color-kidville-info-soft)' },
    assente: { label: 'Assenti', tint: 'var(--color-kidville-neutral)', soft: 'var(--color-kidville-neutral-soft)' },
};

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

type FilterKey = 'tutti' | 'todo' | AttendanceStato;

// ─── Tab ──────────────────────────────────────────────────────────────────────

type Tab = 'oggi' | 'mese';

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { id: 'oggi', label: 'Oggi', icon: LayoutGrid },
    { id: 'mese', label: 'Mese', icon: CalendarDays },
];

const tabContentVariants = {
    enter: (direction: number) => ({ x: direction > 0 ? 32 : -32, opacity: 0 }),
    center: { x: 0, opacity: 1, transition: { duration: 0.28, ease: 'easeInOut' as const } },
    exit: (direction: number) => ({ x: direction > 0 ? -32 : 32, opacity: 0, transition: { duration: 0.2, ease: 'easeInOut' as const } }),
};

// ─── Utility data ─────────────────────────────────────────────────────────────

function toISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso: string, n: number): string {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return toISO(d);
}

function formatDateIT(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Navigatore Data ─────────────────────────────────────────────────────────

function DateNavigator({ date, onChange }: { date: string; onChange: (d: string) => void }) {
    const todayISO = toISO(new Date());
    const isToday = date === todayISO;

    return (
        <div className="flex items-center gap-2 rounded-2xl border border-kidville-line bg-kidville-cream p-2">
            <button
                onClick={() => onChange(addDays(date, -1))}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-kidville-green shadow-sm"
                title="Giorno precedente"
            >
                <ChevronLeft size={15} />
            </button>

            <div className="relative flex flex-1 items-center gap-2 rounded-xl bg-white px-3 py-1.5 shadow-sm">
                <Calendar size={14} className="flex-shrink-0 text-kidville-green" />
                <input
                    type="date"
                    value={date}
                    max={todayISO}
                    onChange={(e) => e.target.value && onChange(e.target.value)}
                    className="w-full cursor-pointer bg-transparent font-maven text-sm font-medium text-kidville-ink outline-none"
                />
            </div>

            <button
                onClick={() => !isToday && onChange(addDays(date, 1))}
                disabled={isToday}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-kidville-green shadow-sm disabled:cursor-not-allowed disabled:opacity-30"
                title="Giorno successivo"
            >
                <ChevronRight size={15} />
            </button>

            {!isToday && (
                <button
                    onClick={() => onChange(todayISO)}
                    className="rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-semibold text-kidville-yellow"
                >
                    Oggi
                </button>
            )}
        </div>
    );
}

// ─── Card riepilogo + filtro (DR Summary) ──────────────────────────────────────

function Summary({
    counts, total, filter, onFilter,
}: {
    counts: Record<string, number>;
    total: number;
    filter: FilterKey;
    onFilter: (f: FilterKey) => void;
}) {
    const reg = (counts.presente ?? 0) + (counts.ritardo ?? 0) + (counts.uscita_anticipata ?? 0) + (counts.assente ?? 0);
    const safeTot = total || 1;
    const chips: { key: FilterKey; label: string; n: number; tint: string; soft: string }[] = [
        { key: 'tutti', label: 'Tutti', n: total, tint: 'var(--color-kidville-green)', soft: 'var(--color-kidville-green-soft)' },
        { key: 'presente', label: 'Presenti', n: counts.presente ?? 0, tint: STATI.presente.tint, soft: STATI.presente.soft },
        { key: 'ritardo', label: 'Ritardo', n: counts.ritardo ?? 0, tint: STATI.ritardo.tint, soft: STATI.ritardo.soft },
        { key: 'uscita_anticipata', label: 'Uscita', n: counts.uscita_anticipata ?? 0, tint: STATI.uscita_anticipata.tint, soft: STATI.uscita_anticipata.soft },
        { key: 'assente', label: 'Assenti', n: counts.assente ?? 0, tint: STATI.assente.tint, soft: STATI.assente.soft },
        { key: 'todo', label: 'Da registrare', n: total - reg, tint: 'var(--color-kidville-yellow-dark)', soft: 'var(--color-kidville-yellow-soft)' },
    ];

    return (
        <div>
            <div className="rounded-[20px] bg-white p-4" style={{ boxShadow: '0 1px 2px rgba(0,84,75,.05), 0 10px 28px -20px rgba(0,84,75,.4)' }}>
                <div className="flex items-end justify-between gap-3">
                    <div>
                        <div className="font-barlow text-[11px] font-bold uppercase tracking-[0.12em] text-kidville-yellow-dark">Sezione {SEZIONE}</div>
                        <div className="mt-0.5 flex items-baseline gap-1.5">
                            <span className="font-barlow text-[34px] font-black leading-none text-kidville-green">{reg}</span>
                            <span className="font-barlow text-lg font-extrabold text-kidville-muted">/ {total}</span>
                            <span className="ml-0.5 font-maven text-xs text-kidville-ink">registrati</span>
                        </div>
                    </div>
                    {reg === total && total > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-success-soft px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase text-kidville-success"><Check size={11} strokeWidth={2.8} /> Completo</span>
                    ) : (
                        <span className="rounded-pill bg-kidville-yellow-soft px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase text-kidville-yellow-dark">{total - reg} mancanti</span>
                    )}
                </div>
                <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-kidville-cream-dark">
                    <div style={{ width: `${(counts.presente ?? 0) / safeTot * 100}%`, background: STATI.presente.tint }} />
                    <div style={{ width: `${(counts.ritardo ?? 0) / safeTot * 100}%`, background: STATI.ritardo.tint }} />
                    <div style={{ width: `${(counts.uscita_anticipata ?? 0) / safeTot * 100}%`, background: STATI.uscita_anticipata.tint }} />
                    <div style={{ width: `${(counts.assente ?? 0) / safeTot * 100}%`, background: STATI.assente.tint }} />
                </div>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {chips.map((c) => {
                    const on = filter === c.key;
                    return (
                        <button
                            key={c.key}
                            onClick={() => onFilter(c.key)}
                            className="flex shrink-0 items-center gap-1.5 rounded-pill bg-white py-1.5 pl-2 pr-3"
                            style={on ? { boxShadow: `inset 0 0 0 1.5px ${c.tint}`, background: c.soft } : { boxShadow: '0 1px 2px rgba(0,84,75,.05)' }}
                        >
                            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 font-barlow text-xs font-extrabold text-white" style={{ background: c.tint }}>{c.n}</span>
                            <span className="font-barlow text-xs font-extrabold uppercase tracking-wide" style={{ color: on ? c.tint : '#6c766f' }}>{c.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Vista Oggi ───────────────────────────────────────────────────────────────

function TodayView() {
    const [selectedDate, setSelectedDate] = useState(toISO(new Date()));

    const [students, setStudents] = useState<Student[]>([]);
    const [records, setRecords] = useState<Record<string, AttendanceRecord>>({});
    const [delegates, setDelegates] = useState<LocalDelegate[]>([]);
    const [selectedCheckout, setSelectedCheckout] = useState<string | null>(null);
    const [loadingStudentId, setLoadingStudentId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
    const [filter, setFilter] = useState<FilterKey>('tutti');

    // ── Fetch studenti reali dall'anagrafica Supabase ──
    // Restituisce null in caso di errore (rete o HTTP), mai eccezioni.
    const fetchStudents = useCallback(async (): Promise<Student[] | null> => {
        const res = await fetch(`/api/diary/students?sezione=${SEZIONE}`).catch(() => null);
        if (!res?.ok) return null;
        const data = await res.json().catch(() => null);
        if (Array.isArray(data)) {
            return data.map((a: { id: string; nome: string; cognome: string }) => ({
                id: a.id,
                firstName: a.nome,
                lastName: a.cognome,
            }));
        }
        return [];
    }, []);

    // ── Fetch presenze del giorno selezionato da Supabase ──
    const fetchTodayRecords = useCallback(async () => {
        const res = await fetch(`/api/attendance/daily?data=${selectedDate}&sezione=${SEZIONE}`).catch(() => null);
        const rows = res?.ok ? await res.json().catch(() => null) : null;
        const map: Record<string, AttendanceRecord> = {};
        if (Array.isArray(rows)) {
            rows.forEach((row: {
                alunno_id: string;
                id?: string;
                data: string;
                stato: AttendanceStato;
                orario_entrata: string | null;
                orario_uscita: string | null;
            }) => {
                map[row.alunno_id] = {
                    id: row.id,
                    alunno_id: row.alunno_id,
                    data: row.data,
                    stato: row.stato,
                    orario_entrata: row.orario_entrata,
                    orario_uscita: row.orario_uscita,
                };
            });
        }
        setRecords(map);
    }, [selectedDate]);

    // ── Fetch delegati ──
    const fetchDelegates = useCallback(async () => {
        try {
            const res = await fetch(`/api/attendance/delegates?sezione=${SEZIONE}`);
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data)) setDelegates(data);
        } catch { /* non bloccante */ }
    }, []);

    // ── Caricamento iniziale ──
    const loadAll = useCallback(async () => {
        try {
            const [studs] = await Promise.all([
                fetchStudents(),
                fetchTodayRecords(),
                fetchDelegates(),
            ]);
            if (studs) {
                setStudents(studs);
                setError(null);
            } else {
                setError('Errore caricamento alunni');
            }
        } finally {
            setIsLoading(false);
        }
    }, [fetchStudents, fetchTodayRecords, fetchDelegates]);

    useEffect(() => {
        loadAll();
        const onOnline = () => setIsOffline(false);
        const onOffline = () => setIsOffline(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [loadAll]);

    // ── Cambia stato — scrive DIRETTAMENTE su Supabase ──
    const handleSetStato = async (studentId: string, stato: AttendanceStato) => {
        setLoadingStudentId(studentId);
        const now = new Date().toISOString();

        const orario_entrata = stato === 'assente' ? null : (records[studentId]?.orario_entrata ?? now);
        const orario_uscita = stato === 'uscita_anticipata' ? now : null;

        // Ottimistic update
        setRecords(prev => ({
            ...prev,
            [studentId]: {
                alunno_id: studentId,
                data: selectedDate,
                stato,
                orario_entrata,
                orario_uscita,
            }
        }));

        try {
            const res = await fetch('/api/attendance/daily', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: studentId, data: selectedDate, stato, orario_entrata, orario_uscita }),
            });
            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error ?? 'Errore salvataggio');
            }
            const saved = await res.json();
            setRecords(prev => ({ ...prev, [studentId]: saved }));
        } catch (err) {
            console.error('Errore salvataggio presenza:', err);
            // Rollback ottimistico
            setRecords(prev => {
                const next = { ...prev };
                delete next[studentId];
                return next;
            });
        } finally {
            setLoadingStudentId(null);
        }
    };

    // ── Panic alert ──
    const handlePanicAlert = async () => {
        if (!selectedCheckout) return;
        try {
            const res = await fetch('/api/panic-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunnoId: selectedCheckout }),
            });
            if (res.ok) {
                alert('ALLARME INVIATO CON SUCCESSO!');
                setSelectedCheckout(null);
            } else {
                alert('Errore invio allarme.');
            }
        } catch {
            alert('Errore di rete. Allarme non inviato.');
        }
    };

    // ── Checkout delegato ──
    const handleConfirmCheckout = async () => {
        if (!selectedCheckout) return;
        await handleSetStato(selectedCheckout, 'uscita_anticipata');
        setSelectedCheckout(null);
    };

    const checkoutStudent = students.find(s => s.id === selectedCheckout);
    const studentDelegates = delegates.filter(d => d.alunno_id === selectedCheckout);

    const counts = useMemo(() => {
        const c: Record<string, number> = { presente: 0, ritardo: 0, uscita_anticipata: 0, assente: 0 };
        Object.values(records).forEach((r) => { if (r.stato in c) c[r.stato] += 1; });
        return c;
    }, [records]);

    const visibleStudents = useMemo(() => {
        if (filter === 'tutti') return students;
        if (filter === 'todo') return students.filter((s) => !records[s.id]);
        return students.filter((s) => records[s.id]?.stato === filter);
    }, [students, records, filter]);

    // ── Stati UI ──
    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <Loader2 size={32} className="animate-spin text-kidville-green" />
                <p className="font-maven text-sm text-kidville-muted">Caricamento alunni da anagrafica…</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <p className="font-maven text-sm text-kidville-error">⚠️ {error}</p>
                <button
                    onClick={loadAll}
                    className="flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-maven text-sm text-kidville-yellow"
                >
                    <RefreshCw size={14} /> Riprova
                </button>
            </div>
        );
    }

    if (students.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <span className="text-5xl opacity-30">👶</span>
                <p className="text-center font-maven text-sm text-kidville-muted">
                    Nessun alunno nella sezione <strong>{SEZIONE}</strong>.<br />
                    Verifica che gli alunni abbiano la sezione corretta in anagrafica.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {/* Navigatore data + intestazione */}
            <div className="flex flex-col gap-3 rounded-2xl border border-kidville-line bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-maven text-sm capitalize text-kidville-muted">{formatDateIT(selectedDate)}</p>
                    <div className="flex items-center gap-2">
                        {isOffline && (
                            <div className="flex items-center gap-1.5 rounded-pill border border-kidville-warn/30 bg-kidville-warn-soft px-3 py-1.5 font-maven text-xs text-kidville-warn">
                                <WifiOff size={12} /> Offline
                            </div>
                        )}
                        <button
                            onClick={fetchTodayRecords}
                            title="Aggiorna presenze"
                            className="flex h-8 w-8 items-center justify-center rounded-xl bg-kidville-cream text-kidville-muted transition-colors hover:text-kidville-green"
                        >
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>
                <DateNavigator date={selectedDate} onChange={setSelectedDate} />
            </div>

            {/* Card riepilogo + chip filtro */}
            <Summary counts={counts} total={students.length} filter={filter} onFilter={setFilter} />

            {/* Lista studenti (filtrata) */}
            <div className="flex flex-col gap-2">
                {visibleStudents.map(student => (
                    <StudentAttendanceRow
                        key={student.id}
                        student={student}
                        record={records[student.id]}
                        onSetStato={handleSetStato}
                        onCheckoutClick={setSelectedCheckout}
                        isLoading={loadingStudentId === student.id}
                    />
                ))}
                {visibleStudents.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-kidville-line bg-white/60 p-6 text-center font-maven text-sm text-kidville-muted">
                        Nessun alunno per questo filtro.
                    </div>
                )}
            </div>

            {/* Modal uscita delegato */}
            {selectedCheckout && checkoutStudent && (
                <CheckoutModal
                    studentName={`${checkoutStudent.firstName} ${checkoutStudent.lastName}`}
                    delegates={studentDelegates}
                    onClose={() => setSelectedCheckout(null)}
                    onConfirmCheckout={handleConfirmCheckout}
                    onPanicAlert={handlePanicAlert}
                />
            )}
        </div>
    );
}

// ─── Pagina Principale ────────────────────────────────────────────────────────

export default function TeacherAttendancePage() {
    const [activeTab, setActiveTab] = useState<Tab>('oggi');
    const [prevTab, setPrevTab] = useState<Tab>('oggi');

    const direction = TABS.findIndex(t => t.id === activeTab) - TABS.findIndex(t => t.id === prevTab);

    const handleTabChange = (tab: Tab) => {
        if (tab === activeTab) return;
        setPrevTab(activeTab);
        setActiveTab(tab);
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* ── Header verde (DR) ── */}
            <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">Registro</p>
                <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">Appello</h1>
                <span className="mt-2 inline-flex items-center gap-1.5 rounded-pill bg-white/15 px-2.5 py-1 font-maven text-xs font-semibold text-white backdrop-blur">
                    <Users size={13} /> Sezione {SEZIONE}
                </span>
            </div>

            {/* ── Tab Switcher ── */}
            <div className="mt-4 inline-flex gap-1 rounded-pill bg-white p-1 shadow-sm">
                {TABS.map(tab => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            id={`tab-attendance-${tab.id}`}
                            onClick={() => handleTabChange(tab.id)}
                            className={`relative flex items-center gap-2 rounded-pill px-4 py-2 font-maven text-sm font-semibold transition-all duration-200 ${isActive ? 'text-kidville-yellow' : 'text-kidville-muted hover:text-kidville-green'}`}
                        >
                            {isActive && (
                                <motion.div
                                    layoutId="tab-bg-attendance"
                                    className="absolute inset-0 rounded-pill bg-kidville-green"
                                    style={{ zIndex: 0 }}
                                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                                />
                            )}
                            <Icon size={15} className="relative z-10" />
                            <span className="relative z-10">{tab.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* ── Tab Content ── */}
            <div className="relative mt-4 overflow-hidden">
                <AnimatePresence initial={false} custom={direction} mode="wait">
                    <motion.div
                        key={activeTab}
                        custom={direction}
                        variants={tabContentVariants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                    >
                        {activeTab === 'oggi' && <TodayView />}

                        {activeTab === 'mese' && (
                            <div className="overflow-x-auto rounded-3xl border border-kidville-line bg-white p-4 shadow-sm">
                                <MonthlyAttendanceTable sezione={SEZIONE} />
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
            </div>
        </div>
    );
}
