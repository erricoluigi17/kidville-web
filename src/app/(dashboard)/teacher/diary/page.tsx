'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Minus, Clock, Users, WifiOff, ChevronDown, ChevronRight } from 'lucide-react';
import { DiaryEventType } from '@/lib/offline/db';
import { EventTypeButton } from '@/components/features/teacher/diary/EventTypeButton';
import { EVENT_CONFIG } from '@/components/features/teacher/diary/eventConfig';

interface Student { id: string; firstName: string; lastName: string; allergie: string[]; }

const SEZIONE = 'Girasoli';
const MAESTRA_ID = '22222222-2222-2222-2222-222222222222'; // dev default

// Nomi reali dal modulo Mensa (in futuro da Supabase)
const MOCK_MEAL_COURSES = [
    { id: 'primo', nome: 'Pasta al Pomodoro', portata: 'Primo piatto', icon: '🍝' },
    { id: 'secondo', nome: 'Pollo Arrosto', portata: 'Secondo piatto', icon: '🍗' },
    { id: 'contorno', nome: 'Insalata Mista', portata: 'Contorno', icon: '🥗' },
    { id: 'frutta', nome: 'Macedonia di Frutta', portata: 'Frutta', icon: '🍎' },
];

const MEAL_QUANTITIES = [
    { value: 'niente', short: '✗' },
    { value: 'poco', short: '¼' },
    { value: 'meta', short: '½' },
    { value: 'quasi', short: '¾' },
    { value: 'tutto', short: '★' },
];

const PARTICIPATION_LEVELS = [
    { value: 'non_fatta', label: 'Non fatta', bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200' },
    { value: 'difficolta', label: 'Con difficoltà', bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200' },
    { value: 'aiuto', label: 'Con aiuto', bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200' },
    { value: 'autonomia', label: 'In autonomia', bg: 'bg-emerald-100', text: 'text-emerald-700', border: 'border-emerald-200' },
];

// Nanna e Sveglia unificate in un unico pulsante "Nanna"
const ALL_EVENT_TYPES: DiaryEventType[] = ['entrata', 'attivita', 'merenda', 'pranzo', 'nanna_inizio', 'bagno'];

function now() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildInitialState(type: DiaryEventType, students: Student[]) {
    const state: Record<string, Record<string, unknown>> = {};
    students.forEach(s => {
        if (type === 'entrata') state[s.id] = { orario: now() };
        else if (type === 'attivita') state[s.id] = { partecipazione: null };
        else if (type === 'pranzo') {
            const corsi: Record<string, string | null> = {};
            MOCK_MEAL_COURSES.forEach(c => { corsi[c.id] = null; });
            state[s.id] = { corsi };
        } else if (type === 'merenda') {
            state[s.id] = { corsi: { merenda: null } };
        } else if (type === 'nanna_inizio') {
            state[s.id] = { orario_inizio: '', orario_fine: '' };
        } else if (type === 'bagno') {
            state[s.id] = { pipi: 0, cacca: 0 };
        } else {
            state[s.id] = {};
        }
    });
    return state;
}

function StudentAvatar({ student, meal = false }: { student: Student; meal?: boolean }) {
    const hasAllergie = meal && student.allergie.length > 0;
    return (
        <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs ${hasAllergie ? 'bg-kidville-error text-white' : 'bg-kidville-cream text-kidville-green'}`}>
            {student.firstName[0]}{student.lastName[0]}
        </div>
    );
}

export default function TeacherDiaryPage() {
    const [students, setStudents] = useState<Student[]>([]);
    const [selectedEvent, setSelectedEvent] = useState<DiaryEventType>('entrata');
    const [isSheetOpen, setIsSheetOpen] = useState(false);
    const [studentStates, setStudentStates] = useState<Record<string, Record<string, unknown>>>({});
    const [isOffline, setIsOffline] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [expandedCourse, setExpandedCourse] = useState<string | null>('primo');
    const [savedStudentIds, setSavedStudentIds] = useState<Set<string>>(new Set());
    const [showSavedToast, setShowSavedToast] = useState(false);

    // Carica studenti da Supabase all'avvio
    useEffect(() => {
        fetchStudents();
        const onOnline = () => setIsOffline(false);
        const onOffline = () => setIsOffline(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        setIsOffline(!navigator.onLine);
        return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    }, []);

    const fetchStudents = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/diary/students?sezione=${SEZIONE}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                const mapped: Student[] = data.map((a: { id: string; nome: string; cognome: string; note_mediche: string | null }) => ({
                    id: a.id,
                    firstName: a.nome,
                    lastName: a.cognome,
                    allergie: a.note_mediche ? a.note_mediche.split(',').map((s: string) => s.trim()) : [],
                }));
                setStudents(mapped);
                setStudentStates(buildInitialState('entrata', mapped));
                // Ripristina dati salvati per entrata
                restoreFromSupabase('entrata', mapped);
                setTimeout(() => setIsSheetOpen(true), 120);
            }
        } catch (err) {
            console.error('Errore caricamento alunni:', err);
        } finally {
            setIsLoading(false);
        }
    };

    // Ripristina lo stato UI dai dati già salvati su Supabase per un certo tipo evento
    const restoreFromSupabase = async (eventType: DiaryEventType, studentList?: Student[]) => {
        const list = studentList ?? students;
        if (list.length === 0) { setSavedStudentIds(new Set()); return; }
        try {
            const today = new Date().toISOString().split('T')[0];
            const res = await fetch(`/api/diary/entries?sezione=${SEZIONE}&date=${today}`);
            const entries = await res.json();
            if (!Array.isArray(entries)) { setSavedStudentIds(new Set()); return; }

            const filtered = entries.filter((e: { tipo_evento: string }) => e.tipo_evento === eventType);
            if (filtered.length === 0) { setSavedStudentIds(new Set()); return; }

            // Per ogni studente, prendi l'ultimo salvataggio
            const latestPerStudent: Record<string, { dettagli: Record<string, unknown> }> = {};
            filtered.forEach((e: { alunno_id: string; orario_inizio: string; dettagli: Record<string, unknown> }) => {
                if (!latestPerStudent[e.alunno_id] || e.orario_inizio > (latestPerStudent[e.alunno_id] as unknown as { orario_inizio: string }).orario_inizio) {
                    latestPerStudent[e.alunno_id] = e;
                }
            });

            const newState = buildInitialState(eventType, list);
            const savedIds = new Set<string>();
            Object.entries(latestPerStudent).forEach(([studentId, entry]) => {
                if (entry.dettagli && typeof entry.dettagli === 'object') {
                    newState[studentId] = entry.dettagli;
                    savedIds.add(studentId);
                }
            });
            setStudentStates(newState);
            setSavedStudentIds(savedIds);
        } catch (err) {
            console.error('Errore ripristino dati:', err);
            setSavedStudentIds(new Set());
        }
    };

    const handleEventSelect = (type: DiaryEventType) => {
        setSelectedEvent(type);
        setStudentStates(buildInitialState(type, students));
        setSavedStudentIds(new Set());
        if (type === 'pranzo') setExpandedCourse('primo');
        setIsSheetOpen(true);
        restoreFromSupabase(type);
    };

    const updateStudent = (id: string, updates: Record<string, unknown>) => {
        setStudentStates(prev => ({ ...prev, [id]: { ...prev[id], ...updates } }));
        setSavedStudentIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    };

    const updateMealCourse = (studentId: string, corsoId: string, value: string | null) => {
        const prev = (studentStates[studentId]?.corsi as Record<string, string | null>) ?? {};
        updateStudent(studentId, { corsi: { ...prev, [corsoId]: value } });
    };

    const counter = (id: string, field: 'pipi' | 'cacca', delta: number) => {
        const cur = (studentStates[id]?.[field] as number) ?? 0;
        updateStudent(id, { [field]: Math.max(0, cur + delta) });
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const nowIso = new Date().toISOString();
            const payload = students.map(student => ({
                alunno_id: student.id,
                maestra_id: MAESTRA_ID,
                tipo_evento: selectedEvent,
                orario_inizio: nowIso,
                dettagli: studentStates[student.id] ?? null,
            }));

            const res = await fetch('/api/diary/entries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Errore salvataggio');
            }

            setSavedStudentIds(new Set(students.map(s => s.id)));
            setShowSavedToast(true);
            setTimeout(() => setShowSavedToast(false), 2500);
        } catch (err) {
            console.error('Errore salvataggio:', err);
            alert('Errore nel salvataggio. Controlla la console.');
        } finally {
            setIsSaving(false);
        }
    };

    const cfg = EVENT_CONFIG[selectedEvent];
    const isMeal = selectedEvent === 'pranzo' || selectedEvent === 'merenda';
    const mealCourses = selectedEvent === 'merenda'
        ? [{ id: 'merenda', nome: 'Merenda', portata: 'Merenda', icon: '🍎' }]
        : MOCK_MEAL_COURSES;

    if (isLoading) {
        return (
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-gray-500">Caricamento alunni da Supabase...</p>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6">

            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">Diario del Giorno</h1>
                    <p className="font-maven text-gray-500 mt-1 flex items-center gap-2">
                        <Users size={15} />
                        Sezione Girasoli • {new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}
                    </p>
                </div>
                {isOffline && (
                    <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-600 px-3 py-1.5 rounded-full text-xs font-maven">
                        <WifiOff size={12} /> Offline
                    </div>
                )}
            </div>

            {/* Griglia eventi */}
            <div className="bg-white rounded-2xl p-4 shadow-sm">
                <p className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">Cosa vuoi registrare?</p>
                <div className="grid grid-cols-6 gap-2">
                    {ALL_EVENT_TYPES.map(type => (
                        <div key={type} className={`rounded-xl transition-all ${selectedEvent === type && isSheetOpen ? 'ring-2 ring-kidville-green ring-offset-1' : ''}`}>
                            <EventTypeButton type={type} disabled={false} onClick={handleEventSelect} />
                        </div>
                    ))}
                </div>
            </div>

            {/* ── BOTTOM SHEET ── */}
            {isSheetOpen && (
                <>
                    <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" onClick={() => setIsSheetOpen(false)} />

                    <div className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-kidville-cream rounded-t-3xl shadow-2xl max-h-[88vh] transition-transform duration-300 ${isSheetOpen ? 'translate-y-0' : 'translate-y-full'}`}>

                        {/* Handle + Header */}
                        <div className="flex-shrink-0 pt-3">
                            <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-3" />
                            <div className="flex items-center justify-between px-5 pb-3 border-b border-gray-200">
                                <div className="flex items-center gap-3">
                                    <span className="text-2xl">{cfg.emoji}</span>
                                    <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">{cfg.label}</h2>
                                </div>
                                <button onClick={() => setIsSheetOpen(false)} className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-gray-400 hover:text-gray-600 shadow-sm">
                                    <X size={16} />
                                </button>
                            </div>
                            {/* Allergie alert */}
                            {isMeal && students.some(s => s.allergie.length > 0) && (
                                <div className="mx-4 mt-2.5 p-2.5 rounded-xl bg-kidville-error/10 border border-kidville-error/20">
                                    <p className="font-barlow font-bold text-kidville-error uppercase text-xs tracking-wide">⚠️ Allergie — {students.filter(s => s.allergie.length > 0).map(s => `${s.firstName}: ${s.allergie.join(', ')}`).join(' • ')}</p>
                                </div>
                            )}
                        </div>

                        {/* Scrollable list */}
                        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">

                            {/* ENTRATA */}
                            {selectedEvent === 'entrata' && students.map(student => (
                                <div key={student.id} className="bg-white rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm">
                                    <StudentAvatar student={student} />
                                    <span className="flex-1 font-maven font-medium text-sm text-kidville-green">
                                        {student.firstName} {student.lastName}
                                        {savedStudentIds.has(student.id) && <span className="ml-1.5 text-emerald-500">✅</span>}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <Clock size={13} className="text-gray-400" />
                                        <input
                                            type="time"
                                            value={(studentStates[student.id]?.orario as string) ?? now()}
                                            onChange={e => updateStudent(student.id, { orario: e.target.value })}
                                            className="border-2 border-gray-200 rounded-xl px-2 py-1 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                        />
                                    </div>
                                </div>
                            ))}

                            {/* ATTIVITÀ */}
                            {selectedEvent === 'attivita' && students.map(student => {
                                const sel = studentStates[student.id]?.partecipazione as string | null;
                                return (
                                    <div key={student.id} className="bg-white rounded-xl px-4 py-3 shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <StudentAvatar student={student} />
                                            <span className="font-maven font-medium text-sm text-kidville-green">
                                                {student.firstName} {student.lastName}
                                                {savedStudentIds.has(student.id) && <span className="ml-1.5 text-emerald-500">✅</span>}
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-1.5">
                                            {PARTICIPATION_LEVELS.map(lv => (
                                                <button
                                                    key={lv.value}
                                                    onClick={() => updateStudent(student.id, { partecipazione: sel === lv.value ? null : lv.value })}
                                                    className={`py-2 rounded-xl border-2 text-xs font-maven font-semibold transition-all ${sel === lv.value ? `${lv.bg} ${lv.text} ${lv.border}` : 'bg-gray-50 text-gray-400 border-gray-100'}`}
                                                >
                                                    {lv.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}

                            {/* PRANZO / MERENDA — accordion per portata */}
                            {isMeal && mealCourses.map(corso => {
                                const isOpen = expandedCourse === corso.id;
                                return (
                                    <div key={corso.id} className="bg-white rounded-2xl overflow-hidden shadow-sm">
                                        <button
                                            onClick={() => setExpandedCourse(isOpen ? null : corso.id)}
                                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                                        >
                                            <span className="text-xl">{corso.icon}</span>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-sm text-kidville-green">{corso.nome}</p>
                                                <p className="font-maven text-xs text-gray-400">{corso.portata}</p>
                                            </div>
                                            {/* Conteggio compilati */}
                                            {(() => {
                                                const filled = students.filter(s => {
                                                    const c = studentStates[s.id]?.corsi as Record<string, string | null>;
                                                    return c?.[corso.id] != null;
                                                }).length;
                                                return filled > 0 ? (
                                                    <span className="text-xs font-maven font-bold text-kidville-green bg-kidville-cream px-2 py-0.5 rounded-full mr-1">{filled}/{students.length}</span>
                                                ) : null;
                                            })()}
                                            {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                                        </button>

                                        {isOpen && (
                                            <div className="border-t border-gray-100 divide-y divide-gray-50">
                                                {students.map(student => {
                                                    const corsi = studentStates[student.id]?.corsi as Record<string, string | null>;
                                                    const selQ = corsi?.[corso.id];
                                                    const hasAllergie = student.allergie.length > 0;
                                                    return (
                                                        <div key={student.id} className={`flex items-center gap-2 px-4 py-2.5 ${hasAllergie ? 'bg-kidville-error/5' : ''}`}>
                                                            <span className={`font-maven text-sm font-medium flex-shrink-0 w-24 truncate ${hasAllergie ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                                                {student.firstName} {hasAllergie ? '⚠️' : ''}
                                                            </span>
                                                            <div className="flex gap-1 flex-1">
                                                                {MEAL_QUANTITIES.map(q => (
                                                                    <button
                                                                        key={q.value}
                                                                        onClick={() => updateMealCourse(student.id, corso.id, selQ === q.value ? null : q.value)}
                                                                        className={`flex-1 py-2 rounded-lg text-xs font-bold border-2 transition-all ${selQ === q.value ? 'bg-kidville-green text-kidville-yellow border-kidville-green' : 'bg-gray-50 text-gray-400 border-gray-100 hover:border-gray-300'}`}
                                                                    >
                                                                        {q.short}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* NANNA — due orari per bambino */}
                            {selectedEvent === 'nanna_inizio' && students.map(student => {
                                const state = studentStates[student.id] ?? {};
                                return (
                                    <div key={student.id} className="bg-white rounded-xl px-4 py-3 shadow-sm">
                                        <div className="flex items-center gap-3 mb-3">
                                            <StudentAvatar student={student} />
                                            <span className="font-maven font-medium text-sm text-kidville-green">
                                                {student.firstName} {student.lastName}
                                                {savedStudentIds.has(student.id) && <span className="ml-1.5 text-emerald-500">✅</span>}
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div>
                                                <p className="font-maven text-xs text-gray-500 mb-1">😴 Si addormenta</p>
                                                <input
                                                    type="time"
                                                    value={(state.orario_inizio as string) ?? ''}
                                                    onChange={e => updateStudent(student.id, { orario_inizio: e.target.value })}
                                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                                />
                                            </div>
                                            <div>
                                                <p className="font-maven text-xs text-gray-500 mb-1">☀️ Si sveglia</p>
                                                <input
                                                    type="time"
                                                    value={(state.orario_fine as string) ?? ''}
                                                    onChange={e => updateStudent(student.id, { orario_fine: e.target.value })}
                                                    className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}

                            {/* BAGNO — contatori compatti inline */}
                            {selectedEvent === 'bagno' && students.map(student => {
                                const state = studentStates[student.id] ?? {};
                                const pipi = (state.pipi as number) ?? 0;
                                const cacca = (state.cacca as number) ?? 0;
                                return (
                                    <div key={student.id} className="bg-white rounded-xl px-4 py-3 shadow-sm flex items-center gap-3">
                                        <StudentAvatar student={student} />
                                        <span className="font-maven font-medium text-sm text-kidville-green flex-1 truncate">
                                            {student.firstName} {student.lastName}
                                            {savedStudentIds.has(student.id) && <span className="ml-1 text-emerald-500">✅</span>}
                                        </span>
                                        {/* Pipì */}
                                        <div className="flex items-center gap-1.5 bg-sky-50 rounded-xl px-2 py-1.5">
                                            <span className="text-base leading-none">💧</span>
                                            <button onClick={() => counter(student.id, 'pipi', -1)} className="w-6 h-6 rounded-full bg-white border border-sky-200 text-sky-600 flex items-center justify-center hover:bg-sky-100 transition-colors">
                                                <Minus size={10} />
                                            </button>
                                            <span className="font-barlow font-black text-lg text-sky-700 w-5 text-center">{pipi}</span>
                                            <button onClick={() => counter(student.id, 'pipi', 1)} className="w-6 h-6 rounded-full bg-sky-500 text-white flex items-center justify-center hover:bg-sky-600 transition-colors">
                                                <Plus size={10} />
                                            </button>
                                        </div>
                                        {/* Cacca */}
                                        <div className="flex items-center gap-1.5 bg-amber-50 rounded-xl px-2 py-1.5">
                                            <span className="text-base leading-none">💩</span>
                                            <button onClick={() => counter(student.id, 'cacca', -1)} className="w-6 h-6 rounded-full bg-white border border-amber-200 text-amber-600 flex items-center justify-center hover:bg-amber-100 transition-colors">
                                                <Minus size={10} />
                                            </button>
                                            <span className="font-barlow font-black text-lg text-amber-700 w-5 text-center">{cacca}</span>
                                            <button onClick={() => counter(student.id, 'cacca', 1)} className="w-6 h-6 rounded-full bg-amber-500 text-white flex items-center justify-center hover:bg-amber-600 transition-colors">
                                                <Plus size={10} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Footer salva */}
                        <div className="flex-shrink-0 px-4 py-3 border-t border-gray-200 bg-white">
                            <button
                                onClick={handleSave}
                                disabled={isSaving}
                                className="w-full h-13 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 py-3"
                            >
                                {isSaving
                                    ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> Salvataggio...</>
                                    : <><span>{cfg.emoji}</span> Salva {cfg.label} per tutti</>
                                }
                            </button>
                        </div>
                    </div>
                </>
            )}

            {/* Toast di conferma salvataggio */}
            {showSavedToast && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] bg-emerald-600 text-white font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-bounce">
                    ✅ Salvato con successo!
                </div>
            )}
        </div>
    );
}
