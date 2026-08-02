import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// S23 — Il consenso fotografico arriva a destinazione (privacy F4).
//
// `consenso_foto_sito` e `consenso_foto_social` erano raccolti da 141 famiglie e
// non arrivavano da nessuna parte: nessuna colonna di destinazione, nessun
// codice che li leggesse. Il canale «sito web della Scuola» È il bucket `news`,
// PUBBLICO e servito senza login (decisione del titolare del 2026-07-31), e
// l'unica difesa era una spunta libera nell'editor che viveva in `useState`:
// nessuna prova di chi avesse dichiarato cosa (art. 5 §2 e art. 7 §1 GDPR).
//
// Contratti verificati qui — sempre sulla MUTAZIONE, non solo sullo status:
//  - post CON foto e un bambino SENZA consenso «sito» → rifiuto e `news_posts`
//    NON scritta; controllo positivo: con il consenso → 201 e riga scritta;
//  - il consenso è GRANULARE PER CANALE: `consenso_privacy` (galleria riservata)
//    NON vale come consenso per il sito pubblico;
//  - non esiste l'esenzione «foto privata» della galleria: sul canale pubblico
//    anche UN SOLO bambino ritratto senza consenso blocca;
//  - la dichiarazione dell'operatore è PERSISTITA (chi, quando, quale versione
//    del testo, quali bambini): senza riga non c'è prova;
//  - foto presente e dichiarazione ASSENTE → rifiuto (non si pubblica «non
//    sapendo»); dichiarazione esplicita «nessun bambino ritratto» → 201;
//  - consenso NON VERIFICABILE (colonna assente sul DB E2E non migrato, o
//    lettura fallita) → BLOCCA, non «passa». Fail-closed;
//  - degradazione E2E dell'INSERT: `PGRST204` sulle colonne nuove → si ritenta
//    senza, il post si salva lo stesso (il DB della CI non è migrato).
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sanificaContenuto: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  // alunni: riga per id (undefined = alunno non trovato / fuori sede)
  alunni: [] as Array<Record<string, unknown>>,
  errAlunni: null as { code?: string; message: string } | null,
  filtriAlunni: null as Record<string, unknown> | null,
  // news_posts — coda di errori consumata un insert alla volta (per provare il ritento)
  erroriInsert: [] as Array<{ code?: string; message: string } | null>,
  insertsTentati: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
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
      const st = { table, op: 'select', filters: {} as Record<string, unknown>, payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') {
          h.filtriAlunni = { ...st.filters }
          return { data: h.errAlunni ? null : h.alunni, error: h.errAlunni }
        }
        if (st.table === 'news_posts' && st.op === 'insert') {
          const err = h.erroriInsert.length > 0 ? h.erroriInsert.shift() : null
          if (err) return { data: null, error: err }
          return { data: { id: 'new-post', ...(st.payload ?? {}) }, error: null }
        }
        return { data: null, error: null }
      }
      b.select = () => b
      b.order = () => b
      b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.in = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.or = () => b
      b.is = () => b
      b.limit = () => b
      b.insert = (rec: Record<string, unknown>) => {
        st.op = 'insert'
        st.payload = rec
        h.insertsTentati.push({ ...rec })
        h.lastInsert = { ...rec }
        return b
      }
      b.single = async () => risolvi()
      b.maybeSingle = async () => risolvi()
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(onF, onR)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { POST as NEWS_POST } from '@/app/api/news/route'
import { CONSENSI_VERSIONE } from '@/lib/forms/enrollment-template'

const A1 = '11111111-1111-4111-8111-111111111111'
const A2 = '22222222-2222-4222-8222-222222222222'

const FOTO = 'https://xyz.supabase.co/storage/v1/object/public/news/2026/foto.jpg'

const bodyReq = (body: unknown) => ({
  url: 'http://test/api/news',
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
  cookies: { get: () => undefined },
}) as never

/** Post con COPERTINA fotografica: è il caso che fa scattare il gate. */
const postConFoto = (extra: Record<string, unknown> = {}) => ({
  tipo: 'articolo',
  titolo: 'Festa di fine anno',
  copertina_url: FOTO,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.alunni = []
  h.errAlunni = null
  h.filtriAlunni = null
  h.erroriInsert = []
  h.insertsTentati = []
  h.lastInsert = null
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
})

describe('POST /api/news — consenso «sito» dei bambini ritratti', () => {
  it('bambino SENZA consenso sito → rifiuto e NESSUNA riga in news_posts', async () => {
    h.alunni = [
      { id: A1, nome: 'Anna', cognome: 'B.', consenso_privacy: true, consenso_foto_sito: false },
      { id: A2, nome: 'Bruno', cognome: 'C.', consenso_privacy: true, consenso_foto_sito: true },
    ]
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1, A2] })))
    expect(res.status).toBe(422)
    // L'asserzione che conta è sulla MUTAZIONE: il post non deve esistere.
    expect(h.lastInsert).toBeNull()
    const j = (await res.json()) as { error?: string; bambini?: { id: string }[] }
    expect(j.bambini?.map((b) => b.id)).toEqual([A1])
  })

  it('CONTROLLO POSITIVO — stessi bambini CON consenso sito → 201 e riga scritta', async () => {
    h.alunni = [
      { id: A1, nome: 'Anna', cognome: 'B.', consenso_privacy: false, consenso_foto_sito: true },
      { id: A2, nome: 'Bruno', cognome: 'C.', consenso_privacy: false, consenso_foto_sito: true },
    ]
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1, A2] })))
    expect(res.status).toBe(201)
    expect(h.lastInsert).not.toBeNull()
    expect(h.lastInsert?.bambini_ritratti).toEqual([A1, A2])
  })

  it('il consenso è GRANULARE PER CANALE: la liberatoria della galleria non vale per il sito', async () => {
    // `consenso_privacy` = galleria riservata alle famiglie della sezione.
    // Il sito è pubblico: è un consenso distinto (provv. Garante 725/2025).
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_privacy: true, consenso_foto_sito: false }]
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1] })))
    expect(res.status).toBe(422)
    expect(h.lastInsert).toBeNull()
  })

  it('nessuna esenzione «foto privata»: UN SOLO bambino senza consenso basta a bloccare', async () => {
    // Nella galleria un bambino taggato da solo passa (la foto la vedono solo i
    // suoi genitori). Qui il canale è pubblico: quella regola non esiste.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1] })))
    expect(res.status).toBe(422)
    expect(h.lastInsert).toBeNull()
  })

  it('la verifica è ristretta alle sedi dell’operatore (mai un nome di minore di un altro plesso)', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1] })))
    expect(h.filtriAlunni?.id).toEqual([A1])
    expect(h.filtriAlunni?.scuola_id).toEqual(['sc-1'])
  })

  it('bambino non trovato nelle proprie sedi → «non verificabile» → blocca', async () => {
    h.alunni = [] // l'uuid non appartiene a un alunno delle sedi dell'operatore
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1] })))
    expect(res.status).toBe(422)
    expect(h.lastInsert).toBeNull()
  })
})

describe('POST /api/news — la dichiarazione dell’operatore è una prova, non uno stato React', () => {
  it('foto senza dichiarazione dei ritratti → rifiuto e nessuna riga', async () => {
    const res = await NEWS_POST(bodyReq(postConFoto()))
    expect(res.status).toBe(422)
    expect(h.lastInsert).toBeNull()
  })

  it('dichiarazione esplicita «nessun bambino ritratto» → 201, e la dichiarazione è PERSISTITA', async () => {
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [] })))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.bambini_ritratti).toEqual([])
    expect(h.lastInsert?.consenso_dichiarato_da).toBe('admin-1')
    expect(typeof h.lastInsert?.consenso_dichiarato_il).toBe('string')
    expect(h.lastInsert?.consenso_versione).toBe(CONSENSI_VERSIONE)
  })

  it('immagine dentro il rich-text (senza copertina) → la dichiarazione serve lo stesso', async () => {
    const contenuto = { type: 'doc', content: [{ type: 'image', attrs: { src: FOTO } }] }
    const res = await NEWS_POST(bodyReq({ tipo: 'articolo', titolo: 'T', contenuto_json: contenuto }))
    expect(res.status).toBe(422)
    expect(h.lastInsert).toBeNull()
  })

  it('post di solo testo → nessuna dichiarazione richiesta (201)', async () => {
    const contenuto = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ciao' }] }] }
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', contenuto_json: contenuto }))
    expect(res.status).toBe(201)
    expect(h.lastInsert).not.toBeNull()
  })
})

describe('POST /api/news — fail-closed e degradazione', () => {
  it('lettura del consenso fallita (42703: colonna assente) → BLOCCA, non passa', async () => {
    h.errAlunni = { code: '42703', message: 'column "consenso_foto_sito" does not exist' }
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [A1] })))
    expect(res.status).toBe(503)
    expect(h.lastInsert).toBeNull()
  })

  it('DB E2E non migrato: PGRST204 sulle colonne nuove → si ritenta senza, il post si salva', async () => {
    // Il DB E2E della CI non è migrato: le quattro colonne nuove non ci sono.
    // Un post che non ritrae bambini deve salvarsi lo stesso (nessun 500).
    h.erroriInsert = [
      { code: 'PGRST204', message: "Could not find the 'bambini_ritratti' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_dichiarato_da' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_dichiarato_il' column of 'news_posts' in the schema cache" },
      { code: 'PGRST204', message: "Could not find the 'consenso_versione' column of 'news_posts' in the schema cache" },
    ]
    const res = await NEWS_POST(bodyReq(postConFoto({ bambini_ritratti: [] })))
    expect(res.status).toBe(201)
    expect(h.insertsTentati.length).toBe(5)
    expect(h.insertsTentati[0]).toHaveProperty('bambini_ritratti')
    const ultimo = h.insertsTentati[h.insertsTentati.length - 1]
    expect(ultimo).not.toHaveProperty('bambini_ritratti')
    expect(ultimo).not.toHaveProperty('consenso_versione')
    // controllo positivo: il post c'è comunque, con il suo titolo
    expect(ultimo.titolo).toBe('Festa di fine anno')
  })
})
