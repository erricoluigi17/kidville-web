'use client';

import { useState, useEffect, useCallback } from 'react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';

const PARENT_ID = '33333333-3333-3333-3333-333333333333';
const STUDENT_ID = 'dc617529-e80d-4084-9041-fb28e864089f'; // dev default

export default function ParentAvvisiPage() {
    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);

    const loadAvvisi = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/avvisi?classe=Girasoli&parentId=${PARENT_ID}`);
            if (res.ok) setAvvisi(await res.json());
        } catch (err) {
            console.error('Errore caricamento avvisi:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    const handleReadReceipt = async (avvisoId: string) => {
        try {
            await fetch(`/api/avvisi/${avvisoId}/risposte`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: PARENT_ID, student_id: STUDENT_ID }),
            });
            await loadAvvisi();
        } catch (err) {
            console.error('Errore presa visione:', err);
        }
    };

    const handleAdesione = async (avvisoId: string, risposta: 'si' | 'no') => {
        try {
            await fetch(`/api/avvisi/${avvisoId}/risposte`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: PARENT_ID, student_id: STUDENT_ID, risposta }),
            });
            await loadAvvisi();
        } catch (err) {
            console.error('Errore adesione:', err);
        }
    };

    return (
        <div className="max-w-lg mx-auto p-4 sm:p-6 pb-16">
            {/* Header */}
            <div className="mb-6">
                <h1 className="font-barlow font-black text-3xl text-kidville-green uppercase tracking-wide">
                    📋 Avvisi
                </h1>
                <p className="font-maven text-gray-400 mt-1 text-sm">
                    Comunicazioni dalla scuola
                </p>
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-gray-400">Caricamento...</p>
                </div>
            )}

            {/* Empty */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📭</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">Nessun avviso</h2>
                    <p className="font-maven text-gray-400 text-sm max-w-xs">
                        Non ci sono comunicazioni dalla scuola al momento
                    </p>
                </div>
            )}

            {/* Avvisi */}
            {!loading && avvisi.length > 0 && (
                <div className="space-y-3">
                    {avvisi.map((avviso, idx) => (
                        <AvvisoCard key={avviso.id} avviso={avviso} index={idx}
                            onReadReceipt={handleReadReceipt}
                            onAdesione={handleAdesione} />
                    ))}
                </div>
            )}

            {/* Footer */}
            <div className="mt-8 p-4 bg-white/50 backdrop-blur-sm rounded-2xl border border-white/30 text-center">
                <p className="font-maven text-xs text-gray-400">
                    📋 Gli avvisi restano visibili fino alla loro scadenza.<br />
                    Le prese visione vengono registrate automaticamente.
                </p>
            </div>
        </div>
    );
}
