// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { Calendario, RigaCalendario } from '@/lib/anno-scolastico'
import { PRESTAMPATI, prestampatiPerRuolo } from '@/lib/prestampati/registro'
import {
  MODULI_CHE_SI_RINNOVANO,
  confineRifirma,
  moduliDaRifirmare,
  type FirmaArchiviata,
} from '@/lib/prestampati/da-rifirmare'

/**
 * I MODULI DA RIFIRMARE: il calcolo (compito 4.4.9).
 *
 * La misura che regge questo file: l'anno 2026/27 comincia il 01/09/2026 e i prestampati sono entrati in
 * app il 15/08/2026, quindi ogni firma di quei diciassette giorni cade, per il calendario, nel 2025/26. La
 * regola scritta nella bozza («firmate in un anno diverso dall'attivo») avrebbe chiesto di rifirmare già
 * oggi. Le prove qui sotto guardano quel confine da entrambi i lati.
 *
 * Nessun dato reale: anni e date sono inventati sulla forma del calendario di produzione.
 */

const anno = (id: number) => `anno-${id}`

function riga(annoInizio: number, stato: RigaCalendario['stato']): RigaCalendario {
  return {
    annoId: anno(annoInizio),
    annoSedeId: `sede-${annoInizio}`,
    annoInizio,
    inizio: `${annoInizio}-09-01`,
    fine: `${annoInizio + 1}-08-31`,
    ultimoGiornoAperto: `${annoInizio + 1}-07-31`,
    preparaSuccessivoDal: `${annoInizio}-09-01`,
    stato,
    domandeAperte: false,
  }
}

/** Com'è ogni sede oggi: 2025/26 chiuso, 2026/27 corrente, 2027/28 in preparazione. */
const OGGI: Calendario = [riga(2025, 'chiuso'), riga(2026, 'corrente'), riga(2027, 'in_preparazione')]
/** Dopo il passaggio del 2027: il 2027/28 è corrente anche se il suo `inizio` è ancora da venire. */
const DOPO_IL_PASSAGGIO: Calendario = [
  riga(2025, 'chiuso'),
  riga(2026, 'chiuso'),
  riga(2027, 'corrente'),
  riga(2028, 'in_preparazione'),
]

const firma = (document_type: string | null, created_at: string | null): FirmaArchiviata => ({ document_type, created_at })
const slugs = (firme: FirmaArchiviata[], confine: string) => moduliDaRifirmare(firme, confine).map((m) => m.slug)

describe('quali moduli si rinnovano', () => {
  it('fra i diciassette si rifirma solo ciò che la famiglia firma e che resta in vigore', () => {
    expect(MODULI_CHE_SI_RINNOVANO.map((v) => v.slug)).toEqual(['delega_ritiro'])
  })

  it('i moduli sanitari non si rifirmano mai', () => {
    const confine = '2027-07-31'
    const firme = ['scheda_sanitaria', 'autorizzazione_farmaci', 'dieta_speciale'].map((s) =>
      firma(s, '2026-10-10T08:00:00Z'),
    )
    expect(slugs(firme, confine)).toEqual([])
  })

  it('una gita o un permesso dell’anno scorso non si rifirmano: raccontano un fatto finito', () => {
    const firme = [firma('autorizzazione_uscita', '2026-10-10T08:00:00Z'), firma('permesso_orario', '2026-10-10T08:00:00Z')]
    expect(slugs(firme, '2027-07-31')).toEqual([])
  })

  it('ciò che firma la Scuola o che nasce allo sportello non si rifirma, qualunque cosa dichiari', () => {
    const altri = PRESTAMPATI.filter((v) => v.slug !== 'delega_ritiro').map((v) => firma(v.slug, '2026-10-10T08:00:00Z'))
    expect(altri).toHaveLength(16)
    expect(slugs(altri, '2027-07-31')).toEqual([])
  })
})

describe('oggi nessuna famiglia ha moduli da rifirmare', () => {
  // Tutti i giorni in cui un prestampato può essere stato firmato finora: dal primo giorno in app, passando
  // per il confine fra 2025/26 e 2026/27, fino a oggi.
  const GIORNI_DA_INIZIO_APP = ['2026-08-15', '2026-08-20', '2026-08-31', '2026-09-01', '2026-10-15', '2026-11-08']
  const FIRME_DI_TUTTI = prestampatiPerRuolo('genitore').flatMap((v) =>
    GIORNI_DA_INIZIO_APP.map((g) => firma(v.slug, `${g}T10:00:00Z`)),
  )

  it('tutte le frequenze sono del 2026/27: non c’è un anno prima da cui rifirmare', () => {
    expect(confineRifirma(OGGI, new Set([anno(2026)]))).toBeNull()
  })

  it('e anche se un bambino avesse una frequenza del 2025/26, le firme di agosto 2026 valgono per il 2026/27', () => {
    const confine = confineRifirma(OGGI, new Set([anno(2025), anno(2026)]))
    expect(confine).toBe('2026-07-31')
    expect(slugs(FIRME_DI_TUTTI, confine as string)).toEqual([])
  })

  it('la firma più antica possibile di una delega, il 15/08/2026, non è da rifirmare', () => {
    const confine = confineRifirma(OGGI, new Set([anno(2025), anno(2026)])) as string
    expect(slugs([firma('delega_ritiro', '2026-08-15T00:00:00Z')], confine)).toEqual([])
  })
})

describe('dopo il primo passaggio', () => {
  const CHI_CONTINUA = new Set([anno(2026), anno(2027)])
  const confine = confineRifirma(DOPO_IL_PASSAGGIO, CHI_CONTINUA) as string

  it('il confine è l’ultimo giorno aperto dell’anno prima dell’attivo', () => {
    expect(confine).toBe('2027-07-31')
  })

  it('una delega firmata nell’anno scorso è da rifirmare, e la risposta dice quando è stata firmata', () => {
    expect(moduliDaRifirmare([firma('delega_ritiro', '2026-10-10T08:00:00Z')], confine)).toEqual([
      { slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-10-10' },
    ])
  })

  it('chi rifirma dopo il passaggio ma prima dell’inizio dell’anno non risulta più da rifirmare', () => {
    // Si rifirma «dal passaggio», e il passaggio cade fra il 01/08 e il 01/09. Con il solo calendario questa
    // firma resterebbe del 2026/27 e la famiglia risulterebbe da rifirmare anche dopo averlo fatto.
    expect(slugs([firma('delega_ritiro', '2027-08-25T08:00:00Z')], confine)).toEqual([])
  })

  it('una firma di giugno, a scuola ancora aperta, è ancora dell’anno che finisce', () => {
    expect(slugs([firma('delega_ritiro', '2027-06-20T08:00:00Z')], confine)).toEqual(['delega_ritiro'])
  })

  it('il giorno è quello di Roma, non quello del server', () => {
    // Le 23:30 del 31/07 a Roma: ancora l'anno vecchio.
    expect(slugs([firma('delega_ritiro', '2027-07-31T21:30:00Z')], confine)).toEqual(['delega_ritiro'])
    // Le 00:30 del 01/08 a Roma, ancora il 31/07 in UTC: già l'anno nuovo.
    expect(slugs([firma('delega_ritiro', '2027-07-31T22:30:00Z')], confine)).toEqual([])
  })

  it('conta l’ultima firma: una vecchia accanto a una nuova non chiede niente', () => {
    const firme = [firma('delega_ritiro', '2026-10-10T08:00:00Z'), firma('delega_ritiro', '2027-09-05T08:00:00Z')]
    expect(slugs(firme, confine)).toEqual([])
    expect(slugs([...firme].reverse(), confine)).toEqual([])
  })

  it('ultimaFirma è la più recente, comunque arrivino le righe', () => {
    const firme = [firma('delega_ritiro', '2026-10-10T08:00:00Z'), firma('delega_ritiro', '2027-03-03T08:00:00Z')]
    expect(moduliDaRifirmare(firme, confine)[0].ultimaFirma).toBe('2027-03-03')
    expect(moduliDaRifirmare([...firme].reverse(), confine)[0].ultimaFirma).toBe('2027-03-03')
  })

  it('un modulo mai firmato non è da rifirmare: manca, che è un’altra lista', () => {
    expect(slugs([], confine)).toEqual([])
  })

  it('una data illeggibile non è una firma: non chiede niente e non copre niente', () => {
    expect(slugs([firma('delega_ritiro', 'non una data'), firma('delega_ritiro', null)], confine)).toEqual([])
    expect(
      slugs([firma('delega_ritiro', '2026-10-10T08:00:00Z'), firma('delega_ritiro', 'non una data')], confine),
    ).toEqual(['delega_ritiro'])
  })

  it('un tipo che non è nel catalogo si ignora', () => {
    expect(slugs([firma('tipo_di_fantasia', '2026-10-10T08:00:00Z'), firma(null, '2026-10-10T08:00:00Z')], confine)).toEqual([])
  })
})

describe('chi non ha un anno prima da cui rifirmare', () => {
  it('una famiglia nuova, che ha firmato durante l’iscrizione, non deve rifirmare', () => {
    expect(confineRifirma(DOPO_IL_PASSAGGIO, new Set([anno(2027)]))).toBeNull()
  })

  it('una frequenza dell’anno PROSSIMO non è un anno prima', () => {
    expect(confineRifirma(OGGI, new Set([anno(2026), anno(2027)]))).toBeNull()
  })

  it('un anno che il calendario della sede non conosce non conta', () => {
    expect(confineRifirma(DOPO_IL_PASSAGGIO, new Set(['anno-di-un-altra-sede', anno(2027)]))).toBeNull()
  })

  it('senza frequenze, senza calendario o senza un anno attivo non c’è niente da chiedere', () => {
    expect(confineRifirma(DOPO_IL_PASSAGGIO, new Set())).toBeNull()
    expect(confineRifirma(null, new Set([anno(2026)]))).toBeNull()
    expect(confineRifirma([], new Set([anno(2026)]))).toBeNull()
    expect(confineRifirma([riga(2027, 'in_preparazione')], new Set([anno(2026)]))).toBeNull()
  })

  it('chi ha saltato un anno rifirma lo stesso, e il confine resta quello dell’anno subito prima', () => {
    const conAnnoSaltato = confineRifirma(DOPO_IL_PASSAGGIO, new Set([anno(2025), anno(2027)]))
    expect(conAnnoSaltato).toBe('2027-07-31')
  })
})
