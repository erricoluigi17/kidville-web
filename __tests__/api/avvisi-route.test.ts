import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// GET/POST /api/avvisi.
// Falle chiuse:
//  - G3: GET ramo genitore era anonimo + spoofabile via ?parentId. Ora requireUser +
//        parentId DALLA SESSIONE, figli e classi derivati server-side, i parametri client ignorati.
//  - m3: ogni avviso porta l'elenco dei FIGLI cui si riferisce (globale=tutti, classe=chi è in classe).
//  - M7: POST autore = sessione (author_id del body ignorato).
//  - M8: POST target_scope='classe' con classi vuote → 400 (per tutti i ruoli).

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  getModuleConfig: vi.fn(),
  notificaEvento: vi.fn(),
  genitoriDiScuola: vi.fn(),
  genitoriDiClassi: vi.fn(),
  logScrittura: vi.fn(),
  // canned data / capture
  alunni: [] as Array<Record<string, unknown>>,
  avvisi: [] as Array<Record<string, unknown>>,
  author: { nome: null, cognome: null, ruolo: null, first_name: 'Anna', last_name: 'Bianchi', role: 'educator' } as Record<string, unknown>,
  risposte: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: (...a: unknown[]) => h.verificaTargetAvvisoDocente(...a) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: (...a: unknown[]) => h.getModuleConfig(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...a) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiScuola: (...a: unknown[]) => h.genitoriDiScuola(...a),
  genitoriDiClassi: (...a: unknown[]) => h.genitoriDiClassi(...a),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.logScrittura(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const st: { count: boolean; notNull: string | null; filters: Record<string, unknown>; inserted: Record<string, unknown> | null } =
        { count: false, notNull: null, filters: {}, inserted: null }
      const result = () => {
        if (table === 'alunni') return { data: h.alunni, error: null }
        if (table === 'avvisi') return { data: h.avvisi, error: null }
        if (table === 'utenti') return { data: h.author, error: null }
        if (table === 'avvisi_risposte') {
          if (st.count) {
            if (st.notNull === 'letto_il') return { count: 0 }
            if (st.filters.risposta === 'si') return { count: 0 }
            if (st.filters.risposta === 'no') return { count: 0 }
            return { count: 0 }
          }
          return { data: h.risposte, error: null }
        }
        return { data: null, error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (_s: string, opts?: { count?: string; head?: boolean }) => { if (opts?.count) st.count = true; return b }
      b.order = () => b
      b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.in = () => b
      b.not = (c: string) => { st.notNull = c; return b }
      b.limit = () => b
      b.insert = (rec: Record<string, unknown>) => { h.lastInsert = rec; st.inserted = rec; return b }
      b.single = async () => (table === 'avvisi' && st.inserted ? { data: { id: 'new-av', ...st.inserted }, error: null } : result())
      b.maybeSingle = async () => result()
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR)
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/avvisi/route'

const getReq = (qs = '') => ({
  url: `http://test/api/avvisi${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams(qs) },
  cookies: { get: () => undefined },
}) as never

const postReq = (body: unknown) => ({
  url: 'http://test/api/avvisi',
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.lastInsert = null
  h.risposte = []
  h.alunni = [
    { id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: 'sc-1' },
    { id: 's2', nome: 'Bruno', classe_sezione: '1B', scuola_id: 'sc-1' },
  ]
  h.avvisi = [
    { id: 'av-glob', author_id: 'aut1', titolo: 'Chiusura', contenuto: 'x', tipo: 'presa_visione', target_scope: 'globale', target_classes: null, scadenza: null, attachment_url: null, created_at: '2026-07-03' },
    { id: 'av-1a', author_id: 'aut1', titolo: 'Gita 1A', contenuto: 'y', tipo: 'adesione', target_scope: 'classe', target_classes: ['1A'], scadenza: null, attachment_url: null, created_at: '2026-07-02' },
    { id: 'av-3c', author_id: 'aut1', titolo: 'Altra classe', contenuto: 'z', tipo: 'presa_visione', target_scope: 'classe', target_classes: ['3C'], scadenza: null, attachment_url: null, created_at: '2026-07-01' },
  ]
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.getFigliDiGenitore.mockResolvedValue(['s1', 's2'])
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.getModuleConfig.mockResolvedValue({ ruoli_pubblicazione: ['admin', 'teacher'] })
  h.genitoriDiScuola.mockResolvedValue([])
  h.genitoriDiClassi.mockResolvedValue([])
})

describe('GET /api/avvisi — ramo genitore (G3 + m3)', () => {
  it('401 quando anonimo', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(getReq('parentId=chiunque'))
    expect(res.status).toBe(401)
  })

  it('deriva il feed dalla sessione e ignora i parametri client', async () => {
    // parentId/classe/studentId del client sono OSTILI: devono essere ignorati.
    const res = await GET(getReq('parentId=VITTIMA&classe=9Z&studentId=X'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string }>
    const ids = j.map((a) => a.id).sort()
    // globale + classe del figlio 1A; l'avviso di 3C (nessun figlio) è escluso.
    expect(ids).toEqual(['av-1a', 'av-glob'])
    // parentId è derivato dalla sessione, non dal query param.
    expect(h.getFigliDiGenitore).toHaveBeenCalledWith(expect.anything(), PARENT_ID)
  })

  it('m3: ogni avviso porta i figli cui si riferisce (globale=tutti, classe=in classe)', async () => {
    const res = await GET(getReq())
    const j = (await res.json()) as Array<{ id: string; figli: Array<{ student_id: string; nome: string }> }>
    const glob = j.find((a) => a.id === 'av-glob')!
    const uno = j.find((a) => a.id === 'av-1a')!
    expect(glob.figli.map((f) => f.student_id).sort()).toEqual(['s1', 's2'])
    expect(uno.figli).toEqual([{ student_id: 's1', nome: 'Bruna' }])
  })

  it('genitore senza figli → lista vuota', async () => {
    h.getFigliDiGenitore.mockResolvedValue([])
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /api/avvisi — ramo staff', () => {
  it('lo staff vede gli avvisi del proprio plesso (nessun figli, my_response null)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<Record<string, unknown>>
    expect(j.length).toBe(3)
    expect(j[0].figli).toBeUndefined()
    expect(j[0].my_response).toBeNull()
  })
})

describe('POST /api/avvisi — autore e target', () => {
  it('M7: usa l\'autore di SESSIONE e ignora author_id del body', async () => {
    const res = await POST(postReq({ author_id: 'SPOOF-DOCENTE', titolo: 'T', contenuto: 'C', target_scope: 'globale' }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.author_id).toBe('seg-1')
    expect(h.lastInsert?.author_id).not.toBe('SPOOF-DOCENTE')
  })

  it('M8: target_scope=classe con classi vuote → 400', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: [] }))
    expect(res.status).toBe(400)
    expect(h.lastInsert).toBeNull()
  })

  it('M8: target_scope=classe con classi solo whitespace → 400', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: ['', '  '] }))
    expect(res.status).toBe(400)
  })

  it('classe con classi valide → 201', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: ['1A'] }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.author_id).toBe('seg-1')
  })
})
