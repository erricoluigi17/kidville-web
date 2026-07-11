'use client';

import { useMemo } from 'react';
import { AGING_LABEL, bucketScadenze, type AgingBucketId, type AgingPagamento } from '@/lib/pagamenti/aging';
import { cx } from '@/lib/ui/cx';

const ORDINE: AgingBucketId[] = ['scaduti_oltre_30', 'scaduti_entro_30', 'settimana', 'mese'];
const TONO: Record<AgingBucketId, { testo: string; attivo: string }> = {
    scaduti_oltre_30: { testo: 'text-kidville-error', attivo: 'border-kidville-error bg-kidville-error-soft/50' },
    scaduti_entro_30: { testo: 'text-kidville-error', attivo: 'border-kidville-error bg-kidville-error-soft/50' },
    settimana: { testo: 'text-kidville-warn', attivo: 'border-kidville-warn bg-kidville-warn-soft/50' },
    mese: { testo: 'text-kidville-green', attivo: 'border-kidville-green bg-kidville-green/10' },
};

interface Props {
    pagamenti: AgingPagamento[];
    /** Data di riferimento YYYY-MM-DD (default: oggi). Espressa come prop per i test. */
    oggi?: string;
    attivo: AgingBucketId | null;
    onSelect: (id: AgingBucketId | null) => void;
}

/** Agenda scadenze: 4 bucket di aging cliccabili che filtrano la lista. */
export function AgendaScadenze({ pagamenti, oggi, attivo, onSelect }: Props) {
    const rif = oggi ?? new Date().toISOString().slice(0, 10);
    const buckets = useMemo(() => bucketScadenze(pagamenti, rif), [pagamenti, rif]);

    return (
        <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {ORDINE.map((id) => {
                const b = buckets[id];
                const on = attivo === id;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onSelect(on ? null : id)}
                        className={cx(
                            'rounded-xl border-2 px-3 py-2 text-left transition-colors',
                            on ? TONO[id].attivo : 'border-kidville-line bg-kidville-white hover:border-kidville-green'
                        )}
                    >
                        <span className="block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-neutral">
                            {AGING_LABEL[id]}
                        </span>
                        <span className="mt-0.5 flex items-baseline gap-1.5">
                            <span className={cx('font-barlow text-xl font-black leading-none', TONO[id].testo)}>{b.count}</span>
                            <span className="font-maven text-[11px] text-kidville-muted">€ {b.totale.toFixed(2)}</span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
