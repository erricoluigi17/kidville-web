'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Clock, CheckCircle2, AlertTriangle, Download, FileText } from 'lucide-react';
import { getSupabase } from '@/lib/supabase/browser-client';
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
    alunni?: { nome?: string; cognome?: string };
}

interface Props { userId: string }

const STATI: Record<string, { label: string; cls: string }> = {
    da_pagare: { label: 'Da pagare', cls: 'bg-gray-100 text-gray-600' },
    parziale: { label: 'Parziale', cls: 'bg-amber-100 text-amber-700' },
    pagato: { label: 'Pagato', cls: 'bg-green-100 text-green-700' },
    scaduto: { label: 'Scaduto', cls: 'bg-red-100 text-red-700' },
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

    const daPagare = pagamenti.filter((p) => p.stato !== 'pagato');
    const pagati = pagamenti.filter((p) => p.stato === 'pagato');

    return (
        <div className="space-y-5">
            <div className="flex justify-end"><PushOptIn userId={userId} /></div>

            {loading ? (
                <p className="font-maven text-sm text-gray-400 text-center py-8">Caricamento…</p>
            ) : error ? (
                <p className="font-maven text-sm text-red-500 text-center py-8">{error}</p>
            ) : pagamenti.length === 0 ? (
                <p className="font-maven text-sm text-gray-400 text-center py-8">Nessun pagamento.</p>
            ) : (
                <>
                    {daPagare.length > 0 && (
                        <Section title="Da pagare" icon={<Clock size={16} className="text-amber-600" />}>
                            {daPagare.map((p) => <PagamentoCard key={p.id} p={p} userId={userId} />)}
                        </Section>
                    )}
                    {pagati.length > 0 && (
                        <Section title="Pagamenti effettuati" icon={<CheckCircle2 size={16} className="text-green-600" />}>
                            {pagati.map((p) => <PagamentoCard key={p.id} p={p} userId={userId} />)}
                        </Section>
                    )}
                </>
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
        <div className={`bg-white rounded-xl border p-3 ${p.stato === 'scaduto' ? 'border-red-200' : 'border-gray-100'}`}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="font-maven font-bold text-sm text-kidville-green flex items-center gap-1">
                        {p.payment_categories?.icona} {p.descrizione}
                        {p.obbligatorio && <span className="text-[10px] text-red-500">•obbl.</span>}
                    </p>
                    <p className="font-maven text-xs text-gray-400">
                        {p.alunni?.nome} {p.alunni?.cognome} · scad. {p.scadenza}
                        {isSplit && <span className="ml-1 text-amber-600">· tua quota</span>}
                    </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${st.cls}`}>{st.label}</span>
            </div>

            <div className="flex items-center justify-between mt-2">
                <div className="font-maven text-sm">
                    <span className="text-kidville-green font-bold">€ {Number(p.importo).toFixed(2)}</span>
                    {p.stato === 'parziale' && <span className="text-gray-400 text-xs ml-2">(resta € {resto.toFixed(2)})</span>}
                </div>
                {fatturaPronta ? (
                    <a
                        href={`/api/pagamenti/fattura?pagamento_id=${p.id}&userId=${userId}`}
                        className="flex items-center gap-1 px-3 py-1 rounded-full bg-kidville-green/10 text-kidville-green text-xs font-bold hover:bg-kidville-green/20"
                    >
                        <Download size={13} /> Fattura
                    </a>
                ) : p.stato === 'pagato' ? (
                    <span className="flex items-center gap-1 text-gray-300 text-xs font-maven"><FileText size={13} /> —</span>
                ) : null}
            </div>
        </div>
    );
}
