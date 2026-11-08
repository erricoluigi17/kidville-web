/**
 * PR 4.4 · Le due pagine della chat, montate davvero: `scrivibile` arriva dalla lista e spegne il campo, e un 403
 * `chat_sola_lettura` scoperto all'invio fa lo stesso, anche se la lista ricaricata non ha più quel thread. Il testo resta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  identita: { userId: 'gen-1', ready: true, role: 'genitore' },
}))

vi.mock('next-intl', () => {
  const t = (k: string, v?: Record<string, unknown>) =>
    v ? `${k}:${Object.values(v).join(',')}` : k
  return {
    useTranslations: () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }),
    useLocale: () => 'it',
    useFormatter: () => ({ dateTime: (x: unknown) => String(x), number: (x: unknown) => String(x) }),
  }
})
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'X'),
}))
vi.mock('@/lib/auth/use-session-identity', () => ({ useSessionIdentity: () => h.identita }))
vi.mock('@/components/features/chat/useChatRealtime', () => ({ useChatRealtime: () => {} }))
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }))
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/chat',
  useParams: () => ({}),
}))

const THREAD = {
  id: 'th-1', teacher_id: 'doc-1', parent_id: 'gen-1', student_id: 'alu-1',
  other_user: { id: 'x', first_name: 'Dora', last_name: 'Docente' },
  student: { id: 'alu-1', nome: 'n', cognome: 'c', classe_sezione: 'Girasoli' },
  last_message: null, last_message_at: '2026-09-07T10:00:00Z', unread_count: 0, sospensione: null,
}

let listaThread: Record<string, unknown>[] = []
let dopoIl403: Record<string, unknown>[] | null = null
let invii = 0

beforeEach(() => {
  invii = 0
  dopoIl403 = null
  h.identita = { userId: 'gen-1', ready: true, role: 'genitore' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url)
    const m = init?.method ?? 'GET'
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
    if (u.includes('/api/chat/threads') && m === 'GET') return ok(listaThread)
    if (u.includes('/api/chat/contacts')) return ok({ contacts: [], existing_count: 1, motivo: null })
    if (u.includes('/api/chat/messages') && m === 'POST') {
      invii += 1
      if (dopoIl403) listaThread = dopoIl403
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: 'x', codice: 'CHAT_SOLA_LETTURA', motivo: 'chat_sola_lettura' }),
      }
    }
    if (u.includes('/api/chat/messages') && m === 'GET') return ok({ messages: [], total: 0 })
    return ok({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

class FintoIO {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return [] }
  root = null; rootMargin = ''; thresholds = []
}
vi.stubGlobal('IntersectionObserver', FintoIO as unknown as typeof IntersectionObserver)
Element.prototype.scrollIntoView = function () {}

import ParentChatPage from '@/app/(dashboard)/parent/chat/page'
import TeacherChatPage from '@/app/(dashboard)/teacher/chat/page'

const apri = async () => {
  fireEvent.click((await screen.findAllByText(/Dora Docente/, {}, { timeout: 3000 }))[0])
  return (await screen.findAllByRole('textbox', {}, { timeout: 3000 }))[0] as HTMLTextAreaElement
}

describe.each([
  ['genitore', ParentChatPage, { userId: 'gen-1', ready: true, role: 'genitore' }],
  ['docente', TeacherChatPage, { userId: 'doc-1', ready: true, role: 'educator' }],
] as const)('la pagina della chat, %s', (_nome, Pagina, identita) => {
  beforeEach(() => {
    h.identita = identita
  })

  it('`scrivibile: false` dalla lista: campo spento, con il motivo', async () => {
    listaThread = [{ ...THREAD, scrivibile: false }]
    render(<Pagina />)

    const campo = await apri()

    expect(campo.disabled).toBe(true)
    expect(screen.getAllByRole('status').some((n) => n.textContent === 'chatSolaLettura')).toBe(true)
  })

  it('`scrivibile: true`: il campo è acceso e non dice niente', async () => {
    listaThread = [{ ...THREAD, scrivibile: true }]
    render(<Pagina />)

    const campo = await apri()

    expect(campo.disabled).toBe(false)
    expect(screen.queryByText('chatSolaLettura')).toBeNull()
  })

  it('il 403 scoperto all’invio spegne il campo e il testo resta, anche se il thread sparisce dalla lista', async () => {
    listaThread = [{ ...THREAD, scrivibile: true }]
    dopoIl403 = []
    render(<Pagina />)

    const campo = await apri()
    fireEvent.change(campo, { target: { value: 'ciao' } })
    fireEvent.click(screen.getAllByLabelText('chatInputAriaInvia')[0])

    await waitFor(() => expect(screen.getAllByText('chatSolaLettura').length).toBeGreaterThan(0))
    expect(invii).toBe(1)
    const dopo = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement
    expect(dopo.disabled).toBe(true)
    expect(dopo.value).toBe('ciao')
  })
})
