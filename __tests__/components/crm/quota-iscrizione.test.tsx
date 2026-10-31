import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import { QuotaIscrizione } from '@/components/features/crm/schede/QuotaIscrizione'
import { annoDellaQuota, etichettaAnno } from '@/lib/crm/quota-anno'
import { importoDaTesto, importoLeggibile, importoPerCampo } from '@/components/features/crm/schede/quota-importo'
import type { BambinoDettaglioRow } from '@/lib/crm/tipi'

/**
 * CRM della segreteria · la quota d'iscrizione nella scheda (Compito 5).
 *
 * La rete è finta ma ESIGENTE: ogni chiamata ha bisogno di una rotta preparata, e una chiamata che non ne
 * ha fa cadere il test (`afterEach`). Un finto che risponde sempre «ok» sarebbe verde anche con un
 * componente che non chiama niente.
 *
 * ── Il catalogo si legge da disco, e una chiave che non c'è fa cadere il test ──────────────────
 * Il mock globale di next-intl ripiega sul NOME della chiave: ogni asserzione sul testo sarebbe verde su
 * una stringa che nessuno leggerà. Qui il mock risolve anche le chiavi annidate e LANCIA su quelle che non
 * esistono.
 *
 * Si aspetta sempre la PRESENZA di qualcosa (un `waitFor` su un'assenza passa prima che i dati arrivino).
 * Dati di prova soltanto: «Bimbo Prova».
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
const URL_QUOTA = `/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/quota`

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
  render(<QuotaIscrizione schedaId={SCHEDA} bambino={bambino(extra)} onCambiata={onCambiata} />)
  return { onCambiata }
}

const SEGNA = 'Segna la quota d’iscrizione'
const IMPORTO_NON_VALIDO = 'Scrivi un importo maggiore di zero, con al massimo due decimali (per esempio 150,50).'
const apriModulo = () => fireEvent.click(screen.getByRole('button', { name: SEGNA }))
const scrivi = (etichetta: string, valore: string) => fireEvent.change(screen.getByLabelText(etichetta), { target: { value: valore } })
const conferma = () => screen.getByRole('button', { name: 'Segna la quota' }) as HTMLButtonElement

// L'anno atteso si calcola con la stessa funzione del componente: il test non dipende dal giorno in cui gira.
const ANNO_PROSSIMO = etichettaAnno(annoDellaQuota('prossimo') as number)

// Oggi a Roma, calcolato qui in modo INDIPENDENTE dal componente (non con la sua `dataCivile`): se il campo
// partisse da un altro giorno, il test se ne accorgerebbe.
const OGGI_ISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date())
const OGGI_IT = OGGI_ISO.split('-').reverse().join('/')
const GIORNO = 'Giorno del pagamento'
const GIORNO_NON_VALIDO = 'Indica un giorno valido'

// ════════════════════════════════════════════════════════════════════════════════
describe('QuotaIscrizione · segnare la quota', () => {
  it('nessuna quota: c’è solo il bottone, e non parte nessuna chiamata', () => {
    monta()
    expect(screen.getByRole('button', { name: SEGNA })).toBeTruthy()
    expect(screen.queryByLabelText('Importo (€)')).toBeNull()
    expect(h.chiamate).toEqual([])
  })

  it('con «150,50» manda importo 150.5 e metodo contanti', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    const { onCambiata } = monta()

    apriModulo()
    // L'anno si legge, non si sceglie: viene dall'anno di ingresso del bambino.
    expect(screen.getByText(`Anno scolastico ${ANNO_PROSSIMO}`)).toBeTruthy()
    scrivi('Importo (€)', '150,50')
    fireEvent.click(conferma())

    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    // Il giorno parte SEMPRE: qui non l'abbiamo toccato, ed è quello che il campo proponeva (oggi a Roma).
    expect(chiamate('PUT', URL_QUOTA)[0].corpo).toEqual({ importo: 150.5, giorno: OGGI_ISO, metodo: 'contanti' })
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('all’apertura il campo del giorno vale oggi, e salvando senza toccarlo il corpo porta giorno = oggi', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    monta()

    apriModulo()
    expect((screen.getByLabelText(GIORNO) as HTMLInputElement).value).toBe(OGGI_IT)
    expect(screen.queryByText(GIORNO_NON_VALIDO)).toBeNull()
    scrivi('Importo (€)', '150')
    expect(conferma().disabled).toBe(false)
    fireEvent.click(conferma())

    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect((chiamate('PUT', URL_QUOTA)[0].corpo as { giorno?: string }).giorno).toBe(OGGI_ISO)
  })

  it.each([
    ['una data digitata a metà', '15/10/20'],
    ['un carattere cancellato', '15/10/202'],
    ['il campo svuotato', ''],
    ['una data inesistente', '31/02/2026'],
  ])('%s: «Salva» è spento, c’è «Indica un giorno valido» e non parte nessuna fetch', (_nome, digitato) => {
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    scrivi(GIORNO, digitato)

    // Presenza del messaggio (non un'assenza): il bottone spento e il testo del catalogo.
    expect(screen.getByText(GIORNO_NON_VALIDO)).toBeTruthy()
    expect(conferma().disabled).toBe(true)
    // Anche forzando l'invio del modulo non parte niente: il contante non finisce nella cassa di oggi.
    fireEvent.click(conferma())
    fireEvent.submit(screen.getByRole('form', { name: 'Quota d’iscrizione' }))
    expect(h.chiamate).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('riscrivere il giorno per intero riaccende «Salva» e toglie l’avviso', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    scrivi(GIORNO, '15/10/20')
    expect(screen.getByText(GIORNO_NON_VALIDO)).toBeTruthy()

    scrivi(GIORNO, '15/10/2026')
    expect(screen.queryByText(GIORNO_NON_VALIDO)).toBeNull()
    expect(conferma().disabled).toBe(false)
    fireEvent.click(conferma())
    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect(chiamate('PUT', URL_QUOTA)[0].corpo).toEqual({ importo: 150, giorno: '2026-10-15', metodo: 'contanti' })
  })

  it('il giorno e il metodo scelti partono nel corpo', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    monta()

    apriModulo()
    scrivi('Importo (€)', '99')
    scrivi('Giorno del pagamento', '20/10/2026')
    scrivi('Come ha pagato', 'carta')
    fireEvent.click(conferma())

    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect(chiamate('PUT', URL_QUOTA)[0].corpo).toEqual({ importo: 99, giorno: '2026-10-20', metodo: 'carta' })
  })

  it('rifiuta «150,555», «0» e il resto senza chiamare la rete', () => {
    monta()
    apriModulo()
    for (const valore of ['150,555', '0', '0,00', '-5', 'abc', '1.500,00', '100000,01']) {
      scrivi('Importo (€)', valore)
      // Il motivo del rifiuto si vede (presenza), il bottone resta spento…
      expect(screen.getByText(IMPORTO_NON_VALIDO)).toBeTruthy()
      expect(conferma().disabled).toBe(true)
      // …e anche forzando l'invio del modulo non parte niente.
      fireEvent.submit(screen.getByRole('form', { name: 'Quota d’iscrizione' }))
    }
    expect(h.chiamate).toEqual([])
  })

  it('accetta anche il punto e un solo decimale («150.5»)', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    monta()
    apriModulo()
    scrivi('Importo (€)', '150.5')
    fireEvent.click(conferma())
    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect((chiamate('PUT', URL_QUOTA)[0].corpo as { importo: number }).importo).toBe(150.5)
  })

  it('un giorno nel futuro non parte: lo dice il messaggio del catalogo', () => {
    monta()
    apriModulo()
    scrivi('Importo (€)', '100')
    scrivi('Giorno del pagamento', '31/12/2099')
    expect(screen.getByText('Il giorno del pagamento non può essere nel futuro.')).toBeTruthy()
    expect(conferma().disabled).toBe(true)
    fireEvent.submit(screen.getByRole('form', { name: 'Quota d’iscrizione' }))
    expect(h.chiamate).toEqual([])
  })

  it('anno di ingresso non indicato: bottone spento e messaggio', () => {
    monta({ anno_ingresso: 'non_indicato' })
    apriModulo()
    scrivi('Importo (€)', '150')
    expect(screen.getByText('Indica prima l’anno di ingresso')).toBeTruthy()
    expect(conferma().disabled).toBe(true)
    fireEvent.submit(screen.getByRole('form', { name: 'Quota d’iscrizione' }))
    expect(h.chiamate).toEqual([])
  })

  it('mentre l’invio è in volo il bottone è disabilitato (un secondo clic non parte)', async () => {
    let sblocca: (r: Response) => void = () => undefined
    rotta('PUT', URL_QUOTA, () => new Promise<Response>((risolvi) => (sblocca = risolvi)))
    const { onCambiata } = monta()

    apriModulo()
    scrivi('Importo (€)', '150')
    const bottone = conferma()
    fireEvent.click(bottone)
    fireEvent.click(bottone)
    // Il modulo, rimandato mentre la richiesta è ancora in volo, nemmeno lui parte.
    fireEvent.submit(screen.getByRole('form', { name: 'Quota d’iscrizione' }))

    // Presenza: il bottone cambia testo e si spegne. Poi si conta la rete.
    const inVolo = (await screen.findByRole('button', { name: 'Salvo…' })) as HTMLButtonElement
    expect(inVolo.disabled).toBe(true)
    expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1)

    sblocca(new Response(JSON.stringify({ data: { stato: 'in_attesa', passaggio: null } }), { status: 200 }))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
    expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1)
  })

  it('409 QUOTA_CASSA_CHIUSA mette oggi nel campo del giorno', async () => {
    rotta(
      'PUT',
      URL_QUOTA,
      json(409, {
        error: 'La cassa di quel giorno è già chiusa.',
        codice: 'QUOTA_CASSA_CHIUSA',
        giornoProposto: '2026-10-31',
      }),
    )
    const { onCambiata } = monta()

    apriModulo()
    scrivi('Importo (€)', '150')
    scrivi('Giorno del pagamento', '05/01/2026')
    fireEvent.click(conferma())

    // Si aspetta il messaggio (presenza) e poi si legge il campo.
    expect((await screen.findByRole('alert')).textContent).toContain('La cassa di quel giorno è già chiusa.')
    expect((screen.getByLabelText('Giorno del pagamento') as HTMLInputElement).value).toBe('31/10/2026')
    // Il modulo resta aperto, con l'importo che si era scritto, e la scheda non si rilegge.
    expect((screen.getByLabelText('Importo (€)') as HTMLInputElement).value).toBe('150')
    expect(onCambiata).not.toHaveBeenCalled()
  })

  it('409 QUOTA_CASSA_CHIUSA senza giorno proposto: il campo prende comunque il giorno di oggi', async () => {
    rotta('PUT', URL_QUOTA, json(409, { error: 'x', codice: 'QUOTA_CASSA_CHIUSA' }))
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    scrivi('Giorno del pagamento', '05/01/2026')
    fireEvent.click(conferma())

    await screen.findByRole('alert')
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()).split('-')
    expect((screen.getByLabelText('Giorno del pagamento') as HTMLInputElement).value).toBe(`${oggi[2]}/${oggi[1]}/${oggi[0]}`)
  })

  it('422 QUOTA_ANNO_MANCANTE: il messaggio del catalogo, il modulo resta aperto', async () => {
    rotta('PUT', URL_QUOTA, json(422, { error: 'x', codice: 'QUOTA_ANNO_MANCANTE' }))
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    fireEvent.click(conferma())
    expect((await screen.findByRole('alert')).textContent).toBe('Indica l’anno di ingresso del bambino prima di segnare la quota.')
  })

  it('un guasto del server si dice con la frase del componente, mai col testo del server', async () => {
    rotta('PUT', URL_QUOTA, json(500, { error: 'dettaglio interno del database', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }))
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    fireEvent.click(conferma())
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).not.toContain('dettaglio interno')
    expect(avviso.textContent?.length).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('QuotaIscrizione · gli stati', () => {
  it('senza importo (la vecchia spunta): lo dice, e si completa dal modulo', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    monta({ quota_stato: 'senza_importo', quota_saldata_il: '2026-09-10' })

    expect(screen.getByText('Quota segnata senza importo')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Completa la quota' }))
    // Il giorno della vecchia spunta è già nel campo.
    expect((screen.getByLabelText('Giorno del pagamento') as HTMLInputElement).value).toBe('10/09/2026')
    scrivi('Importo (€)', '120')
    fireEvent.click(conferma())
    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect(chiamate('PUT', URL_QUOTA)[0].corpo).toEqual({ importo: 120, giorno: '2026-09-10', metodo: 'contanti' })
  })

  it('in attesa, senza alunno: importo, metodo, giorno, anno e «in attesa dell’alunno»', () => {
    monta({
      quota_stato: 'in_attesa',
      quota_importo: '150.50',
      quota_metodo: 'carta',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
    })
    expect(screen.getByText('150,50 € · Carta (POS) · 20/10/2026')).toBeTruthy()
    expect(screen.getByText('Anno scolastico 2027/28')).toBeTruthy()
    expect(screen.getByText('In attesa dell’alunno')).toBeTruthy()
    // Senza alunno non c'è niente da riprovare.
    expect(screen.queryByRole('button', { name: 'Riprova' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Correggi' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Togli la quota' })).toBeTruthy()
  })

  it('in attesa, con l’alunno: «in attesa del passaggio in contabilità» e Riprova', () => {
    monta({ quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-20', alunno_id: ALUNNO })
    expect(screen.getByText('In attesa del passaggio in contabilità')).toBeTruthy()
    expect(screen.queryByText('In attesa dell’alunno')).toBeNull()
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy()
  })

  it('correggere: il modulo parte dai valori della quota e manda il PUT', async () => {
    rotta('PUT', URL_QUOTA, json(200, { data: { stato: 'in_attesa', passaggio: null } }))
    const { onCambiata } = monta({
      quota_stato: 'in_attesa',
      quota_importo: '150.50',
      quota_metodo: 'bonifico',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Correggi' }))
    expect((screen.getByLabelText('Importo (€)') as HTMLInputElement).value).toBe('150,50')
    expect((screen.getByLabelText('Come ha pagato') as HTMLSelectElement).value).toBe('bonifico')
    scrivi('Importo (€)', '160')
    fireEvent.click(screen.getByRole('button', { name: 'Salva la correzione' }))

    await waitFor(() => expect(chiamate('PUT', URL_QUOTA)).toHaveLength(1))
    expect(chiamate('PUT', URL_QUOTA)[0].corpo).toEqual({ importo: 160, giorno: '2026-10-20', metodo: 'bonifico' })
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('togliere la quota: DELETE, poi la scheda si rilegge', async () => {
    rotta('DELETE', URL_QUOTA, json(200, { data: { stornato: true } }))
    const { onCambiata } = monta({ quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-20' })
    fireEvent.click(screen.getByRole('button', { name: 'Togli la quota' }))
    await waitFor(() => expect(chiamate('DELETE', URL_QUOTA)).toHaveLength(1))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('Riprova: POST …/quota/riprova; se passa, la scheda si rilegge', async () => {
    rotta('POST', `${URL_QUOTA}/riprova`, json(200, { data: { esito: 'ok', pagamentoId: 'p-1', incassoId: 'i-1', voceNuova: true } }))
    const { onCambiata } = monta({ quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-20', alunno_id: ALUNNO })
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(chiamate('POST', `${URL_QUOTA}/riprova`)).toHaveLength(1))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('Riprova: se la quota non è pronta lo dice e non rilegge', async () => {
    rotta('POST', `${URL_QUOTA}/riprova`, json(200, { data: { esito: 'non_pronta' } }))
    const { onCambiata } = monta({ quota_stato: 'in_attesa', quota_importo: 150, quota_metodo: 'contanti', quota_anno: 2027, quota_saldata_il: '2026-10-20', alunno_id: ALUNNO })
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Il bambino non è ancora collegato a un alunno: il passaggio non può partire.')
    expect(onCambiata).not.toHaveBeenCalled()
  })

  it('bloccata gia_pagata mostra «È lo stesso pagamento» e chiama DELETE', async () => {
    rotta('DELETE', URL_QUOTA, json(200, { data: { stornato: true } }))
    const { onCambiata } = monta({
      quota_stato: 'bloccata',
      quota_blocco_motivo: 'gia_pagata',
      quota_importo: 150,
      quota_metodo: 'contanti',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      alunno_id: ALUNNO,
    })
    // Il motivo del blocco è quello del catalogo, e c'è Riprova.
    expect(screen.getByText(/Per quest’anno questo alunno ha già una quota d’iscrizione pagata/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy()
    // Per gia_pagata «togli» si dice «È lo stesso pagamento»: stesso gesto, non due bottoni uguali.
    expect(screen.queryByRole('button', { name: 'Togli la quota' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'È lo stesso pagamento' }))
    await waitFor(() => expect(chiamate('DELETE', URL_QUOTA)).toHaveLength(1))
    await waitFor(() => expect(onCambiata).toHaveBeenCalledTimes(1))
  })

  it('bloccata per un altro motivo: il suo testo, Riprova, Correggi e Togli; niente «lo stesso pagamento»', () => {
    monta({
      quota_stato: 'bloccata',
      quota_blocco_motivo: 'piu_voci',
      quota_importo: 150,
      quota_metodo: 'carta',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      alunno_id: ALUNNO,
    })
    expect(screen.getByText(/più voci d’iscrizione per quest’anno/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Correggi' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Togli la quota' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'È lo stesso pagamento' })).toBeNull()
  })

  it('in contabilità: nessun campo modificabile, collegamento allo scadenzario', () => {
    monta({
      quota_stato: 'in_contabilita',
      quota_importo: 150,
      quota_metodo: 'contanti',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      quota_pagamento_id: 'pagamento-1',
      alunno_id: ALUNNO,
    })
    expect(screen.getByText('In contabilità')).toBeTruthy()
    expect(screen.getByText('150,00 € · Contanti · 20/10/2026')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Apri lo scadenzario' }).getAttribute('href')).toBe('/admin/pagamenti?vista=scadenzario')
    // Né campi né azioni: si corregge in contabilità.
    expect(screen.queryAllByRole('textbox')).toEqual([])
    expect(screen.queryAllByRole('combobox')).toEqual([])
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('bonifico in contabilità e voce non ancora pagata: «in attesa del bonifico»', () => {
    monta({
      quota_stato: 'in_contabilita',
      quota_importo: 150,
      quota_metodo: 'bonifico',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      quota_pagamento_id: 'pagamento-1',
      quota_pagamento_stato: 'da_pagare',
      alunno_id: ALUNNO,
    })
    expect(screen.getByText('In contabilità, in attesa del bonifico')).toBeTruthy()
  })

  it('«in attesa del bonifico» ha un tono d’attesa, diverso dal verde di «in contabilità»', () => {
    const base = {
      quota_stato: 'in_contabilita' as const,
      quota_importo: 150,
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      quota_pagamento_id: 'pagamento-1',
      alunno_id: ALUNNO,
    }
    monta({ ...base, quota_metodo: 'bonifico', quota_pagamento_stato: 'da_pagare' })
    const attesa = screen.getByText('In contabilità, in attesa del bonifico').className
    cleanup()
    monta({ ...base, quota_metodo: 'bonifico', quota_pagamento_stato: 'pagato' })
    const fatto = screen.getByText('In contabilità').className

    expect(fatto).toContain('kidville-success-soft')
    expect(attesa).toContain('kidville-info-soft')
    expect(attesa).not.toContain('kidville-success-soft')
    expect(attesa).not.toBe(fatto)
  })

  it('bonifico in contabilità e voce pagata dalla banca: solo «in contabilità»', () => {
    monta({
      quota_stato: 'in_contabilita',
      quota_importo: 150,
      quota_metodo: 'bonifico',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      quota_pagamento_id: 'pagamento-1',
      quota_pagamento_stato: 'pagato',
      alunno_id: ALUNNO,
    })
    expect(screen.getByText('In contabilità')).toBeTruthy()
    expect(screen.queryByText('In contabilità, in attesa del bonifico')).toBeNull()
  })

  it('un contante in contabilità non dice mai «in attesa del bonifico», qualunque sia lo stato della voce', () => {
    monta({
      quota_stato: 'in_contabilita',
      quota_importo: 150,
      quota_metodo: 'contanti',
      quota_anno: 2027,
      quota_saldata_il: '2026-10-20',
      quota_pagamento_id: 'pagamento-1',
      quota_pagamento_stato: 'da_pagare',
      alunno_id: ALUNNO,
    })
    expect(screen.getByText('In contabilità')).toBeTruthy()
    expect(screen.queryByText('In contabilità, in attesa del bonifico')).toBeNull()
  })

  it('il modulo si annulla senza chiamare la rete', () => {
    monta()
    apriModulo()
    scrivi('Importo (€)', '150')
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(screen.getByRole('button', { name: SEGNA })).toBeTruthy()
    expect(h.chiamate).toEqual([])
    // Dentro la sezione non resta nessun campo.
    expect(within(screen.getByRole('region', { name: 'Quota d’iscrizione' })).queryAllByRole('textbox')).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('l’importo, scritto e letto all’italiana', () => {
  it('si scrive con la virgola o con il punto, due decimali al massimo', () => {
    expect(importoDaTesto('150,50')).toBe(150.5)
    expect(importoDaTesto('150.5')).toBe(150.5)
    expect(importoDaTesto(' 99 ')).toBe(99)
    expect(importoDaTesto('0,01')).toBe(0.01)
    expect(importoDaTesto('100000')).toBe(100000)
  })

  it('tre decimali, zero, negativi, migliaia, lettere e oltre il tetto della route non sono un importo', () => {
    for (const v of ['150,555', '0', '0,00', '-5', '1.500,00', '1.500', 'abc', '', ' ', '15 0', ',50', '150,', '100000,01', '1e3']) {
      expect(importoDaTesto(v), `«${v}»`).toBeNull()
    }
  })

  it('si legge sempre con due decimali e la virgola; numeric di PostgREST può essere una stringa', () => {
    expect(importoLeggibile(150.5)).toBe('150,50')
    expect(importoLeggibile('150.50')).toBe('150,50')
    expect(importoLeggibile(10000)).toBe('10.000,00')
    expect(importoLeggibile(null)).toBeNull()
    expect(importoLeggibile('non un numero')).toBeNull()
    expect(importoPerCampo('150.50')).toBe('150,50')
    expect(importoPerCampo(null)).toBe('')
  })
})
