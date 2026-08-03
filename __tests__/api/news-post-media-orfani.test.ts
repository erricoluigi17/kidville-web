import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// LA CREAZIONE DI UNA NEWS POTEVA LASCIARE UNA FOTO PUBBLICA CHE NESSUNA RIGA
// NOMINAVA — cioè irraggiungibile da revoca e oblio, per sempre.
//
// IL DIFETTO (W1-ter, misurato il 2026-08-03). `POST /api/news` promuove i media
// dal bucket privato `news_bozze` a `news` (PUBBLICO, servito senza login) PRIMA
// di inserire la riga, e deve farlo: il contenuto salvato deve citare gli
// indirizzi definitivi. Ma le due vie d'uscita che NON scrivono la riga —
// promozione fallita a metà, e insert rifiutato — rispondevano e basta. I file
// già spostati restavano pubblici, e da quell'istante non esisteva più nessuna
// riga di `news_posts` che li nominasse.
//
// PERCHÉ È GRAVE, ed è la stessa classe di W1/W1-bis presa dalla terza strada.
// Revoca del consenso (`verificaPermanenzaConsenso`), oblio del minore
// (`obliaFotoNewsAlunno`) e cancellazione partono TUTTE dalla riga corrente:
// calcolano i percorsi con `percorsiPubbliciDelPost(post)`. Un file che nessuna
// riga cita non lo raggiunge nessuno dei tre — e nel bucket `news` quel file è
// la foto di un bambino, già servita in chiaro a chiunque ne conosca l'indirizzo.
//
// LA PRIMITIVA ESISTEVA GIÀ (`riportaMediaInBozza`) e la PATCH la chiamava da
// tutte e tre le sue vie d'uscita. Qui non era chiamata da nessuna: una regola
// valida per due rotte scritta in una sola diverge in silenzio — è letteralmente
// la causa radice di questa serie.
//
// SI RIPORTA INDIETRO, NON SI CANCELLA. Il perché sta nella testata di
// `riportaMediaInBozza`: cancellare farebbe salvare, al secondo tentativo,
// l'indirizzo pubblico di un oggetto che non esiste più (la promozione legge
// «not found» come «era già di là»), cioè un'immagine rotta scritta in silenzio.
//
// Le asserzioni sono sulla MUTAZIONE — quali `move()` sono passate e in che verso
// — non sui nomi delle funzioni: un lock sul nome è già stato evaso una volta
// chiamando la funzione e buttandone via il verdetto.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sanificaContenuto: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  alunni: [] as Array<Record<string, unknown>>,
  /** Gli spostamenti visti passare: `da` → `a`. */
  spostamenti: [] as Array<{ da: string; a: string; percorso: string }>,
  /**
   * Quante `move()` sono ANCORA IN CORSO. È la sonda contro il difetto più banale
   * di tutti: sostituire `await riportaMediaInBozza(…)` con `void riportaMediaInBozza(…)`.
   * ESLint resta verde (`void` soddisfa `no-floating-promises`), tsc pure, e su
   * Vercel Functions l'invocazione può essere congelata appena parte la risposta:
   * la `move()` di ritorno non finisce, e resta pubblica la foto di un bambino che
   * nessuna riga nomina.
   */
  moveInVolo: 0,
  /** Il percorso su cui la promozione deve fallire (guasto a metà strada). */
  moveFalliscePer: null as string | null,
  /** Il percorso su cui la promozione deve LANCIARE (guasto di trasporto). */
  moveLanciaPer: null as string | null,
  /** Se valorizzato, anche il RITORNO in sosta fallisce. */
  ritornoFallisce: false,
  insert: null as Record<string, unknown> | null,
  errInsert: null as { code?: string; message: string } | null,
  /** L'insert LANCIA invece di ritornare `{ error }`: guasto di trasporto. */
  insertLancia: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireStaff: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))
vi.mock('@/lib/news/sanitizza', () => ({
  sanificaContenuto: (...a: unknown[]) => h.sanificaContenuto(...a),
}))
vi.mock('@/lib/news/notifiche', () => ({
  notificaNewsPubblicata: (...a: unknown[]) => h.notificaNewsPubblicata(...a),
}))
// Mock PARZIALE: `withRoute` e la redazione restano quelli veri, si osservano solo
// le due funzioni di scrittura. Sostituire l'intero modulo spegnerebbe il wrapper
// che avvolge la route, cioè si collauderebbe un'altra route.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

function makeClient() {
  return {
    from(table: string) {
      const st = { table, op: 'select', payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') return { data: h.alunni, error: null }
        if (st.table === 'news_posts' && st.op === 'insert') {
          // supabase-js NON promette sempre `{ error }`: su un guasto di trasporto
          // la promessa viene RIGETTATA. È la strada che finiva nel `catch` esterno
          // della route, cioè fuori da ogni ramo che rimetteva i media in sosta.
          if (h.insertLancia) throw new TypeError('fetch failed')
          if (h.errInsert) return { data: null, error: h.errInsert }
          return { data: { id: 'post-nuovo', ...(st.payload ?? {}) }, error: null }
        }
        return { data: null, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.or = () => b
      b.not = () => b
      b.limit = () => b
      b.insert = (rec: Record<string, unknown>) => {
        st.op = 'insert'
        st.payload = rec
        h.insert = { ...rec }
        return b
      }
      b.single = async () => risolvi()
      b.maybeSingle = async () => risolvi()
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(risolvi()).then(onF, onR)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        move: async (da: string, _a: string, opz: { destinationBucket: string }) => {
          h.moveInVolo++
          try {
            // IL RITORNO NON È IMMEDIATO, ed è deliberato: `move()` è una chiamata
            // di rete, e un finto che risponde nello stesso tick renderebbe
            // indistinguibile una chiamata ATTESA da una lasciata andare. Con
            // questo ritardo, `void riportaMediaInBozza(…)` al posto di `await`
            // lascia `moveInVolo` a 1 quando la route ha già risposto (lo verifica
            // `chiamaPost`) e non registra in tempo nessuno spostamento.
            await new Promise((r) => setTimeout(r, 0))
            if (h.moveLanciaPer === da && bucket === 'news_bozze') {
              // Trasporto caduto: non si sa nemmeno se il file si sia mosso, e
              // l'elenco dei già promossi NON deve uscire di scena con l'eccezione.
              throw new TypeError('fetch failed')
            }
            h.spostamenti.push({ da: bucket, a: opz.destinationBucket, percorso: da })
            if (h.moveFalliscePer === da && bucket === 'news_bozze') {
              return { data: null, error: { message: 'storage in avaria' } }
            }
            if (h.ritornoFallisce && bucket === 'news') {
              return { data: null, error: { message: 'storage in avaria' } }
            }
            return { data: { path: da }, error: null }
          } finally {
            h.moveInVolo--
          }
        },
        getPublicUrl: (percorso: string) => ({
          data: { publicUrl: `https://xyz.supabase.co/storage/v1/object/public/news/${percorso}` },
        }),
      }),
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { POST as NEWS_POST } from '@/app/api/news/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const A1 = '11111111-1111-4111-8111-111111111111'

// I percorsi stanno sotto l'uuid di CHI HA CARICATO — è `news/upload:POST` a
// scriverli così, prendendo l'utente dal gate — e qui quell'uuid è lo STESSO
// dell'attore, perché è il caso reale: chi crea il post è chi ha appena
// caricato le immagini. Un uploader diverso dall'attore non è «un dettaglio
// della fixture»: è lo scenario dell'ADOZIONE del file di un altro, che ha i
// suoi test e finisce 403 — qui renderebbe irraggiungibile tutto il resto.
const P_COPERTINA = 'uploads/admin-1/1800-copertina.jpg'
const P_TESTO = 'uploads/admin-1/1800-nel-testo.png'

/** L'anteprima firmata di un media ancora in sosta nel bucket PRIVATO. */
const inSosta = (p: string) => `https://xyz.supabase.co/storage/v1/object/sign/news_bozze/${p}?token=abc`
/** L'indirizzo che la riga porta dopo la promozione: bucket PUBBLICO. */
const pubblico = (p: string) => `https://xyz.supabase.co/storage/v1/object/public/news/${p}`

const req = (body: unknown) =>
  ({
    url: 'http://test/api/news',
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
    cookies: { get: () => undefined },
  }) as never

const promossi = () =>
  h.spostamenti.filter((s) => s.da === 'news_bozze' && s.a === 'news').map((s) => s.percorso)
const riportatiInSosta = () =>
  h.spostamenti.filter((s) => s.da === 'news' && s.a === 'news_bozze').map((s) => s.percorso)

/**
 * Chiama la route e verifica SUBITO che non sia rimasto niente in volo.
 *
 * «Subito» è tutto il punto: un `afterEach` non servirebbe, perché fra la fine del
 * corpo del test e l'hook passano dei tick e una `move()` lasciata andare avrebbe
 * tutto il tempo di finire. Qui invece si guarda l'istante esatto in cui la route
 * ha risposto — che su Vercel Functions è l'istante in cui l'invocazione può
 * essere congelata.
 */
async function chiamaPost(body: unknown) {
  const res = await NEWS_POST(req(body))
  expect(
    h.moveInVolo,
    'la route ha risposto mentre uno spostamento di file era ancora in corso: la chiamata a ' +
      '`riportaMediaInBozza` non è attesa (`void` invece di `await`). Su Vercel l’invocazione può ' +
      'essere congelata subito dopo la risposta, e la foto di un bambino resta nel bucket pubblico ' +
      'senza nessuna riga che la nomini',
  ).toBe(0)
  return res
}

/** Corpo con copertina e immagine nel testo, entrambe ancora in sosta. */
const corpoConDueFoto = () => ({
  tipo: 'articolo',
  titolo: 'Festa di fine anno',
  copertina_url: inSosta(P_COPERTINA),
  contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: inSosta(P_TESTO) } }] },
  bambini_ritratti: [A1],
})

/**
 * UNA FOTO SOLA — la copertina, niente rich-text.
 *
 * Non è una variante per completezza: tutti i casi di questo file passano da due
 * media, e `riportaMediaInBozza` cicla su un ELENCO. Un difetto che vive nel ramo
 * senza ciclo — un `[0]` al posto della lista, un `for` che parte da 1, un
 * `.slice(1)` — resterebbe verde su ogni caso a due foto e in produzione lascerebbe
 * pubblica la foto di un bambino nel caso PIÙ comune, che è l'articolo con la sola
 * copertina.
 */
const corpoConUnaFotoSola = () => ({
  tipo: 'articolo',
  titolo: 'Festa di fine anno',
  copertina_url: inSosta(P_COPERTINA),
  contenuto_json: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  bambini_ritratti: [A1],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
  h.spostamenti = []
  h.moveInVolo = 0
  h.moveFalliscePer = null
  h.moveLanciaPer = null
  h.ritornoFallisce = false
  h.insert = null
  h.errInsert = null
  h.insertLancia = false
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
})

describe('POST /api/news — nessun file pubblico che nessuna riga nomina (W1-ter)', () => {
  it('PROMOZIONE fallita a metà → il file già spostato torna in sosta, e 503', async () => {
    // È il ramo PIÙ probabile di tutti: un guasto dello Storage dentro una
    // richiesta che sta già facendo Storage. La copertina è appena diventata
    // pubblica quando l'immagine del testo non ce la fa; la riga non si scriverà.
    h.moveFalliscePer = P_TESTO
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(503)
    expect(h.insert, 'la riga è stata scritta nonostante la promozione fallita').toBeNull()
    // Controllo POSITIVO: la prima promozione era davvero avvenuta. Senza,
    // «è tornato indietro» sarebbe verde anche se non fosse mai andato avanti.
    expect(promossi()).toEqual([P_COPERTINA, P_TESTO])
    expect(
      riportatiInSosta(),
      'il file promosso è rimasto nel bucket pubblico e nessuna riga lo nomina: ' +
        'revoca e oblio partono dalla riga, quindi non ci arriveranno mai',
    ).toEqual([P_COPERTINA])
  })

  it('INSERT rifiutato → TUTTI i media appena promossi tornano nel bucket privato', async () => {
    h.errInsert = { code: '23514', message: 'violazione di vincolo' }
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(500)
    // Due file, non uno: con un solo media «torna indietro il primo» e «tornano
    // indietro tutti» avrebbero lo stesso colore, e il secondo resterebbe
    // pubblico per sempre dopo ogni insert rifiutato.
    expect(promossi().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
    expect(riportatiInSosta().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
  })

  it('SCHEMA ASSENTE (DB E2E della CI non migrato) → i media tornano lo stesso in sosta', async () => {
    // Non è un caso di scuola: sull'ambiente della CI questa è la via d'uscita
    // NORMALE. Mettere il ritorno in sosta dopo il controllo su `schemaAssente`
    // avrebbe lasciato scoperto proprio il ramo che si percorre più spesso.
    h.errInsert = { code: 'PGRST204', message: "Could not find the 'tipo' column of 'news_posts'" }
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ disponibile: false })
    expect(riportatiInSosta().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
  })

  it('CONTROLLO POSITIVO — creazione riuscita → nessun file torna indietro', async () => {
    // Senza questo, «torna indietro quando serve» sarebbe verde anche in una
    // route che riporta in bozza SEMPRE, cioè che non pubblica più niente.
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(201)
    expect(riportatiInSosta()).toEqual([])
    expect(h.insert?.copertina_url).toBe(pubblico(P_COPERTINA))
    expect(JSON.stringify(h.insert?.contenuto_json)).toContain(pubblico(P_TESTO))
  })

  it('post SENZA media in sosta → lo Storage non viene sfiorato in nessuna direzione', async () => {
    // Il ritorno in sosta non deve diventare un gesto che parte comunque: su un
    // insert rifiutato senza niente da riportare, una `move()` di troppo sarebbe
    // una richiesta allo Storage su un percorso che non esiste.
    h.errInsert = { code: '23514', message: 'violazione di vincolo' }
    const res = await chiamaPost({ tipo: 'breve', titolo: 'Solo testo' })

    expect(res.status).toBe(500)
    expect(h.spostamenti).toEqual([])
  })

  it('nemmeno il RITORNO riesce → il file resta pubblico, e una riga di `error` lo dice', async () => {
    // Qui non c'è niente di meglio da fare che gridare: un file pubblico che
    // nessuna riga nomina è ripulibile solo da chi legge i log. Un guasto che
    // tace è esattamente ciò che questa catena esiste per impedire — ed è già
    // costato a questo repo mesi di email mai arrivate.
    h.errInsert = { code: '23514', message: 'violazione di vincolo' }
    h.ritornoFallisce = true
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(500)
    // Il tentativo c'è stato su entrambi (il controllo positivo del ramo)…
    expect(riportatiInSosta().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
    // …ed è fallito rumorosamente, a livello `error` e col conteggio.
    const grido = h.logEvento.mock.calls.find(
      (c) => c[1] === 'error' && (c[2] as Record<string, unknown>)?.esito === 'media-rimasti-pubblici',
    )
    expect(
      grido,
      'due foto sono rimaste nel bucket pubblico senza nessuna riga che le nomini, e nei log ' +
        'non c’è niente che lo dica: nessuno potrà mai ripulirle',
    ).toBeTruthy()
    expect((grido![2] as Record<string, unknown>).n_file).toBe(2)
    // Il corpo dell'errore dello Storage non si butta via: uno status da solo non
    // dice a nessuno PERCHÉ la foto di un bambino è rimasta pubblica.
    expect(h.logErrore).toHaveBeenCalled()
  })
})

// =============================================================================
// LA QUARTA VIA D'USCITA: L'ECCEZIONE (W1-quater, 2026-08-03).
//
// I sei casi qui sopra coprono le vie d'uscita che passano da un `if`. Ne restava
// una che non passa da nessuno: un'eccezione fra la promozione e la scrittura
// della riga. Il `catch` esterno della route rispondeva 500 e non rimetteva in
// sosta niente — cioè il difetto W1-ter intatto, sulla strada che nessuno guarda.
//
// NON È TEORICA, e le due strade sono corte:
//  · `sanificaContenuto` gira su un JSON che arriva dal CLIENT ed è chiamata DOPO
//    la promozione. Un nodo inatteso e la funzione lancia;
//  · supabase-js può RIGETTARE invece di ritornare `{ error }` (guasto di
//    trasporto). Lo sa già `riportaMediaInBozza`, che ha un `catch` apposta.
// In entrambi i casi il file promosso resta nel bucket `news`, che è pubblico, e
// nessuna riga di `news_posts` lo nomina.
//
// LE ASSERZIONI SONO IN COPPIA: prima il controllo POSITIVO — la promozione era
// davvero avvenuta — e poi l'uguaglianza fra ciò che è uscito e ciò che è
// rientrato. Senza il primo, «è tornato indietro tutto» sarebbe verde anche in una
// route che non promuove più niente.
// =============================================================================

describe('POST /api/news — un’ECCEZIONE non lascia file pubblici orfani (W1-quater)', () => {
  it('la SANIFICAZIONE lancia dopo la promozione → tutti i media tornano in sosta', async () => {
    h.sanificaContenuto.mockImplementation(() => {
      throw new TypeError('nodo inatteso')
    })
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(500)
    expect(h.insert, 'la riga non esiste, quindi non nomina i file appena promossi').toBeNull()
    expect(promossi().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
    expect(
      riportatiInSosta().slice().sort(),
      'un’eccezione fra promozione e scrittura ha lasciato le foto nel bucket pubblico senza ' +
        'nessuna riga che le nomini: revoca e oblio partono dalla riga, quindi non ci arriveranno mai',
    ).toEqual(promossi().slice().sort())
  })

  it('UNA foto sola: la sanificazione lancia → torna in sosta lo stesso (il ramo senza ciclo)', async () => {
    // Il caso che la sonda usa-e-getta del 2026-08-03 copriva e che si è perso
    // quando è stata cancellata. Tutti gli altri casi di questo file promuovono DUE
    // media, quindi esercitano `riportaMediaInBozza` col ciclo pieno: un difetto nel
    // ramo a un elemento solo passerebbe inosservato — ed è il caso più comune in
    // produzione, l'articolo con la sola copertina.
    h.sanificaContenuto.mockImplementation(() => {
      throw new TypeError('nodo inatteso')
    })
    const res = await chiamaPost(corpoConUnaFotoSola())

    expect(res.status).toBe(500)
    expect(h.insert).toBeNull()
    // Controllo POSITIVO: la promozione era davvero avvenuta, ed era di UNO.
    expect(promossi()).toEqual([P_COPERTINA])
    expect(
      riportatiInSosta(),
      'con un media solo il ritorno in sosta non è partito: la copertina resta nel bucket ' +
        'pubblico senza nessuna riga che la nomini, irraggiungibile da revoca e oblio',
    ).toEqual([P_COPERTINA])
  })

  it('l’INSERT LANCIA (guasto di trasporto) → tutti i media tornano in sosta', async () => {
    // supabase-js non promette sempre `{ error }`: quando il fetch cade, rigetta.
    // È la stessa via d'uscita di sopra presa dal punto in cui il repo si fida di
    // più — «PostgREST non lancia» vale per gli errori del DATABASE, non per il
    // trasporto che ci arriva.
    h.insertLancia = true
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(500)
    expect(promossi().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
    expect(riportatiInSosta().slice().sort()).toEqual(promossi().slice().sort())
  })

  it('la PROMOZIONE stessa lancia a metà → il file già spostato torna indietro lo stesso', async () => {
    // L'eccezione qui è la più insidiosa delle tre: uscendo da `promuoviMediaBozza`
    // si porterebbe via `promossiPercorsi`, cioè l'unico elenco da cui si sa che
    // cosa è appena diventato pubblico. Il `catch` della route, con l'elenco
    // ancora vuoto, non avrebbe niente da rimettere in sosta.
    h.moveLanciaPer = P_TESTO
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(503)
    expect(h.insert).toBeNull()
    expect(promossi(), 'la copertina non risulta promossa: lo scenario non è quello previsto').toEqual([
      P_COPERTINA,
    ])
    expect(
      riportatiInSosta(),
      'il trasporto è caduto a metà promozione e la copertina è rimasta pubblica senza padrone',
    ).toEqual([P_COPERTINA])
  })

  it('CONTROLLO POSITIVO — l’eccezione arriva DOPO la riga: non si annulla niente', async () => {
    // È l'asserzione che tiene onesto il resto. Se il ritorno in sosta partisse da
    // OGNI eccezione, un guasto della notifica push — che arriva quando la riga è
    // già scritta e nomina già quei file — riporterebbe le immagini nel bucket
    // privato e lascerebbe l'articolo appena pubblicato con le foto rotte. Il
    // punto in cui l'elenco si azzera è quindi parte della correzione, non un
    // dettaglio: questo test è rosso se lo si sposta anche solo di una riga.
    h.notificaNewsPubblicata.mockRejectedValue(new Error('push non raggiungibile'))
    const res = await chiamaPost({ ...corpoConDueFoto(), stato: 'pubblicata' })

    expect(res.status).toBe(500)
    expect(h.insert, 'la riga non è stata scritta: lo scenario non è quello previsto').toBeTruthy()
    expect(h.insert?.copertina_url).toBe(pubblico(P_COPERTINA))
    expect(
      riportatiInSosta(),
      'la riga nomina già quelle immagini e sono state rimesse nel bucket privato: l’articolo ' +
        'pubblicato è rimasto con le foto rotte',
    ).toEqual([])
  })
})

// =============================================================================
// IL PASSO 1 DELL'ATTACCO, CHIUSO ANCHE SULLA CREAZIONE (giro 2, 2026-08-03).
//
// La difesa contro l'ADOZIONE del file di un altro era stata scritta sulla sola
// `PATCH` — e la PATCH è la strada lunga. Su questa rotta non c'era niente:
// bastava creare il post con l'indirizzo già dentro per ottenere lo stesso
// risultato senza incontrare nessun controllo. Il test dell'esecutore del giro 1
// lo dava per scontato con un commento — «Il passo 1 è già avvenuto» — e nessuno
// verificava COME fosse avvenuto.
//
// Da qui in poi tutto il resto segue: la riga nomina il file di un altro, e alla
// modifica successiva quel percorso finisce dentro una `remove()` in service-role.
// Chiuderlo qui è la difesa complementare, non un doppione: la `DELETE` e il
// ritiro non hanno nessun corpo da validare.
//
// DUE BUCKET, e il secondo è peggio del primo. Sul pubblico si arriva a cancellare
// il file di un altro; sull'area di SOSTA privata si arriva a PUBBLICARLO, con una
// `move()` in service-role su una foto che sta lì proprio perché nessuno ne ha
// ancora verificato il consenso.
// =============================================================================

describe('POST /api/news — un post non NASCE adottando il file di un altro', () => {
  const P_VITTIMA = 'uploads/staff-vittima/1700-vittima.jpg'

  const corpoBase = () => ({ tipo: 'articolo', titolo: 'Festa di fine anno', bambini_ritratti: [A1] })

  it('l’indirizzo pubblico di un altro articolo come COPERTINA → 403', async () => {
    const res = await chiamaPost({ ...corpoBase(), copertina_url: pubblico(P_VITTIMA) })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'NEWS_MEDIA_ESTRANEO' })
    expect(h.insert, 'la riga è nata nominando il file di un altro post').toBeNull()
    expect(h.spostamenti, 'lo Storage è stato toccato da una creazione rifiutata').toEqual([])
  })

  it('stesso rifiuto se arriva dentro il RICH-TEXT', async () => {
    const res = await chiamaPost({
      ...corpoBase(),
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_VITTIMA) } }] },
    })

    expect(res.status).toBe(403)
    expect(h.insert).toBeNull()
  })

  it('l’AREA DI SOSTA privata di un altro operatore → 403, e nessuna `move()`', async () => {
    // Qui il rifiuto vale ancora di più: senza, la promozione avrebbe spostato nel
    // bucket PUBBLICO un file che un altro operatore aveva caricato e mai salvato.
    const res = await chiamaPost({ ...corpoBase(), copertina_url: inSosta(P_VITTIMA) })

    expect(res.status).toBe(403)
    expect(
      h.spostamenti,
      'il file privato di un altro operatore è stato reso pubblico da una creazione altrui',
    ).toEqual([])
    expect(h.insert).toBeNull()
  })

  it('CONTROLLO POSITIVO — la propria area di sosta si usa come sempre', async () => {
    // Senza questo, «rifiuta i file altrui» sarebbe verde anche in una rotta che
    // rifiuta TUTTI i media, cioè che non pubblica più nessuna foto.
    const res = await chiamaPost(corpoConDueFoto())

    expect(res.status).toBe(201)
    expect(promossi().slice().sort()).toEqual([P_COPERTINA, P_TESTO].sort())
  })

  it('CONTROLLO POSITIVO — un indirizzo già pubblico caricato DA CHI SCRIVE passa', async () => {
    // Finché la migrazione di `news_bozze` non è applicata, `news/upload:POST`
    // ricade sul bucket pubblico e restituisce già un indirizzo pubblico: senza
    // questo ramo, su quegli ambienti nessuno potrebbe più creare un post con una
    // foto.
    const mio = `uploads/${'admin-1'}/1900-appena-caricata.jpg`
    const res = await chiamaPost({ ...corpoBase(), copertina_url: pubblico(mio) })

    expect(res.status).toBe(201)
    expect(h.insert?.copertina_url).toBe(pubblico(mio))
  })

  it('un indirizzo che non è di questi bucket non è affare di questa regola', () => {
    // Un embed Instagram non è un oggetto dello Storage e nessuna `remove()` potrà
    // mai raggiungerlo: rifiutarlo sarebbe rumore che non protegge niente.
    return chiamaPost({ ...corpoBase(), copertina_url: 'https://www.instagram.com/p/abc/' }).then(
      async (res) => {
        expect(res.status).toBe(201)
      },
    )
  })

  it('il codice del rifiuto è dichiarato e tradotto in ENTRAMBE le lingue', () => {
    const chiave = CODICI_ERRORE.NEWS_MEDIA_ESTRANEO
    expect(chiave, 'il codice non è dichiarato in CODICI_ERRORE').toBeTruthy()
    expect((itShared as Record<string, string>)[chiave]).toBeTruthy()
    expect((enShared as Record<string, string>)[chiave]).toBeTruthy()
  })
})
