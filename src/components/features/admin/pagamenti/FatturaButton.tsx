'use client';

import { useState } from 'react';
import { FileText, Download, Loader2, X } from 'lucide-react';
import { motion } from 'framer-motion';

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
        return (
            <a href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&userId=${userId}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-kidville-green/10 text-kidville-green text-xs font-bold hover:bg-kidville-green/20">
                <Download size={12} /> Fattura
            </a>
        );
    }

    if (stato === 'in_attesa') {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-kidville-warn-soft text-kidville-warn text-xs font-bold" title="Trasmessa allo SDI tramite Aruba, in attesa di esito">
                <Loader2 size={12} className="animate-spin" /> In attesa SDI
            </span>
        );
    }

    return (
        <>
            <button onClick={() => { setCausale(descrizione ?? ''); setOpen(true); }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-kidville-line text-kidville-muted text-xs font-bold hover:border-kidville-green hover:text-kidville-green">
                <FileText size={12} />
                {stato === 'scartata' ? 'Riprova fattura' : 'Invia fattura'}
            </button>

            {open && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5"
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
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        <div className="flex gap-2 mt-4">
                            <button onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-full border-2 border-kidville-line font-maven font-bold text-sm text-kidville-muted hover:bg-kidville-cream">
                                Annulla
                            </button>
                            <button onClick={emetti} disabled={busy}
                                className="flex-1 py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1">
                                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Emetti
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </>
    );
}
