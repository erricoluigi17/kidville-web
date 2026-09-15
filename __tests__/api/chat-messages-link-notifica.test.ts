import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL LINK DELLA NOTIFICA DI CHAT PORTA LA CONVERSAZIONE, NON SOLO LA PAGINA.
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * `POST /api/chat/messages` accodava la notifica alla controparte con
 * `link: '/teacher/chat'` o `'/parent/chat'`: la pagina delle chat, e basta. Il tocco
 * sulla notifica apriva la LISTA delle conversazioni, e toccava a chi l'aveva ricevuta
 * cercare quella giusta — per un docente, fra le famiglie di tutta la sezione.
 *
 * Decisione del titolare (2026-09-14): il tocco apre DIRETTAMENTE la conversazione. Il
 * link nasce qui, e da qui lo trasportano senza modifiche la push nativa (`data.url`) e
 * il dispatch web (`url: n.link`): se il thread non entra nel link in questa riga, non
 * c'è nessun altro punto del percorso che possa rimetterlo.
 *
 * ─── L'AREA È IL POSTO NEL THREAD ────────────────────────────────────────────
 * `/parent/…` se la controparte occupa il posto del genitore, `/teacher/…` se occupa
 * quello del docente. Il server non può sapere quale veste sia attiva sul telefono di chi
 * riceve: per le poche persone con due profili la riscrive il client sull'area in cui si
 * trovano (`instradaLinkNotifica`, `src/lib/chat/link-conversazione.ts`).
 *
 * UUID finti e fissi, nessun dato di una persona vera.
 */

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000011'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000012'
const THREAD = 'dddddddd-0000-4000-8000-000000000014'
const ALUNNO = 'cccccccc-0000-4000-8000-000000000013'
const SEDE = 'eeeeeeee-0000-4000-8000-000000000015'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  controparteThread: vi.fn(),
  notificaEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: async () => null }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: h.controparteThread }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: async () => null }))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.is = () => b
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: { teacher_id: TEACHER, parent_id: PARENT, student_id: ALUNNO }, error: null }
      if (table === 'parents') return { data: { consensi_gdpr: { privacy: true, termini: true } }, error: null }
      if (table === 'alunni') return { data: { scuola_id: SEDE }, error: null }
      return { data: null, error: null }
    }
    b.insert = (row: Record<string, unknown>) => ({
      select: () => ({ single: async () => ({ data: { id: 'msg-nuovo', ...row }, error: null }) }),
    })
    b.update = () => ({ eq: async () => ({ error: null }) })
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/messages/route'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Ciò con cui la notifica è stata accodata. */
const notificata = () => h.notificaEvento.mock.calls[0]?.[1] as Record<string, unknown> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/chat/messages — il link della notifica apre la conversazione', () => {
  it('scrive il GENITORE: il docente riceve /teacher/chat?thread=<id del thread>', async () => {
    h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: SEDE } })
    h.controparteThread.mockResolvedValue({ utenteId: TEACHER, versoGenitore: false })

    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(notificata()).toMatchObject({
      tipo: 'chat_docente',
      utenteIds: [TEACHER],
      link: `/teacher/chat?thread=${THREAD}`,
      entitaTipo: 'chat_thread',
      entitaId: THREAD,
    })
  })

  it('scrive il DOCENTE: il genitore riceve /parent/chat?thread=<id del thread>', async () => {
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: SEDE } })
    h.controparteThread.mockResolvedValue({ utenteId: PARENT, versoGenitore: true })

    const res = await POST(postReq({ thread_id: THREAD, content: 'ricevuto' }))

    expect(res.status).toBe(201)
    expect(notificata()).toMatchObject({
      tipo: 'chat_genitore',
      utenteIds: [PARENT],
      link: `/parent/chat?thread=${THREAD}`,
      entitaTipo: 'chat_thread',
      entitaId: THREAD,
    })
  })

  it('nel link finisce solo l’id del thread: niente testo, niente mittente', async () => {
    h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: SEDE } })
    h.controparteThread.mockResolvedValue({ utenteId: TEACHER, versoGenitore: false })

    await POST(postReq({ thread_id: THREAD, content: 'il pediatra ha detto varicella' }))

    const link = String(notificata()?.link)
    expect(link).not.toContain('varicella')
    expect(link).not.toContain(PARENT)
    expect(new URL(link, 'http://x').searchParams.get('thread')).toBe(THREAD)
    expect([...new URL(link, 'http://x').searchParams.keys()]).toEqual(['thread'])
  })
})
