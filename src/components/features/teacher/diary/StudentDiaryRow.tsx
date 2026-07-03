'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ChevronDown, Minus, Plus } from 'lucide-react';
import { LocalDiaryEntry, DiaryEventType } from '@/lib/offline/db';
import { getEventConfig, MEAL_QUANTITIES } from './eventConfig';

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
    allergie?: string[];
}

type ActiveSection = DiaryEventType | null;

export interface DiaryRowCallbacks {
    onMealSelect: (studentId: string, corsoId: string, quantita: string | null) => void;
    onBathroomChange: (studentId: string, field: 'pipi' | 'cacca', delta: number) => void;
    onActivitySelect: (studentId: string, partecipazione: string | null) => void;
    onTimeChange: (studentId: string, field: 'orario' | 'orario_inizio' | 'orario_fine', value: string) => void;
}

interface StudentDiaryRowProps {
    student: Student;
    lastEntry?: LocalDiaryEntry;
    isSelected: boolean;
    isPranzoActive?: boolean;
    studentState?: Record<string, unknown>;
    savedIds?: Set<string>;
    callbacks: DiaryRowCallbacks;
    onSelect: (id: string) => void;
    /** Se true, la riga è in modalità "dettaglio standalone" con sezioni espandibili */
    expandable?: boolean;
    activeEventType?: DiaryEventType;
}

// ─── Costanti livelli attività ────────────────────────────────────────────────

const PARTICIPATION_LEVELS = [
    { value: 'non_fatta',  label: 'Non fatta',    bg: 'bg-kidville-error-soft',    text: 'text-kidville-error',    border: 'border-kidville-error/25' },
    { value: 'difficolta', label: 'Con difficoltà', bg: 'bg-kidville-warn-soft', text: 'text-kidville-warn', border: 'border-kidville-warn/30' },
    { value: 'aiuto',      label: 'Con aiuto',     bg: 'bg-yellow-100', text: 'text-yellow-700', border: 'border-yellow-200' },
    { value: 'autonomia',  label: 'In autonomia',  bg: 'bg-kidville-success-soft',text: 'text-kidville-success',border: 'border-kidville-success/30' },
] as const;

const MOCK_MEAL_COURSES = [
    { id: 'primo',   nome: 'Pasta al Pomodoro', portata: 'Primo',    icon: '🍝' },
    { id: 'secondo', nome: 'Pollo Arrosto',      portata: 'Secondo',  icon: '🍗' },
    { id: 'contorno',nome: 'Insalata Mista',     portata: 'Contorno', icon: '🥗' },
    { id: 'frutta',  nome: 'Macedonia',           portata: 'Frutta',   icon: '🍎' },
];

// ─── Varianti animazione ──────────────────────────────────────────────────────

const accordionVariants = {
    hidden: { height: 0, opacity: 0 },
    visible: {
        height: 'auto',
        opacity: 1,
        transition: {
            height: { duration: 0.3, ease: 'easeInOut' as const },
            opacity: { duration: 0.2, delay: 0.05 },
            staggerChildren: 0.05,
        },
    },
    exit: {
        height: 0,
        opacity: 0,
        transition: {
            height: { duration: 0.25, ease: 'easeInOut' as const },
            opacity: { duration: 0.15 },
        },
    },
};

const itemVariants = {
    hidden: { opacity: 0, y: -6 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.18 } },
    exit:    { opacity: 0, y: -4, transition: { duration: 0.12 } },
};



function PranzoSectionContent({
    student,
    studentState,
    onMealSelect,
    isMerenda,
}: {
    student: Student;
    studentState?: Record<string, unknown>;
    onMealSelect: DiaryRowCallbacks['onMealSelect'];
    isMerenda?: boolean;
}) {
    const corsi = (studentState?.corsi as Record<string, string | null>) ?? {};
    const courses = isMerenda
        ? [{ id: 'merenda', nome: 'Merenda', portata: '', icon: '🍎' }]
        : MOCK_MEAL_COURSES;

    return (
        <>
            {student.allergie && student.allergie.length > 0 && (
                <motion.div variants={itemVariants} className="mx-4 mb-1 mt-2 p-2 rounded-xl bg-kidville-error/8 border border-kidville-error/20">
                    <p className="font-maven text-xs text-kidville-error font-semibold">
                        ⚠️ Allergie: {student.allergie.join(', ')}
                    </p>
                </motion.div>
            )}
            {courses.map(corso => {
                const selQ = corsi[corso.id] ?? null;
                return (
                    <motion.div key={corso.id} variants={itemVariants} className="py-2 px-4">
                        <p className="font-maven text-xs text-kidville-muted mb-1.5">
                            {corso.icon} {corso.nome || corso.portata}
                        </p>
                        <div className="flex gap-1.5">
                            {MEAL_QUANTITIES.map(q => (
                                <button
                                    key={q.value}
                                    onClick={() => onMealSelect(student.id, corso.id, selQ === q.value ? null : q.value)}
                                    className={`flex-1 py-2 rounded-xl text-xs font-bold border-2 transition-all active:scale-95 ${
                                        selQ === q.value
                                            ? 'bg-kidville-green text-kidville-yellow border-kidville-green shadow-sm'
                                            : 'bg-kidville-cream text-kidville-muted border-kidville-line hover:border-kidville-line'
                                    }`}
                                >
                                    {q.icon}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                );
            })}
        </>
    );
}

function NannaSectionContent({
    student,
    studentState,
    onTimeChange,
}: {
    student: Student;
    studentState?: Record<string, unknown>;
    onTimeChange: DiaryRowCallbacks['onTimeChange'];
}) {
    return (
        <motion.div variants={itemVariants} className="grid grid-cols-2 gap-3 px-4 py-3">
            <div>
                <p className="font-maven text-xs text-kidville-muted mb-1">😴 Si addormenta</p>
                <input
                    type="time"
                    value={(studentState?.orario_inizio as string) ?? ''}
                    onChange={e => onTimeChange(student.id, 'orario_inizio', e.target.value)}
                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                />
            </div>
            <div>
                <p className="font-maven text-xs text-kidville-muted mb-1">☀️ Si sveglia</p>
                <input
                    type="time"
                    value={(studentState?.orario_fine as string) ?? ''}
                    onChange={e => onTimeChange(student.id, 'orario_fine', e.target.value)}
                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                />
            </div>
        </motion.div>
    );
}

function BagnoSectionContent({
    student,
    studentState,
    onBathroomChange,
}: {
    student: Student;
    studentState?: Record<string, unknown>;
    onBathroomChange: DiaryRowCallbacks['onBathroomChange'];
}) {
    const pipi = (studentState?.pipi as number) ?? 0;
    const cacca = (studentState?.cacca as number) ?? 0;

    // Funzione di render locale (non componente): chiude su state/handler,
    // il JSX emesso è identico a prima.
    const renderCounter = ({ field, emoji, bg, color }: { field: 'pipi' | 'cacca'; emoji: string; bg: string; color: string }) => {
        const val = field === 'pipi' ? pipi : cacca;
        return (
            <div className={`flex items-center gap-2 ${bg} rounded-xl px-3 py-2 flex-1`}>
                <span className="text-lg">{emoji}</span>
                <button
                    onClick={() => onBathroomChange(student.id, field, -1)}
                    className={`w-7 h-7 rounded-full bg-white border ${color} flex items-center justify-center hover:opacity-80 transition-opacity`}
                >
                    <Minus size={10} />
                </button>
                <span className={`font-barlow font-black text-xl ${color.replace('border-', 'text-')} w-6 text-center`}>{val}</span>
                <button
                    onClick={() => onBathroomChange(student.id, field, 1)}
                    className={`w-7 h-7 rounded-full ${color.replace('border-', 'bg-').replace('/30', '')} text-white flex items-center justify-center hover:opacity-80 transition-opacity`}
                >
                    <Plus size={10} />
                </button>
            </div>
        );
    };

    return (
        <motion.div variants={itemVariants} className="flex gap-3 px-4 py-3">
            {renderCounter({ field: 'pipi', emoji: '💧', bg: 'bg-kidville-info-soft', color: 'border-kidville-info text-kidville-info bg-kidville-info-soft0' })}
            {renderCounter({ field: 'cacca', emoji: '💩', bg: 'bg-kidville-warn-soft', color: 'border-kidville-warn text-kidville-warn bg-kidville-warn-soft0' })}
        </motion.div>
    );
}

function AttivitaSectionContent({
    student,
    studentState,
    onActivitySelect,
}: {
    student: Student;
    studentState?: Record<string, unknown>;
    onActivitySelect: DiaryRowCallbacks['onActivitySelect'];
}) {
    const sel = (studentState?.partecipazione as string) ?? null;
    return (
        <motion.div variants={itemVariants} className="grid grid-cols-2 gap-1.5 px-4 py-3">
            {PARTICIPATION_LEVELS.map(lv => (
                <button
                    key={lv.value}
                    onClick={() => onActivitySelect(student.id, sel === lv.value ? null : lv.value)}
                    className={`py-2.5 rounded-xl border-2 text-xs font-maven font-semibold transition-all active:scale-95 ${
                        sel === lv.value ? `${lv.bg} ${lv.text} ${lv.border}` : 'bg-kidville-cream text-kidville-muted border-kidville-line hover:border-kidville-line'
                    }`}
                >
                    {lv.label}
                </button>
            ))}
        </motion.div>
    );
}

// ─── Sezioni per tipo evento ──────────────────────────────────────────────────

function InlineSectionContent({
    activeEvent,
    student,
    studentState,
    callbacks,
}: {
    activeEvent: DiaryEventType;
    student: Student;
    studentState?: Record<string, unknown>;
    callbacks: DiaryRowCallbacks;
}) {
    switch (activeEvent) {
        case 'pranzo':
            return <PranzoSectionContent student={student} studentState={studentState} onMealSelect={callbacks.onMealSelect} />;
        case 'merenda':
            return <PranzoSectionContent student={student} studentState={studentState} onMealSelect={callbacks.onMealSelect} isMerenda />;
        case 'nanna_inizio':
        case 'nanna_fine':
            return <NannaSectionContent student={student} studentState={studentState} onTimeChange={callbacks.onTimeChange} />;
        case 'bagno':
            return <BagnoSectionContent student={student} studentState={studentState} onBathroomChange={callbacks.onBathroomChange} />;
        case 'attivita':
            return <AttivitaSectionContent student={student} studentState={studentState} onActivitySelect={callbacks.onActivitySelect} />;
        default:
            return null;
    }
}

// ─── Componente Principale ───────────────────────────────────────────────────

export function StudentDiaryRow({
    student,
    lastEntry,
    isSelected,
    isPranzoActive = false,
    studentState,
    savedIds,
    callbacks,
    onSelect,
    expandable = false,
    activeEventType,
}: StudentDiaryRowProps) {
    const [activeSection, setActiveSection] = useState<ActiveSection>(null);

    const hasAllergie = (student.allergie?.length ?? 0) > 0;
    const showAllergyWarning = isPranzoActive && hasAllergie;
    const lastEventConfig = lastEntry ? getEventConfig(lastEntry.tipo_evento) : null;
    const isSaved = savedIds?.has(student.id) ?? false;

    // Se expandable, usa stato locale per la sezione aperta
    // La sezione aperta è quella del tipo evento corrente passato dall'esterno
    const currentSection: DiaryEventType | null = expandable
        ? (activeSection ?? null)
        : null;

    const handleSectionToggle = (type: DiaryEventType) => {
        if (!expandable) return;
        setActiveSection(prev => prev === type ? null : type);
    };

    // Sezioni disponibili quando la riga è in modalità expandable
    const availableSections: DiaryEventType[] = activeEventType ? [activeEventType] : [];

    return (
        <div
            className={`
                rounded-2xl border-2 overflow-hidden transition-all duration-200 select-none
                ${isSelected
                    ? 'border-kidville-green bg-kidville-green/5 shadow-md'
                    : showAllergyWarning
                        ? 'border-kidville-error bg-kidville-error/5'
                        : 'border-kidville-line bg-white hover:border-kidville-line hover:shadow-sm'
                }
            `}
        >
            {/* ── Riga principale (cliccabile) ── */}
            <div
                onClick={() => onSelect(student.id)}
                className="flex items-center gap-3 p-3 cursor-pointer"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`${student.firstName} ${student.lastName}`}
            >
                {/* Checkbox visuale */}
                <div className={`
                    w-6 h-6 flex-shrink-0 rounded-md border-2 flex items-center justify-center transition-colors
                    ${isSelected ? 'bg-kidville-green border-kidville-green' : 'border-kidville-line bg-white'}
                `}>
                    {isSelected && (
                        <svg className="w-4 h-4 text-kidville-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                    )}
                </div>

                {/* Avatar */}
                <div className={`
                    w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center font-barlow font-bold text-sm
                    ${showAllergyWarning ? 'bg-kidville-error text-white' : 'bg-kidville-cream text-kidville-green'}
                `}>
                    {student.firstName[0]}{student.lastName[0]}
                </div>

                {/* Info studente */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`font-maven font-medium text-sm truncate ${showAllergyWarning ? 'text-kidville-error' : 'text-kidville-green'}`}>
                            {student.firstName} {student.lastName}
                        </span>
                        {showAllergyWarning && <AlertTriangle size={14} className="flex-shrink-0 text-kidville-error" />}
                        {isSaved && <span className="text-kidville-success text-xs">✅</span>}
                    </div>
                    {showAllergyWarning && (
                        <p className="font-maven text-xs text-kidville-error truncate">⚠️ {student.allergie!.join(', ')}</p>
                    )}
                    {!showAllergyWarning && lastEventConfig && (
                        <p className="font-maven text-xs text-kidville-muted truncate">
                            Ultimo: {lastEventConfig.emoji} {lastEventConfig.label}
                        </p>
                    )}
                </div>

                {/* Badge ultimo evento */}
                {lastEventConfig && (
                    <div className={`flex-shrink-0 px-2 py-1 rounded-full text-xs font-maven font-medium border ${lastEventConfig.accentColor} ${lastEventConfig.color}`}>
                        {lastEventConfig.emoji}
                    </div>
                )}

                {/* Pulsante espandi sezione (solo in modalità expandable) */}
                {expandable && availableSections.length > 0 && (
                    <button
                        onClick={e => {
                            e.stopPropagation();
                            handleSectionToggle(availableSections[0]);
                        }}
                        className={`
                            w-8 h-8 rounded-xl flex items-center justify-center transition-all flex-shrink-0
                            ${currentSection ? 'bg-kidville-green/10 text-kidville-green' : 'bg-kidville-cream text-kidville-muted hover:bg-kidville-cream'}
                        `}
                        aria-label={currentSection ? 'Chiudi dettagli' : 'Apri dettagli'}
                    >
                        <motion.div animate={{ rotate: currentSection ? 180 : 0 }} transition={{ duration: 0.22 }}>
                            <ChevronDown size={15} />
                        </motion.div>
                    </button>
                )}
            </div>

            {/* ── Accordion inline dettagli ── */}
            <AnimatePresence initial={false}>
                {expandable && currentSection && (
                    <motion.div
                        key={`section-${student.id}-${currentSection}`}
                        variants={accordionVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className="overflow-hidden border-t border-kidville-line"
                        onClick={e => e.stopPropagation()}
                    >
                        <motion.div
                            variants={{ visible: { transition: { staggerChildren: 0.05 } } }}
                            className="pb-2"
                        >
                            <InlineSectionContent
                                activeEvent={currentSection}
                                student={student}
                                studentState={studentState}
                                callbacks={callbacks}
                            />
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
