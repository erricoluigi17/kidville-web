'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutGrid, CalendarDays, Loader2, WifiOff, Users, RefreshCw, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { LocalDelegate } from '@/lib/offline/db';
import { StudentAttendanceRow, AttendanceRecord, AttendanceStato } from '@/components/features/teacher/StudentAttendanceRow';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';
import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';

// ─── Costanti ─────────────────────────────────────────────────────────────────

const SEZIONE = 'Girasoli';

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

// ─── Tab ──────────────────────────────────────────────────────────────────────

type Tab = 'oggi' | 'mese';

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
    { id: 'oggi', label: 'Oggi',   icon: LayoutGrid },
    { id: 'mese', label: 'Mese',   icon: CalendarDays },
];

const tabContentVariants = {
    enter: (direction: number) => ({
        x: direction > 0 ? 32 : -32,
        opacity: 0,
    }),
    center: {
        x: 0,
        opacity: 1,
        transition: { duration: 0.28, ease: 'easeInOut' as const },
    },
    exit: (direction: number) => ({
        x: direction > 0 ? -32 : 32,
        opacity: 0,
        transition: { duration: 0.2, ease: 'easeInOut' as const },
    }),
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
        <div className="flex items-center gap-2 bg-white/60 backdrop-blur-sm rounded-2xl p-2 border border-white/80 shadow-sm">
            <button
                onClick={() => onChange(addDays(date, -1))}
                className="w-8 h-8 rounded-xl bg-white/80 border border-gray-200 flex items-center justify-center text-gray-500 hover:text-kidville-green hover:border-kidville-green/30 transition-all"
                title="Giorno precedente"
            >
                <ChevronLeft size={15} />
            </button>

            <div className="relative flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-gray-200 hover:border-kidville-green/40 transition-all cursor-pointer">
                <Calendar size={14} className="text-kidville-green flex-shrink-0" />
                <input
                    type="date"
                    value={date}
                    max={todayISO}
                    onChange={e => e.target.value && onChange(e.target.value)}
                    className="font-maven text-sm font-medium text-gray-700 bg-transparent outline-none cursor-pointer w-32"
                />
            </div>

            <button
                onClick={() => !isToday && onChange(addDays(date, 1))}
                disabled={isToday}
                className="w-8 h-8 rounded-xl bg-white/80 border border-gray-200 flex items-center justify-center text-gray-500 hover:text-kidville-green hover:border-kidville-green/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                title="Giorno successivo"
            >
                <ChevronRight size={15} />
            </button>

            {!isToday && (
                <button
                    onClick={() => onChange(todayISO)}
                    className="px-3 py-1.5 rounded-xl bg-kidville-green text-white font-maven text-xs font-semibold hover:opacity-90 transition-all"
                >
                    Oggi
                </button>
            )}
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
    const [isOffline, setIsOffline] = useState(false);

    // ── Fetch studenti reali dall'anagrafica Supabase ──
    const fetchStudents = useCallback(async () => {
        const res = await fetch(`/api/diary/students?sezione=${SEZIONE}`);
        if (!res.ok) throw new Error('Errore caricamento alunni');
        const data = await res.json();
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
        setRecords({});
        const res = await fetch(`/api/attendance/daily?data=${selectedDate}&sezione=${SEZIONE}`);
        if (!res.ok) return;
        const rows = await res.json();
        if (Array.isArray(rows)) {
            const map: Record<string, AttendanceRecord> = {};
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
            setRecords(map);
        }
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
        setIsLoading(true);
        setError(null);
        try {
            const [studs] = await Promise.all([
                fetchStudents(),
                fetchTodayRecords(),
                fetchDelegates(),
            ]);
            setStudents(studs);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Errore caricamento dati');
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
        setIsOffline(!navigator.onLine);
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

    const presentiCount = Object.values(records).filter(r =>
        r.stato === 'presente' || r.stato === 'ritardo' || r.stato === 'uscita_anticipata'
    ).length;

    // ── Stati UI ──
    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <Loader2 size={32} className="text-kidville-green animate-spin" />
                <p className="font-maven text-gray-500 text-sm">Caricamento alunni da anagrafica…</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <p className="font-maven text-kidville-error text-sm">⚠️ {error}</p>
                <button
                    onClick={loadAll}
                    className="px-4 py-2 bg-kidville-green text-white font-maven text-sm rounded-xl hover:opacity-90 flex items-center gap-2"
                >
                    <RefreshCw size={14} /> Riprova
                </button>
            </div>
        );
    }

    if (students.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <span className="text-5xl opacity-30">👶</span>
                <p className="font-maven text-gray-400 text-sm text-center">
                    Nessun alunno nella sezione <strong>{SEZIONE}</strong>.<br />
                    Verifica che gli alunni abbiano la sezione corretta in anagrafica.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Navigatore data + intestazione */}
            <div className="bg-white/60 backdrop-blur-sm rounded-2xl p-4 border border-white/80 shadow-sm flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <p className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-widest mb-1">
                            Presenze del giorno
                        </p>
                        <p className="font-maven text-gray-500 text-sm capitalize">
                            {formatDateIT(selectedDate)}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {isOffline && (
                            <div className="flex items-center gap-1.5 bg-kidville-warn-soft border border-kidville-warn/30 text-kidville-warn px-3 py-1.5 rounded-full text-xs font-maven">
                                <WifiOff size={12} /> Offline
                            </div>
                        )}
                        <button
                            onClick={fetchTodayRecords}
                            title="Aggiorna presenze"
                            className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/80 border border-white/80 text-gray-400 hover:text-kidville-green transition-colors"
                        >
                            <RefreshCw size={14} />
                        </button>
                        <div className="flex items-center gap-2 bg-kidville-green/8 border border-kidville-green/15 rounded-xl px-3 py-1.5">
                            <span className="w-2 h-2 rounded-full bg-kidville-green animate-pulse" />
                            <span className="font-maven text-xs text-kidville-green font-semibold">
                                {presentiCount}/{students.length} presenti
                            </span>
                        </div>
                    </div>
                </div>
                {/* Selettore data */}
                <DateNavigator date={selectedDate} onChange={setSelectedDate} />
            </div>

            {/* Legenda stati */}
            <div className="flex items-center gap-4 px-1 text-xs font-maven text-gray-400">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-kidville-success inline-block" />Presente</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-kidville-warn inline-block" />Ritardo</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" />Uscita Ant.</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block" />Assente</span>
            </div>

            {/* Lista studenti */}
            <div className="flex flex-col gap-2">
                {students.map(student => (
                    <StudentAttendanceRow
                        key={student.id}
                        student={student}
                        record={records[student.id]}
                        onSetStato={handleSetStato}
                        onCheckoutClick={setSelectedCheckout}
                        isLoading={loadingStudentId === student.id}
                    />
                ))}
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
        <div className="min-h-screen" style={{ background: 'linear-gradient(160deg, hsl(145,30%,97%) 0%, hsl(200,25%,95%) 100%)' }}>
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

                {/* ── Page Header ── */}
                <div className="mb-6">
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                        Registro Presenze
                    </h1>
                    <p className="font-maven text-gray-500 mt-1 flex items-center gap-2">
                        <Users size={15} />
                        Sezione {SEZIONE}
                    </p>
                </div>

                {/* ── Tab Switcher ── */}
                <div className="mb-6 inline-flex bg-white/70 backdrop-blur-sm border border-white/80 rounded-2xl p-1 shadow-sm gap-1">
                    {TABS.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                id={`tab-attendance-${tab.id}`}
                                onClick={() => handleTabChange(tab.id)}
                                className={`
                                    relative flex items-center gap-2 px-4 py-2 rounded-xl font-maven font-semibold text-sm
                                    transition-all duration-200
                                    ${isActive ? 'text-white shadow-md' : 'text-gray-500 hover:text-kidville-green hover:bg-white/60'}
                                `}
                            >
                                {isActive && (
                                    <motion.div
                                        layoutId="tab-bg-attendance"
                                        className="absolute inset-0 rounded-xl bg-kidville-green"
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
                <div className="relative overflow-hidden">
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
                                <div className="bg-white/60 backdrop-blur-sm rounded-3xl p-5 sm:p-6 border border-white/80 shadow-sm">
                                    <MonthlyAttendanceTable sezione={SEZIONE} />
                                </div>
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </div>
        </div>
    );
}
