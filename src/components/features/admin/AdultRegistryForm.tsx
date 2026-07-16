'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UserPlus, Shield, Mail, Phone, Loader2, CheckCircle2, XCircle, Building2 } from 'lucide-react';
import { z } from 'zod';

const adultSchema = z.object({
    first_name: z.string().min(2),
    last_name: z.string().min(2),
    role: z.enum(['admin', 'coordinator', 'educator', 'parent', 'delegate']),
    email: z.string().email().optional().or(z.literal('')),
    fiscal_code: z.string().length(16).toUpperCase().optional().or(z.literal('')),
    gender: z.enum(['M', 'F']).optional().or(z.literal('')),
    birth_date: z.string().optional().or(z.literal('')),
    birth_place: z.string().optional().or(z.literal('')),
    phone: z.string().optional().or(z.literal('')),
    // Multi-sede: la sede di destinazione. L'API adults la valida via
    // resolveScuolaScrittura (una sola sede per la scrittura).
    scuola_id: z.string().optional().or(z.literal(''))
});

interface Sede { id: string; nome: string }

export function AdultRegistryForm() {
    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        role: 'parent',
        email: '',
        fiscal_code: '',
        gender: 'M',
        birth_date: '',
        birth_place: '',
        phone: '',
        scuola_id: ''
    });

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [sedi, setSedi] = useState<Sede[]>([]);

    // Sedi accessibili (multi-sede): la select «Sede» compare solo se >1. Con una
    // sola sede il campo è superfluo — la risolve comunque resolveScuolaScrittura.
    useEffect(() => {
        let alive = true;
        fetch('/api/admin/sedi')
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (!alive || !Array.isArray(j?.data)) return;
                setSedi(j.data as Sede[]);
                if (j.data.length === 1) {
                    setFormData((prev) => ({ ...prev, scuola_id: (j.data[0] as Sede).id }));
                }
            })
            .catch(() => { /* best-effort: senza sedi la select non compare */ });
        return () => { alive = false; };
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        if (errors[name]) {
            setErrors(prev => {
                const newErrors = { ...prev };
                delete newErrors[name];
                return newErrors;
            });
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setErrors({});
        
        try {
            const parsedData = adultSchema.parse(formData);
            // scuola_id vuoto → undefined: l'API lo risolve via resolveScuolaScrittura.
            const body = { ...parsedData, scuola_id: formData.scuola_id || undefined };

            const res = await fetch('/api/admin/adults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Errore creazione adulto');
            }

            setToast({ type: 'success', message: 'Adulto salvato e credenziali inviate!' });
            setFormData({
                first_name: '', last_name: '', role: 'parent', email: '', fiscal_code: '', gender: 'M', birth_date: '', birth_place: '', phone: '',
                scuola_id: sedi.length === 1 ? sedi[0].id : ''
            });

        } catch (error) {
            if (error instanceof z.ZodError) {
                const fieldErrors: Record<string, string> = {};
                error.issues.forEach(err => {
                    if (err.path.length > 0) fieldErrors[err.path.join('.')] = err.message;
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: 'Correggi gli errori.' });
            } else {
                setToast({ type: 'error', message: (error as { message?: string })?.message ?? '' });
            }
        } finally {
            setIsSubmitting(false);
            setTimeout(() => setToast(null), 4000);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="w-full max-w-3xl mx-auto p-8 bg-white backdrop-blur-xl border border-kidville-green/15 rounded-3xl shadow-xl relative text-kidville-green">
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

            <h2 className="text-2xl font-bold text-kidville-green mb-6 flex items-center gap-3">
                <UserPlus className="text-kidville-green" /> Nuovo Adulto
            </h2>

            <div className="grid grid-cols-2 gap-6">
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1">Nome</label>
                    <input name="first_name" value={formData.first_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.first_name ? 'border-kidville-error' : 'border-kidville-green/15'}`} />
                </div>
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1">Cognome</label>
                    <input name="last_name" value={formData.last_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.last_name ? 'border-kidville-error' : 'border-kidville-green/15'}`} />
                </div>
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Shield size={14}/> Ruolo</label>
                    <select name="role" value={formData.role} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green">
                        <option value="parent">Genitore</option>
                        <option value="educator">Educatore</option>
                        <option value="coordinator">Coordinatore</option>
                        <option value="delegate">Delegato</option>
                    </select>
                </div>
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Mail size={14}/> Email (Genera Credenziali)</label>
                    <input type="email" name="email" value={formData.email} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.email ? 'border-kidville-error' : 'border-kidville-green/15'}`} placeholder="mario.rossi@email.com" />
                </div>
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1">Codice Fiscale</label>
                    <input name="fiscal_code" value={formData.fiscal_code} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green uppercase" />
                </div>
                <div>
                    <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Phone size={14}/> Telefono</label>
                    <input name="phone" value={formData.phone} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green" />
                </div>
                {sedi.length > 1 && (
                    <div className="col-span-2">
                        <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Building2 size={14}/> Sede</label>
                        <select name="scuola_id" value={formData.scuola_id} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green">
                            <option value="">Seleziona la sede…</option>
                            {sedi.map((s) => (
                                <option key={s.id} value={s.id}>{s.nome}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>

            <div className="mt-8 border-t border-kidville-green/15 pt-6 flex justify-end">
                <button type="submit" disabled={isSubmitting} className="flex items-center gap-2 px-8 py-3 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg disabled:opacity-50">
                    {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : 'Salva Profilo'}
                </button>
            </div>
        </form>
    );
}
