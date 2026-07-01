'use client';

import { useState } from 'react';
import { Ban, RotateCcw, Loader2 } from 'lucide-react';

// Toggle sospensione account moroso (DL-021) — riservato alla Direzione
// (gate server-side: l'API risponde 403 ai non-Direzione).
export function SospensioneToggle({
    alunnoId,
    userId,
    sospeso,
    onChange,
}: {
    alunnoId: string;
    userId: string;
    sospeso: boolean;
    onChange?: () => void;
}) {
    const [busy, setBusy] = useState(false);

    const invia = async (nuovo: boolean, motivo: string) => {
        setBusy(true);
        try {
            const res = await fetch('/api/admin/pagamenti/sospensione', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ alunno_id: alunnoId, sospeso: nuovo, motivo }),
            });
            if (res.status === 403) { alert('Azione riservata alla Direzione.'); return; }
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                alert(j.error || 'Errore durante la sospensione.');
                return;
            }
            onChange?.();
        } finally {
            setBusy(false);
        }
    };

    const toggle = () => {
        if (!sospeso) {
            const motivo = window.prompt('Sospensione per morosità — motivo:');
            if (motivo === null) return;
            void invia(true, motivo);
        } else if (window.confirm('Riattivare l’account dell’alunno?')) {
            void invia(false, '');
        }
    };

    return (
        <button
            onClick={toggle}
            disabled={busy}
            title={sospeso ? 'Riattiva account' : 'Sospendi per morosità'}
            className={`${sospeso ? 'text-kidville-error hover:text-kidville-success' : 'text-kidville-muted hover:text-kidville-error'} disabled:opacity-50`}
        >
            {busy ? <Loader2 size={15} className="animate-spin" /> : sospeso ? <RotateCcw size={15} /> : <Ban size={15} />}
        </button>
    );
}
