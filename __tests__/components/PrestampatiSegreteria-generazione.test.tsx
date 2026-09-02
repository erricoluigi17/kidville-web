import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'

/**
 * IL BANCO DEI PRESTAMPATI — la generazione: cosa si dice quando il foglio non nasce, e cosa
 * quando nasce.
 *
 * Le tre cose che questo file sorveglia:
 *
 *  · IL «MOTIVO» LO TRADUCE IL PANNELLO. Il rifiuto del server porta due campi diversi:
 *    `motivo` è un enumerato stabile (`legale_rappresentante_assente`, `fonte_dati_assente`,
 *    …) e `error` è PROSA, che nasce dove il locale non esiste ed è quindi italiana per
 *    costruzione. Mostrare la seconda dentro un'interfaccia inglese è il difetto che i codici
 *    d'errore hanno chiuso una volta (collaudo del 31/07: «Sede non accessibile» in mezzo a
 *    una pagina in inglese). Qui il finto server manda la prosa APPOSTA: se comparisse a
 *    schermo, il test è rosso.
 *
 *  · GLI ERRORI DI CAMPO NON SOPRAVVIVONO AL BAMBINO. Le risposte si azzerano da sole (la
 *    chiave della scheda non combacia più), ma `erroriCampo` è una mappa a parte: senza
 *    azzerarla, i «Campo obbligatorio» rossi della pratica di un bambino restavano accesi sul
 *    modulo bianco del bambino dopo, su campi che nessuno aveva ancora toccato.
 *
 *  · DOPO IL DOCUMENTO SI SA COME SI RIPARTE. Il comando «Genera» sparisce di proposito —
 *    un foglio che ha già consumato un numero di protocollo non si rifà con un secondo clic
 *    distratto — ma un pulsante che sparisce senza che niente lo dica lascia chi deve
 *    correggere un campo davanti al documento di prima e a nessuna strada evidente.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const prestampatiSegreteria = (await import('../../messages/it/prestampatiSegreteria.json'))
    .default
  const shared = (await import('../../messages/it/shared.json')).default
  // `adminModulistica` dal 2026-09-01: il pannello ci prende le etichette dei campi della sua
  // barra filtri. Senza, il finto risolverebbe quelle chiavi nel proprio nome e la console si
  // riempirebbe di errori di traduzione su una schermata sana.
  const adminModulistica = (await import('../../messages/it/adminModulistica.json')).default
  const cataloghi = { prestampatiSegreteria, shared, adminModulistica }
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

const CLASSI = [{ id: 'cl-1', name: 'Sezione Gialla' }]
const ALUNNI = [
  { id: 'al-1', nome: 'Prova', cognome: 'Iscritta', stato: 'iscritto' },
  { id: 'al-2', nome: 'Prova', cognome: 'Seconda', stato: 'iscritto' },
]

/** Un solo campo, obbligatorio: è quanto basta perché l'assenza si veda. */
const CAMPO = {
  nome: 'uso',
  etichetta: 'Uso dichiarato',
  tipo: 'testo',
  obbligatorio: true,
  chiestoA: 'segreteria',
}

/** La scheda del modello per un bambino: il precompilato più il solo delta da chiedere. */
function scheda(alunnoId: string) {
  return {
    success: true,
    data: {
      modello: { ...MODELLO, campi: [CAMPO] },
      prefill: {
        soggetto: 'alunno',
        alunnoId,
        scuolaId: SEDE,
        sezioneId: 'cl-1',
        legaleRappresentante: 'Legale Rappresentante',
        dati: {
          alunno: {
            nome: 'Prova',
            cognome: alunnoId === 'al-1' ? 'Iscritta' : 'Seconda',
            dataNascita: '2021-03-04',
            // Un codice fiscale palesemente finto: il repository è pubblico.
            codiceFiscale: 'AAAAAA00A00A000A',
            sezione: 'Sezione Gialla',
          },
          annoScolastico: '2026/2027',
        },
      },
    },
  }
}

const fetchMock = vi.fn()

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

/** La risposta del POST quando il foglio nasce: un PDF e tre header che raccontano com'è andata. */
function rispostaPdf(intestazioni: Record<string, string>) {
  const mappa = Object.fromEntries(
    Object.entries(intestazioni).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (nome: string) => mappa[nome.toLowerCase()] ?? null },
    blob: async () => new Blob(['%PDF-finto'], { type: 'application/pdf' }),
    json: async () => null,
  })
}

function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.startsWith('/api/admin/sections')) return CLASSI
  if (u.startsWith('/api/admin/students')) return ALUNNI
  if (u.includes('alunnoId=')) return scheda(u.includes('alunnoId=al-2') ? 'al-2' : 'al-1')
  return { success: true, data: { modelli: [MODELLO] } }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(String(url))))
  vi.stubGlobal('fetch', fetchMock)
  // jsdom non ha né l'una né l'altra: il PDF vive in un blob finché non si scarica.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:prestampato'),
    revokeObjectURL: vi.fn(),
  })
  // Il download è un `<a>` che si clicca da solo: senza questo, jsdom prova a navigare.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

/** Il percorso intero fino al modulo del delta: classe → bambino → modello. */
async function finoAlModulo(cognome = 'Iscritta') {
  const utils = render(<PrestampatiSegreteria />)
  fireEvent.change(await screen.findByLabelText(itPrestampati.scegliClasse), {
    target: { value: 'cl-1' },
  })
  fireEvent.click(await screen.findByRole('button', { name: `${cognome} Prova` }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(NOME_MODELLO) }))
  await waitFor(() => expect(screen.getByLabelText(/Uso dichiarato/)).toBeInTheDocument())
  return utils
}

const pulsanteGenera = () => screen.getByRole('button', { name: itPrestampati.genera })

/**
 * Il riquadro dell'esito, aspettato per la sua FRASE e preso RISALENDO da quella.
 *
 * «Generazione in corso…» ha anch'essa `role="status"` — deve averlo, è ciò che annuncia
 * l'attesa a chi non guarda lo schermo — e `findByRole('status')` si accontenterebbe di
 * quella, cioè misurerebbe l'attesa credendo di misurare l'esito.
 *
 * ⚠️ E FINO AL 2026-09-01 NON BASTAVA. Dopo aver aspettato la frase giusta, questa funzione
 * tornava `getByRole('status')`: una premessa sul NUMERO di regioni annunciate nella
 * schermata, non sul riquadro. La barra filtri del catalogo ne ha aggiunta una legittima — il
 * conteggio «1 risultato su 1», che deve essere annunciato a chi non vede l'elenco
 * accorciarsi — e i tre `it` che passavano di qui sono diventati rossi senza che il
 * comportamento sorvegliato fosse cambiato di un carattere. Ora si RISALE dalla frase al suo
 * contenitore: il riquadro è legato a ciò che dice, non a quanti vicini ha.
 */
async function attendiIlDocumento() {
  const conferma = await screen.findByText(itPrestampati.confermaGenerato)
  const riquadro = conferma.closest('[role="status"]')
  expect(riquadro, 'la conferma non vive dentro una regione annunciata').not.toBeNull()
  return riquadro as HTMLElement
}

describe('PrestampatiSegreteria — il rifiuto della generazione', () => {
  it('il 422 col MOTIVO mostra la frase del catalogo, non la prosa del server', async () => {
    await finoAlModulo()
    fireEvent.change(screen.getByLabelText(/Uso dichiarato/), { target: { value: 'Bonus INPS' } })

    const PROSA_DEL_SERVER =
      'Manca il nome del legale rappresentante in scuole.config.anagrafica.'
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return ok(
          {
            error: PROSA_DEL_SERVER,
            codice: 'PRESTAMPATO_DATI_MANCANTI',
            motivo: 'legale_rappresentante_assente',
          },
          422,
        )
      }
      return ok(rispostaPredefinita(String(url)))
    })

    fireEvent.click(pulsanteGenera())

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itPrestampati.motivoLegaleRappresentanteAssente)
    expect(screen.queryByText(PROSA_DEL_SERVER)).not.toBeInTheDocument()
    // Il documento non è nato: nessuna conferma verde, nessun protocollo annunciato.
    expect(screen.queryByText(itPrestampati.confermaGenerato)).not.toBeInTheDocument()
  })

  it('il 400 di validazione appende l’errore AL CAMPO, per il `path` che il server nomina', async () => {
    await finoAlModulo()
    fireEvent.change(screen.getByLabelText(/Uso dichiarato/), { target: { value: 'x' } })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return ok(
          { error: 'Dati non validi', details: [{ path: 'uso', message: 'Troppo corto' }] },
          400,
        )
      }
      return ok(rispostaPredefinita(String(url)))
    })

    fireEvent.click(pulsanteGenera())

    await waitFor(() =>
      expect(screen.getByLabelText(/Uso dichiarato/)).toHaveAccessibleDescription('Troppo corto'),
    )
  })
})

describe('PrestampatiSegreteria — gli errori di campo e il cambio di bambino', () => {
  it('il campo obbligatorio vuoto ferma la generazione PRIMA del POST', async () => {
    await finoAlModulo()
    fireEvent.click(pulsanteGenera())

    await waitFor(() =>
      expect(screen.getByLabelText(/Uso dichiarato/)).toHaveAccessibleDescription(
        itPrestampati.campoObbligatorio,
      ),
    )
    // Nessun POST: su un foglio protocollato una prova a vuoto brucerebbe un numero.
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('cambiato bambino, i rossi della pratica di prima se ne vanno con lei', async () => {
    await finoAlModulo()
    fireEvent.click(pulsanteGenera())
    await waitFor(() =>
      expect(screen.getByLabelText(/Uso dichiarato/)).toHaveAccessibleDescription(
        itPrestampati.campoObbligatorio,
      ),
    )
    expect(screen.getByText(itPrestampati.campoNonValido)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itPrestampati.cambiaAlunno }))
    fireEvent.click(await screen.findByRole('button', { name: 'Seconda Prova' }))

    // Il modulo del bambino nuovo è bianco: nessun errore su campi che nessuno ha toccato.
    await waitFor(() => expect(screen.getByLabelText(/Uso dichiarato/)).toHaveValue(''))
    expect(screen.getByLabelText(/Uso dichiarato/)).not.toHaveAccessibleDescription()
    expect(screen.queryByText(itPrestampati.campoNonValido)).not.toBeInTheDocument()
  })
})

describe('PrestampatiSegreteria — il documento nato', () => {
  it('dice il protocollo, l’archiviazione e COME SI RIPARTE', async () => {
    await finoAlModulo()
    fireEvent.change(screen.getByLabelText(/Uso dichiarato/), { target: { value: 'Bonus INPS' } })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return rispostaPdf({
          'Content-Disposition': 'attachment; filename="certificato.pdf"',
          'X-Prestampato-Protocollo': '2026/000123',
          'X-Prestampato-Archiviato': 'archiviato',
        })
      }
      return ok(rispostaPredefinita(String(url)))
    })

    fireEvent.click(pulsanteGenera())

    const conferma = await attendiIlDocumento()
    expect(conferma).toHaveTextContent(itPrestampati.confermaGenerato)
    expect(conferma).toHaveTextContent('2026/000123')
    expect(conferma).toHaveTextContent(itPrestampati.confermaArchiviato)
    // Il comando è sparito di proposito: la strada per rifarne uno sta scritta accanto.
    expect(screen.queryByRole('button', { name: itPrestampati.genera })).not.toBeInTheDocument()
    expect(conferma).toHaveTextContent(itPrestampati.esitoRiparti)

    // …e «Chiudi» rimette davvero il comando.
    fireEvent.click(within(conferma).getByRole('button', { name: itPrestampati.chiudi }))
    expect(pulsanteGenera()).toBeInTheDocument()
  })

  it('la richiesta DICHIARA la sua sede, e manda solo il delta compilato', async () => {
    await finoAlModulo()
    fireEvent.change(screen.getByLabelText(/Uso dichiarato/), { target: { value: 'Bonus INPS' } })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return rispostaPdf({ 'X-Prestampato-Archiviato': 'archiviato' })
      }
      return ok(rispostaPredefinita(String(url)))
    })

    fireEvent.click(pulsanteGenera())
    await attendiIlDocumento()

    const invio = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(invio?.[0]).toBe('/api/prestampati/genera')
    // Con tre plessi in produzione una scrittura senza sede è un 400: la sede si dichiara.
    expect(JSON.parse(String((invio?.[1] as RequestInit).body))).toEqual({
      modello: SLUG,
      scuolaId: SEDE,
      alunnoId: 'al-1',
      risposte: { uso: 'Bonus INPS' },
    })
  })

  it('archiviazione FALLITA: il foglio c’è, ma nel fascicolo non è entrato — e si dice', async () => {
    await finoAlModulo()
    fireEvent.change(screen.getByLabelText(/Uso dichiarato/), { target: { value: 'Bonus INPS' } })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return rispostaPdf({
          'X-Prestampato-Archiviato': 'fallita',
          'X-Prestampato-Incompleto': '1',
        })
      }
      return ok(rispostaPredefinita(String(url)))
    })

    fireEvent.click(pulsanteGenera())

    const conferma = await attendiIlDocumento()
    expect(conferma).toHaveTextContent(itPrestampati.archiviazioneFallita)
    expect(conferma).toHaveTextContent(itPrestampati.documentoIncompleto)
    expect(conferma).not.toHaveTextContent(itPrestampati.confermaArchiviato)
  })
})
