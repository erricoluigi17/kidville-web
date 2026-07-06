'use client';

import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, Shield, Mail, Phone, Loader2, MapPin, Plus, Trash2, Fingerprint } from 'lucide-react';
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
    civico: z.string().max(20).optional().or(z.literal('')),
    residence_city: z.string().optional().or(z.literal('')),
    residence_province: z.string().max(2).optional().or(z.literal('')),
    zip_code: z.string().max(10).optional().or(z.literal('')),
    emails: z.array(z.string().email("Email non valida")).optional(),
    phones: z.array(z.string()).optional()
});

export interface AdultFormHandle {
    // Scheda mai compilata (nome+cognome vuoti): va SALTATA dal salvataggio unico,
    // così si può registrare l'alunno con un solo genitore (o nessuno).
    isEmpty: () => boolean;
    // Valida i campi (mostra gli errori inline) e ritorna il payload per il POST
    // /api/admin/parents (action create_parent), oppure { ok:false } se invalido.
    validate: () => { ok: true; data: Record<string, unknown> } | { ok: false };
    reset: () => void;
}

export const ScrollableAdultForm = forwardRef<AdultFormHandle, { defaultRole?: string; updateTabLabel?: (label: string) => void }>(
    function ScrollableAdultForm({ defaultRole, updateTabLabel }, ref) {
    const initialRole = defaultRole || 'mother';
    const initialGender = (initialRole === 'mother' || initialRole === 'delegate') ? 'F' : 'M';

    const initialFormData = {
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
        civico: '',
        residence_city: '',
        residence_province: '',
        zip_code: '',
        emails: [''],
        phones: ['']
    };

    const [formData, setFormData] = useState(initialFormData);

    const [isCfAutoCalculated, setIsCfAutoCalculated] = useState(false);
    const [isCfLoading, setIsCfLoading] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});

    // Specchio dell'ultimo valore di formData.fiscal_code: permette all'effect di
    // confrontare il CF corrente senza dipendere da formData.fiscal_code (deps invariate)
    const fiscalCodeRef = useRef('');

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
                    if (cf && cf !== fiscalCodeRef.current) {
                        fiscalCodeRef.current = cf;
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
        if (name === 'fiscal_code') fiscalCodeRef.current = value;
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

    // Salvataggio orchestrato dal contenitore (FamilyRegistryManager): qui solo
    // validazione + estrazione del payload (il role serve al collegamento lato server).
    useImperativeHandle(ref, () => ({
        isEmpty() {
            return !formData.first_name.trim() && !formData.last_name.trim();
        },
        validate() {
            setErrors({});
            try {
                const dataToValidate = {
                    ...formData,
                    emails: formData.emails.filter(e => e.trim() !== ''),
                    phones: formData.phones.filter(p => p.trim() !== ''),
                };
                const parsedData = adultSchema.parse(dataToValidate);
                return { ok: true as const, data: { ...parsedData } };
            } catch (error) {
                const zodLike = error as { issues?: { path?: (string | number)[]; message: string }[] };
                if (zodLike && zodLike.issues) {
                    const fieldErrors: Record<string, string> = {};
                    zodLike.issues.forEach((err) => {
                        if (err.path && err.path.length > 0) fieldErrors[err.path.join('.')] = err.message;
                    });
                    setErrors(fieldErrors);
                }
                return { ok: false as const };
            }
        },
        reset() {
            fiscalCodeRef.current = '';
            setErrors({});
            setFormData({ ...initialFormData });
        },
    }), [formData]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="text-kidville-green">
            <div className="flex items-center mb-8 border-b border-kidville-green/15 pb-4">
                <h2 className="text-2xl font-bold text-kidville-green flex items-center gap-2">
                    <UserPlus /> Compilazione Adulto
                </h2>
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
                            <input name="first_name" value={formData.first_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.first_name ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.first_name && <span className="text-xs text-kidville-error font-bold">{errors.first_name}</span>}
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cognome</label>
                            <input name="last_name" value={formData.last_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.last_name ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.last_name && <span className="text-xs text-kidville-error font-bold">{errors.last_name}</span>}
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
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-warn pl-3">
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
                            <input name="fiscal_code" value={formData.fiscal_code} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none uppercase bg-white text-kidville-green placeholder-kidville-green/40 transition-colors ${errors.fiscal_code ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : isCfAutoCalculated ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-green/15 focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.fiscal_code && <span className="text-xs text-kidville-error font-bold">{errors.fiscal_code}</span>}
                        </div>
                    </div>
                </section>

                {/* Residenza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        <MapPin size={20} className="text-kidville-info"/> Residenza
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Indirizzo di Residenza</label>
                            <input name="address" value={formData.address} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder="Via Roma" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Numero Civico</label>
                            <input name="civico" value={formData.civico} onChange={handleInputChange} maxLength={20} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder="123" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Città di Residenza</label>
                            <input name="residence_city" value={formData.residence_city} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1">Prov. Residenza (Sigla)</label>
                            <input name="residence_province" value={formData.residence_province} onChange={handleInputChange} maxLength={2} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
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
                                            <button onClick={() => removeArrayItem(idx, 'phones')} className="p-3 bg-kidville-error/10 text-kidville-error rounded-xl hover:bg-kidville-error/20 transition-colors">
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
                                                <input type="email" value={email} onChange={(e) => handleArrayChange(idx, 'emails', e.target.value)} placeholder="mario.rossi@email.com" className={`w-full p-3 rounded-xl border bg-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors[`emails.${idx}`] ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                                                {idx === 0 && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase font-black tracking-widest text-kidville-green bg-kidville-green/10 px-2 py-1 rounded">Primaria</span>}
                                            </div>
                                            <button onClick={() => removeArrayItem(idx, 'emails')} className="p-3 bg-kidville-error/10 text-kidville-error rounded-xl hover:bg-kidville-error/20 transition-colors">
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
});
