import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import type { RigaCalendario } from '@/lib/anno-scolastico'

/**
 * PR 4.5.14 — la pagina delle domande dice di che anno è ogni domanda, e la sposta.
 *
 * La route `POST /api/admin/iscrizioni/sposta-anno` esisteva già (4.5.8) ma nessuna schermata la
 * chiamava, e l'elenco non diceva per quale anno fosse una domanda: da gennaio la segreteria avrebbe
 * visto mischiate le domande dell'anno in corso e quelle dell'anno prossimo.
 *
 * Solo dati finti: uuid `2222…`, nomi inventati.
 */

const { logClientMock, stato } = vi.hoisted(() => ({
  logClientMock: vi.fn(),
  stato: { perSede: {} as Record<string, unknown[]> },
}))

vi.mock('@/lib/logging/client', () => ({ logClient: logClientMock, nomeErrore: () => 'e' }))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'sc-giugliano', nome: 'Kidville Giugliano' }],
    selezionate: [],
    effettive: ['sc-giugliano'],
    sedeCorrente: null,
    reFetchKey: 'sc-giugliano',
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

// Solo `useCalendario` è finto: le funzioni pure del calendario (`annoAttivoDelCalendario`, `etichettaAnno`) sono quelle vere.
vi.mock('@/lib/context/calendario-context', async (importOriginal) => {
  const originale = await importOriginal<typeof import('@/lib/context/calendario-context')>()
  return {
    ...originale,
    useCalendario: () => ({ perSede: stato.perSede, loading: false, errore: false, ricarica: () => {} }),
  }
})

const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'
const A28 = '22222222-2222-4222-8222-222222222028'

function riga(annoId: string, annoInizio: number, statoAnno: RigaCalendario['stato'], domandeAperte: boolean): RigaCalendario {
  return {
    annoId,
    annoSedeId: `22222222-2222-4222-8222-${String(annoInizio).padStart(12, '1')}`,
    annoInizio,
    inizio: `${annoInizio}-09-01`,
    fine: `${annoInizio + 1}-08-31`,
    ultimoGiornoAperto: `${annoInizio + 1}-08-31`,
    preparaSuccessivoDal: `${annoInizio + 1}-03-01`,
    stato: statoAnno,
    domandeAperte,
  }
}

/** Il 2026/27 è l'anno attivo; gli altri passati qui sono anni con le domande aperte. */
function calendarioConAperti(...altri: Array<[string, number]>) {
  stato.perSede = {
    'sc-giugliano': [
      riga(A26, 2026, 'corrente', false),
      ...altri.map(([id, anno]) => riga(id, anno, 'iscrizioni_aperte', true)),
    ],
  }
}

const SEZIONI_26 = [{ id: 'sez-26', name: 'GIUGLIANO 3 ANNI', scuola_id: 'sc-giugliano' }]
const SEZIONI_27 = [{ id: 'sez-27', name: 'GIUGLIANO 3 ANNI B', scuola_id: 'sc-giugliano' }]

type Dom = {
  id: string
  scuola_id: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  anno_id?: string | null
  nome: string
}
const DOMANDE: Dom[] = [
  { id: 'sub-corrente', scuola_id: 'sc-giugliano', status: 'pending', created_at: '2026-07-20T10:00:00Z', anno_id: A26, nome: 'Bruno Neri' },
  { id: 'sub-prossimo', scuola_id: 'sc-giugliano', status: 'pending', created_at: '2026-07-21T10:00:00Z', anno_id: A27, nome: 'Ada Verdi' },
  { id: 'sub-approvata', scuola_id: 'sc-giugliano', status: 'approved', created_at: '2026-07-22T10:00:00Z', anno_id: A26, nome: 'Carla Gialli' },
]

let domande: Dom[] = DOMANDE

function elenco() {
  return domande.map((d) => ({
    id: d.id,
    scuola_id: d.scuola_id,
    status: d.status,
    assigned_classes: null,
    created_at: d.created_at,
    ...(d.anno_id === undefined ? {} : { anno_id: d.anno_id }),
    riassunto: { bambini: 1, adulti: 1, primo_bambino: d.nome },
  }))
}
function dettaglio(id: string) {
  const d = domande.find((x) => x.id === id)!
  const [nome, cognome] = d.nome.split(' ')
  return {
    ...elenco().find((x) => x.id === id),
    data: {
      children: [{ nome, cognome, codice_fiscale: 'CF-FINTO', data_nascita: '2022-01-01' }],
      adults: [{ first_name: 'Anna', last_name: cognome, ruolo: 'mother', email: 'a@example.test' }],
    },
  }
}

type Risposta = { ok: boolean; status: number; corpo: unknown }
let rispostaSposta: Risposta | 'rete' = { ok: true, status: 200, corpo: { success: true, data: {} } }
const fetchMock = vi.fn()

function rispondi(url: string, init?: RequestInit): Promise<unknown> {
  const u = String(url)
  if (u.includes('/api/admin/iscrizioni/sposta-anno')) {
    if (rispostaSposta === 'rete') return Promise.reject(new TypeError('rete'))
    const r = rispostaSposta
    return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.corpo })
  }
  const json = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo })
  if (u.includes('/api/admin/sections')) return json(u.includes(`anno_id=${A26}`) || !u.includes('anno_id=') ? SEZIONI_26 : SEZIONI_27)
  const m = u.match(/\?id=([^&]+)/)
  if (m) return json({ data: dettaglio(decodeURIComponent(m[1])) })
  void init
  return json({ data: elenco(), total: domande.length })
}

const confermaMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  domande = DOMANDE
  rispostaSposta = { ok: true, status: 200, corpo: { success: true, data: {} } }
  calendarioConAperti([A27, 2027])
  fetchMock.mockImplementation((url: string, init?: RequestInit) => rispondi(url, init))
  vi.stubGlobal('fetch', fetchMock)
  confermaMock.mockReturnValue(true)
  vi.stubGlobal('confirm', confermaMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { ModuliRicevuti } from '@/components/features/admin/iscrizioni/ModuliRicevuti'

const chiamateSposta = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('sposta-anno'))
const apri = async (nome: string) => {
  await waitFor(() => expect(screen.getByText(nome)).toBeInTheDocument())
  fireEvent.click(screen.getByText(nome))
}

describe('ModuliRicevuti — anno della domanda', () => {
  it('i testi nuovi esistono in italiano e in inglese', () => {
    for (const k of [
      'ricevutiAnnoPer', 'ricevutiAnnoDomanda', 'ricevutiSpostaAnno', 'ricevutiSpostaAnnoGenerico',
      'ricevutiSpostaAnnoScegli', 'ricevutiSpostaAnnoLavora', 'ricevutiSpostaAnnoConferma',
      'ricevutiSpostaAnnoFatto', 'ricevutiSpostaAnnoGiaEsaminata', 'ricevutiSpostaAnnoNonOfferto',
      'ricevutiSpostaAnnoErrore',
    ]) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
  })

  it('una domanda dell\'anno prossimo porta l\'etichetta sulla riga, una dell\'anno attivo no', async () => {
    render(<ModuliRicevuti />)
    await waitFor(() => expect(screen.getByText('Bruno Neri')).toBeInTheDocument())
    const rigaProssima = screen.getByText('Ada Verdi').closest('button')!
    const rigaAttiva = screen.getByText('Bruno Neri').closest('button')!
    expect(within(rigaProssima).getByText('per il 2027/28')).toBeInTheDocument()
    expect(within(rigaAttiva).queryByText(/^per il /)).toBeNull()
    expect(screen.getAllByText(/^per il /)).toHaveLength(1)
  })

  it('il dettaglio dice l\'anno della domanda', async () => {
    render(<ModuliRicevuti />)
    await apri('Ada Verdi')
    expect(await screen.findByText('Anno della domanda: 2027/28')).toBeInTheDocument()
  })

  it('il pulsante c\'è per una domanda in attesa con un altro anno aperto', async () => {
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    expect(await screen.findByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sposta al 2027/28' })).toBeEnabled()
  })

  it('il pulsante non c\'è per una domanda approvata, ma la riga dell\'anno sì', async () => {
    render(<ModuliRicevuti />)
    await apri('Carla Gialli')
    expect(await screen.findByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Sposta/ })).toBeNull()
  })

  it('il pulsante non c\'è se nessun altro anno ha le domande aperte', async () => {
    calendarioConAperti() // solo il 2026/27, con le domande chiuse
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    expect(await screen.findByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Sposta/ })).toBeNull()
  })

  it('la conferma manda il corpo esatto, poi mostra il nuovo anno, azzera le classi e rilegge quelle del nuovo anno', async () => {
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    const select = await screen.findByLabelText(/Classe \/ Sezione/i)
    fireEvent.change(select, { target: { value: 'GIUGLIANO 3 ANNI' } })
    expect((select as HTMLSelectElement).value).toBe('GIUGLIANO 3 ANNI')

    rispostaSposta = { ok: true, status: 200, corpo: { success: true, data: { domanda_id: 'sub-corrente', anno_id: A27 } } }
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))

    expect(confermaMock).toHaveBeenCalledWith('Spostare questa domanda al 2027/28? Le classi scelte finora vanno riscelte.')
    await waitFor(() => expect(screen.getByText('Anno della domanda: 2027/28')).toBeInTheDocument())

    const chiamate = chiamateSposta()
    expect(chiamate).toHaveLength(1)
    const [url, init] = chiamate[0] as [string, RequestInit]
    expect(url).toBe('/api/admin/iscrizioni/sposta-anno')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ domanda_id: 'sub-corrente', anno_id: A27 })
    expect((init.headers as Record<string, string>)['x-sedi']).toBe('sc-giugliano')

    // le classi scelte sono state azzerate, e quelle proposte sono ora del nuovo anno
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes(`/api/admin/sections?anno_id=${A27}`))).toBe(true),
    )
    const dopo = await screen.findByLabelText(/Classe \/ Sezione/i)
    await waitFor(() => {
      const opzioni = within(dopo).getAllByRole('option').map((o) => o.textContent)
      expect(opzioni).toContain('GIUGLIANO 3 ANNI B')
    })
    expect((dopo as HTMLSelectElement).value).toBe('')
    expect(screen.getByText(/Domanda spostata al 2027\/28/)).toBeInTheDocument()
    // la riga dell'elenco porta ora l'etichetta, e il pulsante verso lo stesso anno non c'è più
    // (il nome compare anche nel dettaglio: la riga è il pulsante dell'elenco che porta la sede)
    const rigaSpostata = screen.getAllByRole('button').find((b) => b.textContent?.includes('Bruno Neri') && b.textContent.includes('Kidville Giugliano'))!
    expect(within(rigaSpostata).getByText('per il 2027/28')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sposta al 2027/28' })).toBeNull()
  })

  it('annullare il dialogo non chiama niente', async () => {
    confermaMock.mockReturnValue(false)
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))
    expect(confermaMock).toHaveBeenCalledTimes(1)
    expect(chiamateSposta()).toHaveLength(0)
    expect(screen.getByText('Anno della domanda: 2026/27')).toBeInTheDocument()
  })

  it('durante la chiamata il pulsante è disabilitato e dice che sta lavorando', async () => {
    let chiudi: (v: unknown) => void = () => {}
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      String(url).includes('sposta-anno')
        ? new Promise((r) => { chiudi = r })
        : rispondi(url, init),
    )
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))
    const occupato = await screen.findByRole('button', { name: 'Sto spostando…' })
    expect(occupato).toBeDisabled()
    chiudi({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })
    await waitFor(() => expect(screen.getByText('Anno della domanda: 2027/28')).toBeInTheDocument())
  })

  it('un 409 lascia l\'anno com\'è, mostra il messaggio della route e rilegge l\'elenco', async () => {
    rispostaSposta = {
      ok: false,
      status: 409,
      corpo: { error: 'La domanda è già stata esaminata: aggiorna l\'elenco per vedere il suo stato.', codice: 'DOMANDA_GIA_ESAMINATA' },
    }
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    const elenchiPrima = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/admin/iscrizioni?limit=')).length
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))

    expect(await screen.findByText(/già stata esaminata/)).toBeInTheDocument()
    expect(screen.getByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/admin/iscrizioni?limit=')).length).toBeGreaterThan(elenchiPrima),
    )
  })

  it('un 422 ANNO_NON_OFFERTO dà un messaggio chiaro e il pulsante resta', async () => {
    rispostaSposta = { ok: false, status: 422, corpo: { error: 'Lo spostamento di anno non è disponibile.', codice: 'ANNO_NON_OFFERTO' } }
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))
    expect(await screen.findByText(itAdminAltro.ricevutiSpostaAnnoNonOfferto)).toBeInTheDocument()
    expect(screen.getByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sposta al 2027/28' })).toBeEnabled()
  })

  it('un 500 lascia l\'anno com\'è e scrive il log senza dati personali', async () => {
    rispostaSposta = { ok: false, status: 500, corpo: { error: 'Errore interno', codice: 'ERRORE_INTERNO' } }
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))

    expect(await screen.findByText(itAdminAltro.ricevutiSpostaAnnoErrore)).toBeInTheDocument()
    expect(screen.getByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sposta al 2027/28' })).toBeEnabled()

    const log = logClientMock.mock.calls.map(([x]) => x).find((x) => String(x.messaggio).startsWith('iscrizione-sposta-anno'))
    expect(log).toBeDefined()
    expect(log.livello).toBe('warn')
    const testo = JSON.stringify(log)
    expect(testo).toContain('500')
    for (const dato of ['Bruno', 'Neri', 'sub-corrente', A27, 'CF-FINTO', 'example.test']) expect(testo).not.toContain(dato)
  })

  it('un errore di rete lascia l\'anno com\'è e scrive il log con il solo nome dell\'errore', async () => {
    rispostaSposta = 'rete'
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    fireEvent.click(screen.getByRole('button', { name: 'Sposta al 2027/28' }))
    expect(await screen.findByText(itAdminAltro.ricevutiSpostaAnnoErrore)).toBeInTheDocument()
    expect(screen.getByText('Anno della domanda: 2026/27')).toBeInTheDocument()
    expect(logClientMock.mock.calls.some(([x]) => x.livello === 'warn' && String(x.messaggio).startsWith('iscrizione-sposta-anno'))).toBe(true)
  })

  it('senza calendario e senza anno_id non c\'è né etichetta né pulsante (il database della CI)', async () => {
    stato.perSede = {}
    domande = DOMANDE.map((d) => ({ ...d, anno_id: undefined }))
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByLabelText(/Classe \/ Sezione/i)
    expect(screen.queryByText(/^per il /)).toBeNull()
    expect(screen.queryByText(/Anno della domanda/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Sposta/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('con più di un altro anno aperto si sceglie dall\'elenco', async () => {
    calendarioConAperti([A27, 2027], [A28, 2028])
    render(<ModuliRicevuti />)
    await apri('Bruno Neri')
    await screen.findByText('Anno della domanda: 2026/27')
    expect(screen.queryByRole('button', { name: 'Sposta al 2027/28' })).toBeNull()

    const scelta = screen.getByLabelText(itAdminAltro.ricevutiSpostaAnnoScegli) as HTMLSelectElement
    expect(within(scelta).getAllByRole('option').map((o) => o.textContent)).toEqual(['2027/28', '2028/29'])
    fireEvent.change(scelta, { target: { value: A28 } })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta' }))

    expect(confermaMock).toHaveBeenCalledWith('Spostare questa domanda al 2028/29? Le classi scelte finora vanno riscelte.')
    await waitFor(() => expect(screen.getByText('Anno della domanda: 2028/29')).toBeInTheDocument())
    expect(JSON.parse(String((chiamateSposta()[0] as [string, RequestInit])[1].body))).toEqual({
      domanda_id: 'sub-corrente',
      anno_id: A28,
    })
  })
})
