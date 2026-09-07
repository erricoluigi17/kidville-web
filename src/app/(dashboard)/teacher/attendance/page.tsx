'use client';

import { useState, useEffect, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { LayoutGrid, CalendarDays, Loader2, Users } from 'lucide-react';
import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';
// Il motore della giornata sta fuori da questa pagina dal 2026-09-07: lo monta anche
// il cockpit della segreteria, che di questa shell mobile non ha niente.
import { AppelloGiornaliero } from '@/components/features/teacher/attendance/AppelloGiornaliero';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { fetchEducatorSections, sezioniDallaRisposta, type SezioneDocente } from '@/lib/sezioni/educator-sections-cache';

type Tab = 'oggi' | 'mese';

// La label di ogni tab arriva dal namespace i18n: `id` coincide con la chiave
// di traduzione (t('oggi') / t('mese')).
const TABS: { id: Tab; icon: typeof LayoutGrid }[] = [
    { id: 'oggi', icon: LayoutGrid },
    { id: 'mese', icon: CalendarDays },
];

const tabContentVariants = {
    enter: (direction: number) => ({ x: direction > 0 ? 32 : -32, opacity: 0 }),
    center: { x: 0, opacity: 1, transition: { duration: 0.28, ease: 'easeInOut' as const } },
    exit: (direction: number) => ({ x: direction > 0 ? -32 : 32, opacity: 0, transition: { duration: 0.2, ease: 'easeInOut' as const } }),
};


// ─── Pagina Principale ────────────────────────────────────────────────────────

function TeacherAttendanceContent() {
    const t = useTranslations('teacherPresenze');
    const { userId: teacherId } = useSessionIdentity();
    const [activeTab, setActiveTab] = useState<Tab>('oggi');
    const [prevTab, setPrevTab] = useState<Tab>('oggi');

    // Sezione REALE del docente (niente 'Girasoli' hardcoded): da educator-sections.
    //
    // Si tiene il NOME (è quello che la maestra legge nell'intestazione e nel
    // selettore) ma si porta dietro anche l'UUID, che è l'identità vera. Fino al
    // 2026-09-02 questa pagina leggeva `sectionNames` — i soli nomi — e mandava
    // il nome al server, che filtrava `alunni.classe_sezione` per uguaglianza
    // esatta: cinque classi di Giugliano si aprivano vuote o quasi perché il
    // testo scritto dal foglio d'iscrizione differiva di uno spazio.
    const [sezione, setSezione] = useState('');
    const [availableSections, setAvailableSections] = useState<SezioneDocente[]>([]);
    const [sectionsLoaded, setSectionsLoaded] = useState(false);
    const sectionId = availableSections.find((s) => s.name === sezione)?.id;

    useEffect(() => {
        if (!teacherId) return;
        fetchEducatorSections(teacherId)
            .then((d) => {
                // `sezioniDallaRisposta` regge entrambe le forme della risposta:
                // `sections` (con l'id) e la vecchia `sectionNames` (senza).
                const secs = sezioniDallaRisposta(d);
                setAvailableSections(secs);
                if (secs.length > 0) setSezione((prev) => prev || secs[0].name);
            })
            .catch(() => {})
            .finally(() => setSectionsLoaded(true));
    }, [teacherId]);

    const direction = TABS.findIndex(t => t.id === activeTab) - TABS.findIndex(t => t.id === prevTab);

    const handleTabChange = (tab: Tab) => {
        if (tab === activeTab) return;
        setPrevTab(activeTab);
        setActiveTab(tab);
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* ── Header verde (DR) ── */}
            <PageHeaderCard
                eyebrow={t('eyebrowRegistro')}
                title={t('appello')}
                subtitle={
                    <span className="inline-flex items-center gap-1.5 rounded-pill bg-white/15 px-2.5 py-1 font-maven text-xs font-semibold text-white backdrop-blur">
                        <Users size={13} /> {t('sezioneCon', { sezione: sezione || '…' })}
                    </span>
                }
            />

            {/* ── Selettore sezione (solo se il docente ne ha più d'una) ── */}
            {availableSections.length > 1 && (
                <div className="mt-3 flex items-center gap-2">
                    <label htmlFor="att-section-select" className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-muted">{t('sezioneSelettore')}</label>
                    <select
                        id="att-section-select"
                        value={sezione}
                        onChange={(e) => setSezione(e.target.value)}
                        className="rounded-xl border border-kidville-line bg-white px-3 py-1.5 font-barlow text-sm font-bold uppercase text-kidville-green shadow-sm focus:outline-none"
                    >
                        {availableSections.map((sec) => <option key={sec.id ?? sec.name} value={sec.name}>{sec.name}</option>)}
                    </select>
                </div>
            )}

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
                            className={`relative flex items-center gap-2 rounded-pill px-4 py-2 font-maven text-sm font-semibold transition-all duration-200 ${isActive ? 'text-kidville-yellow-ink' : 'text-kidville-muted hover:text-kidville-green'}`}
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
                            <span className="relative z-10">{t(tab.id)}</span>
                        </button>
                    );
                })}
            </div>

            {/* ── Tab Content ── */}
            <div className="relative mt-4 overflow-hidden">
                {!sezione ? (
                    <div className="flex flex-col items-center justify-center gap-4 py-20">
                        {sectionsLoaded ? (
                            <p className="text-center font-maven text-sm text-kidville-muted">
                                {t('nessunaSezioneProfilo')}
                            </p>
                        ) : (
                            <Loader2 size={32} className="animate-spin text-kidville-green" />
                        )}
                    </div>
                ) : (
                    <AnimatePresence initial={false} custom={direction} mode="wait">
                        <motion.div
                            key={activeTab}
                            custom={direction}
                            variants={tabContentVariants}
                            initial="enter"
                            animate="center"
                            exit="exit"
                        >
                            {activeTab === 'oggi' && <AppelloGiornaliero sezione={sezione} sectionId={sectionId} />}

                            {activeTab === 'mese' && (
                                <div className="overflow-x-auto rounded-3xl border border-kidville-line bg-white p-4 shadow-sm">
                                    <MonthlyAttendanceTable sezione={sezione} sectionId={sectionId} />
                                </div>
                            )}
                        </motion.div>
                    </AnimatePresence>
                )}
            </div>
        </div>
    );
}

export default function TeacherAttendancePage() {
    return (
        <Suspense fallback={
            <div className="mx-auto flex min-h-[60vh] max-w-[460px] flex-col items-center justify-center gap-4 px-4">
                <Loader2 size={32} className="animate-spin text-kidville-green" />
            </div>
        }>
            <TeacherAttendanceContent />
        </Suspense>
    );
}
