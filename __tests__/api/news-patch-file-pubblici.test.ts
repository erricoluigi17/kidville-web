import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// SOSTITUIRE LA COPERTINA NON TOGLIEVA LA VECCHIA FOTO DAL BUCKET PUBBLICO —
// e da quel momento nessuna riga la nominava più.
//
// IL DIFETTO (collaudo del 2026-08-03, W1). `PATCH /api/news/[id]` scriveva
// `updates.copertina_url = promozione.copertinaUrl ?? null` e non toccava lo
// Storage. La sonda misurava: «PATCH sostituzione — percorsi tolti dal bucket:
// []» e «PATCH azzeramento — percorsi tolti dal bucket: []».
//
// PERCHÉ È GRAVE, e non è «un file di troppo». Il bucket `news` è PUBBLICO e
// servito senza login. Dopo la sostituzione la vecchia immagine resta al suo
// indirizzo — che `/api/news/feed` ha già distribuito in chiaro a chiunque
// leggesse il sito — e non c'è più nessuna riga che la nomini:
// `verificaPermanenzaConsenso`, `obliaFotoNewsAlunno` e la `DELETE` calcolano i
// percorsi da `percorsiPubbliciDelPost(post)`, cioè dalla riga CORRENTE. Quindi
// né la revoca del consenso né il diritto all'oblio possono più arrivarci: la
// foto di quel bambino è pubblica per sempre.
//
// È LA STESSA CLASSE del difetto V4 (la `DELETE` che cancellava la riga e
// lasciava il file), chiuso la mattina dello stesso giorno sulla strada accanto.
// La regola non è riscritta qui: la PATCH chiama la stessa funzione del ritiro e
// della cancellazione (`liberaPercorsiPubblici`). Una regola valida per tre
// strade deve vivere in un posto solo — è la causa radice di tutta la serie.
//
// LE ASSERZIONI SONO SULLA MUTAZIONE, non sui nomi. Un lock che cerca il NOME di
// una funzione è già stato evaso una volta chiamandola e buttando via il
// verdetto (`void gate`): qui si guarda che cosa è finito davvero dentro una
// `remove()` e in che ordine.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  sanificaContenuto: vi.fn(),
  post: null as Record<string, unknown> | null,
  /**
   * Le ALTRE righe di `news_posts`: quelle che possiedono i file. Insieme
   * DIVERSO da `post`, e deve restarlo — «il post che si modifica» e «il post che
   * possiede il file» sono le due grandezze che la regressione confondeva.
   */
  altriPost: [] as Array<Record<string, unknown>>,
  /**
   * Le interrogazioni sulla proprietà viste passare: gli id ESCLUSI e la finestra.
   * Il finto le risolve come il database — applica l'esclusione, ordina per id e
   * taglia la pagina — perché nel giro 1 registrava il filtro e restituiva
   * comunque tutte le righe: con un finto compiacente «cerco nella colonna
   * sbagliata» ha lo stesso colore del codice giusto.
   */
  citazioni: [] as Array<{ esclusi: string[]; da: number; a: number }>,
  /** Guasto di lettura sulla SOLA domanda «di chi è questo file?». */
  erroreCitazioni: null as { code?: string; message: string } | null,
  alunni: [] as Array<Record<string, unknown>>,
  /** L'ordine dei fatti: promozione → rimozione dei file usciti → riga. */
  eventi: [] as string[],
  /** Le `remove()` viste passare, per bucket. */
  rimossi: [] as Array<{ bucket: string; paths: string[] }>,
  /** Gli spostamenti visti passare: `da` → `a`. */
  spostamenti: [] as Array<{ da: string; a: string; percorso: string }>,
  removeError: null as { message: string } | null,
  /**
   * Quante chiamate allo Storage sono ANCORA IN CORSO. È la sonda contro il
   * difetto più banale di tutti: `void riportaMediaInBozza(…)` al posto di
   * `await`. ESLint resta verde (`void` soddisfa `no-floating-promises`), tsc
   * pure, e su Vercel Functions l'invocazione può essere congelata appena parte la
   * risposta: la `move()` di ritorno non finisce mai, e resta pubblica la foto di
   * un bambino che nessuna riga nomina.
   */
  storageInVolo: 0,
  /** Il percorso su cui la promozione deve fallire (guasto a metà strada). */
  moveFalliscePer: null as string | null,
  update: null as Record<string, unknown> | null,
  errUpdate: null as { code?: string; message: string } | null,
  /** L'update LANCIA invece di ritornare `{ error }`: guasto di trasporto. */
  updateLancia: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireStaff: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/news/sanitizza', () => ({
  sanificaContenuto: (...a: unknown[]) => h.sanificaContenuto(...a),
}))

function makeClient() {
  return {
    from(table: string) {
      const st = {
        table,
        op: 'select',
        payload: null as Record<string, unknown> | null,
        esclusi: null as string[] | null,
        finestra: null as { da: number; a: number } | null,
      }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') return { data: h.alunni, error: null }
        if (st.table === 'news_posts' && st.op === 'update') {
          // supabase-js NON promette sempre `{ error }`: su un guasto di trasporto
          // la promessa viene RIGETTATA. È la strada che finiva nel `catch` esterno
          // della route, cioè fuori da ogni ramo che rimetteva i media in sosta.
          if (h.updateLancia) throw new TypeError('fetch failed')
          if (h.errUpdate) return { data: null, error: h.errUpdate }
          return { data: { ...(h.post ?? {}), ...(st.payload ?? {}) }, error: null }
        }
        // La domanda «c'è ancora qualcuno che lo nomina?» si riconosce dalla
        // PAGINAZIONE, che è la sua firma: è l'unica lettura che chiede una
        // finestra di righe. Il database applica l'esclusione e taglia la pagina —
        // qui pure, altrimenti il post risponderebbe di sé stesso e non uscirebbe
        // più nessun file (difetto V4), e nessuno se ne accorgerebbe.
        if (st.table === 'news_posts' && st.finestra) {
          const { da, a } = st.finestra
          h.citazioni.push({ esclusi: st.esclusi ?? [], da, a })
          if (h.erroreCitazioni) return { data: null, error: h.erroreCitazioni }
          const esclusi = new Set(st.esclusi ?? [])
          const tutte = [...h.altriPost]
            .sort((x, y) => String(x.id).localeCompare(String(y.id)))
            .filter((r) => !esclusi.has(String(r.id)))
          return { data: tutte.slice(da, a + 1), error: null }
        }
        if (st.table === 'news_posts') return { data: h.post, error: null }
        return { data: null, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.or = () => b
      b.in = () => b
      b.is = () => b
      b.not = (c: string, op: string, v: unknown) => {
        if (c === 'id' && op === 'in') {
          st.esclusi = String(v).replace(/^\(|\)$/g, '').split(',').filter((x) => x !== '')
        }
        return b
      }
      b.range = (da: number, a: number) => { st.finestra = { da, a }; return b }
      b.limit = () => b
      b.update = (rec: Record<string, unknown>) => {
        st.op = 'update'
        st.payload = rec
        h.eventi.push('update-riga')
        h.update = { ...rec }
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
        remove: async (paths: string[]) => {
          h.storageInVolo++
          try {
            await new Promise((r) => setTimeout(r, 0))
            h.eventi.push('remove-file')
            h.rimossi.push({ bucket, paths })
            if (h.removeError) return { data: null, error: h.removeError }
            return { data: paths.map((p) => ({ name: p })), error: null }
          } finally {
            h.storageInVolo--
          }
        },
        // `rimuoviEVerifica` non conta: interroga lo Storage sui percorsi che non
        // risultano usciti. Un finto client senza `list` non è un client Supabase.
        list: async () => ({ data: [], error: null }),
        move: async (da: string, _a: string, opz: { destinationBucket: string }) => {
          h.storageInVolo++
          try {
            // IL RITORNO NON È IMMEDIATO, ed è deliberato: `move()` è una chiamata
            // di rete, e un finto che risponde nello stesso tick renderebbe
            // indistinguibile una chiamata ATTESA da una lasciata andare. Con
            // questo ritardo, `void riportaMediaInBozza(…)` al posto di `await`
            // lascia `storageInVolo` a 1 quando la route ha già risposto (lo
            // verifica `chiamaPatch`) e non registra in tempo nessuno spostamento.
            await new Promise((r) => setTimeout(r, 0))
            h.eventi.push(bucket === 'news_bozze' ? 'promuovi' : 'riporta-in-bozza')
            h.spostamenti.push({ da: bucket, a: opz.destinationBucket, percorso: da })
            if (h.moveFalliscePer === da && bucket === 'news_bozze') {
              return { data: null, error: { message: 'storage in avaria' } }
            }
            return { data: { path: da }, error: null }
          } finally {
            h.storageInVolo--
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

import { PATCH as NEWS_PATCH } from '@/app/api/news/[id]/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const A1 = '11111111-1111-4111-8111-111111111111'
const POST_ID = '33333333-3333-4333-8333-333333333333'

// ─── ATTORE ≠ AUTORE, E DEVONO RESTARE DUE COSE DIVERSE ─────────────────────
// Nel giro 1 questa fixture usava `edu-1` sia per `user.id` sia per `author_id`:
// due grandezze diverse con un valore solo. Conseguenza misurata: sostituendo
// `auth.user.id` con `postCorrente.author_id` dentro la route — cioè decidendo la
// proprietà del file in base a CHI HA SCRITTO IL POST invece che a CHI STA
// CARICANDO — la batteria restava verde, 83 test su 83. Qui l'attore è staff,
// l'autore è un educator, e i due uuid non si toccano.
const ATTORE = 'staff-7'
const AUTORE = 'edu-1'

// I percorsi stanno sotto l'uuid di CHI HA CARICATO — è `news/upload:POST` a
// scriverli così. I file GIÀ nella riga li ha caricati l'AUTORE: passano perché
// il post li nomina già, non perché siano di chi modifica. Quelli nuovi stanno
// sotto l'uuid dell'ATTORE, che è l'unico che possa averli appena caricati.
const P_VECCHIA = `uploads/${AUTORE}/1700-vecchia.jpg`
const P_TESTO = `uploads/${AUTORE}/1700-testo.png`
const P_NUOVA = `uploads/${ATTORE}/1800-nuova.jpg`
const P_SECONDA = `uploads/${ATTORE}/1800-seconda.png`

/** L'indirizzo che la riga porta dopo la promozione: bucket PUBBLICO. */
const pubblico = (p: string) => `https://xyz.supabase.co/storage/v1/object/public/news/${p}`
/** L'anteprima firmata di un media ancora in sosta nel bucket PRIVATO. */
const inSosta = (p: string) => `https://xyz.supabase.co/storage/v1/object/sign/news_bozze/${p}?token=abc`

const req = (body: unknown) =>
  ({
    url: `http://test/api/news/${POST_ID}`,
    method: 'PATCH',
    headers: new Headers(),
    json: async () => body,
    cookies: { get: () => undefined },
  }) as never

const params = { params: Promise.resolve({ id: POST_ID }) } as never

/** Post già in archivio: una copertina e un'immagine nel testo, entrambe pubbliche. */
const postConFoto = (over: Record<string, unknown> = {}) => ({
  id: POST_ID,
  tipo: 'articolo',
  stato: 'bozza',
  titolo: 'Festa di fine anno',
  copertina_url: pubblico(P_VECCHIA),
  contenuto_json: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Una giornata alla Kidville' }] },
      { type: 'image', attrs: { src: pubblico(P_TESTO) } },
    ],
  },
  scuola_id: 'sc-1',
  author_id: AUTORE,
  bambini_ritratti: [A1],
  ...over,
})

const percorsiTolti = () => h.rimossi.filter((r) => r.bucket === 'news').flatMap((r) => r.paths)
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
async function chiamaPatch(body: unknown) {
  const res = await NEWS_PATCH(req(body), params)
  expect(
    h.storageInVolo,
    'la route ha risposto mentre un’operazione sui file era ancora in corso: la chiamata a ' +
      '`riportaMediaInBozza` non è attesa (`void` invece di `await`). Su Vercel l’invocazione può ' +
      'essere congelata subito dopo la risposta, e la foto di un bambino resta nel bucket pubblico ' +
      'senza nessuna riga che la nomini',
  ).toBe(0)
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.post = postConFoto()
  h.altriPost = []
  h.citazioni = []
  h.erroreCitazioni = null
  h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
  h.eventi = []
  h.rimossi = []
  h.spostamenti = []
  h.storageInVolo = 0
  h.removeError = null
  h.moveFalliscePer = null
  h.update = null
  h.errUpdate = null
  h.updateLancia = false
  // Staff che modifica il post di un educator: attore e autore sono due persone.
  h.requireDocente.mockResolvedValue({ user: { id: ATTORE, role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
})

describe('PATCH /api/news/[id] — il file che esce dalla riga esce anche dal bucket (W1)', () => {
  it('SOSTITUZIONE della copertina → la vecchia esce dal bucket pubblico, la nuova no', async () => {
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(200)
    expect(percorsiTolti(), 'la vecchia copertina è rimasta a un indirizzo pubblico').toEqual([P_VECCHIA])
    expect(h.update?.copertina_url).toBe(pubblico(P_NUOVA))
  })

  it('AZZERAMENTO della copertina → la foto esce dal bucket', async () => {
    const res = await chiamaPatch({ copertina_url: null })
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual([P_VECCHIA])
  })

  it('immagine TOLTA dal rich-text → esce quella, e solo quella', async () => {
    const res = await chiamaPatch({ contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] } })
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual([P_TESTO])
  })

  it('la copertina che si SPOSTA nel testo non esce: la riga la nomina ancora', async () => {
    // Il conto è sulla DIFFERENZA fra i percorsi di prima e quelli di dopo, non
    // sul campo che è cambiato: contare per campo cancellerebbe un file che
    // l'altro campo continua a citare — cioè romperebbe l'articolo.
    const res = await chiamaPatch({
      copertina_url: null,
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_VECCHIA) } }] },
    })
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual([P_TESTO])
  })

  it('stessa copertina rinviata identica → nessuna rimozione', async () => {
    const res = await chiamaPatch({ copertina_url: pubblico(P_VECCHIA) })
    expect(res.status).toBe(200)
    expect(h.rimossi).toHaveLength(0)
  })

  it('PATCH del solo titolo → lo Storage non viene sfiorato', async () => {
    const res = await chiamaPatch({ titolo: 'Titolo nuovo' })
    expect(res.status).toBe(200)
    expect(h.rimossi).toHaveLength(0)
    expect(h.spostamenti).toHaveLength(0)
  })

  it('PRIMA il file, POI la riga: l’ordine è la stessa regola della DELETE', async () => {
    // Scrivere la riga per prima e poi fallire la `remove()` lascerebbe la foto a
    // un indirizzo pubblico senza più niente che la nomini: nessuna passata
    // futura potrebbe ritrovarla. È il guasto permanente che si sta chiudendo.
    await chiamaPatch({ copertina_url: null })
    expect(h.eventi.indexOf('remove-file')).toBeGreaterThanOrEqual(0)
    expect(h.eventi.indexOf('remove-file')).toBeLessThan(h.eventi.indexOf('update-riga'))
  })

  it('rimozione FALLITA → 503 e la riga NON si aggiorna, così resta da dove riprovare', async () => {
    h.removeError = { message: 'storage down' }
    const res = await chiamaPatch({ copertina_url: null })
    expect(res.status).toBe(503)
    expect(h.update, 'la riga ha smesso di nominare un file ancora pubblico').toBeNull()
    expect(await res.json()).toMatchObject({ codice: 'NEWS_FILE_SOSTITUITI_NON_RIMOSSI' })
  })

  it('SOSTITUZIONE che tocca copertina E testo → escono ENTRAMBI i file, non uno solo', async () => {
    // È la PATCH ordinaria dell'editor: si cambia la copertina e si sostituisce
    // l'immagine dentro l'articolo nello stesso salvataggio. Tutti gli altri
    // scenari di questo file fanno uscire UN file per volta, e con un solo file
    // «esce quello giusto» ed «esce il primo dell'elenco» hanno lo stesso colore:
    // un codice che liberasse `usciti[0]` e basta li supererebbe tutti, lasciando
    // pubblica per sempre la foto rimasta indietro.
    const res = await chiamaPatch({
      copertina_url: inSosta(P_NUOVA),
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: inSosta(P_SECONDA) } }] },
    })
    expect(res.status).toBe(200)
    expect(
      percorsiTolti().slice().sort(),
      'un file che la riga ha smesso di nominare è rimasto nel bucket pubblico',
    ).toEqual([P_VECCHIA, P_TESTO].sort())
    // Controllo POSITIVO sull'altro capo: i due nuovi sono stati promossi e la
    // riga li nomina. Senza, «ne sono usciti due» starebbe in piedi anche in una
    // route che ha svuotato il post.
    expect(h.update?.copertina_url).toBe(pubblico(P_NUOVA))
    expect(JSON.stringify(h.update?.contenuto_json)).toContain(pubblico(P_SECONDA))
  })

  it('il 503 della modifica NON usa il codice della cancellazione', async () => {
    // TRAPPOLA, e il lock `errori-con-codice` non poteva vederla: il codice era
    // dichiarato e tradotto in due lingue — sbagliato, non mancante.
    // `messaggioDaCorpo`, appena riconosce un codice, mostra il testo di CATALOGO
    // e scarta la prosa del server: con `NEWS_FILE_NON_RIMOSSI` chi aveva appena
    // cambiato una copertina leggeva «la news non è stata eliminata», cioè il
    // resoconto di una cancellazione che nessuno aveva chiesto.
    h.removeError = { message: 'storage down' }
    const res = await chiamaPatch({ copertina_url: null })
    const corpo = (await res.json()) as { codice?: string }

    expect(corpo.codice).not.toBe('NEWS_FILE_NON_RIMOSSI')
    expect(corpo.codice).toBe('NEWS_FILE_SOSTITUITI_NON_RIMOSSI')
    // Ed è il testo che l'utente legge a dover essere giusto, non il nome del
    // codice: si guarda il catalogo, che è ciò che finisce a schermo.
    const chiave = CODICI_ERRORE[corpo.codice as keyof typeof CODICI_ERRORE]
    expect(chiave, 'codice non dichiarato: a schermo ricadrebbe sulla prosa italiana').toBeTruthy()
    expect(
      (itShared as Record<string, string>)[chiave],
      'la frase mostrata parla di una cancellazione, e qui nessuno ha cancellato niente',
    ).not.toMatch(/eliminat|cancellat/i)
    expect((enShared as Record<string, string>)[chiave]).not.toMatch(/delet/i)
    // Controllo POSITIVO: la frase parla davvero della MODIFICA non salvata.
    expect((itShared as Record<string, string>)[chiave]).toMatch(/modifica/i)
    expect((enShared as Record<string, string>)[chiave]).toMatch(/changes/i)
  })

  it('il gate del consenso RIFIUTA → nessuna rimozione e nessuna promozione', async () => {
    // Il gate resta PRIMA di ogni gesto sullo Storage: una modifica rifiutata non
    // deve aver già svuotato il bucket di un post che resta com'era.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(422)
    expect(h.rimossi).toHaveLength(0)
    expect(h.spostamenti).toHaveLength(0)
    expect(h.update).toBeNull()
  })

  it('educator su post altrui → 403, e lo Storage non viene sfiorato', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = postConFoto({ author_id: 'ALTRO-DOCENTE' })
    const res = await chiamaPatch({ copertina_url: null })
    expect(res.status).toBe(403)
    expect(h.rimossi).toHaveLength(0)
  })
})

describe('PATCH /api/news/[id] — nessun file pubblico che nessuna riga nomina (W1-bis)', () => {
  it('SCRITTURA della riga fallita → i media appena promossi tornano nel bucket privato', async () => {
    // La promozione rende pubblici i file PRIMA della scrittura. Se la scrittura
    // non riesce, quei file sono pubblici e nessuna riga li cita: è lo stesso
    // guasto di W1 preso dall'altro capo. Si annulla lo spostamento invece di
    // cancellare, perché `news_bozze` è il posto in cui quei file devono stare
    // finché una riga non li nomina — e un ritentativo li ritrova.
    h.errUpdate = { code: '23514', message: 'violazione di vincolo' }
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(500)
    expect(riportatiInSosta(), 'il file promosso è rimasto pubblico e senza padrone').toEqual([P_NUOVA])
  })

  it('PROMOZIONE fallita a metà → il file già spostato torna indietro, e 503', async () => {
    h.moveFalliscePer = P_SECONDA
    const res = await chiamaPatch({
      copertina_url: inSosta(P_NUOVA),
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: inSosta(P_SECONDA) } }] },
    })
    expect(res.status).toBe(503)
    expect(riportatiInSosta()).toEqual([P_NUOVA])
    expect(h.update).toBeNull()
  })

  it('RIMOZIONE fallita DOPO una promozione → anche i nuovi tornano nel bucket privato', async () => {
    // IL RAMO PIÙ PROBABILE DI TUTTI, e fino al 2026-08-03 nessuna riga lo
    // nominava: è un guasto dello Storage dentro una richiesta che sta GIÀ
    // facendo Storage — la copertina nuova è appena stata promossa quando la
    // vecchia non riesce a uscire. Le due `remove()`/`move()` parlano con lo
    // stesso servizio, quindi se una fallisce l'altra ha ottime probabilità di
    // aver funzionato un istante prima.
    //
    // L'altro scenario di rimozione fallita in questo file passa `copertina_url:
    // null`: non promuove niente, quindi l'elenco da rimettere in sosta è vuoto e
    // cancellare `riportaMediaInBozza` da questa via d'uscita non lo faceva
    // diventare rosso. Qui invece un file è appena diventato pubblico, la riga non
    // si scriverà, e senza il ritorno in sosta resterebbe pubblico senza che
    // nessuna riga lo nomini: irraggiungibile da revoca e oblio, che partono
    // entrambi dalla riga. È W1-bis preso dalla terza via d'uscita.
    h.removeError = { message: 'storage down' }
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })

    expect(res.status).toBe(503)
    expect(h.update, 'la riga si è aggiornata mentre il file vecchio è ancora pubblico').toBeNull()
    // Controllo POSITIVO che la promozione fosse davvero avvenuta: senza, «è
    // tornato indietro» sarebbe verde anche se non fosse mai andato avanti.
    expect(h.spostamenti.filter((s) => s.da === 'news_bozze').map((s) => s.percorso)).toEqual([P_NUOVA])
    expect(
      riportatiInSosta(),
      'il file appena promosso è rimasto nel bucket pubblico e nessuna riga lo nomina: ' +
        'revoca e oblio partono dalla riga, quindi non ci arriveranno mai',
    ).toEqual([P_NUOVA])
  })

  it('CONTROLLO POSITIVO — scrittura riuscita → nessun file torna indietro', async () => {
    // Senza questo, «torna indietro quando serve» sarebbe verde anche in una
    // route che riporta in bozza SEMPRE, cioè che non pubblica più niente.
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(200)
    expect(riportatiInSosta()).toEqual([])
    expect(h.update?.copertina_url).toBe(pubblico(P_NUOVA))
  })
})

// =============================================================================
// LA QUARTA VIA D'USCITA: L'ECCEZIONE (W1-quater, 2026-08-03).
//
// I casi qui sopra coprono le vie d'uscita che passano da un `if`. Ne restava una
// che non passa da nessuno: un'eccezione fra la promozione e la scrittura della
// riga. Il `catch` esterno della route rispondeva 500 e non rimetteva in sosta
// niente — cioè W1-bis intatto, sulla strada che nessuno guarda.
//
// LA STRADA PIÙ CORTA È LA SANIFICAZIONE: `sanificaContenuto` gira su un JSON che
// arriva dal CLIENT ed è chiamata DOPO la promozione. La seconda è il trasporto:
// supabase-js RIGETTA invece di ritornare `{ error }` quando il fetch cade — lo sa
// già `riportaMediaInBozza`, che ha un `catch` apposta.
// =============================================================================

describe('PATCH /api/news/[id] — un’ECCEZIONE non lascia file pubblici orfani (W1-quater)', () => {
  it('la SANIFICAZIONE lancia dopo la promozione → il media torna in sosta', async () => {
    h.sanificaContenuto.mockImplementation(() => {
      throw new TypeError('nodo inatteso')
    })
    const res = await chiamaPatch({
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: inSosta(P_SECONDA) } }] },
    })

    expect(res.status).toBe(500)
    // Controllo POSITIVO: la promozione era davvero avvenuta. Senza, «è tornato
    // indietro» sarebbe verde anche se non fosse mai andato avanti.
    expect(h.spostamenti.filter((s) => s.da === 'news_bozze').map((s) => s.percorso)).toEqual([P_SECONDA])
    expect(
      riportatiInSosta(),
      'un’eccezione fra promozione e scrittura ha lasciato la foto nel bucket pubblico senza ' +
        'nessuna riga che la nomini: revoca e oblio partono dalla riga, quindi non ci arriveranno mai',
    ).toEqual([P_SECONDA])
    // E il file vecchio NON è uscito: la riga lo nomina ancora, perché la
    // modifica non è stata salvata.
    expect(percorsiTolti()).toEqual([])
  })

  it('l’UPDATE LANCIA (guasto di trasporto) → il media torna in sosta', async () => {
    // «PostgREST non lancia» vale per gli errori del DATABASE, non per il
    // trasporto che ce li porta: quando il fetch cade, la promessa viene rigettata
    // e il `try/catch` attorno alla route è l'unica cosa che la vede.
    h.updateLancia = true
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })

    expect(res.status).toBe(500)
    expect(h.spostamenti.filter((s) => s.da === 'news_bozze').map((s) => s.percorso)).toEqual([P_NUOVA])
    expect(riportatiInSosta()).toEqual([P_NUOVA])
  })

  it('CONTROLLO POSITIVO — nessuna eccezione: il ritorno in sosta non parte comunque', async () => {
    // Se il `catch` riportasse in sosta a prescindere, questa modifica riuscita
    // rimetterebbe nel bucket privato l'immagine che la riga ha appena cominciato
    // a nominare: articolo salvato e foto rotta.
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(200)
    expect(riportatiInSosta()).toEqual([])
  })
})

// =============================================================================
// IL RITENTATIVO DOPO UN ROLLBACK — l'invariante che nessuno difendeva.
//
// LO SCENARIO, ed è creato dal lavoro W1-bis stesso. Un salvataggio fallisce →
// `riportaMediaInBozza` rimette il file in `news_bozze` → l'operatore ritenta →
// l'editor rimanda l'indirizzo firmato di SOSTA dello STESSO percorso che la riga
// già nomina in versione pubblica. È il percorso normale di un secondo tentativo,
// non un caso di laboratorio.
//
// L'INVARIANTE. `usciti` si calcola sugli `updates` DOPO la promozione, non sui
// `copertinaDopo`/`contenutoDopo` che il gate aveva in mano PRIMA: quelli portano
// ancora l'indirizzo di sosta, che `percorsoPubblicoNews` non riconosce (bucket
// diverso). Riusarli farebbe risultare quel percorso «uscito dalla riga», e la
// route CANCELLEREBBE dal bucket pubblico il file che la riga sta per nominare:
// articolo con l'immagine rotta e foto persa, in un colpo solo.
// =============================================================================

describe('PATCH /api/news/[id] — il RITENTATIVO non cancella il file che sta per salvare', () => {
  it('stesso percorso rimandato come indirizzo di SOSTA → 200 e nessuna rimozione', async () => {
    const res = await chiamaPatch({ copertina_url: inSosta(P_VECCHIA) })

    expect(res.status).toBe(200)
    // La riga continua a nominare lo stesso file, all'indirizzo pubblico.
    expect(h.update?.copertina_url).toBe(pubblico(P_VECCHIA))
    expect(
      percorsiTolti(),
      'la copertina è stata cancellata dal bucket pubblico mentre la riga la stava rinominando: ' +
        'l’articolo resta con l’immagine rotta e la foto è persa',
    ).toEqual([])
  })
})

// =============================================================================
// LA REGRESSIONE CHE LA CORREZIONE DI W1 HA INTRODOTTO (2026-08-03).
//
// La liberazione dei file «usciti dalla riga» non chiedeva di CHI fossero:
// `percorsoPubblicoNews` valida la FORMA dell'indirizzo, mai la proprietà. E il
// bucket `news` è PUBBLICO — l'indirizzo dell'immagine di un altro articolo lo
// conosce chiunque legga il sito, `/api/news/feed` lo distribuisce in chiaro.
// Due mosse, entrambe legittime prese da sole:
//   1. metto quell'indirizzo nel `contenuto_json` della MIA bozza → 200;
//   2. una seconda PATCH lo toglie → il percorso della vittima finisce fra gli
//      `usciti` → `remove()` in service-role sul file di un altro post.
// La riga della vittima continua a nominarlo: immagine rotta, PERMANENTE,
// invisibile — e nemmeno la revoca o l'oblio possono più farci niente, perché
// arrivano su un file che non c'è più.
//
// LE DUE DIFESE, e sono complementari. Il passo 2 lo chiude
// `liberaPercorsiPubblici` («c'è ancora qualcuno che lo nomina?», in un posto
// solo per PATCH, DELETE e ritiro); il passo 1 lo chiude `percorsiPubbliciEstranei`,
// che rifiuta il corpo. I test qui sotto le esercitano SEPARATAMENTE: il primo
// gruppo passa un corpo perfettamente lecito — l'attaccante toglie l'immagine
// altrui — e deve fermarsi comunque.
// =============================================================================

describe('PATCH /api/news/[id] — non si cancella il file di un ALTRO post', () => {
  const P_VITTIMA = 'uploads/staff-vittima/1700-vittima.jpg'
  const POST_VITTIMA = '55555555-5555-4555-8555-555555555555'
  /** La riga della vittima: altro autore, altra sede, e nomina il suo file. */
  const rigaVittima = () => ({
    id: POST_VITTIMA,
    scuola_id: 'sc-2',
    author_id: 'staff-vittima',
    copertina_url: pubblico(P_VITTIMA),
    contenuto_json: null,
  })

  beforeEach(() => {
    // L'attaccante è un educator che modifica la PROPRIA bozza: tutti i gate di
    // ruolo e di sede passano, perché non è lì che sta il difetto.
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = postConFoto({
      author_id: 'edu-1',
      copertina_url: null,
      // Il passo 1 è già avvenuto: la riga nomina il file della vittima.
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_VITTIMA) } }] },
    })
    h.altriPost = [rigaVittima()]
  })

  it('PASSO 2 — togliere l’immagine altrui NON la cancella dal bucket', async () => {
    const res = await chiamaPatch({ contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] } })
    expect(res.status).toBe(200)
    expect(
      percorsiTolti(),
      'il file di un altro articolo è finito dentro una `remove()` in service-role: ' +
        'immagine rotta sulla riga della vittima, permanente e invisibile',
    ).toEqual([])
    // La modifica si salva lo stesso: è il FILE che non si tocca, non
    // l'operazione. Bloccarla lascerebbe l'attaccante padrone della propria riga.
    expect(h.update).toBeTruthy()
  })

  it('la domanda arriva al database ed esclude la riga corrente', async () => {
    await chiamaPatch({ contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] } })
    expect(h.citazioni, 'nessuno ha chiesto di chi fosse il file').toHaveLength(1)
    expect(h.citazioni[0].esclusi).toEqual([POST_ID])
    expect(h.citazioni[0].da).toBe(0)
  })

  it('la vittima lo nomina SOLO nel `contenuto_json` → il file resta lo stesso', async () => {
    // La forma che il giro 1 non vedeva: la riga della vittima non ha copertina e
    // non ha `contenuto_html` (riga vecchia, oppure `<img>` scartato dal sanitizer
    // che lascia l'indirizzo nel JSON). La domanda chiedeva `ilike` su tre colonne
    // di TESTO — e `ilike` non si applica a una `jsonb` — quindi quella riga non
    // tornava e il file usciva; il test restava verde perché il finto client non
    // applicava il filtro. Oggi il finto lo applica e la domanda non filtra.
    h.altriPost = [{
      id: POST_VITTIMA,
      scuola_id: 'sc-2',
      author_id: 'staff-vittima',
      copertina_url: null,
      contenuto_html: null,
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_VITTIMA) } }] },
    }]
    const res = await chiamaPatch({ contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] } })
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual([])
  })

  it('CONTROLLO POSITIVO (difetto V4) — il file che è DAVVERO suo esce come prima', async () => {
    // Senza questo, «non cancella il file altrui» sarebbe verde anche in una
    // route che non cancella più niente: i file pubblici resterebbero orfani per
    // sempre, irraggiungibili da revoca e oblio, che partono dalla riga.
    h.post = postConFoto({ author_id: 'edu-1' })
    h.altriPost = [rigaVittima()]
    const res = await chiamaPatch({ copertina_url: null })
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual([P_VECCHIA])
  })

  it('DELETE e ritiro a parte, la lettura FALLITA blocca: 503 e la riga non cambia', async () => {
    // `percorsiCitatiDaAltriPost` restituisce «non verificato», e qui «non lo so»
    // non può valere «cancella»: la `remove()` cadrebbe forse su un file altrui.
    h.post = postConFoto({ author_id: 'edu-1' })
    h.altriPost = []
    h.erroreCitazioni = { code: '08006', message: 'connection failure' }
    const res = await chiamaPatch({ copertina_url: null })
    expect(res.status).toBe(503)
    expect(percorsiTolti()).toEqual([])
    expect(h.update, 'la riga ha smesso di nominare un file mentre non si sapeva di chi fosse').toBeNull()
  })
})

describe('PATCH /api/news/[id] — un post non ADOTTA il file di un altro (passo 1)', () => {
  const P_VITTIMA = 'uploads/staff-vittima/1700-vittima.jpg'

  beforeEach(() => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = postConFoto({ author_id: 'edu-1' })
  })

  it('l’indirizzo pubblico di un altro articolo nel rich-text → 403, e niente si muove', async () => {
    const res = await chiamaPatch({ contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_VITTIMA) } }] } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'NEWS_MEDIA_ESTRANEO' })
    expect(h.update, 'la riga ha cominciato a nominare il file di un altro post').toBeNull()
    expect(h.rimossi).toHaveLength(0)
    expect(h.spostamenti).toHaveLength(0)
  })

  it('stesso rifiuto se arriva come COPERTINA', async () => {
    const res = await chiamaPatch({ copertina_url: pubblico(P_VITTIMA) })
    expect(res.status).toBe(403)
    expect(h.update).toBeNull()
  })

  it('CONTROLLO POSITIVO — gli indirizzi che il post GIÀ nomina non si rifiutano', async () => {
    // L'editor rimanda gli indirizzi definitivi delle immagini salvate: se questo
    // rifiuto li prendesse, nessun articolo con una foto sarebbe più modificabile.
    const res = await chiamaPatch({
      titolo: 'Titolo nuovo',
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_TESTO) } }] },
    })
    expect(res.status).toBe(200)
    expect(h.update?.titolo).toBe('Titolo nuovo')
  })

  it('CONTROLLO POSITIVO — un file caricato DA CHI SCRIVE passa (bucket di sosta assente)', async () => {
    // Finché la migrazione di `news_bozze` non è applicata, `news/upload:POST`
    // ricade sul bucket pubblico e restituisce già un indirizzo pubblico: senza
    // questo ramo, su quegli ambienti nessuno potrebbe più aggiungere un'immagine.
    const res = await chiamaPatch({ copertina_url: pubblico('uploads/edu-1/1900-appena-caricata.jpg') })
    expect(res.status).toBe(200)
    expect(h.update?.copertina_url).toBe(pubblico('uploads/edu-1/1900-appena-caricata.jpg'))
  })

  it('il codice del rifiuto è dichiarato e tradotto in ENTRAMBE le lingue', () => {
    // Un codice non dichiarato ricade sulla prosa italiana dentro un'interfaccia
    // inglese: il difetto di localizzazione con l'aria di essere chiuso.
    const chiave = CODICI_ERRORE.NEWS_MEDIA_ESTRANEO
    expect(chiave, 'il codice non è dichiarato in CODICI_ERRORE').toBeTruthy()
    expect((itShared as Record<string, string>)[chiave]).toBeTruthy()
    expect((enShared as Record<string, string>)[chiave]).toBeTruthy()
  })
})

// =============================================================================
// LA PROPRIETÀ È DI CHI CARICA, NON DI CHI HA SCRITTO IL POST.
//
// IL TEST FINTO DEL GIRO 1, e il modo esatto in cui era finto: la fixture usava
// `edu-1` sia per `user.id` sia per `author_id`. Due grandezze diverse, un valore
// solo — e con un valore solo non si distingue quale delle due il codice stia
// leggendo. Sostituendo dentro la route `auth.user.id` con `postCorrente.author_id`
// la batteria restava verde, 83 su 83, mentre il significato cambiava del tutto:
// staff che apre l'articolo di un educator avrebbe potuto adottare qualunque file
// caricato DALL'AUTORE, e non avrebbe più potuto usare i propri.
//
// Qui l'attore è `staff-7` e l'autore `edu-1`. Le due asserzioni sono speculari e
// nessuna delle due regge da sola: passa il file dell'attore, non passa quello
// dell'autore.
// =============================================================================

describe('PATCH /api/news/[id] — la proprietà del file è di CHI CARICA', () => {
  beforeEach(() => {
    // Staff (non educator) che modifica il post di un altro: `guardEducator` non
    // lo ferma, ed è giusto — è la sua mansione. Ma la proprietà dei file no.
    h.requireDocente.mockResolvedValue({ user: { id: ATTORE, role: 'admin', scuola_id: 'sc-1' } })
    h.post = postConFoto({ author_id: AUTORE })
  })

  it('un file caricato DALL’ATTORE si può aggiungere', async () => {
    const suo = `uploads/${ATTORE}/1900-appena-caricata.jpg`
    const res = await chiamaPatch({ copertina_url: pubblico(suo) })
    expect(res.status).toBe(200)
    expect(h.update?.copertina_url).toBe(pubblico(suo))
  })

  it('un file caricato DALL’AUTORE, e che il post NON nomina, è estraneo → 403', async () => {
    // È l'asserzione che il giro 1 non poteva avere: `author_id` e `user.id`
    // valevano lo stesso uuid, quindi «di chi sta scrivendo» e «di chi ha scritto
    // il post» erano indistinguibili. Un altro articolo dello stesso autore non è
    // materiale di questo articolo.
    const suoDellAutore = `uploads/${AUTORE}/1900-di-un-altro-articolo.jpg`
    const res = await chiamaPatch({ copertina_url: pubblico(suoDellAutore) })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'NEWS_MEDIA_ESTRANEO' })
    expect(h.update).toBeNull()
  })

  it('CONTROLLO POSITIVO — i file che il post GIÀ nomina passano, anche se sono dell’autore', async () => {
    // L'editor rimanda gli indirizzi definitivi delle immagini salvate. Qui
    // passano SOLO perché la riga li nomina già — l'attore non li ha caricati —
    // quindi questa è la versione forte del controllo positivo: nel giro 1 le due
    // ragioni coincidevano e non si poteva sapere quale delle due reggesse.
    const res = await chiamaPatch({
      titolo: 'Titolo nuovo',
      contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(P_TESTO) } }] },
    })
    expect(res.status).toBe(200)
    expect(h.update?.titolo).toBe('Titolo nuovo')
  })

  it('l’AREA DI SOSTA privata di un altro operatore non si può nominare → 403', async () => {
    // La strada accanto, e di là la conseguenza è peggiore: `pathBozza` accettava
    // qualunque `uploads/<utente>/<file>` senza chiedere di chi fosse, e dopo il
    // gate partiva una `move()` in service-role che RENDEVA PUBBLICA la foto in
    // sosta di un altro — una foto che sta in un bucket privato proprio perché
    // nessuno ne ha ancora verificato il consenso.
    const sostaAltrui = `uploads/${AUTORE}/1900-mai-salvata.jpg`
    const res = await chiamaPatch({ copertina_url: inSosta(sostaAltrui) })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'NEWS_MEDIA_ESTRANEO' })
    expect(
      h.spostamenti,
      'il file privato di un altro operatore è stato spostato nel bucket PUBBLICO',
    ).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO — la propria area di sosta si usa come sempre', async () => {
    const res = await chiamaPatch({ copertina_url: inSosta(P_NUOVA) })
    expect(res.status).toBe(200)
    expect(h.update?.copertina_url).toBe(pubblico(P_NUOVA))
  })
})
