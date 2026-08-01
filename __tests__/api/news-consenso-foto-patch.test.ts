import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// Il gate sul consenso «sito web» non si aggira cambiando rotta.
//
// IL DIFETTO (collaudo del 2026-08-01). Il controllo introdotto lo stesso giorno
// viveva SOLO su `POST /api/news`. Bastavano due chiamate per scavalcarlo:
//   1. si crea il post SENZA foto  → nessun gate, nessuna dichiarazione;
//   2. `PATCH /api/news/[id]` aggiunge `copertina_url` (o un nodo `image` nel
//      rich-text) → nessun controllo di nessun tipo.
// Il bucket `news` è pubblico e servito senza login: la foto di un bambino senza
// consenso al canale «sito» finiva online in due mosse, con il gate verde.
//
// È la stessa forma di difetto che questa sessione ha già incontrato tre volte:
// la regola chiusa su una strada e lasciata aperta su quella accanto. Perciò la
// regola ora vive in UN POSTO SOLO (`src/lib/news/gate-consenso.ts`) e questo
// file la interroga da entrambe le rotte — anche dalla pubblicazione, che è il
// momento in cui il contenuto diventa davvero visibile.
//
// Ogni asserzione negativa qui dentro ha il suo CONTROLLO POSITIVO: senza, «non
// scrive» sarebbe verde anche con una route che non fa più niente.
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sanificaContenuto: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  // `news_posts` — la riga che la route ricarica per lo scope
  post: null as Record<string, unknown> | null,
  // `alunni` — l'esito della verifica del consenso
  alunni: [] as Array<Record<string, unknown>>,
  errAlunni: null as { code?: string; message: string } | null,
  // mutazioni osservate
  update: null as Record<string, unknown> | null,
  updatesTentati: [] as Array<Record<string, unknown>>,
  erroriUpdate: [] as Array<{ code?: string; message: string } | null>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
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

function makeClient() {
  return {
    from(table: string) {
      const st = { table, op: 'select', payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') return { data: h.errAlunni ? null : h.alunni, error: h.errAlunni }
        if (st.table === 'news_posts' && st.op === 'update') {
          const err = h.erroriUpdate.length > 0 ? h.erroriUpdate.shift() : null
          if (err) return { data: null, error: err }
          return { data: { ...(h.post ?? {}), ...(st.payload ?? {}) }, error: null }
        }
        if (st.table === 'news_posts') return { data: h.post, error: null }
        return { data: null, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.is = () => b
      b.update = (rec: Record<string, unknown>) => {
        st.op = 'update'
        st.payload = rec
        h.updatesTentati.push({ ...rec })
        h.update = { ...rec }
        return b
      }
      b.single = async () => risolvi()
      b.maybeSingle = async () => risolvi()
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(risolvi()).then(onF, onR)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { PATCH as NEWS_PATCH } from '@/app/api/news/[id]/route'
import { POST as NEWS_PUBBLICA } from '@/app/api/news/[id]/pubblica/route'
import { CONSENSI_VERSIONE } from '@/lib/forms/enrollment-template'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'
const POST_ID = '33333333-3333-4333-8333-333333333333'
const FOTO = 'https://xyz.supabase.co/storage/v1/object/public/news/2026/foto.jpg'

const req = (body: unknown, url = `http://test/api/news/${POST_ID}`) =>
  ({
    url,
    method: 'PATCH',
    headers: new Headers(),
    json: async () => body,
    cookies: { get: () => undefined },
  }) as never

const params = { params: Promise.resolve({ id: POST_ID }) } as never

/** Post di SOLO TESTO già in archivio: creato senza gate, perché non ritraeva nessuno. */
const postSenzaFoto = (extra: Record<string, unknown> = {}) => ({
  id: POST_ID,
  tipo: 'articolo',
  stato: 'bozza',
  titolo: 'Festa di fine anno',
  contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  copertina_url: null,
  scuola_id: 'sc-1',
  author_id: 'admin-1',
  bambini_ritratti: null,
  consenso_dichiarato_da: null,
  consenso_dichiarato_il: null,
  consenso_versione: null,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.post = postSenzaFoto()
  h.alunni = []
  h.errAlunni = null
  h.update = null
  h.updatesTentati = []
  h.erroriUpdate = []
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
})

describe('PATCH /api/news/[id] — la copertina non entra senza dichiarazione', () => {
  it('aggiungere la COPERTINA a un post senza dichiarazione → rifiuto e NESSUN update', async () => {
    const res = await NEWS_PATCH(req({ copertina_url: FOTO }), params)
    expect(res.status).toBe(422)
    // L'asserzione che conta è sulla MUTAZIONE: la copertina non deve essere scritta.
    expect(h.update).toBeNull()
  })

  it('aggiungere un NODO IMMAGINE nel rich-text → stesso rifiuto (la strada accanto)', async () => {
    const contenuto = { type: 'doc', content: [{ type: 'image', attrs: { src: FOTO } }] }
    const res = await NEWS_PATCH(req({ contenuto_json: contenuto }), params)
    expect(res.status).toBe(422)
    expect(h.update).toBeNull()
  })

  it('CONTROLLO POSITIVO — stessa PATCH con dichiarazione e consenso → 200 e copertina scritta', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const res = await NEWS_PATCH(req({ copertina_url: FOTO, bambini_ritratti: [A1] }), params)
    expect(res.status).toBe(200)
    expect(h.update?.copertina_url).toBe(FOTO)
    // La PROVA della dichiarazione viaggia con la modifica: chi, quando, su cosa.
    expect(h.update?.bambini_ritratti).toEqual([A1])
    expect(h.update?.consenso_dichiarato_da).toBe('admin-1')
    expect(h.update?.consenso_versione).toBe(CONSENSI_VERSIONE)
  })

  it('dichiarazione presente ma UN bambino senza consenso «sito» → rifiuto e nessun update', async () => {
    h.alunni = [
      { id: A1, nome: 'Anna', cognome: 'B.', consenso_privacy: true, consenso_foto_sito: false },
      { id: A2, nome: 'Bruno', cognome: 'C.', consenso_foto_sito: true },
    ]
    const res = await NEWS_PATCH(req({ copertina_url: FOTO, bambini_ritratti: [A1, A2] }), params)
    expect(res.status).toBe(422)
    expect(h.update).toBeNull()
    const j = (await res.json()) as { bambini?: { id: string }[] }
    expect(j.bambini?.map((b) => b.id)).toEqual([A1])
  })

  it('consenso NON VERIFICABILE (colonna assente) → BLOCCA, non passa', async () => {
    h.errAlunni = { code: '42703', message: 'column "consenso_foto_sito" does not exist' }
    const res = await NEWS_PATCH(req({ copertina_url: FOTO, bambini_ritratti: [A1] }), params)
    expect(res.status).toBe(503)
    expect(h.update).toBeNull()
  })

  it('PATCH di solo testo su un post senza foto → nessun gate (200)', async () => {
    const res = await NEWS_PATCH(req({ titolo: 'Nuovo titolo' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.titolo).toBe('Nuovo titolo')
  })
})

describe('PATCH /api/news/[id] — un post CHE GIÀ ritrae bambini resta sotto controllo', () => {
  it('PATCH del solo titolo su post con foto e consenso REVOCATO → rifiuto', async () => {
    // La revoca è un diritto (art. 7 §3 GDPR): dal momento in cui arriva, quel
    // contenuto non si tocca più senza rimuovere il bambino dalla dichiarazione.
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1] })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await NEWS_PATCH(req({ titolo: 'Altro titolo' }), params)
    expect(res.status).toBe(422)
    expect(h.update).toBeNull()
  })

  it('CONTROLLO POSITIVO — stesso post con consenso ancora valido → 200', async () => {
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1] })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const res = await NEWS_PATCH(req({ titolo: 'Altro titolo' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.titolo).toBe('Altro titolo')
  })

  it('togliere la foto e dichiarare «nessun bambino» → 200 (la via d’uscita esiste)', async () => {
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1] })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await NEWS_PATCH(req({ copertina_url: null, contenuto_json: null }), params)
    expect(res.status).toBe(200)
  })
})

describe('PATCH /api/news/[id] — degradazione sul DB E2E non migrato', () => {
  it('PGRST204 sulle colonne della dichiarazione → si ritenta senza, la modifica passa', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    h.erroriUpdate = [
      { code: 'PGRST204', message: "Could not find the 'bambini_ritratti' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_dichiarato_da' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_dichiarato_il' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_versione' column of 'news_posts' in the schema cache" },
    ]
    const res = await NEWS_PATCH(req({ copertina_url: FOTO, bambini_ritratti: [A1] }), params)
    expect(res.status).toBe(200)
    expect(h.updatesTentati.length).toBe(5)
    const ultimo = h.updatesTentati[h.updatesTentati.length - 1]
    expect(ultimo).not.toHaveProperty('bambini_ritratti')
    // controllo positivo: il campo del post è comunque arrivato
    expect(ultimo.copertina_url).toBe(FOTO)
  })
})

describe('POST /api/news/[id]/pubblica — la revoca vale anche al momento di pubblicare', () => {
  it('post con foto e consenso REVOCATO → non si pubblica, e nessun update', async () => {
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1], stato: 'bozza' })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await NEWS_PUBBLICA(req({ azione: 'pubblica' }), params)
    expect(res.status).toBe(422)
    expect(h.update).toBeNull()
    expect(h.notificaNewsPubblicata).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — stesso post con consenso valido → pubblicato e notificato', async () => {
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1], stato: 'bozza' })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const res = await NEWS_PUBBLICA(req({ azione: 'pubblica' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('pubblicata')
    expect(h.notificaNewsPubblicata).toHaveBeenCalled()
  })

  it('RITIRARE un post non passa dal gate: si deve poter sempre togliere dal sito', async () => {
    // Se la revoca bloccasse anche il ritiro, l'unico modo di onorarla sarebbe
    // cancellare il post: il gate diventerebbe un ostacolo alla revoca stessa.
    h.post = postSenzaFoto({ copertina_url: FOTO, bambini_ritratti: [A1], stato: 'pubblicata' })
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await NEWS_PUBBLICA(req({ azione: 'ritira' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('nascosta')
  })
})
