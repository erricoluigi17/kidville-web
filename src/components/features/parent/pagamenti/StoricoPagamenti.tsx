'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Download, Receipt } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';
import { raggruppaPerCategoria } from '@/lib/pagamenti/categorie';
import { residuoEffettivo } from '@/lib/pagamenti/aging';
import { isoToIt } from '@/lib/format/data';
import { PushOptIn } from './PushOptIn';

interface Pagamento {
    id: string;
    alunno_id?: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    sconto?: number | string | null;
    scadenza: string;
    stato: string;
    tipo: string;
    obbligatorio: boolean;
    fattura_stato?: string;
    fattura_pdf_path?: string | null;
    importo_totale_famiglia?: number;
    residuo?: number | string | null;
    stato_effettivo?: string;
    payment_categories?: { nome?: string; colore?: string; icona?: string } | null;
    alunni?: { nome?: string; cognome?: string; sospeso?: boolean };
}

// Residuo per riga (fonte unica): per gli split importo_pagato è dell'intero
// pagamento (non della quota del genitore), quindi il residuo affidabile è
// l'intera quota; per gli altri è residuoEffettivo (importo − sconto − pagato,
// clampato). Mai negativo.
function residuoRiga(p: Pagamento): number {
    if (p.stato === 'pagato') return 0;
    if (p.tipo === 'split') return Math.max(0, Number(p.importo) - Number(p.sconto || 0));
    return residuoEffettivo(p);
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
            const res = await fetch(`/api/pagamenti?userId=${userId}`, { headers: { 'x-user-id': userId } }).catch(() => null);
            const j = res ? await res.json().catch(() => null) : null;
            if (j?.success) {
                setPagamenti(j.data);
                idsRef.current = j.data.map((p: Pagamento) => p.id).join(',');
                setError(null);
            } else if (j) {
                setError(j.error || 'Impossibile caricare i pagamenti');
            } else {
                setError('Errore di rete');
            }
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

    // Totale ancora dovuto (DR banner "Totale da saldare"): somma del residuo
    // effettivo per voce (fonte unica aging.ts, split-aware, mai negativo).
    const totaleDovuto = pagamenti.reduce((s, p) => s + residuoRiga(p), 0);
    const vociAperte = pagamenti.filter((p) => p.stato !== 'pagato').length;

    // Vista «Totale famiglia»: subtotale del residuo per figlio (raggruppa per
    // alunno_id sui dati già in memoria — zero nuove fetch) + totale complessivo.
    // Compare solo con ≥2 figli distinti.
    const perFiglio = new Map<string, { nome: string; totale: number }>();
    for (const p of pagamenti) {
        const key = p.alunno_id ?? 'sconosciuto';
        const nome = `${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || 'Alunno';
        const cur = perFiglio.get(key) ?? { nome, totale: 0 };
        cur.totale += residuoRiga(p);
        cur.nome = nome;
        perFiglio.set(key, cur);
    }
    const mostraTotaleFamiglia = perFiglio.size >= 2;

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

            {!loading && !error && mostraTotaleFamiglia && (
                <div className="rounded-card border border-kidville-line bg-white p-4">
                    <p className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-2">Totale famiglia</p>
                    <div className="space-y-1.5">
                        {[...perFiglio.entries()].map(([id, f]) => (
                            <div key={id} className="flex items-center justify-between font-maven text-sm">
                                <span className="text-kidville-ink">{f.nome}</span>
                                <span className="font-bold text-kidville-green">€ {f.totale.toFixed(2)}</span>
                            </div>
                        ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-kidville-line pt-2 font-maven text-sm">
                        <span className="font-bold text-kidville-green">Totale complessivo</span>
                        <span className="font-black text-kidville-green">€ {totaleDovuto.toFixed(2)}</span>
                    </div>
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

interface FatturaRow { id: string; numero: number; quota_label: string | null; intestatario: string; pdf_disponibile: boolean }

// Link fattura: uno solo (fast-path invariato) o uno per intestatario quando il
// pagamento è stato fatturato in più quote (genitori separati).
function FatturaLinks({ pagamentoId, userId }: { pagamentoId: string; userId: string }) {
    const [fatture, setFatture] = useState<FatturaRow[] | null>(null);
    useEffect(() => {
        let active = true;
        fetch(`/api/pagamenti/fattura/list?pagamento_id=${pagamentoId}&userId=${userId}`, { headers: { 'x-user-id': userId } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (active && d?.success) setFatture(d.data); })
            .catch(() => {});
        return () => { active = false; };
    }, [pagamentoId, userId]);

    // In caricamento o quota unica → link singolo identico al comportamento storico.
    if (!fatture || fatture.length <= 1) {
        return (
            <a
                href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&userId=${userId}`}
                className="flex items-center gap-1 px-3 py-1 rounded-full bg-kidville-green/10 text-kidville-green text-xs font-bold hover:bg-kidville-green/20"
            >
                <Download size={13} /> Fattura
            </a>
        );
    }
    return (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
            {fatture.map((f) => (
                <a
                    key={f.id}
                    href={`/api/pagamenti/fattura?pagamento_id=${pagamentoId}&fattura_id=${f.id}&userId=${userId}`}
                    className="flex items-center gap-1 px-3 py-1 rounded-full bg-kidville-green/10 text-kidville-green text-xs font-bold hover:bg-kidville-green/20"
                >
                    <Download size={13} /> Fattura — {f.quota_label || f.intestatario}
                </a>
            ))}
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
    const isSplit = p.tipo === 'split';
    // Per gli split importo_pagato è dell'intero pagamento, non della quota:
    // il residuo per-quota non è calcolabile qui, quindi non si mostra "(resta …)".
    // Per i non-split: importo − sconto − pagato, mai negativo (guard sui sovraincassi).
    const resto = residuoEffettivo(p);
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
                        {p.alunni?.nome} {p.alunni?.cognome} · scad. {isoToIt(p.scadenza) || p.scadenza}
                        {isSplit && <span className="ml-1 text-kidville-warn">· tua quota</span>}
                    </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${st.cls}`}>{st.label}</span>
            </div>

            <div className="flex items-center justify-between mt-2">
                <div className="font-maven text-sm">
                    <span className="text-kidville-green font-bold">€ {Number(p.importo).toFixed(2)}</span>
                    {(p.stato === 'parziale' || p.stato === 'scaduto') && !isSplit && Number(p.importo_pagato) > 0 && <span className="text-kidville-muted text-xs ml-2">(resta € {resto.toFixed(2)})</span>}
                </div>
                {fatturaPronta ? (
                    <FatturaLinks pagamentoId={p.id} userId={userId} />
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
