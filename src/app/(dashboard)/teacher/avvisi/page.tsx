'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm } from '@/components/features/avvisi/AvvisoForm';

const TEACHER_ID = '22222222-2222-2222-2222-222222222222';
const AVAILABLE_CLASSES = ['Girasoli', 'Margherite', 'Tulipani', '3A', '4B'];

export default function TeacherAvvisiPage() {
    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);

    const loadAvvisi = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/avvisi');
            if (res.ok) setAvvisi(await res.json());
        } catch (err) {
            console.error('Errore caricamento avvisi:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    const handleCreate = async (data: {
        titolo: string; contenuto: string; tipo: string;
        target_scope: string; target_classes: string[]; scadenza: string | null;
    }) => {
        try {
            const res = await fetch('/api/avvisi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ author_id: TEACHER_ID, ...data }),
            });
            if (res.ok) await loadAvvisi();
        } catch (err) {
            console.error('Errore creazione avviso:', err);
        }
    };

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-6">
                <div>
                    <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                        📋 Bacheca Avvisi
                    </h1>
                    <p className="font-maven text-gray-500 mt-1">Circolari e comunicazioni alle famiglie</p>
                </div>
                <button onClick={() => setShowForm(true)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-kidville-green text-kidville-yellow font-barlow font-bold text-sm uppercase rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all shadow-lg shadow-kidville-green/20">
                    <Plus size={16} strokeWidth={1.5} /> Nuovo
                </button>
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-gray-400">Caricamento avvisi...</p>
                </div>
            )}

            {/* Empty state */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📢</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">Nessun avviso</h2>
                    <p className="font-maven text-gray-400 text-sm max-w-xs">
                        Crea il tuo primo avviso per comunicare con le famiglie
                    </p>
                </div>
            )}

            {/* Avvisi list */}
            {!loading && avvisi.length > 0 && (
                <div className="space-y-3">
                    {avvisi.map((avviso, idx) => (
                        <AvvisoCard key={avviso.id} avviso={avviso} index={idx} isTeacher />
                    ))}
                </div>
            )}

            {/* Form modale */}
            <AvvisoForm open={showForm} onClose={() => setShowForm(false)}
                onSubmit={handleCreate} availableClasses={AVAILABLE_CLASSES} />
        </div>
    );
}
