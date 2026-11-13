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
  ruolo: 'segreteria' as string,
  /** La sede dell'anno in lavorazione, e i gruppi di sezioni che la route per sede restituisce (M1). */
  sede: 'ffffffff-ffff-4fff-8fff-ffffffffff01' as string | null,
  gruppi: [] as unknown[],
  anno: { effettivo: { annoSedeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attivo: false, stato: 'iscrizioni_aperte' } } as unknown,
}))
// 4.7.4: la pagina legge `?vista=` e `?conferma=` all'apertura (il cruscotto rimanda qui). Di solito la query è vuota.
const q = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(q.query) }))
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedeCorrente: h.sede, loading: false }),
  // Il vero `SedeNotice` legge il contesto delle sedi (provato altrove): qui basta vedere che compare e con quale frase.
  SedeNotice: ({ cosa }: { cosa?: string }) => <div data-testid="sede-notice">{cosa}</div>,
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
  useRuoloCockpit: () => h.ruolo,
}))

import { ConfermeClient } from '@/app/(dashboard)/admin/students/conferme/ConfermeClient'

const ANNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const F_PART = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const F_NUOVA = '91919191-9191-4919-8919-919191919191'
const F_NUOVA_ARRIVO = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const AL1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const SEDE_ANNO = 'ffffffff-ffff-4fff-8fff-ffffffffff01'
const SEDE_ALTRA = 'ffffffff-ffff-4fff-8fff-ffffffffff02'
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
  quotaRitiro: 'tolta' as string, // l'esito della voce che «Ritira la conferma» risponde
  ritiroRifiutato: false, // 4.5.16 (B): la route risponde 409 FREQUENZA_NON_DI_CONFERMA (bambino che non frequenta ancora)
  extraPost: {} as Record<string, unknown>, // 4.5.16: `riaperta` / `sezione_ignorata` che il POST di conferma può rispondere
  quotaPost: 'creata' as string, // l'esito della voce che il POST di conferma risponde
  gradoPartenza: null as string | null, // lotto 5: il grado (`school_type`) della classe di oggi del bambino, come lo legge la route
  piuVoci: false, // 4.7.4: `quota_piu_voci` che il server legge per la riga di conferma
  quotaArrivo: 'assente' as 'assente' | 'da_pagare', // la quota del bambino in arrivo, che «Genera la quota» fa nascere (4.5.16, F)
}
const fetchMock = vi.fn()

const rigaConferma = () => ({
  frequenza_id: F_PART, alunno_id: AL1, section_id: null, conferma: s.confermata || s.confermato ? 'confermato' : 'non_risposto',
  nuova_frequenza_id: s.confermata || s.confermato ? F_NUOVA : null, nuova_section_id: null, non_rinnova_motivo: null,
  moduli: { fatti: s.spunteConferma.length, richiesti: 2 }, quota: s.quota, quota_piu_voci: s.piuVoci, cambia_grado: false, grado_partenza: s.gradoPartenza,
  stato_frequenza: s.confermata || s.confermato ? 'in_attesa' : null, nome: 'NomeProva', cognome: 'CognomeProva', classe: 'Sezione Prova',
})
const rigaNuova = () => ({
  frequenza_id: F_NUOVA_ARRIVO, alunno_id: AL2, section_id: null, conferma: 'confermato', nuova_frequenza_id: F_NUOVA_ARRIVO, nuova_section_id: null,
  non_rinnova_motivo: null, moduli: { fatti: 0, richiesti: 2 }, quota: s.quotaArrivo, cambia_grado: false,
  stato_frequenza: 'in_attesa', nome: 'NomeArrivo', cognome: 'CognomeArrivo', classe: null,
})

function risposta(url: string, metodo: string, body: Record<string, unknown>): Risposta {
  if (url.includes('/api/admin/sections/scoped')) return { status: 200, body: { data: h.gruppi } }
  if (url.includes('/conferme/ritira') && s.ritiroRifiutato) {
    return { status: 409, body: { error: itShared.erroreFrequenzaNonDiConferma, codice: 'FREQUENZA_NON_DI_CONFERMA' } }
  }
  if (url.includes('/conferme/ritira')) {
    s.confermato = false
    s.confermata = false
    return ok({ frequenza_id: F_NUOVA, ritirata: true, quota: s.quotaRitiro })
  }
  if (url.includes('/conferme/non-rinnova')) return ok({ frequenza_id: F_PART, non_rinnova: true, cambiato: true })
  if (url.includes(`/api/admin/anni/${ANNO}/conferme/quota`) && metodo === 'POST') {
    if (body.frequenza_id === F_NUOVA_ARRIVO) {
      if (s.quotaPost === 'creata') s.quotaArrivo = 'da_pagare'
      return ok({ frequenza_id: F_NUOVA_ARRIVO, quota: s.quotaPost, pagamento_id: null })
    }
    s.quota = s.quotaPost === 'creata' ? 'da_pagare' : 'assente'
    return ok({ frequenza_id: F_NUOVA, quota: s.quotaPost, pagamento_id: null })
  }
  if (url.includes(`/api/admin/anni/${ANNO}/conferme`) && metodo === 'POST') {
    s.confermata = true
    s.quota = s.quotaPost === 'creata' ? 'da_pagare' : 'assente'
    return ok({ frequenza_id: F_NUOVA, creata: true, cambia_grado: false, retta_personalizzata_precedente: false, quota: s.quotaPost, pagamento_id: null, posti_oltre: false, ...s.extraPost })
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
  h.ruolo = 'segreteria'
  h.sede = SEDE_ANNO
  h.gruppi = []
  s.spunteConferma = [M1]
  s.confermato = true
  s.confermata = false
  s.quota = 'da_pagare'
  s.quotaPost = 'creata'
  s.extraPost = {}
  s.ritiroRifiutato = false
  s.quotaArrivo = 'assente'
  s.piuVoci = false
  s.gradoPartenza = null
  q.query = ''
  s.quotaRitiro = 'tolta'
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
    // 4.5.17 (C): la riga porta `conferma: 'confermato'` e `nuova_frequenza_id` (come quella di un bambino tornato dopo la conferma), ma in «Nuove» «Ritira la conferma» non c'è
    expect(within(riga).queryByRole('button', { name: itConferme.azioneRitiraConferma })).toBeNull()
    // il filtro delle nuove ha solo «Tutti» e «Mancano moduli»
    expect(screen.queryByRole('button', { name: itConferme.filtroNo })).toBeNull()
    expect(screen.getByRole('button', { name: itConferme.filtroManca })).toBeInTheDocument()
  })
})

describe('ConfermeClient — la scheda del bambino in arrivo (4.5.15, C2)', () => {
  it('nelle «Nuove iscrizioni» il nome apre la SUA scheda; nella vista delle conferme il nome resta testo', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    // Controllo POSITIVO sul resto: nella vista delle conferme (chi frequenta già) non c'è alcun collegamento alla scheda.
    expect(screen.queryByRole('link', { name: /CognomeProva NomeProva/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    await screen.findByText('CognomeArrivo NomeArrivo')
    const link = screen.getByRole('link', { name: /CognomeArrivo NomeArrivo/ })
    expect(link.getAttribute('href')).toBe(`/admin/students/${AL2}?kind=child`)
  })
})

describe('ConfermeClient — la casella «Va alla primaria» solo per chi non è già in primaria (lotto 5)', () => {
  const montaConGrado = async (grado: string | null) => {
    s.confermato = false
    s.gradoPartenza = grado
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
  }

  it('la riga di un bambino d\u2019infanzia ha la casella', async () => {
    await montaConGrado('infanzia')
    expect(screen.getByRole('checkbox', { name: itConferme.vaAllaPrimaria })).toBeInTheDocument()
  })

  it('la riga di un bambino già in primaria non ha la casella, ma ha ancora «Conferma»', async () => {
    await montaConGrado('primaria')
    expect(screen.getByRole('button', { name: itConferme.azioneConferma })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: itConferme.vaAllaPrimaria })).toBeNull()
  })
})

describe('ConfermeClient — il selettore della primaria offre le classi della SEDE dell\u2019anno (4.5.15, M1)', () => {
  const opzioniPrimaria = async () => {
    s.confermato = false
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('checkbox', { name: itConferme.vaAllaPrimaria }))
    return screen
  }

  it('con le primarie di DUE sedi nella risposta, il selettore mostra solo quelle della sede dell\u2019anno', async () => {
    h.gruppi = [
      { scuolaId: SEDE_ANNO, scuolaNome: 'Sede Uno', sezioni: [
        { id: 's-uno-a', name: 'PRIMA A UNO', school_type: 'primaria' },
        { id: 's-uno-inf', name: 'GIRASOLI UNO', school_type: 'infanzia' },
      ] },
      { scuolaId: SEDE_ALTRA, scuolaNome: 'Sede Due', sezioni: [{ id: 's-due-a', name: 'PRIMA A DUE', school_type: 'primaria' }] },
    ]
    await opzioniPrimaria()
    const sel = (await screen.findByLabelText(itConferme.sezioneArrivo)) as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([itConferme.sezioneScegli, 'PRIMA A UNO'])
  })

  it('se la primaria c\u2019è solo in un\u2019altra sede, si dice che questa non ne ha, invece di offrire quella degli altri', async () => {
    h.gruppi = [
      { scuolaId: SEDE_ANNO, scuolaNome: 'Sede Uno', sezioni: [{ id: 's-uno-inf', name: 'GIRASOLI UNO', school_type: 'infanzia' }] },
      { scuolaId: SEDE_ALTRA, scuolaNome: 'Sede Due', sezioni: [{ id: 's-due-a', name: 'PRIMA A DUE', school_type: 'primaria' }] },
    ]
    await opzioniPrimaria()
    expect(await screen.findByText(itConferme.nessunaPrimaria)).toBeInTheDocument()
    expect(screen.queryByText('PRIMA A DUE')).toBeNull()
  })

  it('4.5.16 H (4.5.6): scelta una classe di primaria, la POST di conferma porta `section_id` e `cambia_grado: true`', async () => {
    h.gruppi = [
      { scuolaId: SEDE_ANNO, scuolaNome: 'Sede Uno', sezioni: [{ id: 's-uno-a', name: 'PRIMA A UNO', school_type: 'primaria' }] },
    ]
    await opzioniPrimaria()
    const sel = (await screen.findByLabelText(itConferme.sezioneArrivo)) as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 's-uno-a' } })
    fireEvent.click(screen.getByRole('button', { name: itConferme.azioneConferma }))
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme`).length).toBeGreaterThan(0))
    const posts = chiamate('POST', `/api/admin/anni/${ANNO}/conferme`).filter(([u]) => !String(u).includes('/quota'))
    expect(JSON.parse(posts[0][1].body)).toEqual({ frequenza_id: F_PART, section_id: 's-uno-a', cambia_grado: true })
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

  it('conferma che riapre un\u2019iscrizione chiusa, con una classe non applicata: la schermata dice tutte e due le cose (4.5.16, A)', async () => {
    s.confermato = false
    s.extraPost = { creata: false, riaperta: true, sezione_ignorata: true }
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.azioneConferma }))
    const stato = await screen.findByRole('status', { name: itConferme.esitoRegione })
    expect(stato).toHaveTextContent(itConferme.esitoRiaperta)
    expect(stato).toHaveTextContent(itConferme.esitoSezioneIgnorata)
    expect(stato).not.toHaveTextContent(itConferme.esitoGiaConfermato)
  })

  it('una conferma senza listino dice «Quota da generare», e il pulsante riprova sulla stessa route finché la voce non nasce', async () => {
    s.quota = 'assente'
    s.quotaPost = 'senza_listino'
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    expect(colonnaQuota(rigaDi('CognomeProva NomeProva'))).toHaveTextContent(itConferme.quotaDaGenerare)
    fireEvent.click(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.azioneGeneraQuota }))
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`).length).toBe(1))
    expect(JSON.parse(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`)[0][1].body)).toEqual({ frequenza_id: F_NUOVA })
    expect(await screen.findByRole('status')).toHaveTextContent(itConferme.esitoQuotaSenzaListino)
    // il listino adesso c'è: stessa riga, stesso pulsante, la voce nasce
    s.quotaPost = 'creata'
    fireEvent.click(await screen.findByRole('button', { name: itConferme.azioneGeneraQuota }))
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`).length).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull())
    expect(colonnaQuota(rigaDi('CognomeProva NomeProva'))).toHaveTextContent(itConferme.quotaDaPagare)
  })

  it('nelle «Nuove iscrizioni» «Genera la quota» c\u2019è, chiama la route nuova con la frequenza dell\u2019anno NUOVO, e la riga si aggiorna (4.5.16, F)', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    const nome = await screen.findByText('CognomeArrivo NomeArrivo')
    const riga = nome.closest('tr') as HTMLElement
    expect(colonnaQuota(riga)).toHaveTextContent(itConferme.quotaDaGenerare)
    const pulsante = within(riga).getByRole('button', { name: itConferme.azioneGeneraQuota })
    // sta nella stessa tabella scorrevole di «Conferma» e «Ritira»: a 375 px si raggiunge scorrendo, non è tagliato fuori
    expect(pulsante.closest('.overflow-x-auto')).not.toBeNull()
    fireEvent.click(pulsante)
    await waitFor(() => expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`)).toHaveLength(1))
    expect(String(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`)[0][0])).toBe(`/api/admin/anni/${ANNO}/conferme/quota`)
    expect(JSON.parse(chiamate('POST', `/api/admin/anni/${ANNO}/conferme/quota`)[0][1].body)).toEqual({ frequenza_id: F_NUOVA_ARRIVO })
    // niente passa dalla route di conferma, che riparte dalla frequenza di oggi
    expect(chiamate('POST', `/api/admin/anni/${ANNO}/conferme`).filter(([u]) => !String(u).endsWith('/quota'))).toHaveLength(0)
    await waitFor(() => expect(colonnaQuota(rigaDi('CognomeArrivo NomeArrivo'))).toHaveTextContent(itConferme.quotaDaPagare))
    expect(within(rigaDi('CognomeArrivo NomeArrivo')).queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull()
  })

  it('nelle «Nuove» «piu_voci» ha il suo messaggio e non nasce una voce doppia (la risposta lo ridice)', async () => {
    s.quotaPost = 'piu_voci'
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    const riga = (await screen.findByText('CognomeArrivo NomeArrivo')).closest('tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.azioneGeneraQuota }))
    expect(await screen.findByRole('status')).toHaveTextContent(itConferme.esitoQuotaPiuVoci)
    expect(within(rigaDi('CognomeArrivo NomeArrivo')).queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull()
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


describe('ConfermeClient — «Ritira la conferma» (4.5.15, C1)', () => {
  it('chiede conferma, manda la frequenza dell’anno NUOVO alla route e la riga torna libera: «Conferma» di nuovo disponibile', async () => {
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    const riga = nome.closest('tr') as HTMLElement
    expect(within(riga).queryByRole('button', { name: itConferme.azioneConferma })).toBeNull() // confermato: nessuna azione, oggi
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.azioneRitiraConferma }))
    // niente parte finché non si risponde alla domanda
    expect(chiamate('POST', '/conferme/ritira')).toHaveLength(0)
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.ritiraSi }))
    await waitFor(() => expect(chiamate('POST', '/conferme/ritira')).toHaveLength(1))
    expect(JSON.parse(chiamate('POST', '/conferme/ritira')[0][1].body)).toEqual({ frequenza_id: F_NUOVA })
    expect(await screen.findByText(new RegExp(itConferme.esitoRitirataQuotaTolta))).toBeInTheDocument()
    // la riga non resta bloccata: ora si può confermare di nuovo
    expect(await within(rigaDi('CognomeProva NomeProva')).findByRole('button', { name: itConferme.azioneConferma })).toBeInTheDocument()
    expect(within(rigaDi('CognomeProva NomeProva')).queryByRole('button', { name: itConferme.azioneRitiraConferma })).toBeNull()
  })

  it('il pulsante c\u2019è anche sulla riga di chi ha una domanda approvata; se il bambino non frequenta ancora, il rifiuto dice come si toglie (4.5.16, B)', async () => {
    s.ritiroRifiutato = true
    render(<ConfermeClient />)
    const riga = (await screen.findByText('CognomeProva NomeProva')).closest('tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.azioneRitiraConferma }))
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.ritiraSi }))
    await waitFor(() => expect(chiamate('POST', '/conferme/ritira')).toHaveLength(1))
    expect(await screen.findByText(/archiviandolo dalla sua scheda/)).toBeInTheDocument()
    // niente è cambiato: la riga è sempre confermata, col suo pulsante
    expect(within(rigaDi('CognomeProva NomeProva')).getByRole('button', { name: itConferme.azioneRitiraConferma })).toBeInTheDocument()
  })

  it('«Annulla» non manda niente', async () => {
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    const riga = nome.closest('tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.azioneRitiraConferma }))
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.ritiraAnnulla }))
    expect(chiamate('POST', '/conferme/ritira')).toHaveLength(0)
    expect(within(riga).getByRole('button', { name: itConferme.azioneRitiraConferma })).toBeInTheDocument()
  })

  it('con la quota già pagata la schermata lo dice: rimborso e storno sono della contabilità', async () => {
    s.quotaRitiro = 'resta-pagata'
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    const riga = nome.closest('tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.azioneRitiraConferma }))
    fireEvent.click(within(riga).getByRole('button', { name: itConferme.ritiraSi }))
    expect(await screen.findByText(new RegExp(itConferme.esitoRitirataQuotaPagata.slice(0, 30)))).toBeInTheDocument()
  })

  it('la coordinatrice non vede il pulsante (la route le risponde comunque 403)', async () => {
    h.ruolo = 'coordinator'
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    expect(within(nome.closest('tr') as HTMLElement).queryByRole('button', { name: itConferme.azioneRitiraConferma })).toBeNull()
  })

  it('un ruolo ignoto (il provider non ha ancora risposto) nasconde il pulsante', async () => {
    h.ruolo = ''
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    expect(within(nome.closest('tr') as HTMLElement).queryByRole('button', { name: itConferme.azioneRitiraConferma })).toBeNull()
  })
})

describe('ConfermeClient — 4.7.4: «più voci» dal server e filtri aperti dall’indirizzo', () => {
  it('una riga con `quota_piu_voci` dal server mostra «Più voci» e NON offre «Genera la quota», anche dopo un ricaricamento', async () => {
    s.quota = 'assente'
    s.piuVoci = true
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    const riga = nome.closest('tr') as HTMLElement
    expect(within(riga).getByText(itConferme.quotaPiuVoci)).toBeInTheDocument()
    expect(within(riga).queryByRole('button', { name: itConferme.azioneGeneraQuota })).toBeNull()
  })

  it('senza `quota_piu_voci` la stessa riga offre «Genera la quota» (controllo positivo)', async () => {
    s.quota = 'assente'
    s.piuVoci = false
    render(<ConfermeClient />)
    const nome = await screen.findByText('CognomeProva NomeProva')
    expect(within(nome.closest('tr') as HTMLElement).getByRole('button', { name: itConferme.azioneGeneraQuota })).toBeInTheDocument()
  })

  it('`?conferma=moduli_senza_quota` apre il filtro giusto e lo passa alla route', async () => {
    q.query = 'conferma=moduli_senza_quota'
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('conferma=moduli_senza_quota'))).toBe(true)
  })

  it('`?vista=nuove&conferma=quota_senza_moduli` apre le nuove con quel filtro', async () => {
    q.query = 'vista=nuove&conferma=quota_senza_moduli'
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('vista=nuove&conferma=quota_senza_moduli'))).toBe(true)
  })

  it('un filtro che nelle nuove non esiste si ignora', async () => {
    q.query = 'vista=nuove&conferma=no'
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('conferma=no'))).toBe(false)
  })
})

describe('ConfermeClient — revisione finale: il perimetro del cruscotto, il filtro che resta, la sede', () => {
  const MOD = '71717171-7171-4717-8717-717171717171'

  it('`?vista=nuove&ambito=anno&conferma=…` passa il perimetro alla route e lo dice sopra la tabella', async () => {
    q.query = 'vista=nuove&ambito=anno&conferma=moduli_senza_quota'
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('vista=nuove&conferma=moduli_senza_quota&ambito=anno'))).toBe(true)
    expect(screen.getByText(itConferme.ambitoAnnoNota)).toBeInTheDocument()
    expect(screen.queryByText(itConferme.nuoveNota)).toBeNull()
  })

  it('`&modulo=` si passa solo con «Mancano moduli», e il pulsante toglie il perimetro e rilegge le sole Nuove', async () => {
    q.query = `vista=nuove&ambito=anno&conferma=mancano_moduli&modulo=${MOD}`
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes(`ambito=anno&modulo=${MOD}`))).toBe(true)
    expect(screen.getByText(itConferme.ambitoAnnoModuloNotaSenzaTitolo)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itConferme.ambitoAnnoEsci }))
    await waitFor(() => expect(screen.queryByText(itConferme.ambitoAnnoModuloNotaSenzaTitolo)).toBeNull())
    const ultimo = String(chiamate('GET', '/conferme?').at(-1)![0])
    expect(ultimo).toContain('vista=nuove')
    expect(ultimo).toContain('conferma=mancano_moduli')
    expect(ultimo).not.toContain('ambito=')
    expect(ultimo).not.toContain('modulo=')
  })

  it('un `modulo` che non è un uuid si ignora', async () => {
    q.query = 'vista=nuove&ambito=anno&conferma=mancano_moduli&modulo=non-un-uuid'
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('modulo='))).toBe(false)
  })

  it('cambiare vista toglie il perimetro ma TIENE il filtro, se nell’altra vista esiste', async () => {
    q.query = 'vista=nuove&ambito=anno&conferma=moduli_senza_quota'
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaConferme }))
    await waitFor(() => expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('vista=conferme&conferma=moduli_senza_quota'))).toBe(true))
    const ultimo = String(chiamate('GET', '/conferme?').at(-1)![0])
    expect(ultimo).not.toContain('ambito=')
  })

  it('cambiare vista azzera il filtro che nell’altra vista non esiste («Hanno confermato» non c’è nelle Nuove)', async () => {
    q.query = 'conferma=confermato'
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    await waitFor(() => expect(chiamate('GET', '/conferme?').some(([url]) => String(url).includes('vista=nuove&conferma=tutti'))).toBe(true))
  })

  it('con più sedi attive chiede la SEDE, non l’anno, e non legge niente', async () => {
    h.sede = null
    render(<ConfermeClient />)
    expect(await screen.findByTestId('sede-notice')).toHaveTextContent(itConferme.sedeCosa)
    expect(screen.queryByText(itConferme.nessunAnno)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    h.sede = 'ffffffff-ffff-4fff-8fff-ffffffffff01'
  })
})

describe('ConfermeClient — ri-revisione: modulo di un’altra sede, nota col titolo, etichetta della classe', () => {
  const MOD = '71717171-7171-4717-8717-717171717171'

  it('N1 · un modulo rifiutato dalla route (422) dice il messaggio e offre di togliere il filtro, non «Totale: 0»', async () => {
    q.query = `vista=nuove&ambito=anno&conferma=mancano_moduli&modulo=${MOD}`
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((url: string, init?: unknown) =>
      String(url).includes('modulo=')
        ? Promise.resolve({ ok: false, status: 422, json: async () => ({ error: 'Questo modulo non è richiesto', codice: 'MODULO_NON_RICHIESTO' }) })
        : base(url, init))
    render(<ConfermeClient />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Questo modulo non è richiesto')
    expect(screen.queryByText(/Totale/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: itConferme.ambitoAnnoTogliModulo }))
    await screen.findByText('CognomeArrivo NomeArrivo')
    const ultimo = String(chiamate('GET', '/conferme?').at(-1)![0])
    expect(ultimo).not.toContain('modulo=')
    expect(ultimo).toContain('ambito=anno')
  })

  it('N2 · la nota sopra la lista di un modulo lo nomina', async () => {
    q.query = `vista=nuove&ambito=anno&conferma=mancano_moduli&modulo=${MOD}&titolo=Delega%20al%20ritiro`
    render(<ConfermeClient />)
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(screen.getByText(itConferme.ambitoAnnoModuloNota.replace('{titolo}', 'Delega al ritiro'))).toBeInTheDocument()
    expect(itConferme.ambitoAnnoModuloNota).not.toMatch(/un solo modulo/)
  })

  it('N3 · l’etichetta della classe dice il vero nelle due viste', async () => {
    render(<ConfermeClient />)
    await screen.findByText('CognomeProva NomeProva')
    expect(screen.queryAllByText(/Classe dell’anno prossimo/)).toHaveLength(0)
    // le righe delle Nuove portano la classe dell'anno nuovo: il finto gliene dà una
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: unknown) => {
      const r = (await base(url, init)) as { ok: boolean; status: number; json: () => Promise<{ data?: { righe?: Array<Record<string, unknown>> } }> }
      if (!String(url).includes('vista=nuove')) return r
      const corpo = await r.json()
      return { ...r, json: async () => ({ ...corpo, data: { ...corpo.data, righe: (corpo.data?.righe ?? []).map((x) => ({ ...x, classe: 'Sezione A' })) } }) }
    })
    fireEvent.click(screen.getByRole('button', { name: itConferme.vistaNuove }))
    await screen.findByText('CognomeArrivo NomeArrivo')
    expect(screen.queryAllByText(/Classe di oggi/)).toHaveLength(0)
    expect(screen.queryAllByText(/Classe dell’anno prossimo/).length).toBeGreaterThan(0)
  })
})
