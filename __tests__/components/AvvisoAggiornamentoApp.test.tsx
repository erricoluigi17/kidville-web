import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import sharedIt from '../../messages/it/shared.json'

/**
 * Il pop-up «Aggiorna l'app» (spec 2026-09-29), montato in `RootProviders` dentro il gate
 * biometrico. Chi deve aggiornare lo decide `@/lib/native/aggiornamento-app` (verificato in
 * `__tests__/lib/aggiornamento-app.test.ts`); qui si guarda CIÒ CHE SI VEDE e CIÒ CHE SI TOCCA:
 *  - compare SOLO sul binario sotto la minima (1.0): mai sul web, mai sulla 1.1;
 *  - «Aggiorna ora» porta alla scheda dello store della piattaforma; «Più tardi» (ed Esc, e
 *    Indietro su Android) chiude;
 *  - «a ogni apertura»: chiuso, ricompare al ritorno in primo piano dopo ≥ 30 minuti in
 *    background, non dopo un passaggio lampo a un'altra app;
 *  - non si apre mentre il gate biometrico blocca (la `Modal` renderebbe inerte lo sblocco);
 *  - StrictMode e rimontaggi non raddoppiano la comparsa né il log.
 *
 * LA MINIMA DEL PERSONALE (spec 2026-10-02, T14), spedita ACCESA SU ANDROID (1.2, dal 2026-10-04) e
 * SPENTA SU iOS: l'ultimo blocco di questo file la ACCENDE a 1.2 su entrambe (`stato.minimaPersonale`,
 * iniettata dove la libreria userebbe il valore spedito) e guarda ciò che si vede: il personale sotto
 * la 1.2 vede il pop-up COL SUO TESTO, il personale alla 1.2 e il genitore no; e prova il valore
 * spedito, piattaforma per piattaforma. Il ruolo arriva da `leggiProfili` (finta qui, e spia); chi
 * lavora con l'app lo decide la libreria vera, verificata in `__tests__/lib/aggiornamento-app.test.ts`.
 * Tutti gli altri test di questo file girano col valore spedito e senza un ruolo noto: lì decide la
 * sola minima dello store, e il corpo è quello di sempre.
 *
 * La decisione è di SESSIONE, cioè di modulo: ogni test ricarica il modulo (`vi.resetModules`).
 */

type Profilo = { ruolo: string; area: string }

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  versione: '1.0',
  bloccato: false,
  visibilita: 'visible' as DocumentVisibilityState,
  ora: Date.UTC(2026, 8, 29, 8, 0, 0),
  /** La minima del personale di questo test; `null` = il valore spedito (Android 1.2, iOS spenta). */
  minimaPersonale: null as { ios: string | null; android: string | null } | null,
  /** I profili che `/api/me` darebbe alla sessione; `null` = «non lo so». */
  profili: null as Profilo[] | null,
}))

// La lettura dei profili: finta, e spia (con la minima del personale spenta, o già alla pari, non
// deve partire nessuna richiesta).
const leggiProfili = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/use-profili', () => ({ leggiProfili }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => stato.piattaforma,
    isPluginAvailable: (nome: string) => nome === 'App',
  },
}))

const getInfo = vi.hoisted(() => vi.fn(async () => ({ version: stato.versione, build: '1' })))
vi.mock('@capacitor/app', () => ({ App: { getInfo, addListener: vi.fn(async () => ({ remove: vi.fn() })) } }))

vi.mock('@/components/providers/BiometricGate', () => ({ useBloccoBiometrico: () => stato.bloccato }))

// La navigazione vera (`window.location.assign`) in jsdom non si osserva: si passa alla funzione
// VERA un apri-url spia, così URL e piattaforma restano quelli del codice di produzione.
// Idem per la decisione: gira la funzione VERA, e l'unica cosa iniettata è la minima del personale
// quando il test la sceglie (altrimenti vale `VERSIONE_MINIMA_PERSONALE`, il valore spedito). Gli
// argomenti che il componente passasse comunque hanno la precedenza.
const apriUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/native/aggiornamento-app', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/aggiornamento-app')>()
  return {
    ...vero,
    apriSchedaStore: () => vero.apriSchedaStore(apriUrl),
    appDaAggiornare: (
      minime: Parameters<typeof vero.appDaAggiornare>[0] = vero.VERSIONE_MINIMA_STORE,
      minimePersonale: Parameters<typeof vero.appDaAggiornare>[1] = stato.minimaPersonale ?? vero.VERSIONE_MINIMA_PERSONALE,
    ) => vero.appDaAggiornare(minime, minimePersonale),
  }
})

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

const T = sharedIt as Record<string, string>
const MINUTO = 60_000

type Componente = typeof import('@/components/providers/AvvisoAggiornamentoApp').AvvisoAggiornamentoApp

function albero(Avviso: Componente, strict = false) {
  const a = (
    <NextIntlClientProvider locale="it" messages={{ shared: sharedIt }}>
      <Avviso />
    </NextIntlClientProvider>
  )
  return strict ? <StrictMode>{a}</StrictMode> : a
}

async function monta(strict = false) {
  vi.resetModules()
  const { AvvisoAggiornamentoApp } = await import('@/components/providers/AvvisoAggiornamentoApp')
  return { ...render(albero(AvvisoAggiornamentoApp, strict)), Avviso: AvvisoAggiornamentoApp }
}

/** Lascia risolvere la decisione (getInfo è asincrono) e applicare lo stato che ne segue. */
async function lasciaDecidere() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function cambiaVisibilita(v: DocumentVisibilityState) {
  stato.visibilita = v
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function messaggiLog(): string[] {
  return logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)
}

/**
 * Il messaggio porta PIATTAFORMA E VERSIONE, e non per ornamento: `app_log` accorpa le righe per
 * impronta, e l'impronta contiene il messaggio ma NON la piattaforma né i `campi`. Col solo
 * «avviso-aggiorna-app-mostrato», senza utente (pagina di login), tutte le comparse del giorno
 * finivano in UNA riga con piattaforma e versione della prima: una comparsa sulla 1.1 sarebbe
 * stata contata sotto la «1.0» senza lasciare traccia (misurato il 29/09, dopo il deploy #174).
 */
const M = (azione: string, piattaforma = 'android', versione = '1.0') =>
  `avviso-aggiorna-app-${azione}: ${piattaforma} ${versione}`

const dialogo = () => screen.queryByRole('dialog')

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.versione = '1.0'
  stato.bloccato = false
  stato.visibilita = 'visible'
  stato.ora = Date.UTC(2026, 8, 29, 8, 0, 0)
  stato.minimaPersonale = null
  stato.profili = null
  getInfo.mockClear()
  apriUrl.mockReset()
  logClient.mockReset()
  leggiProfili.mockReset()
  leggiProfili.mockImplementation(async () => stato.profili)
  vi.spyOn(Date, 'now').mockImplementation(() => stato.ora)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => stato.visibilita })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // Alcuni test si mettono sulla pagina di accesso: il prossimo riparte dalla radice.
  window.history.pushState({}, '', '/')
})

describe('AvvisoAggiornamentoApp — a chi compare', () => {
  it('sul web non rende niente, non chiede la versione e non logga', async () => {
    stato.nativo = false
    const { container } = await monta()
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(getInfo).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it.each(['1.1', '1.2'])('binario %s: niente pop-up', async (versione) => {
    stato.versione = versione
    const { container } = await monta()
    // Si aspetta la PRESENZA di un fatto (la versione è stata letta), non un'assenza.
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(logClient).not.toHaveBeenCalled()
  })

  it.each([
    ['ios', 'https://apps.apple.com/it/app/kidville/id6794883055'],
    ['android', 'https://play.google.com/store/apps/details?id=it.kidville.app'],
  ])('binario 1.0 su %s: «Aggiorna ora» porta alla scheda dello store e chiude', async (piattaforma, url) => {
    stato.piattaforma = piattaforma
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    // Sotto la minima dello store il corpo è quello di sempre, non quello del personale.
    expect(screen.getByText(T.avvisoAggiornaCorpo)).toBeTruthy()
    expect(screen.queryByText(T.avvisoAggiornaCorpoPersonale)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: T.avvisoAggiornaBottone }))
    expect(apriUrl).toHaveBeenCalledWith(url)
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).toEqual([M('mostrato', piattaforma), M('tocco-store', piattaforma)])
    expect(logClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        livello: 'warn',
        evento: 'avvio',
        campi: { piattaforma, esito: 'navigazione-richiesta' },
      }),
    )
  })

  it('il messaggio distingue piattaforma e versione (una riga di app_log per versione)', async () => {
    stato.piattaforma = 'ios'
    stato.versione = '1.0.3'
    await monta()
    await screen.findByRole('dialog')
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-mostrato: ios 1.0.3'])
  })

  it('«Più tardi» chiude e lo registra; non si naviga', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    expect(dialogo()).toBeNull()
    expect(apriUrl).not.toHaveBeenCalled()
    expect(messaggiLog()).toEqual([M('mostrato'), M('rimandato')])
    expect(logClient).toHaveBeenLastCalledWith(expect.objectContaining({ campi: { piattaforma: 'android' } }))
  })

  it('Esc vale «Più tardi»', async () => {
    await monta()
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).toContain(M('rimandato'))
  })

  it('non si chiude toccando fuori: si sceglie uno dei due bottoni', async () => {
    await monta()
    const d = await screen.findByRole('dialog')
    fireEvent.mouseDown(d.parentElement as HTMLElement)
    expect(dialogo()).not.toBeNull()
  })
})

describe('AvvisoAggiornamentoApp — «a ogni apertura»', () => {
  it('rimandato, ricompare tornando in primo piano dopo 30 minuti in background', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    expect(dialogo()).toBeNull()

    cambiaVisibilita('hidden')
    stato.ora += 30 * MINUTO
    cambiaVisibilita('visible')
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(messaggiLog().filter((m) => m === M('mostrato'))).toHaveLength(2)
  })

  it('un passaggio lampo a un\'altra app (5 minuti) non lo ripropone', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))

    cambiaVisibilita('hidden')
    stato.ora += 5 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    expect(dialogo()).toBeNull()
    expect(messaggiLog().filter((m) => m === M('mostrato'))).toHaveLength(1)
  })

  it('anche dopo «Aggiorna ora» senza aggiornare, al ritorno dopo 30 minuti ricompare', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaBottone }))
    cambiaVisibilita('hidden')
    stato.ora += 45 * MINUTO
    cambiaVisibilita('visible')
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('sulla 1.1 il ritorno in primo piano non fa comparire niente', async () => {
    stato.versione = '1.1'
    const { container } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    cambiaVisibilita('hidden')
    stato.ora += 60 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
  })

  it('mai chiuso, il ritorno dopo 30 minuti non conta una seconda comparsa (nemmeno a un rimontaggio)', async () => {
    const { Avviso, unmount } = await monta()
    await screen.findByRole('dialog')
    cambiaVisibilita('hidden')
    stato.ora += 40 * MINUTO
    cambiaVisibilita('visible')
    await lasciaDecidere()
    unmount()
    render(albero(Avviso))
    await lasciaDecidere()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(messaggiLog().filter((m) => m === M('mostrato'))).toHaveLength(1)
  })

  it('rimandato, smontato e rimontato nella stessa sessione non ricompare', async () => {
    const { Avviso, unmount } = await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    unmount()
    const { container } = render(albero(Avviso))
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(getInfo).toHaveBeenCalledTimes(1)
  })
})

describe('AvvisoAggiornamentoApp — gate biometrico e doppio montaggio', () => {
  it('col gate bloccato resta chiuso; allo sblocco compare, e il log «mostrato» parte allora', async () => {
    stato.bloccato = true
    const { Avviso, rerender } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).not.toContain(M('mostrato'))

    stato.bloccato = false
    rerender(albero(Avviso))
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(messaggiLog()).toEqual([M('mostrato')])
  })

  it('StrictMode: la versione si legge una volta, il pop-up compare, un solo log «mostrato»', async () => {
    await monta(true)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await lasciaDecidere()
    expect(getInfo).toHaveBeenCalledTimes(1)
    expect(messaggiLog().filter((m) => m === M('mostrato'))).toHaveLength(1)
  })
})

describe('AvvisoAggiornamentoApp — la minima del personale (T14)', () => {
  const PERSONALE_1_2 = { ios: '1.2', android: '1.2' }
  // Profili con le aree vere di `/api/me`: la decisione si prende sul RUOLO.
  const DOCENTE: Profilo[] = [{ ruolo: 'educator', area: 'teacher' }]
  const GENITORE: Profilo[] = [{ ruolo: 'genitore', area: 'parent' }]

  beforeEach(() => {
    // Accesa a 1.2, su un binario 1.1: l'unica fascia in cui conta CHI sei.
    stato.minimaPersonale = PERSONALE_1_2
    stato.versione = '1.1'
  })

  /**
   * Il log «mostrato» lo scrive un EFFETTO, dopo che il dialogo è comparso: `findByRole` può
   * restituire il controllo prima che quell'effetto sia girato (sotto carico succede, misurato con
   * la cartella `architecture` in parallelo). Si aspetta la PRESENZA della riga, mai si legge il log
   * subito dopo il dialogo.
   */
  const attendiMostrato = (piattaforma = 'android', versione = '1.1', volte = 1) =>
    waitFor(() => expect(messaggiLog().filter((m) => m === M('mostrato', piattaforma, versione))).toHaveLength(volte))

  it('il valore spedito, su iOS (spenta): il personale sul binario 1.1 non vede niente, e il ruolo non si chiede', async () => {
    stato.minimaPersonale = null // il valore spedito: `VERSIONE_MINIMA_PERSONALE`, spenta su iOS
    stato.piattaforma = 'ios'
    stato.profili = DOCENTE
    const { container } = await monta()
    // Si aspetta la PRESENZA di un fatto (la versione è stata letta), non un'assenza.
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(leggiProfili).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('il valore spedito, su Android (1.2): il personale sul binario 1.1 vede il pop-up col testo del personale', async () => {
    stato.minimaPersonale = null // il valore spedito: `VERSIONE_MINIMA_PERSONALE`, 1.2 su Android
    stato.profili = DOCENTE
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(screen.getByText(T.avvisoAggiornaCorpoPersonale)).toBeTruthy()
    await attendiMostrato('android', '1.1')
    expect(leggiProfili).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ios', 'https://apps.apple.com/it/app/kidville/id6794883055'],
    ['android', 'https://play.google.com/store/apps/details?id=it.kidville.app'],
  ])('il personale sul binario 1.1 su %s: compare, e «Aggiorna ora» porta alla scheda dello store', async (piattaforma, url) => {
    stato.piattaforma = piattaforma
    stato.profili = DOCENTE
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    // Il corpo è quello del personale (i video della 1.2), non quello di sempre (la 1.1).
    expect(screen.getByText(T.avvisoAggiornaCorpoPersonale)).toBeTruthy()
    expect(screen.queryByText(T.avvisoAggiornaCorpo)).toBeNull()
    await attendiMostrato(piattaforma)

    fireEvent.click(screen.getByRole('button', { name: T.avvisoAggiornaBottone }))
    expect(apriUrl).toHaveBeenCalledWith(url)
    expect(dialogo()).toBeNull()
    // Gli stessi log di tutti, con la versione nel messaggio, e nient'altro: niente ruolo.
    expect(messaggiLog()).toEqual([M('mostrato', piattaforma, '1.1'), M('tocco-store', piattaforma, '1.1')])
    expect(logClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        livello: 'warn',
        evento: 'avvio',
        campi: { piattaforma, esito: 'navigazione-richiesta' },
      }),
    )
    expect(leggiProfili).toHaveBeenCalledTimes(1)
  })

  it('il personale sul binario 1.2: niente, e il ruolo non si chiede', async () => {
    stato.versione = '1.2'
    stato.profili = DOCENTE
    const { container } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(leggiProfili).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('il genitore sul binario 1.1: niente, e il ruolo è stato davvero letto', async () => {
    stato.profili = GENITORE
    const { container } = await monta()
    // La PRESENZA di un fatto: il ruolo è stato letto. Solo dopo ha senso guardare l'assenza.
    await waitFor(() => expect(leggiProfili).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(logClient).not.toHaveBeenCalled()
  })

  it('il genitore sul binario 1.0: compare lo stesso (la minima dello store vale per tutti), senza chiedere il ruolo', async () => {
    stato.versione = '1.0'
    stato.profili = GENITORE
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    expect(screen.getByText(T.avvisoAggiornaCorpo)).toBeTruthy()
    await attendiMostrato('android', '1.0')
    expect(messaggiLog()).toEqual([M('mostrato', 'android', '1.0')])
    expect(leggiProfili).not.toHaveBeenCalled()
  })

  it('dalla pagina di accesso: il personale sul binario 1.1 non vede niente, e il ruolo non si chiede', async () => {
    // Chi apre l'app senza essere dentro parte da qui: nessun ruolo da leggere, nessuna `GET /api/me`.
    window.history.pushState({}, '', '/auth/login')
    stato.profili = DOCENTE
    const { container } = await monta()
    await waitFor(() => expect(getInfo).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(leggiProfili).not.toHaveBeenCalled()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('dalla pagina di accesso il binario 1.0 vede il pop-up lo stesso: la minima dello store copre anche il login', async () => {
    window.history.pushState({}, '', '/auth/login')
    stato.versione = '1.0'
    await monta()
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    await attendiMostrato('android', '1.0')
    expect(leggiProfili).not.toHaveBeenCalled()
  })

  it('ruolo non noto (rete giù, sessione scaduta): niente, nel dubbio non si disturba', async () => {
    stato.profili = null
    const { container } = await monta()
    await waitFor(() => expect(leggiProfili).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
  })

  it('col gate bloccato resta chiuso; allo sblocco compare, e il log «mostrato» parte allora', async () => {
    stato.profili = DOCENTE
    stato.bloccato = true
    const { Avviso, rerender } = await monta()
    await waitFor(() => expect(leggiProfili).toHaveBeenCalled())
    await lasciaDecidere()
    expect(dialogo()).toBeNull()
    expect(messaggiLog()).not.toContain(M('mostrato', 'android', '1.1'))

    stato.bloccato = false
    rerender(albero(Avviso))
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    await attendiMostrato()
    expect(messaggiLog()).toEqual([M('mostrato', 'android', '1.1')])
  })

  it('«Più tardi» chiude; dopo 30 minuti in background ricompare, e il ruolo si è letto una volta sola', async () => {
    stato.profili = DOCENTE
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaPiuTardi }))
    expect(dialogo()).toBeNull()

    cambiaVisibilita('hidden')
    stato.ora += 30 * MINUTO
    cambiaVisibilita('visible')
    expect(await screen.findByRole('dialog', { name: T.avvisoAggiornaTitolo })).toBeTruthy()
    await attendiMostrato('android', '1.1', 2)
    expect(leggiProfili).toHaveBeenCalledTimes(1)
    expect(getInfo).toHaveBeenCalledTimes(1)
  })

  it('StrictMode: il ruolo si legge una volta, il pop-up compare, un solo log «mostrato»', async () => {
    stato.profili = DOCENTE
    await monta(true)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await attendiMostrato()
    await lasciaDecidere()
    expect(leggiProfili).toHaveBeenCalledTimes(1)
    expect(getInfo).toHaveBeenCalledTimes(1)
    expect(messaggiLog().filter((m) => m === M('mostrato', 'android', '1.1'))).toHaveLength(1)
  })
})
