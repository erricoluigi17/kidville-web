// Vocabolario condiviso della contabilità: stati pagamento (chip) e metodi incasso.
// Il chip di stato si rende con il `<Badge tone={…}>` dell'app: il `tone` mappa
// lo stato sui toni semantici del Badge (linguaggio unico con genitore/docente).
import type { BadgeTone } from '@/components/ui/Badge';

export const STATI_PAGAMENTO: Record<string, { label: string; tone: BadgeTone }> = {
    da_pagare: { label: 'Da pagare', tone: 'neutral' },
    parziale: { label: 'Parziale', tone: 'warn' },
    pagato: { label: 'Pagato', tone: 'success' },
    scaduto: { label: 'Scaduto', tone: 'error' },
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
