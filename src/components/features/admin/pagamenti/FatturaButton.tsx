'use client';

import { useState, useEffect } from 'react';
import { FileText, Download, Loader2, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

interface FatturaRow { id: string; quota_label: string | null; intestatario: string }

// Download fattura(e): link singolo o menù a tendina quando il pagamento è stato
// fatturato in più quote (genitori separati).
function EmessaLinks({ pagamentoId, userId }: { pagamentoId: string; userId: string }) {
    const [fatture, setFatture] = useState<FatturaRow[] | null>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        let active = true;
        fetch(`/api/pagamenti/fattura/list?pagamento_id=${pagamentoId}&userId=${userId}`, { headers: { 'x-user-id': userId } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (active && d?.success) setFatture(d.data); })
            .catch(() => {});
        return () => { active = false; };
    }, [pagamentoId, userId]);

    if (!fatture || fatture.length <= 1) {
        return (
            <a href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&userId=${userId}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-kidville-green-soft text-kidville-green text-xs font-bold transition-colors hover:bg-kidville-green/20">
                <Download size={12} /> Fattura
            </a>
        );
    }
    return (
        <div className="relative inline-block">
            <button onClick={() => setOpen((o) => !o)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-kidville-green-soft text-kidville-green text-xs font-bold transition-colors hover:bg-kidville-green/20">
                <Download size={12} /> Fatture ({fatture.length})
            </button>
            {open && (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-card border border-kidville-line bg-kidville-white p-1" style={{ boxShadow: MODAL_SHADOW }}>
                    {fatture.map((f) => (
                        <a key={f.id} href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&fattura_id=${f.id}&userId=${userId}`}
                            className="block rounded-input px-3 py-1.5 font-maven text-xs text-kidville-green hover:bg-kidville-green-soft">
                            Fattura — {f.quota_label || f.intestatario}
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}

interface Props {
    pagamentoId: string;
    userId: string;
    fatturaStato?: string;
    /** descrizione del pagamento, usata per precompilare la causale */
    descrizione?: string;
    onEmessa?: () => void;
}

// Pulsante "Invia Fattura" (scaffold Aruba). Prima dell'emissione apre un modale
// per modificare la causale; quando emessa mostra il link di download.
export function FatturaButton({ pagamentoId, userId, fatturaStato, descrizione, onEmessa }: Props) {
    const [stato, setStato] = useState(fatturaStato ?? 'non_richiesta');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [causale, setCausale] = useState(descrizione ?? '');

    const emetti = async () => {
        setBusy(true);
        try {
            const res = await fetch('/api/pagamenti/fattura', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ pagamento_id: pagamentoId, causale: causale.trim() || undefined }),
            });
            const j = await res.json();
            if (res.ok) { setStato(j.data?.fattura_stato ?? 'in_attesa'); setOpen(false); onEmessa?.(); }
            else { setStato(j.data?.fattura_stato ?? 'scartata'); alert(j.error); }
        } finally { setBusy(false); }
    };

    if (stato === 'emessa') {
        return <EmessaLinks pagamentoId={pagamentoId} userId={userId} />;
    }

    if (stato === 'in_attesa') {
        return (
            <Badge tone="warn" title="Trasmessa allo SDI tramite Aruba, in attesa di esito">
                <Loader2 size={12} className="animate-spin" /> In attesa SDI
            </Badge>
        );
    }

    return (
        <>
            <button onClick={() => { setCausale(descrizione ?? ''); setOpen(true); }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-pill border-[1.5px] border-kidville-line text-kidville-muted text-xs font-bold transition-colors hover:border-kidville-green hover:text-kidville-green">
                <FileText size={12} />
                {stato === 'scartata' ? 'Riprova fattura' : 'Invia fattura'}
            </button>

            {open && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-kidville-ink/40 p-4" onClick={() => setOpen(false)}>
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        className={MODAL_CARD}
                        style={{ boxShadow: MODAL_SHADOW }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                                <FileText size={18} /> Emetti fattura
                            </h3>
                            <button onClick={() => setOpen(false)} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                        </div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Causale fattura</label>
                        <textarea value={causale} onChange={(e) => setCausale(e.target.value)} rows={3}
                            placeholder="Lascia vuoto per usare il template delle impostazioni"
                            className={INPUT} />
                        <div className="flex gap-2 mt-4">
                            <button onClick={() => setOpen(false)} className={cx(BTN_SECONDARY, 'flex-1')}>
                                Annulla
                            </button>
                            <button onClick={emetti} disabled={busy} className={cx(BTN_PRIMARY, 'flex-1')}>
                                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Emetti
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </>
    );
}
