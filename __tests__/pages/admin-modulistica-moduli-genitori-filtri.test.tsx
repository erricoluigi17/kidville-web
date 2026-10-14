import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itAdminModulistica from '../../messages/it/adminModulistica.json'

/**
 * «MODULI PER I GENITORI ISCRITTI» — la barra filtri della linguetta che vive INLINE.
 *
 * ─── PERCHÉ QUESTA LINGUETTA È IL BANCO DI PROVA DEL VUOTO ──────────────────────
 *
 * `forms_templates` in produzione non ha nemmeno una riga. È quindi l'unico posto in cui la
 * distinzione fra «non è ancora stato creato nessun modulo» e «nessuno corrisponde ai filtri»
 * non è un caso limite ma lo stato NORMALE della schermata — e sbagliarla vuol dire mandare
 * la segreteria a cercare un filtro da togliere che nessuno ha messo. I due stati si misurano
 * qui, uno accanto all'altro.
 *
 * ⚠️ Le date si costruiscono RELATIVE all'orologio, non scritte a mano: un modulo «ancora
 * valido» fissato al 2026-12-31 diventa «scaduto» da solo il primo gennaio, e il test
 * comincerebbe a fallire senza che nessuno abbia toccato il codice. È la trappola già pagata
 * in questo repo da un test scaduto col calendario.
 */

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const GIORNO = 24 * 60 * 60 * 1000

const h = vi.hoisted(() => ({ query: 'tab=moduli-genitori', scarica: vi.fn() }))
vi.mock('@/lib/native/scarica', async (original) => ({ ...await original<typeof import('@/lib/native/scarica')>(), scaricaDocumento: h.scarica }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/modulistica',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE, nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: [SEDE],
    sedeCorrente: SEDE,
    reFetchKey: SEDE,
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
  SedeNotice: () => null,
}))

// I pannelli delle altre linguette non si montano con `?tab=moduli-genitori`, ma restano
// importati: si azzerano per non farli leggere nulla se un giorno la catena cambiasse.
vi.mock('@/components/features/admin/iscrizioni/ModuliInviabili', () => ({ ModuliInviabili: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ModuliRicevuti', () => ({ ModuliRicevuti: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ElencoClassi', () => ({ ElencoClassi: () => null }))
vi.mock('@/components/features/admin/iscrizioni/RinviaCredenziali', () => ({ RinviaCredenziali: () => null }))
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({ CandidatureInsegnanti: () => null }))
vi.mock('@/components/features/admin/personale/PratichePersonale', () => ({ PratichePersonale: () => null }))
vi.mock('@/components/features/prestampati/PrestampatiSegreteria', () => ({ PrestampatiSegreteria: () => null }))

const base = {
  fields: [],
  target_scope: 'class' as const,
}

const MODULI = [
  {
    ...base,
    id: 'a',
    title: 'Uscita didattica al museo',
    description: 'Serve il consenso di chi esercita la responsabilità genitoriale',
    form_type: 'autorizzazione',
    target_classes: ['PRIMAVERA A'],
    expiration_date: new Date(Date.now() + 30 * GIORNO).toISOString(),
    created_at: '2026-01-15T10:00:00Z',
    sempre_firmabile: true,
  },
  {
    ...base,
    id: 'b',
    title: 'Come è andato l’anno',
    description: 'Un giudizio sul servizio',
    form_type: 'gradimento',
    target_classes: ['INFANZIA B'],
    expiration_date: new Date(Date.now() - 30 * GIORNO).toISOString(),
    created_at: '2026-06-20T10:00:00Z',
    sempre_firmabile: false,
  },
  {
    ...base,
    id: 'c',
    title: 'Preferenze sul menu',
    description: '',
    form_type: 'sondaggio',
    target_classes: ['PRIMAVERA A', 'INFANZIA B'],
    expiration_date: null,
    created_at: '2026-03-10T10:00:00Z',
    sempre_firmabile: false,
  },
]

const SEZIONI = [
  { id: 's1', name: 'PRIMAVERA A' },
  { id: 's2', name: 'INFANZIA B' },
  // Una sezione su cui non è mai stato creato niente: deve comunque essere una scelta.
  { id: 's3', name: 'NIDO A' },
]

let moduliDaServire: unknown[] = MODULI

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/admin/forms')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => moduliDaServire })
  }
  if (url.includes('/api/admin/sections')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => SEZIONI })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.query = 'tab=moduli-genitori'
  moduliDaServire = MODULI
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  window.history.replaceState(null, '', '/admin/modulistica?tab=moduli-genitori')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('segreteria: riepilogo server e documento completo recuperabile', () => {
  const CLASS = 'PRIMAVERA A & B'
  const ID = '55555555-5555-4555-8555-555555555555'
  function mockDownloads() {
    moduliDaServire = [{ ...MODULI[0], target_classes: [CLASS] }]
    const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' })
    const fetch = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/admin/documents-merge')) return Promise.resolve(url.includes('format=pdf')
        ? { ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => pdf }
        : { ok: true, json: async () => ({ results: [{ student_id: 'alunno', nome_alunno: 'Bimba', cognome_alunno: 'Prova', signed: true, is_signed: true, submission_id: ID, pdf_path: null }] }) })
      if (url.includes('/api/forms/signed-pdf')) return Promise.resolve(options?.method === 'POST'
        ? { ok: true, json: async () => ({ pdf_ready: true, submission: { pdf_path: 'originale.pdf' } }) }
        : { ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: async () => pdf })
      return fetchFinto(input)
    })
    vi.stubGlobal('fetch', fetch)
    return { fetch, pdf }
  }
  it('esporta i byte server con classe codificata e format=pdf', async () => {
    const { fetch, pdf } = mockDownloads()
    render(<AdminModulisticaPage />)
    fireEvent.click(await screen.findByRole('button', { name: `Merge ${CLASS}` }))
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const url = fetch.mock.calls.map(([u]) => String(u)).find((u) => u.includes('documents-merge'))!
    expect(new URL(url, 'http://localhost').searchParams.get('class_name')).toBe(CLASS)
    expect(new URL(url, 'http://localhost').searchParams.get('format')).toBe('pdf')
    expect(h.scarica.mock.calls[0][0].sorgente).toBe(pdf)
  })
  it('compilazione firmata senza pdf_path appare e si recupera senza nuovo OTP', async () => {
    const { fetch } = mockDownloads()
    render(<AdminModulisticaPage />)
    fireEvent.click(await screen.findByRole('button', { name: `Protocolla ${CLASS}` }))
    fireEvent.click(await screen.findByRole('button', { name: 'Scarica autorizzazione firmata' }))
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('/api/forms/signed-pdf'))).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Protocolla' })).toBeEnabled()
  })

  function mockProtocolPreparation(origine = 'online', initialPath = 'signed_forms/legacy-percorso-simulato.pdf') {
    moduliDaServire = [{ ...MODULI[0], target_classes: [CLASS] }]
    const state = { ready: true, protocolThrows: false }
    const realPath = origine === 'cartaceo' ? initialPath : 'signed_forms/sede/compilazione-reale.pdf'
    const fetch = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/admin/documents-merge')) return Promise.resolve({ ok: true, json: async () => ({ results: [{ student_id: 'alunno', nome_alunno: 'Bimba', cognome_alunno: 'Prova', signed: true, is_signed: true, submission_id: ID, pdf_path: initialPath, origine }] }) })
      if (url === '/api/forms/signed-pdf' && options?.method === 'POST') return Promise.resolve({
        ok: state.ready, status: state.ready ? 200 : 503,
        json: async () => state.ready ? { pdf_ready: true, submission: { pdf_path: realPath } } : { pdf_ready: false, pdf_error: 'PDF_DOWNLOAD_FAILED' },
      })
      if (url === '/api/admin/protocolli/da-documento') {
        if (state.protocolThrows) return Promise.reject(new TypeError('Rete non disponibile'))
        // La route di protocollazione accetta soltanto byte PDF, non scansioni WebP.
        if (!realPath.endsWith('.pdf')) return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'Il documento archiviato non è un PDF valido' }) })
        return Promise.resolve({ ok: true, json: async () => ({ data: { numeroFormattato: '1/2026' } }) })
      }
      return fetchFinto(input)
    })
    vi.stubGlobal('fetch', fetch)
    return { fetch, state, realPath }
  }
  async function openProtocolModal() {
    render(<AdminModulisticaPage />)
    fireEvent.click(await screen.findByRole('button', { name: `Protocolla ${CLASS}` }))
    return await screen.findByRole('button', { name: 'Protocolla' })
  }
  const documentCalls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([url]) => String(url).includes('/api/forms/signed-pdf') || url === '/api/admin/protocolli/da-documento')

  it('un path storico non vuoto non abilita il protocollo prima della preparazione reale', async () => {
    const { fetch } = mockProtocolPreparation()
    const button = await openProtocolModal()
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await within(screen.getByRole('dialog')).findByText('n. 1/2026', { exact: true })).toBeInTheDocument()
    expect(documentCalls(fetch).map(([url]) => url)).toEqual(['/api/forms/signed-pdf', '/api/forms/signed-pdf', '/api/admin/protocolli/da-documento'])
    expect(documentCalls(fetch)[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ id: ID }) })
  })
  it('guasto preparazione preserva la firma, impedisce protocollo e consente retry senza OTP', async () => {
    const { fetch, state } = mockProtocolPreparation()
    state.ready = false
    const button = await openProtocolModal()
    fireEvent.click(screen.getByRole('button', { name: 'Prepara documento' }))
    expect(await screen.findByText('Firma registrata, PDF non disponibile. Riprova a scaricare il documento.')).toBeInTheDocument()
    expect(button).toBeDisabled()
    expect(documentCalls(fetch).map(([url]) => url)).toEqual(['/api/forms/signed-pdf'])
    expect(screen.getByText('Bimba', { exact: false })).toBeInTheDocument()
    state.ready = true
    fireEvent.click(screen.getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    // Il documento può diventare indisponibile tra verifica e clic: nessun protocollo falso.
    state.ready = false
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    expect(fetch.mock.calls.some(([url]) => url === '/api/admin/protocolli/da-documento')).toBe(false)
    expect(fetch.mock.calls.some(([url]) => String(url).includes('otp'))).toBe(false)
  })
  it('scansione cartacea conserva l’originale e passa dalla verifica Storage prima del protocollo', async () => {
    const { fetch } = mockProtocolPreparation('cartaceo', 'cartacei/scansione-originale.pdf')
    const button = await openProtocolModal()
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await within(screen.getByRole('dialog')).findByText('n. 1/2026', { exact: true })).toBeInTheDocument()
    expect(documentCalls(fetch).map(([url]) => url)).toEqual(['/api/forms/signed-pdf', '/api/forms/signed-pdf', '/api/admin/protocolli/da-documento'])
    expect(documentCalls(fetch)[2][1]).toMatchObject({ body: JSON.stringify({ sorgente: 'modulo_firmato', id: ID }) })
  })
  it('400 su scansione WebP revoca pronta, preserva firma e permette una nuova verifica', async () => {
    const { fetch } = mockProtocolPreparation('cartaceo', 'cartacei/scansione-originale.webp')
    const button = await openProtocolModal()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText('❌ Il documento archiviato non è un PDF valido', { exact: true })).toBeInTheDocument()
    expect(button).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Prepara documento' })).toBeEnabled()
    expect(within(dialog).getByText('Prova Bimba', { exact: true })).toBeInTheDocument()
    expect(within(dialog).queryByText('n. 1/2026', { exact: true })).not.toBeInTheDocument()
    expect(fetch.mock.calls.filter(([url]) => url === '/api/admin/protocolli/da-documento')).toHaveLength(1)
  })
  it('guasto di rete del protocollo revoca pronta e richiede verifica nuova prima del retry', async () => {
    const { fetch, state } = mockProtocolPreparation()
    state.protocolThrows = true
    const button = await openProtocolModal()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText(itAdminModulistica.modToastErroreReteProtocollo, { exact: true })).toBeInTheDocument()
    expect(button).toBeDisabled()
    expect(within(dialog).queryByText('n. 1/2026', { exact: true })).not.toBeInTheDocument()
    state.protocolThrows = false
    fireEvent.click(within(dialog).getByRole('button', { name: 'Prepara documento' }))
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await within(dialog).findByText('n. 1/2026', { exact: true })).toBeInTheDocument()
    expect(fetch.mock.calls.filter(([url]) => url === '/api/forms/signed-pdf')).toHaveLength(4)
    expect(fetch.mock.calls.filter(([url]) => url === '/api/admin/protocolli/da-documento')).toHaveLength(2)
  })
})

import AdminModulisticaPage from '@/app/(dashboard)/admin/modulistica/page'

const titoliVisibili = () =>
  MODULI.filter((m) => screen.queryByRole('heading', { name: m.title }) !== null).map((m) => m.title)

async function monta() {
  render(<AdminModulisticaPage />)
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Uscita didattica al museo' })).toBeInTheDocument(),
  )
}

describe('Modulistica · moduli per i genitori — la barra filtri', () => {
  it('la barra c’è, e all’apertura non nasconde niente', async () => {
    await monta()
    expect(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca)).toBeInTheDocument()
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('3 risultati su 3')
    expect(titoliVisibili()).toHaveLength(3)
  })

  it('il tipo di modulo usa le stesse parole della pastiglia di ogni riga', async () => {
    await monta()
    // «Gradimento» è la STESSA etichetta che la riga mostra nella sua pastiglia verde.
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`^${itAdminModulistica.modFormTypeGradimento}`) }),
    )

    await waitFor(() => expect(titoliVisibili()).toEqual(['Come è andato l’anno']))
  })

  it('la scadenza distingue i TRE stati: senza scadenza non è «ancora valido»', async () => {
    await monta()
    const scadenza = screen.getByLabelText(itAdminModulistica.filtriModuliScadenza) as HTMLSelectElement

    fireEvent.change(scadenza, { target: { value: 'attivi' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Uscita didattica al museo']))

    fireEvent.change(scadenza, { target: { value: 'scaduti' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Come è andato l’anno']))

    fireEvent.change(scadenza, { target: { value: 'senza' } })
    await waitFor(() => expect(titoliVisibili()).toEqual(['Preferenze sul menu']))
  })

  it('fra le classi c’è anche la sezione su cui non è stato creato niente', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    const gruppo = screen.getByRole('group', { name: 'Filtri' })

    // «NIDO A» non è nominata da nessun modulo: viene dalle sezioni della sede, e serve
    // proprio a rispondere «su questa sezione ho già mandato qualcosa?».
    const nidoA = within(gruppo).getByRole('button', { name: /^NIDO A/ })
    fireEvent.click(nidoA)
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('0 risultati su 3'),
    )
    expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument()
  })

  it('«Solo i moduli essenziali» tiene quello firmabile anche da un genitore sospeso', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: /Filtri/ }))
    fireEvent.click(
      screen.getByRole('switch', { name: itAdminModulistica.filtriModuliSoloEssenziali }),
    )

    await waitFor(() => expect(titoliVisibili()).toEqual(['Uscita didattica al museo']))
  })

  it('a ZERO moduli si dice «non ne è stato creato nessuno», non «nessun risultato»', async () => {
    moduliDaServire = []
    render(<AdminModulisticaPage />)

    await waitFor(() =>
      expect(screen.getByText(itAdminModulistica.modNessunModuloGenitori)).toBeInTheDocument(),
    )
    expect(screen.queryByText('Nessun risultato con questi filtri')).toBeNull()
    // E la barra non si disegna sopra il nulla.
    expect(screen.queryByLabelText(itAdminModulistica.filtriModuliRicerca)).toBeNull()
  })

  it('con dei moduli e un filtro che non trova nulla si dice «nessun risultato», e si pulisce', async () => {
    await monta()
    fireEvent.change(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca), {
      target: { value: 'qwertyuiop-nessuna-corrispondenza' },
    })

    await waitFor(() =>
      expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument(),
    )
    expect(screen.queryByText(itAdminModulistica.modNessunModuloGenitori)).toBeNull()

    fireEvent.click(
      within(screen.getByTestId('stato-moduli-genitori')).getByText('Pulisci filtri'),
    )
    await waitFor(() => expect(titoliVisibili()).toHaveLength(3))
  })

  it('i filtri finiscono nell’indirizzo senza portare via `?tab=`', async () => {
    await monta()
    fireEvent.change(screen.getByLabelText(itAdminModulistica.filtriModuliRicerca), {
      target: { value: 'museo' },
    })

    await waitFor(() => expect(window.location.search).toContain('q=museo'))
    // `?tab=` non è governato da questa barra: riscrivere l'indirizzo per intero
    // scollegherebbe la pagina dalla linguetta su cui si sta lavorando.
    expect(window.location.search).toContain('tab=moduli-genitori')
  })
})
