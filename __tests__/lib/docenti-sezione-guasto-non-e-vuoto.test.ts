import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * `docentiDiSezione` — UN GUASTO NON È UNA SEZIONE SENZA DOCENTI.
 *
 * Il difetto, per otto mesi, stava in una destrutturazione:
 *
 *     const { data } = await supabase.from('utenti_sezioni')…
 *     return (data ?? []).map(r => r.utente_id)
 *
 * `{ error }` veniva buttato via. PostgREST non lancia — ritorna `{ data: null,
 * error }` — quindi una lettura negata dalla RLS, una tabella che il DB E2E non
 * ha, una connessione esaurita producevano ESATTAMENTE lo stesso valore di una
 * sezione a cui nessuno è stato assegnato: `[]`.
 *
 * Non è un dettaglio di osservabilità. Questa funzione è la sorgente dei
 * destinatari di SETTE punti di chiamata — assenze, giustifiche, giustifiche
 * didattiche, firma della pagella, armadietto, mensa, notifiche della primaria —
 * e sotto ci sono `notificaEvento`/`enqueueNotifiche`, che su lista vuota escono
 * con un `warn` «nessun-destinatario». Il genitore comunica l'assenza, la route
 * risponde 200, e la maestra non riceve niente. È il guasto silenzioso nella
 * forma esatta che questo repo ha già pagato con le email di credenziali.
 *
 * Qui si collauda che:
 *  1. l'errore di lettura produce una riga `error` con l'OGGETTO errore intero
 *     (`code`/`details`/`hint`: sono loro a dire PERCHÉ);
 *  2. il filtro sugli utenti attivi non introduce un secondo modo di tacere —
 *     un `attivo` NULL non è un disattivato, e una seconda query rotta degrada
 *     alla lista intera invece che a zero destinatari;
 *  3. i rami legittimi (nessuna sezione, nessun legame) restano muti: un logger
 *     loquace acceca quanto uno muto.
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

// `redact` NON è mockato: è quello vero, e serve a PROVARE — non ad affermare —
// che i campi di queste righe arrivano leggibili anche in tabella.
import { redact } from '@/lib/logging/redact'
import { docentiDiSezione } from '@/lib/sezioni/docenti'

// Uuid veri: la redazione a lista bianca lascia passare in chiaro gli uuid, e
// un test che usa `sez-1` non proverebbe niente su come esce la riga persistita.
const SEZIONE = '11111111-1111-4111-8111-111111111111'
const ALTRA_SEZIONE = '22222222-2222-4222-8222-222222222222'
const MAESTRA_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MAESTRA_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CESSATA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/** Due maestre sulla sezione, una terza su un'altra: il filtro deve tenere. */
function dbConDueMaestre(): DBFinto {
  return {
    utenti_sezioni: [
      { utente_id: MAESTRA_A, section_id: SEZIONE },
      { utente_id: MAESTRA_B, section_id: SEZIONE },
      { utente_id: CESSATA, section_id: ALTRA_SEZIONE },
    ],
    utenti: [
      { id: MAESTRA_A, attivo: true },
      { id: MAESTRA_B, attivo: true },
      { id: CESSATA, attivo: true },
    ],
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => logEvento.mockClear())

describe('docentiDiSezione — il percorso felice resta muto', () => {
  it('restituisce i docenti della sola sezione richiesta, senza una riga di log', async () => {
    const ids = await docentiDiSezione(creaFintoSupabase(dbConDueMaestre()), SEZIONE)
    expect([...ids].sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('sezione senza legami ⇒ [] e nessun log: è una condizione legittima, non un guasto', async () => {
    const db = dbConDueMaestre()
    db.utenti_sezioni = []
    const ids = await docentiDiSezione(creaFintoSupabase(db), SEZIONE)
    expect(ids).toEqual([])
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('sezione non indicata ⇒ [] senza toccare il database e senza log', async () => {
    const letture: string[] = []
    expect(await docentiDiSezione(creaFintoSupabase(dbConDueMaestre(), letture), null)).toEqual([])
    expect(await docentiDiSezione(creaFintoSupabase(dbConDueMaestre(), letture), undefined)).toEqual([])
    expect(letture).toEqual([])
    expect(logEvento).not.toHaveBeenCalled()
  })
})

describe('docentiDiSezione — IL DIFETTO: `{ error }` scartato', () => {
  it('lettura fallita ⇒ [] MA con una riga `error`, non un silenzio identico a «zero docenti»', async () => {
    const supabase = creaFintoSupabase(dbConDueMaestre(), [], {
      errori: { utenti_sezioni: { code: '42501', message: 'permission denied for table utenti_sezioni' } },
    })
    const ids = await docentiDiSezione(supabase, SEZIONE)

    expect(ids).toEqual([])
    const riga = logDi('docenti-non-letti')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    // `error` e non `warn`: nessuno a valle recupera la notifica mai accodata.
    expect(riga?.[1]).toBe('error')
    expect(riga?.[2]).toMatchObject({ operazione: 'sezioni/docenti:docentiDiSezione', sezione_id: SEZIONE })
  })

  it("l'errore viaggia INTERO come 4° argomento: `code`, `details` e `hint` dicono PERCHÉ", async () => {
    const supabase = creaFintoSupabase(dbConDueMaestre(), [], {
      errori: {
        utenti_sezioni: {
          code: '42P01',
          message: 'relation "public.utenti_sezioni" does not exist',
          details: 'schema non migrato',
          hint: 'esegui le migrazioni',
        },
      },
    })
    await docentiDiSezione(supabase, SEZIONE)

    const riga = logDi('docenti-non-letti')
    // Mai `String(e)`: un messaggio senza codice è un `403` senza corpo, cioè niente.
    expect(riga?.[3]).toMatchObject({ code: '42P01', details: 'schema non migrato', hint: 'esegui le migrazioni' })
  })

  it('eccezione vera (rete/DNS) ⇒ [] e una riga `error`, mai un catch muto', async () => {
    const supabase = {
      from: () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    } as never
    expect(await docentiDiSezione(supabase, SEZIONE)).toEqual([])
    expect(logDi('docenti-non-letti')?.[1]).toBe('error')
  })
})

describe('docentiDiSezione — solo gli utenti attivi', () => {
  it('un docente disattivato non è più un destinatario, e lo scarto è contato', async () => {
    const db = dbConDueMaestre()
    db.utenti = [
      { id: MAESTRA_A, attivo: true },
      { id: MAESTRA_B, attivo: false },
    ]
    const ids = await docentiDiSezione(creaFintoSupabase(db), SEZIONE)

    expect(ids).toEqual([MAESTRA_A])
    const riga = logDi('docenti-non-attivi')
    expect(riga).toBeDefined()
    // `warn`: è il comportamento voluto, non un guasto — ma va CONTATO, perché
    // «la maestra non riceve più niente» va spiegato senza aprire il database.
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ n_scartati: 1 })
  })

  it('`attivo` NULL NON è «disattivato»: la colonna è nullable con DEFAULT true', async () => {
    const db = dbConDueMaestre()
    db.utenti = [
      { id: MAESTRA_A, attivo: null },
      { id: MAESTRA_B, attivo: true },
    ]
    const ids = await docentiDiSezione(creaFintoSupabase(db), SEZIONE)
    expect([...ids].sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
    expect(logDi('docenti-non-attivi')).toBeUndefined()
  })

  it('un legame orfano (utente inesistente) viene scartato: sarebbe una FK rotta in `notifiche`', async () => {
    const db = dbConDueMaestre()
    db.utenti = [{ id: MAESTRA_A, attivo: true }]
    expect(await docentiDiSezione(creaFintoSupabase(db), SEZIONE)).toEqual([MAESTRA_A])
    expect(logDi('docenti-non-attivi')?.[2]).toMatchObject({ n_scartati: 1 })
  })

  it('seconda query rotta ⇒ si degrada alla lista INTERA + warn, non a zero destinatari', async () => {
    // La ragione della seconda query invece del join: qui il guasto costa una
    // notifica in più a un docente cessato, non una notifica in meno a tutti.
    const supabase = creaFintoSupabase(dbConDueMaestre(), [], {
      errori: { utenti: { code: '42703', message: 'column utenti.attivo does not exist' } },
    })
    const ids = await docentiDiSezione(supabase, SEZIONE)

    expect([...ids].sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
    const riga = logDi('attivi-non-verificati')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[3]).toMatchObject({ code: '42703' })
  })

  it('`{ soloAttivi: false }` ⇒ nessuna seconda query: la UI di gestione deve vedere anche i cessati', async () => {
    const db = dbConDueMaestre()
    db.utenti = [{ id: MAESTRA_A, attivo: true }, { id: MAESTRA_B, attivo: false }]
    const letture: string[] = []
    const ids = await docentiDiSezione(creaFintoSupabase(db, letture), SEZIONE, { soloAttivi: false })

    expect([...ids].sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
    expect(letture).toEqual(['utenti_sezioni'])
    expect(logEvento).not.toHaveBeenCalled()
  })
})

describe('docentiDiSezione — mai dati personali nei log', () => {
  it('nessuna riga porta email, nomi o testo libero: solo uuid, conteggi e codici', async () => {
    const db = dbConDueMaestre()
    db.utenti = [{ id: MAESTRA_A, attivo: false, nome: 'Maria', cognome: 'Esposito', email: 'maria@kidville.it' }]
    await docentiDiSezione(creaFintoSupabase(db), SEZIONE)
    await docentiDiSezione(
      creaFintoSupabase(db, [], { errori: { utenti_sezioni: { code: '42501' } } }),
      SEZIONE,
    )

    expect(logEvento).toHaveBeenCalled()
    for (const c of logEvento.mock.calls) {
      const campi = JSON.stringify(c[2])
      expect(campi).not.toMatch(/@/)
      expect(campi).not.toMatch(/Maria|Esposito/)
    }
  })

  it('…e sopravvivono alla lista bianca: `sezione_id` e i conteggi restano leggibili in tabella', async () => {
    // La lista bianca di `redact()` è PER CHIAVE: una riga i cui campi escono
    // tutti come `[redatto:str/N]` è una riga che non serve a nessuno. Qui si
    // misura con il `redact` vero invece di fidarsi.
    const db = dbConDueMaestre()
    db.utenti = [{ id: MAESTRA_A, attivo: true }]
    await docentiDiSezione(creaFintoSupabase(db), SEZIONE)

    const riga = logDi('docenti-non-attivi')
    expect(redact(riga?.[2])).toEqual({
      operazione: 'sezioni/docenti:docentiDiSezione',
      esito: 'docenti-non-attivi',
      sezione_id: SEZIONE,
      n: 2,
      n_scartati: 1,
    })
  })
})
