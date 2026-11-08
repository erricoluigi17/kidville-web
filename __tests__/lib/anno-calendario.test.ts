import { afterEach, describe, expect, it } from 'vitest'
import { dataCivile } from '@/i18n/config'
import {
  annoAttivoDelCalendario,
  annoDelGiorno,
  annoDiIstante,
  etichettaAnno,
  fineAnno,
  giornoValido,
  inizioAnno,
  mesiDelAnno,
  ultimoGiornoApertoAnno,
  type Calendario,
  type RigaCalendario,
} from '@/lib/anno-scolastico'

const riga2025: RigaCalendario = {
  annoId: '11111111-1111-4111-8111-111111111111',
  annoSedeId: '22222222-2222-4222-8222-222222222222',
  annoInizio: 2025,
  inizio: '2025-09-01',
  fine: '2026-09-14',
  ultimoGiornoAperto: '2026-07-31',
  preparaSuccessivoDal: '2026-03-01',
  stato: 'chiuso',
  domandeAperte: false,
}
const riga2026: RigaCalendario = {
  annoId: '33333333-3333-4333-8333-333333333333',
  annoSedeId: '44444444-4444-4444-8444-444444444444',
  annoInizio: 2026,
  inizio: '2026-09-15',
  fine: '2027-08-31',
  ultimoGiornoAperto: '2027-07-15',
  preparaSuccessivoDal: '2027-03-01',
  stato: 'corrente',
  domandeAperte: true,
}
const calendario: Calendario = [riga2025, riga2026]

describe('annoDelGiorno', () => {
  it('senza calendario il 31/08 è ancora l\'anno che finisce', () => {
    const r = annoDelGiorno('2026-08-31')
    expect(r.annoInizio).toBe(2025)
    expect(r.fonte).toBe('predefinito')
    expect(r.riga).toBeUndefined()
    expect(annoDelGiorno('2026-09-01').annoInizio).toBe(2026)
    expect(annoDelGiorno('2026-07-31').annoInizio).toBe(2025)
    expect(annoDelGiorno('2027-01-15').annoInizio).toBe(2026)
  })

  it('agosto non è più un ponte', () => {
    const r = annoDelGiorno('2026-08-01')
    expect(r.etichetta).toBe('2025/2026')
    expect(r.etichettaBreve).toBe('2025/26')
  })

  it('una sede che comincia il 15/09', () => {
    const a = annoDelGiorno('2026-09-10', calendario)
    expect(a.annoInizio).toBe(2025)
    expect(a.fonte).toBe('sede')
    expect(a.riga?.annoSedeId).toBe(riga2025.annoSedeId)
    const b = annoDelGiorno('2026-09-15', calendario)
    expect(b.annoInizio).toBe(2026)
    expect(b.fonte).toBe('sede')
  })

  it('un giorno fuori da ogni riga ripiega sul predefinito', () => {
    const r = annoDelGiorno('2024-12-31', calendario)
    expect(r.annoInizio).toBe(2024)
    expect(r.fonte).toBe('predefinito')
    expect(r.riga).toBeUndefined()
    expect(annoDelGiorno('2026-10-01', []).fonte).toBe('predefinito')
    expect(annoDelGiorno('2026-10-01', null).fonte).toBe('predefinito')
  })

  it('un giorno non valido è un errore di programma', () => {
    expect(() => annoDelGiorno('2026-02-30')).toThrow(RangeError)
  })
})

describe('annoDiIstante', () => {
  const originale = process.env.TZ
  afterEach(() => {
    if (originale === undefined) delete process.env.TZ
    else process.env.TZ = originale
  })

  function verifica() {
    expect(annoDiIstante(new Date('2026-07-31T22:30:00Z')).annoInizio).toBe(2025)
    expect(annoDiIstante(new Date('2026-08-31T22:30:00Z')).annoInizio).toBe(2026)
    expect(annoDiIstante(new Date('2026-08-31T21:30:00Z')).annoInizio).toBe(2025)
  }

  it('annoDiIstante conta a Roma', () => {
    verifica()
  })

  it('il fuso del processo non conta', () => {
    process.env.TZ = 'America/Los_Angeles'
    verifica()
  })

  // Portati da `anno-scolastico.test.ts` (la vecchia `annoScolasticoCorrente`, tolta nel compito 4.1.S4b):
  // «il giorno si conta a Roma», col confine spostato dal 1° agosto al 1° settembre. Il caso del 31 luglio
  // 22:30Z (già il 1° agosto a Roma) e quello delle 21:00Z c'erano solo lì; la notte del 1° settembre (ora
  // legale) c'era già sopra, in `verifica()`.
  it("31 luglio 22:30Z è già il 1° agosto a Roma, e agosto appartiene ancora all'anno che si chiude", () => {
    const istante = new Date('2026-07-31T22:30:00.000Z')
    expect(dataCivile(istante)).toBe('2026-08-01')
    expect(annoDiIstante(istante).etichetta).toBe('2025/2026')
    expect(annoDiIstante(new Date('2026-07-31T21:00:00.000Z')).etichetta).toBe('2025/2026')
  })

  it('concorda SEMPRE col giorno civile italiano, qualunque sia il fuso del processo', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = tz
      for (const iso of [
        '2026-07-31T22:00:00.000Z',
        '2026-08-31T21:59:59.000Z',
        '2026-08-31T22:00:00.000Z',
        '2026-12-31T23:30:00.000Z',
        '2027-01-01T00:30:00.000Z',
      ]) {
        const istante = new Date(iso)
        expect(annoDiIstante(istante).annoInizio, `${iso} @ ${tz}`).toBe(annoDelGiorno(dataCivile(istante)).annoInizio)
      }
    }
  })

  it('con il calendario della sede il confine è la mezzanotte di Roma del suo inizio', () => {
    // riga2026 comincia il 15/09: le 22:30Z del 14 (ora legale) sono già il 15 a Roma, le 21:30Z no.
    expect(annoDiIstante(new Date('2026-09-14T22:30:00Z'), calendario).annoInizio).toBe(2026)
    expect(annoDiIstante(new Date('2026-09-14T21:30:00Z'), calendario).annoInizio).toBe(2025)
  })
})

describe('etichettaAnno', () => {
  it('etichettaAnno', () => {
    expect(etichettaAnno(2026, 'estesa')).toBe('2026/2027')
    expect(etichettaAnno(2026, 'breve')).toBe('2026/27')
    expect(etichettaAnno(2099, 'breve')).toBe('2099/00')
  })
})

describe('mesiDelAnno', () => {
  it('mesiDelAnno', () => {
    const m = mesiDelAnno(2026)
    expect(m).toHaveLength(10)
    expect(m[0]).toBe('2026-09-01')
    expect(m[9]).toBe('2027-06-01')
    expect(new Set(m).size).toBe(10)
    const dodici = mesiDelAnno(2026, { da: 9, a: 8 })
    expect(dodici).toHaveLength(12)
    expect(dodici[11]).toBe('2027-08-01')
    const quattro = mesiDelAnno(2026, { da: 9, a: 12 })
    expect(quattro).toHaveLength(4)
    expect(quattro.every((x) => x.startsWith('2026-'))).toBe(true)
    expect(() => mesiDelAnno(2026, { da: 0 })).toThrow(RangeError)
  })
})

describe('inizio, fine e ultimo giorno aperto', () => {
  it('inizio, fine e ultimo giorno aperto', () => {
    expect(inizioAnno(2026)).toBe('2026-09-01')
    expect(fineAnno(2026)).toBe('2027-08-31')
    expect(ultimoGiornoApertoAnno(2026)).toBe('2027-07-31')
    expect(inizioAnno(2026, calendario)).toBe('2026-09-15')
    expect(fineAnno(2026, calendario)).toBe('2027-08-31')
    expect(ultimoGiornoApertoAnno(2026, calendario)).toBe('2027-07-15')
    expect(inizioAnno(2030, calendario)).toBe('2030-09-01')
    expect(fineAnno(2030, calendario)).toBe('2031-08-31')
    expect(ultimoGiornoApertoAnno(2030, calendario)).toBe('2031-07-31')
  })
})

describe('giornoValido', () => {
  it('giornoValido', () => {
    expect(giornoValido('2026-02-28')).toBe(true)
    expect(giornoValido('2028-02-29')).toBe(true)
    for (const g of ['2026-02-29', '2026-02-30', '2026-13-01', '', '2026-9-1', '2026-09-01T00:00:00Z']) {
      expect(giornoValido(g)).toBe(false)
    }
  })
})

describe('annoAttivoDelCalendario', () => {
  const r = (annoInizio: number, stato: RigaCalendario['stato']): RigaCalendario => ({
    ...riga2025,
    annoInizio,
    inizio: `${annoInizio}-09-01`,
    fine: `${annoInizio + 1}-08-31`,
    stato,
  })

  it('chiuso, corrente, in_preparazione: vince il corrente', () => {
    const cal = [r(2025, 'chiuso'), r(2026, 'corrente'), r(2027, 'in_preparazione')]
    expect(annoAttivoDelCalendario(cal)?.annoInizio).toBe(2026)
  })

  it('chiuso, in_chiusura, iscrizioni_aperte: vince in_chiusura', () => {
    const cal = [r(2025, 'chiuso'), r(2026, 'in_chiusura'), r(2027, 'iscrizioni_aperte')]
    expect(annoAttivoDelCalendario(cal)?.annoInizio).toBe(2026)
  })

  it('fra più righe attive vince l’inizio più recente, qualunque sia l’ordine', () => {
    expect(annoAttivoDelCalendario([r(2026, 'corrente'), r(2025, 'chiuso')])?.annoInizio).toBe(2026)
  })

  it('solo in_preparazione: null', () => {
    expect(annoAttivoDelCalendario([r(2027, 'in_preparazione')])).toBeNull()
  })

  it('calendario assente o vuoto: null', () => {
    expect(annoAttivoDelCalendario(null)).toBeNull()
    expect(annoAttivoDelCalendario(undefined)).toBeNull()
    expect(annoAttivoDelCalendario([])).toBeNull()
  })
})
