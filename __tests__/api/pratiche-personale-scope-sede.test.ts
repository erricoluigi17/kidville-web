import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { costruisciClient, type StatoFinto } from '../fixtures/pratiche-personale'

// =============================================================================
// L'ISOLAMENTO FRA SEDI, e in particolare LA SCANSIONE DEL DOCUMENTO D'IDENTITÀ.
//
// ── IL DIFETTO CHE QUESTO FILE IMPEDISCE ─────────────────────────────────────
// Una URL firmata è scaricabile SENZA sessione: chi ce l'ha, ha il file. Produrla e
// POI rispondere 403 è una fuga con un altro nome — è il difetto misurato in
// produzione il 2026-07-31 sui documenti d'identità dei bambini, e qui l'oggetto è la
// fotografia della carta d'identità di una dipendente. Perciò la prova non guarda lo
// STATUS della risposta: guarda che `createSignedUrl` non sia stata chiamata AFFATTO.
//
// ── LE ALTRE COSE CHE TIENE FERME ────────────────────────────────────────────
//  · elenco e dettaglio portano il filtro di sede NELLA STESSA query;
//  · «non esiste» e «è di un'altra sede» escono dalla stessa porta, con la stessa
//    frase: distinguerle direbbe a chi non ha titolo di vederla che quella pratica c'è,
//    e da lì escono codice fiscale, residenza ed estremi del documento;
//  · un GUASTO dello storage DOPO il gate è 503, non 403: un guasto non si veste da
//    diniego, o la Segreteria va a cercare un problema di permessi che non c'è;
//  · la firma dura 300 secondi e non 600. Un curriculum e una carta d'identità non
//    valgono lo stesso, e una durata che nessuno misura torna al valore di prima al
//    primo copincolla;
//  · scope VUOTO ⇒ elenco vuoto, non «tutto»: `.in()` incondizionato.
//  · un `?doc=` MALFORMATO non arriva a nessuna query: la forma si decide PRIMA
//    della risoluzione, e la prova è il contatore delle tabelle interrogate — non
//    lo status, che è (e deve restare) quello di «non esiste».
// =============================================================================

const OPERATORE = { id: 'ffffffff-1111-4000-8000-000000000001', role: 'segreteria', scuola_id: SEDE_A }
const PRATICA_A = 'dddddddd-0000-4000-8000-00000000000a'
const PRATICA_B = 'dddddddd-0000-4000-8000-00000000000b'

// ⚠️ LA FORMA CANONICA, quella che `iscrizione/personale/upload:POST` produce:
// `documenti/<uuid>/<uuid>.<ext>`. Qui c'era `documenti/aaaa/mia.jpg`, che quella
// forma non ce l'ha: da questo giro il gate lo respingerebbe per FORMA, e il
// percorso felice sarebbe restato verde per la ragione sbagliata — 403 invece di
// 200 — smettendo di misurare la risoluzione. Misurata in produzione il 12/08/2026:
// l'unico percorso archiviato ha esattamente questa forma.
const DOC_A = 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jpg'
const DOC_A_RETRO = 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jpg'
const DOC_B = 'documenti/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f.jpg'
/**
 * IL RETRO DELL'ALTRA SEDE, e serve a una prova sola ma che non si può fare senza.
 *
 * Il ciclo DIAGNOSTICO — quello che, dopo il diniego, decide se scrivere in `app_log`
 * `documento-fuori-sede` o `documento-non-risolto` — itera anch'esso su
 * `COLONNE_DOCUMENTO`. Con un solo percorso «altrui» archiviato nel FRONTE, ridurre
 * quel ciclo alla prima colonna resterebbe verde: è la mutazione sopravvissuta del
 * 13/08/2026.
 */
const DOC_B_RETRO = 'documenti/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70.jpg'

/** Un percorso ben formato che non è di nessuno: serve a confrontare le risposte. */
const DOC_INESISTENTE = 'documenti/99999999-9999-4999-8999-999999999999/88888888-8888-4888-8888-888888888888.pdf'

/**
 * IL PERCORSO CHE RISCRIVE IL FILTRO, scritto per esteso.
 *
 * `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')` è la scrittura che
 * viene naturale con due colonne, e in quella sintassi la virgola SEPARA le condizioni:
 * un `<X>` che ne contenga una non rompe il filtro, lo RISCRIVE. Finisce con
 * un'estensione legittima apposta, così a respingerlo può essere solo la FORMA.
 */
const DOC_MALFORMATO = `${DOC_A},documento_retro_path.eq.${DOC_B}`

const h = vi.hoisted(() => ({
  state: {
    tabelle: {} as Record<string, Record<string, unknown>[]>,
    inserimenti: [] as { table: string; row: Record<string, unknown> }[],
    aggiornamenti: [] as { table: string; patch: Record<string, unknown>; filtri: { col: string; vals: unknown[] }[] }[],
    upserts: [] as { table: string; row: Record<string, unknown>; onConflict: string | null }[],
    authUsers: [] as { id: string; email: string }[],
    creazioniAuth: [] as { email: string; password?: string }[],
    cancellazioniAuth: [] as string[],
    erroriTabella: {} as Record<string, { code?: string; message: string }>,
    colonneAssenti: {} as Record<string, string[]>,
    erroreStorage: null as null | { message: string },
    urlFirmate: [] as { path: string; secondi: number }[],
    erroreCreazioneAuth: null as null | { message: string; status?: number },
    /**
     * OGNI `from(<tabella>)`, anche quando la query poi fallisce o non viene mai
     * eseguita: è l'unica misura che dimostra un ORDINE. Guardare lo status non
     * distinguerebbe «respinto per forma» da «cercato e non trovato» — sono lo stesso
     * 403, e devono esserlo. Sta qui e non nel finto condiviso perché è un bisogno di
     * questo file: il finto lo usano in cinque, e allargarlo per uno è come si
     * ottengono fixture che nessuno capisce più.
     */
    tabelleInterrogate: [] as string[],
  },
  scuole: [] as string[],
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.scuole }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', () => {
  // Il finto condiviso, avvolto in un contatore di `from()`. L'involucro sta QUI e
  // non dentro `costruisciClient`: la fixture è usata da cinque file, e allargarla
  // per il bisogno di uno è il modo in cui una fixture diventa illeggibile.
  const conContatore = () => {
    const client = costruisciClient(h.state as unknown as StatoFinto)
    return {
      ...client,
      from: (table: string) => {
        h.state.tabelleInterrogate.push(table)
        return client.from(table)
      },
    }
  }
  return { createAdminClient: async () => conContatore(), createClient: async () => conContatore() }
})

import { GET, PATCH } from '@/app/api/admin/pratiche-personale/route'
// Il tetto si IMPORTA e non si ribatte: un `200` scritto qui sarebbe la quarta
// dichiarazione dello stesso numero, e la prima a smettere di seguire le altre.
import { DOC_MAX_LUNGHEZZA } from '@/lib/personale/percorso-documento'

const url = (qs = '') => new NextRequest(`http://localhost/api/admin/pratiche-personale${qs}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.scuole = [SEDE_A]
  Object.assign(h.state, {
    inserimenti: [], aggiornamenti: [], upserts: [], erroriTabella: {}, colonneAssenti: {},
    erroreStorage: null, urlFirmate: [], tabelleInterrogate: [],
  })
  h.state.tabelle = {
    pratiche_personale: [
      {
        id: PRATICA_A, scuola_id: SEDE_A, stato: 'pending', nome: 'Mia', cognome: 'Collega',
        email: 'mia@example.test', fiscal_code: 'RSSMRA90A41H501U',
        // LE COLONNE DI OGGI, E SOLO QUELLE (migrazione `20260812194501`).
        // Qui c'era anche `documento_path: DOC_A`, tenuto «perché il gate di `?doc=`
        // la interroga ancora»: era il finto che reggeva in piedi una query rotta.
        // In produzione quella colonna non esiste più e la lettura risponde `42703`,
        // quindi il gate — fail-closed — negava OGNI documento mentre questi test
        // restavano verdi. Un finto più ricco del database rende invisibile
        // esattamente il difetto che il database ha già.
        documento_fronte_path: DOC_A, documento_retro_path: DOC_A_RETRO,
        document_expiry: '2030-01-01', gradi: ['nido'], creata_il: '2026-08-11T08:00:00.000Z',
      },
      {
        id: PRATICA_B, scuola_id: SEDE_B, stato: 'pending', nome: 'Altra', cognome: 'Sede',
        email: 'altra@example.test', fiscal_code: 'VRDLGU85M01F839X',
        // DUE facce anche qui, e il retro non è decorazione del finto: è l'unico dato
        // con cui si può misurare che il ciclo diagnostico guardi ANCHE la seconda
        // colonna. Vedi `DOC_B_RETRO`.
        documento_fronte_path: DOC_B, documento_retro_path: DOC_B_RETRO,
        document_expiry: '2029-01-01', gradi: ['infanzia'], creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
    utenti: [], parents: [], anagrafica_personale: [],
  }
  h.requireStaff.mockImplementation(async () => ({ user: OPERATORE }))
})

describe('pratiche personale · isolamento fra sedi', () => {
  it('l’ELENCO mostra solo le pratiche delle sedi attive, e resta POVERO', async () => {
    const res = await GET(url())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(PRATICA_A)
    expect(body.total).toBe(1)

    // L'elenco NON porta codice fiscale, email, residenza né il percorso della
    // scansione: è la lezione di «Moduli ricevuti», dove il payload completo di ogni
    // domanda partiva verso il browser di ogni membro dello staff a ogni apertura.
    const riga = body.data[0] as Record<string, unknown>
    expect(Object.keys(riga).sort()).toEqual(
      ['cognome', 'creata_il', 'document_expiry', 'id', 'nome', 'scuola_id', 'stato'],
    )
  })

  it('scope VUOTO ⇒ elenco vuoto, non «tutto»', async () => {
    h.scuole = []
    const res = await GET(url())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('il DETTAGLIO di un’altra sede: 404 con la STESSA frase di «non esiste»', async () => {
    const fuori = await GET(url(`?id=${PRATICA_B}`))
    expect(fuori.status).toBe(404)
    const corpoFuori = await fuori.json()
    expect(corpoFuori.codice).toBe('PRATICA_NON_TROVATA')

    const inesistente = await GET(url('?id=11111111-1111-4111-8111-111111111111'))
    expect(inesistente.status).toBe(404)
    const corpoInesistente = await inesistente.json()
    // La stessa frase: distinguerle sarebbe un oracolo su chi lavora dove.
    expect(corpoFuori.error).toBe(corpoInesistente.error)
  })

  it('il DETTAGLIO della PROPRIA sede si apre, e porta i campi che servono a decidere', async () => {
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const dati = (await res.json()).data as Record<string, unknown>
    expect(dati.fiscal_code).toBe('RSSMRA90A41H501U')
    expect(dati.documento_fronte_path).toBe(DOC_A)
  })

  it('🔴 `?doc=` di un’ALTRA sede: 403 e `createSignedUrl` MAI chiamata', async () => {
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_B)}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('PRATICA_NON_TROVATA')
    // LA PROVA VERA: non lo status, ma il fatto che la firma non sia mai stata
    // prodotta. Una URL firmata vive di vita propria: emetterla e poi negare l'accesso
    // è una fuga con un altro nome.
    expect(h.state.urlFirmate, 'una URL firmata è stata prodotta prima del diniego').toEqual([])
  })

  it('`?doc=` di un percorso INVENTATO: stesso 403, stessa frase, nessuna firma', async () => {
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_INESISTENTE)}`))
    expect(res.status).toBe(403)
    expect(h.state.urlFirmate).toEqual([])
  })

  it('🔴 `?doc=` MALFORMATO: 403 identico a «non esiste», e ZERO query alla tabella', async () => {
    /**
     * IL DIFETTO CHE QUESTA RIGA IMPEDISCE. Lo schema `zod` di `?doc=` impone solo un
     * tetto di lunghezza: la forma non è vincolata da nessuna parte. Con due colonne
     * da confrontare la scrittura che viene naturale è
     * `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')`, e in quella
     * sintassi la virgola SEPARA le condizioni — un `<X>` che ne contenga una non
     * rompe il filtro, lo RISCRIVE, e il gate direbbe «è della tua sede» di una
     * scansione che non lo è. Non è un'iniezione SQL (PostgREST non concatena SQL):
     * è un'iniezione di FILTRO, e qui produce lo stesso danno.
     *
     * La difesa è l'ORDINE, e l'ordine è ciò che questa prova misura: il contatore
     * delle tabelle interrogate deve restare VUOTO. Lo status non basterebbe — un
     * filtro che non trova nulla risponde 403 esattamente come il gate di forma.
     */
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_MALFORMATO)}`))
    expect(res.status).toBe(403)
    expect(
      h.state.tabelleInterrogate,
      'un percorso malformato è entrato in una query: il gate di forma non viene per primo',
    ).toEqual([])
    expect(h.state.urlFirmate).toEqual([])

    // La risposta è IDENTICA a quella di un percorso ben formato che non esiste:
    // distinguere «malformato» da «non c'è» direbbe a chi prova che la forma, quella
    // volta, era giusta.
    const inesistente = await GET(url(`?doc=${encodeURIComponent(DOC_INESISTENTE)}`))
    expect(res.status).toBe(inesistente.status)
    expect(await res.json()).toEqual(await inesistente.json())
  })

  // ── IL TETTO DI `?doc=` — vedi il gemello in `anagrafica-personale-admin-scope-sede` ──
  //
  // `percorso-documento.ts` dichiara che `DOC_MAX_LUNGHEZZA` agisce DAVVERO solo qui e
  // nella rotta gemella, e fino al 13/08/2026 nessuna riga lo misurava: mutato
  // `.max(DOC_MAX_LUNGHEZZA)` → `.max(50000)` nei due schemi, **39 test restavano
  // verdi**. Le due prove valgono in coppia — 400 sopra il tetto, 403 al limite esatto
  // — perché è la coppia a inchiodare il numero da entrambi i lati.
  it('🔴 `?doc=` OLTRE `DOC_MAX_LUNGHEZZA`: 400 di validazione, e non arriva nemmeno al gate di forma', async () => {
    const troppoLungo = DOC_A + 'a'.repeat(DOC_MAX_LUNGHEZZA + 1 - DOC_A.length)
    expect(troppoLungo.length).toBe(DOC_MAX_LUNGHEZZA + 1)

    const res = await GET(url(`?doc=${encodeURIComponent(troppoLungo)}`))

    expect(res.status, 'sopra il tetto la risposta deve essere 400: il valore non è nemmeno guardato').toBe(400)
    expect(((await res.json()).details as { path: string }[]).map((d) => d.path)).toContain('doc')
    expect(h.state.tabelleInterrogate, 'una stringa oltre il tetto è entrata in una query').toEqual([])
    expect(h.state.urlFirmate).toEqual([])
  })

  it('🔴 `?doc=` lungo ESATTAMENTE `DOC_MAX_LUNGHEZZA` passa la validazione: il tetto è quello, non uno più stretto', async () => {
    const alLimite = DOC_A + 'a'.repeat(DOC_MAX_LUNGHEZZA - DOC_A.length)
    expect(alLimite.length).toBe(DOC_MAX_LUNGHEZZA)

    const res = await GET(url(`?doc=${encodeURIComponent(alLimite)}`))

    // 403 e non 400: lo respinge il gate di FORMA (estensione fuori elenco), non `zod`.
    expect(res.status, 'al limite esatto la risposta è del gate di forma, non della validazione').toBe(403)
  })

  // ── IL LOG DI UNA FUGA DEVE RESTARE LEGGIBILE ANCHE SUL RETRO ────────────────
  //
  // Verso il client, «è di un'altra sede» e «questo percorso non esiste» sono la
  // STESSA risposta, ed è giusto così: distinguerle direbbe a chi non ha titolo che
  // quella persona lavora qui. La conseguenza è che la distinzione sopravvive in UN
  // POSTO SOLO — `app_log` — e da lì si legge la differenza fra un collegamento vecchio
  // e qualcuno che sta provando i documenti di un altro plesso.
  //
  // Il commento nella rotta la promette per esteso: «cercare il fronte e non il retro
  // direbbe “inventato” di un documento che esiste, cioè renderebbe illeggibile proprio
  // il log di una fuga». Fino al 13/08/2026 nessuna riga la misurava: mutazione
  // eseguita, `for (const colonna of COLONNE_DOCUMENTO)` → `COLONNE_DOCUMENTO.slice(0, 1)`
  // nel ciclo diagnostico, **44 test verdi**.
  it.each([
    ['FRONTE', () => DOC_B],
    ['RETRO', () => DOC_B_RETRO],
  ])('🔴 `?doc=` di un’altra sede archiviato nel %s: il log dice `documento-fuori-sede`, non «non risolto»', async (_faccia, doc) => {
    const res = await GET(url(`?doc=${encodeURIComponent(doc())}`))

    // Verso il client: identico al percorso inventato. È il contratto, e non cambia.
    expect(res.status).toBe(403)
    expect(h.state.urlFirmate).toEqual([])

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { azione?: string })?.azione === 'documento' && (c[1] as string) === 'warn',
    )?.[2] as { esito?: string; sede_id?: unknown } | undefined
    expect(
      riga?.esito,
      'un tentativo cross-sede è uscito in `app_log` come un collegamento vecchio: la sola distinzione che sopravvive è persa',
    ).toBe('documento-fuori-sede')
    expect(riga?.sede_id, 'il log non dice DA QUALE sede viene il documento richiesto').toBe(SEDE_B)
  })

  it('🔴 un percorso ben formato e DI NESSUNO resta `documento-non-risolto`: i due esiti non collassano in uno', async () => {
    // La guardia contro l'autoinganno gemella delle altre: un ciclo diagnostico che
    // rispondesse «fuori sede» sempre renderebbe verdi le due prove qui sopra, e
    // renderebbe illeggibile il log nell'altro verso — ogni collegamento vecchio di
    // una scheda aperta ieri sembrerebbe un tentativo.
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_INESISTENTE)}`))
    expect(res.status).toBe(403)

    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { azione?: string })?.azione === 'documento' && (c[1] as string) === 'warn',
    )?.[2] as { esito?: string; sede_id?: unknown } | undefined
    expect(riga?.esito).toBe('documento-non-risolto')
    expect(riga?.sede_id).toBeNull()
  })

  it('🔴 il rifiuto per FORMA ha un `esito` suo, e non porta il percorso', async () => {
    // Stessa risposta verso il client, log DIVERSO: `documento-non-risolto` è il
    // collegamento vecchio di chi ha una scheda aperta da ieri, `documento-forma-non-valida`
    // è qualcuno che ha scritto a mano una cosa che il prodotto non produce. Senza
    // due `esito` distinti quella differenza non si legge più in SQL.
    await GET(url(`?doc=${encodeURIComponent(DOC_MALFORMATO)}`))
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'documento-forma-non-valida',
    )
    expect(riga, 'il rifiuto per forma non lascia nessuna riga distinguibile in `app_log`').toBeTruthy()
    expect(riga?.[0]).toBe('multi_sede')
    expect(riga?.[1]).toBe('warn')

    // Il percorso NON si logga: non porta il nome del file, ma è la chiave che apre
    // la fotografia della carta d'identità di una persona.
    const scritto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
    expect(scritto).not.toContain(DOC_A)
    expect(scritto).not.toContain(DOC_B)
  })

  it('🔴 il gate di forma NON respinge il percorso VERO: un gate che nega tutto è il difetto di ieri', async () => {
    // La guardia contro l'autoinganno: `percorsoDocumentoAmmesso` che rispondesse
    // sempre `false` renderebbe verdi tutte le prove qui sopra — e chiuderebbe la
    // Segreteria fuori da ogni documento, che è il difetto del 12/08/2026 con un
    // altro nome.
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(200)
    expect(h.state.tabelleInterrogate).toContain('pratiche_personale')
  })

  it('🔴 DB NON MIGRATO (42703) durante il gate: 503 di indisponibilità, MAI una firma', async () => {
    // È lo stato del database E2E della CI per costruzione, ed è lo stato in cui la
    // PRODUZIONE si è trovata fra la migrazione `20260812194501` e questo codice. Le
    // due cose da tenere ferme: non si firma niente, e la risposta è 503 — un guasto
    // travestito da 403 manderebbe la Segreteria a cercare un permesso che non manca.
    h.state.erroriTabella = {
      pratiche_personale: { code: '42703', message: 'column "documento_fronte_path" does not exist' },
    }
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    expect(h.state.urlFirmate, 'una URL firmata è stata prodotta con lo schema in errore').toEqual([])
  })

  it('`?doc=` della PROPRIA sede: firma da 300 secondi, non 600', async () => {
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(200)
    expect(typeof (await res.json()).url).toBe('string')
    expect(h.state.urlFirmate).toHaveLength(1)
    expect(h.state.urlFirmate[0].path).toBe(DOC_A)
    expect(
      h.state.urlFirmate[0].secondi,
      'la durata della firma su una carta d’identità è tornata a quella di un curriculum',
    ).toBe(300)
  })

  it('🔴 anche il RETRO della propria sede si firma: il gate guarda TUTTE le colonne', async () => {
    // Il gate interrogava una colonna scritta a mano (`documento_path`). Il
    // 12/08/2026 la migrazione `20260812194501` l'ha rinominata in
    // `documento_fronte_path`, in PRODUZIONE, e la lettura è diventata un `42703`
    // («column does not exist») — che su un gate fail-CLOSED vale «non firmo». La
    // Segreteria delle tre sedi ha smesso di aprire qualunque documento d'identità
    // ricevendo la risposta di un tentativo abusivo, e la suite era verde perché il
    // finto teneva ANCHE la colonna vecchia. Adesso le colonne si iterano da
    // `CAMPI_DOCUMENTO`: questa riga è rossa se qualcuno torna a nominarne una sola.
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A_RETRO)}`))
    expect(res.status).toBe(200)
    expect(h.state.urlFirmate).toHaveLength(1)
    expect(h.state.urlFirmate[0].path).toBe(DOC_A_RETRO)
  })

  it('🔴 storage in ERRORE DOPO il gate: 503, non 403 — un guasto non si veste da diniego', async () => {
    h.state.erroreStorage = { message: 'Object not found in bucket documenti_personale' }
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
    // Il messaggio grezzo non torna al client: contiene il percorso dell'oggetto.
    expect(String(body.error)).not.toContain('documenti_personale')
    expect(String(body.error)).not.toContain(DOC_A)
  })

  it('lettura fallita durante il gate del documento: fail-CLOSED, e nessuna firma', async () => {
    h.state.erroriTabella = { pratiche_personale: { code: '08006', message: 'connection failure' } }
    const res = await GET(url(`?doc=${encodeURIComponent(DOC_A)}`))
    expect(res.status).toBe(503)
    expect(h.state.urlFirmate, 'non sapere di chi è un documento non può voler dire consegnarlo').toEqual([])
  })

  it('la PATCH su una pratica di un’altra sede: 404, e nessuna scrittura', async () => {
    const res = await PATCH(new NextRequest('http://localhost/api/admin/pratiche-personale', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PRATICA_B, action: 'approva' }),
    }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('PRATICA_NON_TROVATA')
    expect(h.state.aggiornamenti).toEqual([])
    expect(h.state.creazioniAuth).toEqual([])
  })

  it('il DETTAGLIO dice se quell’email ha già un account, e con che ruolo', async () => {
    /**
     * La route lo sapeva già — `risolviAccountEsistente` gira prima del claim — e lo
     * buttava in un campo di log. Il riquadro di conferma non poteva dirlo, quindi non
     * lo diceva: chi premeva «Approva» non sapeva che stava per riscrivere il profilo
     * e il fascicolo di una persona che esiste, né con quale ruolo o sede.
     * `/anagrafica-personale` è pubblico e ANONIMO: chiunque può mandare una pratica
     * con l'email di una collega o della Direzione.
     */
    h.state.tabelle.utenti = [
      { id: 'u-1', email: 'mia@example.test', ruolo: 'admin', scuola_id: SEDE_A },
    ]
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.account).toMatchObject({ esiste: true, ruolo: 'admin', sede_gestita: true })
    expect(body.account.sede_nome).toBe('Kidville Alfa')
    // …e NON esce l'uuid dell'account: qui si risponde a una domanda su QUESTA pratica,
    // non si apre una finestra sull'anagrafica del personale.
    expect(JSON.stringify(body.account)).not.toContain('u-1')
  })

  it('l’account è in un plesso FUORI scope: si dice che c’è, ma il ruolo NON esce', async () => {
    // La decisione lì è già presa — il gate del punto 5 negherà l'approvazione — e il
    // ruolo di una persona di un altro plesso non serve a prenderla.
    h.state.tabelle.utenti = [
      { id: 'u-2', email: 'mia@example.test', ruolo: 'admin', scuola_id: SEDE_B },
    ]
    const body = await (await GET(url(`?id=${PRATICA_A}`))).json()
    expect(body.account).toEqual({ esiste: true, ruolo: null, sede_gestita: false, sede_nome: null })
  })

  it('nessun account con quell’email: `esiste: false`, che NON è `null`', async () => {
    const body = await (await GET(url(`?id=${PRATICA_A}`))).json()
    expect(body.account.esiste).toBe(false)
  })

  it('la verifica dell’account NON riesce: `esiste: null`, e il dettaglio si apre lo stesso', async () => {
    // Tre stati e non due. `false` direbbe «non c'è» su una domanda a cui non si è
    // risposto, ed è esattamente l'errore che il fail-closed della PATCH esiste per
    // evitare — qui però la lettura della pratica è riuscita, quindi il dettaglio non
    // si nega: si dichiara ciò che non si sa.
    h.state.erroriTabella = { utenti: { code: '08006', message: 'connection failure' } }
    const res = await GET(url(`?id=${PRATICA_A}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.fiscal_code).toBe('RSSMRA90A41H501U')
    expect(body.account.esiste).toBeNull()
  })

  it('la TABELLA assente non si degrada in «non è arrivato niente»: 503 dichiarato', async () => {
    // Un elenco vuoto sarebbe una risposta, e sarebbe falsa: la Segreteria
    // concluderebbe che non ha compilato nessuno.
    h.state.erroriTabella = { pratiche_personale: { code: 'PGRST205', message: 'Could not find the table' } }
    const res = await GET(url())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('PRATICHE_OPERAZIONE_NON_RIUSCITA')
  })
})
