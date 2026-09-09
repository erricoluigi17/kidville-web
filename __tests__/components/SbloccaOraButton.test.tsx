import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// =============================================================================
// L9 — IL BOTTONE CHE FINORA NON ESISTEVA.
//
// `POST /api/primaria/sblocca` è in produzione da mesi e non ha MAI avuto un
// chiamante: `grep` su `src`, `__tests__` ed `e2e` non ne trovava uno. Il
// risultato, misurato sul codice: la pagina admin del registro è un re-export di
// quella docente, quindi il dirigente riceveva lo stesso 423 con lo stesso
// messaggio — «Richiedi lo sblocco al dirigente» — indirizzato a sé stesso.
//
// Questo file fissa le quattro cose che il bottone deve fare e le tre che non
// deve fare mai:
//  · si mostra SOLO a chi ha il ruolo per sbloccare (il gate vero resta sul
//    server: qui si evita di offrire un comando che risponderebbe 403);
//  · non parte SENZA motivazione — `sblocchi_audit.motivazione` è NOT NULL, e
//    una motivazione inventata dal client sarebbe una firma falsa su un registro
//    di minori;
//  · manda le coordinate dello SLOT, che è tutto il punto: l'ora mai firmata una
//    riga non ce l'ha, quindi non c'è nessun `entitaId` da mandare;
//  · un rifiuto del server si LEGGE (e si logga), non sparisce.
// =============================================================================

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient }))

import { SbloccaOraButton, puoSbloccare } from '@/components/features/primaria/SbloccaOraButton'

const SEZIONE = 'aaaa1111-0000-4000-8000-0000000000a1'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const LUNEDI = '2026-09-07'

const fetchMock = vi.fn()

function montaDaDirigente(extra: Record<string, unknown> = {}) {
  const onSbloccato = vi.fn()
  render(
    <SbloccaOraButton
      sectionId={SEZIONE}
      data={LUNEDI}
      oraLezione={3}
      userId={DIRIGENTE}
      ruolo="admin"
      onSbloccato={onSbloccato}
      {...extra}
    />,
  )
  return { onSbloccato }
}

/** Apre il pannello e scrive la motivazione. Ritorna il comando di conferma. */
function apriEScrivi(motivazione: string) {
  fireEvent.click(screen.getByRole('button', { name: /sblocca/i }))
  fireEvent.change(screen.getByLabelText(/motivo/i), { target: { value: motivazione } })
  return screen.getByRole('button', { name: /autorizza/i })
}

beforeEach(() => {
  fetchMock.mockReset()
  h.logClient.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SbloccaOraButton — chi lo vede', () => {
  it('la maestra NON lo vede: il comando è della dirigenza', () => {
    render(
      <SbloccaOraButton
        sectionId={SEZIONE}
        data={LUNEDI}
        oraLezione={3}
        userId={DIRIGENTE}
        ruolo="educator"
        onSbloccato={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /sblocca/i })).toBeNull()
  })

  it('senza un ruolo noto non si mostra nulla (fail-closed)', () => {
    render(
      <SbloccaOraButton
        sectionId={SEZIONE}
        data={LUNEDI}
        oraLezione={3}
        userId={DIRIGENTE}
        ruolo={null}
        onSbloccato={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /sblocca/i })).toBeNull()
  })

  it('dirigenza (admin e coordinator) lo vede', () => {
    expect(puoSbloccare('admin')).toBe(true)
    expect(puoSbloccare('coordinator')).toBe(true)
    expect(puoSbloccare('educator')).toBe(false)
    expect(puoSbloccare('segreteria')).toBe(false)
    expect(puoSbloccare(null)).toBe(false)

    montaDaDirigente()
    expect(screen.getByRole('button', { name: /sblocca/i })).toBeInTheDocument()
  })
})

describe('SbloccaOraButton — che cosa manda', () => {
  it('manda le coordinate dello SLOT, non un `entitaId` che non esiste', async () => {
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(apriEScrivi('La maestra era assente: recupero autorizzato'))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/primaria/sblocca')
    expect(url).toContain(`userId=${DIRIGENTE}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-user-id']).toBe(DIRIGENTE)
    expect(JSON.parse(String(init.body))).toEqual({
      entitaTipo: 'registro',
      sectionId: SEZIONE,
      data: LUNEDI,
      oraLezione: 3,
      motivazione: 'La maestra era assente: recupero autorizzato',
    })
  })

  it('senza motivazione NON parte niente: l’audit non si firma a vuoto', async () => {
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(screen.getByRole('button', { name: /sblocca/i }))
    fireEvent.click(screen.getByRole('button', { name: /autorizza/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/motiv/i)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSbloccato).not.toHaveBeenCalled()
  })

  it('una motivazione di soli spazi vale come nessuna motivazione', async () => {
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(apriEScrivi('    '))
    fireEvent.click(screen.getByRole('button', { name: /autorizza/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/motiv/i)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSbloccato).not.toHaveBeenCalled()
  })
})

describe('SbloccaOraButton — quando il server dice di no', () => {
  it('un rifiuto si legge a schermo, si logga, e NON chiama `onSbloccato`', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'Accesso negato: classe fuori dal tuo plesso' }) }),
    )
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(apriEScrivi('recupero'))

    expect(await screen.findByRole('alert')).toHaveTextContent(/fuori dal tuo plesso/i)
    expect(onSbloccato).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
    )
  })

  it('la rete che cade non è un silenzio: avviso a schermo e riga di log', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(apriEScrivi('recupero'))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onSbloccato).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' }))
  })

  it('la MOTIVAZIONE non finisce nei log del client', async () => {
    const segreto = 'ZZ-motivazione-che-non-deve-comparire-ZZ'
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Sblocco non registrato' }) }),
    )
    montaDaDirigente()
    fireEvent.click(apriEScrivi(segreto))

    await screen.findByRole('alert')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(segreto)
  })

  it('un secondo tentativo riuscito cancella l’avviso del primo', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Sblocco non registrato' }) }),
    )
    const { onSbloccato } = montaDaDirigente()
    fireEvent.click(apriEScrivi('recupero'))
    await screen.findByRole('alert')

    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }),
    )
    fireEvent.click(screen.getByRole('button', { name: /autorizza/i }))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
