import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ChatConversationMenu } from '@/components/features/chat/ChatConversationMenu'

// C5 §2 — menu ⋮ della conversazione (chat 1:1). Tre voci ETICHETTATE (mai solo
// icona): "Segnala messaggio", "Segnala utente", "Sospendi conversazione".
//  · segnala utente → POST /api/segnalazioni { tipo_oggetto:'utente', segnalato_id }
//  · segnala messaggio → POST /api/segnalazioni { tipo_oggetto:'messaggio_chat', oggetto_id }
//  · sospendi → POST /api/chat/threads/[id]/sospendi, poi onSuspended
//  · a conversazione già sospesa, la voce "Sospendi" scompare.

const ME = 'me-0000-0000-0000-000000000001'
const OTHER = 'ot-0000-0000-0000-000000000002'
const THREAD = 'th-0000-0000-0000-000000000003'
const MSG = 'ms-0000-0000-0000-000000000004'

const labels: Record<string, string> = {
  ugcMenuLabel: 'Opzioni conversazione',
  ugcReportMessage: 'Segnala messaggio',
  ugcReportUser: 'Segnala utente',
  ugcSuspend: 'Sospendi conversazione',
  ugcSuspendTitle: 'Sospendi conversazione',
  ugcSuspendExplain: 'Spiegazione',
  ugcSuspendMotivoLabel: 'Motivo (opzionale)',
  ugcSuspendMotivoPlaceholder: 'Motivo…',
  ugcSuspendConfirm: 'Sospendi',
  ugcSuspendCancel: 'Annulla',
  ugcSuspendSending: 'Sospensione…',
  ugcSuspendError: 'Errore sospensione',
  ugcSuspendAlready: 'Già sospesa',
  ugcReportMessageTitle: 'Segnala messaggio',
  ugcReportUserTitle: 'Segnala utente',
}
const t = (k: string) => labels[k] ?? k

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true, id: 'x' }) })
})
afterEach(() => cleanup())

function renderMenu(over: Partial<Parameters<typeof ChatConversationMenu>[0]> = {}) {
  return render(
    <ChatConversationMenu
      t={t}
      currentUserId={ME}
      threadId={THREAD}
      controparteId={OTHER}
      lastIncomingMessageId={MSG}
      isSuspended={false}
      onSuspended={vi.fn()}
      {...over}
    />,
  )
}

describe('ChatConversationMenu — voci etichettate', () => {
  it('apre il menu e mostra le tre voci col testo', () => {
    renderMenu()
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    expect(screen.getByText('Segnala messaggio')).toBeInTheDocument()
    expect(screen.getByText('Segnala utente')).toBeInTheDocument()
    expect(screen.getByText('Sospendi conversazione')).toBeInTheDocument()
  })

  it('a conversazione già sospesa, la voce "Sospendi" non compare (ma le segnalazioni sì)', () => {
    renderMenu({ isSuspended: true })
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    expect(screen.queryByText('Sospendi conversazione')).toBeNull()
    expect(screen.getByText('Segnala utente')).toBeInTheDocument()
  })

  it('senza messaggi in arrivo, "Segnala messaggio" non compare', () => {
    renderMenu({ lastIncomingMessageId: null })
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    expect(screen.queryByText('Segnala messaggio')).toBeNull()
    expect(screen.getByText('Segnala utente')).toBeInTheDocument()
  })

  it('Segnala utente → POST /api/segnalazioni con tipo_oggetto utente e segnalato_id', async () => {
    renderMenu()
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    fireEvent.click(screen.getByText('Segnala utente'))
    // Il dialog di segnalazione è aperto: invia.
    fireEvent.click(screen.getByRole('button', { name: /Invia/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/segnalazioni')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body).toMatchObject({ tipo_oggetto: 'utente', segnalato_id: OTHER })
  })

  it('Segnala messaggio → POST /api/segnalazioni con messaggio_chat + oggetto_id + thread_id', async () => {
    renderMenu()
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    fireEvent.click(screen.getByText('Segnala messaggio'))
    fireEvent.click(screen.getByRole('button', { name: /Invia/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toMatchObject({ tipo_oggetto: 'messaggio_chat', oggetto_id: MSG, thread_id: THREAD })
  })

  it('Sospendi → dialog conferma → POST sospendi e onSuspended col nuovo stato', async () => {
    const onSuspended = vi.fn()
    renderMenu({ onSuspended })
    fireEvent.click(screen.getByLabelText('Opzioni conversazione'))
    fireEvent.click(screen.getByText('Sospendi conversazione'))
    // Conferma nel modal.
    fireEvent.click(screen.getByRole('button', { name: 'Sospendi' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/chat/threads/${THREAD}/sospendi`)
    expect((opts as RequestInit).method).toBe('POST')
    await waitFor(() => expect(onSuspended).toHaveBeenCalled())
    const s = onSuspended.mock.calls[0][0]
    expect(s).toMatchObject({ sospesaDa: ME, sospesaVerso: OTHER })
  })
})
