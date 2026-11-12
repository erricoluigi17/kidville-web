import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Integrazioni } from '@/components/features/crm/integrazioni/Integrazioni'
import shared from '../../../messages/it/shared.json'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'

const h = vi.hoisted(() => ({
  auth: null as ((evento: string) => void) | null,
  log: vi.fn(),
  ruolo: 'admin',
}))
vi.mock('@/lib/context/admin-identity', () => ({ useRuoloCockpit: () => h.ruolo }))
vi.mock('@/lib/supabase/browser-client', () => ({
  getSupabase: () => ({
    auth: {
      onAuthStateChange: (callback: (evento: string) => void) => {
        h.auth = callback
        return { data: { subscription: { unsubscribe: () => { h.auth = null } } } }
      },
    },
  }),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log }))

const API = '/api/admin/crm/integrazioni'
const TOKEN = 'kvai_' + 'T'.repeat(43)
const ID = '11111111-1111-4111-8111-111111111111'
const RIGA = {
  id: ID,
  nome: 'Chiave di prova',
  coda: 'AAAA',
  creataIl: '2026-11-09T23:10:00Z',
  revocataIl: null,
  ultimoUsoIl: null,
}
const NESSUNA = 'Nessuna chiave attiva.'
const CREA = 'Crea la chiave'
const SOLO_DIREZIONE = 'Questa pagina è riservata alla Direzione.'
const SPENTO = 'L’accesso dell’assistente è spento per questa sede.'
const COPIA_ORA = 'Copiala adesso: quando chiudi questa finestra non la potrai più rivedere.'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const elenco = (data: unknown[] = [], aiAttivo = true, sedeAmmessa = true) => json({ data, aiAttivo, sedeAmmessa })
const rifiuto = (status: number, codice: string) => json({ error: TOKEN, codice, token: TOKEN }, status)
const writeText = vi.fn<(testo: string) => Promise<void>>()
const fetchFinto = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const URL_GET = (sede: string) => API + '?scuolaId=' + sede

function inAttesa() {
  let rispondi!: (res: Response) => void
  const risposta = new Promise<Response>((resolve) => { rispondi = resolve })
  return { risposta, rispondi }
}

beforeEach(() => {
  fetchFinto.mockReset()
  fetchFinto.mockImplementation(async () => { throw new Error('Richiesta non prevista') })
  writeText.mockReset().mockResolvedValue(undefined)
  h.log.mockClear()
  h.ruolo = 'admin'
  vi.stubGlobal('fetch', fetchFinto)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
})

afterEach(() => {
  cleanup()
  expect(h.auth).toBeNull()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function preparaCreazione() {
  fetchFinto.mockResolvedValueOnce(elenco())
  render(<Integrazioni scuolaId={SEDE_A} />)
  return screen.findByRole('button', { name: CREA })
}

describe('CRM · Chiave dell’assistente', () => {
  it('una segretaria vede subito «riservata alla Direzione», senza chiamare la rotta né scrivere un log', async () => {
    h.ruolo = 'segreteria'
    const { container } = render(<Integrazioni scuolaId={SEDE_A} />)
    expect(container.textContent).toBe(SOLO_DIREZIONE)
    await act(async () => { await Promise.resolve() })
    expect(fetchFinto).not.toHaveBeenCalled()
    expect(h.log).not.toHaveBeenCalled()
    expect(h.auth).toBeNull()
  })

  it('finché il ruolo non è noto non chiama la rotta e non mostra né l’avviso né il modulo', async () => {
    h.ruolo = ''
    const { container } = render(<Integrazioni scuolaId={SEDE_A} />)
    await act(async () => { await Promise.resolve() })
    expect(fetchFinto).not.toHaveBeenCalled()
    expect(h.log).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain(SOLO_DIREZIONE)
    expect(screen.queryByRole('button', { name: CREA })).toBeNull()
  })

  it('con 403 SOLO_ADMIN mostra soltanto l’avviso per la Direzione', async () => {
    fetchFinto.mockResolvedValueOnce(rifiuto(403, 'SOLO_ADMIN'))
    const { container } = render(<Integrazioni scuolaId={SEDE_A} />)
    await screen.findByText(SOLO_DIREZIONE)
    expect(container.textContent).toBe(SOLO_DIREZIONE)
    expect(screen.queryByRole('button')).toBeNull()
    expect(fetchFinto.mock.calls).toEqual([[URL_GET(SEDE_A), expect.any(Object)]])
  })

  it.each([[false, true], [true, false]])('impedisce la creazione con interruttore %s e sede ammessa %s', async (aiAttivo, sedeAmmessa) => {
    fetchFinto.mockResolvedValueOnce(elenco([], aiAttivo, sedeAmmessa))
    render(<Integrazioni scuolaId={SEDE_A} />)
    await screen.findByText(SPENTO)
    expect(screen.queryByRole('button', { name: CREA })).toBeNull()
  })

  it('senza chiave attiva mostra il modulo con il nome Assistente', async () => {
    await preparaCreazione()
    expect(screen.getByText(NESSUNA)).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Nome della chiave' }).value).toBe('Assistente')
  })

  it('crea, mostra il token una volta, lo copia su richiesta e lo rimuove alla chiusura', async () => {
    const scriviStorage = vi.spyOn(Storage.prototype, 'setItem')
    const crea = await preparaCreazione()
    fetchFinto
      .mockResolvedValueOnce(json({ id: ID, token: TOKEN }, 201))
      .mockResolvedValueOnce(elenco([{ ...RIGA, coda: 'TTTT' }]))
    fireEvent.click(crea)

    const avviso = await screen.findByText(COPIA_ORA)
    const dialogo = screen.getByRole('dialog', { name: 'Chiave dell’assistente' })
    expect(dialogo.contains(avviso)).toBe(true)
    expect(screen.getAllByText(TOKEN)).toHaveLength(1)
    expect(fetchFinto).toHaveBeenNthCalledWith(2, API, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ scuolaId: SEDE_A, nome: 'Assistente' }),
    }))
    expect(writeText).not.toHaveBeenCalled()
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Copia la chiave' }))
    await within(dialogo).findByText('Chiave copiata.')
    expect(writeText).toHaveBeenCalledExactlyOnceWith(TOKEN)

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Chiudi' }))
    await screen.findByText('Attiva · finisce per TTTT')
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(window.location.href).not.toContain(TOKEN)
    expect(JSON.stringify(scriviStorage.mock.calls)).not.toContain(TOKEN)
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(TOKEN)
  })

  it('chiede conferma prima di revocare e mostra lo storico e le date nel fuso di Roma', async () => {
    fetchFinto
      .mockResolvedValueOnce(elenco([RIGA]))
      .mockResolvedValueOnce(json({ id: ID, revocata: true }))
      .mockResolvedValueOnce(elenco([{ ...RIGA, revocataIl: '2026-11-10T23:15:00Z', ultimoUsoIl: '2026-11-09T23:10:00Z' }]))
    render(<Integrazioni scuolaId={SEDE_A} />)
    await screen.findByText('Attiva · finisce per AAAA')
    expect(screen.getByText('Mai usata')).toBeTruthy()
    expect(screen.queryByRole('button', { name: CREA })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Revoca' }))
    let dialogo = screen.getByRole('dialog', { name: 'Revoca' })
    expect(within(dialogo).getByText('Revocare la chiave? L’assistente smette subito di funzionare per questa sede.')).toBeTruthy()
    expect(fetchFinto).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchFinto).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Revoca' }))
    dialogo = screen.getByRole('dialog', { name: 'Revoca' })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Revoca' }))

    await screen.findByText('Revocata il 11/11/2026')
    expect(screen.getByText('Ultimo uso: 10/11/2026, 00:10')).toBeTruthy()
    expect(screen.getByText(NESSUNA)).toBeTruthy()
    expect(screen.getByRole('button', { name: CREA })).toBeTruthy()
    expect(fetchFinto).toHaveBeenNthCalledWith(2, API + '/' + ID, expect.objectContaining({ method: 'DELETE' }))
  })

  it('con 409 INTEGRAZIONE_ESISTENTE usa la frase del catalogo e non mostra o registra il corpo', async () => {
    const crea = await preparaCreazione()
    fetchFinto.mockResolvedValueOnce(rifiuto(409, 'INTEGRAZIONE_ESISTENTE')).mockResolvedValueOnce(elenco([RIGA]))
    fireEvent.click(crea)
    await screen.findByText(shared.erroreCrmAiIntegrazioneEsistente)
    await screen.findByText('Attiva · finisce per AAAA')
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ stato: 409 }))
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(TOKEN)
  })

  it('se la rilettura perde la sessione chiude anche il riquadro della chiave', async () => {
    const crea = await preparaCreazione()
    const tardiva = inAttesa()
    fetchFinto.mockResolvedValueOnce(json({ id: ID, token: TOKEN }, 201)).mockReturnValueOnce(tardiva.risposta)
    fireEvent.click(crea)
    await screen.findByText(TOKEN)

    tardiva.rispondi(rifiuto(401, 'NON_AUTENTICATO'))
    await screen.findByText('La sessione è terminata. Accedi di nuovo.')
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('quando si cambia sede cancella il token già visibile e usa l’elenco della nuova sede', async () => {
    fetchFinto
      .mockResolvedValueOnce(elenco())
      .mockResolvedValueOnce(json({ id: ID, token: TOKEN }, 201))
      .mockResolvedValueOnce(elenco([RIGA]))
      .mockResolvedValueOnce(elenco([], false, false))
    const { rerender } = render(<Integrazioni scuolaId={SEDE_A} />)
    fireEvent.click(await screen.findByRole('button', { name: CREA }))
    await screen.findByText(TOKEN)

    rerender(<Integrazioni scuolaId={SEDE_B} />)
    expect(document.body.textContent).not.toContain(TOKEN)
    await screen.findByText(SPENTO)
    expect(fetchFinto).toHaveBeenLastCalledWith(URL_GET(SEDE_B), expect.any(Object))
    expect(screen.queryByText(RIGA.nome)).toBeNull()
  })

  it('scarta la chiave creata se il POST della prima sede risponde dopo un cambio sede', async () => {
    const tardiva = inAttesa()
    fetchFinto
      .mockResolvedValueOnce(elenco())
      .mockReturnValueOnce(tardiva.risposta)
      .mockResolvedValueOnce(elenco([RIGA]))
    const { rerender } = render(<Integrazioni scuolaId={SEDE_A} />)
    fireEvent.click(await screen.findByRole('button', { name: CREA }))

    rerender(<Integrazioni scuolaId={SEDE_B} />)
    await screen.findByText('Attiva · finisce per AAAA')
    await act(async () => { tardiva.rispondi(json({ id: ID, token: TOKEN }, 201)) })

    expect(document.body.textContent).not.toContain(TOKEN)
    expect(screen.getByText(RIGA.nome)).toBeTruthy()
    expect(fetchFinto).toHaveBeenCalledTimes(3)
  })

  it('scarta anche un elenco in ritardo della sede lasciata', async () => {
    const tardiva = inAttesa()
    fetchFinto.mockReturnValueOnce(tardiva.risposta).mockResolvedValueOnce(elenco())
    const { rerender } = render(<Integrazioni scuolaId={SEDE_A} />)
    rerender(<Integrazioni scuolaId={SEDE_B} />)
    await screen.findByText(NESSUNA)
    await act(async () => { tardiva.rispondi(elenco([RIGA])) })
    expect(screen.getByText(NESSUNA)).toBeTruthy()
    expect(screen.queryByText(RIGA.nome)).toBeNull()
  })

  it('al ritorno con Indietro non ripristina il token dalla memoria di navigazione', async () => {
    const crea = await preparaCreazione()
    fetchFinto
      .mockResolvedValueOnce(json({ id: ID, token: TOKEN }, 201))
      .mockResolvedValueOnce(elenco([RIGA]))
      .mockResolvedValueOnce(rifiuto(401, 'NON_AUTENTICATO'))
    fireEvent.click(crea)
    await screen.findByText(TOKEN)

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      expect(document.body.textContent).not.toContain(TOKEN)
    })
    act(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })) })

    await screen.findByText('La sessione è terminata. Accedi di nuovo.')
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(fetchFinto).toHaveBeenCalledTimes(4)
  })

  it.each(['prima del POST', 'dopo il POST'])('al logout %s spariscono chiave e azioni', async (momento) => {
    const crea = await preparaCreazione()
    const tardiva = inAttesa()
    fetchFinto.mockReturnValueOnce(tardiva.risposta).mockResolvedValueOnce(elenco([RIGA]))
    fireEvent.click(crea)

    if (momento === 'dopo il POST') {
      tardiva.rispondi(json({ id: ID, token: TOKEN }, 201))
      await screen.findByText(TOKEN)
    }
    expect(h.auth).not.toBeNull()
    act(() => { h.auth?.('SIGNED_OUT') })
    if (momento === 'prima del POST') {
      await act(async () => { tardiva.rispondi(json({ id: ID, token: TOKEN }, 201)) })
    }
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
