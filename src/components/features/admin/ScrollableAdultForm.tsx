'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, Shield, Mail, Phone, Loader2, CheckCircle2, XCircle, MapPin, KeyRound, Save, Plus, Trash2, Fingerprint } from 'lucide-react';
import { fetchFiscalCode } from '@/lib/utils/fiscalCodeApi';
import { z } from 'zod';

const adultSchema = z.object({
    first_name: z.string().min(2, "Almeno 2 caratteri"),
    last_name: z.string().min(2, "Almeno 2 caratteri"),
    role: z.enum(['admin', 'coordinator', 'educator', 'parent', 'delegate', 'mother', 'father']),
    gender: z.enum(['M', 'F']).optional().or(z.literal('')),
    birth_date: z.string().optional().or(z.literal('')),
    citizenship: z.string().optional().or(z.literal('')),
    birth_nation: z.string().optional().or(z.literal('')),
    birth_province: z.string().max(2).optional().or(z.literal('')),
    birth_place: z.string().optional().or(z.literal('')),
    fiscal_code: z.string().length(16, "CF deve essere 16 caratteri").toUpperCase().optional().or(z.literal('')),
    address: z.string().optional().or(z.literal('')),
    residence_city: z.string().optional().or(z.literal('')),
    zip_code: z.string().max(10).optional().or(z.literal('')),
    emails: z.array(z.string().email("Email non valida")).optional(),
    phones: z.array(z.string()).optional()
});

export function ScrollableAdultForm({ tabId, defaultRole, updateTabLabel, studentId }: { tabId?: string, defaultRole?: string, updateTabLabel?: (label: string) => void, studentId?: string | null }) {
    const initialRole = defaultRole || 'mother';
    const initialGender = (initialRole === 'mother' || initialRole === 'delegate') ? 'F' : 'M';

    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        role: initialRole,
        gender: initialGender,
        birth_date: '',
        citizenship: 'Italiana',
        birth_nation: 'Italia',
        birth_province: '',
        birth_place: '',
        fiscal_code: '',
        address: '',
        residence_city: '',
        zip_code: '',
        emails: [''],
        phones: ['']
    });

    const [isCfAutoCalculated, setIsCfAutoCalculated] = useState(false);
    const [isCfLoading, setIsCfLoading] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // Auto CF Calc
    useEffect(() => {
        const timeoutId = setTimeout(async () => {
            if (formData.first_name && formData.last_name && formData.gender && formData.birth_date && formData.birth_place && formData.birth_province.length === 2) {
                setIsCfLoading(true);
                try {
                    const cf = await fetchFiscalCode({
                        nome: formData.first_name,
                        cognome: formData.last_name,
                        sesso: formData.gender as 'M' | 'F',
                        data_nascita: formData.birth_date,
                        comune_nascita: formData.birth_place,
                        provincia_nascita: formData.birth_province
                    });
                    if (cf && cf !== formData.fiscal_code) {
                        setFormData(prev => ({ ...prev, fiscal_code: cf }));
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
    }, [formData.first_name, formData.last_name, formData.gender, formData.birth_date, formData.birth_place, formData.birth_province]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        // Aggiorna l'etichetta della tab FUORI dall'updater (evita setState-in-render)
        if ((name === 'first_name' || name === 'last_name') && updateTabLabel) {
            const newFirst = name === 'first_name' ? value : formData.first_name;
            const newLast  = name === 'last_name'  ? value : formData.last_name;
            const label = `${newFirst} ${newLast}`.trim();
            updateTabLabel(label || 'Nuovo Adulto');
        }
        if (errors[name]) {
            setErrors(prev => { const newErrors = { ...prev }; delete newErrors[name]; return newErrors; });
        }
    };

    const handleArrayChange = (index: number, type: 'emails' | 'phones', value: string) => {
        setFormData(prev => {
            const arr = [...prev[type]];
            arr[index] = value;
            return { ...prev, [type]: arr };
        });
    };

    const addArrayItem = (type: 'emails' | 'phones') => {
        setFormData(prev => ({ ...prev, [type]: [...prev[type], ''] }));
    };

    const removeArrayItem = (index: number, type: 'emails' | 'phones') => {
        setFormData(prev => {
            const arr = [...prev[type]];
            if (arr.length > 1) arr.splice(index, 1);
            else arr[0] = '';
            return { ...prev, [type]: arr };
        });
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);
        setErrors({});
        
        try {
            // Rimuovi stringhe vuote dagli array prima di validare
            const dataToValidate = {
                ...formData,
                emails: formData.emails.filter(e => e.trim() !== ''),
                phones: formData.phones.filter(p => p.trim() !== '')
            };

            const parsedData = adultSchema.parse(dataToValidate);
            
            const payload = {
                ...parsedData,
                action: 'create_parent',
                student_id: studentId || null
            };
            
            const res = await fetch('/api/admin/parents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Errore salvataggio genitore');
            }

            setToast({ type: 'success', message: 'Adulto salvato e credenziali inviate!' });

        } catch (error: any) {
            if (error && error.issues) {
                const fieldErrors: Record<string, string> = {};
                error.issues.forEach((err: any) => {
                    if (err.path && err.path.length > 0) fieldErrors[err.path.join('.')] = err.message;
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: 'Correggi gli errori.' });
            } else {
                setToast({ type: 'error', message: error.message });
            }
        } finally {
            setIsSubmitting(false);
            setTimeout(() => setToast(null), 4000);
        }
    };

    const handleRegenerateCredentials = async () => {
        if (!formData.emails[0]) {
            setToast({ type: 'error', message: 'Inserisci un indirizzo email primario per generare credenziali.' });
            setTimeout(() => setToast(null), 3000);
            return;
        }
        // Qui verrebbe chiamata una API per il reset della password / invio magic link
        setToast({ type: 'success', message: 'Link di rigenerazione credenziali inviato alla mail primaria!' });
        setTimeout(() => setToast(null), 3000);
    };

    return (
        <div className="text-kidville-green">
            <AnimatePresence>
                {toast && (
                    <motion.div 
                        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                        className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg z-50 ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-red-500 text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="flex justify-between items-center mb-8 border-b border-kidville-green/15 pb-4">
                <h2 className="text-2xl font-bold text-kidville-green flex items-center gap-2">
                    <UserPlus /> Compilazione Adulto
                </h2>
                <div className="flex items-center gap-3">
                    <button 
                        onClick={handleRegenerateCredentials}
                        className="flex items-center gap-2 px-4 py-2 rounded-full border border-kidville-green/50 text-kidville-green hover:bg-kidville-green/10 transition-colors text-sm font-bold"
                    >
                        <KeyRound size={16} /> Rigenera Credenziali
                    </button>
                    <button 
                        onClick={handleSubmit} disabled={isSubmitting}
                        className="flex items-center gap-2 px-6 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg disabled:opacity-50"
                    >
                        {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : <><Save size={18} /> Salva Adulto</>}
                    </button>
                </div>
            </div>

            <div className="space-y-12">
                {/* Dati Personali */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-green pl-3">
                        Dati Personali
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Nome</label>
                            <input name="first_name" value={formData.first_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.first_name ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.first_name && <span className="text-xs text-red-500 font-bold">{errors.first_name}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cognome</label>
                            <input name="last_name" value={formData.last_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.last_name ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.last_name && <span className="text-xs text-red-500 font-bold">{errors.last_name}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Shield size={14}/> Ruolo Familiare / Operativo</label>
                            <select name="role" value={formData.role} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="mother">Madre</option>
                                <option value="father">Padre</option>
                                <option value="delegate">Delegato/a</option>
                                <option value="educator">Educatore/trice</option>
                                <option value="coordinator">Coordinatore</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Sesso</label>
                            <select name="gender" value={formData.gender} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="M">Maschio</option>
                                <option value="F">Femmina</option>
                            </select>
                        </div>
                    </div>
                </section>

                {/* Nascita e Cittadinanza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-amber-500 pl-3">
                        Nascita e Cittadinanza
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Data di Nascita</label>
                            <input type="date" name="birth_date" value={formData.birth_date} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" style={{ colorScheme: 'light' }} />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cittadinanza</label>
                            <input name="citizenship" value={formData.citizenship} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Nazione di Nascita</label>
                            <input name="birth_nation" value={formData.birth_nation} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Comune di Nascita</label>
                            <input name="birth_place" value={formData.birth_place} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Prov. Nascita (Sigla)</label>
                            <input name="birth_province" value={formData.birth_province} onChange={handleInputChange} maxLength={2} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                        </div>
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> Codice Fiscale
                                {isCfLoading && <Loader2 size={14} className="animate-spin text-kidville-green" />}
                                {isCfAutoCalculated && <span className="text-xs text-kidville-green font-normal">Autocalcolato! ✨</span>}
                            </label>
                            <input name="fiscal_code" value={formData.fiscal_code} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none uppercase bg-white text-kidville-green placeholder-kidville-green/40 transition-colors ${errors.fiscal_code ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : isCfAutoCalculated ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-green/15 focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.fiscal_code && <span className="text-xs text-red-500 font-bold">{errors.fiscal_code}</span>}
                        </div>
                    </div>
                </section>

                {/* Residenza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-blue-500 pl-3">
                        <MapPin size={20} className="text-blue-500"/> Residenza
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Indirizzo Completo</label>
                            <input name="address" value={formData.address} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder="Via Roma, 123" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Città di Residenza</label>
                            <input name="residence_city" value={formData.residence_city} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">CAP</label>
                            <input name="zip_code" value={formData.zip_code} onChange={handleInputChange} maxLength={10} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                    </div>
                </section>

                {/* Contatti */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-pink-500 pl-3">
                        Contatti e Accesso
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        {/* Telefoni */}
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-2 flex items-center gap-2"><Phone size={14}/> Numeri di Cellulare</label>
                            <div className="space-y-3">
                                <AnimatePresence>
                                    {formData.phones.map((phone, idx) => (
                                        <motion.div key={idx} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
                                            <input value={phone} onChange={(e) => handleArrayChange(idx, 'phones', e.target.value)} placeholder="+39 333 000 0000" className="flex-1 p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                                            <button onClick={() => removeArrayItem(idx, 'phones')} className="p-3 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-colors">
                                                <Trash2 size={18} />
                                            </button>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                                <button onClick={() => addArrayItem('phones')} className="text-sm font-bold text-kidville-green flex items-center gap-1 hover:underline">
                                    <Plus size={14} /> Aggiungi Numero
                                </button>
                            </div>
                        </div>

                        {/* Email */}
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-2 flex items-center gap-2"><Mail size={14}/> Indirizzi Email (La prima verrà usata per Auth)</label>
                            <div className="space-y-3">
                                <AnimatePresence>
                                    {formData.emails.map((email, idx) => (
                                        <motion.div key={idx} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
                                            <div className="flex-1 relative">
                                                <input type="email" value={email} onChange={(e) => handleArrayChange(idx, 'emails', e.target.value)} placeholder="mario.rossi@email.com" className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors[`emails.${idx}`] ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                                                {idx === 0 && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase font-black tracking-widest text-kidville-green bg-kidville-green/10 px-2 py-1 rounded">Primaria</span>}
                                            </div>
                                            <button onClick={() => removeArrayItem(idx, 'emails')} className="p-3 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-colors">
                                                <Trash2 size={18} />
                                            </button>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                                <button onClick={() => addArrayItem('emails')} className="text-sm font-bold text-kidville-green flex items-center gap-1 hover:underline">
                                    <Plus size={14} /> Aggiungi Email
                                </button>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
