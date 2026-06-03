'use client';

import { useState } from 'react';
import { FileText, Download, Loader2 } from 'lucide-react';

interface Props {
    pagamentoId: string;
    userId: string;
    fatturaStato?: string;
    onEmessa?: () => void;
}

// Pulsante "Invia Fattura" (scaffold Aruba). Mostra stato emessa/scartata e,
// quando emessa, il link di download.
export function FatturaButton({ pagamentoId, userId, fatturaStato, onEmessa }: Props) {
    const [stato, setStato] = useState(fatturaStato ?? 'non_richiesta');
    const [busy, setBusy] = useState(false);

    const emetti = async () => {
        setBusy(true);
        try {
            const res = await fetch('/api/pagamenti/fattura', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ pagamento_id: pagamentoId }),
            });
            const j = await res.json();
            if (res.ok) { setStato('emessa'); onEmessa?.(); }
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

    return (
        <button onClick={emetti} disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-gray-200 text-gray-500 text-xs font-bold hover:border-kidville-green hover:text-kidville-green disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
            {stato === 'scartata' ? 'Riprova fattura' : 'Invia fattura'}
        </button>
    );
}
