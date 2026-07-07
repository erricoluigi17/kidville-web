'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Users, Plus, Heart, ShieldCheck, Trash2, Save, Loader2, CheckCircle2, XCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { ScrollableStudentForm, type StudentFormHandle } from './ScrollableStudentForm';
import { ScrollableAdultForm, type AdultFormHandle } from './ScrollableAdultForm';

interface TabDef {
    id: string;
    label: string;
    type: 'student' | 'adult';
    removable: boolean;
    defaultRole?: string;
}

export function FamilyRegistryManager() {
    const [tabs, setTabs] = useState<TabDef[]>([
        { id: 'alunno', label: 'Alunno', type: 'student', removable: false },
        { id: 'madre', label: 'Madre', type: 'adult', removable: false, defaultRole: 'mother' },
        { id: 'padre', label: 'Padre', type: 'adult', removable: false, defaultRole: 'father' },
    ]);
    const [activeTab, setActiveTab] = useState('alunno');
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [savedSummary, setSavedSummary] = useState<{ studentName: string; parents: number; failed: { label: string; error?: string }[] } | null>(null);

    // Ref imperativi: ogni form resta auto-contenuto ma espone validate()/reset().
    // Tutti i form restano MONTATI (solo l'attivo è visibile) così lo stato e i ref
    // non si perdono cambiando tab — requisito del salvataggio unico.
    const studentRef = useRef<StudentFormHandle | null>(null);
    const adultRefs = useRef<Record<string, AdultFormHandle | null>>({});

    const showToast = (t: { type: 'success' | 'error'; message: string }) => {
        setToast(t);
        setTimeout(() => setToast(null), 4500);
    };

    const addAdultTab = () => {
        const newId = `adulto-${tabs.length}-${Math.round(performance.now())}`;
        setTabs(prev => [...prev, { id: newId, label: 'Nuovo Componente', type: 'adult', removable: true, defaultRole: 'delegate' }]);
        setActiveTab(newId);
    };

    const removeTab = (tabId: string) => {
        delete adultRefs.current[tabId];
        setTabs(prev => prev.filter(t => t.id !== tabId));
        if (activeTab === tabId) setActiveTab('alunno');
    };

    const getTabIcon = (tab: TabDef) => {
        if (tab.type === 'student') return <User size={16} />;
        if (tab.defaultRole === 'mother') return <Heart size={16} />;
        if (tab.defaultRole === 'father') return <ShieldCheck size={16} />;
        return <Users size={16} />;
    };

    // Salvataggio UNICO: valida alunno + tutti i genitori, poi crea l'alunno e
    // collega ogni genitore. Se l'alunno fallisce, non si crea nulla (niente più
    // genitori orfani). Errori per-persona riportati senza perdere il resto.
    const handleSaveAll = async () => {
        const sv = studentRef.current?.validate();
        if (!sv || !sv.ok) {
            setActiveTab('alunno');
            showToast({ type: 'error', message: 'Correggi i dati dell’alunno evidenziati.' });
            return;
        }

        const adultTabs = tabs.filter(t => t.type === 'adult');
        const adultPayloads: { tabId: string; label: string; data: Record<string, unknown> }[] = [];
        for (const t of adultTabs) {
            const h = adultRefs.current[t.id];
            if (!h) continue;
            if (h.isEmpty()) continue; // scheda mai compilata → saltata
            const r = h.validate();
            if (!r.ok) {
                setActiveTab(t.id);
                showToast({ type: 'error', message: `Correggi i dati di “${t.label}”.` });
                return;
            }
            adultPayloads.push({ tabId: t.id, label: t.label, data: r.data });
        }

        setSaving(true);
        try {
            // Salvataggio ATOMICO: alunno + genitori in un'unica richiesta lato server
            // (niente più genitori "persi" né alunni duplicati al retry).
            const sres = await fetch('/api/admin/students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...sv.data, parents: adultPayloads.map(a => a.data) }),
            });
            if (!sres.ok) {
                const e = await sres.json().catch(() => ({}));
                throw new Error(e.error || 'Errore nel salvataggio dell’alunno');
            }
            const student = await sres.json();
            const results: { label: string; ok: boolean; error?: string }[] = Array.isArray(student.parents) ? student.parents : [];
            const failed = results.filter(r => !r.ok).map(r => ({ label: r.label, error: r.error }));

            const studentName = `${String(sv.data.nome ?? '')} ${String(sv.data.cognome ?? '')}`.trim();
            if (failed.length) {
                showToast({ type: 'error', message: `Alunno salvato, ma errore su: ${failed.map(f => f.label).join(', ')}.` });
            }
            setSavedSummary({ studentName, parents: results.filter(r => r.ok).length, failed });
        } catch (err) {
            showToast({ type: 'error', message: (err as Error).message });
        } finally {
            setSaving(false);
        }
    };

    const resetAll = () => {
        setSavedSummary(null);
        studentRef.current?.reset();
        Object.values(adultRefs.current).forEach(h => h?.reset());
        // Rimuove eventuali componenti extra, torna a madre/padre.
        setTabs([
            { id: 'alunno', label: 'Alunno', type: 'student', removable: false },
            { id: 'madre', label: 'Madre', type: 'adult', removable: false, defaultRole: 'mother' },
            { id: 'padre', label: 'Padre', type: 'adult', removable: false, defaultRole: 'father' },
        ]);
        setActiveTab('alunno');
    };

    if (savedSummary) {
        return (
            <div className="w-full max-w-5xl mx-auto">
                <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center justify-center gap-6 py-16 text-center bg-white border border-kidville-green/15 rounded-3xl shadow-xl"
                >
                    <div className="w-20 h-20 rounded-full bg-kidville-green/20 flex items-center justify-center">
                        <CheckCircle2 size={44} className="text-kidville-green" />
                    </div>
                    <div>
                        <h3 className="text-2xl font-black font-barlow text-kidville-green uppercase tracking-wide">Anagrafica salvata!</h3>
                        <p className="text-kidville-green/80 font-maven mt-1 text-lg">{savedSummary.studentName}</p>
                        <p className="text-kidville-muted font-maven text-sm mt-1">
                            {savedSummary.parents === 0
                                ? 'Nessun genitore collegato'
                                : `${savedSummary.parents} ${savedSummary.parents === 1 ? 'genitore collegato' : 'genitori collegati'}`}
                        </p>
                    </div>
                    {savedSummary.failed.length > 0 && (
                        <div className="w-full max-w-md rounded-2xl border border-kidville-error/30 bg-kidville-error/5 p-4 text-left">
                            <p className="flex items-center gap-2 font-barlow font-bold text-kidville-error uppercase text-sm">
                                <XCircle size={16} /> Alcuni genitori non salvati
                            </p>
                            <ul className="mt-2 space-y-1">
                                {savedSummary.failed.map((f, i) => (
                                    <li key={i} className="font-maven text-xs text-kidville-error">
                                        <b>{f.label}</b>{f.error ? ` — ${f.error}` : ''}
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2 font-maven text-xs text-kidville-muted">
                                L&apos;alunno è stato salvato. Puoi riaggiungere questi genitori dalla scheda dell&apos;alunno.
                            </p>
                        </div>
                    )}
                    <div className="flex gap-3 mt-2">
                        <Link
                            href="/admin/students"
                            className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green text-white rounded-xl font-barlow font-bold uppercase text-sm hover:opacity-90 transition-all"
                        >
                            Vai alla lista alunni <ArrowRight size={16} />
                        </Link>
                        <button
                            onClick={resetAll}
                            className="flex items-center gap-2 px-5 py-2.5 bg-kidville-cream border border-kidville-green/15 text-kidville-green rounded-xl font-barlow font-bold uppercase text-sm hover:bg-kidville-green-light transition-all"
                        >
                            <RefreshCw size={16} /> Nuova anagrafica
                        </button>
                    </div>
                </motion.div>
            </div>
        );
    }

    return (
        <div className="w-full max-w-5xl mx-auto">
            {/* Toast globale */}
            <AnimatePresence>
                {toast && (
                    <motion.div
                        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                        className={`fixed top-6 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-kidville-error text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Barra azione con il pulsante di salvataggio UNICO, fuori dalle schede */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                    <h1 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">Nuova anagrafica</h1>
                    <p className="font-maven text-sm text-kidville-muted">Compila l&apos;alunno e i genitori, poi premi <b>Salva anagrafica</b>: verranno salvati e collegati insieme.</p>
                </div>
                <button
                    onClick={handleSaveAll}
                    disabled={saving}
                    className="flex items-center gap-2 px-6 py-3 rounded-full bg-kidville-green text-white font-barlow font-black uppercase text-sm hover:opacity-90 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                    {saving ? 'Salvataggio…' : 'Salva anagrafica'}
                </button>
            </div>

            {/* Top Tabs */}
            <div className="flex flex-wrap gap-2 mb-6 p-2 bg-white backdrop-blur-md rounded-2xl border border-kidville-green/15 shadow-sm w-fit">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`relative px-5 py-3 rounded-xl font-bold text-sm transition-colors flex items-center gap-2 ${activeTab === tab.id ? 'text-white' : 'text-kidville-muted hover:text-kidville-green'}`}
                    >
                        {activeTab === tab.id && (
                            <motion.div
                                layoutId="activeFamilyTabIndicator"
                                className="absolute inset-0 bg-kidville-green rounded-xl shadow-lg"
                                initial={false}
                                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                            />
                        )}
                        <span className="relative z-10 flex items-center gap-2">
                            {getTabIcon(tab)}
                            {tab.label}
                            {tab.removable && (
                                <span
                                    onClick={(e) => { e.stopPropagation(); removeTab(tab.id); }}
                                    className="ml-1 p-0.5 rounded-full hover:bg-kidville-error/30 text-kidville-muted hover:text-kidville-error transition-colors"
                                >
                                    <Trash2 size={12} />
                                </span>
                            )}
                        </span>
                    </button>
                ))}

                <button
                    onClick={addAdultTab}
                    className="relative px-4 py-3 rounded-xl font-bold text-sm text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-colors flex items-center gap-2 border border-dashed border-kidville-green/30"
                >
                    <Plus size={16} /> Aggiungi Componente
                </button>
            </div>

            {/* Contenuto — tutti i form restano montati; visibile solo l'attivo */}
            <div className="relative min-h-[600px]">
                {tabs.map((tab) => (
                    <div key={tab.id} className={activeTab === tab.id ? 'block' : 'hidden'}>
                        <div className="bg-white backdrop-blur-2xl border border-kidville-green/15 p-8 rounded-3xl shadow-xl text-kidville-green">
                            {tab.type === 'student' ? (
                                <ScrollableStudentForm ref={studentRef} />
                            ) : (
                                <ScrollableAdultForm
                                    ref={(h) => { adultRefs.current[tab.id] = h; }}
                                    defaultRole={tab.defaultRole}
                                    updateTabLabel={(label) => setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, label } : t))}
                                />
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
