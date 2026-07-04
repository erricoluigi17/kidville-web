'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Fingerprint, FileWarning, User, AlertTriangle, Loader2, CheckCircle2, XCircle, Save, ArrowRight, RefreshCw } from 'lucide-react';
import { fetchFiscalCode } from '@/lib/utils/fiscalCodeApi';
import { z } from 'zod';
import { AllergeniSelect } from '@/components/features/admin/AllergeniSelect';
import { useSediAttive } from '@/lib/context/sede-context';

const studentSchema = z.object({
    nome: z.string().min(2, "Il nome deve avere almeno 2 caratteri"),
    cognome: z.string().min(2, "Il cognome deve avere almeno 2 caratteri"),
    sesso: z.enum(['M', 'F']),
    data_nascita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida"),
    comune_nascita: z.string().min(2, "Comune non valido"),
    provincia_nascita: z.string().length(2, "Sigla provincia deve essere 2 lettere"),
    codice_fiscale: z.string().optional().or(z.literal('')),
    indirizzo_residenza: z.string().optional().or(z.literal('')),
    comune_residenza: z.string().optional().or(z.literal('')),
    cap: z.string().optional().or(z.literal('')),
    classe_sezione: z.string().optional().or(z.literal('')),
    is_bes_dsa: z.boolean(),
    note_bes: z.string().optional(),
    usa_pannolino: z.boolean().optional(),
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

interface ScrollableStudentFormProps {
    onSaveSuccess?: (studentId: string) => void;
}

export function ScrollableStudentForm({ onSaveSuccess }: ScrollableStudentFormProps = {}) {
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
        classe_sezione: '',
        scuola_id: '',
        is_bes_dsa: false,
        note_bes: '',
        usa_pannolino: false,
        allergies: '',
        allergeni: [] as string[],
        invoice_holder_type: 'mom',
        invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' }
    });

    const [sections, setSections] = useState<{id: string, name: string, school_type: string}[]>([]);
    // Sedi reali accessibili all'utente (contesto multi-sede). La sede attiva
    // (sedeCorrente) fa da default; con >1 sedi accessibili si può scegliere.
    const { sedi, sedeCorrente } = useSediAttive();
    const scuolaSelezionata = formData.scuola_id || sedeCorrente || (sedi[0]?.id ?? '');
    const [isCfAutoCalculated, setIsCfAutoCalculated] = useState(false);
    const [isCfLoading, setIsCfLoading] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [savedStudent, setSavedStudent] = useState<{ id: string; nome: string; cognome: string } | null>(null);

    // Specchio dell'ultimo valore di formData.codice_fiscale: permette all'effect di
    // confrontare il CF corrente senza dipendere da formData.codice_fiscale (deps invariate)
    const codiceFiscaleRef = useRef('');

    // Carica sezioni all'avvio
    useEffect(() => {
        fetch('/api/admin/sections').then(r => r.json()).then(d => { if (Array.isArray(d)) setSections(d); }).catch(() => {});
    }, []);

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
        }, 800);

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
        setErrors({});
        setIsSubmitting(true);
        try {
            const parsedData = studentSchema.parse(formData);
            
            const res = await fetch('/api/admin/students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // scuola_id: sede scelta (default = sede attiva). Il server la valida
                // via resolveScuolaScrittura contro le sedi accessibili.
                body: JSON.stringify({ ...parsedData, scuola_id: scuolaSelezionata })
            });

            if (!res.ok) {
                let errorMsg = 'Errore nel salvataggio';
                try {
                    const errorData = await res.json();
                    errorMsg = errorData.error || errorMsg;
                } catch { /* risposta non-JSON, ignoriamo */ }
                throw new Error(errorMsg);
            }

            const responseData = await res.json();

            setSavedStudent({ id: responseData.id, nome: formData.nome, cognome: formData.cognome });
            
            if (onSaveSuccess && responseData.id) {
                onSaveSuccess(responseData.id);
            }

        } catch (error) {
            const zodLike = error as { issues?: { path?: (string | number)[]; message: string }[] };
            if (zodLike && zodLike.issues) {
                const fieldErrors: Record<string, string> = {};
                zodLike.issues.forEach((err) => {
                    if (err.path && err.path.length > 0) {
                        fieldErrors[err.path.join('.')] = err.message;
                    }
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: 'Correggi gli errori evidenziati nel form.' });
            } else {
                setToast({ type: 'error', message: (error as Error).message || 'Errore sconosciuto' });
            }
            setTimeout(() => setToast(null), 5000);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="text-kidville-green">
            {/* Pannello di conferma salvataggio — mostrato al posto del form */}
            {savedStudent ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center justify-center gap-6 py-10 text-center"
                >
                    <div className="w-20 h-20 rounded-full bg-kidville-green/20 flex items-center justify-center">
                        <CheckCircle2 size={44} className="text-kidville-green" />
                    </div>
                    <div>
                        <h3 className="text-2xl font-black font-barlow text-kidville-green uppercase tracking-wide">
                            Alunno Salvato!
                        </h3>
                        <p className="text-kidville-green/80 font-maven mt-1 text-lg">
                            {savedStudent.nome} {savedStudent.cognome}
                        </p>
                        <p className="text-kidville-muted font-maven text-sm mt-1">
                            ID: {savedStudent.id.slice(0, 8)}...
                        </p>
                    </div>

                    <div className="bg-kidville-success-soft border border-kidville-success-soft rounded-xl px-5 py-3 text-kidville-success text-sm font-maven font-bold flex items-center gap-2">
                        <CheckCircle2 size={15} />
                        Ora compila Madre e Padre per collegare i genitori
                    </div>

                    <div className="flex gap-3 mt-2">
                        <a
                            href="/admin/students"
                            className="flex items-center gap-2 px-5 py-2.5 bg-kidville-green text-white rounded-xl font-barlow font-bold uppercase text-sm hover:opacity-90 transition-all"
                        >
                            Vai alla lista alunni <ArrowRight size={16} />
                        </a>
                        <button
                            onClick={() => {
                                setSavedStudent(null);
                                codiceFiscaleRef.current = '';
                                setFormData({ nome: '', cognome: '', sesso: 'M', data_nascita: '', comune_nascita: '', provincia_nascita: '', codice_fiscale: '', indirizzo_residenza: '', comune_residenza: '', cap: '', classe_sezione: '', scuola_id: '', is_bes_dsa: false, note_bes: '', usa_pannolino: false, allergies: '', allergeni: [], invoice_holder_type: 'mom', invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' } });
                            }}
                            className="flex items-center gap-2 px-5 py-2.5 bg-kidville-cream border border-kidville-green/15 text-kidville-green rounded-xl font-barlow font-bold uppercase text-sm hover:bg-kidville-green-light transition-all"
                        >
                            <RefreshCw size={16} /> Nuovo alunno
                        </button>
                    </div>
                </motion.div>
            ) : (
            <>
            <AnimatePresence>
                {toast && (
                    <motion.div 
                        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                        className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg z-50 ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-kidville-error text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="flex justify-between items-center mb-8 border-b border-kidville-green/15 pb-4">
                <h2 className="text-2xl font-bold text-kidville-green flex items-center gap-2">
                    <User /> Compilazione Alunno
                </h2>
                <button 
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="flex items-center gap-2 px-6 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                    {isSubmitting ? 'Salvataggio...' : 'Salva Alunno'}
                </button>
            </div>

            <div className="space-y-12">
                {/* Sezione 1: Dati Personali */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-green pl-3">
                        Dati Personali
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Nome</label>
                            <input name="nome" value={formData.nome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.nome ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.nome && <span className="text-xs text-kidville-error font-bold">{errors.nome}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cognome</label>
                            <input name="cognome" value={formData.cognome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.cognome ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.cognome && <span className="text-xs text-kidville-error font-bold">{errors.cognome}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Sesso</label>
                            <select name="sesso" value={formData.sesso} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="M">Maschio</option>
                                <option value="F">Femmina</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Data di Nascita</label>
                            <input type="date" name="data_nascita" value={formData.data_nascita} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.data_nascita ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} style={{ colorScheme: 'light' }} />
                            {errors.data_nascita && <span className="text-xs text-kidville-error font-bold">{errors.data_nascita}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Comune di Nascita</label>
                            <input name="comune_nascita" value={formData.comune_nascita} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.comune_nascita ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.comune_nascita && <span className="text-xs text-kidville-error font-bold">{errors.comune_nascita}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Prov. Nascita (Sigla)</label>
                            <input name="provincia_nascita" value={formData.provincia_nascita} onChange={handleInputChange} maxLength={2} className={`w-full p-3 rounded-xl border outline-none uppercase bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.provincia_nascita ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.provincia_nascita && <span className="text-xs text-kidville-error font-bold">{errors.provincia_nascita}</span>}
                        </div>
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> Codice Fiscale 
                                {isCfLoading && <Loader2 size={14} className="animate-spin text-kidville-green" />}
                                {isCfAutoCalculated && <span className="text-xs text-kidville-green font-normal">Autocalcolato! ✨</span>}
                            </label>
                            <input 
                                name="codice_fiscale" 
                                value={formData.codice_fiscale} 
                                onChange={handleInputChange} 
                                className={`w-full p-3 rounded-xl border outline-none uppercase transition-all duration-500 bg-white text-kidville-green placeholder-kidville-green/40 ${errors.codice_fiscale ? 'border-kidville-error bg-kidville-error-soft shadow-[0_0_10px_rgba(239,68,68,0.3)]' : isCfAutoCalculated ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-green/15 focus:ring-2 focus:ring-kidville-green'}`} 
                            />
                            {errors.codice_fiscale && <span className="text-xs text-kidville-error font-bold">{errors.codice_fiscale}</span>}
                        </div>
                    </div>
                </section>

                {/* Sezione 1b: Sede e Sezione */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        Sede e Sezione
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Sede</label>
                            <select
                                name="scuola_id"
                                value={scuolaSelezionata}
                                onChange={handleInputChange}
                                disabled={sedi.length <= 1}
                                className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green disabled:opacity-70"
                            >
                                {sedi.length === 0 && <option value="">Nessuna sede disponibile</option>}
                                {sedi.map(s => (
                                    <option key={s.id} value={s.id}>{s.nome}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Sezione</label>
                            <select 
                                name="classe_sezione" 
                                value={formData.classe_sezione} 
                                onChange={handleInputChange}
                                className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green focus:ring-2 focus:ring-kidville-green ${errors.classe_sezione ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`}
                            >
                                <option value="">— Seleziona sezione —</option>
                                {sections.map(s => (
                                    <option key={s.id} value={s.name}>{s.name} ({s.school_type})</option>
                                ))}
                            </select>
                            {errors.classe_sezione && <span className="text-xs text-kidville-error font-bold">{errors.classe_sezione}</span>}
                        </div>
                    </div>
                </section>

                {/* Sezione 2: Residenza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        Residenza
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Indirizzo di Residenza</label>
                            <input name="indirizzo_residenza" value={formData.indirizzo_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.indirizzo_residenza ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} placeholder="Via Roma, 1" />
                            {errors.indirizzo_residenza && <span className="text-xs text-kidville-error font-bold">{errors.indirizzo_residenza}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Comune di Residenza</label>
                            <input name="comune_residenza" value={formData.comune_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.comune_residenza ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.comune_residenza && <span className="text-xs text-kidville-error font-bold">{errors.comune_residenza}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">CAP</label>
                            <input name="cap" value={formData.cap} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.cap ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} maxLength={5} />
                            {errors.cap && <span className="text-xs text-kidville-error font-bold">{errors.cap}</span>}
                        </div>
                    </div>
                </section>

                {/* Sezione 3: Medica / BES */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-error pl-3">
                        Informazioni Mediche / BES
                    </h3>
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <AlertTriangle size={16} className="text-kidville-error" /> Allergie e Intolleranze
                            </label>
                            <AllergeniSelect value={formData.allergeni} onChange={next => setFormData(prev => ({ ...prev, allergeni: next }))} />
                            {formData.allergies?.trim() && (
                                <p className="mt-2 rounded-xl bg-kidville-cream px-3 py-2 font-maven text-xs text-kidville-muted">
                                    Testo storico (sola lettura): {formData.allergies}
                                </p>
                            )}
                        </div>

                        <div className="p-4 bg-kidville-warn-soft/10 rounded-2xl border border-kidville-warn">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="is_bes_dsa" checked={formData.is_bes_dsa} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-warn/50 bg-white text-kidville-warn focus:ring-kidville-warn" />
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
                                        <textarea name="note_bes" value={formData.note_bes} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-warn bg-white text-kidville-green focus:ring-2 focus:ring-kidville-warn outline-none" rows={2} placeholder="Dettagli aggiuntivi..." />
                                        <div className="mt-3 text-sm text-kidville-warn/80">I documenti (PEI, Diagnosi) potranno essere caricati nella scheda Documenti dopo il salvataggio.</div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        <div className="p-4 bg-kidville-info-soft0/10 rounded-2xl border border-kidville-info/30">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="usa_pannolino" checked={formData.usa_pannolino} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-info-soft/50 bg-white text-kidville-info focus:ring-kidville-info" />
                                <span className="font-bold text-kidville-info flex items-center gap-2">
                                    🧷 Usa pannolino
                                </span>
                            </label>
                            <p className="mt-2 text-sm text-kidville-info/80">Se attivo, ogni evento &quot;Bagno&quot; nel Diario 0-6 scala automaticamente 1 pannolino dall&apos;armadietto del bambino.</p>
                        </div>
                    </div>
                </section>

                {/* Sezione 4: Amministrazione */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        Amministrazione & Fatturazione
                    </h3>
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-2">Intestatario Fattura</label>
                            <div className="flex gap-4">
                                {['mom', 'dad', 'other'].map(type => (
                                    <label key={type} className={`flex-1 flex items-center justify-center p-3 rounded-xl border cursor-pointer transition-all ${formData.invoice_holder_type === type ? 'border-kidville-green bg-kidville-green/20 text-kidville-green font-bold' : 'border-kidville-green/15 text-kidville-muted hover:bg-kidville-cream'}`}>
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
                                    className="p-6 border border-kidville-info/30 bg-kidville-info-soft0/5 rounded-2xl overflow-hidden mt-2"
                                >
                                    <div className="flex items-center justify-between mb-4">
                                        <h4 className="font-bold text-kidville-info">Dettagli Intestatario Fattura Alternativo</h4>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Nome</label>
                                            <input name="invoice_holder_details.nome" value={formData.invoice_holder_details.nome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cognome</label>
                                            <input name="invoice_holder_details.cognome" value={formData.invoice_holder_details.cognome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Codice Fiscale Intestatario</label>
                                            <input name="invoice_holder_details.codice_fiscale" value={formData.invoice_holder_details.codice_fiscale} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                                        </div>
                                        <div className="col-span-2 text-xs text-kidville-muted mt-2">
                                            Nota: Salvando l&apos;anagrafica, questo soggetto verrà registrato come intestatario della fattura per l&apos;alunno.
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </section>
            </div>
            </>
            )}
        </div>
    );
}
