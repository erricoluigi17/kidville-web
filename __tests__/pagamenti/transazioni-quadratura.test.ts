import { describe, it, expect } from 'vitest'
import { proponiAllocazione, round2 } from '@/lib/pagamenti/transazioni-quadratura'

// Proposta automatica (Contabilità v2 S4): alloca la capienza sulle voci in ordine
// dato (il server le manda già più vecchie prima), senza mai sforare la capienza.

describe('proponiAllocazione', () => {
    const voci = [
        { id: 'vecchia', residuo: 100 },
        { id: 'media', residuo: 50 },
        { id: 'nuova', residuo: 80 },
    ]

    it('capienza copre tutto → ogni voce riceve il proprio residuo', () => {
        expect(proponiAllocazione(voci, 230)).toEqual({ vecchia: '100', media: '50', nuova: '80' })
    })

    it('capienza parziale → riempie le più vecchie prima, l\'ultima parziale, le successive saltate', () => {
        // 120: 100 alla vecchia, 20 alla media, nulla alla nuova
        expect(proponiAllocazione(voci, 120)).toEqual({ vecchia: '100', media: '20' })
    })

    it('capienza oltre il totale dei residui → tutte piene, nessuno sforo', () => {
        expect(proponiAllocazione(voci, 999)).toEqual({ vecchia: '100', media: '50', nuova: '80' })
    })

    it('capienza nulla o negativa → nessuna allocazione', () => {
        expect(proponiAllocazione(voci, 0)).toEqual({})
        expect(proponiAllocazione(voci, -5)).toEqual({})
    })

    it('centesimi: non sfora e arrotonda a 2 decimali', () => {
        const r = proponiAllocazione([{ id: 'a', residuo: 33.33 }, { id: 'b', residuo: 33.33 }], 50)
        expect(r.a).toBe('33.33')
        expect(r.b).toBe('16.67')
        expect(round2(Number(r.a) + Number(r.b))).toBe(50)
    })
})
