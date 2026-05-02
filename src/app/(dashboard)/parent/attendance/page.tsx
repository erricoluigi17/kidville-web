'use client';

import { useState } from 'react';
import { CheckCircle } from 'lucide-react';

export default function ParentAttendancePage() {
    const [reason, setReason] = useState('');
    const [isSubmitted, setIsSubmitted] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // Qui invieremmo l'assenza a Supabase
        setIsSubmitted(true);
    };

    if (isSubmitted) {
        return (
            <div className="max-w-md mx-auto p-6 mt-10 bg-kidville-white rounded-card shadow-sm text-center">
                <div className="w-16 h-16 bg-kidville-success/10 text-kidville-success rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle size={32} />
                </div>
                <h2 className="font-barlow font-bold text-2xl text-kidville-green uppercase mb-2">
                    Avviso Inviato
                </h2>
                <p className="font-maven text-gray-600 mb-6">
                    La scuola è stata notificata dell'assenza. Grazie per la collaborazione.
                </p>
                <button 
                    onClick={() => setIsSubmitted(false)}
                    className="h-10 px-6 font-maven rounded-pill bg-kidville-cream text-kidville-green hover:bg-kidville-green hover:text-kidville-yellow transition-colors"
                >
                    Torna Indietro
                </button>
            </div>
        );
    }

    return (
        <div className="max-w-md mx-auto p-4 sm:p-6">
            <div className="mb-6">
                <h1 className="font-barlow font-bold text-3xl text-kidville-green uppercase tracking-wide">
                    Avviso Assenza
                </h1>
                <p className="font-maven text-gray-500 mt-1">Giulia Bianchi</p>
            </div>

            <form onSubmit={handleSubmit} className="bg-kidville-white p-6 rounded-card shadow-sm">
                <div className="mb-4">
                    <label className="block font-maven font-medium text-kidville-green mb-2">
                        Motivo dell'assenza (opzionale)
                    </label>
                    <textarea 
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl p-3 font-maven focus:outline-none focus:border-kidville-green focus:ring-1 focus:ring-kidville-green resize-none h-32"
                        placeholder="Es. Influenza, motivi familiari..."
                    />
                </div>

                <button 
                    type="submit"
                    className="w-full h-12 font-barlow font-bold text-lg rounded-pill bg-kidville-green text-kidville-yellow hover:opacity-90 transition-opacity"
                >
                    Comunica Assenza
                </button>
            </form>
        </div>
    );
}
