import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// STEP 3 — feed genitore server-derived + dettaglio con conteggio visualizzazioni.
//
// Invarianti sotto lock:
//  - genitore SENZA figli con sede determinabile → [] (FAIL-CLOSED).
//  - post 'classi' di una classe non dei figli → escluso (postVisibileAiFigli reale).
//  - pinned prima (ordinamento server-side stabile).
//  - ?q= usa la full-text italiana (websearch), non un LIKE.
//  - dettaglio di un post fuori target → 404 (non 403).
//  - upsert su news_visualizzazioni SOLO per il genitore.
//  - degrado schema-assente → nessun 500.
// `postVisibileAiFigli` è REALE (mock parziale di target): si testa la logica vera.
// =============================================================================

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  caricaFigliConTarget: vi.fn(),
  // db state
  posts: [] as Array<Record<string, unknown>>,
  postsError: null as unknown,
  post: null as Record<string, unknown> | null,
  postError: null as unknown,
  media: [] as Array<Record<string, unknown>>,
  visErr: null as unknown,
  calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
  upserts: [] as Array<{ table: string; rec: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/news/target', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, caricaFigliConTarget: (...a: unknown[]) => h.caricaFigliConTarget(...a) }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
  createClient: async () => ({}),
}))

function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const rec = (m: string) => (...args: unknown[]) => { h.calls.push({ table, m, args }); return b }
      for (const m of ['select', 'order', 'eq', 'in', 'is', 'or', 'lte', 'lt', 'gte', 'limit', 'textSearch', 'not']) {
        b[m] = rec(m)
      }
      b.upsert = (rec2: unknown, ...rest: unknown[]) => {
        h.upserts.push({ table, rec: rec2 })
        h.calls.push({ table, m: 'upsert', args: [rec2, ...rest] })
        return b
      }
      b.maybeSingle = async () => (table === 'news_posts' ? { data: h.post, error: h.postError } : { data: null, error: null })
      b.single = async () => (table === 'news_posts' ? { data: h.post, error: h.postError } : { data: null, error: null })
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
        let r: { data: unknown; error: unknown }
        if (table === 'news_posts') r = { data: h.posts, error: h.postsError }
        else if (table === 'news_media') r = { data: h.media, error: null }
        else if (table === 'news_visualizzazioni') r = { data: null, error: h.visErr }
        else r = { data: null, error: null }
        return Promise.resolve(r).then(onF, onR)
      }
      return b
    },
  }
}

import { GET as feedGET } from '@/app/api/news/feed/route'
import { GET as feedIdGET } from '@/app/api/news/feed/[id]/route'

const POST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const getReq = (qs = '') => ({
  url: `http://test/api/news/feed${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  cookies: { get: () => undefined },
}) as never

const idReq = () => ({
  url: `http://test/api/news/feed/${POST_ID}`,
  method: 'GET',
  headers: new Headers(),
  cookies: { get: () => undefined },
}) as never
const ctx = { params: Promise.resolve({ id: POST_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.posts = []
  h.postsError = null
  h.post = null
  h.postError = null
  h.media = []
  h.visErr = null
  h.calls = []
  h.upserts = []
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.caricaFigliConTarget.mockResolvedValue([{ scuola_id: 'sc-1', classe_sezione: '1A', grado: 'infanzia' }])
})

describe('GET /api/news/feed — ramo genitore', () => {
  it('401 quando anonimo', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await feedGET(getReq())
    expect(res.status).toBe(401)
  })

  it('FAIL-CLOSED: genitore senza figli con sede → posts vuoto e news_posts non interrogata', async () => {
    h.caricaFigliConTarget.mockResolvedValue([]) // nessun figlio con sede
    const res = await feedGET(getReq())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { posts: unknown[] }
    expect(j.posts).toEqual([])
    expect(h.calls.some((c) => c.table === 'news_posts')).toBe(false)
  })

  it('esclude un post di CLASSI non frequentate dai figli', async () => {
    h.posts = [
      { id: 'p-glob', pinned: false, pubblicata_il: '2026-07-01T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null, titolo: 'A' },
      { id: 'p-3c', pinned: false, pubblicata_il: '2026-07-02T00:00:00Z', scuola_id: 'sc-1', target_scope: 'classi', target_gradi: null, target_classes: ['3C'], titolo: 'B' },
      { id: 'p-1a', pinned: false, pubblicata_il: '2026-07-03T00:00:00Z', scuola_id: 'sc-1', target_scope: 'classi', target_gradi: null, target_classes: ['1A'], titolo: 'C' },
    ]
    const res = await feedGET(getReq())
    const j = (await res.json()) as { posts: Array<{ id: string }> }
    const ids = j.posts.map((p) => p.id).sort()
    expect(ids).toEqual(['p-1a', 'p-glob']) // p-3c escluso, i figli sono in 1A
  })

  it('limita al widget con ?limit=', async () => {
    h.posts = [
      { id: 'p1', pinned: false, pubblicata_il: '2026-07-05T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'p2', pinned: false, pubblicata_il: '2026-07-04T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'p3', pinned: false, pubblicata_il: '2026-07-03T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
    ]
    const res = await feedGET(getReq('limit=2'))
    const j = (await res.json()) as { posts: unknown[] }
    expect(j.posts.length).toBe(2)
  })
})

describe('GET /api/news/feed — ramo staff', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  })

  it('pinned prima, poi pubblicata_il DESC', async () => {
    h.posts = [
      { id: 'vecchio', pinned: false, pubblicata_il: '2026-07-01T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'nuovo', pinned: false, pubblicata_il: '2026-07-09T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'fissato', pinned: true, pubblicata_il: '2026-06-01T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
    ]
    const res = await feedGET(getReq())
    const j = (await res.json()) as { posts: Array<{ id: string }> }
    expect(j.posts.map((p) => p.id)).toEqual(['fissato', 'nuovo', 'vecchio'])
  })

  it('?q= usa la full-text italiana (websearch), non un LIKE', async () => {
    await feedGET(getReq('q=gita'))
    const ts = h.calls.find((c) => c.m === 'textSearch')
    expect(ts).toBeTruthy()
    expect(ts!.args[0]).toBe('search_tsv')
    expect(ts!.args[1]).toBe('gita')
    expect(ts!.args[2]).toMatchObject({ type: 'websearch', config: 'italian' })
  })

  it('?archivio=1 aggrega per mese', async () => {
    h.posts = [
      { id: 'a', pinned: false, pubblicata_il: '2026-07-03T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'b', pinned: false, pubblicata_il: '2026-07-20T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
      { id: 'c', pinned: false, pubblicata_il: '2026-06-10T00:00:00Z', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null },
    ]
    const res = await feedGET(getReq('archivio=1'))
    const j = (await res.json()) as { archivio: Array<{ mese: string; conteggio: number }> }
    expect(j.archivio).toEqual([
      { mese: '2026-07', conteggio: 2 },
      { mese: '2026-06', conteggio: 1 },
    ])
  })

  it('schema assente → nessun 500, degrado silenzioso', async () => {
    h.postsError = { code: '42P01', message: 'relation "news_posts" does not exist' }
    const res = await feedGET(getReq())
    expect(res.status).toBe(200)
    const j = (await res.json()) as { disponibile: boolean; posts: unknown[] }
    expect(j.disponibile).toBe(false)
    expect(j.posts).toEqual([])
  })
})

describe('GET /api/news/feed/[id] — dettaglio', () => {
  it('404 se il post non esiste', async () => {
    h.post = null
    const res = await feedIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })

  it('genitore: post fuori target → 404 (non 403) e NESSUNA visualizzazione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
    h.post = { id: POST_ID, stato: 'pubblicata', scuola_id: 'sc-1', target_scope: 'classi', target_gradi: null, target_classes: ['3C'], titolo: 'X' }
    const res = await feedIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
    expect(h.upserts.length).toBe(0)
  })

  it('genitore in target: 200 e UPSERT su news_visualizzazioni', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore', scuola_id: null } })
    h.post = { id: POST_ID, stato: 'pubblicata', scuola_id: 'sc-1', target_scope: 'classi', target_gradi: null, target_classes: ['1A'], titolo: 'X' }
    h.media = [{ id: 'm1', post_id: POST_ID, tipo: 'immagine', url: 'u', poster_url: null, ordine: 0 }]
    const res = await feedIdGET(idReq(), ctx)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { post: { id: string }; media: unknown[] }
    expect(j.post.id).toBe(POST_ID)
    expect(j.media.length).toBe(1)
    expect(h.upserts.length).toBe(1)
    expect(h.upserts[0].table).toBe('news_visualizzazioni')
    expect(h.upserts[0].rec).toMatchObject({ post_id: POST_ID, utente_id: 'gen-1' })
  })

  it('staff: 200 SENZA registrare visualizzazioni (solo i genitori contano)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    h.post = { id: POST_ID, stato: 'pubblicata', scuola_id: 'sc-1', target_scope: 'globale', target_gradi: null, target_classes: null, titolo: 'X' }
    const res = await feedIdGET(idReq(), ctx)
    expect(res.status).toBe(200)
    expect(h.upserts.length).toBe(0)
  })

  it('staff: post di una sede non accessibile → 404', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
    h.post = { id: POST_ID, stato: 'pubblicata', scuola_id: 'sc-2', target_scope: 'globale', target_gradi: null, target_classes: null, titolo: 'X' }
    const res = await feedIdGET(idReq(), ctx)
    expect(res.status).toBe(404)
  })
})
