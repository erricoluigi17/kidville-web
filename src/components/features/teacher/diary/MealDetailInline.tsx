'use client';

import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, UtensilsCrossed } from 'lucide-react';
import { MEAL_QUANTITIES } from './eventConfig';

// ─── Hook mockato per il menu del giorno ──────────────────────────────────────

interface DailyMenuItem {
    id: string;
    nome: string;
    portata: string;
    icon: string;
}

interface DailyMenu {
    primo: string;
    secondo: string;
    contorno: string;
    frutta: string;
}

const EMPTY_MENU: DailyMenu = { primo: '', secondo: '', contorno: '', frutta: '' };

/**
 * Carica il menu del giorno configurato dalla scuola (modulo Mensa) per la data
 * indicata. Legge da /api/mensa/menu (override → rotazione). Il menu è school-wide,
 * quindi `_classId` non è usato. Mostra solo le portate effettivamente valorizzate.
 */
export function useDailyMenu(date: string, _classId: string): {
    menu: DailyMenu;
    courses: DailyMenuItem[];
    isLoading: boolean;
} {
    const [isLoading, setIsLoading] = useState(true);
    const [menu, setMenu] = useState<DailyMenu>(EMPTY_MENU);

    useEffect(() => {
        let active = true;
        setIsLoading(true);
        fetch(`/api/mensa/menu?from=${date}&to=${date}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!active) return;
                const giorno = d?.success ? d.data?.[0] : null;
                const p = giorno && !giorno.chiuso ? giorno.portate : null;
                setMenu(p ? { primo: p.primo ?? '', secondo: p.secondo ?? '', contorno: p.contorno ?? '', frutta: p.frutta ?? '' } : EMPTY_MENU);
            })
            .catch(() => { if (active) setMenu(EMPTY_MENU); })
            .finally(() => { if (active) setIsLoading(false); });
        return () => { active = false; };
    }, [date]);

    // Manteniamo sempre i 4 slot portata (il maestro registra le quantità anche
    // senza menu pubblicato); il nome resta vuoto se non configurato.
    const courses: DailyMenuItem[] = useMemo(() => ([
        { id: 'primo',    nome: menu.primo,    portata: 'Primo piatto', icon: '🍝' },
        { id: 'secondo',  nome: menu.secondo,  portata: 'Secondo piatto', icon: '🍖' },
        { id: 'contorno', nome: menu.contorno,  portata: 'Contorno', icon: '🥗' },
        { id: 'frutta',   nome: menu.frutta,    portata: 'Frutta', icon: '🍎' },
    ]), [menu]);

    return { menu, courses, isLoading };
}

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
    allergie?: string[];
}

interface MealDetailInlineProps {
    students: Student[];
    studentStates: Record<string, Record<string, unknown>>;
    onMealSelect: (studentId: string, corsoId: string, value: string | null) => void;
    date: string;
    classId: string;
    savedStudentIds: Set<string>;
    isMerenda?: boolean;
}

// ─── Animazioni ───────────────────────────────────────────────────────────────

const itemVariants = {
    hidden: { opacity: 0, y: 8 },
    visible: (i: number) => ({
        opacity: 1, y: 0,
        transition: { delay: i * 0.03, duration: 0.25, ease: 'easeOut' as const },
    }),
};

// ─── Componente ───────────────────────────────────────────────────────────────

export function MealDetailInline({
    students,
    studentStates,
    onMealSelect,
    date,
    classId,
    savedStudentIds,
    isMerenda = false,
}: MealDetailInlineProps) {
    const { courses, isLoading } = useDailyMenu(date, classId);

    const merendaCourse = [{ id: 'merenda', nome: 'Merenda', portata: 'Merenda', icon: '🍎' }];
    const activeCourses = isMerenda ? merendaCourse : courses;

    // Pre-populate: quando il menu del giorno arriva, inizializza gli slot vuoti
    useEffect(() => {
        if (isLoading || isMerenda) return;
        // L'inizializzazione è gestita dal parent — qui è solo una notifica
        // che il menu è pronto (predisposizione per futura logica di pre-fill)
    }, [isLoading, isMerenda]);

    const studentsWithAllergies = students.filter(s => (s.allergie?.length ?? 0) > 0);

    return (
        <div className="space-y-2">
            {/* Alert allergie globale */}
            {studentsWithAllergies.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="p-3 rounded-2xl bg-kidville-error-soft backdrop-blur-sm border border-kidville-error/25"
                >
                    <div className="flex items-start gap-2">
                        <AlertTriangle size={14} className="text-kidville-error flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                        <div>
                            <p className="font-barlow font-bold text-kidville-error uppercase text-xs tracking-wide">Allergie</p>
                            <p className="font-maven text-xs text-kidville-error mt-0.5">
                                {studentsWithAllergies.map(s => `${s.firstName}: ${s.allergie!.join(', ')}`).join(' • ')}
                            </p>
                        </div>
                    </div>
                </motion.div>
            )}

            {/* Menu del giorno (info banner) — solo se almeno una portata è pubblicata */}
            {!isMerenda && !isLoading && courses.some(c => c.nome.trim().length > 0) && (
                <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="px-4 py-2.5 rounded-2xl bg-kidville-success-soft/60 backdrop-blur-sm border border-kidville-success/40 flex items-center gap-2.5"
                >
                    <UtensilsCrossed size={14} className="text-kidville-success flex-shrink-0" strokeWidth={1.5} />
                    <div className="flex-1">
                        <p className="font-barlow font-bold text-kidville-success uppercase text-[10px] tracking-wider">Menu del giorno</p>
                        <p className="font-maven text-xs text-kidville-success mt-0.5">
                            {courses.filter(c => c.nome.trim().length > 0).map(c => `${c.icon} ${c.nome}`).join('  •  ')}
                        </p>
                    </div>
                </motion.div>
            )}

            {/* ── Card per studente (layout come Nanna) ── */}
            {students.map((student, idx) => {
                const corsi = studentStates[student.id]?.corsi as Record<string, string | null>;
                const hasAllergie = (student.allergie?.length ?? 0) > 0;
                const isSaved = savedStudentIds.has(student.id);

                return (
                    <motion.div
                        key={student.id}
                        custom={idx}
                        variants={itemVariants}
                        initial="hidden"
                        animate="visible"
                        className="bg-white/80 backdrop-blur-xl rounded-2xl border border-white/40 shadow-sm px-4 py-3"
                    >
                        {/* Avatar + Nome */}
                        <div className="flex items-center gap-3 mb-3">
                            <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center font-barlow font-bold text-xs ${hasAllergie ? 'bg-kidville-error-soft text-kidville-error' : 'bg-kidville-cream text-kidville-green'}`}>
                                {student.firstName[0]}{student.lastName[0]}
                            </div>
                            <span className={`font-maven font-medium text-sm flex-1 ${hasAllergie ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                {student.firstName} {student.lastName}
                                {hasAllergie && <span className="ml-1">⚠️</span>}
                                {isSaved && <span className="ml-1.5 text-kidville-success">✅</span>}
                            </span>
                        </div>

                        {/* Portate con pulsanti quantità */}
                        <div className="space-y-2.5">
                            {activeCourses.map(corso => {
                                const selQ = corsi?.[corso.id] ?? null;
                                return (
                                    <div key={corso.id}>
                                        <p className="font-maven text-[11px] text-kidville-muted mb-1.5">
                                            {corso.icon} {corso.nome?.trim() || corso.portata}
                                        </p>
                                        <div className="flex gap-1.5">
                                            {MEAL_QUANTITIES.map(q => (
                                                <button
                                                    key={q.value}
                                                    onClick={() => onMealSelect(student.id, corso.id, selQ === q.value ? null : q.value)}
                                                    className={`flex-1 py-2 rounded-xl text-xs font-bold border-2 transition-all duration-150 active:scale-95 ${
                                                        selQ === q.value
                                                            ? 'bg-kidville-green text-kidville-yellow border-kidville-green shadow-sm'
                                                            : 'bg-kidville-cream text-kidville-muted border-kidville-line hover:border-kidville-line'
                                                    }`}
                                                >
                                                    {q.short}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </motion.div>
                );
            })}
        </div>
    );
}
