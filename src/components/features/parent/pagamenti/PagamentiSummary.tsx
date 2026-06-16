'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Euro, ChevronRight, CheckCircle2 } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';

interface Pagamento {
    id: string; descrizione: string; importo: number; importo_pagato: number;
    scadenza: string; stato: string;
}

interface Props { userId: string; href: string }

// Riepilogo pagamenti per la home genitore: totale da pagare e prossima scadenza.
// Si aggiorna in realtime quando vengono registrati incassi/pagamenti.
export function PagamentiSummary({ userId, href }: Props) {
    const [pagamenti, setPagamenti] = useState<Pagamento[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/pagamenti?userId=${userId}`, { headers: { 'x-user-id': userId } });
            const j = await res.json();
            if (j.success) setPagamenti(j.data);
        } finally { setLoading(false); }
    }, [userId]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        const supabase = getSupabase();
        const channel = supabase
            .channel(`pagamenti-home-${userId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'pagamenti' }, () => load())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'incassi' }, () => load())
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [userId, load]);

    if (loading) return null;

    const daPagare = pagamenti.filter((p) => p.stato !== 'pagato');
    const totale = daPagare.reduce((s, p) => s + (Number(p.importo) - Number(p.importo_pagato || 0)), 0);
    const prossima = [...daPagare].sort((a, b) => a.scadenza.localeCompare(b.scadenza))[0];

    return (
        <Link href={href} className="block mx-4 mb-5">
            <div className="rounded-2xl border border-gray-100 bg-white px-4 py-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-kidville-green/10 flex items-center justify-center flex-shrink-0">
                    <Euro size={18} className="text-kidville-green" />
                </div>
                <div className="flex-1 min-w-0">
                    {totale > 0 ? (
                        <>
                            <p className="font-barlow font-black text-base text-kidville-green leading-tight">
                                € {totale.toFixed(2)} da pagare
                            </p>
                            {prossima && (
                                <p className="font-maven text-xs text-gray-400 truncate">
                                    {prossima.descrizione} · scad. {prossima.scadenza}
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="font-maven text-sm text-kidville-green font-bold flex items-center gap-1">
                            <CheckCircle2 size={15} className="text-green-600" /> Tutto in regola
                        </p>
                    )}
                </div>
                <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
            </div>
        </Link>
    );
}
