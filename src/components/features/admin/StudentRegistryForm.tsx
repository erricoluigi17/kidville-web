'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Fingerprint, FileWarning, Users, Activity, Home, User, AlertTriangle, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { fetchFiscalCode } from '@/lib/utils/fiscalCodeApi';
import { z } from 'zod';
import { AllergeniSelect } from '@/components/features/admin/AllergeniSelect';

const studentSchema = z.object({
    nome: z.string().min(2, "Il nome deve avere almeno 2 caratteri"),
    cognome: z.string().min(2, "Il cognome deve avere almeno 2 caratteri"),
    sesso: z.enum(['M', 'F']),
    data_nascita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida"),
    comune_nascita: z.string().min(2, "Comune non valido"),
    provincia_nascita: z.string().length(2, "Sigla provincia deve essere 2 lettere"),
    codice_fiscale: z.string().length(16, "Il CF deve essere di 16 caratteri").toUpperCase(),
    indirizzo_residenza: z.string().min(5, "Indirizzo non valido"),
    comune_residenza: z.string().min(2, "Comune non valido"),
    cap: z.string().length(5, "CAP deve essere di 5 cifre"),
    is_bes_dsa: z.boolean(),
    note_bes: z.string().optional(),
    allergies: z.string().optional(),
    allergeni: z.array(z.string()).optional(),
    invoice_holder_type: z.enum(['mom', 'dad', 'other']),
    invoice_holder_details: z.object({
        nome: z.string().optional(),
        cognome: z.string().optional(),
        codice_fiscale: z.string().optional(),
        adult_id: z.string().optional()
    }).optional()
});

export function StudentRegistryForm() {
    const [step, setStep] = useState(1);
    
    // Form state
    const [formData, setFormData] = useState({
        nome: '',
        cognome: '',
        sesso: 'M',
        data_nascita: '',
        comune_nascita: '',
        provincia_nascita: '',
        codice_fiscale: '',
        indirizzo_residenza: '',
        comune_residenza: '',
        cap: '',
        is_bes_dsa: false,
        note_bes: '',
        allergies: '',
        allergeni: [] as string[],
        invoice_holder_type: 'mom',
        invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' }
    });

    const [isCfAutoCalculated, setIsCfAutoCalculated] = useState(false);
    const [isCfLoading, setIsCfLoading] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // Specchio dell'ultimo valore di formData.codice_fiscale: permette all'effect di
    // confrontare il CF corrente senza dipendere da formData.codice_fiscale (deps invariate)
    const codiceFiscaleRef = useRef('');

    // Auto calculate CF
    useEffect(() => {
        const timeoutId = setTimeout(async () => {
            if (formData.nome && formData.cognome && formData.sesso && formData.data_nascita && formData.comune_nascita && formData.provincia_nascita.length === 2) {
                setIsCfLoading(true);
                try {
                    const cf = await fetchFiscalCode({
                        nome: formData.nome,
                        cognome: formData.cognome,
                        sesso: formData.sesso as 'M' | 'F',
                        data_nascita: formData.data_nascita,
                        comune_nascita: formData.comune_nascita,
                        provincia_nascita: formData.provincia_nascita
                    });
                    if (cf && cf !== codiceFiscaleRef.current) {
                        codiceFiscaleRef.current = cf;
                        setFormData(prev => ({ ...prev, codice_fiscale: cf }));
                        setIsCfAutoCalculated(true);
                        setTimeout(() => setIsCfAutoCalculated(false), 3000);
                    }
                } catch (error) {
                    console.error("CF calculation error", error);
                } finally {
                    setIsCfLoading(false);
                }
            }
        }, 800); // Debounce di 800ms

        return () => clearTimeout(timeoutId);
    }, [formData.nome, formData.cognome, formData.sesso, formData.data_nascita, formData.comune_nascita, formData.provincia_nascita]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target as HTMLInputElement;
        const checked = (e.target as HTMLInputElement).checked;

        if (name === 'codice_fiscale') codiceFiscaleRef.current = value;

        if (name.startsWith('invoice_holder_details.')) {
            const field = name.split('.')[1];
            setFormData(prev => ({
                ...prev,
                invoice_holder_details: { ...prev.invoice_holder_details, [field]: value }
            }));
        } else {
            setFormData(prev => ({
                ...prev,
                [name]: type === 'checkbox' ? checked : value
            }));
        }
        
        if (errors[name]) {
            setErrors(prev => {
                const newErrors = { ...prev };
                delete newErrors[name];
                return newErrors;
            });
        }
    };

    const handleSubmit = async () => {
        try {
            // Validazione Zod
            const parsedData = studentSchema.parse(formData);
            
            // Simulo fetch al server
            const res = await fetch('/api/admin/students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(parsedData)
            });

            if (!res.ok) {
                const errorData = await res.json();
                throw new Error(errorData.error || "Errore nel salvataggio");
            }

            setToast({ type: 'success', message: 'Anagrafica salvata con successo!' });
            setTimeout(() => { setToast(null); setStep(1); }, 3000);

        } catch (error) {
            const zodLike = error as { errors?: { path?: (string | number)[]; message: string }[] };
            if (error instanceof z.ZodError || (zodLike && Array.isArray(zodLike.errors))) {
                const fieldErrors: Record<string, string> = {};
                (zodLike.errors || []).forEach((err) => {
                    if (err.path && err.path.length > 0) {
                        fieldErrors[err.path.join('.')] = err.message;
                    }
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: 'Correggi gli errori evidenziati nel form.' });
            } else {
                setToast({ type: 'error', message: (error as Error).message });
            }
            setTimeout(() => setToast(null), 4000);
        }
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-8 bg-white/5 backdrop-blur-lg border border-white/10 rounded-3xl shadow-xl relative">
            
            {/* Custom Toast */}
            <AnimatePresence>
                {toast && (
                    <motion.div 
                        initial={{ opacity: 0, y: -20 }} 
                        animate={{ opacity: 1, y: 0 }} 
                        exit={{ opacity: 0, y: -20 }}
                        className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg z-50 ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-kidville-error text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            <h2 className="text-2xl font-bold text-kidville-green mb-6 font-maven flex items-center gap-2">
                <User className="text-kidville-green" /> Anagrafica Alunno
            </h2>

            {/* Stepper Header */}
            <div className="flex gap-4 mb-8 border-b border-kidville-line pb-4">
                {[
                    { num: 1, label: 'Dati Personali', icon: <User size={16} /> },
                    { num: 2, label: 'Residenza', icon: <Home size={16} /> },
                    { num: 3, label: 'Medica / BES', icon: <Activity size={16} /> },
                    { num: 4, label: 'Amministrazione', icon: <Users size={16} /> },
                ].map(s => (
                    <button
                        key={s.num}
                        onClick={() => setStep(s.num)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm transition-all duration-300 ${step === s.num ? 'bg-kidville-green text-white shadow-md' : 'text-kidville-muted hover:bg-kidville-cream'}`}
                    >
                        {s.icon} {s.label}
                    </button>
                ))}
            </div>

            {/* Form Steps */}
            <div className="min-h-[300px]">
                {step === 1 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Nome</label>
                            <input name="nome" value={formData.nome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none transition-all ${errors.nome ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.nome && <span className="text-xs text-kidville-error">{errors.nome}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Cognome</label>
                            <input name="cognome" value={formData.cognome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none transition-all ${errors.cognome ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.cognome && <span className="text-xs text-kidville-error">{errors.cognome}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Sesso</label>
                            <select name="sesso" value={formData.sesso} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line focus:ring-2 focus:ring-kidville-green outline-none bg-white">
                                <option value="M">Maschio</option>
                                <option value="F">Femmina</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Data di Nascita</label>
                            <input type="date" name="data_nascita" value={formData.data_nascita} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.data_nascita ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.data_nascita && <span className="text-xs text-kidville-error">{errors.data_nascita}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Comune di Nascita</label>
                            <input name="comune_nascita" value={formData.comune_nascita} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.comune_nascita ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.comune_nascita && <span className="text-xs text-kidville-error">{errors.comune_nascita}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Prov. Nascita (Sigla)</label>
                            <input name="provincia_nascita" value={formData.provincia_nascita} onChange={handleInputChange} maxLength={2} className={`w-full p-3 rounded-xl border outline-none uppercase ${errors.provincia_nascita ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.provincia_nascita && <span className="text-xs text-kidville-error">{errors.provincia_nascita}</span>}
                        </div>
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-ink mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> Codice Fiscale 
                                {isCfLoading && <Loader2 size={14} className="animate-spin text-kidville-green" />}
                                {isCfAutoCalculated && <span className="text-xs text-kidville-green font-normal">Autocalcolato! ✨</span>}
                            </label>
                            <input 
                                name="codice_fiscale" 
                                value={formData.codice_fiscale} 
                                onChange={handleInputChange} 
                                className={`w-full p-3 rounded-xl border outline-none uppercase transition-all duration-500 ${errors.codice_fiscale ? 'border-kidville-error bg-kidville-error-soft' : isCfAutoCalculated ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} 
                            />
                            {errors.codice_fiscale && <span className="text-xs text-kidville-error">{errors.codice_fiscale}</span>}
                        </div>
                    </motion.div>
                )}

                {step === 2 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Indirizzo di Residenza</label>
                            <input name="indirizzo_residenza" value={formData.indirizzo_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.indirizzo_residenza ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} placeholder="Via Roma, 1" />
                            {errors.indirizzo_residenza && <span className="text-xs text-kidville-error">{errors.indirizzo_residenza}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">Comune di Residenza</label>
                            <input name="comune_residenza" value={formData.comune_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.comune_residenza ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.comune_residenza && <span className="text-xs text-kidville-error">{errors.comune_residenza}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1">CAP</label>
                            <input name="cap" value={formData.cap} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.cap ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} maxLength={5} />
                            {errors.cap && <span className="text-xs text-kidville-error">{errors.cap}</span>}
                        </div>
                    </motion.div>
                )}

                {step === 3 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1 flex items-center gap-2">
                                <AlertTriangle size={16} className="text-kidville-error" /> Allergie e Intolleranze
                            </label>
                            <AllergeniSelect value={formData.allergeni} onChange={next => setFormData(prev => ({ ...prev, allergeni: next }))} />
                            {formData.allergies?.trim() && (
                                <p className="mt-2 rounded-xl bg-kidville-cream px-3 py-2 font-maven text-xs text-kidville-muted">
                                    Testo storico (sola lettura): {formData.allergies}
                                </p>
                            )}
                        </div>

                        <div className="p-4 bg-kidville-warn-soft rounded-2xl border border-kidville-warn/30">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="is_bes_dsa" checked={formData.is_bes_dsa} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-warn/30 text-kidville-warn focus:ring-kidville-warn" />
                                <span className="font-bold text-kidville-warn flex items-center gap-2">
                                    <FileWarning size={18} /> Studente BES / DSA
                                </span>
                            </label>

                            <AnimatePresence>
                                {formData.is_bes_dsa && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="mt-4 overflow-hidden"
                                    >
                                        <label className="block text-sm font-bold text-kidville-warn mb-1">Note BES / DSA</label>
                                        <textarea name="note_bes" value={formData.note_bes} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-warn/30 bg-white focus:ring-2 focus:ring-kidville-warn outline-none" rows={2} placeholder="Dettagli aggiuntivi..." />
                                        <div className="mt-3 text-sm text-kidville-warn">I documenti (PEI, Diagnosi) potranno essere caricati nella scheda Documenti dopo il salvataggio.</div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}

                {step === 4 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-2">Intestatario Fattura</label>
                            <div className="flex gap-4">
                                {['mom', 'dad', 'other'].map(type => (
                                    <label key={type} className={`flex-1 flex items-center justify-center p-3 rounded-xl border cursor-pointer transition-all ${formData.invoice_holder_type === type ? 'border-kidville-green bg-kidville-green/10 text-kidville-green font-bold' : 'border-kidville-line text-kidville-muted hover:bg-kidville-cream'}`}>
                                        <input type="radio" name="invoice_holder_type" value={type} checked={formData.invoice_holder_type === type} onChange={handleInputChange} className="hidden" />
                                        {type === 'mom' ? 'Madre' : type === 'dad' ? 'Padre' : 'Altro Soggetto'}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <AnimatePresence>
                            {formData.invoice_holder_type === 'other' && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="p-4 border border-kidville-info/30 bg-kidville-info-soft/50 rounded-2xl overflow-hidden mt-2"
                                >
                                    <div className="flex items-center justify-between mb-4">
                                        <h4 className="font-bold text-kidville-info">Seleziona o Crea Adulto</h4>
                                        <button className="text-sm px-3 py-1 bg-white border border-kidville-info/30 rounded-full text-kidville-info font-medium hover:bg-kidville-info-soft">
                                            + Nuovo Adulto
                                        </button>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-bold text-kidville-ink mb-1">Nome</label>
                                            <input name="invoice_holder_details.nome" value={formData.invoice_holder_details.nome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-kidville-ink mb-1">Cognome</label>
                                            <input name="invoice_holder_details.cognome" value={formData.invoice_holder_details.cognome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="block text-sm font-bold text-kidville-ink mb-1">Codice Fiscale Intestatario</label>
                                            <input name="invoice_holder_details.codice_fiscale" value={formData.invoice_holder_details.codice_fiscale} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                                        </div>
                                        <div className="col-span-2 text-xs text-kidville-muted">
                                            Nota: Salvando questa anagrafica, questo adulto verrà automaticamente registrato e collegato con `is_invoice_holder = true`.
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </div>

            <div className="mt-8 flex justify-between border-t border-kidville-line pt-6">
                <button 
                    onClick={() => setStep(s => Math.max(1, s - 1))}
                    disabled={step === 1}
                    className="px-6 py-2 rounded-full font-bold text-kidville-muted disabled:opacity-50"
                >
                    Indietro
                </button>
                {step < 4 ? (
                    <button 
                        onClick={() => setStep(s => Math.min(4, s + 1))}
                        className="px-6 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg"
                    >
                        Avanti
                    </button>
                ) : (
                    <button 
                        onClick={handleSubmit}
                        className="px-8 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg ring-4 ring-kidville-green/20"
                    >
                        Salva Anagrafica
                    </button>
                )}
            </div>
        </div>
    );
}
