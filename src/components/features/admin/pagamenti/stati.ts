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
