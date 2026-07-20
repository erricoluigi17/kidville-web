import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// Route di GESTIONE News (Step 2): /api/news (GET+POST), /api/news/[id]
// (GET+PATCH+DELETE), /api/news/[id]/{pubblica,approva,statistiche}.
//
// Contratti verificati:
//  - 401 senza identità, 403 ruolo insufficiente, 400 zod su body malformato;
//  - il client invia SOLO contenuto_json → il server sanifica (chokepoint) e
//    salva html/testo (il client NON può iniettare contenuto_html);
//  - educator: stato forzato a bozza|proposta; post altrui/pubblicati → 403;
//  - scuola_id:null (tutte le sedi) SOLO admin (altri → 403);
//  - staff pubblica → notificaNewsPubblicata; ripubblica NON ri-notifica;
//  - programma con data passata → 400; approva su non-proposta → 409;
//  - degrado schema-assente → 503/{disponibile:false} (mai 500 sul DB CI).
// =============================================================================

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  sanificaContenuto: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  genitoriDiGrado: vi.fn(),
  genitoriDiClassi: vi.fn(),
  genitoriDiScuola: vi.fn(),
  // canned data / capture
  post: null as Record<string, unknown> | null,
  posts: [] as Array<Record<string, unknown>>,
  vis: [] as Array<Record<string, unknown>>,
  errPostLoad: null as string | null,
  errList: null as string | null,
  errInsert: null as string | null,
  errUpdate: null as string | null,
  errDelete: null as string | null,
  lastInsert: null as Record<string, unknown> | null,
  lastUpdate: null as Record<string, unknown> | null,
  deleted: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
  requireUser: (...a: unknown[]) => h.requireUser(...a),
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
  genitoriDiGrado: (...a: unknown[]) => h.genitoriDiGrado(...a),
}))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiClassi: (...a: unknown[]) => h.genitoriDiClassi(...a),
  genitoriDiScuola: (...a: unknown[]) => h.genitoriDiScuola(...a),
}))

function resolveResult(st: { table: string; op: string; filters: Record<string, unknown>; payload: Record<string, unknown> | null }, mode: string) {
  const errObj = (code: string | null) => (code ? { code, message: `err ${code}` } : null)
  if (st.table === 'news_posts') {
    if (st.op === 'insert') {
      return { data: h.errInsert ? null : { id: 'new-post', ...(st.payload ?? {}) }, error: errObj(h.errInsert) }
    }
    if (st.op === 'update') {
      return {
        data: h.errUpdate ? null : { id: (st.filters.id as string) ?? 'post-x', ...(h.post ?? {}), ...(st.payload ?? {}) },
        error: errObj(h.errUpdate),
      }
    }
    if (st.op === 'delete') return { data: null, error: errObj(h.errDelete) }
    if (mode === 'maybeSingle') return { data: h.post, error: errObj(h.errPostLoad) }
    return { data: h.posts, error: errObj(h.errList) }
  }
  if (st.table === 'news_visualizzazioni') return { data: h.vis, error: null }
  return { data: null, error: null }
}

function makeClient() {
  return {
    from(table: string) {
      const st = { table, op: 'select', filters: {} as Record<string, unknown>, payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.in = () => b
      b.or = () => b
      b.is = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.gte = () => b
      b.lt = () => b
      b.not = () => b
      b.limit = () => b
      b.insert = (rec: Record<string, unknown>) => { st.op = 'insert'; st.payload = rec; h.lastInsert = rec; return b }
      b.update = (rec: Record<string, unknown>) => { st.op = 'update'; st.payload = rec; h.lastUpdate = rec; return b }
      b.delete = () => { st.op = 'delete'; h.deleted = true; return b }
      b.single = async () => resolveResult(st, 'single')
      b.maybeSingle = async () => resolveResult(st, 'maybeSingle')
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(resolveResult(st, 'list')).then(onF, onR)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { GET as NEWS_GET, POST as NEWS_POST } from '@/app/api/news/route'
import { PATCH as ID_PATCH, DELETE as ID_DELETE } from '@/app/api/news/[id]/route'
import { POST as PUBBLICA } from '@/app/api/news/[id]/pubblica/route'
import { POST as APPROVA } from '@/app/api/news/[id]/approva/route'
import { GET as STATS } from '@/app/api/news/[id]/statistiche/route'

const POST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const getReq = (qs = '') => ({
  url: `http://test/api/news${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  cookies: { get: () => undefined },
}) as never

const bodyReq = (body: unknown, method = 'POST') => ({
  url: 'http://test/api/news',
  method,
  headers: new Headers(),
  json: async () => body,
  cookies: { get: () => undefined },
}) as never

const params = (id = POST_ID) => ({ params: Promise.resolve({ id }) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.post = null
  h.posts = []
  h.vis = []
  h.errPostLoad = null
  h.errList = null
  h.errInsert = null
  h.errUpdate = null
  h.errDelete = null
  h.lastInsert = null
  h.lastUpdate = null
  h.deleted = false
  h.requireDocente.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.requireUser.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.sanificaContenuto.mockReturnValue({ html: '<p>ciao</p>', testo: 'ciao' })
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
  h.genitoriDiGrado.mockResolvedValue([])
  h.genitoriDiClassi.mockResolvedValue([])
  h.genitoriDiScuola.mockResolvedValue([])
})

describe('POST /api/news — creazione e workflow', () => {
  it('401 quando requireDocente nega', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T' }))
    expect(res.status).toBe(401)
  })

  it('400 zod quando manca il titolo', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'breve' }))
    expect(res.status).toBe(400)
    expect(h.lastInsert).toBeNull()
  })

  it('400 zod quando il tipo non è valido', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'podcast', titolo: 'T' }))
    expect(res.status).toBe(400)
  })

  it('educator: stato pubblicata richiesto → forzato a bozza, nessuna notifica', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', stato: 'pubblicata' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.stato).toBe('bozza')
    expect(h.lastInsert?.author_id).toBe('edu-1')
    expect(h.notificaNewsPubblicata).not.toHaveBeenCalled()
  })

  it('educator: stato proposta è consentito', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', stato: 'proposta' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.stato).toBe('proposta')
  })

  it('staff crea direttamente pubblicata → notifica inviata e pubblicata_il valorizzato', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', stato: 'pubblicata' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.stato).toBe('pubblicata')
    expect(h.lastInsert?.pubblicata_il).toBeTruthy()
    expect(h.notificaNewsPubblicata).toHaveBeenCalledTimes(1)
  })

  it('scuola_id:null (tutte le sedi) da segreteria → 403', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', scuola_id: null }))
    expect(res.status).toBe(403)
    expect(h.lastInsert).toBeNull()
  })

  it('scuola_id:null da admin → consentito, scuola_id null nel record', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T', scuola_id: null }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.scuola_id).toBeNull()
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
  })

  it('tipo instagram con URL non valido → 400', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'instagram', titolo: 'T', instagram_url: 'https://example.com/foo' }))
    expect(res.status).toBe(400)
  })

  it('tipo instagram con URL valido → salva instagram_shortcode', async () => {
    const res = await NEWS_POST(bodyReq({ tipo: 'instagram', titolo: 'T', instagram_url: 'https://www.instagram.com/p/ABC12345/' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.instagram_shortcode).toBe('ABC12345')
  })

  it('il server sanifica il JSON e il client NON può iniettare contenuto_html', async () => {
    h.sanificaContenuto.mockReturnValue({ html: '<p>pulito</p>', testo: 'pulito' })
    const res = await NEWS_POST(bodyReq({
      tipo: 'articolo',
      titolo: 'T',
      contenuto_json: { type: 'doc', content: [] },
      contenuto_html: '<script>alert(1)</script>',
    }))
    expect(res.status).toBe(201)
    expect(h.sanificaContenuto).toHaveBeenCalledTimes(1)
    expect(h.lastInsert?.contenuto_html).toBe('<p>pulito</p>')
    expect(h.lastInsert?.contenuto_testo).toBe('pulito')
    // Il campo html grezzo del client non viene mai preso.
    expect(h.lastInsert?.contenuto_html).not.toContain('<script>')
  })

  it('degrado schema-assente sull\'insert → 503 {disponibile:false}', async () => {
    h.errInsert = 'PGRST205'
    const res = await NEWS_POST(bodyReq({ tipo: 'breve', titolo: 'T' }))
    expect(res.status).toBe(503)
    expect((await res.json()).disponibile).toBe(false)
  })
})

describe('GET /api/news — elenco gestionale', () => {
  it('elenca i post disponibili', async () => {
    h.posts = [{ id: 'p1', titolo: 'A', stato: 'bozza', scuola_id: 'sc-1', author_id: 'admin-1' }]
    const res = await NEWS_GET(getReq('stato=bozza'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.disponibile).toBe(true)
    expect(j.posts.length).toBe(1)
  })

  it('degrado schema-assente → {disponibile:false, posts:[]}', async () => {
    h.errList = '42P01'
    const res = await NEWS_GET(getReq())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.disponibile).toBe(false)
    expect(j.posts).toEqual([])
  })
})

describe('PATCH/DELETE /api/news/[id] — modifica con scope', () => {
  it('404 quando il post non esiste', async () => {
    h.post = null
    const res = await ID_PATCH(bodyReq({ titolo: 'nuovo' }, 'PATCH'), params())
    expect(res.status).toBe(404)
  })

  it('403 quando la sede del post non è accessibile', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-altra', stato: 'bozza', author_id: 'admin-1' }
    h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
    const res = await ID_PATCH(bodyReq({ titolo: 'nuovo' }, 'PATCH'), params())
    expect(res.status).toBe(403)
  })

  it('educator su post altrui → 403', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'bozza', author_id: 'ALTRO-DOCENTE' }
    const res = await ID_PATCH(bodyReq({ titolo: 'nuovo' }, 'PATCH'), params())
    expect(res.status).toBe(403)
  })

  it('educator sul proprio post GIÀ pubblicato → 403 (non editabile)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'pubblicata', author_id: 'edu-1' }
    const res = await ID_PATCH(bodyReq({ titolo: 'nuovo' }, 'PATCH'), params())
    expect(res.status).toBe(403)
  })

  it('staff modifica un post pubblicato liberamente e ri-sanifica il json', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'pubblicata', author_id: 'admin-1' }
    const res = await ID_PATCH(bodyReq({ contenuto_json: { type: 'doc' } }, 'PATCH'), params())
    expect(res.status).toBe(200)
    expect(h.sanificaContenuto).toHaveBeenCalledTimes(1)
    expect(h.lastUpdate?.contenuto_html).toBe('<p>ciao</p>')
  })

  it('DELETE staff → 200', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'pubblicata', author_id: 'admin-1' }
    const res = await ID_DELETE(bodyReq({}, 'DELETE'), params())
    expect(res.status).toBe(200)
    expect(h.deleted).toBe(true)
  })

  it('DELETE educator su post altrui → 403, nessuna cancellazione', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'edu-1', role: 'educator', scuola_id: 'sc-1' } })
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'bozza', author_id: 'ALTRO' }
    const res = await ID_DELETE(bodyReq({}, 'DELETE'), params())
    expect(res.status).toBe(403)
    expect(h.deleted).toBe(false)
  })
})

describe('POST /api/news/[id]/pubblica', () => {
  it('403 quando requireStaff nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await PUBBLICA(bodyReq({ azione: 'pubblica' }), params())
    expect(res.status).toBe(403)
  })

  it('azione pubblica → stato pubblicata + notifica', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'programmata', titolo: 'T', target_scope: 'globale', invia_notifica: true, notifica_inviata_il: null }
    const res = await PUBBLICA(bodyReq({ azione: 'pubblica' }), params())
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.stato).toBe('pubblicata')
    expect(h.lastUpdate?.pubblicata_il).toBeTruthy()
    expect(h.notificaNewsPubblicata).toHaveBeenCalledTimes(1)
  })

  it('azione ripubblica → NON ri-invia la notifica', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'nascosta', titolo: 'T', target_scope: 'globale', invia_notifica: true, notifica_inviata_il: '2026-07-01T00:00:00Z' }
    const res = await PUBBLICA(bodyReq({ azione: 'ripubblica' }), params())
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.stato).toBe('pubblicata')
    expect(h.notificaNewsPubblicata).not.toHaveBeenCalled()
  })

  it('azione programma con data passata → 400', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'bozza', titolo: 'T', target_scope: 'globale' }
    const res = await PUBBLICA(bodyReq({ azione: 'programma', programmata_il: '2000-01-01T00:00:00Z' }), params())
    expect(res.status).toBe(400)
  })

  it('azione pin → inverte pinned', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'pubblicata', pinned: false, titolo: 'T', target_scope: 'globale' }
    const res = await PUBBLICA(bodyReq({ azione: 'pin' }), params())
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.pinned).toBe(true)
  })
})

describe('POST /api/news/[id]/approva', () => {
  it('409 se il post non è in stato proposta', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'bozza', titolo: 'T', target_scope: 'globale' }
    const res = await APPROVA(bodyReq({ esito: 'approva' }), params())
    expect(res.status).toBe(409)
  })

  it('approva + pubblica subito → approvata_da valorizzato e notifica', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'proposta', titolo: 'T', target_scope: 'globale', invia_notifica: true, notifica_inviata_il: null }
    const res = await APPROVA(bodyReq({ esito: 'approva', pubblica_subito: true }), params())
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.stato).toBe('pubblicata')
    expect(h.lastUpdate?.approvata_da).toBe('admin-1')
    expect(h.notificaNewsPubblicata).toHaveBeenCalledTimes(1)
  })

  it('rifiuta → torna in bozza, motivo restituito', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'proposta', titolo: 'T', target_scope: 'globale' }
    const res = await APPROVA(bodyReq({ esito: 'rifiuta', motivo: 'Rivedere il testo' }), params())
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.stato).toBe('bozza')
    const j = await res.json()
    expect(j.motivo).toBe('Rivedere il testo')
  })
})

describe('GET /api/news/[id]/statistiche', () => {
  it('conta le famiglie uniche che hanno visualizzato + le famiglie target', async () => {
    h.post = { id: POST_ID, scuola_id: 'sc-1', stato: 'pubblicata', target_scope: 'globale', target_gradi: null, target_classes: null }
    h.vis = [{ utente_id: 'u1' }, { utente_id: 'u1' }, { utente_id: 'u2' }]
    h.genitoriDiScuola.mockResolvedValue(['u1', 'u2', 'u3'])
    const res = await STATS(getReq(), params())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.visualizzazioni).toBe(2)
    expect(j.famiglie_target).toBe(3)
  })
})
