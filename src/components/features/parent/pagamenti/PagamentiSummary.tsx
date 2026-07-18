'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Euro, ChevronRight, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { isoToIt } from '@/lib/format/data';
import { formatEuro } from '@/lib/format/valuta';
import { riepilogoHome, residuoEffettivo, type AgingPagamentoDerivato } from '@/lib/pagamenti/aging';

interface Pagamento extends AgingPagamentoDerivato {
    id: string; descrizione: string; importo: number; importo_pagato: number;
    scadenza: string; stato: string;
}

interface Props { userId: string; href: string }

// Riepilogo pagamenti per la home genitore: tri-stato con CLAMP PER VOCE.
//  • ROSSO  «€X scaduti»   se c'è anche un solo residuo scaduto;
//  • AMBRA  «€Y da pagare» se c'è del dovuto non ancora scaduto;
//  • VERDE  «in regola»    solo se ogni residuo è zero.
// Un sovraincasso su una voce NON compensa lo scaduto di un'altra (finding #1).
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

    const oggi = new Date().toISOString().slice(0, 10);
    const { stato, scaduto, daPagare } = riepilogoHome(pagamenti, oggi);
    // prossima scadenza fra le voci ancora aperte (residuo effettivo > 0, no padre)
    const residuoRiga = (p: Pagamento) =>
        p.residuo != null && Number.isFinite(Number(p.residuo)) ? Math.max(0, Number(p.residuo)) : residuoEffettivo(p);
    const aperti = pagamenti.filter((p) => p.tipo !== 'padre' && residuoRiga(p) > 0);
    const prossima = [...aperti].sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''))[0];

    // Stato ROSSO: c'è del residuo SCADUTO. Banner danger sui token error.
    if (stato === 'rosso') {
        return (
            <Link href={href} className="block px-4">
                <div className="relative flex items-center gap-3 overflow-hidden rounded-[22px] border border-kidville-error/30 bg-kidville-error-soft px-5 py-4">
                    <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[14px] bg-kidville-error/15 text-kidville-error-strong">
                        <AlertTriangle size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="font-maven text-[11.5px] font-semibold text-kidville-error-strong/80">
                            Pagamenti scaduti
                        </p>
                        <p className="font-barlow text-2xl font-black leading-none text-kidville-error-strong">
                            {formatEuro(scaduto)} scaduti
                        </p>
                        {prossima && (
                            <p className="mt-1 truncate font-maven text-[12px] text-kidville-error-strong/75">
                                {prossima.descrizione} · scad. {isoToIt(prossima.scadenza) || prossima.scadenza}
                            </p>
                        )}
                    </div>
                    <ChevronRight size={20} className="flex-shrink-0 text-kidville-error-strong/50" />
                </div>
            </Link>
        );
    }

    // Stato AMBRA: c'è del dovuto ma nulla è scaduto. Banner verde-gradiente (stile attuale).
    if (stato === 'ambra') {
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
                            Totale da pagare
                        </p>
                        <p className="font-barlow text-2xl font-black leading-none text-kidville-yellow">
                            {formatEuro(daPagare)}
                        </p>
                        {prossima && (
                            <p className="mt-1 truncate font-maven text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
                                {prossima.descrizione} · scad. {isoToIt(prossima.scadenza) || prossima.scadenza}
                            </p>
                        )}
                    </div>
                    <ChevronRight size={20} className="flex-shrink-0" style={{ color: 'rgba(255,255,255,0.6)' }} />
                </div>
            </Link>
        );
    }

    // Stato VERDE: ogni residuo è zero.
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
