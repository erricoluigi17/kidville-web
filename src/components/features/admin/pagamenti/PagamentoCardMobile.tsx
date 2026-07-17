'use client';

import { ChevronRight } from 'lucide-react';
import { FatturaChip } from './FatturaChip';
import { STATI_PAGAMENTO } from './stati';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import type { PagamentoRow } from './RegistraIncassoModal';

interface Props {
    pagamento: PagamentoRow & { scadenza?: string | null };
    alunnoLabel: string;
    sezioneLabel?: string | null;
    sospeso?: boolean;
    onIncassa: () => void;
    onApri: () => void;
}

/** Card compatta per la lista pagamenti su mobile (sotto lg la tabella diventa card-list). */
export function PagamentoCardMobile({ pagamento, alunnoLabel, sezioneLabel, sospeso, onIncassa, onApri }: Props) {
    const st = STATI_PAGAMENTO[pagamento.stato] ?? STATI_PAGAMENTO.da_pagare;
    const residuo = Math.max(0, Number(pagamento.importo) - Number(pagamento.importo_pagato || 0));
    const saldato = pagamento.stato === 'pagato';

    return (
        <div className={cx('kv-admin-rowcard rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3', pagamento.stato === 'scaduto' && 'bg-kidville-error-soft/40')}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="truncate font-maven text-sm font-bold text-kidville-green">
                        {alunnoLabel}
                        {sospeso && (
                            <Badge tone="error" className="ml-1 align-middle">sospeso</Badge>
                        )}
                    </p>
                    {sezioneLabel && <p className="font-maven text-xs text-kidville-muted">{sezioneLabel}</p>}
                </div>
                <Badge tone={st.tone} className="shrink-0">{st.label}</Badge>
            </div>

            <p className="mt-1 truncate font-maven text-xs text-kidville-ink">{pagamento.descrizione}</p>

            <div className="mt-2 flex items-center justify-between font-maven text-xs">
                <span className="text-kidville-muted">
                    Totale € {Number(pagamento.importo).toFixed(2)} · Pagato € {Number(pagamento.importo_pagato || 0).toFixed(2)}
                </span>
                {!saldato && <span className="font-bold text-kidville-green">Restano € {residuo.toFixed(2)}</span>}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
                <FatturaChip stato={pagamento.stato} fatturaStato={pagamento.fattura_stato} />
                <div className="ml-auto flex items-center gap-2">
                    {!saldato && (
                        <button type="button" onClick={onIncassa}
                            className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark">
                            Incassa
                        </button>
                    )}
                    <button type="button" onClick={onApri}
                        className="inline-flex min-h-[44px] items-center justify-center gap-0.5 rounded-pill border-[1.5px] border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        Dettagli <ChevronRight size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
}
