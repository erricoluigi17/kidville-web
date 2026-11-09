import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type RispostaRpc } from '../fixtures/finto-supabase'

/**
 * PR 4.4 · GET /api/gallery, ramo della famiglia: l'elenco lo decide `galleria_pagina_genitore`.
 *
 * Il gate è quello vero. Il database finto ha sempre una foto `is_broadcast` della sede e una con il figlio taggato: è la lista
 * larga di oggi, e il rosso senza la correzione è proprio lei che esce. La funzione risponde per utente e per figlio, come
 * quella vera: una famiglia chiede con il proprio id, e riceve solo la propria pagina.
 */

const GEN_A = '99999999-9999-4999-8999-999999999991'
const GEN_B = '99999999-9999-4999-8999-999999999992'
const FIGLIO_A = '11111111-1111-4111-8111-111111111111'
const FIGLIO_B = '11111111-1111-4111-8111-111111111112'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ = '55555555-5555-4555-8555-555555555551'
const FREQ = '66666666-6666-4666-8666-666666666661'
const FOTO_1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const FOTO_2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const FOTO_ALTRA_SEZIONE = 'aaaaaaaa-0000-4000-8000-000000000003'

type Rpc = (args: Riga) => RispostaRpc

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelleLette: [] as string[],
  chiamate: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  figliAttivi: null as unknown,
  pagina: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  assertAlunnoInScope: h.assertAlunnoInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/gallery/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/gallery/storage')>()),
  firmaMediaGalleria: async (_s: unknown, media: unknown) => media,
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => creaFintoSupabase(h.db as DBFinto, h.tabelleLette, {
    rpc: {
      figli_attivi: (args: Riga) => {
        h.chiamate.push({ nome: 'figli_attivi', args })
        return (h.figliAttivi as Rpc)(args)
      },
      galleria_pagina_genitore: (args: Riga) => {
        h.chiamate.push({ nome: 'galleria_pagina_genitore', args })
        return (h.pagina as Rpc)(args)
      },
    },
  }),
}))

import { GET } from '@/app/api/gallery/route'

const url = (query: string) => new Request(`http://localhost/api/gallery?${query}`)
const riga = (alunno: string) => ({ alunno_id: alunno, frequenza_id: FREQ, section_id: SEZ, scuola_id: SEDE })

const foto = (id: string, extra: Record<string, unknown> = {}) => ({
  id, scuola_id: SEDE, uploaded_by: null, file_url: `p/${id}.jpg`, file_type: 'foto', tag_students: [], is_broadcast: false,
  target_classes: null, created_at: '2026-10-20T10:00:00Z', eliminato_il: null, ...extra,
})

const famiglia = (id: string) => ({ user: { id, role: 'genitore', ruoli: ['genitore'] } })

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelleLette.length = 0
  h.chiamate.length = 0
  h.db = {
    legame_genitori_alunni: [
      { genitore_id: GEN_A, alunno_id: FIGLIO_A },
      { genitore_id: GEN_B, alunno_id: FIGLIO_B },
    ],
    parents: [],
    student_parents: [],
    alunni: [
      { id: FIGLIO_A, scuola_id: SEDE, section_id: SEZ, stato: 'iscritto', archiviato_il: null },
      { id: FIGLIO_B, scuola_id: SEDE, section_id: SEZ, stato: 'iscritto', archiviato_il: null },
    ],
    utenti: [],
    galleria_media_v2: [
      foto(FOTO_1, { tag_students: [FIGLIO_A], created_at: '2026-10-19T10:00:00Z' }),
      foto(FOTO_2, { tag_students: [FIGLIO_A], created_at: '2026-10-20T10:00:00Z' }),
      // Per tutta la sede con il filtro di oggi: è la foto che la famiglia B oggi riceve.
      foto(FOTO_ALTRA_SEZIONE, { is_broadcast: true, target_classes: ['Girasoli'], created_at: '2026-10-21T10:00:00Z' }),
    ],
  }
  h.requireUser.mockResolvedValue(famiglia(GEN_A))
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.figliAttivi = ((args: Riga) => ({
    data: [riga(args.p_utente === GEN_A ? FIGLIO_A : FIGLIO_B)],
    error: null,
  })) as Rpc
  // La regola vera: alla famiglia A le sue due foto, dalla più recente; alla B nessuna.
  h.pagina = ((args: Riga) => ({
    data: args.p_utente === GEN_A && args.p_alunno === FIGLIO_A
      ? [{ media_id: FOTO_2, totale: 2 }, { media_id: FOTO_1, totale: 2 }]
      : [{ media_id: null, totale: 0 }],
    error: null,
  })) as Rpc
})

describe('GET /api/gallery, famiglia', () => {
  it('l’elenco è la pagina della funzione, nel suo ordine e col suo totale', async () => {
    const res = await GET(url(`studentId=${FIGLIO_A}&limit=2&offset=0`))
    expect(res.status).toBe(200)
    const body = await res.json() as { media: Array<Record<string, unknown>>; total: number; limit: number; offset: number }
    expect(body.media.map((m) => m.id)).toEqual([FOTO_2, FOTO_1])
    expect(body.total).toBe(2)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(0)
    expect(body.media[0].tag_students).toBeUndefined()
  })

  it('una foto della sezione A non arriva alla famiglia B, anche se oggi il filtro la lascia passare', async () => {
    h.requireUser.mockResolvedValue(famiglia(GEN_B))

    const res = await GET(url(`studentId=${FIGLIO_B}`))
    const body = await res.json() as { media: unknown[]; total: number }

    expect(res.status).toBe(200)
    expect(body.media).toEqual([])
    expect(body.total).toBe(0)
  })

  it('la funzione si chiama con l’utente del gate, mai con il `parentId` del client', async () => {
    await GET(url(`studentId=${FIGLIO_A}&parentId=${GEN_A}&limit=7&offset=14`))

    const chiamata = h.chiamate.find((c) => c.nome === 'galleria_pagina_genitore')
    expect(chiamata?.args).toMatchObject({ p_utente: GEN_A, p_alunno: FIGLIO_A, p_limit: 7, p_offset: 14, p_dal: null, p_al: null })
  })

  it('il filtro della data arriva alla funzione', async () => {
    await GET(url(`studentId=${FIGLIO_A}&date=2026-10-20`))

    const chiamata = h.chiamate.find((c) => c.nome === 'galleria_pagina_genitore')
    expect(chiamata?.args).toMatchObject({ p_dal: '2026-10-20T00:00:00.000Z', p_al: '2026-10-20T23:59:59.999Z' })
  })

  it('un figlio legato ma non attivo: 403 `FIGLIO_NON_ATTIVO`, e nessuna foto viene letta', async () => {
    h.figliAttivi = (() => ({ data: [], error: null })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'FIGLIO_NON_ATTIVO' })
    expect(h.tabelleLette).not.toContain('galleria_media_v2')
  })

  it('oltre la fine: il totale c’è e le foto no', async () => {
    h.pagina = (() => ({ data: [{ media_id: null, totale: 2 }], error: null })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}&offset=30`))
    const body = await res.json() as { media: unknown[]; total: number }

    expect(body.media).toEqual([])
    expect(body.total).toBe(2)
  })

  it('una foto buttata nel cestino fra le due letture non esce', async () => {
    h.db.galleria_media_v2[1].eliminato_il = '2026-10-30T10:00:00Z'

    const res = await GET(url(`studentId=${FIGLIO_A}`))
    const body = await res.json() as { media: Array<{ id: string }> }

    expect(body.media.map((m) => m.id)).toEqual([FOTO_1])
  })

  it('schema indietro: il filtro di oggi, con un `info`', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: 'PGRST202', message: 'assente' } })) as Rpc
    h.pagina = (() => ({ data: null, error: { code: '42883', message: 'assente' } })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))
    const body = await res.json() as { media: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(body.media.map((m) => m.id).sort()).toEqual([FOTO_1, FOTO_2, FOTO_ALTRA_SEZIONE].sort())
    expect(h.logEvento).toHaveBeenCalledWith('anno-scolastico', 'info', expect.objectContaining({
      operazione: 'anno/visibilita:galleria_pagina_genitore',
      esito: 'schema-indietro',
    }))
  })

  it('un guasto della pagina non apre: 500 e nessuna foto', async () => {
    h.pagina = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.tabelleLette).not.toContain('galleria_media_v2')
  })

  it('un guasto del figlio attivo non apre: 500 e nessuna foto', async () => {
    h.figliAttivi = (() => ({ data: null, error: { code: '57014', message: 'timeout' } })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(500)
    expect(h.tabelleLette).not.toContain('galleria_media_v2')
  })

  // La via è concreta: `media_visibili_genitore` legge `target_classes`, e la PR 5 toglie quella colonna.
  it.each(['42703', '42P01'])('una colonna o una tabella sparita nel corpo della pagina (%s) non torna al filtro largo', async (code) => {
    h.pagina = (() => ({ data: null, error: { code, message: 'assente nel corpo' } })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.tabelleLette).not.toContain('galleria_media_v2')
  })

  it.each(['42703', '42P01'])('lo stesso nel corpo di `figli_attivi` (%s): non è schema indietro', async (code) => {
    h.figliAttivi = (() => ({ data: null, error: { code, message: 'assente nel corpo' } })) as Rpc

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(500)
    expect(h.tabelleLette).not.toContain('galleria_media_v2')
  })
})

describe('GET /api/gallery, una docente sul proprio figlio', () => {
  it('passa per legame, quindi è famiglia anche in veste di lavoro', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_A, role: 'educator', ruoli: ['educator', 'genitore'] } })

    const res = await GET(url(`studentId=${FIGLIO_A}`))
    const body = await res.json() as { media: Array<{ id: string }> }

    expect(res.status).toBe(200)
    expect(body.media.map((m) => m.id)).toEqual([FOTO_2, FOTO_1])
    expect(h.chiamate.map((c) => c.nome)).toContain('galleria_pagina_genitore')
  })
})

describe('GET /api/gallery, chi non è famiglia resta com’è', () => {
  it('la segreteria con `studentId` non passa dalle funzioni', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GEN_B, role: 'segreteria', ruoli: ['segreteria'] } })

    const res = await GET(url(`studentId=${FIGLIO_A}`))

    expect(res.status).toBe(200)
    expect(h.chiamate).toEqual([])
    const body = await res.json() as { media: Array<{ id: string }> }
    expect(body.media.map((m) => m.id).sort()).toEqual([FOTO_1, FOTO_2, FOTO_ALTRA_SEZIONE].sort())
  })
})
