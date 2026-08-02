import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// La conservazione a 24 mesi — PRIMA i file, POI le righe. E «prima» va provato.
//
// ─── TRE DIFETTI, LO STESSO INVARIANTE ──────────────────────────────────────
//
// 1. La versione SQL di questo lavoro (migrazione `20260801081423`) cancellava i
//    file con `DELETE FROM storage.objects`. Postgres lo vieta — trigger
//    `protect_objects_delete`, FOR EACH STATEMENT, scatta anche a zero righe — e la
//    funzione falliva con `42501` a ogni esecuzione, PRIMA di scrivere la riga di
//    log che avrebbe dovuto segnalarlo.
//
// 2. La route che l'ha sostituita dichiarava `ok: true` anche quando i file NON
//    erano stati rimossi. `supabase.storage.remove()` non fallisce sui percorsi che
//    non esistono: restituisce `data: []` con `error: null`. La route guardava solo
//    `error`, quindi «zero file rimossi su tre attesi» passava per un successo — e
//    le righe venivano cancellate lo stesso: documento nell'archivio, riga che lo
//    nominava sparita. Invisibile, non cancellato.
//
// 3. La correzione del difetto 2 CONTAVA invece di GUARDARE, e si è capovolta in
//    un difetto peggiore: «file non rimosso» veniva usato come sinonimo di «file
//    ancora lì». Non lo è. Un percorso che non esiste più è l'esito voluto GIÀ
//    raggiunto — e siccome un file mancante non torna, il confronto fra conteggi
//    non sarebbe MAI più tornato: un solo allegato già assente avrebbe bloccato per
//    sempre la cancellazione dell'INTERO lotto, cioè l'opposto esatto dell'obbligo
//    che questa route esiste per adempiere. Su dati sanitari di minori.
//
// La regola che ne esce, ed è ciò che questo file sorveglia: **si verifica lo
// STATO, non il conteggio**. Dopo la rimozione, per ogni percorso che non risulta
// uscito si chiede allo Storage se c'è ancora:
//   · non c'è più  → obiettivo raggiunto, si prosegue (riga `info`, come fa già
//                    `rimuoviFileOblio` nell'oblio su richiesta: `oblio-file-gia-assenti`);
//   · c'è ancora   → ci si ferma, ma SOLO sulla domanda che lo nomina;
//   · non si sa    → ci si ferma lo stesso: «non so» non è «non c'è».
//
// ─── COSA PROVA QUESTO FILE ─────────────────────────────────────────────────
//
// L'ORDINE, la RINUNCIA e la sua MISURA: che i file siano tolti prima delle righe,
// che quando un documento è ancora nell'archivio la sua riga resti dov'è, e che una
// domanda che non si può chiudere non trattenga tutte le altre. Con il controllo
// positivo accanto, perché una route che non cancella mai niente passerebbe un test
// fatto di sole rinunce — ed è esattamente il difetto 3.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
  /** La sequenza REALE delle operazioni: è l'ordine la cosa da provare. */
  sequenza: [] as { tipo: 'remove' | 'delete'; valore: unknown }[],
  /** Le domande scadute che la lettura restituisce. */
  scadute: [] as Record<string, unknown>[],
  /** Cosa risponde `storage.remove()`: il cuore del secondo difetto. */
  removeRisposta: null as { data: unknown[] | null; error: unknown } | null,
  /** I percorsi che, INTERROGANDO lo Storage, risultano ANCORA nel bucket. */
  ancoraNelBucket: new Set<string>(),
  /** Le interrogazioni di verifica effettivamente partite: `<cartella>|<nome>`. */
  verifiche: [] as string[],
  /** Guasto della verifica: «non so» — che non è «non c'è». */
  erroreVerifica: null as unknown,
  erroreLettura: null as unknown,
  erroreDelete: null as unknown,
  eventi: [] as { livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (_evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'lt', 'eq']) qb[m] = () => qb
      qb.delete = () => ({
        in: (_c: string, ids: unknown) => {
          h.sequenza.push({ tipo: 'delete', valore: ids })
          return Promise.resolve({ error: h.erroreDelete })
        },
      })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.scadute, error: h.erroreLettura }).then(res)
      return qb
    },
    storage: {
      from: () => ({
        remove: (percorsi: string[]) => {
          h.sequenza.push({ tipo: 'remove', valore: percorsi })
          return Promise.resolve(
            h.removeRisposta ?? { data: percorsi.map((p) => ({ name: p })), error: null },
          )
        },
        // `list(cartella, { search })` è la domanda «c'è ancora?»: lo Storage risponde
        // 200 con l'elenco (vuoto se non c'è), non 404 — così una verifica su un file
        // legittimamente assente non finisce nel canale degli errori.
        list: (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          h.verifiche.push(`${cartella}|${nome}`)
          if (h.erroreVerifica) return Promise.resolve({ data: null, error: h.erroreVerifica })
          const completo = cartella ? `${cartella}/${nome}` : nome
          return Promise.resolve({
            data: h.ancoraNelBucket.has(completo) ? [{ name: nome }] : [],
            error: null,
          })
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

const chiama = () =>
  POST(
    new Request('http://localhost/api/gdpr/retention-iscrizioni', {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }),
  )

/** Una domanda scaduta con due documenti allegati. */
const domandaConAllegati = (id: string) => ({
  id,
  data: {
    children: [{ documento_path: `${id}/minore.pdf` }],
    adults: [{ documento_path: `${id}/adulto.pdf` }],
  },
})

const soloDelete = () => h.sequenza.filter((c) => c.tipo === 'delete')
const soloRemove = () => h.sequenza.filter((c) => c.tipo === 'remove')
const idsCancellati = () => soloDelete().flatMap((c) => c.valore as string[])
const eventiDi = (livello: string) => h.eventi.filter((e) => e.livello === livello)

beforeEach(() => {
  vi.clearAllMocks()
  h.sequenza = []
  h.scadute = []
  h.removeRisposta = null
  h.ancoraNelBucket = new Set()
  h.verifiche = []
  h.erroreVerifica = null
  h.erroreLettura = null
  h.erroreDelete = null
  h.eventi = []
  process.env.CRON_SECRET = CRON_SECRET
})

describe('POST /api/gdpr/retention-iscrizioni — i file prima delle righe', () => {
  it('CONTROLLO POSITIVO: con tutto a posto cancella file E righe, in quest’ordine', async () => {
    // Senza questo, l'intero file certificherebbe una route che non cancella mai
    // niente — cioè una conservazione che non conserva e non cancella.
    h.scadute = [domandaConAllegati('d1')]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 2 })
    expect(h.sequenza.map((c) => c.tipo), 'prima remove, poi delete').toEqual(['remove', 'delete'])
    expect(h.verifiche, 'se sono usciti tutti non si interroga lo Storage').toEqual([])
  })

  it('🔴 un allegato GIÀ ASSENTE non blocca la cancellazione: l’esito voluto è raggiunto', async () => {
    // IL DIFETTO 3, quello che si sarebbe auto-bloccato per sempre. `remove()` non
    // restituisce i percorsi che non esistevano più; contarli come fallimenti
    // significava non cancellare MAI PIÙ nessuna domanda del lotto, perché un file
    // mancante non torna. Qui lo Storage conferma che non c'è: si prosegue.
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [], error: null }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 1 })
    expect(idsCancellati(), 'la riga si cancella: i documenti non ci sono più').toEqual(['d1'])
    expect(h.verifiche.length, 'i due percorsi non usciti vanno verificati uno per uno').toBe(2)
    const info = eventiDi('info').find((e) => e.campi.n_file_gia_assenti === 2)
    expect(info, 'un file già assente si DICE (info), non si nasconde e non è un errore').toBeTruthy()
  })

  it('le verifiche vanno a lotti, e non se ne perde nessuna per strada', async () => {
    // Le interrogazioni partono a gruppi: una dietro l'altra, su centinaia di
    // percorsi, il lavoro scadrebbe prima di finire — e un lavoro che scade non
    // cancella niente, cioè lo stesso blocco permanente per un'altra strada. Il
    // rischio del lotto è l'opposto: perderne uno per un errore di indice.
    h.scadute = ['d1', 'd2', 'd3', 'd4', 'd5'].map(domandaConAllegati)
    h.removeRisposta = { data: [], error: null }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.verifiche.length, 'dieci percorsi, dieci verifiche').toBe(10)
    expect(idsCancellati()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(eventiDi('info').some((e) => e.campi.n_file_gia_assenti === 10)).toBe(true)
  })

  it('🔴 un allegato ANCORA NEL BUCKET ferma la sua domanda: la riga NON si tocca', async () => {
    // «Non rimosso» e «ancora lì» tornano a essere due fatti diversi, e questo è il
    // secondo: il documento d'identità c'è ancora, quindi la riga che lo nomina resta
    // dov'è — altrimenti resterebbe un file senza più nessun dato che lo nomini.
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [{ name: 'd1/adulto.pdf' }], error: null }
    h.ancoraNelBucket = new Set(['d1/minore.pdf'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'allegati-non-rimossi' })
    expect(soloDelete(), 'nessuna riga cancellata').toHaveLength(0)
    const errore = eventiDi('error').find((e) => e.campi.n_file_bloccanti !== undefined)
    expect(errore, 'un fallimento silenzioso è il difetto, non la conseguenza').toBeTruthy()
    expect(errore?.campi.n_file_bloccanti).toBe(1)
  })

  it('🔴 una domanda bloccata non trattiene le ALTRE', async () => {
    // La conservazione è un obbligo per riga, non per lotto: un allegato che non esce
    // riguarda la SUA domanda. Trattenerle tutte era il modo di trasformare un guasto
    // su un file in una violazione su novantadue famiglie.
    h.scadute = [domandaConAllegati('d1'), domandaConAllegati('d2')]
    h.removeRisposta = { data: [{ name: 'd1/adulto.pdf' }, { name: 'd2/minore.pdf' }, { name: 'd2/adulto.pdf' }], error: null }
    h.ancoraNelBucket = new Set(['d1/minore.pdf'])
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(idsCancellati(), 'd2 non ha niente a che vedere con il file di d1').toEqual(['d2'])
    expect(await res.json()).toMatchObject({
      ok: false,
      motivo: 'allegati-non-rimossi',
      domande: 1,
      domande_trattenute: 1,
    })
  })

  it('🔴 se la verifica NON risponde, non si cancella: «non so» non è «non c’è»', async () => {
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [], error: null }
    h.erroreVerifica = { message: 'storage giù' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'verifica-non-riuscita' })
    expect(soloDelete(), 'nell’incertezza la riga resta, e si riprova il mese dopo').toHaveLength(0)
    expect(eventiDi('error').length, 'un dubbio taciuto è un dubbio che nessuno scioglie').toBeGreaterThan(0)
  })

  it('se `remove()` risponde col solo NOME del file, non parte una verifica inutile', async () => {
    // Lo Storage risponde con gli oggetti rimossi; questa route non deve dipendere
    // dalla FORMA di quella risposta per decidere. Percorso pieno o nome solo, se il
    // riscontro è univoco il file è uscito e non c'è niente da verificare.
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: [{ name: 'minore.pdf' }, { name: 'adulto.pdf' }], error: null }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.verifiche).toEqual([])
    expect(idsCancellati()).toEqual(['d1'])
  })

  it('se lo Storage risponde con un errore vero, le righe NON si toccano', async () => {
    h.scadute = [domandaConAllegati('d1')]
    h.removeRisposta = { data: null, error: { message: 'storage giù' } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDelete()).toHaveLength(0)
    expect(h.verifiche, 'se la chiamata è fallita non c’è niente da verificare').toEqual([])
  })

  it('nessuna domanda scaduta ⇒ nessuna operazione, e il conteggio si scrive LO STESSO', async () => {
    // «Nessuna riga» non può voler dire insieme «tutto a posto» e «non è mai
    // partito»: è la riga che nella versione SQL non veniva scritta MAI, perché
    // stava dopo la DELETE che faceva fallire tutto.
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 0, file: 0 })
    expect(soloRemove(), 'niente da togliere, nessuna chiamata allo Storage').toHaveLength(0)
    const info = h.eventi.find((e) => e.livello === 'info')
    expect(info?.campi.esito).toBe('retention-iscrizioni')
    expect(info?.campi.n_domande).toBe(0)
  })

  it('una domanda SENZA allegati si cancella comunque', async () => {
    h.scadute = [{ id: 'd2', data: { children: [{}], adults: [] } }]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, domande: 1, file: 0 })
    expect(soloDelete()).toHaveLength(1)
  })

  it('un guasto di LETTURA non passa per «nessuna domanda scaduta»', async () => {
    // PostgREST non lancia: senza controllare `error`, un guasto diventerebbe un
    // giro a vuoto che si dichiara riuscito.
    h.erroreLettura = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(soloDelete()).toHaveLength(0)
    expect(soloRemove()).toHaveLength(0)
  })

  it('senza il segreto del cron si passa dal gate dello staff', async () => {
    const { requireStaff } = await import('@/lib/auth/require-staff')
    await POST(new Request('http://localhost/api/gdpr/retention-iscrizioni', { method: 'POST' }))
    expect(requireStaff).toHaveBeenCalled()
  })
})
