import { describe, it, expect } from 'vitest'
import { residuoEffettivo, statoEffettivo, residuoDi } from '@/lib/pagamenti/aging'

// Fonte unica di stato/residuo (slice S1). La regola è: residuo effettivo =
// max(0, importo − sconto − pagato); lo stato "scaduto" deriva SEMPRE dalle date.
const OGGI = '2026-07-18'
const IERI = '2026-07-17'

describe('residuoEffettivo', () => {
  it('(a) clampa a 0 una voce sovrapagata (il negativo non emerge)', () => {
    expect(residuoEffettivo({ importo: 100, importo_pagato: 150, stato: 'pagato' })).toBe(0)
  })
  it('(b) lo sconto riduce il residuo', () => {
    expect(residuoEffettivo({ importo: 100, sconto: 30, importo_pagato: 0, stato: 'da_pagare' })).toBe(70)
  })
  it('sconto + pagato che coprono tutto → residuo 0', () => {
    expect(residuoEffettivo({ importo: 100, sconto: 40, importo_pagato: 60, stato: 'parziale' })).toBe(0)
  })
  it('accetta stringhe numeriche (numeric di Postgres)', () => {
    expect(residuoEffettivo({ importo: '100.00', sconto: '10', importo_pagato: '20', stato: 'parziale' })).toBe(70)
  })
  it('sconto null/assente vale 0', () => {
    expect(residuoEffettivo({ importo: 100, sconto: null, importo_pagato: 25, stato: 'parziale' })).toBe(75)
    expect(residuoEffettivo({ importo: 100, importo_pagato: 25, stato: 'parziale' })).toBe(75)
  })
  it('residuoDi resta un alias di residuoEffettivo (compatibilità)', () => {
    expect(residuoDi).toBe(residuoEffettivo)
  })
})

describe('statoEffettivo', () => {
  it('(c) scadenza ieri e residuo>0 → "scaduto" anche se lo stato DB è "da_pagare"', () => {
    expect(statoEffettivo({ importo: 100, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI }, OGGI)).toBe('scaduto')
  })
  it('residuo azzerato dal pagamento → "pagato" (tranne i contenitori padre)', () => {
    expect(statoEffettivo({ importo: 100, importo_pagato: 100, stato: 'parziale', scadenza: IERI }, OGGI)).toBe('pagato')
  })
  it('un contenitore padre a residuo 0 NON viene forzato a "pagato": torna lo stato DB', () => {
    expect(statoEffettivo({ importo: 0, importo_pagato: 0, stato: 'da_pagare', tipo: 'padre' }, OGGI)).toBe('da_pagare')
  })
  it('residuo>0 e scadenza futura → stato DB invariato', () => {
    expect(statoEffettivo({ importo: 100, importo_pagato: 0, stato: 'da_pagare', scadenza: '2026-08-01' }, OGGI)).toBe('da_pagare')
  })
  it('lo sconto che azzera il residuo porta a "pagato" pur con scadenza passata', () => {
    expect(statoEffettivo({ importo: 100, sconto: 100, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI }, OGGI)).toBe('pagato')
  })
})
