import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../../fixtures/sedi'

// =============================================================================
// IL DIGEST NON DEVE MENTIRE (rilievi T17-F4 e T17-F5 parte 1).
//
// T17-F4 — misurato dalla sonda del collaudo: con un errore PostgREST sulla
// tabella `utenti`, l'esito era letteralmente
//   generata true · inviata true · destinatari_count 0 · errori_count 0
// con ZERO email partite e ZERO log d'errore, e l'UPDATE di `inviata_il` partiva
// lo stesso. Al giro successivo l'edizione non ripartiva: persa per sempre.
// La causa: `emailFamiglie` ritornava un elenco vuoto sia per «questa sede non ha
// famiglie» sia per «non ho potuto leggere», e senza un log (AGENTS regola 7:
// PostgREST non lancia, il valore di ritorno va controllato; regola 6: un catch
// che non logga è un bug).
//
// La regola di marcatura è la stessa già scritta e provata in
// `src/app/api/push/dispatch/route.ts` (~281): se non si è potuto nemmeno
// tentare, NON si marca — la riga torna in coda e riparte al giro dopo.
//
// T17-F5 parte 1 — il tipo di notifica `news` esiste (src/lib/notifiche/tipi.ts)
// e il gate `isNotificaAbilitata` esiste (src/lib/notifiche/config.ts) con nove
// chiamanti: il digest non era fra loro. Un admin che spegneva «News della
// scuola» continuava a far partire il digest a tutte le famiglie.
//
// I test sono di COMPORTAMENTO: guardano le email davvero partite e le SCRITTURE
// davvero finite nel finto database, non il fatto che una funzione sia chiamata.
// =============================================================================

const logEvento = vi.fn()
const logErrore = vi.fn()
const sendEmailDetailed = vi.fn(async (p: { to: string }) => ({ ok: true, error: null, to: p.to }))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: (p: { to: string }) => sendEmailDetailed(p),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import { generaEInviaDigest } from '@/lib/news/digest'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const PUBBLICATA = '2026-06-15T10:00:00.000Z'

/** Una sede reale, un post pubblicato a giugno, una famiglia raggiungibile. */
function dbBase(): DBFinto {
  return {
    scuole: [{ id: SEDE_A, nome: NOME_SEDE_A, attiva: true }],
    news_posts: [
      {
        id: 'p-a', titolo: 'Gita al parco', stato: 'pubblicata', pinned: false,
        pubblicata_il: PUBBLICATA, scuola_id: SEDE_A, target_scope: 'globale', contenuto_testo: 'x',
      },
    ],
    news_digest_edizioni: [],
    // `stato` esplicito: `genitoriDiScuola` legge i soli iscritti dal 2026-08-12.
    alunni: [{ id: 'al-a', scuola_id: SEDE_A, stato: 'iscritto' }],
    utenti: [{ id: 'gen-al-a', email: 'a@example.test' }],
    admin_settings: [],
  }
}

const updatesEdizioni = (scritture: Scrittura[]) =>
  scritture.filter((s) => s.tabella === 'news_digest_edizioni' && s.operazione === 'update')

const logConEsito = (esito: string) =>
  logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  invalidateNotificheConfigCache()
})

describe('T17-F4 — destinatari illeggibili: si RIMANDA, non si mente', () => {
  it('errore sulla tabella utenti ⇒ nessuna email, nessun UPDATE, edizione non inviata', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const supabase = creaFintoSupabase(db, [], {
      errori: { utenti: { code: 'PGRST301', message: 'JWT expired' } },
      scritture,
    })

    const { edizioni } = await generaEInviaDigest(supabase, { anno: 2026, mese: 6, scuolaId: SEDE_A })

    // (a) nessuna email è partita
    expect(sendEmailDetailed).not.toHaveBeenCalled()
    // (b) NESSUN update su news_digest_edizioni fra le scritture (oggi ce n'è uno)
    expect(updatesEdizioni(scritture)).toEqual([])
    // (c) l'edizione risulta NON inviata, nell'esito e nel database
    expect(edizioni).toHaveLength(1)
    expect(edizioni[0].generata).toBe(true)
    expect(edizioni[0].inviata).toBe(false)
    expect(edizioni[0].destinatari_count).toBe(0)
    expect(db.news_digest_edizioni[0]?.inviata_il ?? null).toBeNull()
  })

  it('il guasto viene DETTO: un log di livello error con il codice PostgREST', async () => {
    const db = dbBase()
    const supabase = creaFintoSupabase(db, [], {
      errori: { utenti: { code: 'PGRST301', message: 'JWT expired' } },
    })

    await generaEInviaDigest(supabase, { anno: 2026, mese: 6, scuolaId: SEDE_A })

    const errori = logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori.length).toBeGreaterThan(0)
    // Il corpo dell'errore del provider/DB non si butta via (AGENTS §3).
    const conCorpo = errori.filter((c) => (c[3] as { code?: string } | undefined)?.code === 'PGRST301')
    expect(conCorpo.length).toBeGreaterThan(0)
    // E l'esito «rimandata» dice che l'edizione è rimasta in coda.
    expect(logConEsito('rimandata').length).toBeGreaterThan(0)
  })

  it('SECONDO GIRO con il database sano, STESSO db ⇒ le email partono davvero', async () => {
    const db = dbBase()

    // Primo giro: `utenti` illeggibile.
    await generaEInviaDigest(
      creaFintoSupabase(db, [], { errori: { utenti: { code: 'PGRST301', message: 'JWT expired' } } }),
      { anno: 2026, mese: 6, scuolaId: SEDE_A },
    )
    expect(sendEmailDetailed).not.toHaveBeenCalled()

    // Secondo giro: nessun errore iniettato, stesso oggetto `db`.
    const scritture: Scrittura[] = []
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, [], { scritture }), {
      anno: 2026, mese: 6, scuolaId: SEDE_A,
    })

    // Questo è il punto che cade se qualcuno «ripara» smettendo di GENERARE
    // l'edizione invece di rimandarne l'invio: l'edizione deve ripartire.
    expect(sendEmailDetailed.mock.calls.map((c) => c[0].to)).toEqual(['a@example.test'])
    expect(edizioni[0].inviata).toBe(true)
    expect(edizioni[0].destinatari_count).toBe(1)
    expect(updatesEdizioni(scritture)).toHaveLength(1)
    expect(db.news_digest_edizioni[0]?.inviata_il).toBeTruthy()
  })

  it('sede senza nemmeno una famiglia ⇒ si marca inviata (niente da riprovare)', async () => {
    const db = dbBase()
    db.alunni = []
    const scritture: Scrittura[] = []
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, [], { scritture }), {
      anno: 2026, mese: 6, scuolaId: SEDE_A,
    })

    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(edizioni[0].inviata).toBe(true)
    expect(edizioni[0].destinatari_count).toBe(0)
    expect(updatesEdizioni(scritture)).toHaveLength(1)
  })

  it('errore sulla tabella alunni ⇒ anche lì si rimanda, non si marca', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const { edizioni } = await generaEInviaDigest(
      creaFintoSupabase(db, [], { errori: { alunni: { code: '42703', message: 'column does not exist' } }, scritture }),
      { anno: 2026, mese: 6, scuolaId: SEDE_A },
    )

    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(updatesEdizioni(scritture)).toEqual([])
    expect(edizioni[0].inviata).toBe(false)
    expect(db.news_digest_edizioni[0]?.inviata_il ?? null).toBeNull()
  })
})

// =============================================================================
// LA SONDA DEI DESTINATARI CONTA GLI STESSI BAMBINI CHE `genitoriDiScuola` LEGGE
//
// Quando i genitori sono zero, `emailFamiglie` RILEGGE il numero di alunni della
// sede per distinguere «questa sede non ha famiglie» da «non ho potuto leggere».
// Dal 2026-08-12 `genitoriDiScuola` legge i soli ISCRITTI: se la sonda contasse
// anche gli archiviati, i due numeri smetterebbero di essere confrontabili e una
// sede rimasta senza bambini in corso produrrebbe «alunni ce ne sono, genitori
// collegati no» — un warn che accusa i legami di un guasto inesistente e manda a
// cercare il difetto dalla parte sbagliata.
// =============================================================================
describe('destinatari — la sonda conta gli ISCRITTI, come chi risolve i genitori', () => {
  const logConEsitoLocale = (esito: string) =>
    logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

  it('sede con SOLI archiviati ⇒ nessuna email e NESSUN allarme sui legami', async () => {
    const db = dbBase()
    db.alunni = [{ id: 'al-rit', scuola_id: SEDE_A, stato: 'ritirato' }]
    db.utenti = []
    await generaEInviaDigest(creaFintoSupabase(db, []), { anno: 2026, mese: 6, scuolaId: SEDE_A })

    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(logConEsitoLocale('nessun-genitore-collegato')).toEqual([])
  })

  it('CONTROLLO OPPOSTO — bambini iscritti e legami VUOTI ⇒ il warn c’è davvero', async () => {
    // Senza questo, il test qui sopra sarebbe verde anche se il ramo del warn
    // fosse stato cancellato del tutto — ed è il ramo che dice a chi guarda i log
    // «i bambini ci sono, i tutori a sistema no».
    //
    // Il caso si costruisce svuotando la risoluzione dei LEGAMI, non l'anagrafica:
    // con le due query ora coerenti (leggono entrambe i soli iscritti) è rimasto
    // l'unico modo di avere zero genitori con alunni presenti — che è poi il solo
    // significato che quel warn ha mai avuto.
    const legami = await import('@/lib/anagrafiche/legami')
    vi.mocked(legami.getGenitoriDiAlunni).mockResolvedValueOnce(new Map())
    const db = dbBase()
    db.alunni = [{ id: 'al-solo', scuola_id: SEDE_A, stato: 'iscritto' }]
    await generaEInviaDigest(creaFintoSupabase(db, []), { anno: 2026, mese: 6, scuolaId: SEDE_A })

    const righe = logConEsitoLocale('nessun-genitore-collegato')
    expect(righe).toHaveLength(1)
    // Il conteggio che finisce nel log è quello degli ISCRITTI: è il numero su cui
    // qualcuno deciderà se cercare un guasto o alzare le spalle.
    expect((righe[0][2] as { alunni?: number }).alunni).toBe(1)
  })
})

describe('T17-F5 parte 1 — il digest obbedisce all\'interruttore «News della scuola»', () => {
  it('toggle news = false ⇒ nessuna email e edizione NON marcata inviata', async () => {
    const db = dbBase()
    db.admin_settings = [{ scuola_id: SEDE_A, notifiche_config: { toggles: { news: false } } }]
    const scritture: Scrittura[] = []

    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, [], { scritture }), {
      anno: 2026, mese: 6, scuolaId: SEDE_A,
    })

    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(updatesEdizioni(scritture)).toEqual([])
    expect(edizioni[0].inviata).toBe(false)
    expect(db.news_digest_edizioni[0]?.inviata_il ?? null).toBeNull()
    expect(logConEsito('tipo-disattivato').length).toBe(1)
  })

  it('toggle riacceso al giro dopo ⇒ l\'edizione riparte e le email partono', async () => {
    const db = dbBase()
    db.admin_settings = [{ scuola_id: SEDE_A, notifiche_config: { toggles: { news: false } } }]
    await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6, scuolaId: SEDE_A })
    expect(sendEmailDetailed).not.toHaveBeenCalled()

    db.admin_settings = [{ scuola_id: SEDE_A, notifiche_config: { toggles: { news: true } } }]
    invalidateNotificheConfigCache()
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6, scuolaId: SEDE_A })

    expect(sendEmailDetailed.mock.calls.map((c) => c[0].to)).toEqual(['a@example.test'])
    expect(edizioni[0].inviata).toBe(true)
  })

  it('nessun toggle impostato ⇒ invio normale (fail-open, comportamento invariato)', async () => {
    const db = dbBase()
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6, scuolaId: SEDE_A })

    expect(sendEmailDetailed.mock.calls.map((c) => c[0].to)).toEqual(['a@example.test'])
    expect(edizioni[0].inviata).toBe(true)
    expect(logConEsito('tipo-disattivato')).toEqual([])
  })

  it('un altro tipo spento non tocca il digest', async () => {
    const db = dbBase()
    db.admin_settings = [{ scuola_id: SEDE_A, notifiche_config: { toggles: { galleria: false } } }]
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6, scuolaId: SEDE_A })

    expect(sendEmailDetailed).toHaveBeenCalledTimes(1)
    expect(edizioni[0].inviata).toBe(true)
  })
})
