import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'

/**
 * IL CATALOGO DEI PRESTAMPATI — la barra filtri sopra la griglia dei diciassette.
 *
 * ─── LA COSA CHE QUESTA GRIGLIA FA E LE ALTRE LINGUETTE NO ──────────────────────
 *
 * Qui la ricerca **ordina**, non solo scarta. Diciassette voci in una griglia a due colonne
 * non si scorrono: chi scrive «cert» deve trovarsi «Certificato di servizio» in cima, non
 * nella posizione in cui il registro l'aveva messo. Sulle altre tre linguette l'ordine è
 * quello della tabella e non si tocca — la differenza è misurata qui.
 *
 * ⚠️ Nessun dato personale nei dati di prova: il repository è pubblico.
 */

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/**
 * ⚠️ MOCK LOCALE DI next-intl, come negli altri quattro banchi di questo pannello.
 *
 * Il mock globale di `test/setup.ts` risolve `it[ns][chiave]` con una chiave PIATTA, e il
 * nome dei modelli sta in una chiave ANNIDATA (`modelli.schedaSanitaria`): col globale ogni
 * card mostrerebbe la stringa «prestampatiSegreteria.modelli.schedaSanitaria», e un'asserzione
 * sull'ordine dei nomi sarebbe verde su testi che nessuno legge. Qui il traduttore è quello
 * vero di `use-intl`, che l'annidamento lo sa fare.
 */
vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const prestampatiSegreteria = (await import('../../messages/it/prestampatiSegreteria.json')).default
  const shared = (await import('../../messages/it/shared.json')).default
  const adminModulistica = (await import('../../messages/it/adminModulistica.json')).default
  const cataloghi = { prestampatiSegreteria, shared, adminModulistica }
  // Un `t` solo per namespace: il pannello mette `t` fra le dipendenze di un `useCallback`, e
  // un'identità nuova a ogni render farebbe ricaricare la scheda all'infinito.
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

/** Cinque modelli VERI del registro: la famiglia si ricava dallo slug, e dev'essere vera. */
const MODELLI = [
  { slug: 'scheda_sanitaria', etichetta: 'Scheda sanitaria', soggetto: 'alunno', firma: 'otp_genitore', protocollo: 'nessuno', archiviazione: 'student_documents', generabile: true },
  { slug: 'certificato_iscrizione_frequenza', etichetta: 'Certificato di iscrizione e frequenza', soggetto: 'alunno', firma: 'legale_rappresentante', protocollo: 'uscita', archiviazione: 'student_documents', generabile: true },
  { slug: 'stampe_sezione', etichetta: 'Stampe di sezione', soggetto: 'sezione', firma: 'nessuna', protocollo: 'nessuno', archiviazione: 'nessuna', generabile: true },
  { slug: 'registro_presenze', etichetta: 'Registro presenze', soggetto: 'sezione', firma: 'nessuna', protocollo: 'nessuno', archiviazione: 'nessuna', generabile: true },
  { slug: 'certificato_servizio', etichetta: 'Certificato di servizio', soggetto: 'dipendente', firma: 'legale_rappresentante', protocollo: 'uscita', archiviazione: 'nessuna', generabile: false, motivo: 'fonte_dati_assente' },
]

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/prestampati')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: { modelli: MODELLI } }) })
  }
  if (url.includes('/api/admin/sections')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: 'cl-1', name: 'Sezione Gialla' }] })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/admin/modulistica?tab=prestampati')
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

/**
 * I NOMI COME LI LEGGE LA SEGRETERIA, cioè quelli del CATALOGO — non il campo `etichetta`
 * che il server manda, che è italiano di servizio e serve ai log e al nome del file.
 * Si leggono dal JSON e non si ricopiano: una prova che ripete a mano il testo atteso resta
 * verde anche quando il catalogo cambia sotto.
 */
const NOME = itPrestampati.modelli as Record<string, string>
const TUTTI_I_NOMI = [
  NOME.schedaSanitaria,
  NOME.certificatoIscrizioneFrequenza,
  NOME.stampeSezione,
  NOME.registroPresenze,
  NOME.certificatoServizio,
]

/** I nomi dei modelli nella griglia dei generabili, NELL'ORDINE in cui si leggono. */
function nomiInGriglia(): string[] {
  return screen
    .getAllByRole('button', { pressed: false })
    .map((b) => b.querySelector('span')?.textContent ?? '')
    .filter((n) => TUTTI_I_NOMI.includes(n))
}

async function monta() {
  render(<PrestampatiSegreteria />)
  await waitFor(() => expect(screen.getByText(NOME.schedaSanitaria)).toBeInTheDocument())
}

describe('PrestampatiSegreteria — la barra filtri del catalogo', () => {
  it('la barra c’è, e conta tutti e cinque i modelli (anche quello spento)', async () => {
    await monta()
    expect(screen.getByLabelText('Cerca un modello')).toBeInTheDocument()
    // Il totale è il CATALOGO, non i soli generabili: «4 su 5» dopo aver spento un filtro
    // che nessuno ha messo sarebbe una bugia sul catalogo.
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('5 risultati su 5')
  })

  it('il soggetto usa le parole delle pastiglie della griglia, e restringe', async () => {
    await monta()
    // «Una sezione intera» è la STESSA etichetta che ogni card mostra nella sua pastiglia.
    fireEvent.click(screen.getAllByRole('button', { name: /^Una sezione intera/ })[0])

    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('2 risultati su 5'),
    )
    expect(nomiInGriglia().sort()).toEqual([NOME.registroPresenze, NOME.stampeSezione].sort())
  })

  it('«Solo quelli che posso generare» porta via la sezione dei modelli spenti', async () => {
    await monta()
    expect(screen.getByText(itPrestampati.moduliNonGenerabili)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Solo quelli che posso generare' }))

    await waitFor(() =>
      expect(screen.queryByText(itPrestampati.moduliNonGenerabili)).toBeNull(),
    )
    expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('4 risultati su 5')
  })

  it('la ricerca ORDINA per qualità della corrispondenza, non solo scarta', async () => {
    await monta()
    // ⚠️ LA QUERY È SCELTA PERCHÉ DUE MODELLI **GENERABILI** CORRISPONDANO CON RANGHI DIVERSI,
    // e non è pignoleria: al primo giro questo test cercava «certificato» e passava anche con
    // il riordino TOLTO, perché dei due modelli che corrispondevano uno era spento e finiva
    // nell'altra sezione — in griglia ne restava uno solo, e un elenco di un elemento è
    // ordinato in qualunque ordine. Misurato con una mutazione: il test era verde sul codice
    // rotto, cioè non misurava niente.
    //
    // Con «re»: «Registro presenze mensile» comincia con la query (rango 0), «Certificato di
    // iscrizione e frequenza» la nasconde dentro «frequenza» (rango 2). Il server li manda
    // nell'ordine opposto, quindi solo il riordino può metterli così.
    fireEvent.change(screen.getByLabelText('Cerca un modello'), { target: { value: 're' } })

    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('2 risultati su 5'),
    )
    expect(nomiInGriglia()).toEqual([
      NOME.registroPresenze,
      NOME.certificatoIscrizioneFrequenza,
    ])
  })

  it('un filtro che non lascia passare nulla dice «nessun risultato», e si può pulire', async () => {
    await monta()
    fireEvent.change(screen.getByLabelText('Cerca un modello'), {
      target: { value: 'qwertyuiop-nessuna-corrispondenza' },
    })

    await waitFor(() =>
      expect(screen.getByText('Nessun risultato con questi filtri')).toBeInTheDocument(),
    )
    // ⚠️ NON è lo stato «vuoto»: il catalogo ha cinque modelli, e dire «non c'è ancora nulla
    // qui» accuserebbe di vuoto un elenco pieno.
    expect(screen.queryByText('Non c’è ancora nulla qui')).toBeNull()

    fireEvent.click(
      within(screen.getByTestId('stato-catalogo-prestampati')).getByText('Pulisci filtri'),
    )
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('5 risultati su 5'),
    )
  })

  it('scegliere un modello e poi filtrarlo via non cancella il lavoro cominciato', async () => {
    await monta()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(NOME.schedaSanitaria) }))
    await waitFor(() => expect(screen.getByText(itPrestampati.campiTitolo)).toBeInTheDocument())

    // Il filtro toglie dalla GRIGLIA il modello scelto: la scheda già aperta resta, perché
    // restringere un catalogo è un gesto di ricerca, non un annullamento.
    fireEvent.click(screen.getAllByRole('button', { name: /^Una sezione intera/ })[0])
    await waitFor(() =>
      expect(screen.getByTestId('conteggio-risultati')).toHaveTextContent('2 risultati su 5'),
    )
    expect(screen.getByText(itPrestampati.campiTitolo)).toBeInTheDocument()
  })
})
