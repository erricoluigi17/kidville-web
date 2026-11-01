import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { NOME_SEDE_A, NOME_SEDE_B, SEDE_A, SEDE_B } from '../fixtures/sedi'
import { QuoteCrmPanel } from '@/components/features/admin/pagamenti/QuoteCrmPanel'
import type { QuotaInAttesa } from '@/lib/crm/tipi'

/**
 * Contabilità · la lista «Quote dal CRM» (Compito 6 del piano «quota e disponibilità»).
 *
 * La rete è finta ma ESIGENTE: ogni chiamata ha bisogno di una rotta preparata, e una chiamata che non ne ha
 * fa cadere il test (`afterEach`). Un finto che risponde sempre «ok» sarebbe verde anche con un pannello che
 * non chiama niente. Il catalogo è quello VERO (`messages/it`, via il mock globale di next-intl): i testi che
 * si cercano sono quelli che la segreteria leggerà.
 *
 * Si aspetta sempre la PRESENZA di qualcosa (un `waitFor` su un'assenza passa prima che i dati arrivino).
 * Dati di prova soltanto: «Bimbo Prova».
 */

const h = vi.hoisted(() => ({
  chiamate: [] as { url: string; metodo: string }[],
  rotte: [] as { metodo: string; contiene: string; risposta: () => Promise<Response> | Response }[],
  nonPreviste: [] as string[],
  logClient: vi.fn(),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
    ],
    effettive: [SEDE_A, SEDE_B],
  }),
}))

const SCHEDA = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'
const SCHEDA_2 = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5d'
const BAMBINO = '7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7d'
const BAMBINO_2 = '7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7e'
const URL_RIPROVA = (scheda: string, bambino: string) => `/api/admin/crm/schede/${scheda}/bambini/${bambino}/quota/riprova`

const json = (stato: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } })

/** Prepara una risposta per la chiamata `metodo` il cui indirizzo CONTIENE `contiene`. L'ultima preparata vince. */
function rotta(metodo: string, contiene: string, risposta: () => Promise<Response> | Response) {
  h.rotte.push({ metodo, contiene, risposta })
}
const chiamate = (metodo: string, contiene = '') => h.chiamate.filter((c) => c.metodo === metodo && c.url.includes(contiene))

beforeEach(() => {
  h.chiamate.length = 0
  h.rotte.length = 0
  h.nonPreviste.length = 0
  h.logClient.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const metodo = (init?.method ?? 'GET').toUpperCase()
      h.chiamate.push({ url, metodo })
      for (let k = h.rotte.length - 1; k >= 0; k--) {
        if (h.rotte[k].metodo === metodo && url.includes(h.rotte[k].contiene)) return h.rotte[k].risposta()
      }
      h.nonPreviste.push(`${metodo} ${url}`)
      return new Response('{}', { status: 599 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Una chiamata senza rotta è un pannello che parla con una route che il test non conosce.
  expect(h.nonPreviste).toEqual([])
})

const quota = (extra: Partial<QuotaInAttesa> = {}): QuotaInAttesa => ({
  bambinoId: BAMBINO,
  schedaId: SCHEDA,
  scuolaId: SEDE_A,
  nome: 'Bimbo Prova',
  anno: 2027,
  importo: 150,
  metodo: 'contanti',
  giorno: '2026-10-28',
  giorniAttesa: 3,
  stato: 'in_attesa',
  motivo: null,
  alunnoCollegato: false,
  ...extra,
})

const elenco = (...righe: QuotaInAttesa[]) => json(200, { data: righe })

/** Risposte in fila: la prima chiamata prende la prima, le successive l'ultima. Per «prima / dopo il Riprova». */
const sequenza = (...risposte: (() => Promise<Response> | Response)[]) => {
  let i = 0
  return () => risposte[Math.min(i++, risposte.length - 1)]()
}

const monta = (scuolaId: string | null = SEDE_A) => render(<QuoteCrmPanel userId="utente-prova" scuolaId={scuolaId} />)

const RISERVATO = 'Riservato alla segreteria'
const NON_DISPONIBILE = 'Il CRM non è disponibile su questo ambiente'
const VUOTO = 'Nessuna quota in attesa'

describe('QuoteCrmPanel · le tre schermate che non sono la lista', () => {
  it('lista vuota: «Nessuna quota in attesa»', async () => {
    rotta('GET', '/api/admin/crm/quote', elenco())
    monta()
    expect(await screen.findByText(VUOTO)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('403: «Riservato alla segreteria»', async () => {
    rotta('GET', '/api/admin/crm/quote', json(403, { error: 'Accesso negato' }))
    monta()
    expect(await screen.findByText(RISERVATO)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('403 per la sede (SEDE_NON_ACCESSIBILE): dice della sede, non «riservato»', async () => {
    rotta('GET', '/api/admin/crm/quote', json(403, { error: 'Sede non accessibile', codice: 'SEDE_NON_ACCESSIBILE' }))
    monta()
    expect(await screen.findByText('Sede non accessibile')).toBeTruthy()
    expect(screen.queryByText(RISERVATO)).toBeNull()
  })

  it('503: «Il CRM non è disponibile su questo ambiente»', async () => {
    rotta('GET', '/api/admin/crm/quote', json(503, { error: 'x', codice: 'CRM_NON_INSTALLATO' }))
    monta()
    expect(await screen.findByText(NON_DISPONIBILE)).toBeTruthy()
  })

  it('un guasto del server: lo dice e offre «Riprova», che rilegge la lista', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      sequenza(json(500, { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }), elenco(quota())),
    )
    monta()
    expect(await screen.findByText('Non è stato possibile leggere le quote dal CRM.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))

    expect(await screen.findByRole('link', { name: 'Bimbo Prova' })).toBeTruthy()
    expect(chiamate('GET', '/api/admin/crm/quote')).toHaveLength(2)
    // Un 5xx lascia traccia nel log del browser (solo lo stato), e il testo del server non si mostra.
    expect(h.logClient).toHaveBeenCalled()
  })

  it('rete caduta: lo stesso messaggio di guasto, e una riga nel log del browser', async () => {
    rotta('GET', '/api/admin/crm/quote', () => {
      throw new TypeError('Failed to fetch')
    })
    monta()
    expect(await screen.findByText('Non è stato possibile leggere le quote dal CRM.')).toBeTruthy()
    expect(h.logClient).toHaveBeenCalled()
  })
})

describe('QuoteCrmPanel · la lista', () => {
  it('mostra il motivo tradotto di una quota bloccata', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(quota({ stato: 'bloccata', motivo: 'gia_pagata', alunnoCollegato: true, metodo: 'carta' })),
    )
    monta()

    // Lo stesso testo che la segreteria legge nella scheda del bambino: un solo catalogo per il motivo.
    expect(
      await screen.findByText(
        'Per quest’anno questo alunno ha già una quota d’iscrizione pagata. Se è lo stesso pagamento, confermalo; altrimenti si risolve in contabilità.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Bloccata')).toBeTruthy()
  })

  it('ogni motivo di blocco ha il suo testo (nessuna chiave fuori catalogo, nessuna riga senza spiegazione)', async () => {
    const motivi = ['gia_pagata', 'supera_residuo', 'piu_voci', 'entrata_stornata'] as const
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(
        ...motivi.map((motivo, i) =>
          quota({ bambinoId: `7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d0${i}`, stato: 'bloccata', motivo, alunnoCollegato: true }),
        ),
      ),
    )
    monta()
    await screen.findAllByText('Bloccata')
    const tabella = screen.getByRole('table')
    // Quattro righe di dati più l'intestazione: ognuna con un testo di motivo (nessuno è il nome della chiave).
    expect(within(tabella).getAllByRole('row')).toHaveLength(5)
    expect(tabella.textContent).not.toMatch(/adminContabilita\.|crmSchede\./)
  })

  it('una riga per quota, con anno, importo, metodo, giorno e giorni di attesa', async () => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota()))
    monta()

    const link = await screen.findByRole('link', { name: 'Bimbo Prova' })
    const riga = link.closest('tr') as HTMLElement
    const testo = riga.textContent ?? ''
    expect(testo).toContain('2027/28')
    expect(testo).toContain('€ 150,00')
    expect(testo).toContain('Contanti')
    expect(testo).toContain('28/10/2026')
    expect(testo).toContain('3 giorni')
    expect(testo).toContain('In attesa dell’alunno')
  })

  it('il bambino è un collegamento alla sua scheda del CRM (/admin/crm?scheda=…)', async () => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota()))
    monta()
    const link = await screen.findByRole('link', { name: 'Bimbo Prova' })
    expect(link.getAttribute('href')).toBe(`/admin/crm?scheda=${SCHEDA}`)
  })

  it('la vecchia spunta (senza importo, metodo, anno) mostra i trattini e non inventa niente; il nome nullo ha il suo testo', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(quota({ nome: null, stato: 'senza_importo', importo: null, metodo: null, anno: null, giorno: null, giorniAttesa: null })),
    )
    monta()
    const link = await screen.findByRole('link', { name: 'Bambino senza nome' })
    const riga = link.closest('tr') as HTMLElement
    expect(within(riga).getAllByText('—').length).toBeGreaterThanOrEqual(4)
    expect(riga.textContent).toContain('Quota segnata senza importo')
    expect(within(riga).queryByRole('button')).toBeNull()
  })

  it('zero giorni: «oggi»; un giorno: «1 giorno»', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(
        quota({ giorniAttesa: 0 }),
        quota({ bambinoId: BAMBINO_2, schedaId: SCHEDA_2, nome: 'Bimbo Seconda', giorniAttesa: 1 }),
      ),
    )
    monta()
    const prima = ((await screen.findByRole('link', { name: 'Bimbo Prova' })).closest('tr') as HTMLElement).textContent
    const seconda = ((await screen.findByRole('link', { name: 'Bimbo Seconda' })).closest('tr') as HTMLElement).textContent
    expect(prima).toContain('oggi')
    expect(seconda).toContain('1 giorno')
  })

  it('con una sede sola la richiesta la dichiara e non c’è la colonna «Sede»', async () => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota()))
    monta(SEDE_A)
    await screen.findByRole('link', { name: 'Bimbo Prova' })
    expect(chiamate('GET', '/api/admin/crm/quote')[0].url).toBe(`/api/admin/crm/quote?scuolaId=${SEDE_A}`)
    expect(screen.queryByRole('columnheader', { name: 'Sede' })).toBeNull()
  })

  it('con più sedi (scuolaId nullo) la richiesta NON porta scuolaId, e ogni riga dice la sua sede', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(quota(), quota({ bambinoId: BAMBINO_2, schedaId: SCHEDA_2, scuolaId: SEDE_B, nome: 'Bimbo Seconda' })),
    )
    monta(null)
    await screen.findByRole('link', { name: 'Bimbo Seconda' })
    expect(chiamate('GET', '/api/admin/crm/quote')[0].url).toBe('/api/admin/crm/quote')
    expect(screen.getByRole('columnheader', { name: 'Sede' })).toBeTruthy()
    const rigaA = (screen.getByRole('link', { name: 'Bimbo Prova' }).closest('tr') as HTMLElement).textContent
    const rigaB = (screen.getByRole('link', { name: 'Bimbo Seconda' }).closest('tr') as HTMLElement).textContent
    expect(rigaA).toContain(NOME_SEDE_A)
    expect(rigaB).toContain(NOME_SEDE_B)
  })
})

describe('QuoteCrmPanel · «Riprova»', () => {
  const RIPROVA = 'Riprova per Bimbo Prova'

  it('c’è solo per le righe con l’alunno già collegato', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(quota(), quota({ bambinoId: BAMBINO_2, schedaId: SCHEDA_2, nome: 'Bimbo Collegato', alunnoCollegato: true })),
    )
    monta()
    await screen.findByRole('link', { name: 'Bimbo Collegato' })
    expect(screen.queryByRole('button', { name: RIPROVA })).toBeNull()
    expect(screen.getByRole('button', { name: 'Riprova per Bimbo Collegato' })).toBeTruthy()
    // Chi non è ancora collegato dice di cosa aspetta, invece di offrire un tasto che non può funzionare.
    const riga = screen.getByRole('link', { name: 'Bimbo Prova' }).closest('tr') as HTMLElement
    expect(riga.textContent).toContain('In attesa dell’alunno')
  })

  it('non c’è per una riga «senza importo», anche se l’alunno è collegato; per «in attesa» collegata sì', async () => {
    // Il collegamento all'alunno non dipende dallo stato: la vecchia spunta può averlo. Ma per `senza_importo`
    // la funzione SQL risponde `non_pronta` (manca l'importo, non l'alunno): il tasto porterebbe a un messaggio falso.
    rotta(
      'GET',
      '/api/admin/crm/quote',
      elenco(
        quota({ bambinoId: BAMBINO, schedaId: SCHEDA, nome: 'Bimbo Prova', stato: 'senza_importo', importo: null, alunnoCollegato: true }),
        quota({ bambinoId: BAMBINO_2, schedaId: SCHEDA_2, nome: 'Bimbo Collegato', stato: 'in_attesa', alunnoCollegato: true }),
      ),
    )
    monta()
    // Si aspetta la PRESENZA di entrambe le righe e del tasto dell'altra: solo allora l'assenza vale qualcosa.
    await screen.findByRole('link', { name: 'Bimbo Prova' })
    expect(await screen.findByRole('button', { name: 'Riprova per Bimbo Collegato' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: RIPROVA })).toBeNull()
    const riga = screen.getByRole('link', { name: 'Bimbo Prova' }).closest('tr') as HTMLElement
    expect(riga.textContent).toContain('Quota segnata senza importo')
  })

  it('chiama la route del bambino e ricarica la lista: la quota passata in contabilità sparisce', async () => {
    // La lista riletta dopo il «Riprova» è vuota: il passaggio è riuscito.
    rotta('GET', '/api/admin/crm/quote', sequenza(elenco(quota({ alunnoCollegato: true })), elenco()))
    rotta('POST', URL_RIPROVA(SCHEDA, BAMBINO), json(200, { data: { esito: 'ok', pagamentoId: 'p-1', incassoId: null, voceNuova: true } }))
    monta()

    fireEvent.click(await screen.findByRole('button', { name: RIPROVA }))

    expect(await screen.findByText(VUOTO)).toBeTruthy()
    expect(screen.getByText('La quota è passata in contabilità.')).toBeTruthy()
    expect(chiamate('POST', URL_RIPROVA(SCHEDA, BAMBINO))).toHaveLength(1)
    expect(chiamate('GET', '/api/admin/crm/quote')).toHaveLength(2)
  })

  it('«bloccata»: ricarica la lista (il motivo può essere cambiato) senza dire che è passata', async () => {
    rotta(
      'GET',
      '/api/admin/crm/quote',
      sequenza(
        elenco(quota({ alunnoCollegato: true })),
        elenco(quota({ alunnoCollegato: true, stato: 'bloccata', motivo: 'piu_voci' })),
      ),
    )
    rotta('POST', URL_RIPROVA(SCHEDA, BAMBINO), json(200, { data: { esito: 'bloccata', motivo: 'piu_voci' } }))
    monta()

    fireEvent.click(await screen.findByRole('button', { name: RIPROVA }))

    expect(await screen.findByText('Bloccata')).toBeTruthy()
    expect(screen.queryByText('La quota è passata in contabilità.')).toBeNull()
    expect(chiamate('GET', '/api/admin/crm/quote')).toHaveLength(2)
  })

  it.each([
    ['non_pronta', 'Il bambino non è ancora collegato a un alunno: il passaggio non può partire.'],
    ['sede_diversa', 'L’alunno collegato è di un’altra sede: la quota non può passare in contabilità.'],
    ['categoria_assente', 'Manca la categoria di pagamento «Iscrizione» in contabilità: la quota non può passare.'],
    // 01/11: la voce eliminata dallo scadenzario era un 500, ora è un esito che si sa dire.
    ['voce_eliminata', 'La voce «Iscrizione» nata da questa quota è stata eliminata dalla contabilità. La scheda non la rimette da sola: per ora si sistema in contabilità.'],
  ])('«%s»: lo dice con parole sue, e la riga resta', async (esito, frase) => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota({ alunnoCollegato: true })))
    rotta('POST', URL_RIPROVA(SCHEDA, BAMBINO), json(200, { data: { esito } }))
    monta()

    fireEvent.click(await screen.findByRole('button', { name: RIPROVA }))

    expect(await screen.findByText(frase)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Bimbo Prova' })).toBeTruthy()
  })

  it.each([
    [500, { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }],
    [503, { error: 'x', codice: 'CRM_NON_INSTALLATO' }],
    [404, { error: 'x', codice: 'SCHEDA_NON_TROVATA' }],
  ])('un rifiuto %s: un messaggio, mai il testo del server; la lista resta quella di prima', async (stato, corpo) => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota({ alunnoCollegato: true })))
    rotta('POST', URL_RIPROVA(SCHEDA, BAMBINO), json(stato, corpo))
    monta()

    fireEvent.click(await screen.findByRole('button', { name: RIPROVA }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent?.length).toBeGreaterThan(0)
    expect(avviso.textContent).not.toBe('x')
    expect(screen.getByRole('link', { name: 'Bimbo Prova' })).toBeTruthy()
  })

  it('un esito che non si riconosce non passa per un successo', async () => {
    rotta('GET', '/api/admin/crm/quote', elenco(quota({ alunnoCollegato: true })))
    rotta('POST', URL_RIPROVA(SCHEDA, BAMBINO), json(200, { data: { esito: 'qualcosa-di-nuovo' } }))
    monta()

    fireEvent.click(await screen.findByRole('button', { name: RIPROVA }))

    expect(await screen.findByText('Non è stato possibile aggiornare la quota.')).toBeTruthy()
    expect(screen.queryByText('La quota è passata in contabilità.')).toBeNull()
  })

  it('doppio clic: la richiesta parte una volta sola, e il bottone si spegne mentre è in volo', async () => {
    let sblocca: (r: Response) => void = () => {}
    rotta('GET', '/api/admin/crm/quote', sequenza(elenco(quota({ alunnoCollegato: true })), elenco()))
    rotta(
      'POST',
      URL_RIPROVA(SCHEDA, BAMBINO),
      () => new Promise<Response>((risolvi) => (sblocca = risolvi)),
    )
    monta()

    const bottone = (await screen.findByRole('button', { name: RIPROVA })) as HTMLButtonElement
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    await waitFor(() => expect(chiamate('POST', URL_RIPROVA(SCHEDA, BAMBINO))).toHaveLength(1))
    expect((screen.getByRole('button', { name: RIPROVA }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Riprovo…')).toBeTruthy()

    sblocca(new Response(JSON.stringify({ data: { esito: 'gia_in_contabilita', pagamentoId: 'p-1' } }), { status: 200 }))
    expect(await screen.findByText(VUOTO)).toBeTruthy()
    expect(chiamate('POST', URL_RIPROVA(SCHEDA, BAMBINO))).toHaveLength(1)
  })
})
