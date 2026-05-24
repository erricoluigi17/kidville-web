'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm } from '@/components/features/avvisi/AvvisoForm';
import { AvvisoDetailsDrawer } from '@/components/features/avvisi/AvvisoDetailsDrawer';

const AVAILABLE_CLASSES = ['Girasoli', 'Margherite', 'Tulipani', '3A', '4B'];

function TeacherAvvisiContent() {
    const searchParams = useSearchParams();
    const teacherId = searchParams.get('userId') || '22222222-2222-2222-2222-222222222222';

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingAvviso, setEditingAvviso] = useState<Avviso | null>(null);
    const [selectedAvviso, setSelectedAvviso] = useState<Avviso | null>(null);
    const [showDetails, setShowDetails] = useState(false);

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

    const handleCreateOrUpdate = async (data: {
        titolo: string; contenuto: string; tipo: string;
        target_scope: string; target_classes: string[]; scadenza: string | null;
        attachment_url: string | null;
    }) => {
        try {
            if (editingAvviso) {
                // UPDATE (PUT)
                const res = await fetch(`/api/avvisi/${editingAvviso.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                });
                if (res.ok) {
                    await loadAvvisi();
                    setEditingAvviso(null);
                }
            } else {
                // CREATE (POST)
                const res = await fetch('/api/avvisi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ author_id: teacherId, ...data }),
                });
                if (res.ok) await loadAvvisi();
            }
        } catch (err) {
            console.error('Errore nel salvataggio dell\'avviso:', err);
        }
    };

    const handleDelete = async (avvisoId: string) => {
        if (!window.confirm("Sei sicuro di voler eliminare definitivamente questo avviso? Questa azione eliminerà anche tutte le risposte associate.")) return;
        try {
            const res = await fetch(`/api/avvisi/${avvisoId}`, {
                method: 'DELETE',
            });
            if (res.ok) await loadAvvisi();
        } catch (err) {
            console.error('Errore eliminazione avviso:', err);
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
                <button onClick={() => {
                    setEditingAvviso(null);
                    setShowForm(true);
                }}
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
                        <AvvisoCard
                            key={avviso.id}
                            avviso={avviso}
                            index={idx}
                            isTeacher
                            onShowDetails={(a) => {
                                setSelectedAvviso(a);
                                setShowDetails(true);
                            }}
                            onEdit={(a) => {
                                setEditingAvviso(a);
                                setShowForm(true);
                            }}
                            onDelete={handleDelete}
                        />
                    ))}
                </div>
            )}

            {/* Form modale */}
            <AvvisoForm
                open={showForm}
                onClose={() => {
                    setShowForm(false);
                    setEditingAvviso(null);
                }}
                onSubmit={handleCreateOrUpdate}
                availableClasses={AVAILABLE_CLASSES}
                initialAvviso={editingAvviso}
            />

            {/* Drawer Dettaglio Monitoraggio */}
            <AvvisoDetailsDrawer
                open={showDetails}
                avviso={selectedAvviso}
                onClose={() => {
                    setShowDetails(false);
                    setSelectedAvviso(null);
                }}
                availableClasses={AVAILABLE_CLASSES}
            />
        </div>
    );
}

export default function TeacherAvvisiPage() {
    return (
        <Suspense fallback={
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <TeacherAvvisiContent />
        </Suspense>
    );
}
