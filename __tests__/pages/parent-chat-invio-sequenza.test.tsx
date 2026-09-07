/**
 * La chat del GENITORE, montata davvero: testo, poi allegato, come fa la spec E2E.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 *
 * Su questa pagina non c'era nessun test: 700 righe che tengono l'invio, il
 * caricamento, la selezione del thread e le tre guardie UGC, e nessuno le montava.
 * L'unica rete era `e2e/chat.spec.ts` — che gira solo in CI, contro un database
 * separato, e quando cade dice «l'elemento non c'è» senza dire perché.
 *
 * ─── DA QUALE DOMANDA È NATO ─────────────────────────────────────────────────
 *
 * Quella spec è diventata rossa e l'ipotesi era che il ramo nuovo di `ChatInput`
 * (`if (esito === false) return`) impedisse l'invio dei messaggi con allegato, o
 * che l'append ottimistico non avvenisse per quel ramo. Questo file riproduce la
 * sequenza ESATTA della spec — apre il thread, manda il testo, carica il file,
 * manda l'allegato — e passa: il percorso client→handler→schermo è corretto.
 *
 * Non ha trovato il difetto, e va detto: ha ESCLUSO un pezzo grosso di superficie,
 * che è l'altra metà del mestiere. Il difetto vero, alla data in cui questo file
 * nasce, non è ancora identificato.
 *
 * ⚠️ Se un giorno questo test diventa rosso, il difetto è QUI dentro — nel client —
 * e non serve più cercarlo in CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => ({ logClient: vi.fn(), chiamate: [] as Array<[string, string, unknown]> }))

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
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'gen-1', ready: true, role: 'genitore' }),
}))
vi.mock('@/components/features/chat/useChatRealtime', () => ({ useChatRealtime: () => {} }))
vi.mock('@/components/features/chat/useUnreadNotifications', () => ({ useUnreadNotifications: () => {} }))
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/parent/chat',
  useParams: () => ({}),
}))

const THREAD = { id: 'th-1', teacher_id: 'doc-1', parent_id: 'gen-1', student_id: 'alu-1',
  other_user: { id: 'doc-1', first_name: 'Dora', last_name: 'Docente' },
  student: { id: 'alu-1', nome: 'Aurora', cognome: 'A', classe_sezione: 'Girasoli' },
  last_message: null, last_message_at: '2026-09-07T10:00:00Z', unread_count: 0, sospensione: null }

let messaggi: Record<string, unknown>[] = []
let postMessaggi: Record<string, unknown>[] = []

beforeEach(() => {
  messaggi = []
  postMessaggi = []
  h.chiamate.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const u = String(url); const m = init?.method ?? 'GET'
    h.chiamate.push([m, u.split('?')[0], init?.body])
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
    if (u.includes('/api/chat/config')) return ok({})
    if (u.includes('/api/chat/threads') && m === 'GET') return ok([THREAD])
    if (u.includes('/api/chat/contacts')) return ok({ contacts: [], existing_count: 1, motivo: null })
    if (u.includes('/api/chat/messages/read')) return ok({ success: true })
    if (u.includes('/api/chat/messages') && m === 'GET') return ok({ messages: messaggi, total: messaggi.length })
    if (u.includes('/api/chat/messages') && m === 'POST') {
      const b = JSON.parse(String(init?.body))
      postMessaggi.push(b)
      const nuovo = { id: `m-${messaggi.length + 1}`, thread_id: b.thread_id, sender_id: 'gen-1',
        content: b.content, attachment_url: b.attachment_url ?? null,
        attachment_type: b.attachment_type ?? null, created_at: new Date().toISOString(),
        read_at: null, delivered_at: null }
      messaggi = [...messaggi, nuovo]
      return { ok: true, status: 201, json: async () => nuovo }
    }
    if (u.includes('/api/chat/upload')) return ok({ path: 'gen-1/x.png', name: 'allegato.png', attachment_type: 'image' })
    if (u.includes('/api/notifiche')) return ok({ notifiche: [], non_lette: 0 })
    return ok({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// jsdom non ha `IntersectionObserver`: `ChatMessageArea` lo usa per il mark-read.
class FintoIO {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return [] }
  root = null; rootMargin = ''; thresholds = []
}
vi.stubGlobal('IntersectionObserver', FintoIO as unknown as typeof IntersectionObserver)
// jsdom non implementa `scrollIntoView`.
Element.prototype.scrollIntoView = function () {}

import ParentChatPage from '@/app/(dashboard)/parent/chat/page'

describe('la sequenza esatta della spec E2E, sulla pagina vera', () => {
  it('testo, poi allegato: entrambi finiscono nel thread', async () => {
    render(<ParentChatPage />)
    // apre la conversazione
    const thread = (await screen.findAllByText('Dora Docente', {}, { timeout: 3000 }))[0]
    fireEvent.click(thread)

    const campo = (await screen.findAllByRole('textbox', {}, { timeout: 3000 }))[0]
    fireEvent.change(campo, { target: { value: 'Ciao maestra! Messaggio E2E.' } })
    fireEvent.click(screen.getAllByLabelText('chatInputAriaInvia')[0])
    await waitFor(() => expect(postMessaggi).toHaveLength(1))
    expect(postMessaggi[0].content).toBe('Ciao maestra! Messaggio E2E.')

    // ora l'ALLEGATO, come fa la spec
    const file = new File(['x'], 'allegato.png', { type: 'image/png' })
    fireEvent.change(document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement, { target: { files: [file] } })
    await screen.findAllByText('allegato.png')
    fireEvent.click(screen.getAllByLabelText('chatInputAriaInvia')[0])

    await waitFor(() => expect(postMessaggi).toHaveLength(2), { timeout: 3000 })
    expect(postMessaggi[1]).toMatchObject({ content: '📎 Allegato', attachment_url: 'gen-1/x.png', attachment_type: 'image' })
    // ...e si VEDE a schermo: è l'asserzione che la spec E2E fa e che cade in CI
    expect((await screen.findAllByText('📎 Allegato')).length).toBeGreaterThan(0)
  })
})
