import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import labels from '../../messages/it/parentServizi.json'

const h = vi.hoisted(() => ({ fetch: vi.fn(), scarica: vi.fn(), ready: true, verdict: vi.fn(), downloadFails: false }))
const ID = '55555555-5555-4555-8555-555555555555'
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/parent/modulistica', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({ useSessionIdentity: () => ({ userId: 'parent', pronto: true }) }))
vi.mock('@/components/features/prestampati/PrestampatiGenitore', () => ({ PrestampatiGenitore: () => null }))
vi.mock('@/lib/native/scarica', async (original) => ({ ...await original<typeof import('@/lib/native/scarica')>(), scaricaDocumento: h.scarica }))
vi.mock('@/components/features/parent/forms/OtpEmailModal', () => ({ OtpEmailModal: ({ open, onVerify }: { open: boolean; onVerify: (code: string) => Promise<unknown> }) => open ? <button onClick={() => void onVerify('123456').then(h.verdict)}>Conferma codice di prova</button> : null }))
const FORM = { form_id: 'form', title: 'Visita di prova', description: '', form_type: 'autorizzazione', fields: [], status: 'pending', student: { id: 'child', nome: 'Bimba', cognome: 'Prova', classe_sezione: 'A' } }
beforeEach(() => {
  vi.clearAllMocks(); h.ready = true; h.downloadFails = false
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  h.fetch.mockImplementation((input: string, options?: RequestInit) => {
    if (input === '/api/parent/forms') return Promise.resolve({ ok: true, json: async () => [FORM] })
    if (input === '/api/parent/forms/otp') return Promise.resolve({ ok: true, json: async () => options?.method === 'PATCH'
      ? { ok: true, submission: { id: ID }, pdf_ready: h.ready, pdf_error: h.ready ? undefined : 'PDF_UPLOAD_FAILED' }
      : { sent: true, expiry: 123, ticket: 'ticket', email: 'parent@example.invalid' } })
    if (input.includes('/api/forms/signed-pdf')) {
      if (h.downloadFails) return Promise.reject(new Error('Rete'))
      return Promise.resolve(options?.method === 'POST' ? { ok: true, json: async () => ({ pdf_ready: true }) }
        : { ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => new Blob(['pdf']) })
    }
    return Promise.resolve({ ok: true, json: async () => [] })
  })
  vi.stubGlobal('fetch', h.fetch)
})
afterEach(() => cleanup())
import ParentModulisticaPage from '@/app/(dashboard)/parent/modulistica/page'
async function sign() {
  render(<ParentModulisticaPage />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(labels.modulisticaCompilaFirma) }))
  fireEvent.click(screen.getByRole('button', { name: labels.modulisticaInviaFirmaRicevuta }))
  fireEvent.click(await screen.findByRole('button', { name: 'Conferma codice di prova' }))
  await waitFor(() => expect(h.verdict).toHaveBeenCalledWith({ ok: true }))
}
describe('firma accettata separata dalla disponibilità e consegna PDF', () => {
  it('se pronto scarica il documento completo dopo firma', async () => {
    await sign()
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('/api/forms/signed-pdf'))).toBe(true)
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('/api/fea/receipt'))).toBe(false)
  })
  it('PDF guasto conserva successo firma e offre retry POST/GET senza nuovo OTP', async () => {
    h.ready = false
    await sign()
    expect(await screen.findByText('Firma registrata, PDF non disponibile')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova a scaricare il documento' }))
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    expect(h.fetch.mock.calls.filter(([url]) => url === '/api/parent/forms/otp')).toHaveLength(2)
    expect(h.fetch.mock.calls.filter(([url]) => String(url).includes('/api/forms/signed-pdf'))).toHaveLength(2)
  })
  it('guasto di download dopo firma non trasforma la firma in fallimento', async () => {
    h.downloadFails = true
    await sign()
    expect(await screen.findByText('Firma registrata, PDF non disponibile')).toBeInTheDocument()
  })
})
