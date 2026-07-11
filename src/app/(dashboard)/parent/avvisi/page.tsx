'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { AvvisoCard, Avviso } from '@/components/features/avvisi/AvvisoCard';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

// Identità dalla sessione (URL → localStorage → /api/me), senza fallback demo (M4).
function ParentAvvisiContent() {
    const { parentId, studentId, ready } = useParentIdentity();

    const [avvisi, setAvvisi] = useState<Avviso[]>([]);
    const [loading, setLoading] = useState(true);
    const [studentName, setStudentName] = useState<string | null>(null);
    // Nessun default hardcoded (era 'Girasoli', sezione infanzia): la classe reale
    // arriva da diary/students del figlio; fino ad allora loadAvvisi attende.
    const [classe, setClasse] = useState<string>('');

    // 1. Carica info studente (per ricavare nome e classe)
    useEffect(() => {
        if (!studentId) return;
        fetch(`/api/diary/students?id=${studentId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d?.nome) {
                    setStudentName(`${d.nome} ${d.cognome ?? ''}`.trim());
                }
                if (d?.classe_sezione) {
                    setClasse(d.classe_sezione);
                }
            })
            .catch(err => console.error('Errore caricamento info studente:', err));
    }, [studentId]);

    // 2. Carica gli avvisi per la classe dello studente
    const loadAvvisi = useCallback(async () => {
        if (!ready || !parentId || !studentId || !classe) return;
        try {
            const res = await fetch(`/api/avvisi?classe=${classe}&parentId=${parentId}&studentId=${studentId}`);
            if (res.ok) setAvvisi(await res.json());
        } finally {
            setLoading(false);
        }
    }, [ready, classe, parentId, studentId]);

    useEffect(() => {
        loadAvvisi();
    }, [loadAvvisi]);

    const handleReadReceipt = async (avvisoId: string) => {
        if (!parentId || !studentId) return;
        try {
            await fetch(`/api/avvisi/${avvisoId}/risposte`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: parentId, student_id: studentId }),
            });
            await loadAvvisi();
        } catch (err) {
            console.error('Errore presa visione:', err);
        }
    };

    const handleAdesione = async (avvisoId: string, risposta: 'si' | 'no') => {
        if (!parentId || !studentId) return;
        try {
            await fetch(`/api/avvisi/${avvisoId}/risposte`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: parentId, student_id: studentId, risposta }),
            });
            await loadAvvisi();
        } catch (err) {
            console.error('Errore adesione:', err);
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
                action={studentName ? (
                    <div className="flex items-center gap-2 rounded-pill bg-white/15 py-1 pl-1 pr-3">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kidville-yellow font-barlow text-xs font-extrabold text-kidville-green">
                            {studentName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate font-barlow text-xs font-extrabold uppercase leading-none text-white">
                                {studentName}
                            </span>
                            <span className="block truncate font-maven text-[10px] text-white/70">Classe {classe}</span>
                        </span>
                    </div>
                ) : undefined}
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
                    {avvisi.map((avviso, idx) => (
                        <AvvisoCard key={avviso.id} avviso={avviso} index={idx}
                            onReadReceipt={handleReadReceipt}
                            onAdesione={handleAdesione} />
                    ))}
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
