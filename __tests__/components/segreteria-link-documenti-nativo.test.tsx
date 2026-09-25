import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import itAdmin from '../../messages/it/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * I DOCUMENTI DELLA SEGRETERIA NELL'APP 1.1 (spec 2026-09-24, compito NAT3g).
 *
 * Nella WebView Capacitor un `<a target="_blank">` e un `window.open` non aprono niente:
 * il link del ripiego «apri a mano», l'allegato di un avviso, il documento del delegato,
 * l'allegato di una segnalazione erano pulsanti muti nell'app. Qui si misura:
 *  1. il cruscotto delle scadenze, nell'app, NON apre nessuna scheda e passa la URL
 *     firmata all'anteprima di sistema; se l'anteprima non consegna niente lo DICE;
 *  2. il documento del delegato (`LinkedAdultProfile`) nell'app ferma la navigazione e
 *     apre l'anteprima; sul web il link resta un link;
 *  3. ogni `target="_blank"` dei pannelli del compito porta il gestore dell'app — un
 *     link nuovo senza gestore tornerebbe muto nell'app senza nessun test rosso.
 */

const h = vi.hoisted(() => ({
  nativo: false,
  apriDocumento: vi.fn(),
  logClient: vi.fn(),
  sedi: [] as Array<{ id: string; nome: string }>,
  sediKey: '',
}))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => h.nativo }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/native/scarica', async (importOriginal) => {
  const originale = await importOriginal<typeof import('@/lib/native/scarica')>()
  return { ...originale, apriDocumento: h.apriDocumento }
})
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: h.sedi,
    selezionate: [],
    effettive: h.sedi.map((s) => s.id),
    sedeCorrente: h.sedi.length === 1 ? h.sedi[0].id : null,
    reFetchKey: h.sediKey,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

import { ScadenzeDocumenti } from '@/components/features/admin/personale/ScadenzeDocumenti'
import { LinkedAdultProfile } from '@/components/features/admin/LinkedAdultProfile'

const OGGI = '2026-08-12'
const PERSONA = 'dddddddd-0000-4000-8000-000000000001'
const RIGHE = [
  { utente_id: PERSONA, nome: 'Anna', cognome: 'Alfa', ruolo: 'educator', scuola_id: SEDE_A, document_type: 'CI', document_expiry: '2026-08-01' },
]
const URL_FIRMATA = 'https://storage.esempio.invalid/object/sign/personale/fronte.jpg?token=xyz'

const fetchMock = vi.fn()

function instrada() {
  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url)
    if (u.includes('utenteId=')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { anagrafica: { documento_fronte_path: `personale/${PERSONA}/fronte.jpg` } } }),
      })
    }
    if (u.includes('doc=')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ url: URL_FIRMATA }) })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data: RIGHE, inRegola: 0, cessati: 0, oggi: OGGI, orizzonteGiorni: 90, totalePersonale: 1, limite: 500 }),
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
  h.sediKey = SEDE_A
  fetchMock.mockReset()
  instrada()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const comandoDi = (persona: string) =>
  within(screen.getByText(persona).closest('tr') as HTMLElement).getByRole('button')

describe('ScadenzeDocumenti · nell’app 1.1 il documento si apre nell’anteprima di sistema', () => {
  it('nessuna scheda, URL firmata all’helper, nome senza pezzi del percorso, nessun avviso', async () => {
    h.nativo = true
    const open = vi.fn(() => null)
    vi.stubGlobal('open', open)
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-anteprima' })

    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    fireEvent.click(comandoDi('Alfa Anna'))

    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(open).not.toHaveBeenCalled()
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: URL_FIRMATA,
      nomeFile: 'scadenze-documento.jpg',
      etichetta: 'scadenze-documento',
    })
    // Né il ripiego «apri a mano» (che nell'app sarebbe muto) né l'errore.
    expect(screen.queryByText(itAdmin.scadDocumentoBloccato)).not.toBeInTheDocument()
    expect(screen.queryByText(itAdmin.scadErroreDocumento)).not.toBeInTheDocument()
  })

  it('un’anteprima che non consegna niente lo DICE, invece del link muto', async () => {
    h.nativo = true
    vi.stubGlobal('open', vi.fn(() => null))
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })

    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    fireEvent.click(comandoDi('Alfa Anna'))

    expect(await screen.findByText(itAdmin.scadErroreDocumento)).toBeInTheDocument()
    expect(screen.queryByText(itAdmin.scadDocumentoBloccato)).not.toBeInTheDocument()
  })

  it('sul WEB resta la scheda aperta nel gesto, e l’helper non si chiama', async () => {
    const finestra = { closed: false, opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() }
    const open = vi.fn(() => finestra)
    vi.stubGlobal('open', open)

    render(<ScadenzeDocumenti userId="u1" />)
    await waitFor(() => expect(screen.getByText('Alfa Anna')).toBeInTheDocument())
    fireEvent.click(comandoDi('Alfa Anna'))

    await waitFor(() => expect(finestra.location.replace).toHaveBeenCalledWith(URL_FIRMATA))
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })
})

describe('LinkedAdultProfile · il documento del delegato', () => {
  const DELEGATO = {
    id: 'eeeeeeee-0000-4000-8000-000000000001',
    first_name: 'Delegato',
    last_name: 'Finto',
    document_url: 'https://storage.esempio.invalid/object/sign/deleghe/carta.pdf?token=abc',
  }

  it('nell’APP il clic non naviga e apre l’anteprima con il file giusto', async () => {
    h.nativo = true
    h.apriDocumento.mockResolvedValue({ esito: 'nativo-anteprima' })
    render(<LinkedAdultProfile data={DELEGATO} type="delegate" />)
    const link = screen.getByRole('link')
    // `fireEvent.click` ritorna `false` quando il gestore ha chiamato `preventDefault`.
    expect(fireEvent.click(link)).toBe(false)
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: DELEGATO.document_url,
      nomeFile: 'delegato-documento.pdf',
      etichetta: 'delegato-documento',
    })
  })

  it('sul WEB il link resta un link: nessun `preventDefault`, nessun helper', () => {
    render(<LinkedAdultProfile data={DELEGATO} type="delegate" />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', DELEGATO.document_url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(fireEvent.click(link)).toBe(true)
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })
})

describe('copertura · ogni `target="_blank"` dei pannelli del compito ha il gestore dell’app', () => {
  const FILE = [
    'src/components/features/admin/StaffDetailPanel.tsx',
    'src/components/features/admin/iscrizioni/ModuliRicevuti.tsx',
    'src/components/features/admin/personale/PratichePersonale.tsx',
    'src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx',
    'src/components/features/admin/personale/ScadenzeDocumenti.tsx',
    'src/components/features/admin/LinkedAdultProfile.tsx',
    'src/components/features/admin/StudentDetailPanel.tsx',
    'src/app/(dashboard)/admin/avvisi/[id]/page.tsx',
  ]

  it.each(FILE)('%s', (file) => {
    const testo = readFileSync(join(process.cwd(), file), 'utf8')
    const ancore: string[] = []
    let da = 0
    for (;;) {
      const i = testo.indexOf('target="_blank"', da)
      if (i < 0) break
      const inizio = testo.lastIndexOf('<a', i)
      const fine = testo.indexOf('</a>', i)
      ancore.push(testo.slice(inizio, fine))
      da = i + 1
    }
    // Il file del compito HA almeno un link: un conteggio a zero vorrebbe dire che il
    // test non sta guardando niente, non che il file è a posto.
    expect(ancore.length, `${file}: nessun target="_blank" trovato`).toBeGreaterThan(0)
    for (const ancora of ancore) {
      expect(ancora, `${file}: un <a target="_blank"> senza gestore dell'app`).toContain('onClick={apriLinkNellApp(')
    }
  })
})
