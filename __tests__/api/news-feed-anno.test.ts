import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · News di una famiglia: i figli dalla funzione `figli_attivi`, la classe per uuid di sezione. Stessa regola di M44b
 * (`20261108204853_anno_visibilita_genitore_policy.sql`), che qui non gira: il finto non ha RLS.
 *
 * Il caso che decide è la sezione omonima: due bambini con lo stesso `classe_sezione` in due sezioni diverse. Per nome la news
 * arriva a tutti e due, per uuid a uno solo. Solo uuid finti.
 */

const GEN_A = '99999999-9999-4999-8999-999999999991'
const GEN_B = '99999999-9999-4999-8999-999999999992'
const FIGLIO_A = '11111111-1111-4111-8111-111111111111'
const FIGLIO_B = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ_A = '55555555-5555-4555-8555-555555555551'
const SEZ_B = '55555555-5555-4555-8555-555555555552'
const FREQ = '66666666-6666-4666-8666-666666666661'

const POST_CLASSE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const POST_GLOBALE = 'aaaaaaaa-0000-4000-8000-000000000002'
const POST_SENZA_UUID = 'aaaaaaaa-0000-4000-8000-000000000003'
const POST_GRADO = 'aaaaaaaa-0000-4000-8000-000000000004'
const DIGEST = 'bbbbbbbb-0000-4000-8000-000000000001'

type Rpc = (args: Riga) => RispostaRpc

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  figliAttivi: null as unknown,
  /** La colonna nuova non esiste, come sul database della CI. */
  colonnaAssente: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: h.resolveScuoleAttive }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, h.lette, {
      rpc: { figli_attivi: (args: Riga) => (h.figliAttivi as Rpc)(args) },
    }) as unknown as { from: (t: string) => Record<string, unknown>; rpc: unknown }
    // Il finto non proietta le colonne: questo è il solo punto in cui una SELECT sulla colonna nuova può rompersi.
    const guasta = creaFintoSupabase({ news_posts: [] }, [], { errori: { news_posts: { code: '42703' } } }) as unknown as typeof vero
    return {
      rpc: vero.rpc,
      from: (t: string) => {
        const q = vero.from(t)
        if (t !== 'news_posts' || !h.colonnaAssente) return q
        return {
          select: (cols: string) => (cols.includes('target_section_ids')
            ? (guasta.from('news_posts').select as (c: string) => unknown)(cols)
            : (q.select as (c: string) => unknown)(cols)),
        }
      },
    }
  },
  createClient: async () => ({}),
}))

import { GET as FEED } from '@/app/api/news/feed/route'
import { GET as DETTAGLIO } from '@/app/api/news/feed/[id]/route'
import { GET as DIGESTS } from '@/app/api/news/digest/route'
import { GET as DIGEST_DETTAGLIO } from '@/app/api/news/digest/[id]/route'

const req = (percorso: string) => ({
  url: `http://test${percorso}`,
  method: 'GET',
  headers: new Headers(),
  cookies: { get: () => undefined },
}) as never
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

const post = (id: string, extra: Record<string, unknown>) => ({
  id, tipo: 'articolo', stato: 'pubblicata', titolo: 't', pinned: false, pubblicata_il: '2026-10-20T10:00:00Z', scuola_id: SEDE,
  target_scope: 'globale', target_gradi: null, target_classes: null, target_section_ids: null, ...extra,
})
const famiglia = (id: string) => ({ user: { id, role: 'genitore', ruoli: ['genitore'] } })
const riga = (alunno: string, sezione: string | null) => ({ alunno_id: alunno, frequenza_id: FREQ, section_id: sezione, scuola_id: SEDE })

const idsFeed = async () => {
  const res = await FEED(req('/api/news/feed'))
  expect(res.status).toBe(200)
  const body = await res.json() as { posts: Array<Record<string, unknown>>; disponibile: boolean }
  return { ids: body.posts.map((p) => p.id), posts: body.posts, disponibile: body.disponibile }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.lette.length = 0
  h.colonnaAssente = false
  h.db = {
    legame_genitori_alunni: [
      { genitore_id: GEN_A, alunno_id: FIGLIO_A },
      { genitore_id: GEN_B, alunno_id: FIGLIO_B },
    ],
    parents: [],
    student_parents: [],
    // I due bambini hanno lo STESSO nome di classe, in due sezioni diverse.
    alunni: [
      { id: FIGLIO_A, scuola_id: SEDE, classe_sezione: 'Girasoli', section_id: SEZ_A, sections: { school_type: 'infanzia' } },
      { id: FIGLIO_B, scuola_id: SEDE, classe_sezione: 'Girasoli', section_id: SEZ_B, sections: { school_type: 'primaria' } },
    ],
    sections: [
      { id: SEZ_A, school_type: 'infanzia' },
      { id: SEZ_B, school_type: 'primaria' },
    ],
    news_posts: [
      post(POST_CLASSE_A, { target_scope: 'classi', target_classes: ['Girasoli'], target_section_ids: [SEZ_A] }),
      post(POST_GLOBALE, {}),
      post(POST_SENZA_UUID, { target_scope: 'classi', target_classes: ['Girasoli'], target_section_ids: null, scuola_id: null }),
      post(POST_GRADO, { target_scope: 'grado', target_gradi: ['primaria'] }),
    ],
    news_media: [],
    news_visualizzazioni: [],
    news_digest_edizioni: [{ id: DIGEST, scuola_id: SEDE, anno: 2026, mese: 10, inviata_il: '2026-10-31T10:00:00Z' }],
  }
  h.requireUser.mockResolvedValue(famiglia(GEN_A))
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.figliAttivi = ((args: Riga) => ({
    data: [args.p_utente === GEN_A ? riga(FIGLIO_A, SEZ_A) : riga(FIGLIO_B, SEZ_B)],
    error: null,
  })) as Rpc
})

describe('GET /api/news/feed, famiglia', () => {
  it('la news di classe arriva per uuid: la sezione omonima non la riceve', async () => {
    expect((await idsFeed()).ids).toContain(POST_CLASSE_A)

    h.requireUser.mockResolvedValue(famiglia(GEN_B))
    expect((await idsFeed()).ids).not.toContain(POST_CLASSE_A)
  })

  it('una news per classi senza uuid resta chiusa, anche con il nome giusto', async () => {
    expect((await idsFeed()).ids).not.toContain(POST_SENZA_UUID)
  })

  it('il grado viene dalla sezione della frequenza', async () => {
    expect((await idsFeed()).ids).not.toContain(POST_GRADO)

    h.requireUser.mockResolvedValue(famiglia(GEN_B))
    expect((await idsFeed()).ids).toContain(POST_GRADO)
  })

  it('il globale arriva a tutti e due', async () => {
    expect((await idsFeed()).ids).toContain(POST_GLOBALE)

    h.requireUser.mockResolvedValue(famiglia(GEN_B))
    expect((await idsFeed()).ids).toContain(POST_GLOBALE)
  })

  it('una frequenza viva senza sezione riceve il globale e nient’altro', async () => {
    h.figliAttivi = (() => ({ data: [riga(FIGLIO_A, null)], error: null })) as Rpc

    expect((await idsFeed()).ids).toEqual([POST_GLOBALE])
  })

  it('nessun figlio attivo: 200 vuoto, nessun caricamento infinito, e le news non si leggono', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const r = await idsFeed()

    expect(r.ids).toEqual([])
    expect(r.disponibile).toBe(true)
    expect(h.lette).not.toContain('news_posts')
  })

  it('gli uuid delle sezioni non escono nella risposta', async () => {
    const { posts } = await idsFeed()

    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) expect(p).not.toHaveProperty('target_section_ids')
  })

  it('un guasto della funzione non apre: 200 vuoto, con la riga di errore', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    expect((await idsFeed()).ids).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'error', expect.objectContaining({
      operazione: 'anno/visibilita:figli_attivi',
      esito: 'lettura-fallita',
    }), expect.anything())
    expect(h.lette).not.toContain('news_posts')
  })

  it('schema indietro: il confronto per nome di oggi, senza la colonna nuova', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc
    h.colonnaAssente = true
    // Il finto non proietta le colonne: sul database della CI questa non c'è proprio.
    for (const p of h.db.news_posts) delete p.target_section_ids
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    const r = await idsFeed()

    expect(r.disponibile).toBe(true)
    // Per nome la news di classe arriva anche alla sezione omonima: è il comportamento di oggi.
    expect(r.ids).toContain(POST_CLASSE_A)
    expect(r.ids).toContain(POST_SENZA_UUID)
  })

  it('la colonna che manca senza lo schema indietro della funzione non spegne il feed', async () => {
    h.colonnaAssente = true

    const r = await idsFeed()

    expect(r.disponibile).toBe(true)
    expect(r.ids).toContain(POST_GLOBALE)
  })
})

describe('GET /api/news/feed, chi lavora resta com’è', () => {
  it('una docente in veste di lavoro non passa dalla funzione', async () => {
    const figliAttivi = vi.fn(() => ({ data: [], error: null }))
    h.figliAttivi = figliAttivi as unknown as Rpc
    h.requireUser.mockResolvedValue({ user: { id: GEN_A, role: 'educator', ruoli: ['educator', 'genitore'] } })

    const r = await idsFeed()

    expect(figliAttivi).not.toHaveBeenCalled()
    expect(r.ids).toContain(POST_CLASSE_A)
  })
})

describe('GET /api/news/feed/[id], famiglia', () => {
  const apri = (id: string) => DETTAGLIO(req(`/api/news/feed/${id}`), ctx(id))

  it('dentro la classe: 200, senza gli uuid delle sezioni', async () => {
    const res = await apri(POST_CLASSE_A)

    expect(res.status).toBe(200)
    const body = await res.json() as { post: Record<string, unknown> }
    expect(body.post.id).toBe(POST_CLASSE_A)
    expect(body.post).not.toHaveProperty('target_section_ids')
  })

  it('la sezione omonima: 404', async () => {
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    expect((await apri(POST_CLASSE_A)).status).toBe(404)
  })

  it('nessun figlio attivo: 404 anche sul globale', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    expect((await apri(POST_GLOBALE)).status).toBe(404)
  })

  it('schema indietro: per nome, e la lettura riparte senza la colonna', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc
    h.colonnaAssente = true
    for (const p of h.db.news_posts) delete p.target_section_ids
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    expect((await apri(POST_CLASSE_A)).status).toBe(200)
  })
})

describe('GET /api/news/digest, famiglia', () => {
  it('nessun figlio attivo: nessuna edizione', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const res = await DIGESTS(req('/api/news/digest'))
    const body = await res.json() as { edizioni: unknown[] }

    expect(body.edizioni).toEqual([])
    expect(h.lette).not.toContain('news_digest_edizioni')
  })

  it('un figlio attivo: l’edizione della sua sede', async () => {
    const res = await DIGESTS(req('/api/news/digest'))
    const body = await res.json() as { edizioni: Array<{ id: string }> }

    expect(body.edizioni.map((e) => e.id)).toEqual([DIGEST])
  })

  it('schema indietro: l’edizione della sede del figlio, come oggi', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc

    const res = await DIGESTS(req('/api/news/digest'))
    const body = await res.json() as { edizioni: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(body.edizioni.map((e) => e.id)).toEqual([DIGEST])
  })
})

describe('GET /api/news/digest/[id], famiglia', () => {
  it('un figlio attivo: si apre', async () => {
    const res = await DIGEST_DETTAGLIO(req(`/api/news/digest/${DIGEST}`), ctx(DIGEST))

    expect(res.status).toBe(200)
  })

  it('nessun figlio attivo: 404, non si rivela l’edizione', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    expect((await DIGEST_DETTAGLIO(req(`/api/news/digest/${DIGEST}`), ctx(DIGEST))).status).toBe(404)
  })

  it('schema indietro: si apre come oggi', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc

    const res = await DIGEST_DETTAGLIO(req(`/api/news/digest/${DIGEST}`), ctx(DIGEST))

    expect(res.status).toBe(200)
  })
})
