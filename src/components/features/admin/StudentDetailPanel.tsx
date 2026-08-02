'use client';

import { useState, useEffect } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { X, Trash2, Save, AlertTriangle, Users, Baby } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { LinkedAdultProfile, AdultProfileData, AdultType } from './LinkedAdultProfile';
import { Task } from '../teacher/tasks/TaskCard';
import { StudentEconomicSection } from './StudentEconomicSection';
import { AllergeniSelect } from './AllergeniSelect';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { formattaIstante } from '@/i18n/config';

interface Student {
    id: string;
    nome?: string;
    cognome?: string;
    first_name?: string;
    last_name?: string;
    data_nascita?: string;
    gender?: string | null;
    citizenship?: string | null;
    birth_nation?: string | null;
    birth_city?: string | null;
    birth_province?: string | null;
    residence_address?: string | null;
    residence_street_number?: string | null;
    residence_city?: string | null;
    residence_province?: string | null;
    zip_code?: string | null;
    classe_sezione?: string | null;
    // Sede del bambino: è il perimetro entro cui una classe ha senso. Arriva
    // dalla `select *` di GET /api/admin/students/[id].
    scuola_id?: string | null;
    stato?: string;
    data_iscrizione?: string | null;
    giorno_scadenza_pagamenti?: number | null;
    note_mediche?: string | null;
    allergeni?: string[] | null;
    allergies?: string | null;
    codice_fiscale?: string | null;
    fiscal_code?: string | null;
    bes?: boolean;
    note_bes?: string | null;
    // Liberatoria foto/video (galleria): senza consenso il bambino compare solo
    // in foto individuali visibili ai suoi genitori (regola "foto privata").
    consenso_privacy?: boolean | null;
    // Gli altri due CANALI, distinti per legge dal primo e fra loro: sito web
    // pubblico (bucket `news`, nessun login) e canali social (fuori dai nostri
    // sistemi). `undefined` su un ambiente non ancora migrato: il comando resta
    // spento e il salvataggio non nomina la colonna che non c'è.
    consenso_foto_sito?: boolean | null;
    consenso_foto_social?: boolean | null;
    emails?: string[];
    phone_numbers?: string[];
    student_parents?: {
        relation_type: string;
        is_primary: boolean;
        parents: AdultProfileData;
    }[];
    delegates?: AdultProfileData[];
    // Dati economici (modulo Pagamenti)
    importo_retta_mensile?: number | null;
    genitori_separati?: boolean | null;
    retta_split_config?: { quote: { adult_id?: string; nome?: string; importo: number }[] } | null;
    intestatario_fatture?: { tipo: 'adult' | 'altro'; adult_id?: string; nome?: string; dati?: Record<string, string> } | null;
}

interface Sibling {
    id: string;
    nome: string;
    cognome: string;
    data_nascita?: string;
    classe_sezione?: string | null;
    stato?: string;
}

interface Props {
    student: Student | null;
    onClose: () => void;
    onSave: (data: Partial<Student> & { id: string }) => void;
    onDelete: (id: string) => void;
    // 'page' = scheda a tutta area (route /admin/students/[id]); 'drawer' = pannello
    // laterale storico. Il default resta 'drawer' per retro-compatibilità.
    variant?: 'drawer' | 'page';
}

export function StudentDetailPanel({ student, onClose, onSave, onDelete, variant = 'drawer' }: Props) {
    const t = useTranslations('adminStudents');
    const locale = useLocale();
    // Il pannello è montato per-alunno ({selectedStudent && <StudentDetailPanel/>}):
    // form inizializzato dal prop, niente state+effect (react-hooks/set-state-in-effect).
    const [form, setForm] = useState<Partial<Student>>(() => (student ? { ...student } : {}));
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [activeAdultTab, setActiveAdultTab] = useState<string | null>(null);
    const [sections, setSections] = useState<{id: string, name: string, school_type: string}[]>([]);
    const [siblings, setSiblings] = useState<Sibling[]>([]);
    // NB: niente setLoading(true) sincrono negli effect (react-hooks/set-state-in-effect):
    // i loading partono già true al mount, i loader li spengono in finally.
    const [siblingsLoading, setSiblingsLoading] = useState(true);

    // Complaints / Reports states
    const [studentTasks, setStudentTasks] = useState<Task[]>([]);
    const [tasksLoading, setTasksLoading] = useState(true);

    // Sezioni della SEDE del bambino: una classe di un altro plesso non è una
    // destinazione possibile (il server la rifiuta da W2-C), quindi non deve
    // nemmeno comparire nella tendina. Senza sede sulla riga non si chiede nulla:
    // non esiste perimetro entro cui una classe sia lecita.
    const sedeAlunno = student?.scuola_id ?? null;
    useEffect(() => {
        if (!sedeAlunno) return;
        let annullato = false;
        fetch(`/api/admin/sections?scuola_id=${encodeURIComponent(sedeAlunno)}`)
            .then(r => r.json())
            .then(d => { if (!annullato && Array.isArray(d)) setSections(d); })
            .catch((err) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `sezioni-sede-caricamento-fallito: ${nomeErrore(err)}` });
            });
        return () => { annullato = true; };
    }, [sedeAlunno]);

    useEffect(() => {
        if (!student?.id) return;
        const sid = student.id;
        const load = async () => {
            try {
                const res = await fetch(`/api/admin/students/${sid}`).catch(() => null);
                const d = res?.ok ? await res.json().catch(() => null) : null;
                if (Array.isArray(d?.siblings)) setSiblings(d.siblings);
            } finally {
                setSiblingsLoading(false);
            }
        };
        load();
    }, [student?.id]);

    useEffect(() => {
        if (!student?.id) return;
        const sid = student.id;
        const load = async () => {
            try {
                // Identità session-only (M4): senza id risolto non si interroga l'API.
                const uid = getCurrentTeacherId(null);
                if (!uid) return;
                const res = await fetch(`/api/tasks?studentId=${sid}&userId=${uid}`).catch(() => null);
                const d = res?.ok ? await res.json().catch(() => null) : null;
                if (Array.isArray(d)) setStudentTasks(d);
            } finally {
                setTasksLoading(false);
            }
        };
        load();
    }, [student?.id]);

    if (!student) return null;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await onSave({ id: student.id, ...form });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = () => {
        if (showDeleteConfirm) {
            onDelete(student.id);
            setShowDeleteConfirm(false);
        } else {
            setShowDeleteConfirm(true);
        }
    };

    const updateForm = (field: string, value: unknown) => {
        setForm(prev => ({ ...prev, [field]: value }));
    };

    // Estrai madre, padre e delegati per i tab
    const getAdultTabs = () => {
        const tabs: { id: string; type: AdultType; label: string; data: AdultProfileData }[] = [];
        
        if (student?.student_parents) {
            student.student_parents.forEach(sp => {
                if (sp.parents) {
                    if (sp.relation_type === 'mother' || sp.parents.gender === 'F') {
                        tabs.push({ id: 'mother', type: 'mother', label: t('ruoloMadre'), data: sp.parents });
                    } else if (sp.relation_type === 'father' || sp.parents.gender === 'M') {
                        tabs.push({ id: 'father', type: 'father', label: t('ruoloPadre'), data: sp.parents });
                    } else {
                        tabs.push({ id: `parent_${sp.parents.id}`, type: 'delegate', label: t('ruoloGenitore'), data: sp.parents });
                    }
                }
            });
        }

        if (student?.delegates) {
            student.delegates.forEach((del, idx) => {
                tabs.push({ id: `delegate_${del.id}`, type: 'delegate', label: t('detailDelegatoN', { n: idx + 1 }), data: del });
            });
        }

        return tabs;
    };

    const adultTabs = getAdultTabs();
    const activeTabData = adultTabs.find(t => t.id === activeAdultTab);

    // Classe corrente non presente fra le sezioni caricate: va mostrata comunque.
    const classeCorrente = (form.classe_sezione as string) ?? '';
    const classeFuoriElenco =
        classeCorrente && !sections.some(s => s.name === classeCorrente) ? classeCorrente : null;

    const isPage = variant === 'page';
    const shellCls = isPage
        ? 'flex w-full flex-col rounded-card bg-kidville-white shadow-sm'
        : 'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-kidville-white shadow-2xl';
    const bodyCls = isPage ? 'p-5 md:p-6 space-y-5' : 'flex-1 overflow-y-auto p-5 space-y-5';

    return (
        <>
            {/* Backdrop — solo nel pannello laterale */}
            {!isPage && <div className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />}

            {/* Contenitore: pannello laterale oppure scheda a tutta area */}
            <div className={shellCls}>
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-kidville-line">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                            {t('detailSchedaAlunno')}
                        </h2>
                        <p className="font-maven text-sm text-kidville-muted">
                            {student.nome} {student.cognome}
                        </p>
                    </div>
                    {!isPage && (
                        <button
                            onClick={onClose}
                            aria-label={t('detailChiudiScheda')}
                            className="w-8 h-8 rounded-full bg-kidville-line flex items-center justify-center text-kidville-muted hover:text-kidville-ink"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {/* Scrollable Form */}
                <div className={bodyCls}>
                    {/* Dati Anagrafici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailDatiAnagrafici')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNome')}</label>
                                <input
                                    type="text"
                                    value={(form.nome as string) ?? ''}
                                    onChange={e => updateForm('nome', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCognome')}</label>
                                <input
                                    type="text"
                                    value={(form.cognome as string) ?? ''}
                                    onChange={e => updateForm('cognome', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataNascita')}</label>
                                <input
                                    type="date"
                                    value={(form.data_nascita as string) ?? ''}
                                    onChange={e => updateForm('data_nascita', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCodiceFiscale')}</label>
                                <input
                                    type="text"
                                    value={(form.codice_fiscale as string) ?? ''}
                                    onChange={e => updateForm('codice_fiscale', e.target.value.toUpperCase())}
                                    maxLength={16}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green uppercase"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Nascita e Cittadinanza */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailNascitaCittadinanza')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoSesso')}</label>
                                <select
                                    value={(form.gender as string) ?? ''}
                                    onChange={e => updateForm('gender', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="">—</option>
                                    <option value="M">{t('optMaschio')}</option>
                                    <option value="F">{t('optFemmina')}</option>
                                </select>
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoComuneNascita')}</label>
                                <input
                                    type="text"
                                    value={(form.birth_city as string) ?? ''}
                                    onChange={e => updateForm('birth_city', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoProvNascita')}</label>
                                <input
                                    type="text"
                                    value={(form.birth_province as string) ?? ''}
                                    onChange={e => updateForm('birth_province', e.target.value.toUpperCase())}
                                    maxLength={2}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green uppercase focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNazioneNascita')}</label>
                                <input
                                    type="text"
                                    value={(form.birth_nation as string) ?? ''}
                                    onChange={e => updateForm('birth_nation', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div className="col-span-2">
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCittadinanza')}</label>
                                <input
                                    type="text"
                                    value={(form.citizenship as string) ?? ''}
                                    onChange={e => updateForm('citizenship', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Residenza */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('sezioneResidenza')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoIndirizzoResidenza')}</label>
                                <input
                                    type="text"
                                    value={(form.residence_address as string) ?? ''}
                                    onChange={e => updateForm('residence_address', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNumeroCivico')}</label>
                                <input
                                    type="text"
                                    value={(form.residence_street_number as string) ?? ''}
                                    onChange={e => updateForm('residence_street_number', e.target.value)}
                                    maxLength={20}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoComuneResidenza')}</label>
                                <input
                                    type="text"
                                    value={(form.residence_city as string) ?? ''}
                                    onChange={e => updateForm('residence_city', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoProvResidenza')}</label>
                                <input
                                    type="text"
                                    value={(form.residence_province as string) ?? ''}
                                    onChange={e => updateForm('residence_province', e.target.value.toUpperCase())}
                                    maxLength={2}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green uppercase focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCap')}</label>
                                <input
                                    type="text"
                                    value={(form.zip_code as string) ?? ''}
                                    onChange={e => updateForm('zip_code', e.target.value)}
                                    maxLength={10}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Classe e Stato */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailClasseStato')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoClasseSezione')}</label>
                                <select
                                    name="classe_sezione"
                                    value={(form.classe_sezione as string) ?? ''}
                                    onChange={e => updateForm('classe_sezione', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="">{t('detailNessuna')}</option>
                                    {sections.map(s => (
                                        <option key={s.id} value={s.name}>{s.name} ({s.school_type})</option>
                                    ))}
                                    {/* La classe ATTUALE del bambino, se non è più fra le
                                        sezioni della sede (rinominata, cancellata, o riga
                                        vecchia): senza questa voce la tendina resterebbe
                                        vuota e sembrerebbe che il bambino non abbia classe. */}
                                    {classeFuoriElenco && <option value={classeFuoriElenco}>{classeFuoriElenco}</option>}
                                </select>
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoStato')}</label>
                                <select
                                    value={(form.stato as string) ?? 'iscritto'}
                                    onChange={e => updateForm('stato', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="iscritto">{t('statoIscritto')}</option>
                                    <option value="ritirato">{t('statoRitirato')}</option>
                                    <option value="sospeso">{t('statoSospeso')}</option>
                                </select>
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataIscrizione')}</label>
                                <input
                                    type="date"
                                    value={(form.data_iscrizione as string) ?? ''}
                                    onChange={e => updateForm('data_iscrizione', e.target.value || null)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                                    {t('detailDataIscrizioneHint')}
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* Dati Medici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <AlertTriangle size={12} className="text-kidville-error" />
                            {t('detailDatiMedici')}
                        </h3>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('detailAllergeni')}</label>
                            <AllergeniSelect
                                value={(form.allergeni as string[]) ?? []}
                                onChange={next => updateForm('allergeni', next)}
                            />
                            {(form.allergies as string)?.trim() && (
                                <p className="mt-2 rounded-lg bg-kidville-cream px-2.5 py-1.5 font-maven text-[11px] text-kidville-muted">
                                    {t('testoStorico', { testo: form.allergies as string })}
                                </p>
                            )}
                        </div>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('detailNoteMediche')}</label>
                            <textarea
                                value={(form.note_mediche as string) ?? ''}
                                onChange={e => updateForm('note_mediche', e.target.value)}
                                placeholder={t('detailNoteMedichePlaceholder')}
                                rows={2}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        </div>

                        <div className="flex items-center gap-3 mb-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.bes}
                                    onChange={e => updateForm('bes', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailBes')}</span>
                            </label>
                        </div>

                        {form.bes && (
                            <textarea
                                value={(form.note_bes as string) ?? ''}
                                onChange={e => updateForm('note_bes', e.target.value)}
                                placeholder={t('detailNoteBesPlaceholder')}
                                rows={2}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        )}

                        {/* ─── I TRE CONSENSI FOTOGRAFICI, uno per CANALE ─────────────────
                            Il modulo d'iscrizione li chiede separatamente perché il consenso
                            alla pubblicazione è granulare per canale (provv. Garante 725 del
                            27/11/2025). Fino al 2026-08-01 qui c'era una sola spunta: gli
                            altri due consensi si potevano solo IMPORTARE da una domanda, e
                            una famiglia che cambiava idea non aveva nessuna strada per farlo
                            registrare — art. 7 §3 GDPR, revocare dev'essere facile quanto
                            acconsentire. */}
                        <div className="mt-3 pt-3 border-t border-kidville-line">
                            <h4 className="font-barlow font-bold text-kidville-green uppercase text-[11px] tracking-wide mb-2">
                                {t('detailConsensiTitolo')}
                            </h4>

                            {/* Galleria riservata alle famiglie della sezione */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_privacy}
                                    onChange={e => updateForm('consenso_privacy', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailLiberatoria')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1 mb-3">
                                {t('detailLiberatoriaHint')}
                            </p>

                            {/* Sito web della Scuola: canale PUBBLICO, senza login */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_foto_sito}
                                    onChange={e => updateForm('consenso_foto_sito', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailConsensoSito')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1 mb-3">
                                {t('detailConsensoSitoHint')}
                            </p>

                            {/* Canali social: la pubblicazione avviene fuori dai nostri sistemi */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_foto_social}
                                    onChange={e => updateForm('consenso_foto_social', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailConsensoSocial')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1">
                                {t('detailConsensoSocialHint')}
                            </p>
                        </div>
                    </section>

                    {/* Dati Economici (modulo Pagamenti) */}
                    <StudentEconomicSection
                        alunnoId={student.id}
                        form={form as Record<string, unknown>}
                        updateForm={updateForm}
                        parents={student.student_parents}
                    />

                    {/* Famiglia e Delegati */}
                    <section className="pt-4 border-t border-kidville-line">
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <Users size={12} />
                            {t('detailFamigliaDelegati')}
                        </h3>
                        
                        {adultTabs.length > 0 ? (
                            <>
                                {/* Segmented Control */}
                                <div className="flex overflow-x-auto snap-x gap-2 pb-2 hide-scrollbar">
                                    {adultTabs.map(tab => {
                                        const isActive = activeAdultTab === tab.id;
                                        return (
                                            <button
                                                key={tab.id}
                                                onClick={() => setActiveAdultTab(isActive ? null : tab.id)}
                                                className={`snap-start whitespace-nowrap px-4 py-2 rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-all duration-300 ${
                                                    isActive 
                                                        ? 'bg-kidville-green/20 text-kidville-green border border-kidville-green/50 ring-1 ring-kidville-green/30' 
                                                        : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-line'
                                                }`}
                                            >
                                                {tab.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Animated Adult Profile Container */}
                                <AnimatePresence mode="wait">
                                    {activeAdultTab && activeTabData && (
                                        <motion.div
                                            key={activeAdultTab}
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                                            className="overflow-hidden rounded-2xl mt-2"
                                        >
                                            <LinkedAdultProfile data={activeTabData.data} type={activeTabData.type} />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </>
                        ) : (
                            <div className="text-center py-6 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line">
                                <Users size={24} className="mx-auto text-kidville-muted mb-2" />
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunGenitore')}</p>
                                <p className="font-maven text-xs text-kidville-muted mt-1">{t('detailAggiungiGenitori')}</p>
                            </div>
                        )}
                    </section>

                    {/* ===== FRATELLI ===== */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <Baby size={12} className="text-kidville-green" />
                            {t('detailFratelli')}
                        </h3>

                        {siblingsLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                {t('detailRicercaFratelli')}
                            </div>
                        ) : siblings.length > 0 ? (
                            <div className="space-y-2">
                                {siblings.map(sibling => (
                                    <div key={sibling.id} className="flex items-center gap-3 p-3 bg-kidville-green/5 border border-kidville-green/15 rounded-xl">
                                        <div className="w-9 h-9 rounded-full bg-kidville-green/10 flex items-center justify-center flex-shrink-0">
                                            <Baby size={16} className="text-kidville-green" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-barlow font-bold text-sm text-kidville-ink leading-tight truncate">
                                                {sibling.cognome} {sibling.nome}
                                            </p>
                                            <p className="font-maven text-xs text-kidville-muted mt-0.5">
                                                {sibling.classe_sezione || t('detailNessunaSezione')}
                                                {sibling.data_nascita && ` • ${new Date(sibling.data_nascita).getFullYear()}`}
                                            </p>
                                        </div>
                                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md flex-shrink-0 ${
                                            sibling.stato === 'iscritto' 
                                                ? 'bg-kidville-green/10 text-kidville-green' 
                                                : 'bg-kidville-line text-kidville-muted'
                                        }`}>
                                            {sibling.stato || 'iscritto'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-5 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line">
                                <Baby size={20} className="mx-auto text-kidville-muted mb-1.5" />
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunFratello')}</p>
                            </div>
                        )}
                    </section>

                    {/* ===== SEGNALAZIONI E RECLAMI ===== */}
                    <section className="pt-4 border-t border-kidville-line">
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            📌 {t('detailSegnalazioni')}
                        </h3>

                        {tasksLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                {t('detailCaricamentoSegnalazioni')}
                            </div>
                        ) : studentTasks.length > 0 ? (
                            <div className="space-y-2">
                                {studentTasks.map(task => {
                                    const isCompleted = task.status === 'completed';
                                    return (
                                        <div key={task.id} className="p-3 bg-kidville-cream/50 border border-kidville-line rounded-xl space-y-1.5 text-left text-xs">
                                            <div className="flex justify-between items-start gap-1">
                                                <span className="font-bold text-kidville-ink font-maven leading-tight block">
                                                    {task.titolo}
                                                </span>
                                                <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md flex-shrink-0 ${
                                                    isCompleted
                                                        ? 'bg-kidville-success-soft/50 text-kidville-success ' 
                                                        : 'bg-kidville-warn-soft/50 text-kidville-warn '
                                                }`}>
                                                    {isCompleted ? t('detailRisolto') : t('detailAttivo')}
                                                </span>
                                            </div>
                                            
                                            {(task.descrizione || task.contenuto) && (
                                                <p className="text-[10px] text-kidville-muted font-maven leading-relaxed">
                                                    {task.descrizione || task.contenuto}
                                                </p>
                                            )}
                                            
                                            {isCompleted && task.resolution_notes && (
                                                <div className="p-2 bg-kidville-success-soft/20 border border-kidville-success/30 rounded-lg italic text-[9px] text-kidville-success font-maven">
                                                    &ldquo;{task.resolution_notes}&rdquo;
                                                </div>
                                            )}
                                            
                                            {/* Render attachments in student panel */}
                                            {task.attachments && task.attachments.length > 0 && (
                                                <div className="mt-1.5 space-y-1">
                                                    <p className="text-[8px] font-bold text-kidville-muted uppercase tracking-wider">{t('detailAllegati')}</p>
                                                    <div className="flex flex-col gap-1">
                                                        {task.attachments.map((att: { name: string; url: string; fileUrl?: string }, attIdx: number) => (
                                                            <a
                                                                key={attIdx}
                                                                href={att.fileUrl || att.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-1 text-[9px] text-kidville-green hover:underline truncate max-w-full font-semibold"
                                                            >
                                                                📎 {att.name}
                                                            </a>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            <div className="text-[8px] text-kidville-muted flex justify-between pt-1 border-t border-kidville-line/30">
                                                <span>{t('detailCategoria', { categoria: task.category })}</span>
                                                <span>{t('detailApertoIl', { data: formattaIstante(new Date(task.created_at), locale) })}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-5 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line ">
                                <span className="text-2xl block mb-1">📋</span>
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunReclamo')}</p>
                            </div>
                        )}
                    </section>
                </div>

                {/* Footer actions */}
                <div className="flex-shrink-0 p-5 border-t border-kidville-line space-y-3">
                    {/* Salva */}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="w-full h-12 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isSaving ? (
                            <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                        ) : (
                            <>
                                <Save size={16} />
                                {t('salvaModifiche')}
                            </>
                        )}
                    </button>

                    {/* Hard Delete GDPR */}
                    <button
                        onClick={handleDelete}
                        className={`w-full h-10 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm transition-all flex items-center justify-center gap-2 ${
                            showDeleteConfirm
                                ? 'bg-kidville-error text-kidville-white hover:bg-kidville-error'
                                : 'bg-kidville-error-soft text-kidville-error border-2 border-kidville-error-soft hover:bg-kidville-error-soft'
                        }`}
                    >
                        <Trash2 size={14} />
                        {showDeleteConfirm
                            ? `⚠️ ${t('detailConfermaEliminazione')}`
                            : t('detailEliminaAlunno')
                        }
                    </button>

                    {showDeleteConfirm && (
                        <div className="bg-kidville-error-soft border border-kidville-error-soft rounded-xl p-3">
                            <p className="font-maven text-xs text-kidville-error">
                                <strong>{t('detailAttenzioneLabel')}</strong> {t('detailAttenzionePre')} <strong>{t('detailAttenzioneIrrev')}</strong> {t('detailAttenzionePost')}
                            </p>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="mt-2 text-xs font-maven font-bold text-kidville-muted hover:text-kidville-ink"
                            >
                                {t('annulla')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
