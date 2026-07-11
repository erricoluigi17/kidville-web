// Vocabolario condiviso della contabilità: stati pagamento (pill) e metodi incasso.
export const STATI_PAGAMENTO: Record<string, { label: string; cls: string }> = {
    da_pagare: { label: 'Da pagare', cls: 'bg-kidville-line text-kidville-ink' },
    parziale: { label: 'Parziale', cls: 'bg-kidville-warn-soft text-kidville-warn' },
    pagato: { label: 'Pagato', cls: 'bg-kidville-success-soft text-kidville-success' },
    scaduto: { label: 'Scaduto', cls: 'bg-kidville-error-soft text-kidville-error' },
};

export const METODO_LABEL: Record<string, string> = {
    contanti: 'Contanti',
    bonifico: 'Bonifico',
    pos: 'POS / Carta',
    assegno: 'Assegno',
    altro: 'Altro',
};

export interface PagamentoTotalizzabile {
    tipo?: string | null;
    importo: number | string;
    importo_pagato?: number | string | null;
    stato?: string | null;
    fattura_stato?: string | null;
}

export interface TotaliPagamenti {
    incassato: number;
    daIncassare: number;
    scaduto: number;
    daFatturare: number;
    nDaFatturare: number;
}

/**
 * Totali finanziari della dashboard segreteria. I contenitori 'padre' dei piani
 * rateali sono esclusi da OGNI somma: gli incassi stanno sulle rate figlie e il
 * padre resta importo_pagato=0 per sempre, quindi contarlo raddoppierebbe il
 * piano (era il bug dei KPI: "Da incassare" gonfiato in modo permanente).
 * Coerente con export/route.ts, aging.ts, solleciti-invio.ts, riconciliazione.
 */
export function calcolaTotaliPagamenti(pagamenti: PagamentoTotalizzabile[]): TotaliPagamenti {
    let incassato = 0, daIncassare = 0, scaduto = 0, daFatturare = 0, nDaFatturare = 0;
    for (const p of pagamenti) {
        if (p.tipo === 'padre') continue;
        incassato += Number(p.importo_pagato || 0);
        const resto = Number(p.importo) - Number(p.importo_pagato || 0);
        if (resto > 0) daIncassare += resto;
        if (p.stato === 'scaduto') scaduto += resto;
        if (p.stato === 'pagato' && (!p.fattura_stato || p.fattura_stato === 'non_richiesta')) {
            daFatturare += Number(p.importo);
            nDaFatturare += 1;
        }
    }
    return { incassato, daIncassare, scaduto, daFatturare, nDaFatturare };
}
