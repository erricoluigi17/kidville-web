import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// CANCELLARE IL POST NON CANCELLAVA LA FOTO — e dopo non restava più niente da
// cui ritrovarla.
//
// IL DIFETTO (collaudo del 2026-08-03, V4). `DELETE /api/news/[id]` toglieva la
// riga da `news_posts` e non toccava il bucket `news`, che è PUBBLICO e servito
// senza login. L'articolo spariva dal sito; l'immagine del bambino restava al suo
// indirizzo, raggiungibile da chiunque lo conoscesse, e — peggio — senza più
// nessuna riga che la nominasse: né il ritiro per consenso caduto
// (`verificaPermanenzaConsenso` legge `news_posts`), né l'oblio del minore
// (`obliaFotoNewsAlunno`, che cerca l'uuid dentro `bambini_ritratti`) potevano
// più arrivarci. Un guasto invisibile e PERMANENTE, prodotto dal gesto che
// sembra il più definitivo di tutti.
//
// LA REGOLA ESISTEVA GIÀ, in un posto solo: «PRIMA il file (verificato), POI la
// riga» (testata di `ritiraPost`, `src/lib/news/permanenza-consenso.ts`). Non è
// stata riscritta qui: la DELETE chiama la stessa funzione del ritiro. Una regola
// valida per due strade deve vivere in un posto solo, altrimenti diverge in
// silenzio — che è la causa radice di tutta questa serie di difetti.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  sanificaContenuto: vi.fn(),
  post: null as Record<string, unknown> | null,
  /**
   * Le ALTRE righe di `news_posts`, cioè quelle che possono possedere i file.
   * Insieme DIVERSO da `post`: «il post che si cancella» e «il post che possiede
   * il file» sono le due grandezze che la regressione del 2026-08-03 confondeva.
   */
  altriPost: [] as Array<Record<string, unknown>>,
  /**
   * Le interrogazioni sulla proprietà viste passare: gli id ESCLUSI e la finestra.
   * Il finto le risolve come il database — esclusione applicata, righe ordinate
   * per id, pagina tagliata. Nel giro 1 registrava il filtro e restituiva comunque
   * tutte le righe: così un codice che cerca nel posto sbagliato ha lo stesso
   * colore di uno giusto, ed è precisamente il modo in cui il difetto è passato.
   */
  citazioni: [] as Array<{ esclusi: string[]; da: number; a: number }>,
  /** L'ordine dei fatti: la `remove()` deve precedere la `delete()`. */
  eventi: [] as string[],
  rimossi: [] as Array<{ bucket: string; paths: string[] }>,
  removeError: null as { message: string } | null,
  removeLancia: false,
  /** `remove()` non nomina nessun oggetto: tocca alla verifica dire come sta. */
  removeMuta: false,
  /** I NOMI dei file che, interrogando lo Storage, risultano ANCORA presenti. */
  ancoraPresenti: [] as string[],
  errDelete: null as { code?: string; message: string } | null,
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
        esclusi: null as string[] | null,
        finestra: null as { da: number; a: number } | null,
      }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'news_posts' && st.op === 'delete') {
          return { data: null, error: h.errDelete }
        }
        // La domanda «c'è ancora qualcuno che lo nomina?» si riconosce dalla
        // PAGINAZIONE, che è la sua firma. Il database applica l'esclusione e
        // taglia la pagina: qui pure, altrimenti il post risponderebbe di sé
        // stesso e nessun file uscirebbe più dal bucket (difetto V4).
        if (st.table === 'news_posts' && st.finestra) {
          const { da, a } = st.finestra
          h.citazioni.push({ esclusi: st.esclusi ?? [], da, a })
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
      b.eq = () => b
      b.or = () => b
      b.order = () => b
      b.not = (c: string, op: string, v: unknown) => {
        if (c === 'id' && op === 'in') {
          st.esclusi = String(v).replace(/^\(|\)$/g, '').split(',').filter((x) => x !== '')
        }
        return b
      }
      b.range = (da: number, a: number) => { st.finestra = { da, a }; return b }
      b.limit = () => b
      b.in = () => b
      b.is = () => b
      b.delete = () => {
        st.op = 'delete'
        h.eventi.push('delete-riga')
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
          h.eventi.push('remove-file')
          h.rimossi.push({ bucket, paths })
          if (h.removeLancia) throw new Error('trasporto interrotto')
          if (h.removeError) return { data: null, error: h.removeError }
          return { data: h.removeMuta ? [] : paths.map((p) => ({ name: p })), error: null }
        },
        // `rimuoviEVerifica` non conta: interroga lo Storage sui percorsi che non
        // risultano usciti. Un finto client senza `list` non è un client Supabase.
        list: async (_cartella: string, opzioni: { search?: string }) => ({
          data: h.ancoraPresenti.filter((n) => n === opzioni?.search).map((n) => ({ name: n })),
          error: null,
        }),
      }),
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { DELETE as NEWS_DELETE } from '@/app/api/news/[id]/route'

const A1 = '11111111-1111-4111-8111-111111111111'
const POST_ID = '33333333-3333-4333-8333-333333333333'
const COPERTINA = 'https://xyz.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg'
const NEL_TESTO = 'https://xyz.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-xyz.png'

const req = () =>
  ({
    url: `http://test/api/news/${POST_ID}`,
    method: 'DELETE',
    headers: new Headers(),
    json: async () => ({}),
    cookies: { get: () => undefined },
  }) as never

const params = { params: Promise.resolve({ id: POST_ID }) } as never

const postConFoto = (extra: Record<string, unknown> = {}) => ({
  id: POST_ID,
  tipo: 'articolo',
  stato: 'pubblicata',
  titolo: 'Festa di fine anno',
  copertina_url: COPERTINA,
  contenuto_json: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Una giornata alla Kidville' }] },
      { type: 'image', attrs: { src: NEL_TESTO } },
    ],
  },
  scuola_id: 'sc-1',
  author_id: 'admin-1',
  bambini_ritratti: [A1],
  ...extra,
})

const percorsiTolti = () => h.rimossi.filter((r) => r.bucket === 'news').flatMap((r) => r.paths)

beforeEach(() => {
  vi.clearAllMocks()
  h.post = postConFoto()
  h.altriPost = []
  h.citazioni = []
  h.eventi = []
  h.rimossi = []
  h.removeError = null
  h.removeLancia = false
  h.removeMuta = false
  h.ancoraPresenti = []
  h.errDelete = null
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
})

describe('DELETE /api/news/[id] — la riga se ne va solo dopo i suoi file', () => {
  it('cancellare il post toglie la copertina E le immagini del testo dal bucket PUBBLICO', async () => {
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual(
      expect.arrayContaining(['uploads/staff-1/1700-abc.jpg', 'uploads/staff-1/1700-xyz.png']),
    )
    expect(h.eventi).toContain('delete-riga')
  })

  it('PRIMA il file, POI la riga: l’ordine non è un dettaglio', async () => {
    // Cancellare la riga per prima e poi fallire la `remove()` lascerebbe la foto
    // a un indirizzo pubblico senza più niente che la nomini: nessuna passata
    // futura potrebbe ritrovarla. È il guasto permanente che questo test chiude.
    await NEWS_DELETE(req(), params)
    expect(h.eventi.indexOf('remove-file')).toBeGreaterThanOrEqual(0)
    expect(h.eventi.indexOf('remove-file')).toBeLessThan(h.eventi.indexOf('delete-riga'))
  })

  it('rimozione FALLITA → la riga NON si cancella, così resta da dove riprovare', async () => {
    h.removeError = { message: 'storage down' }
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(503)
    expect(h.eventi, 'la riga è sparita mentre la foto del bambino è ancora pubblica').not.toContain('delete-riga')
  })

  it('il file è ANCORA nel bucket dopo la `remove()` → la riga NON si cancella', async () => {
    // Lo Storage non fallisce sui percorsi che non esistono e nomina solo ciò che
    // ha davvero tolto: contare invece di verificare è il difetto che
    // `rimuoviEVerifica` esiste per chiudere.
    h.removeMuta = true
    h.ancoraPresenti = ['1700-abc.jpg', '1700-xyz.png']
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(503)
    expect(h.eventi).not.toContain('delete-riga')
  })

  it('lo Storage LANCIA (guasto di trasporto) → la riga resta, mai un catch muto', async () => {
    h.removeLancia = true
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(503)
    expect(h.eventi).not.toContain('delete-riga')
  })

  it('il file NON c’era più → l’esito voluto è raggiunto: la riga si cancella lo stesso', async () => {
    // «Non rimosso adesso» e «ancora lì» sono fatti diversi, e solo il secondo è
    // un guasto: trattare un file già assente come errore bloccherebbe per sempre
    // la cancellazione di un post la cui foto non esiste più.
    h.removeMuta = true
    h.ancoraPresenti = []
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(h.eventi).toContain('delete-riga')
  })

  it('post SENZA file nel bucket → lo Storage non si tocca affatto, e la riga se ne va', async () => {
    h.post = postConFoto({ copertina_url: null, contenuto_json: { type: 'doc', content: [] } })
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(h.rimossi).toHaveLength(0)
    expect(h.eventi).toContain('delete-riga')
  })

  it('un indirizzo che NON è un oggetto di questo bucket non finisce in una `remove()`', async () => {
    // Il rich-text è testo scritto a mano: se una frase venisse scambiata per un
    // percorso, la cancellazione di un post porterebbe via l'immagine di un altro.
    h.post = postConFoto({
      copertina_url: 'https://www.instagram.com/p/ABC12345/',
      contenuto_json: {
        type: 'doc',
        content: [
          { type: 'text', text: 'uploads/staff-1/non-e-un-file' },
          { type: 'image', attrs: { src: 'https://xyz.supabase.co/storage/v1/object/public/gallery/uploads/u/x.jpg' } },
        ],
      },
    })
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(h.rimossi).toHaveLength(0)
  })

  it('educator su post altrui → 403, e lo Storage non viene sfiorato', async () => {
    // Il gate di ruolo resta PRIMA della rimozione: senza, una DELETE rifiutata
    // avrebbe comunque svuotato il bucket di un post che non è di chi chiama.
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = postConFoto({ stato: 'bozza', author_id: 'ALTRO-DOCENTE' })
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(403)
    expect(h.rimossi).toHaveLength(0)
    expect(h.eventi).toHaveLength(0)
  })

  it('sede non accessibile → 403, e lo Storage non viene sfiorato', async () => {
    h.post = postConFoto({ scuola_id: 'sc-altra' })
    h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(403)
    expect(h.rimossi).toHaveLength(0)
    expect(h.eventi).toHaveLength(0)
  })
})

// =============================================================================
// LA STESSA REGRESSIONE, DALLA PORTA DELLA CANCELLAZIONE (2026-08-03).
//
// `liberaFilePubbliciDelPost` libera TUTTI i percorsi che la riga nomina, e la
// riga può nominare l'immagine di un altro articolo: il bucket è pubblico, quel
// l'indirizzo lo conosce chiunque legga il sito e basta incollarlo nel proprio
// rich-text. Cancellare la propria bozza portava via il file della vittima, che
// resta a nominarlo: immagine rotta, permanente, invisibile.
//
// La regola non è riscritta qui: è la stessa funzione della PATCH e del ritiro.
// =============================================================================

describe('DELETE /api/news/[id] — non porta via il file di un ALTRO post', () => {
  const P_VITTIMA = 'uploads/staff-vittima/1700-vittima.jpg'
  const POST_VITTIMA = '55555555-5555-4555-8555-555555555555'
  const pubblico = (p: string) => `https://xyz.supabase.co/storage/v1/object/public/news/${p}`

  it('la riga cancellata nominava il file di un altro → il file resta, la riga se ne va', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = postConFoto({
      stato: 'bozza',
      author_id: 'edu-1',
      copertina_url: pubblico(P_VITTIMA),
      contenuto_json: null,
    })
    h.altriPost = [{ id: POST_VITTIMA, scuola_id: 'sc-2', copertina_url: pubblico(P_VITTIMA), contenuto_json: null }]
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(
      percorsiTolti(),
      'cancellare la propria bozza ha portato via l’immagine di un altro articolo',
    ).toEqual([])
    // La cancellazione non si blocca: è il FILE che non si tocca, non
    // l'operazione. Rifiutare la DELETE lascerebbe in piedi la riga di chi ha
    // incollato l'indirizzo, cioè premierebbe il tentativo.
    expect(h.eventi).toContain('delete-riga')
    expect(h.citazioni[0]?.esclusi).toEqual([POST_ID])
  })

  it('CONTROLLO POSITIVO (difetto V4) — i file DAVVERO suoi escono come prima', async () => {
    // Senza, «non cancella il file altrui» sarebbe verde anche in una route che
    // non cancella più niente: la foto del bambino resterebbe pubblica per sempre
    // e nessuna riga la nominerebbe più.
    h.altriPost = [{ id: POST_VITTIMA, copertina_url: pubblico(P_VITTIMA), contenuto_json: null }]
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual(
      expect.arrayContaining(['uploads/staff-1/1700-abc.jpg', 'uploads/staff-1/1700-xyz.png']),
    )
  })

  it('un file condiviso con un altro post resta; gli altri escono lo stesso', async () => {
    // Il conto è per PERCORSO, non per post: trattenere l'intero lotto perché uno
    // dei file è di un altro lascerebbe pubbliche le foto di questo articolo.
    //
    // ⚠️ ED È ANCHE IL CASO PIÙ SCOMODO PER LA DOMANDA: la riga dell'altro post
    // nomina il file SOLO dentro `contenuto_json`, con `contenuto_html` a null.
    // Nel giro 1 la domanda era un `ilike` su tre colonne di TESTO — e `ilike` non
    // si applica a una `jsonb` — quindi in produzione questa riga non tornava
    // affatto e il file usciva; il test restava verde perché il finto client
    // ignorava il filtro che registrava. Oggi il finto lo applica, e la domanda
    // non filtra: legge le righe e le confronta con la stessa funzione.
    h.altriPost = [{
      id: POST_VITTIMA,
      copertina_url: null,
      contenuto_html: null,
      contenuto_testo: 'Una giornata alla Kidville',
      contenuto_json: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'https://xyz.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-xyz.png' } }],
      },
    }]
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(
      percorsiTolti(),
      'il file che un altro articolo nomina solo nel JSON è uscito lo stesso: quella riga resta a ' +
        'citarlo, con l’immagine rotta, in modo permanente e invisibile',
    ).toEqual(['uploads/staff-1/1700-abc.jpg'])
    expect(h.eventi).toContain('delete-riga')
  })

  it('un post GIÀ RITIRATO per consenso non trattiene più niente', async () => {
    // Se a nominare il file è una riga che l'ha già persa — `nascosta` con motivo
    // «consenso revocato» — trattenerlo significa lasciare pubblica per sempre la
    // foto di un bambino il cui consenso è caduto. È la regressione del giro 1,
    // vista dalla porta della cancellazione.
    h.altriPost = [{
      id: POST_VITTIMA,
      stato: 'nascosta',
      nascosta_motivo: 'consenso-revocato',
      copertina_url: 'https://xyz.supabase.co/storage/v1/object/public/news/uploads/staff-1/1700-abc.jpg',
      contenuto_json: null,
    }]
    const res = await NEWS_DELETE(req(), params)
    expect(res.status).toBe(200)
    expect(percorsiTolti()).toEqual(
      expect.arrayContaining(['uploads/staff-1/1700-abc.jpg', 'uploads/staff-1/1700-xyz.png']),
    )
  })
})
