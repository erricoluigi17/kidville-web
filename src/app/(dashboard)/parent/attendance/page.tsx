'use client';

import { Suspense, useState } from 'react';
import { CheckCircle, CalendarX2, AlertTriangle } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';

function AttendanceInner() {
    const { parentId, studentId, ready } = useParentIdentity();
    const today = new Date().toISOString().slice(0, 10);

    const [data, setData] = useState(today);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Collega il submit al backend esistente: POST /api/parent/presenze/comunica-assenza
    // (decisione 2 — niente nuove API). L'endpoint crea l'assenza già giustificata.
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!parentId || !studentId || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`/api/parent/presenze/comunica-assenza?userId=${parentId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
                body: JSON.stringify({ studentId, data, motivo: reason }),
            });
            const j = await res.json().catch(() => ({}));
            if (res.ok) {
                setIsSubmitted(true);
            } else {
                setError(j.error || 'Impossibile comunicare l’assenza in questo momento.');
            }
        } catch {
            setError('Errore di rete. Riprova.');
        } finally {
            setSubmitting(false);
        }
    };

    if (isSubmitted) {
        return (
            <div className="px-4 pt-5 pb-24">
                <div className="rounded-card bg-kidville-white p-6 text-center shadow-sm">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-success-soft text-kidville-success">
                        <CheckCircle size={32} />
                    </div>
                    <h2 className="mb-2 font-barlow text-2xl font-black uppercase text-kidville-green">Assenza comunicata</h2>
                    <p className="mb-6 font-maven text-kidville-muted">
                        La scuola è stata notificata dell&apos;assenza del {new Date(data + 'T12:00:00').toLocaleDateString('it-IT')}. Grazie per la collaborazione.
                    </p>
                    <Btn
                        variant="ghost"
                        size="sm"
                        onClick={() => { setIsSubmitted(false); setReason(''); setData(today); }}
                    >
                        Comunica un&apos;altra assenza
                    </Btn>
                </div>
            </div>
        );
    }

    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow="La giornata"
                title="Segnala assenza"
                subtitle="Comunica un'assenza alla scuola"
            />

            <form onSubmit={handleSubmit} className="mt-5 rounded-card bg-kidville-white p-6 shadow-sm">
                {/* Icona DR */}
                <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-kidville-error-soft text-kidville-error">
                        <CalendarX2 size={22} />
                    </span>
                    <p className="font-maven text-sm text-kidville-muted">Indica il giorno dell&apos;assenza e, se vuoi, il motivo.</p>
                </div>

                <label className="mb-2 block font-maven font-medium text-kidville-green">Giorno</label>
                <input
                    type="date"
                    value={data}
                    min={today}
                    onChange={(e) => setData(e.target.value)}
                    className="mb-4 w-full rounded-xl border border-kidville-line p-3 font-maven focus:border-kidville-green focus:outline-none focus:ring-1 focus:ring-kidville-green"
                />

                <label className="mb-2 block font-maven font-medium text-kidville-green">Motivo (facoltativo)</label>
                <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="h-28 w-full resize-none rounded-xl border border-kidville-line p-3 font-maven focus:border-kidville-green focus:outline-none focus:ring-1 focus:ring-kidville-green"
                    placeholder="Es. febbre, visita medica, motivi familiari…"
                />

                {error && (
                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error">
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> {error}
                    </div>
                )}

                <Btn
                    type="submit"
                    variant="primary"
                    size="lg"
                    disabled={!ready || submitting}
                    className="mt-4 w-full"
                >
                    {submitting ? 'Invio…' : 'Comunica assenza'}
                </Btn>
            </form>
        </div>
    );
}

export default function ParentAttendancePage() {
    return (
        <Suspense fallback={<div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">Caricamento…</div>}>
            <AttendanceInner />
        </Suspense>
    );
}
