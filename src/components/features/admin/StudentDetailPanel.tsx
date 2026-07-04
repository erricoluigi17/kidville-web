'use client';

import { useState, useEffect } from 'react';
import { X, Trash2, Save, AlertTriangle, Users, Baby } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { LinkedAdultProfile, AdultProfileData, AdultType } from './LinkedAdultProfile';
import { Task } from '../teacher/tasks/TaskCard';
import { StudentEconomicSection } from './StudentEconomicSection';
import { AllergeniSelect } from './AllergeniSelect';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Student {
    id: string;
    nome?: string;
    cognome?: string;
    first_name?: string;
    last_name?: string;
    data_nascita?: string;
    classe_sezione?: string | null;
    stato?: string;
    note_mediche?: string | null;
    allergeni?: string[] | null;
    allergies?: string | null;
    codice_fiscale?: string | null;
    fiscal_code?: string | null;
    bes?: boolean;
    note_bes?: string | null;
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
}

export function StudentDetailPanel({ student, onClose, onSave, onDelete }: Props) {
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

    useEffect(() => {
        fetch('/api/admin/sections').then(r => r.json()).then(d => { if (Array.isArray(d)) setSections(d); }).catch(() => {});
    }, []);

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
                        tabs.push({ id: 'mother', type: 'mother', label: 'Madre', data: sp.parents });
                    } else if (sp.relation_type === 'father' || sp.parents.gender === 'M') {
                        tabs.push({ id: 'father', type: 'father', label: 'Padre', data: sp.parents });
                    } else {
                        tabs.push({ id: `parent_${sp.parents.id}`, type: 'delegate', label: 'Genitore', data: sp.parents });
                    }
                }
            });
        }

        if (student?.delegates) {
            student.delegates.forEach((del, idx) => {
                tabs.push({ id: `delegate_${del.id}`, type: 'delegate', label: `Delegato ${idx + 1}`, data: del });
            });
        }

        return tabs;
    };

    const adultTabs = getAdultTabs();
    const activeTabData = adultTabs.find(t => t.id === activeAdultTab);

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />

            {/* Panel slide-in */}
            <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-2xl flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-kidville-line">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                            Scheda Alunno
                        </h2>
                        <p className="font-maven text-sm text-kidville-muted">
                            {student.nome} {student.cognome}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full bg-kidville-line flex items-center justify-center text-kidville-muted hover:text-kidville-ink"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Scrollable Form */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Dati Anagrafici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            Dati Anagrafici
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Nome</label>
                                <input
                                    type="text"
                                    value={(form.nome as string) ?? ''}
                                    onChange={e => updateForm('nome', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Cognome</label>
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
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Data di Nascita</label>
                                <input
                                    type="date"
                                    value={(form.data_nascita as string) ?? ''}
                                    onChange={e => updateForm('data_nascita', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Codice Fiscale</label>
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

                    {/* Classe e Stato */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            Classe e Stato
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Classe / Sezione</label>
                                <select
                                    value={(form.classe_sezione as string) ?? ''}
                                    onChange={e => updateForm('classe_sezione', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="">— Nessuna —</option>
                                    {sections.map(s => (
                                        <option key={s.id} value={s.name}>{s.name} ({s.school_type})</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Stato</label>
                                <select
                                    value={(form.stato as string) ?? 'iscritto'}
                                    onChange={e => updateForm('stato', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="iscritto">Iscritto</option>
                                    <option value="ritirato">Ritirato</option>
                                    <option value="sospeso">Sospeso</option>
                                </select>
                            </div>
                        </div>
                    </section>

                    {/* Dati Medici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <AlertTriangle size={12} className="text-kidville-error" />
                            Dati Medici / Didattici
                        </h3>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">Allergeni</label>
                            <AllergeniSelect
                                value={(form.allergeni as string[]) ?? []}
                                onChange={next => updateForm('allergeni', next)}
                            />
                            {(form.allergies as string)?.trim() && (
                                <p className="mt-2 rounded-lg bg-kidville-cream px-2.5 py-1.5 font-maven text-[11px] text-kidville-muted">
                                    Testo storico (sola lettura): {form.allergies as string}
                                </p>
                            )}
                        </div>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">Note mediche (uso interno)</label>
                            <textarea
                                value={(form.note_mediche as string) ?? ''}
                                onChange={e => updateForm('note_mediche', e.target.value)}
                                placeholder="Terapie, indicazioni cliniche, note per lo staff…"
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
                                <span className="font-maven font-semibold text-sm text-kidville-green">BES (Bisogni Educativi Speciali)</span>
                            </label>
                        </div>

                        {form.bes && (
                            <textarea
                                value={(form.note_bes as string) ?? ''}
                                onChange={e => updateForm('note_bes', e.target.value)}
                                placeholder="Note BES..."
                                rows={2}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        )}
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
                            Famiglia e Delegati
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
                                            className="overflow-hidden bg-black rounded-2xl mt-2"
                                        >
                                            <LinkedAdultProfile data={activeTabData.data} type={activeTabData.type} />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </>
                        ) : (
                            <div className="text-center py-6 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line">
                                <Users size={24} className="mx-auto text-kidville-muted mb-2" />
                                <p className="font-maven text-sm text-kidville-muted">Nessun genitore collegato</p>
                                <p className="font-maven text-xs text-kidville-muted mt-1">Puoi aggiungere i genitori dalla pagina di creazione famiglia</p>
                            </div>
                        )}
                    </section>

                    {/* ===== FRATELLI ===== */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <Baby size={12} className="text-kidville-green" />
                            Fratelli / Sorelle
                        </h3>

                        {siblingsLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                Ricerca fratelli in corso...
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
                                                {sibling.classe_sezione || 'Nessuna sezione'}
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
                                <p className="font-maven text-sm text-kidville-muted">Nessun fratello/sorella registrato</p>
                            </div>
                        )}
                    </section>

                    {/* ===== SEGNALAZIONI E RECLAMI ===== */}
                    <section className="pt-4 border-t border-kidville-line">
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            📌 Segnalazioni e Reclami
                        </h3>
                        
                        {tasksLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                Caricamento segnalazioni...
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
                                                    {isCompleted ? 'Risolto' : 'Attivo'}
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
                                                    <p className="text-[8px] font-bold text-kidville-muted uppercase tracking-wider">Allegati:</p>
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
                                                <span>Categoria: {task.category}</span>
                                                <span>Aperto il {new Date(task.created_at).toLocaleDateString('it-IT')}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-5 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line ">
                                <span className="text-2xl block mb-1">📋</span>
                                <p className="font-maven text-sm text-kidville-muted">Nessun reclamo o segnalazione</p>
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
                                Salva Modifiche
                            </>
                        )}
                    </button>

                    {/* Hard Delete GDPR */}
                    <button
                        onClick={handleDelete}
                        className={`w-full h-10 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm transition-all flex items-center justify-center gap-2 ${
                            showDeleteConfirm
                                ? 'bg-kidville-error text-white hover:bg-kidville-error'
                                : 'bg-kidville-error-soft text-kidville-error border-2 border-kidville-error-soft hover:bg-kidville-error-soft'
                        }`}
                    >
                        <Trash2 size={14} />
                        {showDeleteConfirm
                            ? '⚠️ Conferma eliminazione definitiva (GDPR)'
                            : 'Elimina Alunno (GDPR)'
                        }
                    </button>

                    {showDeleteConfirm && (
                        <div className="bg-kidville-error-soft border border-kidville-error-soft rounded-xl p-3">
                            <p className="font-maven text-xs text-kidville-error">
                                <strong>Attenzione:</strong> Questa azione è <strong>irreversibile</strong> e cancellerà tutti i dati dell&apos;alunno dal sistema (diario, presenze, armadietto). Un record audit verrà conservato.
                            </p>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                className="mt-2 text-xs font-maven font-bold text-kidville-muted hover:text-kidville-ink"
                            >
                                Annulla
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
