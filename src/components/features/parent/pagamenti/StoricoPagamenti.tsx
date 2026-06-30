'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Download, Receipt } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { raggruppaPerCategoria } from '@/lib/pagamenti/categorie';
import { PushOptIn } from './PushOptIn';

interface Pagamento {
    id: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    scadenza: string;
    stato: string;
    tipo: string;
    obbligatorio: boolean;
    fattura_stato?: string;
    fattura_pdf_path?: string | null;
    importo_totale_famiglia?: number;
    payment_categories?: { nome?: string; colore?: string; icona?: string } | null;
    alunni?: { nome?: string; cognome?: string; sospeso?: boolean };
}

interface Props { userId: string }

const STATI: Record<string, { label: string; cls: string }> = {
    da_pagare: { label: 'Da pagare', cls: 'bg-kidville-neutral-soft text-kidville-neutral' },
    parziale: { label: 'Parziale', cls: 'bg-kidville-warn-soft text-kidville-warn' },
    pagato: { label: 'Pagato', cls: 'bg-kidville-success-soft text-kidville-success' },
    scaduto: { label: 'Scaduto', cls: 'bg-kidville-error-soft text-kidville-error' },
};

export function StoricoPagamenti({ userId }: Props) {
    const [pagamenti, setPagamenti] = useState<Pagamento[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const idsRef = useRef<string>('');

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/pagamenti?userId=${userId}`, { headers: { 'x-user-id': userId } });
            const j = await res.json();
            if (j.success) {
                setPagamenti(j.data);
                idsRef.current = j.data.map((p: Pagamento) => p.id).join(',');
                setError(null);
            } else {
                setError(j.error || 'Impossibile caricare i pagamenti');
            }
        } catch {
            setError('Errore di rete');
        } finally { setLoading(false); }
    }, [userId]);

    useEffect(() => { load(); }, [load]);

    // Realtime: refetch su qualsiasi cambiamento di pagamenti/incassi
    useEffect(() => {
        const supabase = getSupabase();
        const channel = supabase
            .channel(`pagamenti-parent-${userId}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'pagamenti' }, () => load())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'incassi' }, () => load())
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [userId, load]);

    // Figli sospesi per morosità (DL-021): banner informativo, lettura preservata.
    const sospesi = [...new Set(
        pagamenti.filter((p) => p.alunni?.sospeso).map((p) => `${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim())
    )].filter(Boolean);

    // Vista a categorie (DL-022): Rette / Iscrizione / Mensa / Divisa / Materiale / Altro.
    const gruppi = raggruppaPerCategoria(pagamenti);

    // Totale ancora dovuto (DR banner "Totale da saldare"): somma del residuo sulle voci non saldate.
    const totaleDovuto = pagamenti.reduce(
        (s, p) => (p.stato !== 'pagato' ? s + (Number(p.importo) - Number(p.importo_pagato)) : s),
        0,
    );
    const vociAperte = pagamenti.filter((p) => p.stato !== 'pagato').length;

    return (
        <div className="space-y-5">
            {sospesi.length > 0 && (
                <div className="flex items-start gap-2 rounded-card border border-kidville-error/30 bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                    <p className="font-maven text-sm">
                        <span className="font-bold">Account sospeso per morosità</span> ({sospesi.join(', ')}).
                        Le funzioni di servizio sono temporaneamente limitate: regolarizza i pagamenti o contatta la Segreteria.
                    </p>
                </div>
            )}

            {!loading && !error && totaleDovuto > 0 && (
                <div className="rounded-[22px] p-[18px]" style={{ background: 'linear-gradient(135deg, var(--color-kidville-green), var(--color-kidville-green-dark))' }}>
                    <p className="font-maven text-[12.5px] text-white/75">Totale da saldare</p>
                    <p className="font-barlow font-black text-[40px] leading-none text-kidville-yellow">
                        € {totaleDovuto.toFixed(2)}
                    </p>
                    <p className="font-maven text-xs text-white/70 mt-1">
                        {vociAperte} voc{vociAperte === 1 ? 'e' : 'i'} da saldare
                    </p>
                </div>
            )}

            <div className="flex justify-end"><PushOptIn userId={userId} /></div>

            {loading ? (
                <p className="font-maven text-sm text-kidville-muted text-center py-8">Caricamento…</p>
            ) : error ? (
                <p className="font-maven text-sm text-kidville-error text-center py-8">{error}</p>
            ) : pagamenti.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted text-center py-8">Nessun pagamento.</p>
            ) : (
                gruppi.map((g) => (
                    <Section key={g.categoria} title={g.categoria} icon={<span className="text-base leading-none">{g.icona ?? '📁'}</span>}>
                        {g.daPagare.map((p) => <PagamentoCard key={p.id} p={p} userId={userId} />)}
                        {g.pagati.map((p) => <PagamentoCard key={p.id} p={p} userId={userId} />)}
                    </Section>
                ))
            )}
        </div>
    );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div>
            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-2 flex items-center gap-1">
                {icon} {title}
            </h3>
            <div className="space-y-2">{children}</div>
        </div>
    );
}

function PagamentoCard({ p, userId }: { p: Pagamento; userId: string }) {
    const st = STATI[p.stato] ?? STATI.da_pagare;
    const resto = Number(p.importo) - Number(p.importo_pagato);
    const isSplit = p.tipo === 'split';
    const fatturaPronta = p.fattura_stato === 'emessa';

    return (
        <div className={`bg-white rounded-card border p-3 ${p.stato === 'scaduto' ? 'border-kidville-error/40' : 'border-kidville-line'}`}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="font-maven font-bold text-sm text-kidville-green flex items-center gap-1">
                        {p.payment_categories?.icona} {p.descrizione}
                        {p.obbligatorio && <span className="text-[10px] text-kidville-error">•obbl.</span>}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {p.alunni?.nome} {p.alunni?.cognome} · scad. {p.scadenza}
                        {isSplit && <span className="ml-1 text-kidville-warn">· tua quota</span>}
                    </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${st.cls}`}>{st.label}</span>
            </div>

            <div className="flex items-center justify-between mt-2">
                <div className="font-maven text-sm">
                    <span className="text-kidville-green font-bold">€ {Number(p.importo).toFixed(2)}</span>
                    {p.stato === 'parziale' && <span className="text-kidville-muted text-xs ml-2">(resta € {resto.toFixed(2)})</span>}
                </div>
                {fatturaPronta ? (
                    <a
                        href={`/api/pagamenti/fattura?pagamento_id=${p.id}&userId=${userId}`}
                        className="flex items-center gap-1 px-3 py-1 rounded-full bg-kidville-green/10 text-kidville-green text-xs font-bold hover:bg-kidville-green/20"
                    >
                        <Download size={13} /> Fattura
                    </a>
                ) : p.stato === 'pagato' ? (
                    <a
                        href={`/api/pagamenti/ricevuta?pagamento_id=${p.id}&userId=${userId}`}
                        className="flex items-center gap-1 px-3 py-1 rounded-full border border-kidville-line text-kidville-muted text-xs font-bold hover:border-kidville-green hover:text-kidville-green"
                    >
                        <Receipt size={13} /> Ricevuta
                    </a>
                ) : null}
            </div>
        </div>
    );
}
