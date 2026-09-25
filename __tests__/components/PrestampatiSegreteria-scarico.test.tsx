import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'

/**
 * NAT3f — IL PDF DI UN PRESTAMPATO passa dall'helper unico.
 *
 * Prima: dopo la generazione un'ancora `download` su un `blob:` cliccata a mano, e nel
 * riquadro dell'esito due link sul `blob:` («Scarica», «Anteprima»). Nella WebView dell'app
 * nessuno dei tre faceva niente — su un foglio che può aver già consumato un numero di
 * protocollo, cioè che non si rifà con leggerezza.
 *
 * Rosso senza la modifica:
 *  · subito dopo la generazione l'helper riceve IL BLOB della risposta, col nome dall'header;
 *  · un salvataggio non riuscito si dice DENTRO il riquadro dell'esito (che resta: il
 *    documento esiste), e un «Scarica» riuscito lo toglie; un'«Anteprima» di sistema NO
 *    (non salva niente), la stessa ripiegata sul foglio «Salva su File» sì;
 *  · nell'app «Scarica» e «Anteprima» passano dall'helper (`scaricaDocumento` /
 *    `apriDocumento`) con lo stesso Blob; sul web restano link, senza `preventDefault`.
 *
 * Il percorso fino al modulo è lo stesso di `PrestampatiSegreteria-generazione.test.tsx`.
 * ⚠️ Nessun nome vero nei dati di prova: il repository è pubblico.
 */

const h = vi.hoisted(() => ({
  scarica: vi.fn(),
  apri: vi.fn(),
  nativo: false,
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  scaricaDocumento: h.scarica,
  apriDocumento: h.apri,
}))
vi.mock('@/lib/push/native-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/native-register')>()),
  isNativeApp: () => h.nativo,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const prestampatiSegreteria = (await import('../../messages/it/prestampatiSegreteria.json')).default
  const shared = (await import('../../messages/it/shared.json')).default
  const adminModulistica = (await import('../../messages/it/adminModulistica.json')).default
  const cataloghi = { prestampatiSegreteria, shared, adminModulistica }
  // Un `t` per namespace, memoizzato come quello vero (vedi il test della generazione).
  const memoria = new Map<string, unknown>()
  const useTranslations = (ns?: string) => {
    const chiave = ns ?? 'prestampatiSegreteria'
    const gia = memoria.get(chiave)
    if (gia) return gia
    const tradotto = createTranslator({
      locale: 'it',
      messages: cataloghi as never,
      namespace: chiave as never,
    }) as unknown as (k: string, valori?: Record<string, unknown>) => string
    const t = (k: string, valori?: Record<string, unknown>) => tradotto(k, valori)
    const conForme = Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    memoria.set(chiave, conForme)
    return conForme
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', nome: 'Sede di prova' }],
    errore: false,
    selezionate: [],
    effettive: ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'],
    sedeCorrente: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    reFetchKey: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

const SLUG = 'certificato_iscrizione_frequenza'
const NOME_MODELLO = itPrestampati.modelli.certificatoIscrizioneFrequenza

const MODELLO = {
  slug: SLUG,
  etichetta: 'Certificato di iscrizione e frequenza',
  soggetto: 'alunno',
  firma: 'legale_rappresentante',
  protocollo: 'uscita',
  archiviazione: 'student_documents',
  generabile: true,
}

const CAMPO = { nome: 'uso', etichetta: 'Uso dichiarato', tipo: 'testo', obbligatorio: true, chiestoA: 'segreteria' }

function scheda() {
  return {
    success: true,
    data: {
      modello: { ...MODELLO, campi: [CAMPO] },
      prefill: {
        soggetto: 'alunno',
        alunnoId: 'al-1',
        scuolaId: SEDE,
        sezioneId: 'cl-1',
        legaleRappresentante: 'Legale Rappresentante',
        dati: {
          alunno: {
            nome: 'Prova',
            cognome: 'Iscritta',
            dataNascita: '2021-03-04',
            codiceFiscale: 'AAAAAA00A00A000A',
            sezione: 'Sezione Gialla',
          },
          annoScolastico: '2026/2027',
        },
      },
    },
  }
}

function rispostaPredefinita(url: string) {
  if (url.startsWith('/api/admin/sections')) return [{ id: 'cl-1', name: 'Sezione Gialla' }]
  if (url.startsWith('/api/admin/students')) return [{ id: 'al-1', nome: 'Prova', cognome: 'Iscritta', stato: 'iscritto' }]
  if (url.includes('alunnoId=')) return scheda()
  return { success: true, data: { modelli: [MODELLO] } }
}

/** Il PDF generato: sempre lo STESSO oggetto, così si può dire che l'helper ha ricevuto quello. */
let pdfGenerato: Blob

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  h.apri.mockResolvedValue({ esito: 'nativo-anteprima' })
  pdfGenerato = new Blob(['%PDF-finto'], { type: 'application/pdf' })
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const intestazioni: Record<string, string> = {
          'content-disposition': 'attachment; filename="certificato-prova.pdf"',
          'x-prestampato-protocollo': '12/2026',
          'x-prestampato-archiviato': 'archiviato',
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (n: string) => intestazioni[n.toLowerCase()] ?? null },
          blob: async () => pdfGenerato,
          json: async () => null,
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => rispostaPredefinita(String(url)) })
    }),
  )
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:prestampato'), revokeObjectURL: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

async function generaIlDocumento() {
  render(<PrestampatiSegreteria />)
  fireEvent.change(await screen.findByLabelText(itPrestampati.scegliClasse), { target: { value: 'cl-1' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Iscritta Prova' }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(NOME_MODELLO) }))
  fireEvent.change(await screen.findByLabelText(/Uso dichiarato/), { target: { value: 'Bonus' } })
  fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))
  const conferma = await screen.findByText(itPrestampati.confermaGenerato)
  return conferma.closest('[role="status"]') as HTMLElement
}

/** Il click sul link, con la navigazione di jsdom intercettata DOPO il gestore del componente. */
function clicSenzaNavigare(link: HTMLElement): boolean {
  let prevenuto = false
  const osserva = (ev: Event) => {
    prevenuto = ev.defaultPrevented
    ev.preventDefault()
  }
  window.addEventListener('click', osserva)
  try {
    fireEvent.click(link)
  } finally {
    window.removeEventListener('click', osserva)
  }
  return prevenuto
}

describe('PrestampatiSegreteria — il PDF dopo la generazione', () => {
  it('l’helper riceve IL Blob della risposta, col nome dall’header', async () => {
    await generaIlDocumento()
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const arg = h.scarica.mock.calls[0][0]
    expect(arg.sorgente).toBe(pdfGenerato)
    expect(arg).toMatchObject({ nomeFile: 'certificato-prova.pdf', mime: 'application/pdf', etichetta: 'prestampato' })
    expect(screen.queryByText(itPrestampati.scaricoNonRiuscito)).toBeNull()
  })

  it('un salvataggio non riuscito si dice nel riquadro, che resta (il documento esiste)', async () => {
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    const riquadro = await generaIlDocumento()
    expect(await within(riquadro).findByText(itPrestampati.scaricoNonRiuscito)).toBeInTheDocument()
    expect(within(riquadro).getByText(itPrestampati.protocolloAssegnato.replace('{numero}', '12/2026'))).toBeInTheDocument()
  })

  it('sul WEB «Scarica» e «Anteprima» restano link: nessun preventDefault, helper non richiamato', async () => {
    const riquadro = await generaIlDocumento()
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const scarica = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.scarica) })
    const anteprima = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.anteprima) })
    expect(scarica).toHaveAttribute('download', 'certificato-prova.pdf')
    expect(clicSenzaNavigare(scarica)).toBe(false)
    expect(clicSenzaNavigare(anteprima)).toBe(false)
    expect(h.scarica).toHaveBeenCalledTimes(1)
    expect(h.apri).not.toHaveBeenCalled()
  })

  it('nell’APP «Scarica» riprova con lo stesso Blob e, riuscito, toglie l’avviso', async () => {
    h.nativo = true
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    const riquadro = await generaIlDocumento()
    await within(riquadro).findByText(itPrestampati.scaricoNonRiuscito)

    h.scarica.mockResolvedValueOnce({ esito: 'nativo-file' })
    const scarica = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.scarica) })
    expect(clicSenzaNavigare(scarica)).toBe(true)
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(2))
    expect(h.scarica.mock.calls[1][0]).toMatchObject({ sorgente: pdfGenerato, nomeFile: 'certificato-prova.pdf', etichetta: 'prestampato' })
    await waitFor(() => expect(within(riquadro).queryByText(itPrestampati.scaricoNonRiuscito)).toBeNull())
  })

  it('nell’APP «Anteprima» apre l’anteprima di sistema con lo stesso Blob', async () => {
    h.nativo = true
    const riquadro = await generaIlDocumento()
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const anteprima = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.anteprima) })
    expect(clicSenzaNavigare(anteprima)).toBe(true)
    await waitFor(() =>
      expect(h.apri).toHaveBeenCalledWith({
        sorgente: pdfGenerato,
        nomeFile: 'certificato-prova.pdf',
        mime: 'application/pdf',
        etichetta: 'prestampato',
      }),
    )
  })

  /**
   * Un'anteprima di sistema NON è un salvataggio: il PDF resta solo nella Cache dell'app.
   * Se il salvataggio automatico era fallito, l'avviso deve restare dopo «Anteprima».
   * Lo toglie solo un file consegnato davvero (l'helper ripiegato sul foglio «Salva su File»).
   */
  it('nell’APP un’«Anteprima» di sistema NON toglie l’avviso di salvataggio fallito', async () => {
    h.nativo = true
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    const riquadro = await generaIlDocumento()
    await within(riquadro).findByText(itPrestampati.scaricoNonRiuscito)

    let risolvi: (r: { esito: string }) => void = () => {}
    h.apri.mockReturnValueOnce(new Promise((r) => { risolvi = r }))
    const anteprima = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.anteprima) })
    expect(clicSenzaNavigare(anteprima)).toBe(true)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    // Si risolve la promessa e si lascia girare il `.then` del componente PRIMA di guardare:
    // un controllo sull'assenza/presenza fatto prima sarebbe vero anche col difetto.
    risolvi({ esito: 'nativo-anteprima' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(within(riquadro).getByText(itPrestampati.scaricoNonRiuscito)).toBeInTheDocument()
  })

  it('nell’APP un’«Anteprima» ripiegata sul foglio «Salva su File» (nativo-file) toglie l’avviso', async () => {
    h.nativo = true
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    const riquadro = await generaIlDocumento()
    await within(riquadro).findByText(itPrestampati.scaricoNonRiuscito)

    h.apri.mockResolvedValueOnce({ esito: 'nativo-file' })
    const anteprima = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.anteprima) })
    expect(clicSenzaNavigare(anteprima)).toBe(true)
    await waitFor(() => expect(h.apri).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(riquadro).queryByText(itPrestampati.scaricoNonRiuscito)).toBeNull())
  })

  it('nell’APP un’«Anteprima» non riuscita mette l’avviso anche se il salvataggio automatico era riuscito', async () => {
    h.nativo = true
    const riquadro = await generaIlDocumento()
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    expect(within(riquadro).queryByText(itPrestampati.scaricoNonRiuscito)).toBeNull()

    h.apri.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' })
    const anteprima = within(riquadro).getByRole('link', { name: new RegExp(itPrestampati.anteprima) })
    expect(clicSenzaNavigare(anteprima)).toBe(true)
    expect(await within(riquadro).findByText(itPrestampati.scaricoNonRiuscito)).toBeInTheDocument()
  })
})
