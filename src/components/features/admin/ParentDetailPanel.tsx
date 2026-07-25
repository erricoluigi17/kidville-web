'use client';

import { useState, useEffect } from 'react';
import { logClient } from '@/lib/logging/client';
import { useTranslations } from 'next-intl';
import { X, Save, Users, User, ChevronRight, KeyRound } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Strutture dati
interface LinkedParentRef {
    id: string;
    first_name: string;
    last_name: string;
}

interface ChildStudentParent {
    relation_type: string;
    parents: LinkedParentRef;
}

interface LinkedChild {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    student_parents?: ChildStudentParent[];
}

interface ParentProfile {
    id: string;
    first_name: string;
    last_name: string;
    gender: string;
    birth_date: string;
    birth_city: string;
    birth_province?: string;
    birth_nation?: string;
    fiscal_code: string;
    emails: string[];
    phone_numbers: string[];
    residence_address: string;
    residence_street_number?: string;
    residence_city: string;
    residence_province?: string;
    zip_code: string;
    citizenship?: string;
    student_parents?: {
        alunni: LinkedChild | null;
        is_primary: boolean;
        relation_type: string;
    }[];
}

interface Props {
    parentBasicInfo: { id: string } | null;
    onClose: () => void;
    onSave: (data: Partial<ParentProfile> & { id: string }) => void;
    // 'page' = scheda a tutta area (route /admin/students/[id]); 'drawer' = pannello laterale.
    variant?: 'drawer' | 'page';
}

export function ParentDetailPanel({ parentBasicInfo, onClose, onSave, variant = 'drawer' }: Props) {
    const t = useTranslations('adminStudents');
    const [parent, setParent] = useState<ParentProfile | null>(null);
    const [form, setForm] = useState<Partial<ParentProfile>>({});
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [expandedChild, setExpandedChild] = useState<string | null>(null);
    const [regen, setRegen] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
    const [regenMsg, setRegenMsg] = useState('');

    useEffect(() => {
        if (!parentBasicInfo) return;
        
        const fetchParentDetails = async () => {
            setIsLoading(true);
            try {
                const res = await fetch(`/api/admin/parents/${parentBasicInfo.id}`);
                if (!res.ok) throw new Error('Errore nel recupero dati');
                const data = await res.json();
                setParent(data);
                setForm(data);
            } catch {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'dettaglio-genitore-fallito', route: '/admin/students' });
            } finally {
                setIsLoading(false);
            }
        };

        fetchParentDetails();
    }, [parentBasicInfo]);

    if (!parentBasicInfo) return null;

    const handleSave = async () => {
        if (!parent) return;
        setIsSaving(true);
        try {
            await onSave({ id: parent.id, ...form });
        } finally {
            setIsSaving(false);
        }
    };

    const updateForm = <K extends keyof ParentProfile>(field: K, value: ParentProfile[K]) => {
        setForm(prev => ({ ...prev, [field]: value }));
    };

    const handleRegen = async () => {
        if (!parent) return;
        if (!confirm(t('parentConfermaRigenera'))) return;
        setRegen('loading');
        setRegenMsg('');
        try {
            const res = await fetch('/api/admin/regenerate-credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetKind: 'parent', targetId: parent.id }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || t('errore'));
            setRegen('done');
            setRegenMsg(
                body.pdf_notifica
                    ? t('credEmailPdf')
                    : body.email_inviata
                        ? t('credEmailInviata')
                        : body.warning || t('credRigenerate')
            );
        } catch (e) {
            setRegen('error');
            setRegenMsg((e as Error).message);
        }
    };

    const getChildrenTabs = (): LinkedChild[] => {
        if (!parent?.student_parents) return [];
        return parent.student_parents.map(sp => sp.alunni).filter((c): c is LinkedChild => Boolean(c));
    };

    const children = getChildrenTabs();

    const isPage = variant === 'page';
    const shellCls = isPage
        ? 'flex w-full flex-col rounded-card bg-kidville-white shadow-sm'
        : 'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-kidville-white shadow-2xl';
    const bodyCls = isPage ? 'p-5 md:p-6 space-y-5 custom-scrollbar' : 'flex-1 overflow-y-auto p-5 space-y-5 custom-scrollbar';

    return (
        <>
            {/* Backdrop — solo nel pannello laterale */}
            {!isPage && <div className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />}

            {/* Contenitore: pannello laterale oppure scheda a tutta area */}
            <div className={shellCls}>
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-kidville-line">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                            <Users size={20} />
                            {form.citizenship === 'educator' || form.citizenship === 'coordinator'
                                ? t('parentMembroStaff')
                                : t('parentAnagrafica')}
                        </h2>
                        <p className="font-maven text-sm text-kidville-muted mt-0.5">
                            {form.first_name || ''} {form.last_name || ''}
                        </p>
                    </div>
                    {!isPage && (
                        <button
                            onClick={onClose}
                            className="w-8 h-8 rounded-full bg-kidville-line flex items-center justify-center text-kidville-muted hover:text-kidville-ink"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {isLoading ? (
                    <div className={`${isPage ? 'py-16' : 'flex-1'} flex flex-col items-center justify-center gap-4`}>
                        <div className="w-8 h-8 border-4 border-kidville-line border-t-kidville-green rounded-full animate-spin"></div>
                        <p className="font-maven text-kidville-muted">{t('parentCaricamento')}</p>
                    </div>
                ) : (
                    <div className={bodyCls}>
                        {/* Dati Anagrafici */}
                        <section>
                            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                                {t('datiPersonali')}
                            </h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNome')}</label>
                                    <input
                                        type="text"
                                        value={(form.first_name as string) ?? ''}
                                        onChange={e => updateForm('first_name', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCognome')}</label>
                                    <input
                                        type="text"
                                        value={(form.last_name as string) ?? ''}
                                        onChange={e => updateForm('last_name', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 mt-3">
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataNascita')}</label>
                                    <input
                                        type="date"
                                        value={(form.birth_date as string) ?? ''}
                                        onChange={e => updateForm('birth_date', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCodiceFiscale')}</label>
                                    <input
                                        type="text"
                                        value={(form.fiscal_code as string) ?? ''}
                                        onChange={e => updateForm('fiscal_code', e.target.value.toUpperCase())}
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

                        {/* Recapiti e Residenza */}
                        <section>
                            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                                {t('parentRecapitiResidenza')}
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
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCitta')}</label>
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
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoTelefono')}</label>
                                    <input
                                        type="text"
                                        value={form.phone_numbers?.[0] || ''}
                                        onChange={e => {
                                            const newPhones = [...(form.phone_numbers || [])];
                                            newPhones[0] = e.target.value;
                                            updateForm('phone_numbers', newPhones);
                                        }}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('parentEmailPrincipale')}</label>
                                    <input
                                        type="email"
                                        value={form.emails?.[0] || ''}
                                        onChange={e => {
                                            const newEmails = [...(form.emails || [])];
                                            newEmails[0] = e.target.value;
                                            updateForm('emails', newEmails);
                                        }}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                            </div>
                        </section>

                        {/* Figli Collegati */}
                        {children.length > 0 && (
                            <section>
                                <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                                    <User size={12} className="text-kidville-green" />
                                    {t('parentAlunniCollegati')}
                                </h3>

                                <div className="space-y-3">
                                    {children.map((child) => {
                                        const otherParents = child.student_parents?.filter((sp) => sp.parents?.id !== parent?.id) || [];
                                        const isExpanded = expandedChild === child.id;

                                        return (
                                            <div key={child.id} className="bg-kidville-cream border border-kidville-line rounded-xl overflow-hidden transition-all">
                                                {/* Header Figlio */}
                                                <div 
                                                    className={`p-4 flex items-center justify-between cursor-pointer hover:bg-kidville-line ${isExpanded ? 'bg-kidville-green/5 border-b border-kidville-green/10' : ''}`}
                                                    onClick={() => setExpandedChild(isExpanded ? null : child.id)}
                                                >
                                                    <div>
                                                        <h4 className="font-barlow font-bold text-kidville-ink uppercase tracking-wide">
                                                            {child.nome} {child.cognome}
                                                        </h4>
                                                        <p className="font-maven text-xs text-kidville-muted mt-0.5">
                                                            {child.classe_sezione || t('detailNessunaSezione')}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] font-bold uppercase tracking-wider bg-kidville-green/10 text-kidville-green px-2 py-1 rounded-md">
                                                            {t('parentFiglio')}
                                                        </span>
                                                        <ChevronRight size={16} className={`text-kidville-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                                                    </div>
                                                </div>

                                                {/* Dettagli Altri Familiari (A Soffietto) */}
                                                <AnimatePresence>
                                                    {isExpanded && (
                                                        <motion.div
                                                            initial={{ height: 0, opacity: 0 }}
                                                            animate={{ height: 'auto', opacity: 1 }}
                                                            exit={{ height: 0, opacity: 0 }}
                                                            className="overflow-hidden"
                                                        >
                                                            <div className="p-4 bg-kidville-white/50">
                                                                {otherParents.length > 0 ? (
                                                                    <>
                                                                        <h5 className="font-maven text-[10px] text-kidville-muted uppercase tracking-wider mb-2 font-bold">{t('parentAltriFamiliari')}</h5>
                                                                        <div className="space-y-2">
                                                                            {otherParents.map((sp) => (
                                                                                <div key={sp.parents.id} className="flex items-center gap-3 p-3 bg-kidville-white border border-kidville-line rounded-lg shadow-sm">
                                                                                    <div className="w-8 h-8 rounded-full bg-kidville-info-soft text-kidville-info flex items-center justify-center">
                                                                                        <User size={14} />
                                                                                    </div>
                                                                                    <div>
                                                                                        <p className="font-barlow font-bold text-sm text-kidville-ink leading-tight">
                                                                                            {sp.parents.first_name} {sp.parents.last_name}
                                                                                        </p>
                                                                                        <p className="font-maven text-[10px] text-kidville-muted capitalize mt-0.5">
                                                                                            {sp.relation_type === 'mother' ? t('ruoloMadre') : sp.relation_type === 'father' ? t('ruoloPadre') : t('ruoloDelegato')}
                                                                                        </p>
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </>
                                                                ) : (
                                                                    <p className="font-maven text-xs text-kidville-muted text-center py-2">{t('parentNessunAltroFamiliare')}</p>
                                                                )}
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>
                        )}
                    </div>
                )}

                {/* Footer actions */}
                <div className="flex-shrink-0 p-5 border-t border-kidville-line bg-kidville-white space-y-2">
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
                    <button
                        onClick={handleRegen}
                        disabled={regen === 'loading' || !parent}
                        className="w-full h-11 rounded-pill border-2 border-kidville-green/40 text-kidville-green font-barlow font-bold uppercase text-sm hover:bg-kidville-green/5 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        <KeyRound size={15} /> {regen === 'loading' ? t('parentRigenerazione') : t('rigeneraCredenziali')}
                    </button>
                    {regenMsg && (
                        <p className={`text-xs text-center font-maven ${regen === 'error' ? 'text-kidville-error' : 'text-kidville-success'}`}>{regenMsg}</p>
                    )}
                </div>
            </div>
        </>
    );
}
