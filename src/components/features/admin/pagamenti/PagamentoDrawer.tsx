'use client';

import { useEffect, useState } from 'react';
import { Pencil, Layers, Download, Euro } from 'lucide-react';
import { Drawer } from '@/components/ui/cockpit';
import { FatturaChip } from './FatturaChip';
import { FatturaButton } from './FatturaButton';
import { STATI_PAGAMENTO, METODO_LABEL } from './stati';
import type { PagamentoRow } from './RegistraIncassoModal';

interface Incasso {
    id: string;
    importo: number;
    data_incasso: string;
    metodo: string;
    note?: string | null;
    creato_il?: string;
}
interface Rata { id: string; descrizione: string; importo: number; importo_pagato: number; scadenza: string; stato: string }
interface Dettaglio {
    incassi: Incasso[];
    rate: Rata[];
    quote: { id: string; importo: number; etichetta?: string | null; utenti?: { nome?: string; cognome?: string } | null }[];
    payment_categories?: { nome?: string } | null;
    scadenza?: string | null;
    alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | null;
}

interface Props {
    pagamento: PagamentoRow & { scadenza?: string | null };
    userId: string;
    onClose: () => void;
    onIncassa: () => void;
    onModifica: () => void;
    onRateizza: () => void;
    /** Slot per azioni extra (es. SospensioneToggle) rese dal chiamante. */
    extra?: React.ReactNode;
}

const fmtData = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');

/**
 * Drawer di dettaglio pagamento: riepilogo, timeline incassi/storni e tutte le
 * azioni in un punto solo. L'emissione fattura resta manuale (FatturaButton).
 */
export function PagamentoDrawer({ pagamento, userId, onClose, onIncassa, onModifica, onRateizza, extra }: Props) {
    const [dettaglio, setDettaglio] = useState<Dettaglio | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const r = await fetch(`/api/pagamenti/${pagamento.id}?userId=${userId}`, { headers: { 'x-user-id': userId } });
                const j = await r.json();
                if (active && j?.success) setDettaglio(j.data as Dettaglio);
            } catch {
                // dettaglio non disponibile: il drawer resta usabile col solo riepilogo
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => { active = false; };
    }, [pagamento.id, userId]);

    const st = STATI_PAGAMENTO[pagamento.stato] ?? STATI_PAGAMENTO.da_pagare;
    const saldato = pagamento.stato === 'pagato';
    const residuo = Math.max(0, Number(pagamento.importo) - Number(pagamento.importo_pagato || 0));
    const alunno = dettaglio?.alunni ?? pagamento.alunni;
    const sub = [
        [alunno?.nome, alunno?.cognome].filter(Boolean).join(' '),
        (alunno as { classe_sezione?: string | null } | undefined)?.classe_sezione,
    ].filter(Boolean).join(' · ');

    return (
        <Drawer open onClose={onClose} title={pagamento.descrizione} subtitle={sub || undefined}
            footer={
                <div className="flex flex-wrap items-center gap-2">
                    {!saldato && (
                        <button type="button" onClick={onIncassa}
                            className="inline-flex items-center gap-1.5 rounded-full bg-kidville-green px-4 py-2 font-maven text-sm font-bold text-white hover:opacity-90">
                            <Euro size={15} /> Incassa
                        </button>
                    )}
                    {saldato ? (
                        <>
                            <FatturaButton pagamentoId={pagamento.id} userId={userId} fatturaStato={pagamento.fattura_stato} descrizione={pagamento.descrizione} />
                            <a href={`/api/pagamenti/ricevuta?pagamento_id=${pagamento.id}&userId=${userId}`}
                                className="inline-flex items-center gap-1 rounded-full bg-kidville-green/10 px-3 py-1.5 font-maven text-xs font-bold text-kidville-green hover:bg-kidville-green/20">
                                <Download size={13} /> Ricevuta
                            </a>
                        </>
                    ) : (
                        <button type="button" disabled title="Disponibile a saldo avvenuto"
                            className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border-2 border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted opacity-60">
                            <Download size={13} /> Ricevuta
                        </button>
                    )}
                    <button type="button" onClick={onModifica}
                        className="inline-flex items-center gap-1 rounded-full border-2 border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted hover:border-kidville-green hover:text-kidville-green">
                        <Pencil size={13} /> Modifica
                    </button>
                    {pagamento.tipo === 'singolo' && !saldato && (
                        <button type="button" onClick={onRateizza}
                            className="inline-flex items-center gap-1 rounded-full border-2 border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted hover:border-kidville-green hover:text-kidville-green">
                            <Layers size={13} /> Rateizza
                        </button>
                    )}
                    {extra}
                </div>
            }>
            {/* Riepilogo importi + stato */}
            <div className="mb-4 rounded-xl bg-kidville-cream/60 p-3">
                <div className="flex items-center justify-between gap-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${st.cls}`}>{st.label}</span>
                    <FatturaChip stato={pagamento.stato} fatturaStato={pagamento.fattura_stato} />
                </div>
                <div className="mt-2 flex justify-between font-maven text-xs">
                    <span className="text-kidville-muted">Totale € {Number(pagamento.importo).toFixed(2)}</span>
                    <span className="text-kidville-muted">Incassato € {Number(pagamento.importo_pagato || 0).toFixed(2)}</span>
                    <span className="font-bold text-kidville-green">Restano € {residuo.toFixed(2)}</span>
                </div>
                <div className="mt-2 flex justify-between font-maven text-[11px] text-kidville-muted">
                    <span>Scadenza: {fmtData(pagamento.scadenza ?? dettaglio?.scadenza)}</span>
                    {dettaglio?.payment_categories?.nome && <span>{dettaglio.payment_categories.nome}</span>}
                </div>
            </div>

            {/* Quote (genitori separati) */}
            {dettaglio && dettaglio.quote.length > 0 && (
                <div className="mb-4">
                    <h3 className="mb-1.5 font-barlow text-[13px] font-extrabold uppercase text-kidville-neutral">Quote</h3>
                    <div className="space-y-1">
                        {dettaglio.quote.map((q) => (
                            <div key={q.id} className="flex items-center justify-between rounded-lg bg-kidville-cream/40 px-2.5 py-1.5 font-maven text-xs">
                                <span className="text-kidville-ink">{q.etichetta || [q.utenti?.nome, q.utenti?.cognome].filter(Boolean).join(' ') || 'Quota'}</span>
                                <span className="font-bold text-kidville-green">€ {Number(q.importo).toFixed(2)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Timeline movimenti */}
            <h3 className="mb-1.5 font-barlow text-[13px] font-extrabold uppercase text-kidville-neutral">Movimenti</h3>
            {loading ? (
                <p className="py-3 font-maven text-xs text-kidville-muted">Caricamento…</p>
            ) : !dettaglio || dettaglio.incassi.length === 0 ? (
                <p className="py-3 font-maven text-xs text-kidville-muted">Nessun incasso registrato.</p>
            ) : (
                <div className="space-y-1.5">
                    {dettaglio.incassi.map((i) => {
                        const storno = Number(i.importo) < 0;
                        return (
                            <div key={i.id} className={`rounded-lg border px-2.5 py-1.5 ${storno ? 'border-kidville-error-soft bg-kidville-error-soft/40' : 'border-kidville-line bg-kidville-white'}`}>
                                <div className="flex items-center justify-between font-maven text-xs">
                                    <span className={`font-bold ${storno ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                        {storno ? 'Storno' : (METODO_LABEL[i.metodo] ?? i.metodo)}
                                    </span>
                                    <span className={`font-bold ${storno ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                        {storno ? '−' : ''}€ {Math.abs(Number(i.importo)).toFixed(2)}
                                    </span>
                                </div>
                                <div className="mt-0.5 flex items-center justify-between font-maven text-[11px] text-kidville-muted">
                                    <span>{fmtData(i.data_incasso)}</span>
                                    {i.note && <span className="truncate pl-2">{i.note}</span>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Rate del piano (se pagamento padre) */}
            {dettaglio && dettaglio.rate.length > 0 && (
                <div className="mt-4">
                    <h3 className="mb-1.5 font-barlow text-[13px] font-extrabold uppercase text-kidville-neutral">Rate del piano</h3>
                    <div className="space-y-1">
                        {dettaglio.rate.map((r) => {
                            const rst = STATI_PAGAMENTO[r.stato] ?? STATI_PAGAMENTO.da_pagare;
                            return (
                                <div key={r.id} className="flex items-center justify-between rounded-lg bg-kidville-cream/40 px-2.5 py-1.5 font-maven text-xs">
                                    <span className="min-w-0 truncate text-kidville-ink">{r.descrizione} · {fmtData(r.scadenza)}</span>
                                    <span className="flex shrink-0 items-center gap-1.5">
                                        <span className="text-kidville-muted">€ {Number(r.importo).toFixed(2)}</span>
                                        <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold ${rst.cls}`}>{rst.label}</span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </Drawer>
    );
}
