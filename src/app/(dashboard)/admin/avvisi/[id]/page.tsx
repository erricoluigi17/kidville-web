'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
import { Avviso } from '@/components/features/avvisi/AvvisoCard';
import { AvvisoDetailsContent } from '@/components/features/avvisi/AvvisoDetailsContent';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Dettaglio avviso a tutta area contenuto (sidebar e header del cockpit
// restano): testo dell'avviso + monitoraggio letture/adesioni condiviso
// col drawer mobile del docente.

interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: { id: string; name: string; school_type: string }[] }

function AdminAvvisoDetailInner() {
    const params = useParams<{ id: string }>();
    const { userId } = useSessionIdentity();

    const [avviso, setAvviso] = useState<Avviso | null>(null);
    const [loading, setLoading] = useState(true);
    const [errore, setErrore] = useState<string | null>(null);
    const [scuole, setScuole] = useState<ScuolaScoped[]>([]);

    const availableClasses = useMemo(
        () => [...new Set(scuole.flatMap(g => g.sezioni.map(s => s.name)))],
        [scuole]
    );

    useEffect(() => {
        if (!userId || !params?.id) return;
        let active = true;
        fetch(`/api/avvisi/${params.id}?userId=${userId}`)
            .then(async r => ({ ok: r.ok, body: await r.json().catch(() => null) }))
            .then(({ ok, body }) => {
                if (!active) return;
                if (ok) setAvviso(body as Avviso);
                else setErrore(body?.error ?? 'Avviso non trovato');
            })
            .catch(() => { if (active) setErrore('Errore di rete'); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [userId, params?.id]);

    useEffect(() => {
        if (!userId) return;
        let active = true;
        fetch(`/api/admin/sections/scoped?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => { if (active && d?.success) setScuole(d.data ?? []); })
            .catch(() => {});
        return () => { active = false; };
    }, [userId]);

    const backHref = `/admin/avvisi${userId ? `?userId=${userId}` : ''}`;

    return (
        <CockpitPage max={1360}>
            <Link
                href={backHref}
                className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline"
            >
                <ArrowLeft size={15} strokeWidth={2} /> Tutti gli avvisi
            </Link>

            {loading ? (
                <div className="flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
                    <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                    <p className="font-maven text-sm text-kidville-muted">Caricamento avviso…</p>
                </div>
            ) : errore || !avviso ? (
                <div className="rounded-card bg-kidville-white p-10 text-center shadow-sm">
                    <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">Avviso non disponibile</h2>
                    <p className="font-maven mt-1 text-sm text-kidville-muted">{errore ?? 'Avviso non trovato.'}</p>
                </div>
            ) : (
                <>
                    {/* Testata + contenuto dell'avviso */}
                    <div className="mb-5 rounded-card bg-kidville-white p-6 shadow-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-pill bg-kidville-info-soft px-2.5 py-1 font-barlow text-[11px] font-bold uppercase tracking-wider text-kidville-info">
                                {avviso.tipo === 'adesione' ? 'Adesione Interattiva' : 'Presa Visione'}
                            </span>
                            <span className="font-maven text-xs text-kidville-muted">
                                {avviso.author ? `${avviso.author.first_name} ${avviso.author.last_name}` : ''} · {new Date(avviso.created_at).toLocaleDateString('it-IT')}
                                {avviso.scadenza ? ` · scadenza ${new Date(avviso.scadenza).toLocaleDateString('it-IT')}` : ''}
                            </span>
                        </div>
                        <h1 className="font-barlow mt-2 text-3xl font-black uppercase leading-none text-kidville-green">{avviso.titolo}</h1>
                        <p className="font-maven mt-1 text-xs text-kidville-muted">
                            Destinatari: {avviso.target_scope === 'globale' ? 'Tutto l\'istituto' : `Classi ${avviso.target_classes?.join(', ') || ''}`}
                        </p>
                        <p className="font-maven mt-4 whitespace-pre-line text-sm leading-relaxed text-kidville-ink">{avviso.contenuto}</p>
                        {avviso.attachment_url && (
                            <a
                                href={avviso.attachment_url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-4 inline-flex items-center gap-1.5 rounded-pill bg-kidville-cream px-3 py-1.5 font-maven text-xs font-semibold text-kidville-green hover:bg-kidville-green-soft"
                            >
                                <Paperclip size={13} strokeWidth={1.8} /> Allegato
                            </a>
                        )}
                    </div>

                    {/* Monitoraggio letture/adesioni (condiviso col drawer docente) */}
                    <div className="rounded-card bg-kidville-white p-6 shadow-sm">
                        <AvvisoDetailsContent avviso={avviso} availableClasses={availableClasses} userId={userId} layout="page" />
                    </div>
                </>
            )}
        </CockpitPage>
    );
}

export default function AdminAvvisoDetailPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
            <AdminAvvisoDetailInner />
        </Suspense>
    );
}
