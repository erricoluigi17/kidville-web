import { describe, it, expect } from 'vitest'
import { riepilogoHome } from '@/lib/pagamenti/aging'

// Tri-stato home genitore (finding #1): il clamp è PER VOCE, mai compensazioni.
// Una voce sovrapagata NON deve mascherare uno scaduto di un'altra voce.
const OGGI = '2026-07-18'
const IERI = '2026-07-17'

describe('riepilogoHome (tri-stato home genitore)', () => {
  it('(d) CRITERIO CHIAVE: scaduta €70 + sovrapagata €50 → scaduto=70, ROSSO (il negativo non compensa)', () => {
    const rows = [
      { importo: 70, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI },          // scaduta: residuo 70
      { importo: 100, importo_pagato: 150, stato: 'pagato', scadenza: '2026-06-01' },   // sovrapagata di 50 → clamp 0
    ]
    const r = riepilogoHome(rows, OGGI)
    expect(r.scaduto).toBe(70)
    expect(r.daPagare).toBe(0)
    expect(r.stato).toBe('rosso')
  })

  it('(e) VERDE solo quando tutti i residui sono zero', () => {
    const rows = [
      { importo: 100, importo_pagato: 100, stato: 'pagato', scadenza: IERI },
      { importo: 50, importo_pagato: 80, stato: 'pagato', scadenza: '2026-06-01' },
    ]
    const r = riepilogoHome(rows, OGGI)
    expect(r.scaduto).toBe(0)
    expect(r.daPagare).toBe(0)
    expect(r.stato).toBe('verde')
  })

  it('AMBRA quando c\'è del dovuto non ancora scaduto', () => {
    const rows = [{ importo: 120, importo_pagato: 0, stato: 'da_pagare', scadenza: '2026-08-01' }]
    const r = riepilogoHome(rows, OGGI)
    expect(r.stato).toBe('ambra')
    expect(r.daPagare).toBe(120)
    expect(r.scaduto).toBe(0)
  })

  it('scaduto e da-pagare coesistenti → ROSSO (lo scaduto ha la priorità)', () => {
    const rows = [
      { importo: 30, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI },           // scaduto 30
      { importo: 40, importo_pagato: 0, stato: 'da_pagare', scadenza: '2026-08-01' },    // da pagare 40
    ]
    const r = riepilogoHome(rows, OGGI)
    expect(r.scaduto).toBe(30)
    expect(r.daPagare).toBe(40)
    expect(r.stato).toBe('rosso')
  })

  it('esclude i contenitori padre dal calcolo', () => {
    const rows = [{ importo: 300, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI, tipo: 'padre' }]
    expect(riepilogoHome(rows, OGGI).stato).toBe('verde')
  })

  it('lo sconto abbatte il residuo di una voce (abbuono → verde)', () => {
    const rows = [{ importo: 100, sconto: 100, importo_pagato: 0, stato: 'da_pagare', scadenza: IERI }]
    expect(riepilogoHome(rows, OGGI).stato).toBe('verde')
  })

  it('usa i campi derivati del GET (stato_effettivo/residuo) quando presenti', () => {
    const rows = [
      // stato/scadenza "grezzi" direbbero non-scaduto, ma i derivati del server vincono
      { importo: 999, importo_pagato: 0, stato: 'da_pagare', scadenza: '2099-01-01', stato_effettivo: 'scaduto', residuo: 70 },
    ]
    const r = riepilogoHome(rows, OGGI)
    expect(r.scaduto).toBe(70)
    expect(r.stato).toBe('rosso')
  })
})
