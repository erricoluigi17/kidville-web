import { describe, expect, it } from 'vitest'
import { periodoStorico } from '@/lib/storici/periodi'
import type { Calendario } from '@/lib/anno-scolastico'

// Una sede il cui 2026/27 comincia il 17 agosto (e il 2025/26 finisce il 16).
const calendario: Calendario = [
  {
    annoId: '11111111-1111-4111-8111-111111111111',
    annoSedeId: '22222222-2222-4222-8222-222222222222',
    annoInizio: 2025,
    inizio: '2025-09-01',
    fine: '2026-08-16',
    ultimoGiornoAperto: '2026-07-31',
    preparaSuccessivoDal: '2026-03-01',
    stato: 'chiuso',
    domandeAperte: false,
  },
  {
    annoId: '33333333-3333-4333-8333-333333333333',
    annoSedeId: '44444444-4444-4444-8444-444444444444',
    annoInizio: 2026,
    inizio: '2026-08-17',
    fine: '2027-08-31',
    ultimoGiornoAperto: '2027-07-15',
    preparaSuccessivoDal: '2027-03-01',
    stato: 'corrente',
    domandeAperte: true,
  },
]

describe('periodoStorico', () => {
  it("'anno' senza calendario: dal 1° settembre dell'anno in corso (agosto è ancora l'anno che si chiude)", () => {
    expect(periodoStorico('anno', '2026-08-20')).toEqual({ dal: '2025-09-01', al: '2026-08-20' })
    expect(periodoStorico('anno', '2026-09-01')).toEqual({ dal: '2026-09-01', al: '2026-09-01' })
    expect(periodoStorico('anno', '2027-01-15')).toEqual({ dal: '2026-09-01', al: '2027-01-15' })
  })

  it("'anno' con il calendario della sede: dal giorno in cui comincia il suo anno", () => {
    expect(periodoStorico('anno', '2026-08-17', calendario)).toEqual({ dal: '2026-08-17', al: '2026-08-17' })
    expect(periodoStorico('anno', '2026-08-16', calendario)).toEqual({ dal: '2025-09-01', al: '2026-08-16' })
    expect(periodoStorico('anno', '2026-08-20', null)).toEqual({ dal: '2025-09-01', al: '2026-08-20' })
  })

  it('gli altri tipi non cambiano, calendario o no', () => {
    expect(periodoStorico('giorno', '2026-08-20', calendario)).toEqual({ dal: '2026-08-20', al: '2026-08-20' })
    expect(periodoStorico('mese', '2026-08-20', calendario)).toEqual({ dal: '2026-08-01', al: '2026-08-20' })
    expect(periodoStorico('settimana', '2026-08-20')).toEqual({ dal: '2026-08-17', al: '2026-08-20' })
    expect(periodoStorico('tutto', '2026-08-20')).toEqual({ dal: '1900-01-01', al: '2026-08-20' })
  })
})
