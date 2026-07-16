'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { Plus } from 'lucide-react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm } from '@/components/features/avvisi/AvvisoForm';
import { AvvisoDetailsDrawer } from '@/components/features/avvisi/AvvisoDetailsDrawer';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function TeacherAvvisiContent() {
    const { userId: teacherId } = useSessionIdentity();

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingAvviso, setEditingAvviso] = useState<Avviso | null>(null);
    const [selectedAvviso, setSelectedAvviso] = useState<Avviso | null>(null);
    const [showDetails, setShowDetails] = useState(false);

    // Classi reali del docente (utenti_sezioni via /api/educator-sections):
    // niente elenco hardcoded; con 0 sezioni le pill del form restano vuote.
    const [availableClasses, setAvailableClasses] = useState<string[]>([]);

    // Un educator può inviare avvisi solo alle proprie classi. Default RESTRITTIVO
    // (true) finché /api/educator-sections non conferma il ruolo: solo
    // admin/coordinator (Direzione) ottengono il form completo (con «🌐 Tutti»).
    const [soloClassiProprie, setSoloClassiProprie] = useState(true);

    useEffect(() => {
        if (!teacherId) return;
        fetch(`/api/educator-sections?userId=${teacherId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                setAvailableClasses(d?.sectionNames ?? []);
                const role = d?.role;
                setSoloClassiProprie(!(role === 'admin' || role === 'coordinator'));
            })
            .catch(() => {});
    }, [teacherId]);

    const loadAvvisi = useCallback(async () => {
        if (!teacherId) return;
        try {
            const res = await fetch(`/api/avvisi?userId=${teacherId}`).catch(() => null);
            if (res?.ok) setAvvisi(await res.json());
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
        if (!teacherId) return;
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
        if (!teacherId) return;
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
            <PageHeaderCard
                eyebrow="Comunicazioni"
                title="Bacheca"
                subtitle="Circolari e avvisi alle famiglie"
                action={
                    <Btn variant="secondary" size="sm" onClick={() => { setEditingAvviso(null); setShowForm(true); }}>
                        <Plus size={16} strokeWidth={1.8} /> Nuovo
                    </Btn>
                }
            />
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
                availableClasses={availableClasses}
                initialAvviso={editingAvviso}
                soloClassiProprie={soloClassiProprie}
            />

            {/* Drawer Dettaglio Monitoraggio */}
            <AvvisoDetailsDrawer
                open={showDetails}
                avviso={selectedAvviso}
                onClose={() => {
                    setShowDetails(false);
                    setSelectedAvviso(null);
                }}
                availableClasses={availableClasses}
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
