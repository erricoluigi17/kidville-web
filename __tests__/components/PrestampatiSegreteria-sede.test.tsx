import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'

/**
 * IL BANCO DEI PRESTAMPATI — la SEDE, che è il primo passo e quello che decide tutto il resto.
 *
 * Perché questo file esiste, e perché guarda proprio la sede.
 *
 * Le sedi hanno TRE stati, non due: le ho («scegli quale»), non ne ho, e **non ho saputo
 * quali hai**. Il terzo il repo l'ha già pagato una volta: fino al 2026-08-12 un guasto di
 * `/api/admin/sedi` lasciava `sedi = []`, cioè lo stesso valore di «non ne hai», e l'utente
 * riceveva su almeno sette pagine un'istruzione impossibile — «scegline una dal menu in
 * alto» — mentre quel menu, con l'elenco vuoto, non si monta affatto. Nessun log, nessun
 * errore: solo una segretaria bloccata.
 *
 * Su questa linguetta la posta è più alta che altrove, per due motivi:
 *
 *  · la sede non è un filtro di lettura ma il plesso che si DICHIARA alla generazione:
 *    `resolveScuolaScrittura` risponde 400 a chi ne ha più d'una e non la indica, e con tre
 *    plessi in produzione quello è il caso normale;
 *  · il pannello sta di proposito PRIMA della guardia di sede della pagina
 *    (`admin/modulistica/page.tsx`), perché la sede se la sceglie qui dentro. Quindi la rete
 *    di sicurezza di `SedeNotice` — che i tre stati li implementa — qui non c'è: dirli tocca
 *    a questo pannello, e se non li dice non li dice nessuno.
 *
 * Il difetto che questo file rende rosso: con `errore` buttato via, l'elenco vuoto faceva
 * sparire la tendina (si monta solo con più di una sede) e a schermo restava «Scegli la sede
 * prima di generare il documento» — un ordine che nessun clic può eseguire.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/**
 * Le traduzioni VERE del namespace, non il mock globale di `test/setup.ts`: quello risolve
 * solo i venticinque namespace che elenca, e su `prestampatiSegreteria` restituirebbe il nome
 * della chiave. Un test che asserisce su `prestampatiSegreteria.erroreSedi` sarebbe verde
 * anche con il catalogo vuoto.
 */
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

const SEDE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

/** Il contesto delle sedi, PILOTABILE: è la leva con cui si mettono in scena i tre stati. */
const contestoSedi = {
  sedi: [
    { id: SEDE_A, nome: 'Kidville Giugliano' },
    { id: SEDE_B, nome: 'Kidville Aversa' },
  ] as { id: string; nome: string }[],
  errore: false,
  loading: false,
}
const ricaricaSedi = vi.fn()

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: contestoSedi.sedi,
    errore: contestoSedi.errore,
    selezionate: [],
    effettive: contestoSedi.sedi.map((s) => s.id),
    sedeCorrente: contestoSedi.sedi.length === 1 ? contestoSedi.sedi[0].id : null,
    reFetchKey: contestoSedi.sedi.map((s) => s.id).join(','),
    epocaSede: 0,
    loading: contestoSedi.loading,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: ricaricaSedi,
  }),
}))

/** Un modello qualunque: serve solo a far rispondere l'elenco, che parte al montaggio. */
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

const fetchMock = vi.fn()

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.startsWith('/api/admin/sections')) return CLASSI
  if (u.startsWith('/api/admin/students')) return []
  return { success: true, data: { modelli: MODELLI } }
}

beforeEach(() => {
  vi.clearAllMocks()
  contestoSedi.sedi = [
    { id: SEDE_A, nome: 'Kidville Giugliano' },
    { id: SEDE_B, nome: 'Kidville Aversa' },
  ]
  contestoSedi.errore = false
  contestoSedi.loading = false
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(url)))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

/** Il primo passo del percorso: è lì che la sede si sceglie, e lì che i tre stati si vedono. */
const passoSoggetto = () =>
  screen.getByRole('region', { name: itPrestampati.passoSoggetto })

describe('PrestampatiSegreteria — la sede ha tre stati, non due', () => {
  it('CARICAMENTO: dice che sta caricando, non «scegli la sede»', async () => {
    contestoSedi.loading = true
    render(<PrestampatiSegreteria />)

    expect(within(passoSoggetto()).getByText(itPrestampati.caricamento)).toBeInTheDocument()
    // L'ordine impossibile: chiedere di scegliere mentre non c'è niente da scegliere.
    expect(screen.queryByText(itPrestampati.sedeDaScegliere)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(itPrestampati.scegliSede)).not.toBeInTheDocument()
  })

  it('ERRORE: lo DICE con role="alert" e offre un «Riprova» che ritenta davvero', async () => {
    contestoSedi.errore = true
    contestoSedi.sedi = []
    const { rerender } = render(<PrestampatiSegreteria />)

    const avviso = within(passoSoggetto()).getByRole('alert')
    expect(avviso).toHaveTextContent(itPrestampati.erroreSedi)
    // «Non so quali sedi hai» non è «scegline una»: la frase della scelta non compare.
    expect(screen.queryByText(itPrestampati.sedeDaScegliere)).not.toBeInTheDocument()

    // Il rimedio è quello del contesto — `ricarica()` — non un ricaricamento alla cieca.
    fireEvent.click(within(avviso).getByRole('button', { name: itPrestampati.riprova }))
    expect(ricaricaSedi).toHaveBeenCalledTimes(1)

    // …e quando il ritenta va a buon fine, il pannello riparte dal passo 1.
    contestoSedi.errore = false
    contestoSedi.sedi = [
      { id: SEDE_A, nome: 'Kidville Giugliano' },
      { id: SEDE_B, nome: 'Kidville Aversa' },
    ]
    rerender(<PrestampatiSegreteria />)
    await waitFor(() =>
      expect(screen.getByLabelText(itPrestampati.scegliSede)).toBeInTheDocument(),
    )
    expect(within(passoSoggetto()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('CARICATE: con più sedi si sceglie, e la scelta sblocca le classi', async () => {
    render(<PrestampatiSegreteria />)

    const tendina = await screen.findByLabelText(itPrestampati.scegliSede)
    expect(within(tendina).getByText('Kidville Giugliano')).toBeInTheDocument()
    expect(within(tendina).getByText('Kidville Aversa')).toBeInTheDocument()
    // Finché nessuna sede è dichiarata il passo 1 lo dice, e non chiede altro.
    expect(screen.getByText(itPrestampati.sedeDaScegliere)).toBeInTheDocument()

    fireEvent.change(tendina, { target: { value: SEDE_B } })

    await waitFor(() =>
      expect(screen.getByLabelText(itPrestampati.scegliClasse)).toBeInTheDocument(),
    )
    // Le classi si leggono per la sede DICHIARATA, non per una indovinata.
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/sections?scuola_id=${encodeURIComponent(SEDE_B)}`,
    )
  })

  it('UNA SOLA sede attiva: non si chiede, si usa — nessuna tendina con una voce sola', async () => {
    contestoSedi.sedi = [{ id: SEDE_A, nome: 'Kidville Giugliano' }]
    render(<PrestampatiSegreteria />)

    await waitFor(() =>
      expect(screen.getByLabelText(itPrestampati.scegliClasse)).toBeInTheDocument(),
    )
    expect(screen.queryByLabelText(itPrestampati.scegliSede)).not.toBeInTheDocument()
    expect(screen.queryByText(itPrestampati.sedeDaScegliere)).not.toBeInTheDocument()
  })
})
