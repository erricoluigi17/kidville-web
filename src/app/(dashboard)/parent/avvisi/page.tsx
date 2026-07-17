'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { logClient } from '@/lib/logging/client';

// m3: ogni avviso porta l'elenco dei FIGLI cui si riferisce (nome + student_id),
// così il feed unificato può mostrare a chi si riferisce ogni comunicazione senza
// duplicare l'avviso. Il campo è aggiunto server-side dal ramo genitore.
interface FiglioRiferito {
    student_id: string;
    nome: string;
}
type AvvisoConFigli = Avviso & { figli?: FiglioRiferito[] };

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentAvvisiContent() {
    const { parentId, studentId, ready } = useParentIdentity();

    const [avvisi, setAvvisi] = useState<AvvisoConFigli[]>([]);
    const [loading, setLoading] = useState(true);

    // Feed UNIFICATO server-derived (G3): niente più parentId/classe/studentId nella
    // query — il server ricava figli, classi e plesso dalla sessione. Si passa solo
    // l'identità (x-user-id) per il modello header-identity ancora attivo in prod.
    // try/finally (NON try/catch): dentro un effect il catch farebbe scattare
    // react-hooks/set-state-in-effect. I fallimenti di rete/!res.ok sono comunque
    // registrati dal fetch strumentato globale (logClient) — l'osservabilità c'è.
    const loadAvvisi = useCallback(async () => {
        if (!ready || !parentId) return;
        try {
            const res = await fetch('/api/avvisi', { headers: { 'x-user-id': parentId } });
            if (res.ok) setAvvisi(await res.json());
        } finally {
            setLoading(false);
        }
    }, [ready, parentId]);

    useEffect(() => {
        loadAvvisi();
    }, [loadAvvisi]);

    // I figli a cui si riferisce l'avviso: sono la CHIAVE per-figlio della risposta
    // (student_id nell'upsert). Fallback al figlio attivo se il feed non li porta.
    const figliDiAvviso = useCallback((avvisoId: string): string[] => {
        const a = avvisi.find((x) => x.id === avvisoId);
        const ids = (a?.figli ?? []).map((f) => f.student_id).filter(Boolean);
        return ids.length > 0 ? ids : (studentId ? [studentId] : []);
    }, [avvisi, studentId]);

    const postRisposta = useCallback(async (avvisoId: string, sid: string, risposta?: 'si' | 'no') => {
        const body = risposta ? { student_id: sid, risposta } : { student_id: sid };
        await fetch(`/api/avvisi/${avvisoId}/risposte`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(parentId ? { 'x-user-id': parentId } : {}) },
            body: JSON.stringify(body),
        });
    }, [parentId]);

    const handleReadReceipt = async (avvisoId: string) => {
        const ids = figliDiAvviso(avvisoId);
        if (ids.length === 0) return;
        try {
            // Presa visione = il genitore ha letto: vale per TUTTI i figli cui si riferisce.
            await Promise.all(ids.map((sid) => postRisposta(avvisoId, sid)));
            await loadAvvisi();
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `parent/avvisi: presa visione fallita (${err instanceof Error ? err.message : 'errore'})`,
            });
        }
    };

    const handleAdesione = async (avvisoId: string, risposta: 'si' | 'no') => {
        const ids = figliDiAvviso(avvisoId);
        if (ids.length === 0) return;
        try {
            await Promise.all(ids.map((sid) => postRisposta(avvisoId, sid, risposta)));
            await loadAvvisi();
        } catch (err) {
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `parent/avvisi: adesione fallita (${err instanceof Error ? err.message : 'errore'})`,
            });
        }
    };

    // "Da gestire" (DR): non letti (presa visione) + adesioni senza risposta.
    const daGestire = avvisi.filter(a =>
        a.tipo === 'adesione' ? !a.my_response?.risposta : !a.my_response?.letto_il
    ).length;

    return (
        <div className="px-4 pt-5 pb-24">
            {/* Header */}
            <PageHeaderCard
                eyebrow="Comunicazioni"
                title="Avvisi"
                subtitle={loading ? 'Comunicazioni dalla scuola' : daGestire > 0 ? `${daGestire} da gestire` : 'Tutto in regola ✓'}
                className="mb-6"
            />

            {/* Loading */}
            {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
                    <p className="font-maven text-sm text-kidville-muted">Caricamento...</p>
                </div>
            )}

            {/* Empty */}
            {!loading && avvisi.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-20 h-20 bg-kidville-cream rounded-full flex items-center justify-center mb-4 text-4xl">📭</div>
                    <h2 className="font-barlow font-bold text-xl text-kidville-green uppercase mb-2">Nessun avviso</h2>
                    <p className="font-maven text-kidville-muted text-sm max-w-xs">
                        Non ci sono comunicazioni dalla scuola al momento
                    </p>
                </div>
            )}

            {/* Avvisi */}
            {!loading && avvisi.length > 0 && (
                <div className="space-y-3">
                    {avvisi.map((avviso, idx) => {
                        // m3: il/i figlio/i cui si riferisce l'avviso (entrambi se globale).
                        const figli = avviso.figli ?? [];
                        return (
                            <div key={avviso.id}>
                                {figli.length > 0 && (
                                    <div className="mb-1 flex flex-wrap items-center gap-1 px-1">
                                        <span className="font-maven text-[10px] font-semibold text-kidville-green">Per</span>
                                        {figli.map((f) => (
                                            <span
                                                key={f.student_id}
                                                className="inline-flex items-center rounded-full bg-kidville-green-soft px-2 py-0.5 font-maven text-[10px] font-semibold text-kidville-green"
                                            >
                                                {f.nome || 'Figlio'}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <AvvisoCard avviso={avviso} index={idx}
                                    onReadReceipt={handleReadReceipt}
                                    onAdesione={handleAdesione} />
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Footer */}
            <div className="mt-8 p-4 bg-white rounded-2xl border border-kidville-line text-center">
                <p className="font-maven text-xs text-kidville-muted">
                    📋 Gli avvisi restano visibili fino alla loro scadenza.<br />
                    Le prese visione vengono registrate automaticamente.
                </p>
            </div>
        </div>
    );
}

export default function ParentAvvisiPage() {
    return (
        <Suspense fallback={
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
            </div>
        }>
            <ParentAvvisiContent />
        </Suspense>
    );
}
