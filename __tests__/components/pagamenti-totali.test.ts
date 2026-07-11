import { describe, it, expect } from 'vitest';
import { calcolaTotaliPagamenti } from '@/components/features/admin/pagamenti/stati';

// Regressione del bug ALTA: i KPI contavano due volte i piani rateali perché il
// contenitore 'padre' (importo = totale del piano) veniva sommato insieme alle
// rate figlie. "Da incassare" restava gonfiato anche dopo il saldo del piano.
describe('calcolaTotaliPagamenti', () => {
    it('esclude il contenitore padre dei piani rateali da "Da incassare"', () => {
        const t = calcolaTotaliPagamenti([
            { tipo: 'padre', importo: 300, importo_pagato: 0, stato: 'da_pagare' },
            { tipo: 'rata', importo: 100, importo_pagato: 0, stato: 'da_pagare' },
            { tipo: 'rata', importo: 100, importo_pagato: 0, stato: 'da_pagare' },
            { tipo: 'rata', importo: 100, importo_pagato: 0, stato: 'da_pagare' },
        ]);
        // 300 (somma delle 3 rate), NON 600 (padre + rate)
        expect(t.daIncassare).toBe(300);
        expect(t.incassato).toBe(0);
    });

    it('a piano saldato "Da incassare" torna a 0 (il padre non resta appeso)', () => {
        const t = calcolaTotaliPagamenti([
            { tipo: 'padre', importo: 300, importo_pagato: 0, stato: 'da_pagare' },
            { tipo: 'rata', importo: 100, importo_pagato: 100, stato: 'pagato' },
            { tipo: 'rata', importo: 100, importo_pagato: 100, stato: 'pagato' },
            { tipo: 'rata', importo: 100, importo_pagato: 100, stato: 'pagato' },
        ]);
        expect(t.daIncassare).toBe(0);
        expect(t.incassato).toBe(300);
    });

    it('conteggia residuo e scaduto sui pagamenti semplici', () => {
        const t = calcolaTotaliPagamenti([
            { importo: 150, importo_pagato: 50, stato: 'parziale' },
            { importo: 80, importo_pagato: 0, stato: 'scaduto' },
        ]);
        expect(t.daIncassare).toBe(180); // 100 + 80
        expect(t.scaduto).toBe(80);
        expect(t.incassato).toBe(50);
    });

    it('"Da fatturare" conta i saldati senza fattura ed esclude comunque i padre', () => {
        const t = calcolaTotaliPagamenti([
            { importo: 150, importo_pagato: 150, stato: 'pagato', fattura_stato: 'non_richiesta' },
            { importo: 150, importo_pagato: 150, stato: 'pagato', fattura_stato: 'emessa' },
            { tipo: 'padre', importo: 300, importo_pagato: 0, stato: 'pagato' },
        ]);
        expect(t.daFatturare).toBe(150);
        expect(t.nDaFatturare).toBe(1);
    });

    it('gestisce importi come stringhe (payload API)', () => {
        const t = calcolaTotaliPagamenti([
            { importo: '120.50', importo_pagato: '20.50', stato: 'parziale' },
        ]);
        expect(t.daIncassare).toBeCloseTo(100, 2);
    });
});
