import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itPassaggio from '../../messages/it/annoPassaggio.json'
import itShared from '../../messages/it/shared.json'
import itSettings from '../../messages/it/adminSettings.json'
import enSettings from '../../messages/en/adminSettings.json'
import enPassaggio from '../../messages/en/annoPassaggio.json'

// =============================================================================
// PR 4.8 · compito 4.8.9 · LA PAGINA «PASSAGGIO D'ANNO».
//
// Si prova ciò che la segreteria vede e tocca: i quattro stati (Non ancora, Anteprima, Confermato, Annullato), il pulsante spento
// prima della data e con righe da decidere, i contatori che filtrano, la correzione di una classe (PUT …/righe con il corpo giusto),
// il dialogo che conta le famiglie che usciranno, il 409 con la frase del codice, i nomi della sola pagina corrente.
//
// La `fetch` finta rispetta le forme assunte per le sei route (scritte in parallelo dalla 4.8.8) e risponde in modo DIVERSO secondo lo
// stato del «server» (`s`): un finto che risponde sempre uguale sarebbe verde anche senza il codice. Si aspetta sempre una PRESENZA
// prima di asserire un'assenza. Date fisse (solo `Date` finto, i timer restano veri), nomi e uuid inventati.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  sede: 'ffffffff-ffff-4fff-8fff-ffffffffff01' as string | null,
  anno: { effettivo: { annoSedeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attivo: false, stato: 'iscrizioni_aperte' } } as unknown,
}))
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedeCorrente: h.sede }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
  useRuoloCockpit: () => 'segreteria',
}))

import { PassaggioClient } from '@/app/(dashboard)/admin/students/passaggio/PassaggioClient'

const ANNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PASS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEDE = 'ffffffff-ffff-4fff-8fff-ffffffffff01'
const AL1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const AL2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const AL3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'
const AL4 = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4'
const AL5 = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5'
const AL9 = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9'
const S_DA = '51515151-5151-4515-8515-515151515151'
const S_A1 = '52525252-5252-4525-8525-525252525252'
const S_A2 = '53535353-5353-4535-8535-535353535353'
const DOC1 = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'

type Esito = 'continua' | 'cambia_grado' | 'nuova' | 'esce' | 'non_risposto'
type RigaS = {
  alunno_id: string
  esito: Esito
  avviso: 'ritirato_tendina' | 'senza_sezione' | null
  eccezione: boolean
  sezione_da_id: string | null
  sezione_a_id: string | null
  frequenza_a_id: string | null
}
const riga = (alunno_id: string, esito: Esito, extra: Partial<RigaS> = {}): RigaS => ({
  alunno_id, esito, avviso: null, eccezione: false, sezione_da_id: S_DA, sezione_a_id: S_A1, frequenza_a_id: null, ...extra,
})

/** Lo stato del «server»: cambia quando la pagina scrive, e le letture successive lo riflettono. */
const s = {
  passaggio: null as null | { id: string; stato: 'anteprima' | 'confermato'; conteggi: Record<string, number>; apribile_dal: string | null; inizio_anno_nuovo?: string | null; confermato_il?: string | null },
  righe: [] as RigaS[],
  conferma409: null as null | string,
  annulla409: null as null | string,
  pending: false,
  lettura: null as null | number, // uno status di errore per la GET principale
  /** (giro 3, NS1) Come in produzione: l'elenco delle sezioni è quello dell'anno NUOVO, la classe di partenza arriva coi nomi della lettura. */
  scopedSenzaVecchia: false,
}
const fetchMock = vi.fn()

const RIGHE_BASE = (): RigaS[] => [
  riga(AL1, 'continua'),
  riga(AL2, 'esce', { sezione_a_id: null }),
  riga(AL3, 'non_risposto', { sezione_a_id: null }),
  riga(AL5, 'non_risposto', { sezione_a_id: null }),
]
const RIGA_DA_DECIDERE = () => riga(AL4, 'cambia_grado', { sezione_a_id: null, avviso: 'senza_sezione' })

const nomiStudenti = [
  { id: AL1, nome: 'NomeUno', cognome: 'CognomeUno', classe_sezione: 'Sezione Vecchia' },
  { id: AL2, nome: 'NomeDue', cognome: 'CognomeDue', classe_sezione: 'Sezione Vecchia' },
  { id: AL3, nome: 'NomeTre', cognome: 'CognomeTre', classe_sezione: 'Sezione Vecchia' },
  { id: AL4, nome: 'NomeQuattro', cognome: 'CognomeQuattro', classe_sezione: 'Sezione Vecchia' },
  { id: AL5, nome: 'NomeCinque', cognome: 'CognomeCinque', classe_sezione: 'Sezione Vecchia' },
  // Un bambino che NON è nelle righe della pagina: il suo nome non deve comparire mai.
  { id: AL9, nome: 'NomeFuori', cognome: 'CognomeFuori', classe_sezione: 'Sezione Vecchia' },
]

type Risposta = { status: number; body: unknown }
const ok = (data: unknown): Risposta => ({ status: 200, body: { success: true, data } })

function lettura(params: URLSearchParams): Risposta {
  if (s.lettura) return { status: s.lettura, body: {} }
  if (!s.passaggio) return ok({ passaggio: null, righe: [], totale: 0, docenti: [] })
  let righe = s.righe
  const esito = params.get('esito')
  const avviso = params.get('avviso')
  if (esito) righe = righe.filter((r) => r.esito === esito)
  if (avviso) righe = righe.filter((r) => r.avviso === avviso)
  const tetto = Number(params.get('tetto') ?? 25)
  const max = Number(params.get('contatori') ?? 0)
  const contatori = max > 0
    ? {
        esiti: Object.fromEntries((['continua', 'cambia_grado', 'nuova', 'esce', 'non_risposto'] as const).map((e) => [e, s.righe.filter((r) => r.esito === e).length])),
        avvisi: Object.fromEntries((['ritirato_tendina', 'senza_sezione'] as const).map((a) => [a, s.righe.filter((r) => r.avviso === a).length])),
        daDecidere: s.righe.filter((r) => r.avviso !== null).slice(0, max),
      }
    : undefined
  return ok({
    passaggio: s.passaggio,
    righe: righe.slice(0, tetto),
    totale: righe.length,
    docenti: [{ utente_id: DOC1, sezione_a_id: S_A1, origine: 'copiata' }],
    ...(contatori ? { contatori } : {}),
    ...(s.scopedSenzaVecchia ? { classi_da: { [S_DA]: 'Sezione Partenza' } } : {}),
  })
}

function risposta(url: string, metodo: string, body: Record<string, unknown>): Risposta {
  if (url.includes('/api/admin/sections/scoped')) {
    return ok([{ scuolaId: SEDE, sezioni: [
      { id: S_A1, name: 'Sezione Nuova A', school_type: 'infanzia' },
      { id: S_A2, name: 'Sezione Nuova B', school_type: 'infanzia' },
      ...(s.scopedSenzaVecchia ? [] : [{ id: S_DA, name: 'Sezione Partenza', school_type: 'infanzia' }]),
    ] }])
  }
  if (url.includes('/api/admin/staff')) return { status: 200, body: { success: true, data: [{ id: DOC1, nome: 'NomeDocente', cognome: 'CognomeDocente', ruolo: 'docente' }] } }
  const base = `/api/admin/anni/${ANNO}/passaggio`
  if (url.includes(`${base}/nomi`) && metodo === 'GET') {
    const ids = (new URL(url, 'http://x').searchParams.get('ids') ?? '').split(',')
    const inRighe = new Set(s.righe.map((r) => r.alunno_id))
    return ok(nomiStudenti.filter((a) => ids.includes(a.id) && inRighe.has(a.id)).map((a) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe: a.classe_sezione })))
  }
  if (url.includes(`${base}/righe`) && metodo === 'PUT') return ok({ alunno_id: body.alunno_id, esito: body.esito, eccezione: true })
  if (url.includes(`${base}/docenti`) && metodo === 'PUT') return ok({ utente_id: body.utente_id })
  if (url.includes(`${base}/conferma-tardiva`) && metodo === 'POST') return ok({ frequenza_id: 'f', creata: true })
  if (url.includes(`${base}/conferma`) && metodo === 'POST') {
    if (s.conferma409) return { status: 409, body: { error: 'x', codice: s.conferma409 } }
    s.passaggio = { id: PASS, stato: 'confermato', conteggi: { continuano: 1, nuovi: 0, usciti: 3, cambia_grado: 0, docenti_copiati: 1 }, apribile_dal: '2027-07-01' }
    return ok({ passaggio_id: PASS, gia_confermato: false })
  }
  if (url.includes(`${base}/annulla`) && metodo === 'POST') {
    if (s.annulla409) return { status: 409, body: { error: 'x', codice: s.annulla409, conteggi: { presenze: 12, galleria_media_v2: 3, tabella_nuova: 2 } } }
    s.passaggio = null
    s.righe = []
    return ok({ passaggio_id: PASS })
  }
  if (url.includes(base) && metodo === 'POST') {
    s.passaggio = { id: PASS, stato: 'anteprima', conteggi: {}, apribile_dal: s.passaggio?.apribile_dal ?? '2027-07-01' }
    s.righe = RIGHE_BASE()
    return ok({ passaggio_id: PASS, creato: true })
  }
  if (url.includes(base) && metodo === 'GET') return lettura(new URL(url, 'http://x').searchParams)
  return { status: 404, body: { error: 'non previsto' } }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-07-10T10:00:00Z'))
  h.sede = SEDE
  h.anno = { effettivo: { annoSedeId: ANNO, attivo: false, stato: 'iscrizioni_aperte' } }
  s.passaggio = { id: PASS, stato: 'anteprima', conteggi: {}, apribile_dal: '2027-07-01', inizio_anno_nuovo: '2027-09-15' }
  s.righe = RIGHE_BASE()
  s.conferma409 = null
  s.annulla409 = null
  s.pending = false
  s.lettura = null
  s.scopedSenzaVecchia = false
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (s.pending) return new Promise(() => {})
    const r = risposta(String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : {})
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const chiamate = (metodo: string, parte: string) =>
  fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === metodo && String(url).includes(parte))
const corpoDi = (c: unknown[]) => JSON.parse((c[1] as { body: string }).body)
const pulsanteConferma = () => screen.getByRole('button', { name: itPassaggio.azioneConferma })

describe('PassaggioClient · gli stati', () => {
  it('senza anno scelto dice di sceglierlo, senza chiamare il server', () => {
    h.anno = { effettivo: null }
    render(<PassaggioClient />)
    expect(screen.getByText(itPassaggio.nessunAnno)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mentre carica mostra lo stato di caricamento', () => {
    s.pending = true
    render(<PassaggioClient />)
    expect(screen.getByRole('status').textContent).toBe(itPassaggio.caricamento)
  })

  it('un guasto della lettura mostra l’errore col pulsante «Riprova», un 403 dice che manca il permesso', async () => {
    s.lettura = 500
    const { unmount } = render(<PassaggioClient />)
    expect((await screen.findByRole('alert')).textContent).toBe(itPassaggio.erroreGenerico)
    s.lettura = null
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.riprova }))
    expect(await screen.findByText('NomeUno CognomeUno')).toBeTruthy()
    unmount()
    s.lettura = 403
    render(<PassaggioClient />)
    expect((await screen.findByRole('alert')).textContent).toBe(itPassaggio.errorePermesso)
  })

  it('NESSUN PASSAGGIO: propone di calcolare l’anteprima, e il clic fa la POST giusta', async () => {
    s.passaggio = null
    s.righe = []
    render(<PassaggioClient />)
    expect(await screen.findByText(itPassaggio.nessunaAnteprima)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.azioneCalcola }))
    expect(await screen.findByText('NomeUno CognomeUno')).toBeTruthy()
    const post = chiamate('POST', `/api/admin/anni/${ANNO}/passaggio`).filter(([u]) => String(u).endsWith('/passaggio'))
    expect(post).toHaveLength(1)
    expect(corpoDi(post[0])).toEqual({ azione: 'anteprima' })
  })

  it('NON ANCORA: prima della data dice «dal {data}» e il pulsante resta spento', async () => {
    vi.setSystemTime(new Date('2027-06-15T10:00:00Z'))
    render(<PassaggioClient />)
    expect(await screen.findByText(new RegExp(itPassaggio.nonAncora.replace('{data}', '1 luglio 2027').replace('.', '\\.')))).toBeTruthy()
    expect((pulsanteConferma() as HTMLButtonElement).disabled).toBe(true)
  })

  it('ANTEPRIMA: dalla data in poi niente frase, il pulsante è acceso e i contatori mostrano i numeri del server', async () => {
    render(<PassaggioClient />)
    expect(await screen.findByText('NomeUno CognomeUno')).toBeTruthy()
    expect(screen.queryByText(/Il passaggio si può fare dal/)).toBeNull()
    expect((pulsanteConferma() as HTMLButtonElement).disabled).toBe(false)
    const contatori = screen.getByRole('group', { name: itPassaggio.contatoriEtichetta })
    await waitFor(() => expect(within(contatori).getByRole('button', { name: /Non hanno risposto\s*2/ })).toBeTruthy())
    expect(within(contatori).getByRole('button', { name: /Continuano\s*1/ })).toBeTruthy()
    expect(within(contatori).getByRole('button', { name: /Escono\s*1/ })).toBeTruthy()
  })

  it('un contatore filtra l’elenco: la richiesta porta l’esito e restano solo quei bambini', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    const contatori = screen.getByRole('group', { name: itPassaggio.contatoriEtichetta })
    fireEvent.click(await within(contatori).findByRole('button', { name: /Escono/ }))
    await waitFor(() => expect(screen.queryByText('NomeUno CognomeUno')).toBeNull())
    expect(screen.getByText('NomeDue CognomeDue')).toBeTruthy()
    expect(chiamate('GET', 'esito=esce&pagina=1').length).toBeGreaterThan(0)
  })

  it('DA DECIDERE: le righe con avviso compaiono nel blocco e il pulsante di conferma resta spento', async () => {
    s.righe = [...RIGHE_BASE(), RIGA_DA_DECIDERE()]
    render(<PassaggioClient />)
    const blocco = (await screen.findByRole('region', { name: /Da decidere/ })) as HTMLElement
    expect(await within(blocco).findByText('NomeQuattro CognomeQuattro')).toBeTruthy()
    expect(within(blocco).getByText(itPassaggio.avvisoSenzaSezione)).toBeTruthy()
    expect((pulsanteConferma() as HTMLButtonElement).disabled).toBe(true)
  })

  it('senza righe da decidere il blocco dice che non c’è niente da decidere', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    expect(await screen.findByText(itPassaggio.daDecidereVuoto)).toBeTruthy()
  })

  it('i nomi sono quelli della sola pagina: chi non è nelle righe non compare', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    expect(screen.queryByText(/CognomeFuori/)).toBeNull()
    expect(screen.queryByText(/NomeFuori/)).toBeNull()
  })
})

describe('PassaggioClient · le scritture', () => {
  it('correggere la classe nuova chiama PUT …/righe con il corpo giusto', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    const tendina = await screen.findByLabelText('Classe nuova di NomeUno CognomeUno')
    fireEvent.change(tendina, { target: { value: S_A2 } })
    await waitFor(() => expect(chiamate('PUT', '/passaggio/righe')).toHaveLength(1))
    expect(corpoDi(chiamate('PUT', '/passaggio/righe')[0])).toEqual({ alunno_id: AL1, esito: 'continua', section_id: S_A2 })
  })

  it('«Esce dalla scuola» manda l’esito `esce` senza sezione', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    fireEvent.change(await screen.findByLabelText('Classe nuova di NomeUno CognomeUno'), { target: { value: '__esce__' } })
    await waitFor(() => expect(chiamate('PUT', '/passaggio/righe')).toHaveLength(1))
    expect(corpoDi(chiamate('PUT', '/passaggio/righe')[0])).toEqual({ alunno_id: AL1, esito: 'esce' })
  })

  it('chi esce o non ha risposto non ha la tendina: ha il rimando «Registra la conferma» verso «Conferme»', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeTre CognomeTre')
    expect(screen.queryByLabelText('Classe nuova di NomeTre CognomeTre')).toBeNull()
    const link = screen.getAllByRole('link', { name: itPassaggio.rimandoConferme })[0]
    expect(link.getAttribute('href')).toBe('/admin/students/conferme')
  })

  // Prova di facilità d'uso del 14/11: venti «esce» in fila spaventano. In cima all'anteprima un riquadro dice quante famiglie non
  // hanno risposto, che è solo un'anteprima, e porta alle Conferme; una riga spiega «Cambiano grado» e come si segna la primaria.
  it('in cima all\'anteprima: il riquadro con il conteggio dei non risposto, «è solo un\'anteprima» e il collegamento alle Conferme', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    const riquadro = await screen.findByRole('region', { name: itPassaggio.riquadroNonRispostoTitolo })
    expect(riquadro.textContent).toMatch(/2 famiglie non hanno risposto/)
    expect(riquadro.textContent).toMatch(/escono/)
    expect(riquadro.textContent).toMatch(/solo un'anteprima, non è cambiato niente/)
    expect(within(riquadro).getByRole('link', { name: itPassaggio.riquadroVaiAConferme }).getAttribute('href')).toBe('/admin/students/conferme')
    // sta SOPRA l'elenco dei bambini
    const elenco = screen.getByText('NomeUno CognomeUno')
    expect(riquadro.compareDocumentPosition(elenco) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('una riga spiega «Cambiano grado» e come si segna un bambino che va alla primaria', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    const nota = await screen.findByText(itPassaggio.cambiaGradoNota)
    expect(nota.textContent).toMatch(/Va alla primaria/)
  })

  it('«Conferma il passaggio» apre il dialogo che conta i bambini che usciranno, dice le date e il sì fa la POST giusta', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    await waitFor(() => expect((pulsanteConferma() as HTMLButtonElement).disabled).toBe(false))
    await screen.findByRole('button', { name: /Non hanno risposto\s*2/ })
    fireEvent.click(pulsanteConferma())
    const dialogo = await screen.findByRole('dialog')
    expect(within(dialogo).getByText(/2 bambini le cui famiglie non hanno risposto usciranno/)).toBeTruthy()
    // Giro 1, B3: quanti perdono subito l'accesso (1 «esce» + 2 senza risposta) e fino a quando le altre famiglie vedono la classe com'è ora.
    expect(within(dialogo).getByText(/3 bambini perdono subito l’accesso all’app delle famiglie/)).toBeTruthy()
    expect(within(dialogo).getByText(/fino al 14 settembre 2027; la classe nuova la vedono dal 15 settembre 2027/)).toBeTruthy()
    expect(chiamate('POST', '/passaggio/conferma')).toHaveLength(0)
    fireEvent.click(within(dialogo).getByRole('button', { name: itPassaggio.dialogoSi }))
    await waitFor(() => expect(chiamate('POST', '/passaggio/conferma')).toHaveLength(1))
    expect(corpoDi(chiamate('POST', '/passaggio/conferma')[0])).toEqual({})
    expect(await screen.findByText(itPassaggio.statoConfermato)).toBeTruthy()
  })

  it('un 409 ANTEPRIMA_VECCHIA dice di rifare l’anteprima, con il pulsante', async () => {
    s.conferma409 = 'ANTEPRIMA_VECCHIA'
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    await screen.findByRole('button', { name: /Non hanno risposto\s*2/ })
    fireEvent.click(pulsanteConferma())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: itPassaggio.dialogoSi }))
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(itShared.erroreAnteprimaVecchia)
    fireEvent.click(within(avviso).getByRole('button', { name: itPassaggio.azioneRicalcola }))
    await waitFor(() => expect(chiamate('POST', '/passaggio').filter(([u]) => String(u).endsWith('/passaggio'))).toHaveLength(1))
  })
})

describe('PassaggioClient · confermato e annullato', () => {
  beforeEach(() => {
    s.passaggio = { id: PASS, stato: 'confermato', conteggi: { continuano: 1, nuovi: 0, usciti: 3, cambia_grado: 0, docenti_copiati: 1 }, apribile_dal: '2027-07-01' }
  })

  it('L6-3: «Annulla il passaggio» ha 44px di area di tocco (pseudo-elemento fisso, come i pulsanti IT/EN) senza far crescere il pulsante', async () => {
    render(<PassaggioClient />)
    const b = await screen.findByRole('button', { name: itPassaggio.azioneAnnulla })
    const c = b.className.split(/\s+/)
    expect(c, 'il pulsante è il riferimento del pseudo-elemento').toContain('relative')
    expect(c).toContain('before:absolute')
    expect(c, '44px = h-11, fissi').toContain('before:h-11')
    expect(c).toContain('before:inset-x-0')
    expect(c).toContain('before:top-1/2')
    expect(c).toContain('before:-translate-y-1/2')
    // il layout non cresce: nessuna altezza minima né padding verticale maggiore sul pulsante stesso
    const proprie = c.filter((x) => !x.startsWith('before:'))
    expect(proprie.filter((x) => /^(min-h-|h-|py-(?:3|4|5))/.test(x))).toEqual([])
  })

  it('CONFERMATO: mostra il riepilogo dei conteggi, «Annulla il passaggio» e niente conferma', async () => {
    render(<PassaggioClient />)
    expect(await screen.findByText(itPassaggio.statoConfermato)).toBeTruthy()
    expect(screen.getByText('Continuano: 1')).toBeTruthy()
    expect(screen.getByText('Usciti: 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: itPassaggio.azioneAnnulla })).toBeTruthy()
    expect(screen.queryByRole('button', { name: itPassaggio.azioneConferma })).toBeNull()
  })

  it('un 409 PASSAGGIO_NON_ANNULLABILE mostra la frase del codice, senza inventare', async () => {
    s.annulla409 = 'PASSAGGIO_NON_ANNULLABILE'
    render(<PassaggioClient />)
    await screen.findByText(itPassaggio.statoConfermato)
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.azioneAnnulla }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: itPassaggio.dialogoAnnullaSi }))
    // Giro 1, S7: la frase del codice, poi che cosa c'è nell'anno nuovo (nome leggibile; una tabella che non si conosce con il suo nome).
    const avviso = (await screen.findByRole('alert')).textContent ?? ''
    expect(avviso.startsWith(itShared.errorePassaggioNonAnnullabile)).toBe(true)
    expect(avviso).toContain('presenze: 12')
    expect(avviso).toContain('foto e video: 3')
    expect(avviso).toContain('tabella_nuova: 2')
    expect(chiamate('POST', '/passaggio/annulla')).toHaveLength(1)
    expect(corpoDi(chiamate('POST', '/passaggio/annulla')[0])).toEqual({})
  })

  it('ANNULLATO: dopo l’annullamento riuscito si può rifare l’anteprima', async () => {
    render(<PassaggioClient />)
    await screen.findByText(itPassaggio.statoConfermato)
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.azioneAnnulla }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: itPassaggio.dialogoAnnullaSi }))
    expect(await screen.findByText(itPassaggio.statoAnnullato)).toBeTruthy()
    expect(screen.getByRole('button', { name: itPassaggio.azioneCalcola })).toBeTruthy()
  })

  it('per chi è uscito c’è la «Conferma tardiva», che chiama la POST con alunno e classe', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeDue CognomeDue')
    fireEvent.change(await screen.findByLabelText('Classe per la conferma tardiva di NomeDue CognomeDue'), { target: { value: S_A2 } })
    const riga2 = screen.getByText('NomeDue CognomeDue').closest('li') as HTMLElement
    fireEvent.click(within(riga2).getByRole('button', { name: itPassaggio.azioneTardiva }))
    await waitFor(() => expect(chiamate('POST', '/passaggio/conferma-tardiva')).toHaveLength(1))
    expect(corpoDi(chiamate('POST', '/passaggio/conferma-tardiva')[0])).toEqual({ alunno_id: AL2, section_id: S_A2 })
  })
})

describe('PassaggioClient · giro di correzione 1', () => {
  it('S1 · un «Esce» scelto a mano ha la tendina «Continua in questa classe», e la correzione manda `continua` con la classe', async () => {
    s.righe = [riga(AL1, 'esce', { sezione_a_id: null, eccezione: true }), ...RIGHE_BASE().slice(1)]
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    const tendina = (await screen.findByLabelText('Classe nuova di NomeUno CognomeUno')) as HTMLSelectElement
    expect(within(tendina).getByRole('option', { name: itPassaggio.correggiRiporta })).toBeTruthy()
    expect(within(tendina).queryByRole('option', { name: itPassaggio.correggiEsce })).toBeNull()
    fireEvent.change(tendina, { target: { value: S_A1 } })
    await waitFor(() => expect(chiamate('PUT', '/passaggio/righe')).toHaveLength(1))
    expect(corpoDi(chiamate('PUT', '/passaggio/righe')[0])).toEqual({ alunno_id: AL1, esito: 'continua', section_id: S_A1 })
  })

  it('S1 · «Scarta l’anteprima» chiama l’annullo e ripropone di calcolarla', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.azioneScarta }))
    await waitFor(() => expect(chiamate('POST', '/passaggio/annulla')).toHaveLength(1))
    expect(await screen.findByText(itPassaggio.statoAnnullato)).toBeTruthy()
  })

  it('S3 · la conferma tardiva non ha una classe predefinita: il pulsante resta spento finché non se ne sceglie una', async () => {
    s.passaggio = { id: PASS, stato: 'confermato', conteggi: {}, apribile_dal: '2027-07-01', inizio_anno_nuovo: '2027-09-15' }
    render(<PassaggioClient />)
    await screen.findByText('NomeDue CognomeDue')
    const riga2 = screen.getByText('NomeDue CognomeDue').closest('li') as HTMLElement
    const pulsante = within(riga2).getByRole('button', { name: itPassaggio.azioneTardiva }) as HTMLButtonElement
    expect(pulsante.disabled).toBe(true)
    fireEvent.change(await screen.findByLabelText('Classe per la conferma tardiva di NomeDue CognomeDue'), { target: { value: S_A2 } })
    expect(pulsante.disabled).toBe(false)
  })

  it('S17 · sull’anno in corso, senza passaggio, rimanda al selettore invece di proporre il calcolo', async () => {
    s.passaggio = null
    s.righe = []
    h.anno = { effettivo: { annoSedeId: ANNO, attivo: true, stato: 'corrente' } }
    render(<PassaggioClient />)
    expect(await screen.findByText(itPassaggio.rimandoSelettore)).toBeTruthy()
    expect(screen.queryByRole('button', { name: itPassaggio.azioneCalcola })).toBeNull()
  })

  it('anno IN PREPARAZIONE (iscrizioni chiuse): non rimanda al selettore, dice che le iscrizioni vanno aperte', async () => {
    s.passaggio = null
    s.righe = []
    h.anno = { effettivo: { annoSedeId: ANNO, attivo: false, stato: 'in_preparazione' } }
    render(<PassaggioClient />)
    expect(await screen.findByText(itPassaggio.rimandoApertura)).toBeTruthy()
    expect(screen.queryByText(itPassaggio.rimandoSelettore)).toBeNull()
    expect(screen.queryByRole('button', { name: itPassaggio.azioneCalcola })).toBeNull()
  })

  it('la frase di apertura nomina il PULSANTE da premere, come il cruscotto (it e en)', () => {
    expect(itPassaggio.rimandoApertura).toContain(`«${itSettings.annoApriConferma}»`)
    expect(enPassaggio.rimandoApertura).toContain(`“${enSettings.annoApriConferma}”`)
    expect(enPassaggio.rimandoApertura).not.toMatch(/[«»]/)
  })

  it('S15 · la classe di PARTENZA viene dalla riga, non dalla scheda del bambino', async () => {
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    // `nomiStudenti` dice «Sezione Vecchia» (la scheda, già spostata sulla classe nuova); la riga dice S_DA, «Sezione Partenza».
    expect(screen.queryAllByText('Da: Sezione Partenza').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Da: Sezione Vecchia')).toHaveLength(0)
  })
})

describe('PassaggioClient · giro di correzione 3', () => {
  it('NS1 · la colonna «Da» legge la classe di partenza dalle righe anche se l’elenco delle sezioni è quello dell’anno nuovo', async () => {
    s.scopedSenzaVecchia = true
    s.righe = [...RIGHE_BASE(), RIGA_DA_DECIDERE()]
    render(<PassaggioClient />)
    await screen.findByText('NomeUno CognomeUno')
    expect(screen.queryAllByText('Da: Sezione Partenza').length).toBeGreaterThan(1)
    expect(screen.queryAllByText(/Da: nessuna classe/i)).toHaveLength(0)
  })
})

describe('PassaggioClient · giro 3 · NS8', () => {
  it('NS8 · il dialogo dell’annullo dice «dal» il giorno della conferma se è dopo l’inizio dell’anno', async () => {
    s.passaggio = { id: PASS, stato: 'confermato', conteggi: {}, apribile_dal: '2027-06-01', inizio_anno_nuovo: '2027-07-01', confermato_il: '2027-07-05' }
    render(<PassaggioClient />)
    await screen.findByText('NomeDue CognomeDue')
    fireEvent.click(screen.getByRole('button', { name: itPassaggio.azioneAnnulla }))
    const dialogo = await screen.findByText(/Le schede sono già passate sulla classe nuova dal/)
    expect(dialogo.textContent).toContain('5 luglio 2027')
    expect(dialogo.textContent).not.toContain('1 luglio 2027')
  })
})

describe('PassaggioClient · S14', () => {
  it('su un «ritirato» con la classe già proposta c’è il pulsante «Continua in questa classe», che conferma quella classe', async () => {
    s.righe = [riga(AL1, 'continua', { sezione_a_id: S_A1, avviso: 'ritirato_tendina' }), ...RIGHE_BASE().slice(1)]
    render(<PassaggioClient />)
    await screen.findAllByText('NomeUno CognomeUno')
    const blocco = (await screen.findAllByRole('button', { name: itPassaggio.correggiContinuaQui }))[0]
    fireEvent.click(blocco)
    await waitFor(() => expect(chiamate('PUT', '/passaggio/righe')).toHaveLength(1))
    expect(corpoDi(chiamate('PUT', '/passaggio/righe')[0])).toEqual({ alunno_id: AL1, esito: 'continua', section_id: S_A1 })
  })
})
