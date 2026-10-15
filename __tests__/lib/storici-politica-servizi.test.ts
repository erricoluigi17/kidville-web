import { describe, expect, it } from 'vitest'
import { giornoServizio, politicaNotificaServizio } from '@/lib/storici/notifiche-servizi'
import { oggiRoma } from '@/lib/storici/retroattivita'

const attore = { id: '10000000-0000-4000-8000-000000000001', role: 'segreteria' as const }
const oggi = oggiRoma()
const ieri = new Date(Date.parse(`${oggi}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

describe('politica servizi dal giorno dell’evento', () => {
  it('converte i timestamp nel giorno italiano senza spostare le DATE', () => {
    expect(giornoServizio('2026-06-30T22:15:00Z')).toBe('2026-07-01')
    expect(giornoServizio('2026-06-30')).toBe('2026-06-30')
  })

  it('staff: ieri silenzioso, oggi notificabile', () => {
    expect(politicaNotificaServizio(attore, ieri).sopprimiGenitori).toBe(true)
    expect(politicaNotificaServizio(attore, oggi).sopprimiGenitori).toBe(false)
  })

  it('spostare la data di una vecchia consegna a oggi resta una rettifica storica', () => {
    expect(politicaNotificaServizio(attore, ieri, oggi)).toMatchObject({ giornoCompetenza: ieri, sopprimiGenitori: true })
  })

  it('una consegna nuova oggi usa il suo evento e resta notificabile', () => {
    expect(politicaNotificaServizio(attore, oggi)).toMatchObject({ giornoCompetenza: oggi, sopprimiGenitori: false })
  })

  it('l’identità docente o genitore non riceve il privilegio amministrativo', () => {
    for (const role of ['educator', 'genitore'] as const) {
      expect(politicaNotificaServizio({ ...attore, role }, ieri).sopprimiGenitori).toBe(false)
    }
  })
})
