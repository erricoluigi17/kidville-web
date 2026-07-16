'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, ClipboardList, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { CockpitPage, HEADER_BTN, PageHeader, StatCard, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit';
import { Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoForm } from '@/components/features/avvisi/AvvisoForm';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Bacheca avvisi nel cockpit: lista full-width; il dettaglio/monitoraggio apre
// a tutta area su /admin/avvisi/[id] (niente più drawer laterale mobile).

interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: { id: string; name: string; school_type: string }[] }

function AdminAvvisiInner() {
    const router = useRouter();
    const { userId } = useSessionIdentity();

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingAvviso, setEditingAvviso] = useState<Avviso | null>(null);
    const [scuole, setScuole] = useState<ScuolaScoped[]>([]);

    // Classi disponibili dai plessi consentiti (niente hardcode).
    const availableClasses = useMemo(
        () => [...new Set(scuole.flatMap(g => g.sezioni.map(s => s.name)))],
        [scuole]
    );

    const loadAvvisi = useCallback(async () => {
        if (!userId) return;
        try {
            const res = await fetch(`/api/avvisi?userId=${userId}`).catch(() => null);
            if (res?.ok) setAvvisi(await res.json());
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => { loadAvvisi(); }, [loadAvvisi]);

    useEffect(() => {
        if (!userId) return;
        let active = true;
        fetch(`/api/admin/sections/scoped?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => { if (active && d?.success) setScuole(d.data ?? []); })
            .catch(() => {});
        return () => { active = false; };
    }, [userId]);

    const handleCreateOrUpdate = async (data: {
        titolo: string; contenuto: string; tipo: string;
        target_scope: string; target_classes: string[]; scadenza: string | null;
        attachment_url: string | null;
    }) => {
        if (!userId) return;
        try {
            if (editingAvviso) {
                const res = await fetch(`/api/avvisi/${editingAvviso.id}?userId=${userId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify(data),
                });
                if (res.ok) {
                    await loadAvvisi();
                    setEditingAvviso(null);
                }
            } else {
                const res = await fetch(`/api/avvisi?userId=${userId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify({ author_id: userId, ...data }),
                });
                if (res.ok) await loadAvvisi();
            }
        } catch (err) {
            console.error('Errore nel salvataggio dell\'avviso:', err);
        }
    };

    const handleDelete = async (avvisoId: string) => {
        if (!userId) return;
        if (!window.confirm('Sei sicuro di voler eliminare definitivamente questo avviso? Questa azione eliminerà anche tutte le risposte associate.')) return;
        try {
            const res = await fetch(`/api/avvisi/${avvisoId}?userId=${userId}`, {
                method: 'DELETE',
                headers: { 'x-user-id': userId },
            });
            if (res.ok) await loadAvvisi();
        } catch (err) {
            console.error('Errore eliminazione avviso:', err);
        }
    };

    const openDetail = (id: string) => {
        router.push(`/admin/avvisi/${id}${userId ? `?userId=${userId}` : ''}`);
    };

    const adesioni = avvisi.filter(a => a.tipo === 'adesione').length;

    return (
        <CockpitPage max={1360}>
            <PageHeader
                eyebrow="Comunicazione"
                icon={Bell}
                title="Avvisi"
                subtitle="Circolari e comunicazioni alle famiglie: pubblicazione, stato lettura e adesioni."
                actions={
                    <button
                        onClick={() => { setEditingAvviso(null); setShowForm(true); }}
                        className={HEADER_BTN}
                    >
                        <Plus size={16} strokeWidth={1.8} /> Nuovo avviso
                    </button>
                }
            />

            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-[560px]">
                <StatCard icon={Bell} label="Avvisi pubblicati" value={loading ? '…' : avvisi.length} />
                <StatCard icon={ClipboardList} label="Con adesione" value={loading ? '…' : adesioni} tone="yellow" />
            </div>

            {loading ? (
                <div className="flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
                    <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                    <p className="font-maven text-sm text-kidville-muted">Caricamento avvisi…</p>
                </div>
            ) : avvisi.length === 0 ? (
                <div className="rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-cream text-3xl">📢</div>
                    <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">Nessun avviso</h2>
                    <p className="font-maven mt-1 text-sm text-kidville-muted">Crea il primo avviso per comunicare con le famiglie.</p>
                </div>
            ) : (
                <div className="rounded-card bg-kidville-white p-4 shadow-sm">
                    <div className={TABLE_WRAP}>
                        <table className={TABLE}>
                            <thead>
                                <tr>
                                    <th className={TH}>Avviso</th>
                                    <th className={TH}>Tipo</th>
                                    <th className={TH}>Destinatari</th>
                                    <th className={TH}>Scadenza</th>
                                    <th className={TH}>Letture</th>
                                    <th className={TH}>Adesioni</th>
                                    <th className={TH}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {avvisi.map(a => (
                                    <tr key={a.id} className={`${TROW} cursor-pointer`} onClick={() => openDetail(a.id)}>
                                        <td className={TD}>
                                            <span className="font-maven block max-w-[360px] truncate text-sm font-semibold text-kidville-ink">{a.titolo}</span>
                                            <span className="font-maven block text-xs text-kidville-muted">
                                                {a.author ? `${a.author.first_name} ${a.author.last_name}` : ''} · {new Date(a.created_at).toLocaleDateString('it-IT')}
                                            </span>
                                        </td>
                                        <td className={TD}>
                                            <span className={`rounded-pill px-2.5 py-1 font-maven text-[11px] font-bold ${a.tipo === 'adesione' ? 'bg-kidville-info-soft text-kidville-info' : 'bg-kidville-green-soft text-kidville-green'}`}>
                                                {a.tipo === 'adesione' ? 'Adesione' : 'Presa visione'}
                                            </span>
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                                            {a.target_scope === 'globale' ? 'Tutto l\'istituto' : (a.target_classes ?? []).join(', ')}
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-muted`}>
                                            {a.scadenza ? new Date(a.scadenza).toLocaleDateString('it-IT') : '—'}
                                        </td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>{a.stats?.letti ?? 0}</td>
                                        <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                                            {a.tipo === 'adesione' ? `${a.stats?.adesioni_si ?? 0} sì · ${a.stats?.adesioni_no ?? 0} no` : '—'}
                                        </td>
                                        <td className={TD}>
                                            <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                                <button
                                                    onClick={() => openDetail(a.id)}
                                                    title="Apri dettaglio"
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                                                >
                                                    <Eye size={14} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    onClick={() => { setEditingAvviso(a); setShowForm(true); }}
                                                    title="Modifica"
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green transition-colors hover:bg-kidville-green-soft"
                                                >
                                                    <Pencil size={14} strokeWidth={1.8} />
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(a.id)}
                                                    title="Elimina"
                                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-error/10 text-kidville-error transition-colors hover:bg-kidville-error/20"
                                                >
                                                    <Trash2 size={14} strokeWidth={1.8} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Form modale (riusato dal flusso docente) */}
            <AvvisoForm
                open={showForm}
                onClose={() => {
                    setShowForm(false);
                    setEditingAvviso(null);
                }}
                onSubmit={handleCreateOrUpdate}
                availableClasses={availableClasses}
                initialAvviso={editingAvviso}
            />
        </CockpitPage>
    );
}

export default function AdminAvvisiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
            <AdminAvvisiInner />
        </Suspense>
    );
}
