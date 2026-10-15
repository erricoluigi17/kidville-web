import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import itDiario from '../../messages/it/diario.json'

const h = vi.hoisted(() => ({ urls: [] as string[], log: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams(''), useParams: () => ({}), usePathname: () => '/parent/diary' }))
vi.mock('@/lib/auth/use-parent-identity', () => ({ useParentIdentity: () => ({ parentId: 'p1', studentId: 'a1', ready: true }) }))
vi.mock('@/lib/auth/use-child-school-type', () => ({ useChildSchoolType: () => ({ schoolType: 'nido', ready: true }) }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.log, nomeErrore: () => 'Errore' }))
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => false }))
vi.mock('@/lib/offline/read-cache', () => ({ fetchConCache: vi.fn(async (chiave: string, url: string) => {
  h.urls.push(url)
  const giorno = new URL(url, 'http://test').searchParams.get('from')
  expect(chiave).toBe(`diario:a1:${giorno}:${giorno}`)
  return { offline: false, data: [{ id: `umore-${giorno}`, tipo_evento: 'umore', timestamp_evento: `${giorno}T10:00:00Z`, dettagli: { umore: 'felice' }, note: `Nota del ${giorno}`, notaBambino: null }] }
}) }))

import ParentDiaryPage from '@/app/(dashboard)/parent/diary/page'
import { segnalaNotificaAperta } from '@/lib/notifiche/pagina-aperta-da-notifica'

beforeEach(() => {
  vi.clearAllMocks()
  h.urls = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T22:30:00Z'))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => String(url).includes('/students') ? { nome: 'Nome', cognome: 'Fittizio' } : String(url).includes('/checkin') ? { stato: null, orario_entrata: null } : { media: [], total: 0 } })))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const ultimoGiorno = () => new URL(h.urls.at(-1)!, 'http://test').searchParams.get('from')
const nota = (giorno: string) => screen.findByText(new RegExp(`Nota del ${giorno}`))
const precedente = () => fireEvent.click(screen.getByRole('button', { name: itDiario.giornoPrecedente }))
const successivo = () => fireEvent.click(screen.getByRole('button', { name: itDiario.giornoSuccessivo }))
function ritorna() {
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

describe('diario genitore — calendario di Roma anche su dispositivo UTC o lontano', () => {
  it('a Roma 16 ottobre 00:30 richiede from/to 16, mostra umore e nota e chiama il giorno Oggi', async () => {
    render(<ParentDiaryPage />)
    await nota('2026-10-16')
    expect(h.urls[0]).toBe('/api/diary/entries?alunno_id=a1&from=2026-10-16&to=2026-10-16')
    expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument()
    expect(screen.getByText(/Umore della giornata: Felice/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itDiario.giornoSuccessivo })).toBeDisabled()
  })

  it('prima di mezzogiorno naviga al 15 e può tornare al 16 senza passare nel futuro', async () => {
    vi.setSystemTime(new Date('2026-10-16T08:30:00Z'))
    render(<ParentDiaryPage />)
    await nota('2026-10-16')
    precedente()
    await nota('2026-10-15')
    expect(screen.getByText(itDiario.giornoIeri)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itDiario.giornoSuccessivo })).toBeEnabled()
    successivo()
    await nota('2026-10-16')
    expect(ultimoGiorno()).toBe('2026-10-16')
    expect(screen.getByRole('button', { name: itDiario.giornoSuccessivo })).toBeDisabled()
    expect(h.log).not.toHaveBeenCalled()
  })

  it.each([
    ['2026-03-29T22:30:00Z', '2026-03-30', '2026-03-29'],
    ['2026-10-25T22:30:00Z', '2026-10-25', '2026-10-24'],
  ])('Ieri e ±1 sono giorni civili al cambio d’ora %s', async (ora, oggi, ieri) => {
    vi.setSystemTime(new Date(ora))
    render(<ParentDiaryPage />)
    await nota(oggi)
    precedente()
    await nota(ieri)
    expect(screen.getByText(itDiario.giornoIeri)).toBeInTheDocument()
    successivo()
    await nota(oggi)
    expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument()
  })

  it('al ritorno dopo mezzanotte romana segue il nuovo Oggi quando mostrava Oggi', async () => {
    vi.setSystemTime(new Date('2026-10-15T21:30:00Z'))
    render(<ParentDiaryPage />)
    await nota('2026-10-15')
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z'))
    ritorna()
    await nota('2026-10-16')
    expect(ultimoGiorno()).toBe('2026-10-16')
    expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument()
  })

  it('il ritorno preserva una giornata storica scelta a mano', async () => {
    vi.setSystemTime(new Date('2026-10-15T21:30:00Z'))
    render(<ParentDiaryPage />)
    await nota('2026-10-15')
    precedente()
    await nota('2026-10-14')
    vi.setSystemTime(new Date('2026-10-15T22:30:00Z'))
    ritorna()
    await waitFor(() => expect(h.urls).toHaveLength(3))
    expect(ultimoGiorno()).toBe('2026-10-14')
    expect(screen.getByText('14 ottobre 2026')).toBeInTheDocument()
  })

  it('il tocco sulla notifica torna al giorno romano corrente e, se già Oggi, lo rilegge', async () => {
    render(<ParentDiaryPage />)
    await nota('2026-10-16')
    precedente()
    await nota('2026-10-15')
    act(() => segnalaNotificaAperta('/parent/diary'))
    await nota('2026-10-16')
    const n = h.urls.length
    act(() => segnalaNotificaAperta('/parent/diary'))
    await waitFor(() => expect(h.urls).toHaveLength(n + 1))
    expect(ultimoGiorno()).toBe('2026-10-16')
    expect(screen.getByText(itDiario.giornoOggi)).toBeInTheDocument()
  })
})
