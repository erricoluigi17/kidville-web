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
  percorsiPubbliciDelPost,
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
  const client = {
    from(table: string) {
      const st = { isUpdate: false, rec: {} as Record<string, unknown>, eq: {} as Record<string, unknown> }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { st.eq[c] = v; return b }
      b.in = () => b
      b.not = () => b
      b.is = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.contains = () => b
      b.update = (rec: Record<string, unknown>) => { st.isUpdate = true; st.rec = rec; return b }
      const resolve = (): { data: unknown; error: unknown } => {
        if (st.isUpdate) {
          updates.push({ table, rec: st.rec, id: st.eq.id })
          return { data: null, error: cfg.updateError ?? null }
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
  return { client, updates, removed }
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
