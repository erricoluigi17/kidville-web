import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'

/**
 * IL BANCO DEI PRESTAMPATI — CHI compare nell'elenco dei bambini, e chi no.
 *
 * ─── IL CONFINE, E PERCHÉ NON È «SOLO GLI ISCRITTI» ─────────────────────────────
 *
 * `GET /api/admin/students` filtra per `stato` con un `.eq()` a valore singolo: «iscritti
 * più sospesi» non è esprimibile nell'URL. Il confine lo mette quindi il pannello, e lo
 * mette dove sta quello del SERVER: `caricaPrefillAlunno` rifiuta con 409 solo chi
 * `eNonPiuIscritto` — cioè i ritirati. Un sospeso è un bambino che frequenta, e i suoi
 * documenti si generano.
 *
 * Le due metà di questa regola sono l'una la prova dell'altra:
 *
 *  · se il RITIRATO comparisse, la segretaria lo sceglierebbe, compilerebbe il modulo e
 *    scoprirebbe il rifiuto solo dopo — dopo aver fatto leggere l'anagrafica di un bambino
 *    che non è più iscritto (che è una lettura registrata nel registro degli accessi);
 *  · se il SOSPESO sparisse, un bambino che frequenta resterebbe senza certificati per una
 *    riga di codice che nessuno ha deciso — ed è la stessa negazione (`!== 'iscritto'`) che
 *    in `admin/gdpr` aveva messo un sospeso fra i candidati all'anonimizzazione.
 *
 * Il resto del file guarda le due cose che rendono usabile un elenco da centinaia di nomi:
 * la ricerca PER NOME (non una `<select>` da scorrere) e il fatto che una lettura fallita
 * non si travesta da classe vuota.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const prestampatiSegreteria = (await import('../../messages/it/prestampatiSegreteria.json'))
    .default
  const shared = (await import('../../messages/it/shared.json')).default
  const cataloghi = { prestampatiSegreteria, shared }
  /**
   * ⚠️ UN `t` SOLO PER NAMESPACE, E NON UNO NUOVO A OGNI RENDER.
   *
   * Il `useTranslations` vero memoizza: il pannello ci conta, perché mette `t` fra le
   * dipendenze del `useCallback` che legge la scheda del modello. Un `t` di identità nuova a
   * ogni render fa credere all'effetto che la dipendenza sia cambiata, e la scheda si
   * ricarica in continuazione — cioè `setErrore(null)` cancella l'errore appena mostrato, e
   * il test diventa rosso per colpa del suo stesso finto.
   */
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
    sedi: [{ id: SEDE, nome: 'Kidville Giugliano' }],
    errore: false,
    selezionate: [],
    effettive: [SEDE],
    sedeCorrente: SEDE,
    reFetchKey: SEDE,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

const MODELLI = [
  {
    slug: 'certificato_iscrizione_frequenza',
    etichetta: 'Certificato di iscrizione e frequenza',
    soggetto: 'alunno',
    firma: 'legale_rappresentante',
    protocollo: 'uscita',
    archiviazione: 'student_documents',
    generabile: true,
  },
]

const CLASSI = [{ id: 'cl-1', name: 'Sezione Gialla' }]

/**
 * Tre bambini inventati, e il cognome dice a che serve ognuno: il repository è pubblico e in
 * un test non entra il nome di un bambino vero.
 */
const ALUNNI = [
  { id: 'al-1', nome: 'Prova', cognome: 'Iscritta', stato: 'iscritto' },
  { id: 'al-2', nome: 'Prova', cognome: 'Sospesa', stato: 'sospeso' },
  { id: 'al-3', nome: 'Prova', cognome: 'Ritirata', stato: 'ritirato' },
]

const fetchMock = vi.fn()

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.startsWith('/api/admin/sections')) return CLASSI
  if (u.startsWith('/api/admin/students')) return ALUNNI
  return { success: true, data: { modelli: MODELLI } }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

/** Sceglie la classe e aspetta che l'elenco dei bambini sia stato letto. */
async function scegliLaClasse() {
  const utils = render(<PrestampatiSegreteria />)
  const classe = await screen.findByLabelText(itPrestampati.scegliClasse)
  fireEvent.change(classe, { target: { value: 'cl-1' } })
  await waitFor(() => expect(screen.getByLabelText(itPrestampati.cercaAlunno)).toBeInTheDocument())
  return utils
}

describe('PrestampatiSegreteria — chi entra nell’elenco dei bambini', () => {
  it('il RITIRATO non compare, il SOSPESO sì: è il confine del server, non un altro', async () => {
    await scegliLaClasse()

    expect(screen.getByRole('button', { name: 'Iscritta Prova' })).toBeInTheDocument()
    // Un bambino sospeso frequenta: i suoi documenti si generano.
    expect(screen.getByRole('button', { name: 'Sospesa Prova' })).toBeInTheDocument()
    // Un ritirato no: `caricaPrefillAlunno` risponderebbe 409 dopo il modulo compilato.
    expect(screen.queryByRole('button', { name: 'Ritirata Prova' })).not.toBeInTheDocument()
  })

  it('l’elenco si legge per la classe scelta, e la ricerca è PER NOME', async () => {
    await scegliLaClasse()

    const p = new URLSearchParams({ scuola_id: SEDE, classe_sezione: 'Sezione Gialla' })
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/students?${p.toString()}`)

    fireEvent.change(screen.getByLabelText(itPrestampati.cercaAlunno), {
      target: { value: 'sospe' },
    })
    expect(screen.getByRole('button', { name: 'Sospesa Prova' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Iscritta Prova' })).not.toBeInTheDocument()

    // Una ricerca senza esiti lo dice: la lista vuota da sola non distingue «non c'è» da
    // «non ho cercato».
    fireEvent.change(screen.getByLabelText(itPrestampati.cercaAlunno), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText(itPrestampati.nessunRisultato)).toBeInTheDocument()
  })

  it('scelto il bambino, «Cambia bambino» riapre la ricerca', async () => {
    await scegliLaClasse()

    fireEvent.click(screen.getByRole('button', { name: 'Iscritta Prova' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: itPrestampati.cambiaAlunno })).toBeInTheDocument(),
    )
    expect(screen.queryByLabelText(itPrestampati.cercaAlunno)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itPrestampati.cambiaAlunno }))
    expect(screen.getByLabelText(itPrestampati.cercaAlunno)).toBeInTheDocument()
  })

  it('lettura FALLITA ≠ classe vuota: lo dice, e offre il ritenta', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/admin/students')) return ok({ error: 'giù' }, 503)
      return ok(rispostaPredefinita(String(url)))
    })

    render(<PrestampatiSegreteria />)
    const classe = await screen.findByLabelText(itPrestampati.scegliClasse)
    fireEvent.change(classe, { target: { value: 'cl-1' } })

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itPrestampati.erroreElenco)
    // «Nessun bambino in questa classe» sarebbe un'affermazione di fatto, e falsa.
    expect(screen.queryByText(itPrestampati.vuotoAlunni)).not.toBeInTheDocument()

    fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(String(url))))
    fireEvent.click(within(avviso).getByRole('button', { name: itPrestampati.riprova }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Iscritta Prova' })).toBeInTheDocument(),
    )
  })

  it('classe DAVVERO vuota: nessun avviso rosso, la frase del vuoto', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/admin/students')) return ok([])
      return ok(rispostaPredefinita(String(url)))
    })

    render(<PrestampatiSegreteria />)
    const classe = await screen.findByLabelText(itPrestampati.scegliClasse)
    fireEvent.change(classe, { target: { value: 'cl-1' } })

    await waitFor(() => expect(screen.getByText(itPrestampati.vuotoAlunni)).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
