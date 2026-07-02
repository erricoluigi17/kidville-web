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
            const res = await fetch(`/api/avvisi?userId=${teacherId}`);
            if (res.ok) setAvvisi(await res.json());
        } catch (err) {
            console.error('Errore caricamento avvisi:', err);
        } finally {
            setLoading(false);
        }
    }, [teacherId]);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    const handleCreateOrUpdate = async (data: {
        titolo: string; contenuto: string; tipo: string;
        target_scope: string; target_classes: string[]; scadenza: string | null;
        attachment_url: string | null;
    }) => {
        try {
            if (editingAvviso) {
                // UPDATE (PUT)
                const res = await fetch(`/api/avvisi/${editingAvviso.id}?userId=${teacherId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
                    body: JSON.stringify(data),
                });
                if (res.ok) {
                    await loadAvvisi();
                    setEditingAvviso(null);
                }
            } else {
                // CREATE (POST)
                const res = await fetch(`/api/avvisi?userId=${teacherId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': teacherId },
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
            const res = await fetch(`/api/avvisi/${avvisoId}?userId=${teacherId}`, {
                method: 'DELETE',
                headers: { 'x-user-id': teacherId },
            });
            if (res.ok) await loadAvvisi();
        } catch (err) {
            console.error('Errore eliminazione avviso:', err);
        }
    };

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Header verde (DR) */}
            <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">Comunicazioni</p>
                        <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">Bacheca</h1>
                        <p className="mt-1.5 font-maven text-xs text-white/80">Circolari e avvisi alle famiglie</p>
                    </div>
                    <button onClick={() => { setEditingAvviso(null); setShowForm(true); }}
                        className="flex shrink-0 items-center gap-2 rounded-pill bg-kidville-yellow px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-green transition-all active:scale-[0.98]">
                        <Plus size={16} strokeWidth={1.8} /> Nuovo
                    </button>
                </div>
            </div>
            <div className="mt-5">{/* contenuto */}</div>

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-muted">Caricamento avvisi...</p>
                </div>
            )}

            {/* Empty state */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📢</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">Nessun avviso</h2>
                    <p className="font-maven text-kidville-muted text-sm max-w-xs">
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
