import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'

// =============================================================================
// SCRUTINIO DELLA PRIMARIA: «Pagella PDF» e «Template CSV» con l'helper unico
// dei download — compito S4 della spec 2026-09-24.
//
// Fissa:
//  · NELL'APP la pagella non passa più da `window.open` (nella WebView non apre
//    niente): va a `scaricaDocumento` con l'indirizzo della route (con
//    `persist=1`), un nome senza dati di persona (frammenti di uuid di alunno e
//    scrutinio: due pagelle dello stesso alunno in periodi diversi, in volo
//    insieme, non condividono il file in Cache) e il mime del PDF; finito lo
//    scarico si rilegge UNA volta lo scrutinio del periodo corrente, perché la
//    GET ha archiviato il PDF e «Elimina pagella» deve comparire;
//  · un esito non consegnato si dice ACCANTO AL BOTTONE che l'ha avviato, con
//    `role="alert"` (non in cima alla pagina, lontano migliaia di pixel su un
//    telefono): «riprova» o «aggiorna l'app» (binario 1.0), secondo l'helper;
//  · mentre la pagella si genera il bottone di QUELL'alunno è `disabled` e
//    `aria-busy`, e un secondo tocco non lancia un secondo scarico;
//  · SUL WEB la pagella resta `window.open`, e l'helper non si chiama;
//  · il template CSV non usa più `XLSX.writeFile`: il Blob (BOM UTF-8 + CSV,
//    come lo scriveva `writeFile`) passa a `scaricaDocumento`. Sul web si usa
//    l'helper VERO: `<a download>` sullo stesso nome di prima, byte verificati.
//
// next-intl: catalogo italiano VERO e `t` STABILE per namespace (stessa ragione
// di `AzioniScrutinio.test.tsx`: col `t` nuovo a ogni render la pagina rileggerebbe
// lo scrutinio da sola, e il conteggio delle ricariche non misurerebbe niente).
// =============================================================================

vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { IntlMessageFormat } = await import('intl-messageformat')
  const cartella = join(process.cwd(), 'messages/it')
  const cataloghi: Record<string, Record<string, unknown>> = {}
  for (const file of readdirSync(cartella)) {
    if (file.endsWith('.json')) {
      cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'))
    }
  }
  if (Object.keys(cataloghi).length === 0) throw new Error(`Nessun catalogo italiano in ${cartella}`)
  const risolvi = (ns: string | undefined, key: string): string => {
    const v = ns ? cataloghi[ns]?.[key] : undefined
    return typeof v === 'string' ? v : ns ? `${ns}.${key}` : key
  }
  const formatta = (messaggio: string, valori: Record<string, unknown>): string => {
    try {
      return String(new IntlMessageFormat(messaggio, 'it').format(valori))
    } catch {
      return messaggio
    }
  }
  const perNamespace = new Map<string, unknown>()
  const useTranslations = (ns?: string) => {
    const chiave = ns ?? ''
    if (!perNamespace.has(chiave)) {
      const t = (key: string, valori?: Record<string, unknown>) =>
        valori === undefined ? risolvi(ns, key) : formatta(risolvi(ns, key), valori)
      perNamespace.set(
        chiave,
        Object.assign(t, {
          rich: (key: string) => risolvi(ns, key),
          markup: (key: string) => risolvi(ns, key),
          raw: (key: string) => risolvi(ns, key),
          has: () => true,
        }),
      )
    }
    return perNamespace.get(chiave)
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const h = vi.hoisted(() => ({
  logClient: vi.fn(),
  nativo: false,
  scaricaDocumento: vi.fn(),
  vero: null as null | ((input: unknown) => Promise<unknown>),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('@/lib/push/native-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/native-register')>()),
  isNativeApp: () => h.nativo,
}))
// Lo spy AVVOLGE l'helper vero: dove il test non lo istruisce, fa quello che fa
// l'helper (sul web: fetch/Blob → `<a download>`), non un «ok» fisso.
vi.mock('@/lib/native/scarica', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/scarica')>()
  h.vero = (input) => vero.scaricaDocumento(input as Parameters<typeof vero.scaricaDocumento>[0])
  return { ...vero, scaricaDocumento: h.scaricaDocumento }
})

const nav = vi.hoisted(() => ({ params: { sectionId: '' }, search: new URLSearchParams() }))
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/primaria/scrutinio',
}))

import ScrutinioPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/scrutinio/page'

const SEZIONE = 'aaaa1111-0000-4000-8000-0000000000a1'
const SCRUTINIO = 'bbbb2222-0000-4000-8000-0000000000b2'
const PERIODO = 'cccc3333-0000-4000-8000-0000000000c3'
const ALUNNO = 'dddd4444-0000-4000-8000-0000000000d4'
const OPERATORE = 'eeee5555-0000-4000-8000-0000000000e5'
const MATERIA = '99990000-0000-4000-8000-000000000099'
const ALUNNO_2 = 'ffff6666-0000-4000-8000-0000000000f6'
const UN_ALUNNO = [{ id: ALUNNO, nome: 'Mario', cognome: 'Rossi' }]
const DUE_ALUNNI = [...UN_ALUNNO, { id: ALUNNO_2, nome: 'Anna', cognome: 'Bianchi' }]

const NON_SALVATO = 'Il documento non si è salvato sul dispositivo. Riprova fra qualche minuto.'
const APP_DA_AGGIORNARE =
  'Con questa versione dell’app il documento non si può salvare né aprire sul telefono: aggiorna l’app, oppure aprilo dal sito su un computer.'

const fetchMock = vi.fn()

function risposta(status: number, corpo: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => corpo })
}

// Secondo periodo della STESSA sezione: stessi alunni, un altro scrutinio. I primi
// 8 caratteri DIVERSI da SCRUTINIO: sono quelli che finiscono nel nome del file.
const PERIODO_2 = 'cccc3333-0000-4000-8000-0000000000c4'
const SCRUTINIO_2 = 'bbbb4444-0000-4000-8000-0000000000b3'
const PERIODI = [
  { id: PERIODO, nome: 'Primo quadrimestre', anno_scolastico: '2025/26' },
  { id: PERIODO_2, nome: 'Secondo quadrimestre', anno_scolastico: '2025/26' },
]

function instradaFetch(
  chiuso: boolean,
  alunni: { id: string; nome: string; cognome: string }[] = UN_ALUNNO,
  periodi: typeof PERIODI = PERIODI.slice(0, 1),
) {
  fetchMock.mockImplementation((input: string) => {
    const u = new URL(input, 'http://localhost')
    if (u.pathname === '/api/primaria/me') {
      return risposta(200, { success: true, data: { ruolo: 'educator', isDirigente: false } })
    }
    if (u.pathname === '/api/primaria/scrutinio' && !u.searchParams.get('periodoId')) {
      return risposta(200, { success: true, data: { periodi } })
    }
    if (u.pathname === '/api/primaria/scrutinio') {
      return risposta(200, {
        success: true,
        data: {
          scrutinio: {
            id: u.searchParams.get('periodoId') === PERIODO_2 ? SCRUTINIO_2 : SCRUTINIO,
            stato: chiuso ? 'chiuso' : 'aperto',
            chiuso_il: chiuso ? '2026-02-10T10:00:00Z' : null,
            pubblicato: false,
          },
          alunni,
          materie: [{ id: MATERIA, nome: 'Italiano', e_civica: false }],
          mieMaterieIds: [MATERIA],
          scala: ['Ottimo', 'Buono'],
          giudizi: [{ alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: 'Ottimo' }],
          comportamento: [],
          pagelleArchiviate: [],
          pagelleArchiviateNonLette: false,
        },
      })
    }
    return risposta(404, { error: 'rotta non prevista dal test' })
  })
}

// Le GET dello scrutinio (quelle col periodoId) mandate DOPO l'indice `da`.
function getScrutinioDopo(da: number) {
  return fetchMock.mock.calls
    .slice(da)
    .map(([u]) => new URL(String(u), 'http://localhost'))
    .filter((u) => u.pathname === '/api/primaria/scrutinio' && u.searchParams.has('periodoId'))
}

async function assesta() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

// Sceglie un altro periodo dal selettore e aspetta che il suo scrutinio sia stato
// letto (presenza della GET con quel periodoId, poi lo stato si assesta).
async function cambiaPeriodo(periodoId: string) {
  const opzione = screen.getByRole('option', { name: /Secondo quadrimestre/ })
  const selettore = opzione.closest('select') as HTMLSelectElement
  const prima = fetchMock.mock.calls.length
  fireEvent.change(selettore, { target: { value: periodoId } })
  await waitFor(() =>
    expect(getScrutinioDopo(prima).some((u) => u.searchParams.get('periodoId') === periodoId)).toBe(true),
  )
  await assesta()
  expect(selettore.value).toBe(periodoId)
}

beforeEach(() => {
  fetchMock.mockReset()
  h.logClient.mockReset()
  // `mockReset` e non `mockClear`: un `…Once` non consumato da un test (se il
  // codice sotto prova non chiama l'helper) non deve finire nel test dopo.
  h.scaricaDocumento.mockReset()
  h.scaricaDocumento.mockImplementation((input: unknown) => {
    if (!h.vero) throw new Error('helper vero non caricato')
    return h.vero(input)
  })
  h.nativo = false
  vi.stubGlobal('fetch', fetchMock)
  nav.params = { sectionId: SEZIONE }
  nav.search = new URLSearchParams(`userId=${OPERATORE}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('«Pagella PDF» nell’app: dall’helper, non da window.open', () => {
  // Due alunni: l'avviso e il blocco del bottone devono stare sulla riga di
  // QUELL'alunno, non sull'altra e non in cima alla pagina.
  async function montaChiuso(periodi: typeof PERIODI = PERIODI.slice(0, 1)) {
    instradaFetch(true, DUE_ALUNNI, periodi)
    const open = vi.fn(() => ({}) as Window)
    vi.stubGlobal('open', open)
    render(<ScrutinioPage />)
    const bottoni = await screen.findAllByRole('button', { name: /Pagella PDF/ })
    expect(bottoni).toHaveLength(2)
    await assesta()
    // Il blocco dei comandi della riga: il contenitore del bottone.
    const riga = (b: HTMLElement) => b.parentElement as HTMLElement
    return { pdf: bottoni[0], pdf2: bottoni[1], riga, open }
  }

  it('passa a scaricaDocumento l’indirizzo con persist=1, un nome senza persona e il mime; poi UNA ricarica', async () => {
    h.nativo = true
    let rilascia: (v: unknown) => void = () => {}
    h.scaricaDocumento.mockImplementationOnce(() => new Promise((ok) => { rilascia = ok }))
    const { pdf, pdf2, open } = await montaChiuso()

    const prima = fetchMock.mock.calls.length
    fireEvent.click(pdf)

    expect(open).not.toHaveBeenCalled()
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    // In volo: il bottone di QUELL'alunno è fermo e lo dice; l'altro no.
    expect((pdf as HTMLButtonElement).disabled).toBe(true)
    expect(pdf.getAttribute('aria-busy')).toBe('true')
    expect((pdf2 as HTMLButtonElement).disabled).toBe(false)
    expect(pdf2.getAttribute('aria-busy')).toBeNull()
    // Un secondo tocco non lancia una seconda generazione né un secondo foglio.
    fireEvent.click(pdf)
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    const input = h.scaricaDocumento.mock.calls[0][0] as {
      sorgente: string; nomeFile: string; mime: string; etichetta: string
    }
    const u = new URL(input.sorgente, 'http://localhost')
    expect(u.pathname).toBe('/api/primaria/pagella')
    expect(u.searchParams.get('scrutinioId')).toBe(SCRUTINIO)
    expect(u.searchParams.get('alunnoId')).toBe(ALUNNO)
    expect(u.searchParams.get('persist')).toBe('1')
    expect(u.searchParams.get('userId')).toBe(OPERATORE)
    // Solo frammenti di uuid (alunno e scrutinio): niente cognome sul dispositivo.
    expect(input.nomeFile).toBe(`pagella-${ALUNNO.slice(0, 8)}-${SCRUTINIO.slice(0, 8)}.pdf`)
    expect(input.nomeFile).not.toMatch(/rossi|mario/i)
    expect(input.mime).toBe('application/pdf')
    expect(input.etichetta).toBe('pagella')

    // Finché lo scarico è in volo lo scrutinio non si rilegge.
    expect(getScrutinioDopo(prima)).toHaveLength(0)
    await act(async () => {
      rilascia({ esito: 'nativo-file' })
    })
    await waitFor(() => expect(getScrutinioDopo(prima)).toHaveLength(1))
    expect(getScrutinioDopo(prima)[0].searchParams.get('periodoId')).toBe(PERIODO)
    expect(screen.queryByText(NON_SALVATO)).toBeNull()
    // Finito lo scarico il bottone torna attivo.
    expect((pdf as HTMLButtonElement).disabled).toBe(false)
    expect(pdf.getAttribute('aria-busy')).toBeNull()

    // Nessun listener di focus armato: nell'app non c'è una scheda da cui tornare.
    const dopo = fetchMock.mock.calls.length
    fireEvent.focus(window)
    expect(getScrutinioDopo(dopo)).toHaveLength(0)
  })

  it('scarico non riuscito: «riprova» con role=alert ACCANTO al bottone di quell’alunno', async () => {
    h.nativo = true
    h.scaricaDocumento.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    const { pdf, pdf2, riga } = await montaChiuso()
    // Il secondo alunno: l'avviso deve comparire nella SUA riga.
    fireEvent.click(pdf2)
    const avviso = await within(riga(pdf2)).findByRole('alert')
    expect(avviso.textContent).toBe(NON_SALVATO)
    expect(within(riga(pdf)).queryByRole('alert')).toBeNull()
    // Uno solo sulla pagina: non c'è una copia in cima, nel messaggio generale.
    expect(screen.getAllByText(NON_SALVATO)).toHaveLength(1)
    const nomeFile = (h.scaricaDocumento.mock.calls[0][0] as { nomeFile: string }).nomeFile
    expect(nomeFile).toBe(`pagella-${ALUNNO_2.slice(0, 8)}-${SCRUTINIO.slice(0, 8)}.pdf`)
    expect(nomeFile).not.toMatch(/anna|bianchi/i)
  })

  it('binario 1.0 (plugin assenti): a schermo «aggiorna l’app», e un successo dopo lo toglie', async () => {
    h.nativo = true
    h.scaricaDocumento
      .mockResolvedValueOnce({
        esito: 'non-riuscito',
        motivo: 'plugin-assenti:filesystem|link-non-condivisibile',
        binarioDaAggiornare: true,
      })
      .mockResolvedValueOnce({ esito: 'nativo-file' })
    const { pdf, riga } = await montaChiuso()
    fireEvent.click(pdf)
    const avviso = await within(riga(pdf)).findByRole('alert')
    expect(avviso.textContent).toBe(APP_DA_AGGIORNARE)
    expect(screen.queryByText(NON_SALVATO)).toBeNull()

    await waitFor(() => expect((pdf as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(pdf)
    await waitFor(() => expect(h.scaricaDocumento).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(APP_DA_AGGIORNARE)).toBeNull())
    expect(within(riga(pdf)).queryByRole('alert')).toBeNull()
  })

  it('cambiando periodo, l’avviso del periodo di prima NON resta accanto al bottone del nuovo', async () => {
    h.nativo = true
    h.scaricaDocumento.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    const { pdf, riga } = await montaChiuso(PERIODI)
    fireEvent.click(pdf)
    // Presenza, prima: l'avviso del primo quadrimestre c'è.
    expect((await within(riga(pdf)).findByRole('alert')).textContent).toBe(NON_SALVATO)
    await waitFor(() => expect((pdf as HTMLButtonElement).disabled).toBe(false))

    const prima = fetchMock.mock.calls.length
    await cambiaPeriodo(PERIODO_2)
    expect(getScrutinioDopo(prima).map((u) => u.searchParams.get('periodoId'))).toEqual([PERIODO_2])
    const [pdfB] = screen.getAllByRole('button', { name: /Pagella PDF/ })
    expect(within(riga(pdfB)).queryByRole('alert')).toBeNull()
    expect(screen.queryByText(NON_SALVATO)).toBeNull()
  })

  it('uno scarico in volo nel periodo di prima non ferma il bottone del nuovo né vi scrive il suo esito', async () => {
    h.nativo = true
    let rilascia: (v: unknown) => void = () => {}
    let rilasciaB: (v: unknown) => void = () => {}
    h.scaricaDocumento
      .mockImplementationOnce(() => new Promise((ok) => { rilascia = ok }))
      .mockImplementationOnce(() => new Promise((ok) => { rilasciaB = ok }))
    const { pdf, riga } = await montaChiuso(PERIODI)
    fireEvent.click(pdf)
    expect((pdf as HTMLButtonElement).disabled).toBe(true)
    const inputA = h.scaricaDocumento.mock.calls[0][0] as { sorgente: string; nomeFile: string }
    expect(new URL(inputA.sorgente, 'http://localhost').searchParams.get('scrutinioId')).toBe(SCRUTINIO)

    await cambiaPeriodo(PERIODO_2)
    // Nel secondo quadrimestre la pagella dello stesso alunno non è in volo.
    const [pdfB] = screen.getAllByRole('button', { name: /Pagella PDF/ })
    expect((pdfB as HTMLButtonElement).disabled).toBe(false)
    expect(pdfB.getAttribute('aria-busy')).toBeNull()

    // La pagella dello STESSO alunno, secondo quadrimestre, mentre quella del primo
    // è ancora in volo: due scarichi insieme. L'helper scrive in Cache col nome
    // dato: se fosse lo stesso, il secondo PDF sovrascriverebbe il file che il
    // primo foglio «Salva su File» sta ancora offrendo.
    fireEvent.click(pdfB)
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(2)
    const inputB = h.scaricaDocumento.mock.calls[1][0] as { sorgente: string; nomeFile: string }
    expect(new URL(inputB.sorgente, 'http://localhost').searchParams.get('scrutinioId')).toBe(SCRUTINIO_2)
    expect(inputA.nomeFile).toBe(`pagella-${ALUNNO.slice(0, 8)}-${SCRUTINIO.slice(0, 8)}.pdf`)
    expect(inputB.nomeFile).toBe(`pagella-${ALUNNO.slice(0, 8)}-${SCRUTINIO_2.slice(0, 8)}.pdf`)
    expect(inputB.nomeFile).not.toBe(inputA.nomeFile)
    expect((pdfB as HTMLButtonElement).disabled).toBe(true)

    // Lo scarico del primo quadrimestre finisce male DOPO il cambio.
    const dopoCambio = fetchMock.mock.calls.length
    await act(async () => {
      rilascia({ esito: 'non-riuscito', motivo: 'http-500' })
    })
    // Presenza: il `.then` è arrivato (ha riletto lo scrutinio, quello del periodo ORA).
    await waitFor(() => expect(getScrutinioDopo(dopoCambio)).toHaveLength(1))
    expect(getScrutinioDopo(dopoCambio)[0].searchParams.get('periodoId')).toBe(PERIODO_2)
    await assesta()
    const [pdfB2] = screen.getAllByRole('button', { name: /Pagella PDF/ })
    expect(within(riga(pdfB2)).queryByRole('alert')).toBeNull()
    expect(screen.queryByText(NON_SALVATO)).toBeNull()
    // La fine dello scarico del primo quadrimestre non sblocca quello del secondo,
    // ancora in volo.
    expect((pdfB2 as HTMLButtonElement).disabled).toBe(true)
    expect(pdfB2.getAttribute('aria-busy')).toBe('true')

    // Finisce anche il secondo: il bottone torna attivo, senza avvisi.
    const dopoA = fetchMock.mock.calls.length
    await act(async () => {
      rilasciaB({ esito: 'nativo-file' })
    })
    await waitFor(() => expect(getScrutinioDopo(dopoA)).toHaveLength(1))
    await assesta()
    const [pdfB3] = screen.getAllByRole('button', { name: /Pagella PDF/ })
    expect((pdfB3 as HTMLButtonElement).disabled).toBe(false)
    expect(within(riga(pdfB3)).queryByRole('alert')).toBeNull()
  })

  it('sul web resta window.open con persist=1, e l’helper non si chiama', async () => {
    h.nativo = false
    const { pdf, open } = await montaChiuso()
    fireEvent.click(pdf)
    expect(open).toHaveBeenCalledTimes(1)
    const [indirizzo, destinazione] = open.mock.calls[0] as unknown as [string, string]
    expect(destinazione).toBe('_blank')
    expect(new URL(indirizzo, 'http://localhost').searchParams.get('persist')).toBe('1')
    expect(h.scaricaDocumento).not.toHaveBeenCalled()
  })
})

describe('«Template CSV»: il Blob passa all’helper, non a XLSX.writeFile', () => {
  async function leggiByte(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer())
  }

  it('sul web: l’helper VERO scarica con <a download> lo stesso nome, BOM UTF-8 + CSV', async () => {
    instradaFetch(false)
    // jsdom non ha `createObjectURL`: lo si installa sul costruttore VERO (che serve
    // ancora a chi analizza indirizzi) e si toglie alla fine.
    const blobCreati: Blob[] = []
    const statico = URL as unknown as Record<string, unknown>
    const prima = { crea: statico.createObjectURL, revoca: statico.revokeObjectURL }
    statico.createObjectURL = (b: Blob) => {
      blobCreati.push(b)
      return 'blob:finto-1'
    }
    statico.revokeObjectURL = () => {}
    onTestFinished(() => {
      statico.createObjectURL = prima.crea
      statico.revokeObjectURL = prima.revoca
    })
    const scarichi: { href: string; download: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      scarichi.push({ href: this.getAttribute('href') ?? '', download: this.download })
    })

    render(<ScrutinioPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Template CSV/ }))

    await waitFor(() => expect(scarichi).toHaveLength(1))
    expect(scarichi[0]).toEqual({ href: 'blob:finto-1', download: 'scrutinio-giudizi-template.csv' })
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    const input = h.scaricaDocumento.mock.calls[0][0] as { sorgente: unknown; nomeFile: string; mime: string }
    expect(input.sorgente).toBeInstanceOf(Blob)
    expect(input.nomeFile).toBe('scrutinio-giudizi-template.csv')
    expect(input.mime).toBe('text/csv')

    expect(blobCreati).toHaveLength(1)
    const byte = await leggiByte(blobCreati[0])
    // BOM UTF-8 in testa, come lo scriveva `XLSX.writeFile` per il CSV.
    expect(Array.from(byte.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const testo = new TextDecoder().decode(byte.slice(3))
    expect(testo.split('\n')[0]).toBe('alunno,materia,giudizio')
    expect(testo).toContain('Rossi Mario,Italiano,Ottimo')

    // L'esito lo registra l'helper, successo compreso, con l'etichetta del gesto.
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({ messaggio: 'scrutinio-template-scarico-riuscito:web-blob' }),
      ),
    )
    expect(screen.queryByText(NON_SALVATO)).toBeNull()
  })

  it('nell’app: lo stesso Blob all’helper; se il foglio non si apre, «riprova» accanto al bottone', async () => {
    h.nativo = true
    instradaFetch(false)
    h.scaricaDocumento.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    render(<ScrutinioPage />)
    const template = await screen.findByRole('button', { name: /Template CSV/ })
    fireEvent.click(template)

    // Accanto a «Template CSV», con role=alert: non nel messaggio in cima.
    const avviso = await within(template.parentElement as HTMLElement).findByRole('alert')
    expect(avviso.textContent).toBe(NON_SALVATO)
    expect(screen.getAllByText(NON_SALVATO)).toHaveLength(1)
    const input = h.scaricaDocumento.mock.calls[0][0] as { sorgente: Blob; nomeFile: string }
    expect(input.nomeFile).toBe('scrutinio-giudizi-template.csv')
    const testo = new TextDecoder().decode((await leggiByte(input.sorgente)).slice(3))
    expect(testo).toContain('Rossi Mario,Italiano,Ottimo')
  })

  it('nell’app: mentre il template è in volo il bottone è fermo, e un secondo tocco non lancia un secondo foglio', async () => {
    h.nativo = true
    instradaFetch(false)
    let rilascia: (v: unknown) => void = () => {}
    h.scaricaDocumento.mockImplementationOnce(() => new Promise((ok) => { rilascia = ok }))
    render(<ScrutinioPage />)
    const template = (await screen.findByRole('button', { name: /Template CSV/ })) as HTMLButtonElement
    await assesta()

    fireEvent.click(template)
    fireEvent.click(template)
    await waitFor(() => expect(h.scaricaDocumento).toHaveBeenCalledTimes(1))
    expect(template.disabled).toBe(true)
    expect(template.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(template)
    await assesta()
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)

    await act(async () => {
      rilascia({ esito: 'nativo-file' })
    })
    await waitFor(() => expect(template.disabled).toBe(false))
    expect(template.getAttribute('aria-busy')).toBeNull()
    expect(within(template.parentElement as HTMLElement).queryByRole('alert')).toBeNull()
    // Di nuovo attivo: un tocco dopo lancia davvero un secondo scarico.
    h.scaricaDocumento.mockResolvedValueOnce({ esito: 'nativo-file' })
    fireEvent.click(template)
    await waitFor(() => expect(h.scaricaDocumento).toHaveBeenCalledTimes(2))
  })

  it('cambiando periodo, il «riprova» del template di prima non resta accanto al bottone', async () => {
    h.nativo = true
    instradaFetch(false, UN_ALUNNO, PERIODI)
    h.scaricaDocumento.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    render(<ScrutinioPage />)
    const template = await screen.findByRole('button', { name: /Template CSV/ })
    await assesta()
    fireEvent.click(template)
    expect((await within(template.parentElement as HTMLElement).findByRole('alert')).textContent).toBe(NON_SALVATO)

    await cambiaPeriodo(PERIODO_2)
    const templateB = screen.getByRole('button', { name: /Template CSV/ })
    expect(within(templateB.parentElement as HTMLElement).queryByRole('alert')).toBeNull()
    expect(screen.queryByText(NON_SALVATO)).toBeNull()
  })
})
