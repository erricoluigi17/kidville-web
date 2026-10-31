import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import { CollegaAlunno } from '@/components/features/crm/schede/CollegaAlunno'
import type { BambinoDettaglioRow } from '@/lib/crm/tipi'

/**
 * CRM della segreteria · il collegamento del bambino all'alunno, dalla scheda (Compito 5).
 *
 * Stessa disciplina del file della quota: rete finta ma ESIGENTE (una chiamata senza rotta fa cadere il
 * test), catalogo letto da disco (una chiave inesistente lancia), si aspetta sempre la PRESENZA di
 * qualcosa. Dati di prova soltanto: «Bimbo Prova», «Alunno Prova».
 */

vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { IntlMessageFormat } = await import('intl-messageformat')
  const cartella = join(process.cwd(), 'messages/it')
  const catalogo: Record<string, unknown> = {}
  for (const file of readdirSync(cartella)) {
    if (file.endsWith('.json')) catalogo[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'))
  }
  const risolvi = (ns: string | undefined, chiave: string): string => {
    let v: unknown = ns ? catalogo[ns] : catalogo
    for (const pezzo of chiave.split('.')) v = (v as Record<string, unknown> | undefined)?.[pezzo]
    if (typeof v !== 'string') throw new Error(`Chiave di catalogo inesistente: ${ns ?? ''}.${chiave}`)
    return v
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => {
      const testo = risolvi(ns, chiave)
      return valori === undefined ? testo : String(new IntlMessageFormat(testo, 'it').format(valori))
    }
    return Object.assign(t, {
      rich: (chiave: string) => risolvi(ns, chiave),
      markup: (chiave: string) => risolvi(ns, chiave),
      raw: (chiave: string) => risolvi(ns, chiave),
      has: (chiave: string) => {
        try {
          risolvi(ns, chiave)
          return true
        } catch {
          return false
        }
      },
    })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const h = vi.hoisted(() => ({
  chiamate: [] as { url: string; metodo: string; corpo: unknown }[],
  rotte: [] as { metodo: string; contiene: string; risposta: () => Promise<Response> | Response }[],
  nonPreviste: [] as string[],
  logClient: vi.fn(),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}))

const SCHEDA = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'
const BAMBINO = '7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7d'
const ALUNNO = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'
const URL_ALUNNO = `/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/alunno`

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
      const corpo = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      h.chiamate.push({ url, metodo, corpo })
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
  // Una chiamata senza rotta è una schermata che parla con una route che il test non conosce.
  expect(h.nonPreviste).toEqual([])
})

const bambino = (extra: Partial<BambinoDettaglioRow> = {}): BambinoDettaglioRow => ({
  id: BAMBINO,
  scuola_id: SEDE_A,
  scheda_id: SCHEDA,
  nome: 'Bimbo Prova',
  data_nascita: '2024-03-05',
  anno_ingresso: 'prossimo',
  esito: 'aperto',
  motivo_perdita: null,
  motivo_nota: null,
  esito_origine: null,
  esito_da: null,
  esito_il: null,
  domanda_id: null,
  domanda_figlio: null,
  domanda_collegata_il: null,
  nota_collegamento: null,
  da_verificare: false,
  quota_importo: null,
  quota_metodo: null,
  quota_anno: null,
  quota_stato: null,
  quota_blocco_motivo: null,
  quota_saldata_il: null,
  quota_segnata_da: null,
  quota_cassa_movimento_id: null,
  quota_pagamento_id: null,
  alunno_id: null,
  alunno_collegato_il: null,
  creata_il: '2026-10-01T09:00:00.000Z',
  aggiornata_il: '2026-10-01T09:00:00.000Z',
  ...extra,
})

function monta(extra: Partial<BambinoDettaglioRow> = {}) {
  const onCambiata = vi.fn()
  render(<CollegaAlunno schedaId={SCHEDA} bambino={bambino(extra)} scuolaId={SEDE_A} onCambiata={onCambiata} />)
  return { onCambiata }
}

const alunno = (extra: Record<string, unknown> = {}) => ({ id: ALUNNO, nome: 'Alunno', cognome: 'Prova', data_nascita: '2024-03-05', ...extra })
const URL_RICERCA = '/api/admin/crm/alunni'

/** Apre la finestra, scrive il testo e preme «Cerca»; torna la finestra. */
async function cerca(testo: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Collega all’alunno' }))
  const dialogo = await screen.findByRole('dialog')
  fireEvent.change(within(dialogo).getByLabelText('Nome o cognome dell’alunno'), { target: { value: testo } })
  fireEvent.click(within(dialogo).getByRole('button', { name: 'Cerca' }))
  return dialogo
}

// ════════════════════════════════════════════════════════════════════════════════
describe('CollegaAlunno · il bambino non è collegato', () => {
  it('c’è solo il bottone: nessuna chiamata finché non si cerca', () => {
    monta()
    expect(screen.getByRole('button', { name: 'Collega all’alunno' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.chiamate).toEqual([])
  })

  it('cerca nella SEDE della scheda e mostra nome, cognome e nascita', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    monta()
    const dialogo = await cerca('  Prova ')

    // Si aspetta la PRESENZA della riga, poi si legge la chiamata.
    expect(await within(dialogo).findByText('Alunno Prova')).toBeTruthy()
    expect(dialogo.textContent).toContain('Nato il 05/03/2024')
    const richiesta = new URL(chiamate('GET', URL_RICERCA)[0].url, 'http://localhost')
    expect(richiesta.searchParams.get('scuolaId')).toBe(SEDE_A)
    expect(richiesta.searchParams.get('q')).toBe('Prova')
  })

  it('con un solo carattere «Cerca» è spento e non parte niente', async () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: 'Collega all’alunno' }))
    const dialogo = await screen.findByRole('dialog')
    fireEvent.change(within(dialogo).getByLabelText('Nome o cognome dell’alunno'), { target: { value: 'P' } })
    expect((within(dialogo).getByRole('button', { name: 'Cerca' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(within(dialogo).getByRole('search'))
    expect(h.chiamate).toEqual([])
  })

  it('nessun risultato: lo dice', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [] }))
    monta()
    const dialogo = await cerca('Nessuno')
    expect(await within(dialogo).findByText('Nessun alunno iscritto corrisponde alla ricerca.')).toBeTruthy()
  })

  it('la ricerca che fallisce si dice, con la frase del componente', async () => {
    rotta('GET', URL_RICERCA, json(500, { error: 'dettaglio interno', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }))
    monta()
    const dialogo = await cerca('Prova')
    const avviso = await within(dialogo).findByRole('alert')
    expect(avviso.textContent).not.toContain('dettaglio interno')
  })

  it('sceglie l’alunno: PUT con alunnoId, la finestra si chiude e la scheda si rilegge', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    rotta('PUT', URL_ALUNNO, json(200, { data: { collegato: true, passaggio: null } }))
    const { onCambiata } = monta()
    const dialogo = await cerca('Prova')

    fireEvent.click(await within(dialogo).findByRole('button', { name: 'Collega Alunno Prova' }))
    await waitFor(() => expect(chiamate('PUT', URL_ALUNNO)).toHaveLength(1))
    expect(chiamate('PUT', URL_ALUNNO)[0].corpo).toEqual({ alunnoId: ALUNNO })
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('un doppio clic su «Collega» manda un solo PUT', async () => {
    let sblocca: (r: Response) => void = () => undefined
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    rotta('PUT', URL_ALUNNO, () => new Promise<Response>((risolvi) => (sblocca = risolvi)))
    const { onCambiata } = monta()
    const dialogo = await cerca('Prova')

    const scegli = await within(dialogo).findByRole('button', { name: 'Collega Alunno Prova' })
    fireEvent.click(scegli)
    fireEvent.click(scegli)
    // Presenza: il bottone cambia testo mentre la richiesta è in volo.
    expect(await within(dialogo).findByText('Collego…')).toBeTruthy()
    expect(chiamate('PUT', URL_ALUNNO)).toHaveLength(1)

    sblocca(new Response(JSON.stringify({ data: { collegato: true, passaggio: null } }), { status: 200 }))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
    expect(chiamate('PUT', URL_ALUNNO)).toHaveLength(1)
  })

  it('409 ALUNNO_GIA_COLLEGATO: il messaggio del catalogo, la finestra resta aperta', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    rotta('PUT', URL_ALUNNO, json(409, { error: 'x', codice: 'ALUNNO_GIA_COLLEGATO' }))
    const { onCambiata } = monta()
    const dialogo = await cerca('Prova')

    fireEvent.click(await within(dialogo).findByRole('button', { name: 'Collega Alunno Prova' }))
    const avviso = await within(dialogo).findByRole('alert')
    expect(avviso.textContent).toBe('Il bambino o l’alunno scelto sono già collegati: togli prima il collegamento esistente.')
    expect(onCambiata).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('422 ALUNNO_NON_DELLA_SEDE: il messaggio del catalogo', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    rotta('PUT', URL_ALUNNO, json(422, { error: 'x', codice: 'ALUNNO_NON_DELLA_SEDE' }))
    monta()
    const dialogo = await cerca('Prova')
    fireEvent.click(await within(dialogo).findByRole('button', { name: 'Collega Alunno Prova' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toBe('L’alunno scelto non fa parte di questa sede.')
  })

  it('chiudere la finestra non chiama niente', async () => {
    rotta('GET', URL_RICERCA, json(200, { data: [alunno()] }))
    monta()
    const dialogo = await cerca('Prova')
    await within(dialogo).findByText('Alunno Prova')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(chiamate('PUT')).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('CollegaAlunno · il bambino è già collegato', () => {
  it('dice che è collegato e offre «Scollega», ma chiede conferma prima di togliere', async () => {
    rotta('DELETE', URL_ALUNNO, json(200, { data: { scollegato: true } }))
    const { onCambiata } = monta({ alunno_id: ALUNNO, alunno_collegato_il: '2026-10-20T09:00:00.000Z' })

    expect(screen.getByText('Collegato a un alunno dell’anagrafica')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Collega all’alunno' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Scollega l’alunno' }))
    // Un clic distratto non basta: prima la domanda, e ancora nessuna chiamata.
    expect(screen.getByText('Togliere il collegamento all’alunno?')).toBeTruthy()
    expect(h.chiamate).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Sì, scollega' }))
    await waitFor(() => expect(chiamate('DELETE', URL_ALUNNO)).toHaveLength(1))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('«Annulla» richiude la domanda senza chiamare la rete', () => {
    monta({ alunno_id: ALUNNO })
    fireEvent.click(screen.getByRole('button', { name: 'Scollega l’alunno' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(screen.getByRole('button', { name: 'Scollega l’alunno' })).toBeTruthy()
    expect(h.chiamate).toEqual([])
  })

  it('con la quota già in contabilità il collegamento non si toglie più: niente bottone, e il perché', () => {
    monta({ alunno_id: ALUNNO, quota_stato: 'in_contabilita', quota_pagamento_id: 'pagamento-1' })
    expect(screen.getByText('Collegato a un alunno dell’anagrafica')).toBeTruthy()
    expect(screen.getByText('La quota è in contabilità: il collegamento non si toglie più.')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('409 QUOTA_GIA_IN_CONTABILITA allo scollegamento: il messaggio del catalogo, nessuna rilettura', async () => {
    rotta('DELETE', URL_ALUNNO, json(409, { error: 'x', codice: 'QUOTA_GIA_IN_CONTABILITA' }))
    const { onCambiata } = monta({ alunno_id: ALUNNO })
    fireEvent.click(screen.getByRole('button', { name: 'Scollega l’alunno' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, scollega' }))
    expect((await screen.findByRole('alert')).textContent).toBe('La quota è già in contabilità: si corregge da lì.')
    expect(onCambiata).not.toHaveBeenCalled()
  })
})
