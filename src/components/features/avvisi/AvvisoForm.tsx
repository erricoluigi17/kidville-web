'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send } from 'lucide-react';

interface Props {
    open: boolean;
    onClose: () => void;
    onSubmit: (data: {
        titolo: string;
        contenuto: string;
        tipo: string;
        target_scope: string;
        target_classes: string[];
        scadenza: string | null;
    }) => void;
    availableClasses?: string[];
}

export function AvvisoForm({ open, onClose, onSubmit, availableClasses = [] }: Props) {
    const [titolo, setTitolo] = useState('');
    const [contenuto, setContenuto] = useState('');
    const [tipo, setTipo] = useState<'presa_visione' | 'adesione'>('presa_visione');
    const [scope, setScope] = useState<'globale' | 'classe'>('globale');
    const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
    const [scadenza, setScadenza] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const toggleClass = (c: string) => {
        setSelectedClasses(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
    };

    const handleSubmit = async () => {
        if (!titolo.trim() || !contenuto.trim()) return;
        setSubmitting(true);
        await onSubmit({
            titolo: titolo.trim(), contenuto: contenuto.trim(), tipo,
            target_scope: scope, target_classes: scope === 'classe' ? selectedClasses : [],
            scadenza: scadenza || null,
        });
        setSubmitting(false);
        setTitolo(''); setContenuto(''); setTipo('presa_visione');
        setScope('globale'); setSelectedClasses([]); setScadenza('');
        onClose();
    };

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50" onClick={onClose} />
                    <motion.div
                        initial={{ opacity: 0, y: 30, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.97 }} transition={{ duration: 0.25 }}
                        className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg bg-white rounded-3xl shadow-2xl z-50 flex flex-col max-h-[90vh] overflow-hidden"
                    >
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                            <h2 className="font-barlow font-black text-lg text-kidville-green uppercase tracking-wide">Nuovo Avviso</h2>
                            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors">
                                <X size={14} strokeWidth={1.5} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Titolo</label>
                                <input value={titolo} onChange={e => setTitolo(e.target.value)} placeholder="Es. Gita al parco"
                                    className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Contenuto</label>
                                <textarea value={contenuto} onChange={e => setContenuto(e.target.value)} placeholder="Scrivi il testo dell'avviso..." rows={4}
                                    className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all resize-none" />
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Tipo</label>
                                <div className="flex gap-2">
                                    <button onClick={() => setTipo('presa_visione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'presa_visione' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>📖 Presa visione</button>
                                    <button onClick={() => setTipo('adesione')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${tipo === 'adesione' ? 'bg-purple-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>📋 Adesione</button>
                                </div>
                            </div>
                            <div>
                                <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Destinatari</label>
                                <div className="flex gap-2">
                                    <button onClick={() => setScope('globale')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'globale' ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>🌐 Tutti</button>
                                    <button onClick={() => setScope('classe')} className={`flex-1 py-2.5 rounded-2xl font-maven font-semibold text-sm transition-all ${scope === 'classe' ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>🏫 Per classe</button>
                                </div>
                            </div>
                            {scope === 'classe' && (
                                <div className="flex flex-wrap gap-2">
                                    {availableClasses.map(c => (
                                        <button key={c} onClick={() => toggleClass(c)} className={`px-3 py-1.5 rounded-xl font-maven text-sm transition-all ${selectedClasses.includes(c) ? 'bg-kidville-green text-kidville-yellow' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>{c}</button>
                                    ))}
                                </div>
                            )}
                            {tipo === 'adesione' && (
                                <div>
                                    <label className="font-maven font-medium text-xs text-gray-500 uppercase tracking-wide mb-1.5 block">Scadenza (opzionale)</label>
                                    <input type="date" value={scadenza} onChange={e => setScadenza(e.target.value)}
                                        className="w-full border-2 border-gray-200/60 rounded-2xl px-4 py-2.5 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:ring-2 focus:ring-kidville-green/20 focus:border-kidville-green/40 transition-all" />
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-gray-100">
                            <button onClick={handleSubmit} disabled={submitting || !titolo.trim() || !contenuto.trim()}
                                className="w-full py-3.5 rounded-2xl bg-kidville-green text-kidville-yellow font-barlow font-black text-lg uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-kidville-green/20">
                                {submitting ? <><div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" /> Pubblicazione...</>
                                    : <><Send size={16} strokeWidth={1.5} /> Pubblica Avviso</>}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
