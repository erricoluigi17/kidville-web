import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itConferme from '../../messages/it/annoConferme.json'
import itShared from '../../messages/it/shared.json'

// =============================================================================
// PR 4.5 · compito 4.5.10 · LA PAGINA DELLE CONFERME HA UN TEST DI RENDER.
//
// Prima non ne aveva nessuno. Qui si prova ciò che la segreteria vede e tocca: le due viste, il pannello dei moduli, la spunta con la
// risposta del server che aggiorna la riga (stato e moduli fatti), il rifiuto `MODULO_NON_RICHIESTO` in italiano, il filtro passato
// alla route, e che l'ESITO resti leggibile quando la riga esce dal filtro.
//
// La `fetch` finta risponde in modo DIVERSO prima e dopo la spunta (lo stato del server cambia davvero): un finto che risponde sempre
// uguale sarebbe verde anche senza il codice. Si aspetta sempre una PRESENZA prima di asserire un'assenza. Nomi e uuid inventati.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  anno: { effettivo: { annoSedeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attivo: false, stato: 'iscrizioni_aperte' } } as unknown,
}))
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))
vi.mock('@/lib/context/admin-identity', () => ({ useAdminIdentity: () => ({ userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) }))

import { ConfermeClient } from '@/app/(dashboard)/admin/students/conferme/ConfermeClient'

const ANNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const F_PART = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const F_NUOVA = '91919191-9191-4919-8919-919191919191'
const F_NUOVA_ARRIVO = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const AL1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const AL2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const M1 = '71717171-7171-4717-8717-717171717171'
const M2 = '72727272-7272-4727-8727-727272727272'

type Risposta = { status: number; body: unknown }
const ok = (data: Record<string, unknown>): Risposta => ({ status: 200, body: { success: true, data } })

/** Lo stato del «server»: cambia quando la pagina scrive, e le letture successive lo riflettono. */
const s = {
  spunteConferma: [] as string[], // moduli spuntati sulla frequenza N1 (conferma) — il secondo cambia lo stato
  confermato: true,
  rifiutaModulo: false,
  elencoVuotoDopoSpunta: false,
  spuntato: false,
  confermata: false,
  quota: 'da_pagare' as 'da_pagare' | 'assente', // la quota che il server legge per la riga
  quotaPost: 'creata' as string, // l'esito della voce che il POST di conferma risponde
}
const fetchMock = vi.fn()

const rigaConferma = () => ({
  frequenza_id: F_PART, alunno_id: AL1, section_id: null, conferma: s.confermata || s.confermato ? 'confermato' : 'non_risposto',
  nuova_frequenza_id: s.confermata || s.confermato ? F_NUOVA : null, nuova_section_id: null, non_rinnova_motivo: null,
  moduli: { fatti: s.spunteConferma.length, richiesti: 2 }, quota: s.quota, cambia_grado: false,
  stato_frequenza: s.confermata || s.confermato ? 'in_attesa' : null, nome: 'NomeProva', cognome: 'CognomeProva', classe: 'Sezione Prova',
})
const rigaNuova = () => ({
  frequenza_id: F_NUOVA_ARRIVO, alunno_id: AL2, section_id: null, conferma: 'confermato', nuova_frequenza_id: F_NUOVA_ARRIVO, nuova_section_id: null,
  non_rinnova_motivo: null, moduli: { fatti: 0, richiesti: 2 }, quota: 'assente', cambia_grado: false,
  stato_frequenza: 'in_attesa', nome: 'NomeArrivo', cognome: 'CognomeArrivo', classe: null,
})

function risposta(url: string, metodo: string, body: Record<string, unknown>): Risposta {
  if (url.includes('/api/admin/sections/scoped')) return { status: 200, body: { data: [] } }
  if (url.includes('/conferme/non-rinnova')) return ok({ frequenza_id: F_PART, non_rinnova: true, cambiato: true })
  if (url.includes(`/api/admin/anni/${ANNO}/conferme`) && metodo === 'POST') {
    s.confermata = true
    s.quota = s.quotaPost === 'creata' ? 'da_pagare' : 'assente'
    return ok({ frequenza_id: F_NUOVA, creata: true, cambia_grado: false, retta_personalizzata_precedente: false, quota: s.quotaPost, pagamento_id: null, posti_oltre: false })
  }
  if (url.includes(`/api/admin/anni/${ANNO}/conferme`)) {
    const q = new URL(url, 'http://localhost').searchParams
    const vista = q.get('vista')
    const filtro = q.get('conferma')
    if (vista === 'nuove') return ok({ righe: [rigaNuova()], pagina: 1, limite: 100, totale: 1, posti: [] })
    // il filtro «non hanno risposto» dopo la conferma non ha più nessuno; «mancano moduli» dopo l'ultima spunta nemmeno
    if (filtro === 'non_risposto') return s.confermata ? ok({ righe: [], pagina: 1, limite: 100, totale: 0, posti: [] }) : ok({ righe: [{ ...rigaConferma(), conferma: 'non_risposto', nuova_frequenza_id: null }], pagina: 1, limite: 100, totale: 1, posti: [] })
    if (filtro === 'mancano_moduli') return s.elencoVuotoDopoSpunta ? ok({ righe: [], pagina: 1, limite: 100, totale: 0, posti: [] }) : ok({ righe: [rigaConferma()], pagina: 1, limite: 100, totale: 1, posti: [] })
    return ok({ righe: [rigaConferma()], pagina: 1, limite: 100, totale: 1, posti: [] })
  }
  if (url.includes('/moduli') && metodo === 'GET') {
    return ok({
      moduli: [
        { modulo_id: M1, codice: 'privacy_cartacea', titolo: 'Informativa privacy', ordine: 1, spuntato: s.spunteConferma.includes(M1), spuntato_il: null, firmato_in_app_il: null },
        { modulo_id: M2, codice: 'delega_ritiro', titolo: 'Delega al ritiro', ordine: 2, spuntato: s.spunteConferma.includes(M2), spuntato_il: null, firmato_in_app_il: '2027-10-05' },
      ],
    })
  }
  if (url.includes('/moduli') && metodo === 'PUT') {
    if (s.rifiutaModulo) return { status: 422, body: { error: itShared.erroreModuloNonRichiesto, codice: 'MODULO_NON_RICHIESTO' } }
    const moduloId = String(body.modulo_id)
    s.spunteConferma = body.spuntato ? [...s.spunteConferma, moduloId] : s.spunteConferma.filter((x) => x !== moduloId)
    s.elencoVuotoDopoSpunta = s.spunteConferma.length === 2
    const completi = s.spunteConferma.length === 2
    return ok({ frequenza_id: F_NUOVA, modulo_id: moduloId, spuntato: body.spuntato, moduli_completi: completi, quota_saldata: completi, stato: completi ? 'iscritto' : 'in_attesa' })
  }
  return { status: 404, body: { error: 'non previsto' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  s.spunteConferma = [M1]
  s.confermato = true
  s.confermata = false
  s.quota = 'da_pagare'
  s.quotaPost = 'creata'
  s.rifiutaModulo = false
  s.elencoVuotoDopoSpunta = false
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const r = risposta(String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : {})
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const chiamate = (metodo: string, parte: string) =>
  fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === metodo && String(url).includes(parte))
const rigaDi = (nome: string) => screen.getByText(nome).closest('tr') as HTMLElement

async function montaConPannelloAperto() {
  render(<ConfermeClient />)
  const nome = await screen.findByText('CognomeProva NomeProva')
  fireEvent.click(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.moduliApri }))
  await screen.findByRole('checkbox', { name: /Delega al ritiro/ })
}

describe('ConfermeClient — le viste e i nomi', () => {
  it('i nomi arrivano dalla route: la pagina non scarica più l’elenco delle schede', async () => {
    render(<ConfermeClient />)
    expect(await screen.findByText('CognomeProva NomeProva')).toBeInTheDocument()
    expect(screen.getByText('Classe di oggi: Sezione Prova')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/admin/students'))).toBe(false)
  })

  it('«Nuove iscrizioni» chiede la vista `nuove` alla route e mostra chi arriva da fuori, con la colonna Stato', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    expect(await screen.findByText('CognomeArrivo NomeArrivo')).toBeInTheDocument()
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('vista=nuove'))).toBe(true)
    expect(screen.getByRole('columnheader', { name: itConferme.colStato })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: itConferme.colRisposta })).toBeNull()
    // chi arriva da fuori ha il pannello dei moduli ma non i comandi di conferma
    const riga = rigaDi('CognomeArrivo NomeArrivo')
    expect(within(riga).getByRole('button', { name: itConferme.moduliApri })).toBeInTheDocument()
    expect(within(riga).queryByRole('button', { name: itConferme.azioneConferma })).toBeNull()
    // il filtro delle nuove ha solo «Tutti» e «Mancano moduli»
    expect(screen.queryByRole('button', { name: itConferme.filtroNo })).toBeNull()
    expect(screen.getByRole('button', { name: itConferme.filtroManca })).toBeInTheDocument()
  })
})

describe('ConfermeClient — il filtro «mancano moduli» sta nella route', () => {
  it('passa `conferma=mancano_moduli` e riparte dalla pagina 1', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.filtroManca }))
    await waitFor(() => expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('conferma=mancano_moduli'))).toBe(true))
    const url = String(chiamate('GET', '/conferme?').find(([u]) => String(u).includes('mancano_moduli'))![0])
    expect(url).toContain('pagina=1')
    expect(url).toContain('vista=conferme')
  })
})

describe('ConfermeClient — il pannello dei moduli e la spunta', () => {
  it('apre il pannello, legge i moduli della frequenza NUOVA e dice la firma in app come informazione', async () => {
    await montaConPannelloAperto()
    expect(chiamate('GET', `/api/admin/frequenze/${F_NUOVA}/moduli`)).toHaveLength(1)
    const privacy = screen.getByRole('checkbox', { name: /Informativa privacy/ }) as HTMLInputElement
    const delega = screen.getByRole('checkbox', { name: /Delega al ritiro/ }) as HTMLInputElement
    expect(privacy.checked).toBe(true)
    expect(delega.checked).toBe(false)
    // «firmato in app» è informativo: compare, ma la casella resta vuota
    expect(screen.getByText(/Firmato in app il 5 ottobre 2027/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(itConferme.firmatoInAppNota))).toBeInTheDocument()
  })

  it('spuntare manda la PUT, e la risposta del server aggiorna la riga: moduli fatti, stato, quota. Nessuna rilettura dell’elenco', async () => {
    await montaConPannelloAperto()
    const riga = rigaDi('CognomeProva NomeProva')
    expect(within(riga).getByText('1/2')).toBeInTheDocument()
    expect(within(riga).getByText(itConferme.statoInAttesa)).toBeInTheDocument()
    expect(within(riga).getByText(itConferme.quotaDaPagare)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /Delega al ritiro/ }))
    await waitFor(() => expect(within(rigaDi('CognomeProva NomeProva')).getByText('2/2')).toBeInTheDocument())

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(String(put[0])).toBe(`/api/admin/frequenze/${F_NUOVA}/moduli`)
    expect(JSON.parse(put[1].body)).toEqual({ modulo_id: M2, spuntato: true })
    expect(put[1].headers['x-user-id']).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    // la riga riporta lo stato che il DATABASE ha calcolato: la pagina non lo scrive
    const dopo = rigaDi('CognomeProva NomeProva')
    expect(within(dopo).getByText(itConferme.statoIscritto)).toBeInTheDocument()
    expect(within(dopo).getByText(itConferme.quotaSaldata)).toBeInTheDocument()
    expect((screen.getByRole('checkbox', { name: /Delega al ritiro/ }) as HTMLInputElement).checked).toBe(true)
    // nessuna rilettura: l'elenco è stato chiesto una volta sola
    expect(chiamate('GET', '/conferme?')).toHaveLength(1)
    // l'esito è leggibile
    expect(screen.getByRole('status', { name: itConferme.esitoRegione })).toHaveTextContent('CognomeProva NomeProva: «Delega al ritiro» spuntato. Stato dell’iscrizione: Iscritto.')
  })

  it('togliere una spunta riporta «In attesa» come dice il server', async () => {
    s.spunteConferma = [M1, M2]
    await montaConPannelloAperto()
    fireEvent.click(screen.getByRole('checkbox', { name: /Delega al ritiro/ }))
    await waitFor(() => expect(within(rigaDi('CognomeProva NomeProva')).getByText('1/2')).toBeInTheDocument())
    expect(within(rigaDi('CognomeProva NomeProva')).getByText(itConferme.statoInAttesa)).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')![1].body)).toEqual({ modulo_id: M2, spuntato: false })
  })

  it('MODULO_NON_RICHIESTO: il rifiuto è in italiano, la casella resta com’era e la riga non cambia', async () => {
    s.rifiutaModulo = true
    await montaConPannelloAperto()
    fireEvent.click(screen.getByRole('checkbox', { name: /Delega al ritiro/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`CognomeProva NomeProva: ${itShared.erroreModuloNonRichiesto}`)
    expect((screen.getByRole('checkbox', { name: /Delega al ritiro/ }) as HTMLInputElement).checked).toBe(false)
    expect(within(rigaDi('CognomeProva NomeProva')).getByText('1/2')).toBeInTheDocument()
  })

  it('una rete caduta durante la spunta si dice, e non cambia niente', async () => {
    await montaConPannelloAperto()
    fetchMock.mockImplementation((_u: string, init?: { method?: string }) =>
      init?.method === 'PUT' ? Promise.reject(new TypeError('rete')) : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { moduli: [] } }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Delega al ritiro/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itConferme.erroreRete)
    expect((screen.getByRole('checkbox', { name: /Delega al ritiro/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('su un telefono: il pannello non è più largo della finestra e le caselle sono da toccare con un dito', async () => {
    await montaConPannelloAperto()
    const pannello = screen.getByRole('list', { name: /Moduli richiesti per CognomeProva NomeProva/ }).parentElement as HTMLElement
    expect(pannello.className).toMatch(/sticky/)
    expect(pannello.className).toMatch(/100vw/)
    const etichetta = screen.getByRole('checkbox', { name: /Delega al ritiro/ }).closest('label') as HTMLElement
    expect(etichetta.className).toMatch(/min-h-11/)
  })
})

describe('ConfermeClient — l’esito resta in vista quando la riga esce dal filtro', () => {
  it('«Mancano moduli»: spuntato l’ultimo la riga non sparisce sotto le dita; ricaricando esce, e il messaggio resta', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.filtroManca }))
    await waitFor(() => expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('mancano_moduli'))).toBe(true))
    fireEvent.click(within(await waitFor(() => rigaDi('CognomeProva NomeProva'))).getByRole('button', { name: itConferme.moduliApri }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Delega al ritiro/ }))
    await waitFor(() => expect(within(rigaDi('CognomeProva NomeProva')).getByText('2/2')).toBeInTheDocument())
    const esito = screen.getByRole('status', { name: itConferme.esitoRegione })
    expect(esito).toHaveTextContent('spuntato')

    // la segreteria ricarica: il server non ha più nessuno che manchi, la riga esce... e il messaggio resta
    fireEvent.click(screen.getByRole('button', { name: itConferme.azioneAggiorna }))
    expect(await screen.findByText(itConferme.vuoto)).toBeInTheDocument()
    expect(screen.queryByText('CognomeProva NomeProva')).toBeNull()
    expect(screen.getByRole('status', { name: itConferme.esitoRegione })).toHaveTextContent('Stato dell’iscrizione: Iscritto.')
  })

  it('«Non hanno risposto»: confermato un bambino la riga esce dal filtro e il messaggio di conferma resta leggibile', async () => {
    s.confermato = false
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.filtroNonRisposto }))
    await waitFor(() => expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('conferma=non_risposto'))).toBe(true))
    fireEvent.click(within(await waitFor(() => rigaDi('CognomeProva NomeProva'))).getByRole('button', { name: itConferme.azioneConferma }))
    expect(await screen.findByText(itConferme.vuoto)).toBeInTheDocument()
    expect(screen.queryByText('CognomeProva NomeProva', { selector: 'strong' })).toBeNull()
    expect(screen.getByRole('status', { name: itConferme.esitoRegione })).toHaveTextContent(`CognomeProva NomeProva: ${itConferme.esitoConfermato}`)
  })

  it('cambiando filtro l’esito vecchio se ne va: non parla di un elenco che non c’è più', async () => {
    await montaConPannelloAperto()
    fireEvent.click(screen.getByRole('checkbox', { name: /Delega al ritiro/ }))
    await screen.findByRole('status', { name: itConferme.esitoRegione })
    fireEvent.click(screen.getByRole('button', { name: itConferme.filtroTutti }))
    await waitFor(() => expect(screen.queryByRole('status', { name: itConferme.esitoRegione })).toBeNull())
  })
})


describe('ConfermeClient — l’esito della quota (4.5.15, I1)', () => {
  const colonnaQuota = (riga: HTMLElement) => within(riga).getAllByRole('cell')[3]

  it('una conferma senza listino dice «Quota da generare», e il pulsante riprova sulla stessa route finché la voce non nasce', async () => {
    s.quota = 'assente'
    s.quotaPost = 'senza_listino'
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    expect(colonnaQuota(rigaDi('CognomeProva NomeProva'))).toHaveTextContent(itConferme.quotaDaGenerare)
    fireEvent.click(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.azioneGeneraQuota }))
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme`).length).toBe(1))
    expect(JSON.parse(chiamate('POST', `/api/admin/anni/${ANNO}/conferme`)[0][1].body)).toEqual({ frequenza_id: F_PART })
    expect(await screen.findByRole('status')).toHaveTextContent(itConferme.esitoQuotaSenzaListino)
    // il listino adesso c'è: stessa riga, stesso pulsante, la voce nasce
    s.quotaPost = 'creata'
    fireEvent.click(await screen.findByRole('button', { name: itConferme.azioneGeneraQuota }))
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme`).length).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull())
    expect(colonnaQuota(rigaDi('CognomeProva NomeProva'))).toHaveTextContent(itConferme.quotaDaPagare)
  })

  it('«piu_voci» ha il suo stato e il suo messaggio, diversi da «senza listino», e non offre «Genera la quota»', async () => {
    s.quota = 'assente'
    s.quotaPost = 'piu_voci'
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.azioneGeneraQuota }))
    expect(await screen.findByText(new RegExp(itConferme.esitoQuotaPiuVoci.slice(0, 30)))).toBeInTheDocument()
    await waitFor(() => expect(colonnaQuota(rigaDi('CognomeProva NomeProva'))).toHaveTextContent(itConferme.quotaPiuVoci))
    expect(screen.queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull()
  })
})
