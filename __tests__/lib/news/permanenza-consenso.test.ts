import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// IL CONSENSO NON È UN BIGLIETTO D'INGRESSO: È UNA CONDIZIONE DI PERMANENZA.
//
// DUE DIFETTI MISURATI il 2026-08-02 (collaudo privacy #1 e #2), sullo stesso
// bucket — `news`, l'unico PUBBLICO dei tredici, servito senza login.
//
//  #1  Una foto di minore finita lì dentro NON usciva più: il registro
//      dell'oblio dichiarava `news` ESCLUSO, con la motivazione «ci vanno solo
//      media editoriali, le foto dei bambini stanno in `gallery`». Ma il gate
//      del consenso — scritto lo stesso giorno, nel file accanto — esiste
//      APPOSTA per autorizzare le foto di minori con il consenso al canale
//      «sito». La motivazione dell'esclusione descriveva un prodotto diverso da
//      quello che il codice implementa: se la famiglia esercitava il diritto
//      alla cancellazione, l'immagine del bambino restava pubblica per sempre.
//
//  #2  La revoca non aveva effetto sugli articoli GIÀ pubblicati. Il consenso si
//      verificava alla creazione, alla modifica e alla pubblicazione, e poi non
//      lo rileggeva più nessuno. Un consenso che non si può revocare non è un
//      consenso (art. 7 §3 GDPR: revocare dev'essere facile quanto acconsentire).
//
// LA CAUSA È UNA SOLA, ed è la stessa forma di difetto che questo ciclo ha già
// corretto tre volte — la regola chiusa su una strada e lasciata aperta su
// quella accanto — applicata però all'asse del TEMPO invece che a quello delle
// rotte: si controllava l'INGRESSO del dato e mai la sua PERMANENZA.
//
// Le asserzioni qui sotto sono sulla MUTAZIONE: che cosa è stato scritto sulla
// riga e su quale bucket è finita una `remove()`. Un post «nascosto» il cui file
// resta a un indirizzo pubblico non è un ritiro: è un ritiro dichiarato.
// =============================================================================

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['news', 'gdpr', 'storage']) }))

import {
  MOTIVO_CONSENSO_REVOCATO,
  MOTIVO_OBLIO,
  STATI_SORVEGLIATI,
  percorsiPubbliciDelPost,
  percorsiPubbliciEstranei,
  percorsiCitatiDaAltriPost,
  liberaPercorsiPubblici,
  verificaPermanenzaConsenso,
  obliaFotoNewsAlunno,
} from '@/lib/news/permanenza-consenso'
import { REGISTRO_BUCKET_OBLIO } from '@/lib/gdpr/esegui'

const AL_1 = '11111111-1111-4111-8111-111111111111'
const AL_2 = '22222222-2222-4222-8222-222222222222'
const POST_1 = '33333333-3333-4333-8333-333333333333'

/** L'indirizzo pubblico che `promuoviMediaBozza` scrive nella riga del post. */
const COPERTINA = 'https://esempio.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg'
const NEL_TESTO = 'https://esempio.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-xyz.png'

function postConFoto(over: Record<string, unknown> = {}) {
  return {
    id: POST_1,
    stato: 'pubblicata',
    bambini_ritratti: [AL_1],
    copertina_url: COPERTINA,
    contenuto_json: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Una giornata alla Kidville' }] },
        { type: 'image', attrs: { src: NEL_TESTO } },
      ],
    },
    ...over,
  }
}

// ── Finto Supabase: cattura update e remove, risponde per TABELLA ────────────
interface Cfg {
  posts?: Record<string, unknown>[]
  postsError?: { code?: string; message: string } | null
  /**
   * LE ALTRE RIGHE di `news_posts` — quelle che la domanda «c'è ancora qualcuno
   * che lo nomina?» va a cercare. Sono un insieme DIVERSO da `posts`, e devono
   * restarlo: `posts` è ciò che la sorveglianza esamina, questo è ciò che
   * possiede i file. Riusare la stessa lista per entrambi significherebbe che il
   * test non sta distinguendo le due grandezze — e proprio quella confusione è il
   * difetto che si sta chiudendo.
   */
  altriPost?: Record<string, unknown>[]
  altriPostError?: { code?: string; message: string } | null
  alunni?: Record<string, unknown>[]
  alunniError?: { code?: string; message: string } | null
  updateError?: { code?: string; message: string } | null
  removeError?: { message: string } | null
  removeLancia?: boolean
  /** `remove()` non nomina nessun oggetto: tocca alla verifica dire come sta. */
  removeMuta?: boolean
  /** I NOMI dei file che, interrogando lo Storage, risultano ANCORA presenti. */
  ancoraPresenti?: string[]
}

function makeFake(cfg: Cfg) {
  const updates: { table: string; rec: Record<string, unknown>; id: unknown }[] = []
  const removed: { bucket: string; paths: string[] }[] = []
  /** I filtri `.in(colonna, valori)` visti passare: la sorveglianza si legge da qui. */
  const filtriIn: { table: string; colonna: string; valori: unknown }[] = []
  /**
   * Gli `.order(colonna, opzioni)` visti passare, NELL'ORDINE in cui sono stati
   * chiesti — che è l'ordine di PRIORITÀ con cui PostgREST li compone.
   *
   * Fino al 2026-08-03 questo finto `order` teneva la sola colonna e buttava via
   * il secondo argomento. Le due cose che buttava via sono esattamente le due che
   * decidono se la sorveglianza gira davvero: con `{ ascending: false }` e con
   * `id` messo per primo il test restava verde, e in produzione una revoca poteva
   * non arrivare MAI. Un finto che ignora un argomento non sta osservando: sta
   * decidendo che quell'argomento non conta.
   */
  const ordini: { table: string; colonna: string; ascendente: unknown }[] = []
  /**
   * Le interrogazioni «chi altro nomina questo file?»: gli id ESCLUSI e la
   * finestra chiesta.
   *
   * ⚠️ QUESTO FINTO LE RISOLVE COME IL DATABASE — applica l'esclusione e taglia la
   * pagina — e non è pignoleria. Nel giro 1 registrava il filtro e restituiva
   * comunque TUTTE le righe: con un finto così, «cerco nella colonna sbagliata» e
   * «dimentico di escludere la riga corrente» hanno lo stesso colore del codice
   * giusto, e due test che si dichiaravano verdi misuravano il contrario di quel
   * che promettevano. Un finto che ignora un filtro non sta osservando: sta
   * decidendo che quel filtro non conta.
   */
  const citazioni: { esclusi: string[]; da: number; a: number }[] = []
  const client = {
    from(table: string) {
      const st = {
        isUpdate: false,
        rec: {} as Record<string, unknown>,
        eq: {} as Record<string, unknown>,
        esclusi: null as string[] | null,
        finestra: null as { da: number; a: number } | null,
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { st.eq[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtriIn.push({ table, colonna: c, valori: v }); return b }
      b.not = (c: string, op: string, v: unknown) => {
        // `.not('id', 'in', '(a,b)')`: l'esclusione dei post che stanno perdendo i
        // propri file. Si applica DAVVERO, come fa il database.
        if (c === 'id' && op === 'in') {
          st.esclusi = String(v).replace(/^\(|\)$/g, '').split(',').filter((x) => x !== '')
        }
        return b
      }
      b.is = () => b
      b.or = () => b
      b.order = (c: string, opz?: { ascending?: boolean }) => {
        ordini.push({ table, colonna: c, ascendente: opz?.ascending })
        return b
      }
      b.range = (da: number, a: number) => { st.finestra = { da, a }; return b }
      b.limit = () => b
      b.contains = () => b
      b.update = (rec: Record<string, unknown>) => { st.isUpdate = true; st.rec = rec; return b }
      const resolve = (): { data: unknown; error: unknown } => {
        if (st.isUpdate) {
          updates.push({ table, rec: st.rec, id: st.eq.id })
          return { data: null, error: cfg.updateError ?? null }
        }
        // La domanda sulla proprietà si riconosce dalla PAGINAZIONE, che è la sua
        // firma: è l'unica lettura che chiede una finestra di righe.
        if (table === 'news_posts' && st.finestra) {
          const { da, a } = st.finestra
          citazioni.push({ esclusi: st.esclusi ?? [], da, a })
          if (cfg.altriPostError) return { data: null, error: cfg.altriPostError }
          const esclusi = new Set(st.esclusi ?? [])
          const tutte = [...(cfg.altriPost ?? [])]
            // Ordinate per id come chiede la query: senza, la paginazione del
            // finto non somiglierebbe a quella vera e il tetto misurerebbe altro.
            .sort((x, y) => String(x.id).localeCompare(String(y.id)))
            .filter((r) => !esclusi.has(String(r.id)))
          return { data: tutte.slice(da, a + 1), error: null }
        }
        if (table === 'news_posts') {
          return { data: cfg.postsError ? null : (cfg.posts ?? []), error: cfg.postsError ?? null }
        }
        if (table === 'alunni') {
          return { data: cfg.alunniError ? null : (cfg.alunni ?? []), error: cfg.alunniError ?? null }
        }
        return { data: [], error: null }
      }
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths })
          if (cfg.removeLancia) throw new Error('trasporto interrotto')
          if (cfg.removeError) return { data: null, error: cfg.removeError }
          return { data: cfg.removeMuta ? [] : paths.map((p) => ({ name: p })), error: null }
        },
        // `rimuoviEVerifica` non conta: interroga lo Storage sui percorsi che non
        // risultano usciti. Un finto client senza `list` non è un client Supabase.
        list: async (_cartella: string, opzioni: { search?: string }) => ({
          data: (cfg.ancoraPresenti ?? [])
            .filter((n) => n === opzioni?.search)
            .map((n) => ({ name: n })),
          error: null,
        }),
      }),
    },
  }
  return { client, updates, removed, filtriIn, ordini, citazioni }
}

const percorsiRimossi = (removed: { bucket: string; paths: string[] }[]) =>
  removed.filter((r) => r.bucket === 'news').flatMap((r) => r.paths)

beforeEach(() => vi.clearAllMocks())

// ─────────────────────────────────────────────────────────────────────────────
describe('percorsiPubbliciDelPost — quali file di QUESTO post stanno nel bucket pubblico', () => {
  it('trova la copertina e le immagini del rich-text, senza duplicati', () => {
    const p = percorsiPubbliciDelPost(postConFoto())
    expect(p).toContain('uploads/staff-1/1700-abc.jpg')
    expect(p).toContain('uploads/staff-1/1700-xyz.png')
    expect(p).toHaveLength(2)
  })

  it('IGNORA tutto ciò che non è un oggetto di questo bucket', () => {
    // Il rich-text è testo scritto da una persona: se una frase qualunque venisse
    // scambiata per un percorso, il ritiro proverebbe a cancellare oggetti a caso
    // nel bucket pubblico — e il primo a saltare sarebbe un articolo estraneo.
    const p = percorsiPubbliciDelPost({
      copertina_url: 'https://www.instagram.com/p/abc/',
      contenuto_json: {
        content: [
          { type: 'text', text: 'uploads/staff-1/non-e-un-file' },
          { type: 'image', attrs: { src: 'https://esempio.supabase.co/storage/v1/object/public/gallery/uploads/u/x.jpg' } },
        ],
      },
    })
    expect(p).toEqual([])
  })

  it('post senza foto → nessun percorso (e nessuna chiamata allo Storage a valle)', () => {
    expect(percorsiPubbliciDelPost({ copertina_url: null, contenuto_json: null })).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('verificaPermanenzaConsenso — la revoca arriva agli articoli GIÀ pubblicati (#2)', () => {
  it('consenso REVOCATO → il post si nasconde col motivo, e il file esce dal bucket PUBBLICO', async () => {
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')

    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd, 'il post resta pubblicato: la revoca non ha prodotto nessuna scrittura').toBeTruthy()
    expect(upd!.rec.stato).toBe('nascosta')
    expect(upd!.rec.nascosta_motivo).toBe(MOTIVO_CONSENSO_REVOCATO)
    // Nascondere la riga non basta: il bucket è PUBBLICO e l'indirizzo diretto
    // continuerebbe a servire la foto del bambino a chiunque lo conosca.
    expect(percorsiRimossi(f.removed)).toEqual(
      expect.arrayContaining(['uploads/staff-1/1700-abc.jpg', 'uploads/staff-1/1700-xyz.png']),
    )
    expect(r.ritirati).toBe(1)
    expect(r.fileRimossi).toBe(2)
    expect(r.fileNonRimossi).toBe(0)
  })

  it('consenso ANCORA VALIDO → non si tocca niente (controllo positivo)', async () => {
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: true, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates).toHaveLength(0)
    expect(f.removed).toHaveLength(0)
    expect(r.esaminati).toBe(1)
    expect(r.ritirati).toBe(0)
  })

  it('minore OBLIATO (riga anonimizzata) → il post esce, col motivo dell’oblio (#1)', async () => {
    // `patchAlunno` anonimizza la riga e NON tocca `consenso_foto_sito`: guardare
    // solo la spunta lascerebbe online la foto di un bambino cancellato.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: true, anonimizzato_il: '2026-08-02T10:00:00Z' }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd!.rec.nascosta_motivo).toBe(MOTIVO_OBLIO)
    expect(percorsiRimossi(f.removed)).toContain('uploads/staff-1/1700-abc.jpg')
  })

  it('riga del minore SPARITA → fail-closed: si ritira lo stesso', async () => {
    const f = makeFake({ posts: [postConFoto()], alunni: [] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.nascosta_motivo).toBe(MOTIVO_OBLIO)
  })

  it('post PROGRAMMATO con consenso caduto → ritirato PRIMA che il tick lo pubblichi', async () => {
    // La quarta strada: il gate copre POST, PATCH e `pubblica`, ma la promozione
    // automatica delle programmate non passa da nessun gate.
    const f = makeFake({
      posts: [postConFoto({ stato: 'programmata' })],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.stato).toBe('nascosta')
  })

  it('basta UN bambino senza consenso su tre perché il post esca', async () => {
    const f = makeFake({
      posts: [postConFoto({ bambini_ritratti: [AL_1, AL_2] })],
      alunni: [
        { id: AL_1, consenso_foto_sito: true, anonimizzato_il: null },
        { id: AL_2, consenso_foto_sito: false, anonimizzato_il: null },
      ],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(r.ritirati).toBe(1)
  })

  it('dichiarazione «nessun bambino ritratto» → il media editoriale non si tocca', async () => {
    const f = makeFake({ posts: [postConFoto({ bambini_ritratti: [] })] })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(r.esaminati).toBe(0)
    expect(f.removed).toHaveLength(0)
  })

  it('lettura dei consensi FALLITA → NESSUN ritiro, ma il guasto è rumoroso', async () => {
    // Qui «non lo so» non può valere «cancella»: il ritiro rimuove file dal
    // bucket ed è irreversibile. Il fail-closed del gate rifiuta di pubblicare —
    // gesto neutro; qui il gesto è distruttivo, e la risposta giusta a un guasto
    // di lettura è gridare, non demolire.
    const f = makeFake({
      posts: [postConFoto()],
      alunniError: { code: '08006', message: 'connection failure' },
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates).toHaveLength(0)
    expect(f.removed).toHaveLength(0)
    expect(r.verificato).toBe(false)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'consensi-non-riletti' }), expect.anything(),
    )
  })

  it('schema assente (DB E2E della CI non migrato) → silenzio, e il tick prosegue', async () => {
    const f = makeFake({ postsError: { code: '42703', message: 'column news_posts.bambini_ritratti does not exist' } })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(r.disponibile).toBe(false)
    expect(r.verificato).toBe(true)
    expect(f.removed).toHaveLength(0)
    expect(log.logEvento).not.toHaveBeenCalledWith('news', 'error', expect.anything(), expect.anything())
  })

  it('PRIMA il file, POI la riga: se l’UPDATE fallisce la foto è comunque sparita', async () => {
    // L'ordine è quello che il repo ha adottato il 2026-08-02 (vedi la testata di
    // `rimuoviFileOblio`), e qui la ragione è ancora più stretta: nascondere la
    // riga per prima e poi fallire la `remove()` lascerebbe l'immagine a un
    // indirizzo pubblico E toglierebbe il post dall'elenco dei ritirabili — cioè
    // un guasto invisibile e PERMANENTE, senza più niente da cui riprovare.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      updateError: { message: 'update rifiutato' },
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(percorsiRimossi(f.removed)).toContain('uploads/staff-1/1700-abc.jpg')
    expect(r.fileRimossi).toBe(2)
    // Il post è rimasto pubblicato: è un guasto, e si vede.
    expect(r.ritirati).toBe(0)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'ritiro-non-riuscito' }), expect.anything(),
    )
  })

  it('rimozione FALLITA → il post NON si nasconde, così il tick successivo riprova', async () => {
    // Nascondere il post qui sarebbe la mossa peggiore: uscirebbe dagli stati
    // esposti e nessuna passata futura lo riprenderebbe, mentre il file resta
    // servito dal bucket pubblico. Si lascia com'è e si grida.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      removeError: { message: 'storage down' },
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates, 'il post è stato nascosto mentre la foto è ancora pubblica').toHaveLength(0)
    expect(r.ritirati).toBe(0)
    expect(r.fileRimossi).toBe(0)
    expect(r.fileNonRimossi).toBe(2)
    expect(log.logEvento).toHaveBeenCalledWith(
      'storage', 'error', expect.objectContaining({ esito: 'file-non-rimossi' }), expect.anything(),
    )
  })

  it('lo Storage LANCIA (guasto di trasporto) → nessun ritiro dichiarato, mai un catch muto', async () => {
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      removeLancia: true,
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates).toHaveLength(0)
    expect(r.fileNonRimossi).toBe(2)
  })

  it('il file è ANCORA nel bucket dopo la `remove()` → non si dichiara fatto', async () => {
    // Lo Storage non fallisce sui percorsi che non esistono e risponde nominando
    // solo ciò che ha davvero tolto: contare invece di verificare è il difetto
    // che `rimuoviEVerifica` esiste per chiudere. Qui la foto c'è ancora.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      removeMuta: true,
      ancoraPresenti: ['1700-abc.jpg', '1700-xyz.png'],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates).toHaveLength(0)
    expect(r.ritirati).toBe(0)
    expect(r.fileNonRimossi).toBe(2)
  })

  it('il file NON c’era più → l’esito voluto è raggiunto: il post si ritira lo stesso', async () => {
    // «Non rimosso adesso» e «ancora lì» sono due fatti diversi, e solo il
    // secondo è un guasto: trattare un file già assente come un errore
    // bloccherebbe il ritiro per sempre, su una foto che non esiste più.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      removeMuta: true,
      ancoraPresenti: [],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(r.ritirati).toBe(1)
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.stato).toBe('nascosta')
  })

  it('post SENZA file nel bucket (un embed Instagram) → si ritira lo stesso', async () => {
    // Il ritiro non dipende dall'avere un file da togliere: la dichiarazione dei
    // bambini ritratti vale anche per un contenuto che vive altrove, e lasciarlo
    // pubblicato perché «non c'era niente da cancellare» sarebbe la stessa
    // confusione fra il file e il contenuto che ha prodotto il difetto.
    const f = makeFake({
      posts: [postConFoto({ copertina_url: null, contenuto_json: { type: 'doc', content: [] } })],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(r.ritirati).toBe(1)
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.nascosta_motivo).toBe(MOTIVO_CONSENSO_REVOCATO)
    expect(f.removed).toHaveLength(0)
  })

  it('logga anche il SUCCESSO, con i soli CONTEGGI: mai gli uuid dei bambini', async () => {
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    // Senza la riga di successo, «nessun log» direbbe insieme «tutto in regola»
    // e «la sorveglianza non è mai partita».
    const ok = log.logEvento.mock.calls.find(
      (c) => c[2] && (c[2] as Record<string, unknown>).esito === 'permanenza-verificata',
    )
    expect(ok, 'nessuna riga di successo: «nessun log» resta ambiguo').toBeTruthy()
    const scritto = JSON.stringify(log.logEvento.mock.calls)
    expect(scritto, 'un uuid di minore è finito nei log').not.toContain(AL_1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('verificaPermanenzaConsenso — anche una foto ferma in BOZZA è già pubblica (T18-V4c)', () => {
  // IL FATTO che rende necessario questo blocco: un media diventa PUBBLICO già
  // alla creazione del post (`promuoviMediaBozza`, chiamata da `news:POST` subito
  // dopo il gate), non alla pubblicazione. Sorvegliare i soli stati «esposti»
  // lasciava quindi scoperto proprio il caso più lungo: un articolo abbandonato
  // in bozza, con la foto del bambino già servita dal bucket pubblico e nessun
  // tick che la guardasse. La revoca della famiglia non ci arrivava mai.
  //
  // È la stessa forma di difetto delle rotte — la regola chiusa su una strada e
  // lasciata aperta su quella accanto — sull'asse degli STATI invece che su
  // quello delle rotte.

  it('la sorveglianza interroga il database anche su `bozza` e `proposta`', async () => {
    const f = makeFake({ posts: [] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const filtro = f.filtriIn.find((x) => x.table === 'news_posts' && x.colonna === 'stato')
    expect(filtro, 'la passata non filtra affatto per stato: il lock non misura più niente').toBeTruthy()
    expect(
      filtro!.valori,
      'gli stati non esposti restano fuori dalla sorveglianza: la foto in bozza è pubblica e non la guarda nessuno',
    ).toEqual(expect.arrayContaining(['pubblicata', 'programmata', 'bozza', 'proposta']))
  })

  it('`nascosta` NON è sorvegliata: un post già ritirato non si ritira ogni dieci minuti', async () => {
    // Idempotenza. Senza questo confine la passata riprenderebbe per sempre i
    // post già ritirati — una `remove()` e un `update` inutili a ogni tick, e un
    // canale di log sommerso dal rumore, che è il modo più efficace di non vedere
    // più i guasti veri.
    expect(STATI_SORVEGLIATI).not.toContain('nascosta')
  })

  it('post in BOZZA con consenso revocato → il file esce dal bucket pubblico e il post si ritira', async () => {
    const f = makeFake({
      posts: [postConFoto({ stato: 'bozza' })],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(percorsiRimossi(f.removed)).toEqual(
      expect.arrayContaining(['uploads/staff-1/1700-abc.jpg', 'uploads/staff-1/1700-xyz.png']),
    )
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd, 'nessuna scrittura: la bozza resta com’è e il ciclo ricomincia al prossimo tick').toBeTruthy()
    expect(upd!.rec.stato).toBe('nascosta')
    expect(upd!.rec.nascosta_motivo).toBe(MOTIVO_CONSENSO_REVOCATO)
    expect(r.ritirati).toBe(1)
  })

  it('post in PROPOSTA con minore obliato → stessa sorte (la strada accanto)', async () => {
    const f = makeFake({
      posts: [postConFoto({ stato: 'proposta' })],
      alunni: [{ id: AL_1, consenso_foto_sito: true, anonimizzato_il: '2026-08-03T10:00:00Z' }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd!.rec.nascosta_motivo).toBe(MOTIVO_OBLIO)
    expect(percorsiRimossi(f.removed)).toContain('uploads/staff-1/1700-abc.jpg')
  })

  it('CONTROLLO POSITIVO — bozza con consenso ancora valido → non si tocca niente', async () => {
    const f = makeFake({
      posts: [postConFoto({ stato: 'bozza' })],
      alunni: [{ id: AL_1, consenso_foto_sito: true, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.updates).toHaveLength(0)
    expect(f.removed).toHaveLength(0)
    expect(r.esaminati).toBe(1)
    expect(r.ritirati).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('obliaFotoNewsAlunno — il diritto alla cancellazione arriva al bucket pubblico (#1)', () => {
  it('ritira il post, toglie il file pubblico e cancella l’uuid dalla dichiarazione', async () => {
    const f = makeFake({ posts: [postConFoto()] })
    const r = await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd!.rec.stato).toBe('nascosta')
    expect(upd!.rec.nascosta_motivo).toBe(MOTIVO_OBLIO)
    // L'uuid di un bambino cancellato non può restare scritto nella riga: è un
    // riferimento a una persona che ha chiesto di sparire.
    expect(upd!.rec.bambini_ritratti).toEqual([])
    expect(percorsiRimossi(f.removed)).toContain('uploads/staff-1/1700-abc.jpg')
    expect(r.ritirati).toBe(1)
  })

  it('foto di GRUPPO → esce lo stesso dal bucket pubblico, e restano gli altri uuid', async () => {
    // Differenza voluta rispetto alla galleria: lì la foto di gruppo resta,
    // perché è privata e la vedono solo le famiglie dei bambini taggati. Qui
    // l'indirizzo è pubblico: lasciare il file vorrebbe dire lasciare online
    // l'immagine di chi ha chiesto la cancellazione.
    const f = makeFake({ posts: [postConFoto({ bambini_ritratti: [AL_1, AL_2] })] })
    await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')
    expect(upd!.rec.bambini_ritratti).toEqual([AL_2])
    expect(percorsiRimossi(f.removed)).toContain('uploads/staff-1/1700-abc.jpg')
  })

  it('nessun post ritrae quel minore → lo Storage non si tocca affatto', async () => {
    const f = makeFake({ posts: [] })
    const r = await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    expect(f.removed).toHaveLength(0)
    expect(r.ritirati).toBe(0)
  })

  it('schema assente → nessun rumore e nessuna rimozione', async () => {
    const f = makeFake({ postsError: { code: '42703', message: 'column does not exist' } })
    const r = await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    expect(r.ritirati).toBe(0)
    expect(f.removed).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('verificaPermanenzaConsenso — il tetto dei 200 post si vede e non taglia a caso (W2)', () => {
  // IL FATTO (collaudo del 2026-08-03, W2). La lettura è `.limit(200)` senza
  // nessun `.order()`: PostgreSQL non promette nessun ordine se non glielo si
  // chiede, quindi oltre i 200 post sorvegliati il sottoinsieme letto può
  // cambiare a ogni passata — e un post può non essere MAI riletto. Peggio: la
  // correzione della mattina ha ALLARGATO la popolazione sorvegliata (aggiunti
  // `bozza` e `proposta`) a parità di tetto, e nei log non c'era una sola riga
  // che dicesse che il tetto stava mordendo. Una revoca che non arriva è
  // indistinguibile da «non c'era niente da fare».

  it('la lettura dei post sorvegliati è ORDINATA', async () => {
    const f = makeFake({ posts: [] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const ordinePost = f.ordini.filter((o) => o.table === 'news_posts')
    expect(
      ordinePost.length,
      'la passata legge 200 post senza ordinarli: oltre il tetto il sottoinsieme letto è arbitrario ' +
        'e un post può non essere riletto mai',
    ).toBeGreaterThan(0)
    // Il pareggio va rotto, altrimenti «ordinato» resta «ordinato a metà»: due
    // righe con lo stesso istante tornerebbero in ordine libero.
    expect(ordinePost.map((o) => o.colonna)).toContain('id')
  })

  it('si parte dai post riletti PIÙ TEMPO FA: la direzione è ASCENDENTE', async () => {
    // «Ordinato» non basta, e il verso opposto non è «meno ordinato»: è
    // ATTIVAMENTE peggio del disordine di partenza. `ritiraPost` riscrive
    // `updated_at`, quindi con `{ ascending: false }` in testa alla coda tornano
    // sempre i post appena toccati — cioè quelli che non hanno più niente da
    // dire — e i 200 più vecchi, che sono esattamente quelli il cui consenso non
    // si rilegge da più tempo, non vengono raggiunti MAI. Il disordine almeno
    // lasciava a ciascuno una probabilità.
    const f = makeFake({ posts: [] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const perUpdatedAt = f.ordini.find((o) => o.table === 'news_posts' && o.colonna === 'updated_at')
    expect(
      perUpdatedAt,
      'la passata non ordina più per `updated_at`: senza quella colonna «dal più vecchio» non ' +
        'significa niente e il tetto torna a tagliare un sottoinsieme qualunque',
    ).toBeTruthy()
    expect(
      perUpdatedAt!.ascendente,
      'la lettura parte dai post modificati PIÙ DI RECENTE: il ritiro riscrive `updated_at`, quindi ' +
        'la finestra si riempie di post appena trattati e la coda dei più vecchi non viene mai letta',
    ).toBe(true)
  })

  it('la chiave PRIMARIA dell’ordinamento è `updated_at`, non `id`', async () => {
    // PostgREST compone gli `.order()` nell'ordine in cui li riceve. Se `id`
    // arrivasse per primo, la finestra dei 200 si congelerebbe sui primi 200 uuid
    // in assoluto: il 201° non verrebbe riletto MAI, per sempre, e nemmeno
    // trattare i primi 200 lo libererebbe — l'ordine per `id` non cambia quando
    // un post viene ritirato. `id` serve SOLO a rompere il pareggio fra due righe
    // con lo stesso istante.
    const f = makeFake({ posts: [] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const ordinePost = f.ordini.filter((o) => o.table === 'news_posts')
    expect(
      ordinePost.map((o) => o.colonna),
      'l’ordinamento non è più «prima `updated_at`, poi `id`»: se `id` viene prima, la finestra dei ' +
        '200 post si congela sui primi uuid e chi sta oltre non viene riletto mai',
    ).toEqual(['updated_at', 'id'])
  })

  it('tetto RAGGIUNTO → un warn lo dice, con il numero', async () => {
    const posts = Array.from({ length: 200 }, (_, i) => postConFoto({ id: `post-${i}`, bambini_ritratti: [] }))
    const f = makeFake({ posts })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const avviso = log.logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && (c[2] as Record<string, unknown>)?.esito === 'tetto-post-raggiunto',
    )
    expect(
      avviso,
      'il tetto ha morso e nei log non c’è niente che lo dica: la sorveglianza sembra completa ' +
        'mentre un sottoinsieme di post non viene riletto',
    ).toBeTruthy()
  })

  it('CONTROLLO POSITIVO — sotto il tetto nessun avviso, altrimenti è rumore a ogni tick', async () => {
    const f = makeFake({ posts: [postConFoto({ bambini_ritratti: [] })] })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const avviso = log.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.esito === 'tetto-post-raggiunto',
    )
    expect(avviso).toBeFalsy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('liberaPercorsiPubblici — la stessa regola per il ritiro, la DELETE e la PATCH', () => {
  // La PATCH non libera TUTTI i file del post: libera quelli che la riga smette
  // di nominare. Perciò la primitiva prende dei percorsi, e
  // `liberaFilePubbliciDelPost` è il caso particolare «tutti quelli del post».
  // Una regola valida per tre strade deve vivere in un posto solo.

  it('toglie i percorsi indicati dal bucket PUBBLICO e dichiara `liberato`', async () => {
    const f = makeFake({})
    const r = await liberaPercorsiPubblici(f.client as never, ['uploads/staff-1/1700-abc.jpg'], POST_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual(['uploads/staff-1/1700-abc.jpg'])
    expect(r.liberato).toBe(true)
    expect(r.rimossi).toBe(1)
  })

  it('il file è ANCORA nel bucket → NON liberato, e chi chiama non deve toccare la riga', async () => {
    const f = makeFake({ removeMuta: true, ancoraPresenti: ['1700-abc.jpg'] })
    const r = await liberaPercorsiPubblici(f.client as never, ['uploads/staff-1/1700-abc.jpg'], POST_1, 'test')
    expect(r.liberato).toBe(false)
    expect(r.nonRimossi).toBe(1)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'file-pubblici-non-liberati' }),
    )
  })

  it('nessun percorso → lo Storage non si tocca affatto', async () => {
    const f = makeFake({})
    const r = await liberaPercorsiPubblici(f.client as never, [], POST_1, 'test')
    expect(f.removed).toHaveLength(0)
    expect(r.liberato).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('«c’è ancora qualcuno che lo nomina?» — il file di un ALTRO post non si cancella', () => {
  // LA REGRESSIONE (2026-08-03), dimostrata eseguendola e non deducendola. La
  // correzione di W1 ha dato a `PATCH` e `DELETE` una `remove()` sul bucket
  // pubblico in service-role, e nessuna delle due chiedeva di CHI fosse il file:
  // `percorsoPubblicoNews` valida la FORMA dell'indirizzo, mai la proprietà.
  // Bastavano due mosse — metto nel mio rich-text l'indirizzo pubblico
  // dell'immagine di un altro articolo (lo conosce chiunque legga il sito), poi
  // lo tolgo — perché quel percorso finisse fra gli `usciti` e uscisse dal bucket.
  // La riga della vittima continuava a nominarlo: immagine rotta, permanente,
  // invisibile.
  //
  // I DUE VERSANTI, e servono entrambi: un controllo troppo largo non libera più
  // niente e riporta i file pubblici orfani del difetto V4 — irraggiungibili da
  // revoca e oblio, che partono dalla riga. Perciò a ogni «non si cancella» qui
  // sotto corrisponde un «si cancella lo stesso».

  const MIO = 'uploads/edu-attaccante/1800-mio.jpg'
  const DI_UN_ALTRO = 'uploads/staff-vittima/1700-vittima.jpg'
  const ALTRO_POST = '44444444-4444-4444-8444-444444444444'
  const pubblico = (p: string) => `https://esempio.supabase.co/storage/v1/object/public/news/${p}`

  it('un’altra riga lo nomina → NIENTE `remove()`, ma l’operazione prosegue', async () => {
    const f = makeFake({
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null }],
    })
    const r = await liberaPercorsiPubblici(f.client as never, [DI_UN_ALTRO], POST_1, 'test')
    expect(
      percorsiRimossi(f.removed),
      'il file di un altro articolo è finito dentro una `remove()` in service-role',
    ).toEqual([])
    // «Liberato» perché questa riga può smettere di nominarlo: è il FILE che non
    // si tocca, non l'operazione. Bloccare qui vorrebbe dire che nessuno può più
    // modificare o cancellare un post che cita l'immagine di un altro.
    expect(r.liberato).toBe(true)
    expect(r.rimossi).toBe(0)
    expect(r.trattenuti).toBe(1)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'warn', expect.objectContaining({ esito: 'file-nominato-da-un-altro-post' }),
    )
  })

  it('CONTROLLO POSITIVO (difetto V4) — nessun altro lo nomina → il file esce davvero', async () => {
    // Senza questo, «non cancella il file altrui» sarebbe verde anche in un
    // mondo dove non si cancella più niente: i file pubblici resterebbero per
    // sempre, e revoca e oblio non potrebbero più arrivarci.
    const f = makeFake({ altriPost: [] })
    const r = await liberaPercorsiPubblici(f.client as never, [MIO], POST_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([MIO])
    expect(r.rimossi).toBe(1)
    expect(r.trattenuti).toBe(0)
  })

  it('una riga che nomina un file DIVERSO non trattiene niente', async () => {
    // La ricerca nel database è larga per costruzione (`ilike` tratta `_` e `%`
    // come jolly): se bastasse una riga qualunque nel risultato per dichiarare il
    // file «di un altro», un nome simile terrebbe nel bucket una foto che nessuno
    // usa più. La conferma è esatta, riga per riga.
    const f = makeFake({
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null }],
    })
    const r = await liberaPercorsiPubblici(f.client as never, [MIO], POST_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([MIO])
    expect(r.trattenuti).toBe(0)
  })

  it('lo nomina SOLO il `contenuto_json` di un altro post — nient’altro', async () => {
    // ERA IL TEST FINTO PIÙ COSTOSO DEL GIRO 1. La riga della vittima nomina il
    // file soltanto dentro il JSON: `copertina_url` è null, `contenuto_html` è
    // null (riga vecchia, o rich-text il cui `<img>` il sanitizer ha scartato
    // lasciando l'indirizzo nel JSON), e `contenuto_testo` non contiene MAI
    // l'indirizzo di un'immagine perché `estraiTesto` toglie i tag. La domanda
    // chiedeva al database `ilike` su quelle tre colonne — `ilike` non si applica
    // a una `jsonb` — quindi in produzione questa riga non tornava e il file
    // usciva; il test restava verde perché il finto client non applicava il
    // filtro. Oggi non c'è nessun filtro: si legge e si confronta con la stessa
    // funzione, e questo caso è vero come sembrava.
    const f = makeFake({
      altriPost: [{
        id: ALTRO_POST,
        copertina_url: null,
        contenuto_html: null,
        contenuto_testo: 'Una giornata alla Kidville',
        contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(DI_UN_ALTRO) } }] },
      }],
    })
    const r = await liberaPercorsiPubblici(f.client as never, [DI_UN_ALTRO], POST_1, 'test')
    expect(
      percorsiRimossi(f.removed),
      'la riga della vittima nomina il file solo nel JSON e il file è uscito lo stesso',
    ).toEqual([])
    expect(r.trattenuti).toBe(1)
  })

  it('lo nomina solo l’HTML già pubblicato di un altro post → si tiene lo stesso', async () => {
    // `/api/news/feed` serve `contenuto_html`: una riga il cui HTML mostra ancora
    // quell'immagine la sta usando davvero, anche se il JSON non la cita più.
    const f = makeFake({
      altriPost: [{
        id: ALTRO_POST,
        copertina_url: null,
        contenuto_json: { type: 'doc', content: [] },
        contenuto_html: `<p><img src="${pubblico(DI_UN_ALTRO)}"></p>`,
      }],
    })
    const r = await liberaPercorsiPubblici(f.client as never, [DI_UN_ALTRO], POST_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([])
    expect(r.trattenuti).toBe(1)
  })

  it('la riga DEL POST STESSO non conta: il file esce anche se è lei a nominarlo', async () => {
    // L'ESCLUSIONE, misurata dall'effetto e non dalla stringa del filtro. Tutte e
    // tre le strade liberano PRIMA di toccare la riga, quindi in quell'istante il
    // post cita ancora i propri file: senza l'esclusione la risposta sarebbe
    // sempre «sì, qualcuno lo nomina» e non uscirebbe più niente — il difetto V4,
    // cioè l'opposto di quello che il controllo chiude. Qui la riga del post è
    // DENTRO le righe che il database restituirebbe, e il file deve uscire lo
    // stesso; il finto applica il filtro davvero, quindi togliere l'esclusione
    // dal codice fa cadere questo test.
    const f = makeFake({
      altriPost: [{ id: POST_1, copertina_url: pubblico(MIO), contenuto_json: null }],
    })
    const r = await liberaPercorsiPubblici(f.client as never, [MIO], POST_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([MIO])
    expect(r.trattenuti).toBe(0)
    // …e l'esclusione è arrivata al database, non solo alla memoria: il taglio
    // deve avvenire di là, altrimenti la finestra di 200 righe si riempie di righe
    // che vanno scartate e qualcuno resta fuori dalla passata.
    expect(f.citazioni, 'nessuno ha chiesto al database di chi sia il file').toHaveLength(1)
    expect(f.citazioni[0].esclusi).toContain(POST_1)
  })

  it('la domanda si fa a PAGINE ordinate, e la prima parte da capo', async () => {
    const f = makeFake({ altriPost: [] })
    await liberaPercorsiPubblici(f.client as never, [MIO], POST_1, 'test')
    expect(f.citazioni[0].da).toBe(0)
    expect(f.citazioni[0].a).toBeGreaterThan(0)
    const perId = f.ordini.filter((o) => o.table === 'news_posts' && o.colonna === 'id')
    expect(
      perId,
      'la passata legge a finestre senza ordinare: due pagine possono ridare la stessa riga e ' +
        'saltarne un’altra, e la riga saltata è quella che nomina il file',
    ).not.toHaveLength(0)
    expect(perId[0].ascendente).toBe(true)
  })

  it('la lettura FALLISCE → non si rimuove niente e non si dichiara fatto', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Senza il controllo del ritorno,
    // un guasto di lettura passerebbe per «nessun altro lo usa» e il file di un
    // altro articolo sparirebbe proprio nel momento in cui si sa di meno.
    const f = makeFake({ altriPostError: { code: '08006', message: 'connection failure' } })
    const r = await liberaPercorsiPubblici(f.client as never, [MIO], POST_1, 'test')
    expect(f.removed).toHaveLength(0)
    expect(r.liberato).toBe(false)
    expect(r.nonRimossi).toBe(1)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'citazioni-non-lette' }), expect.anything(),
    )
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'proprieta-file-non-verificata' }),
    )
  })

  it('IL RITIRO per consenso revocato non porta via il file di un altro post', async () => {
    // La terza strada. Un attaccante che dichiara nel proprio post un bambino il
    // cui consenso è caduto otterrebbe altrimenti la stessa cancellazione, per
    // mano del tick invece che della propria PATCH.
    const f = makeFake({
      posts: [postConFoto({ copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(MIO) } }] } })],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(percorsiRimossi(f.removed), 'il ritiro ha cancellato il file di un altro articolo').toEqual([MIO])
    // Il post si ritira lo stesso: la foto del bambino non resta pubblicata
    // perché uno dei due file non si è potuto togliere.
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.stato).toBe('nascosta')
    expect(r.ritirati).toBe(1)
  })

  it('L’OBLIO del minore, stessa strada e stessa risposta', async () => {
    const f = makeFake({
      posts: [postConFoto({ copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null })],
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null }],
    })
    const r = await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([])
    expect(f.updates.find((u) => u.table === 'news_posts')!.rec.nascosta_motivo).toBe(MOTIVO_OBLIO)
    expect(r.ritirati).toBe(1)
  })

  it('nei log solo conteggi: mai il percorso, che porta l’uuid di chi ha caricato', async () => {
    const f = makeFake({
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(DI_UN_ALTRO), contenuto_json: null }],
    })
    await liberaPercorsiPubblici(f.client as never, [DI_UN_ALTRO], POST_1, 'test')
    const scritto = JSON.stringify(log.logEvento.mock.calls)
    expect(scritto, 'un percorso dello storage è finito nei log').not.toContain(DI_UN_ALTRO)
    expect(scritto).not.toContain('staff-vittima')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DUE POST, LO STESSO BAMBINO, LA STESSA FOTO — l’oblio deve arrivarci lo stesso', () => {
  // ⚠️ LA REGRESSIONE CHE LA CORREZIONE DEL GIRO 1 HA INTRODOTTO, e nessun test
  // della batteria la vedeva: in tutta la suite non esisteva un caso con DUE post
  // che dichiarano lo stesso minore e condividono lo stesso file.
  //
  // Il meccanismo, dimostrato eseguendolo: A non libera perché B nomina il file,
  // B non libera perché lo nomina A, tutti e due finiscono `nascosta` — e
  // `nascosta` non è in `STATI_SORVEGLIATI`, quindi nessuna passata li riprende
  // MAI. La foto del minore resta a un indirizzo PUBBLICO per sempre, con un solo
  // `warn`. Prima della correzione la `remove()` era incondizionata e l'oblio
  // funzionava: era una regressione vera, non un difetto scoperto.
  //
  // Le asserzioni sono sulla `remove()`, non sui conteggi: «ritirati: 2» era il
  // numero che il giro 1 mostrava mentre il file restava esattamente dov'era.

  const CONDIVISA = 'uploads/staff-1/1700-abc.jpg'
  const POST_2 = '66666666-6666-4666-8666-666666666666'

  it('OBLIO — la foto condivisa da due post dello stesso bambino esce dal bucket', async () => {
    const f = makeFake({
      posts: [
        postConFoto({ id: POST_1, contenuto_json: null }),
        postConFoto({ id: POST_2, contenuto_json: null }),
      ],
      // Il database, alla domanda «chi lo nomina?», restituisce ENTRAMBE le righe:
      // sono le stesse che la passata sta ritirando.
      altriPost: [
        { id: POST_1, copertina_url: COPERTINA, contenuto_json: null },
        { id: POST_2, copertina_url: COPERTINA, contenuto_json: null },
      ],
    })
    const r = await obliaFotoNewsAlunno(f.client as never, AL_1, 'test')
    expect(
      percorsiRimossi(f.removed),
      'i due post si sono tenuti in ostaggio la foto a vicenda: resta a un indirizzo PUBBLICO, ' +
        'e finiscono entrambi `nascosta`, stato che nessuna passata riprende mai',
    ).toContain(CONDIVISA)
    expect(r.ritirati).toBe(2)
    expect(r.fileTrattenuti).toBe(0)
  })

  it('REVOCA — stessa scena dal tick, e stesso esito', async () => {
    const f = makeFake({
      posts: [
        postConFoto({ id: POST_1, contenuto_json: null }),
        postConFoto({ id: POST_2, contenuto_json: null }),
      ],
      altriPost: [
        { id: POST_1, copertina_url: COPERTINA, contenuto_json: null },
        { id: POST_2, copertina_url: COPERTINA, contenuto_json: null },
      ],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(percorsiRimossi(f.removed)).toContain(CONDIVISA)
    expect(r.ritirati).toBe(2)
    expect(r.fileTrattenuti).toBe(0)
  })

  it('l’esclusione è DICHIARATA IN ANTICIPO: già alla prima liberazione ci sono tutti', async () => {
    // Non basta che il file esca alla fine: deve uscire al PRIMO ritiro. Se la
    // passata dichiarasse solo il post di turno, il primo troverebbe il secondo a
    // nominarlo e lo tratterrebbe — e il secondo, che arriva dopo, trova il primo
    // ormai `nascosta`. Funzionerebbe lo stesso, ma per la seconda regola invece
    // che per la prima, e su una passata con un post solo per volta non
    // funzionerebbe affatto.
    const f = makeFake({
      posts: [postConFoto({ id: POST_1, contenuto_json: null }), postConFoto({ id: POST_2, contenuto_json: null })],
      altriPost: [
        { id: POST_1, copertina_url: COPERTINA, contenuto_json: null },
        { id: POST_2, copertina_url: COPERTINA, contenuto_json: null },
      ],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(f.citazioni[0].esclusi).toEqual(expect.arrayContaining([POST_1, POST_2]))
  })

  it('CONTROLLO POSITIVO — il post che il bambino NON lo dichiara trattiene, e si CONTA', async () => {
    // Il confine dell'esclusione: chi non è nella passata resta padrone dei suoi
    // file, e la sua immagine non si rompe. Ma allora la foto del bambino resta
    // pubblica, e questo non può essere un `warn` che si perde: risale come
    // numero fino al cron.
    const ESTRANEO = '77777777-7777-4777-8777-777777777777'
    const f = makeFake({
      posts: [postConFoto({ id: POST_1, contenuto_json: null })],
      altriPost: [{ id: ESTRANEO, copertina_url: COPERTINA, contenuto_json: null }],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    const r = await verificaPermanenzaConsenso(f.client as never, 'test')
    expect(percorsiRimossi(f.removed)).toEqual([])
    expect(r.ritirati).toBe(1)
    expect(r.fileTrattenuti).toBe(1)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'file-trattenuti-dopo-il-ritiro', n_file: 1 }),
    )
  })

  it('la riga ritirata SMETTE di nominare il file che non esiste più', async () => {
    // Una citazione fantasma è una risposta sbagliata che sembra giusta: alla
    // prossima domanda «c'è ancora qualcuno che lo nomina?» questa riga
    // risponderebbe «io», e tratterrebbe nel bucket pubblico la foto di un altro
    // bambino. Il testo dell'articolo, invece, non si tocca: il post è nascosto,
    // non cancellato, e la scuola deve poterlo ripubblicare.
    const f = makeFake({
      posts: [postConFoto()],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')!
    expect(upd.rec.copertina_url, 'la riga nomina ancora una copertina che non esiste più').toBeNull()
    expect(JSON.stringify(upd.rec.contenuto_json)).not.toContain('1700-xyz.png')
    // …e il testo dell'articolo è rimasto dov'era.
    expect(JSON.stringify(upd.rec.contenuto_json)).toContain('Una giornata alla Kidville')
  })

  it('CONTROLLO POSITIVO — il file TRATTENUTO resta nominato: la riga dice il vero', async () => {
    // Il verso opposto, e serve: azzerare i campi «tanto il post è nascosto»
    // toglierebbe alla riga l'unico modo di dire che quel file c'è ancora, e alla
    // prossima passata nessuno saprebbe più che è rimasto pubblico.
    const ESTRANEO = '77777777-7777-4777-8777-777777777777'
    const f = makeFake({
      posts: [postConFoto({ contenuto_json: null })],
      altriPost: [{ id: ESTRANEO, copertina_url: COPERTINA, contenuto_json: null }],
      alunni: [{ id: AL_1, consenso_foto_sito: false, anonimizzato_il: null }],
    })
    await verificaPermanenzaConsenso(f.client as never, 'test')
    const upd = f.updates.find((u) => u.table === 'news_posts')!
    expect(upd.rec.copertina_url).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('percorsiCitatiDaAltriPost — la primitiva, interrogata da sola', () => {
  const P = 'uploads/staff-1/1700-abc.jpg'
  const ALTRO_POST = '44444444-4444-4444-8444-444444444444'

  const pubblico = (p: string) => `https://esempio.supabase.co/storage/v1/object/public/news/${p}`

  it('nessun percorso da cercare → il database non si interroga affatto', async () => {
    const f = makeFake({ altriPost: [{ id: ALTRO_POST, copertina_url: 'x' }] })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [], [POST_1], 'test')
    expect(f.citazioni).toHaveLength(0)
    expect(r).toEqual({ verificato: true, citati: [] })
  })

  it('molti percorsi, una passata sola: nessuna risposta va persa', async () => {
    // La passata non è più spezzata PER PERCORSO (lo era finché si costruiva un
    // filtro testuale, e spezzando si poteva perdere una risposta): si legge una
    // volta e si confronta ogni riga con tutti i percorsi. Qui il file citato è il
    // decimo, cioè quello che una spezzatura sbagliata perderebbe.
    const percorsi = Array.from({ length: 10 }, (_, i) => `uploads/staff-1/f-${i}.jpg`)
    const f = makeFake({
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(percorsi[9]), contenuto_json: null }],
    })
    const r = await percorsiCitatiDaAltriPost(f.client as never, percorsi, [POST_1], 'test')
    expect(r.verificato).toBe(true)
    expect(r.citati).toEqual([percorsi[9]])
  })

  it('il TETTO delle pagine morde → «non lo so», che qui non vale «cancella»', async () => {
    // 5001 post e nessuno che nomini il file: la passata non li esaurisce, quindi
    // sui percorsi rimasti la risposta non è «nessuno lo nomina» ma «non ho finito
    // di guardare». Il finto TAGLIA davvero la finestra (`range`), quindi il tetto
    // è quello del codice e non un artificio del test: nel giro 1 questo caso era
    // verde solo perché il finto restituiva l'elenco intero a ogni chiamata.
    const altriPost = Array.from({ length: 5001 }, (_, i) => ({
      id: `altro-${String(i).padStart(5, '0')}`,
      copertina_url: pubblico(`uploads/u/f-${i}.jpg`),
      contenuto_json: null,
    }))
    const f = makeFake({ altriPost })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1], 'test')
    expect(r.verificato).toBe(false)
    expect(f.citazioni.length, 'la passata non ha nemmeno provato a paginare').toBe(25)
    expect(log.logEvento).toHaveBeenCalledWith(
      'news', 'error', expect.objectContaining({ esito: 'tetto-citazioni-raggiunto' }),
    )
  })

  it('CONTROLLO POSITIVO — sotto il tetto la passata si ferma da sola e risponde', async () => {
    // Senza, «il tetto morde» sarebbe verde anche in un codice che non risponde
    // mai «nessuno», cioè che non libera più niente (difetto V4).
    const altriPost = Array.from({ length: 250 }, (_, i) => ({
      id: `altro-${String(i).padStart(5, '0')}`,
      copertina_url: pubblico(`uploads/u/f-${i}.jpg`),
      contenuto_json: null,
    }))
    const f = makeFake({ altriPost })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1], 'test')
    expect(r).toEqual({ verificato: true, citati: [] })
    expect(f.citazioni.length, 'due pagine bastano per 250 righe: la seconda è corta e chiude').toBe(2)
  })

  it('trovato chi lo nomina → la passata si ferma lì, senza leggere il resto', async () => {
    const altriPost = Array.from({ length: 250 }, (_, i) => ({
      id: `altro-${String(i).padStart(5, '0')}`,
      copertina_url: i === 0 ? pubblico(P) : null,
      contenuto_json: null,
    }))
    const f = makeFake({ altriPost })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1], 'test')
    expect(r.citati).toEqual([P])
    expect(f.citazioni.length).toBe(1)
  })

  it('un percorso con una VIRGOLA si libera come gli altri', async () => {
    // Finché la domanda era un filtro testuale, una virgola dentro il nome del
    // file cambiava la QUERY invece del risultato: quel percorso non si poteva
    // chiedere, quindi non si poteva liberare, quindi restava pubblico per sempre
    // — il difetto V4 per una porta laterale. Senza filtro il problema non esiste
    // più, e questo test è lì perché non torni.
    const conVirgola = 'uploads/staff-1/1700-abc,def.jpg'
    const f = makeFake({ altriPost: [] })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [conVirgola], [POST_1], 'test')
    expect(r).toEqual({ verificato: true, citati: [] })
  })

  it('un post GIÀ RITIRATO per consenso non conta come chi lo nomina', async () => {
    // La regressione del giro 1, presa alla radice. `ritiraPost` scrive `nascosta`
    // solo dopo una liberazione riuscita: quella riga ha già perso i suoi file, e
    // se uno è rimasto è perché in quel momento un ALTRO lo nominava. Contarla
    // significa che due post ritirati si tengono in ostaggio a vicenda e la foto
    // del bambino resta pubblica per sempre.
    const f = makeFake({
      altriPost: [{
        id: ALTRO_POST,
        stato: 'nascosta',
        nascosta_motivo: MOTIVO_CONSENSO_REVOCATO,
        copertina_url: pubblico(P),
        contenuto_json: null,
      }],
    })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1], 'test')
    expect(r.citati).toEqual([])
  })

  it('nascosto per un ALTRO motivo, invece, i suoi file se li tiene', async () => {
    // Il confine è stretto di proposito: `instagram-non-raggiungibile` nasconde il
    // post ma non gli ha tolto niente. Allargare la regola a «nascosta» e basta
    // farebbe cancellare l'immagine di un articolo che è solo momentaneamente
    // fuori dalla vista.
    const f = makeFake({
      altriPost: [{
        id: ALTRO_POST,
        stato: 'nascosta',
        nascosta_motivo: 'instagram-non-raggiungibile',
        copertina_url: pubblico(P),
        contenuto_json: null,
      }],
    })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1], 'test')
    expect(r.citati).toEqual([P])
  })

  it('gli ALTRI post che la stessa passata sta ritirando non contano', async () => {
    const f = makeFake({
      altriPost: [{ id: ALTRO_POST, copertina_url: pubblico(P), contenuto_json: null }],
    })
    const r = await percorsiCitatiDaAltriPost(f.client as never, [P], [POST_1, ALTRO_POST], 'test')
    expect(r.citati).toEqual([])
    expect(f.citazioni[0].esclusi).toEqual(expect.arrayContaining([POST_1, ALTRO_POST]))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('percorsiPubbliciEstranei — un post non ADOTTA il file di un altro', () => {
  // La difesa complementare, che chiude il passo 1 invece del passo 2. Vive qui e
  // non nella rotta perché la domanda «di chi è questo file?» è la stessa di
  // sopra, e una regola valida per due strade sta in un posto solo.
  const ATTORE = 'edu-1'
  const MIO_APPENA_CARICATO = 'uploads/edu-1/1800-nuovo.jpg'
  const GIA_NEL_POST = 'uploads/staff-9/1700-vecchio.jpg'
  const DI_UN_ALTRO = 'uploads/staff-vittima/1700-vittima.jpg'
  const pubblico = (p: string) => `https://esempio.supabase.co/storage/v1/object/public/news/${p}`

  it('l’indirizzo di un ALTRO articolo è estraneo', () => {
    expect(
      percorsiPubbliciEstranei({ copertina_url: pubblico(DI_UN_ALTRO) }, [GIA_NEL_POST], ATTORE),
    ).toEqual([DI_UN_ALTRO])
  })

  it('lo trova anche dentro il rich-text, non solo in copertina', () => {
    const estranei = percorsiPubbliciEstranei(
      { contenuto_json: { type: 'doc', content: [{ type: 'image', attrs: { src: pubblico(DI_UN_ALTRO) } }] } },
      [],
      ATTORE,
    )
    expect(estranei).toEqual([DI_UN_ALTRO])
  })

  it('CONTROLLO POSITIVO — ciò che il post GIÀ nomina passa', () => {
    // L'editor rimanda gli indirizzi definitivi delle immagini salvate: rifiutarli
    // bloccherebbe qualunque modifica di qualunque articolo con una foto.
    expect(percorsiPubbliciEstranei({ copertina_url: pubblico(GIA_NEL_POST) }, [GIA_NEL_POST], ATTORE)).toEqual([])
  })

  it('CONTROLLO POSITIVO — ciò che ha caricato l’attore passa (bucket di sosta assente)', () => {
    // Finché la migrazione di `news_bozze` non è applicata, `news/upload:POST`
    // ricade sul bucket pubblico e restituisce già un indirizzo pubblico: senza
    // questo ramo, su quegli ambienti nessuno potrebbe più aggiungere un'immagine.
    expect(percorsiPubbliciEstranei({ copertina_url: pubblico(MIO_APPENA_CARICATO) }, [], ATTORE)).toEqual([])
  })

  it('attore senza identità → non si concede niente', () => {
    expect(percorsiPubbliciEstranei({ copertina_url: pubblico(MIO_APPENA_CARICATO) }, [], '')).toEqual([
      MIO_APPENA_CARICATO,
    ])
  })

  it('un indirizzo che non è di questo bucket non è affare di questa regola', () => {
    // Un embed Instagram, o l'immagine della galleria privata: non sono oggetti
    // del bucket `news` e nessuna `remove()` potrà mai raggiungerli.
    const estranei = percorsiPubbliciEstranei(
      {
        copertina_url: 'https://www.instagram.com/p/abc/',
        contenuto_json: { content: [{ type: 'text', text: 'uploads/staff-vittima/1700-vittima.jpg' }] },
      },
      [],
      ATTORE,
    )
    expect(estranei).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('lock · il registro dell’oblio non può più dire il falso su `news`', () => {
  it('`news` NON è più escluso con la motivazione «qui non ci sono foto di bambini»', () => {
    const voce = REGISTRO_BUCKET_OBLIO.news
    expect(
      voce.stato,
      'Il bucket `news` è PUBBLICO e il gate del consenso autorizza apposta le foto dei minori ' +
        'con il consenso al canale «sito»: dichiararlo escluso perché «ci vanno solo media ' +
        'editoriali» è una motivazione che descrive un prodotto diverso da questo. Una ' +
        'motivazione falsa passa il lock esattamente come una vera — ed è ciò che ha lasciato ' +
        'online la foto di un bambino dopo il suo oblio.',
    ).not.toBe('escluso')
  })

  it('la voce nomina il MECCANISMO che lo svuota, non una promessa', () => {
    const voce = REGISTRO_BUCKET_OBLIO.news
    const come = voce.stato === 'escluso' ? '' : voce.come
    expect(come).toContain('permanenza-consenso')
    expect(come.length).toBeGreaterThan(80)
  })
})
