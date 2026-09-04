import { describe, it, expect } from 'vitest'
import { determinaQuoteFatturazione } from '@/lib/pagamenti/intestatari'

/**
 * `intestatario_fatture.tipo = 'altro'` — un difetto GIÀ IN PRODUZIONE.
 *
 * ─── COSA SUCCEDEVA ──────────────────────────────────────────────────────────
 * La cascata leggeva un campo solo, `intestatario_fatture.adult_id`. Sul ramo
 * `'altro'` quel campo non esiste: la scelta esplicita dell'operatore veniva
 * SALTATA e la fattura ricadeva sul default della famiglia — o su niente, cioè
 * sul 422 «Intestatario fattura non impostato». In nessuno dei due casi qualcuno
 * poteva accorgersene, perché non c'era nessun errore da nessuna parte.
 *
 * Misurato il 2026-09-04: una sola riga in produzione ha `tipo: 'altro'`, con
 * `dati = {}`, zero pagamenti collegati e zero fatture. Nessun dato da
 * convertire, nessuna migrazione — ma la strada esiste e va fatta funzionare
 * prima che qualcuno la usi.
 *
 * ─── LA REGOLA CHE QUESTI TEST DIFENDONO ─────────────────────────────────────
 * Un `altro` INCOMPLETO non ricade sul default di famiglia: passa come quota con
 * l'anagrafica (vuota) al seguito, e il gate `validaCessionario` dell'emissione
 * lo ferma nominando i campi. Ricadere sarebbe rifare il difetto in un posto
 * nuovo: una scelta esplicita ignorata in silenzio.
 *
 * Nomi e codici fiscali SINTETICI (repository pubblico).
 */

const ALTRO_PAGATORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B_DEFAULT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ALUNNO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface Cfg {
  /** Il genitore marcato `parents.intestatario_default`: il ripiego da NON prendere. */
  defaultParent?: { data: unknown; error: unknown }
  studentParents?: unknown[]
  ordine?: { parent_id: string | null } | null
  quote?: unknown[]
}

function db(cfg: Cfg) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'divise_ordini') return { data: cfg.ordine ?? null, error: null }
        if (table === 'parents') return cfg.defaultParent ?? { data: null, error: null }
        return { data: null, error: null }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'student_parents') return resolve({ data: cfg.studentParents ?? [], error: null })
        if (table === 'pagamenti_quote') return resolve({ data: cfg.quote ?? [], error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }
}

const pagamento = { id: 'pag-1', importo: 150 }

/** Il default di famiglia c'è SEMPRE in questi test: è ciò che non deve vincere. */
const conDefault: Cfg = {
  studentParents: [{ parent_id: B_DEFAULT }],
  defaultParent: { data: { id: B_DEFAULT }, error: null },
}

const datiCompleti = {
  nome: 'Carlo',
  cognome: 'Perlini',
  cf: 'PRLCRL80A01H501Z',
  indirizzo: 'Via delle Prove',
  cap: '81030',
  comune: 'Cesa',
  provincia: 'CE',
  civico: '9',
}

describe('determinaQuoteFatturazione — il ramo `tipo: \'altro\'`', () => {
  it('⛔ `altro` COMPLETO → quota con l’anagrafica, NON il default di famiglia', async () => {
    const quote = await determinaQuoteFatturazione(db(conDefault) as never, pagamento, {
      id: ALUNNO,
      intestatario_fatture: { tipo: 'altro', dati: datiCompleti },
    })
    expect(quote).toHaveLength(1)
    // La prova che il ripiego NON ha deciso: `B_DEFAULT` era lì e non compare.
    expect(quote[0].adultId).toBeNull()
    expect(quote[0].importo).toBe(150)
    expect(quote[0].anagrafica).toEqual({
      codice_fiscale: 'PRLCRL80A01H501Z',
      nome: 'Carlo',
      cognome: 'Perlini',
      indirizzo: 'Via delle Prove',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
      numero_civico: '9',
    })
  })

  it('⛔ `altro` con `dati` VUOTI → nessun ripiego silenzioso: la quota c’è, ed è vuota', async () => {
    // È lo stato dell'unica riga vera in produzione. Il rifiuto deve arrivare
    // dopo, da `validaCessionario`, che dice QUALI campi mancano: qui la cascata
    // non deve «aggiustare» niente scegliendo un'altra persona.
    const quote = await determinaQuoteFatturazione(db(conDefault) as never, pagamento, {
      id: ALUNNO,
      intestatario_fatture: { tipo: 'altro', dati: {} },
    })
    expect(quote).toHaveLength(1)
    expect(quote[0].adultId).toBeNull()
    expect(quote[0].anagrafica?.nome).toBe('')
    expect(quote[0].anagrafica?.codice_fiscale).toBe('')
  })

  it('`altro` senza `dati` affatto → stessa cosa, e nessuna eccezione', async () => {
    const quote = await determinaQuoteFatturazione(db(conDefault) as never, pagamento, {
      id: ALUNNO,
      intestatario_fatture: { tipo: 'altro' },
    })
    expect(quote).toHaveLength(1)
    expect(quote[0].adultId).toBeNull()
    expect(quote[0].anagrafica?.comune).toBe('')
  })

  it('l’ordine divise VINCE ancora su `altro`: chi ha ordinato paga la divisa', async () => {
    const quote = await determinaQuoteFatturazione(
      db({ ...conDefault, ordine: { parent_id: 'parent-ordinante' } }) as never,
      pagamento,
      { id: ALUNNO, intestatario_fatture: { tipo: 'altro', dati: datiCompleti } },
    )
    expect(quote).toEqual([{ adultId: 'parent-ordinante', importo: 150, label: 'Divise' }])
  })

  it('le quote esplicite dei genitori separati VINCONO ancora su `altro`', async () => {
    const quote = await determinaQuoteFatturazione(
      db({
        ...conDefault,
        quote: [
          { adult_id: 'u-mamma', importo: 90, etichetta: 'Mamma' },
          { adult_id: 'u-papa', importo: 60, etichetta: 'Papà' },
        ],
      }) as never,
      pagamento,
      { id: ALUNNO, genitori_separati: true, intestatario_fatture: { tipo: 'altro', dati: datiCompleti } },
    )
    expect(quote.map((q) => q.adultId)).toEqual(['u-mamma', 'u-papa'])
  })

  it('`tipo: \'adult\'` si comporta ESATTAMENTE come oggi (i 50 casi veri non si muovono)', async () => {
    const quote = await determinaQuoteFatturazione(db(conDefault) as never, pagamento, {
      id: ALUNNO,
      intestatario_fatture: { tipo: 'adult', adult_id: ALTRO_PAGATORE },
    })
    expect(quote).toEqual([{ adultId: ALTRO_PAGATORE, importo: 150, label: '' }])
    expect(quote[0].anagrafica).toBeUndefined()
  })

  it('un `adult_id` senza `tipo` (le righe più vecchie) continua a funzionare', async () => {
    const quote = await determinaQuoteFatturazione(db(conDefault) as never, pagamento, {
      id: ALUNNO,
      intestatario_fatture: { adult_id: ALTRO_PAGATORE },
    })
    expect(quote).toEqual([{ adultId: ALTRO_PAGATORE, importo: 150, label: '' }])
  })
})
