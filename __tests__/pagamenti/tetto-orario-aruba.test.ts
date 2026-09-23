import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  contaEmesseUltimaOra,
  posizioniDisponibili,
  quanteSePossonoTentare,
  FINESTRA_MS,
  SOGLIA_ORARIA_APP,
  TETTO_ORARIO_ARUBA,
} from '@/lib/pagamenti/tetto-orario-aruba'

/**
 * IL TETTO ORARIO DI ARUBA, E LE TRE COSE CHE LA GUARDIA NON PUÒ VEDERE.
 *
 * Finché il lotto faceva una POST per fattura, il tetto orario non legava: il `signin`
 * (uno al minuto) impediva di suo di superare le sessanta l'ora. Con un accesso solo per
 * blocco quel freno sparisce, e il volume orario diventa **l'unica cosa** fra un lotto e
 * una tempesta di `429` — che, per giunta, riazzera il TTL del secchio a ogni tentativo.
 */

describe('la soglia sta SOTTO il tetto, e non per prudenza generica', () => {
  it('la soglia dell’app lascia un margine al tetto dichiarato da Aruba', () => {
    // Il margine è per le fatture scritte a mano dal PANNELLO: consumano lo stesso tier
    // e non lasciano nessuna riga in `fatture_emesse` da contare. Il 2026-09-07 ne sono
    // state misurate tre in una serie sola (FPR 1953-1955, assenti dal nostro registro).
    expect(SOGLIA_ORARIA_APP).toBeLessThan(TETTO_ORARIO_ARUBA)
  })

  it('la finestra è larga quanto il TTL del secchio: un’ora', () => {
    expect(FINESTRA_MS).toBe(60 * 60 * 1000)
  })
})

describe('posizioniDisponibili', () => {
  it('a secchio vuoto restano tutte', () => {
    expect(posizioniDisponibili(0)).toBe(SOGLIA_ORARIA_APP)
  })

  it('scala di quante ne risultano emesse', () => {
    expect(posizioniDisponibili(12)).toBe(SOGLIA_ORARIA_APP - 12)
  })

  it('non scende sotto zero nemmeno se il pannello ha già sfondato', () => {
    expect(posizioniDisponibili(SOGLIA_ORARIA_APP + 30)).toBe(0)
  })

  it('«non misurato» NON è «zero»: una guardia che non sa non deve fermare il lavoro', () => {
    // È la differenza che conta. Se la SELECT cade — sul DB E2E la tabella può non
    // esserci — trattare `null` come zero disponibili bloccherebbe l'emissione per un
    // guasto della cintura, non della fattura.
    expect(posizioniDisponibili(null)).toBe(SOGLIA_ORARIA_APP)
  })
})

describe('quanteSePossonoTentare — si tronca, non si rifiuta in blocco', () => {
  it('se ci stanno tutte, si tentano tutte', () => {
    expect(quanteSePossonoTentare(15, 50)).toBe(15)
  })

  it('se ne restano otto e il blocco ne chiede quindici, se ne tentano otto', () => {
    // Otto fatture emesse sono otto fatture emesse. Rifiutare in blocco costringerebbe
    // la segreteria a rifare la selezione a mano per indovinare il numero giusto.
    expect(quanteSePossonoTentare(15, 8)).toBe(8)
  })

  it('a secchio pieno non parte niente', () => {
    expect(quanteSePossonoTentare(15, 0)).toBe(0)
  })
})

describe('contaEmesseUltimaOra', () => {
  let ultimaQuery: { colonne: string[]; filtri: string[] }

  function supabaseFinto(risposta: { count?: number | null; error?: unknown }) {
    ultimaQuery = { colonne: [], filtri: [] }
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      select: (col: string) => {
        ultimaQuery.colonne.push(col)
        return builder
      },
      eq: (campo: string) => {
        ultimaQuery.filtri.push(`eq:${campo}`)
        return builder
      },
      gte: async (campo: string) => {
        ultimaQuery.filtri.push(`gte:${campo}`)
        return { count: risposta.count ?? null, error: risposta.error ?? null }
      },
    })
    return { from: () => builder } as never
  }

  beforeEach(() => {
    vi.stubEnv('VITEST', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('conta su TUTTE le sedi: nessun filtro su scuola_id', async () => {
    // ⚠️ È l'asserzione più importante del file, ed è contro-intuitiva. Il limite di
    // Aruba è **per IP**, e le tre sedi escono dallo stesso IP di Vercel con UNA sola
    // utenza. Un filtro di sede qui farebbe tacere `isolamento-sede-coverage` e
    // renderebbe la guardia FALSA: sarebbe verde mentre il secchio è già vuoto.
    const sb = supabaseFinto({ count: 12 })
    const n = await contaEmesseUltimaOra(sb)

    expect(n).toBe(12)
    expect(ultimaQuery.filtri, 'un filtro di sede qui è un difetto, non una cautela').not.toContain('eq:scuola_id')
    expect(ultimaQuery.filtri).toContain('gte:creato_il')
  })

  it('la finestra parte da un’ora prima dell’istante dato', async () => {
    let visto = ''
    const sb = {
      from: () => {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          gte: async (_campo: string, valore: string) => {
            visto = valore
            return { count: 0, error: null }
          },
        })
        return b
      },
    } as never

    const adesso = new Date('2026-09-07T20:00:00.000Z')
    await contaEmesseUltimaOra(sb, adesso)

    expect(visto).toBe(new Date(adesso.getTime() - FINESTRA_MS).toISOString())
  })

  it('PostgREST non lancia: un `{ error }` diventa «non misurato», non zero', async () => {
    // Il fake restituisce ANCHE un count valorizzato insieme all'errore: un'implementazione
    // che leggesse il `count` senza guardare l'`error` passerebbe un test più indulgente.
    const sb = supabaseFinto({ count: 99, error: { code: '42703', message: 'column does not exist' } })
    expect(await contaEmesseUltimaOra(sb)).toBeNull()
  })
})

describe('il tetto della selezione e la soglia oraria sono due numeri INDIPENDENTI', () => {
  // ⚠️ FINO AL 2026-09-22 QUI SI PRETENDEVA `TETTO_LOTTO === SOGLIA_ORARIA_APP`, ed era
  // giusto: il lotto partiva dal BROWSER, e selezionare più fatture di quante Aruba ne
  // conceda in un'ora voleva dire un troncamento scoperto solo a lotto avviato.
  //
  // Dal nucleo della coda fatture (2026-09-23) il lotto non emette: ACCODA, con una POST
  // sola, e a inviare è il lavoratore sul server, al ritmo di `SOGLIA_ORARIA_APP`, anche
  // a PC spento. Il tetto della selezione è diventato il tetto di un GESTO, e l'unico
  // numero a cui deve restare uguale è quanto la POST della coda accetta
  // (`TETTO_VOCI_CODA`): oltre, la coda risponderebbe 400 all'intero lotto.
  //
  // ⚠️ L'import resta DINAMICO, e i valori NON si importano l'uno dall'altro nei
  // sorgenti, per la stessa ragione di prima: `lotto-fatture.ts` lo carica il browser,
  // mentre questo modulo e `fatture-coda/api.ts` parlano col server. Un numero scritto
  // due volte diverge in silenzio: queste righe sono ciò che lo impedisce.
  it('TETTO_LOTTO è il tetto per GESTO: uguale a ciò che la POST della coda accetta', async () => {
    const { TETTO_LOTTO } = await import('@/lib/pagamenti/lotto-fatture')
    const { TETTO_VOCI_CODA } = await import('@/lib/fatture-coda/api')
    // Controprova che l'import dinamico abbia davvero letto qualcosa: con un modulo
    // sbagliato `undefined === undefined` sarebbe verde su niente.
    expect(typeof TETTO_LOTTO).toBe('number')
    expect(TETTO_LOTTO).toBe(TETTO_VOCI_CODA)
    expect(TETTO_LOTTO).toBe(500)
  })

  it('SOGLIA_ORARIA_APP resta il RITMO del lavoratore, e non limita più la selezione', async () => {
    const { TETTO_LOTTO } = await import('@/lib/pagamenti/lotto-fatture')
    expect(SOGLIA_ORARIA_APP).toBe(50)
    // Il gesto accoda più di un'ora di quota: è il punto della coda, non un difetto.
    expect(TETTO_LOTTO).toBeGreaterThan(SOGLIA_ORARIA_APP)
  })
})
