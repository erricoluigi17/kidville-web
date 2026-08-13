import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

/**
 * I RISOLUTORI DI DESTINATARI, DAVANTI A «NON SO QUALE SEDE».
 *
 * Audit 2026-07-31 (F6). Tre difetti nello stesso file, tutti della stessa
 * famiglia — il ramo «nessun destinatario» non lascia traccia:
 *
 *  1. `staffScuola(null)` esce alla PRIMA riga, PRIMA di tutta la strumentazione
 *     della funzione: sette catene `X ?? Y ?? scuolaUnicaReale()` finivano lì e
 *     nei log «non so a quale sede appartiene» e «avvisati tutti» si leggevano
 *     identici;
 *  2. `genitoriDiClassi` senza sede NON filtrava («se ho lo scope filtro,
 *     altrimenti no»: la forma fail-open che la regola vieta), mentre la gemella
 *     `genitoriDiScuola` negava — due semantiche opposte per lo stesso null;
 *  3. gli errori PostgREST venivano ignorati (`const { data } = await q`) e i
 *     `catch` erano muti: una query rotta si travestiva da «zero destinatari».
 *
 * Qui il finto client FILTRA davvero: «i genitori della sede A» è una proprietà
 * verificata, non asserita.
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

// I genitori di un alunno: `gen-<id alunno>`. Così la lista dei destinatari dice
// da quali BAMBINI è stata derivata, ed è leggibile nelle asserzioni.
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import {
  staffScuola,
  genitoriDiClassi,
  genitoriDiScuola,
  scuolaUnicaReale,
  controparteThread,
} from '@/lib/notifiche/destinatari'

const RUOLI = ['admin', 'coordinator', 'segreteria']

/** Due bambini nella classe «2 ANNI», uno per sede: il nome-classe è omonimo. */
function dbConDueSedi(): DBFinto {
  return {
    alunni: [
      // `stato` esplicito: dal 2026-08-12 i due risolutori leggono i soli
      // iscritti, e una fixture che tacesse lo stato descriverebbe due bambini
      // che nessun avviso raggiunge — cioè non il caso in esame.
      { id: 'al-a', classe_sezione: '2 ANNI', scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-b', classe_sezione: '2 ANNI', scuola_id: SEDE_B, stato: 'iscritto' },
    ],
    utenti: [
      { id: 'segr-a', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'admin-x', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    ],
    utenti_scuole: [{ utente_id: 'admin-x', scuola_id: SEDE_B }],
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => logEvento.mockClear())

describe('staffScuola — sede non risolta', () => {
  it('sede null ⇒ [] E LO DICE (livello error): è il ramo che rendeva mute 7 catene', async () => {
    const db = dbConDueSedi()
    const letture: string[] = []
    const ids = await staffScuola(creaFintoSupabase(db, letture), null, RUOLI)

    expect(ids).toEqual([])
    // Nessuna query: si nega prima di leggere.
    expect(letture).toEqual([])
    const riga = logDi('sede-non-risolta')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('error')
    // Mai PII nei log.
    expect(JSON.stringify(riga?.[2])).not.toMatch(/@/)
  })

  it('elenco ruoli vuoto ⇒ [] e una riga di log distinta (è un errore di programmazione)', async () => {
    const ids = await staffScuola(creaFintoSupabase(dbConDueSedi()), SEDE_A, [])
    expect(ids).toEqual([])
    expect(logDi('ruoli-non-indicati')).toBeDefined()
  })

  it('la sede la trova comunque dal ponte (regressione 2026-07-29, con un client che FILTRA)', async () => {
    const ids = await staffScuola(creaFintoSupabase(dbConDueSedi()), SEDE_B, RUOLI)
    // `admin-x` ha come sede primaria la A: sulla B ci arriva solo da `utenti_scuole`.
    expect(ids).toEqual(['admin-x'])
  })
})

describe('genitoriDiClassi — scope vuoto ⇒ nega', () => {
  it('sede nota ⇒ SOLO i genitori di quella sede (il nome-classe è omonimo)', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), SEDE_A, ['2 ANNI'])
    expect(out).toEqual(['gen-al-a'])
  })

  it('sede assente ⇒ [] + warn, NON «tutte le sedi» per omissione', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), null, ['2 ANNI'])
    expect(out).toEqual([])
    const riga = logDi('sede-non-risolta')
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('warn')
  })

  it('«tutte le sedi» si CHIEDE, e allora arriva davvero a tutte', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), null, ['2 ANNI'], {
      tutteLeSedi: true,
    })
    expect([...out].sort()).toEqual(['gen-al-a', 'gen-al-b'])
    // Scelta esplicita del chiamante: non è un degrado, non si grida.
    expect(logDi('sede-non-risolta')).toBeUndefined()
  })

  it('un ARCHIVIATO nella classe non entra fra i destinatari (2026-08-12)', async () => {
    // La strada normale dell'archiviazione stacca il bambino dalla classe, e
    // allora questa query non lo vedrebbe comunque. Qui si prova l'ALTRA strada,
    // quella che restava scoperta: `stato` portato a `'ritirato'` dalla tendina
    // della scheda alunno, che `classe_sezione` non la tocca. Senza il filtro di
    // stato quel bambino resta agganciato alla sezione e la sua famiglia continua
    // a ricevere gli avvisi di classe.
    const db = dbConDueSedi()
    db.alunni.push({ id: 'al-a-rit', classe_sezione: '2 ANNI', scuola_id: SEDE_A, stato: 'ritirato' })
    const out = await genitoriDiClassi(creaFintoSupabase(db), SEDE_A, ['2 ANNI'])
    expect(out).toEqual(['gen-al-a'])
    expect(out).not.toContain('gen-al-a-rit')
  })

  it('un SOSPESO nella classe RESTA fra i destinatari: frequenta (2026-08-13)', async () => {
    // ⚠️ QUESTO TEST È LA DECISIONE, non il suo commento. Fino al 2026-08-13 i
    // filtri erano `.eq('stato', STATO_ISCRITTO)` in senso stretto: escludevano
    // `'sospeso'`, che `LATO_DEL_CONFINE` classifica «ancora-iscritto». Nessuna
    // asserzione ne parlava, quindi la scelta viveva in due paragrafi di prosa e
    // si poteva ribaltare senza far diventare rosso niente.
    //
    // Il confine è ora `STATI_CON_CANALE_FAMIGLIA`, derivato dallo STESSO
    // `LATO_DEL_CONFINE` che protegge dall'oblio: un bambino che il modulo
    // dichiara «a scuola» non può essere irraggiungibile dai canali del prodotto
    // e insieme protetto dall'anonimizzazione. Un confine solo, non due.
    const db = dbConDueSedi()
    db.alunni.push({ id: 'al-a-sos', classe_sezione: '2 ANNI', scuola_id: SEDE_A, stato: 'sospeso' })
    const out = await genitoriDiClassi(creaFintoSupabase(db), SEDE_A, ['2 ANNI'])
    expect([...out].sort()).toEqual(['gen-al-a', 'gen-al-a-sos'])
  })

  it('query fallita ⇒ [] + error: una lettura rotta non si traveste da «zero destinatari»', async () => {
    const out = await genitoriDiClassi(
      creaFintoSupabase(dbConDueSedi(), [], { errori: { alunni: { code: '42703' } } }),
      SEDE_A,
      ['2 ANNI'],
    )
    expect(out).toEqual([])
    const riga = logDi('alunni-non-letti')
    expect(riga?.[1]).toBe('error')
  })
})

describe('genitoriDiScuola — la gemella, stessa semantica', () => {
  it('sede nota ⇒ i genitori della sola sede', async () => {
    const out = await genitoriDiScuola(creaFintoSupabase(dbConDueSedi()), SEDE_B)
    expect(out).toEqual(['gen-al-b'])
  })

  it('sede assente ⇒ [] + warn (prima taceva)', async () => {
    const out = await genitoriDiScuola(creaFintoSupabase(dbConDueSedi()), null)
    expect(out).toEqual([])
    expect(logDi('sede-non-risolta')?.[1]).toBe('warn')
  })

  it('un ARCHIVIATO della sede non riceve gli avvisi di plesso (2026-08-12)', async () => {
    // È il difetto per cui il filtro è nato. Questa query la CLASSE non la nomina
    // proprio, quindi lo sganciamento — la leva su cui l'archiviazione si regge —
    // qui non arriva: senza `.eq('stato', …)` un avviso «a tutta la sede» sarebbe
    // continuato ad arrivare per sempre ai genitori di chi non frequenta più.
    const db = dbConDueSedi()
    db.alunni.push({ id: 'al-b-rit', classe_sezione: null, scuola_id: SEDE_B, stato: 'ritirato' })
    const out = await genitoriDiScuola(creaFintoSupabase(db), SEDE_B)
    expect(out).toEqual(['gen-al-b'])
  })

  it('un SOSPESO della sede RICEVE gli avvisi di plesso (2026-08-13)', async () => {
    // La gemella del test di `genitoriDiClassi`: la stessa decisione presa una
    // volta sola in `STATI_CON_CANALE_FAMIGLIA` deve valere su tutte e tre le
    // strade, altrimenti «un posto solo» è di nuovo una frase e non un fatto.
    const db = dbConDueSedi()
    db.alunni.push({ id: 'al-b-sos', classe_sezione: null, scuola_id: SEDE_B, stato: 'sospeso' })
    const out = await genitoriDiScuola(creaFintoSupabase(db), SEDE_B)
    expect([...out].sort()).toEqual(['gen-al-b', 'gen-al-b-sos'])
  })

  it('⚠️ lo stato NULL ESCLUDE, e il test è qui per dirlo invece di farlo scoprire', async () => {
    // Questo NON è il comportamento desiderabile: è quello vero, e va nominato.
    // `alunni.stato` è `nullable` con `DEFAULT 'iscritto'` (misurato su
    // `information_schema` il 2026-08-12), e in SQL `NULL = 'iscritto'` non è
    // vero: una riga con lo stato vuoto non torna da questa query, quindi la sua
    // famiglia non riceverebbe gli avvisi di plesso. Il `DEFAULT` protegge gli
    // INSERT, non un `UPDATE ... SET stato = NULL` — e la PATCH di
    // `admin/students` valida quel campo con `z.unknown()`.
    //
    // Perché si lascia così: oggi in produzione le righe con stato NULL sono
    // ZERO (33 alunni, tutti `iscritto`, misurato lo stesso giorno), e nella
    // direzione «chi riceve una comunicazione» un elenco che sbaglia per difetto
    // è meno grave di uno che scrive alla famiglia di un bambino archiviato.
    // Se un giorno comparissero righe NULL, la riparazione è qui e in
    // `genitoriDiClassi`: `.or('stato.eq.iscritto,stato.is.null')`.
    const db = dbConDueSedi()
    db.alunni = [{ id: 'al-muto', classe_sezione: '2 ANNI', scuola_id: SEDE_A }]
    expect(await genitoriDiScuola(creaFintoSupabase(db), SEDE_A)).toEqual([])
  })

  it('query fallita ⇒ [] + error', async () => {
    const out = await genitoriDiScuola(
      creaFintoSupabase(dbConDueSedi(), [], { errori: { alunni: { code: '42703' } } }),
      SEDE_A,
    )
    expect(out).toEqual([])
    expect(logDi('alunni-non-letti')?.[1]).toBe('error')
  })
})

describe('scuolaUnicaReale — la primitiva mono-sede, ora deprecata', () => {
  it('con più sedi reali ⇒ null E una riga di log: il suo esito non è più «normale»', async () => {
    const out = await scuolaUnicaReale(creaFintoSupabase(dbConDueSedi()))
    expect(out).toBeNull()
    const riga = logDi('sede-non-univoca')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('warn')
  })

  it('una sola sede reale (+ la finta E2E) ⇒ quella, senza log di degrado', async () => {
    const db = dbConDueSedi()
    db.schools = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ]
    const out = await scuolaUnicaReale(creaFintoSupabase(db))
    expect(out).toBe(SEDE_A)
    expect(logDi('sede-non-univoca')).toBeUndefined()
  })
})

// =============================================================================
// W9 — `controparteThread`: l'ULTIMO catch muto del file.
//
// Era l'unica funzione che l'audit non aveva toccato: `catch { return null }` e
// la lettura di `chat_threads` senza guardare `{ error }` (PostgREST non lancia).
// Decide CHI riceve la notifica di un messaggio in chat: se fallisce, il
// messaggio viene salvato — 201 — e la notifica non parte. Il `try/catch` del
// chiamante (`chat/messages:POST`) non aiuta: questa funzione non lancia mai,
// quindi quel catch non scatta. Zero righe, e il genitore scopre il messaggio
// solo se apre la chat per caso.
// =============================================================================

describe('controparteThread — chi riceve la notifica di un messaggio', () => {
  const dbChat = (): DBFinto => ({
    chat_threads: [{ id: 'th-1', teacher_id: 'doc-1', parent_id: 'gen-1' }],
  })

  it('dal docente ⇒ il genitore, e viceversa (nessun log: è il percorso felice)', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'doc-1')).toEqual({
      utenteId: 'gen-1',
      versoGenitore: true,
    })
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'gen-1')).toEqual({
      utenteId: 'doc-1',
      versoGenitore: false,
    })
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('errore di lettura ⇒ null MA con una riga `error`: non si finge «nessuna controparte»', async () => {
    const supabase = creaFintoSupabase(dbChat(), [], {
      errori: { chat_threads: { code: '42501', message: 'permission denied' } },
    })
    expect(await controparteThread(supabase, 'th-1', 'doc-1')).toBeNull()
    const riga = logDi('controparte-non-risolta')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('error')
    // L'errore del provider viaggia attaccato: codice e messaggio in tabella.
    expect(riga?.[3]).toMatchObject({ code: '42501' })
  })

  it('thread inesistente ⇒ null e un warn: la notifica non parte, e si sa perché', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-inesistente', 'doc-1')).toBeNull()
    expect(logDi('controparte-thread-assente')?.[1]).toBe('warn')
  })

  it('mittente estraneo al thread ⇒ null e un warn distinto', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'segreteria-9')).toBeNull()
    expect(logDi('controparte-non-nel-thread')?.[1]).toBe('warn')
  })

  it('eccezione vera (rete/DNS) ⇒ null e una riga `error`, mai un catch muto', async () => {
    const supabase = {
      from: () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    } as never
    expect(await controparteThread(supabase, 'th-1', 'doc-1')).toBeNull()
    expect(logDi('controparte-non-risolta')?.[1]).toBe('error')
  })

  it('nessun log porta identificativi in chiaro oltre agli uuid tecnici', async () => {
    await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'segreteria-9')
    for (const c of logEvento.mock.calls) {
      expect(JSON.stringify(c[2])).not.toMatch(/@/)
    }
  })
})
