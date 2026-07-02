'use client';

import React, { useState } from 'react';
import { Mail, Key, User, Shield } from 'lucide-react';

export function ParentRegistryForm({ studentId }: { studentId?: string }) {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');

    const handleInvite = async () => {
        if (!email) return;
        setLoading(true);
        setMessage('');
        try {
            const res = await fetch('/api/admin/parents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'invite', email })
            });
            const data = await res.json();
            if (data.success) {
                setMessage('Credenziali rigenerate e inviate con successo!');
            } else {
                setMessage('Errore: ' + data.error);
            }
        } catch (error) {
            setMessage('Errore di connessione');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="w-full max-w-2xl mx-auto p-8 bg-white/5 backdrop-blur-lg border border-white/10 rounded-3xl shadow-xl">
            <h2 className="text-2xl font-bold text-kidville-green mb-6 font-maven flex items-center gap-2">
                <Shield className="text-kidville-green" /> Credenziali Genitore
            </h2>

            <div className="space-y-6">
                <div>
                    <label className="block text-sm font-bold text-kidville-ink mb-1 flex items-center gap-2">
                        <Mail size={16} /> Email Genitore
                    </label>
                    <input 
                        type="email" 
                        value={email} 
                        onChange={e => setEmail(e.target.value)} 
                        placeholder="mario.rossi@email.com"
                        className="w-full p-3 rounded-xl border border-kidville-line focus:ring-2 focus:ring-kidville-green outline-none" 
                    />
                </div>

                <div className="pt-4 flex items-center gap-4">
                    <button 
                        onClick={handleInvite}
                        disabled={loading || !email}
                        className="flex items-center gap-2 px-6 py-3 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg disabled:opacity-50 transition-all"
                    >
                        <Key size={18} /> {loading ? 'Invio in corso...' : 'Rigenera Credenziali'}
                    </button>
                    {message && (
                        <span className={`text-sm font-bold ${message.includes('Errore') ? 'text-kidville-error' : 'text-kidville-green'}`}>
                            {message}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
