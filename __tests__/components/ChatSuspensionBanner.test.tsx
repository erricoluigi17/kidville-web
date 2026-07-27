import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ChatSuspensionBanner } from '@/components/features/chat/ChatSuspensionBanner'
import type { SospensioneInfo } from '@/components/features/chat/ChatThreadList'

// C5 §2 — banner di stato "conversazione sospesa" (dichiarato).
//  · chi HA sospeso vede "Hai sospeso questa conversazione" + bottone "Riapri";
//  · chi è sospesa_verso vede "Conversazione sospesa" e NESSUN bottone Riapri
//    (solo il sospendente o la Direzione possono riaprire).

const ME = 'me-0000-0000-0000-000000000001'
const OTHER = 'ot-0000-0000-0000-000000000002'
const THREAD = 'th-0000-0000-0000-000000000003'

const labels: Record<string, string> = {
  ugcBannerSuspendedTitle: 'Conversazione sospesa',
  ugcBannerSuspendedBody: 'Non puoi inviare nuovi messaggi in questa conversazione.',
  ugcBannerISuspendedTitle: 'Hai sospeso questa conversazione',
  ugcBannerISuspendedBody: "L'altra persona non può scriverti finché non la riapri.",
  ugcReopen: 'Riapri',
  ugcReopening: 'Riapertura…',
  ugcReopenError: 'Impossibile riaprire',
}
const t = (k: string) => labels[k] ?? k

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = fetchMock as unknown as typeof fetch
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
})
afterEach(() => cleanup())

const suspByMe: SospensioneInfo = { sospesaDa: ME, sospesaVerso: OTHER, motivo: null, sospesaIl: '2026-07-27T10:00:00Z' }
const suspToMe: SospensioneInfo = { sospesaDa: OTHER, sospesaVerso: ME, motivo: null, sospesaIl: '2026-07-27T10:00:00Z' }

describe('ChatSuspensionBanner', () => {
  it('chi ha sospeso: mostra "Hai sospeso…" + bottone Riapri', () => {
    render(<ChatSuspensionBanner t={t} currentUserId={ME} threadId={THREAD} sospensione={suspByMe} onReopened={vi.fn()} />)
    expect(screen.getByText('Hai sospeso questa conversazione')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Riapri' })).toBeInTheDocument()
  })

  it('sospesa_verso: mostra "Conversazione sospesa" e NESSUN Riapri', () => {
    render(<ChatSuspensionBanner t={t} currentUserId={ME} threadId={THREAD} sospensione={suspToMe} onReopened={vi.fn()} />)
    expect(screen.getByText('Conversazione sospesa')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Riapri' })).toBeNull()
  })

  it('Riapri → POST /api/chat/threads/[id]/riapri e onReopened', async () => {
    const onReopened = vi.fn()
    render(<ChatSuspensionBanner t={t} currentUserId={ME} threadId={THREAD} sospensione={suspByMe} onReopened={onReopened} />)
    fireEvent.click(screen.getByRole('button', { name: 'Riapri' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/chat/threads/${THREAD}/riapri`)
    expect((opts as RequestInit).method).toBe('POST')
    await waitFor(() => expect(onReopened).toHaveBeenCalled())
  })
})
