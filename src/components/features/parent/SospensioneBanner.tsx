'use client';

import { useEffect, useState, useCallback } from 'react';
import { Ban } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { formatEuro } from '@/lib/format/valuta';

interface Props {
    userId: string;
    /** Margini/padding esterni gestiti dal chiamante (home vs pagina pagamenti). */
    className?: string;
}

interface StatoSospensione {
    sospeso: boolean;
    totaleScaduto: number;
}

// Banner esplicito per il genitore la cui FAMIGLIA è sospesa per morosità.
// Non mostra dati di altri: la GET `sospensione-stato` è ancorata all'identità del
// gate. Se non sospeso non renderizza nulla. Si aggiorna in realtime quando un
// pagamento/incasso cambia (la revoca automatica lo fa sparire da solo).
export function SospensioneBanner({ userId, className }: Props) {
    const [stato, setStato] = useState<StatoSospensione | null>(null);
    const [loading, setLoading] = useState(true);

    // Pattern PagamentiSummary (react-hooks 7.x): try/finally, mai try/catch, per
    // la fetch lanciata da useEffect. Best-effort: se fallisce, il banner resta
    // nascosto (stato null) senza rompere la pagina.
    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/pagamenti/sospensione-stato', { headers: { 'x-user-id': userId } });
            const j = await res.json();
            if (j?.success) setStato(j.data as StatoSospensione);
        } finally {
            setLoading(false);
        }
    }, [userId]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        const supabase = getSupabase();
        const channel = supabase
            .channel(`sospensione-banner-${userId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'pagamenti' }, () => load())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'incassi' }, () => load())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'alunni' }, () => load())
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [userId, load]);

    if (loading || !stato?.sospeso) return null;

    return (
        <div className={className}>
            <div className="flex items-start gap-3 rounded-[22px] border border-kidville-error/30 bg-kidville-error-soft px-5 py-4">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-kidville-error/15 text-kidville-error-strong">
                    <Ban size={20} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="font-barlow text-base font-black uppercase leading-none text-kidville-error-strong">
                        Servizi sospesi
                    </p>
                    <p className="mt-1 font-maven text-[12.5px] leading-snug text-kidville-error-strong/85">
                        La tua posizione risulta sospesa per morosità
                        {stato.totaleScaduto > 0 ? ` (${formatEuro(stato.totaleScaduto)} scaduti)` : ''}.
                        Alcuni servizi (moduli, adesioni, ordini) sono temporaneamente bloccati.
                        Salda gli importi scaduti o contatta la <strong>Segreteria</strong> per regolarizzare:
                        la riattivazione è automatica una volta saldato tutto lo scaduto.
                    </p>
                </div>
            </div>
        </div>
    );
}
