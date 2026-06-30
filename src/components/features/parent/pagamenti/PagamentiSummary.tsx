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

    // Stile export/DR: banner verde-gradiente con importo in giallo se c'è un dovuto,
    // card chiara "tutto in regola" altrimenti.
    if (totale > 0) {
        return (
            <Link href={href} className="block px-4">
                <div
                    className="relative flex items-center gap-3 overflow-hidden rounded-[22px] px-5 py-4 text-white"
                    style={{ background: 'linear-gradient(135deg, var(--color-kidville-green) 0%, var(--color-kidville-green-dark) 100%)' }}
                >
                    <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px]" style={{ background: 'rgba(255,255,255,0.15)' }}>
                        <Euro size={20} className="text-kidville-yellow" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="font-maven text-[11.5px] font-semibold" style={{ color: 'rgba(255,255,255,0.78)' }}>
                            Totale da saldare
                        </p>
                        <p className="font-barlow text-2xl font-black leading-none text-kidville-yellow">
                            € {totale.toFixed(2)}
                        </p>
                        {prossima && (
                            <p className="mt-1 truncate font-maven text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
                                {prossima.descrizione} · scad. {prossima.scadenza}
                            </p>
                        )}
                    </div>
                    <ChevronRight size={20} className="flex-shrink-0" style={{ color: 'rgba(255,255,255,0.6)' }} />
                </div>
            </Link>
        );
    }

    return (
        <Link href={href} className="block px-4">
            <div className="flex items-center gap-3 rounded-[22px] bg-kidville-green-soft px-5 py-4">
                <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-kidville-white text-kidville-success">
                    <CheckCircle2 size={20} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="font-barlow text-base font-black uppercase leading-none text-kidville-green">Pagamenti in regola</p>
                    <p className="mt-1 font-maven text-[12px] text-kidville-green/70">Nessuna quota in scadenza.</p>
                </div>
                <ChevronRight size={20} className="flex-shrink-0 text-kidville-green/40" />
            </div>
        </Link>
    );
}
