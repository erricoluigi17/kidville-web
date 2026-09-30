import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import teacherNavIt from '../../messages/it/teacherNav.json'

/**
 * `AvvisoNotificheDocente` — «LE NOTIFICHE NON ARRIVANO, E NESSUNO TE LO DICE» (compito C1).
 *
 * ─── IL FATTO, misurato ─────────────────────────────────────────────────────────
 *
 * Segnalazione del 2026-09-29: una docente su Android, che apre l'app ogni giorno, ha ricevuto
 * 137 messaggi in 30 giorni senza una sola push — permesso negato, nessuna riga in
 * `push_subscriptions`, e nessuna schermata che lo dicesse.
 *
 * ─── LE REGOLE CHE QUESTO FILE SORVEGLIA ────────────────────────────────────────
 *
 *  1. **Sul web nessuna attivazione**, solo il rimando all'app. Decisione di PRIVACY: sul web
 *     il logout non annulla l'iscrizione e i PC di scuola sono condivisi — chi si siede dopo
 *     riceverebbe le notifiche della docente precedente, `mensa_allergia` compresa (nome,
 *     sezione e allergeni di un bambino).
 *  2. **Con dispositivi iscritti l'avviso può comparire comunque**: sull'app il conteggio è
 *     per PERSONA, ma il permesso è per DISPOSITIVO. Spente le notifiche dalle Impostazioni,
 *     la riga resta e la push la butta il sistema — è il caso della segnalazione.
 *  3. **In caricamento e su errore non si mostra niente**: «non lo so» non vale «non ne hai».
 *  4. **Una variante per strada vera**, e niente pulsanti che non possono funzionare (plugin
 *     assente → «aggiorna l'app», non «consenti le notifiche»).
 *  5. **Il ricontrollo** al ritorno visibile con la soglia dei 30 s, e un gesto esplicito che
 *     non perde il suo ricontrollo nemmeno se ne trova uno in volo.
 *  6. **Un log per sessione**, e il tocco sulle impostazioni registrato col suo esito.
 *  7. **Accessibilità**: il fuoco non si perde quando la strada cambia, la regione di stato
 *     esiste prima di riempirsi, e il pulsante in attesa non è `disabled`.
 *
 * ⚠️ IL LOG DELLA COMPARSA SI ASPETTA, NON SI LEGGE SUBITO. Parte da un `useEffect`, quindi
 * dopo una `findBy*` può non essere ancora uscito: asserirlo sincrono è una corsa, e come
 * tale l'ha vinta 8 volte su 10 (misurato il 2026-09-30, su test diversi a ogni giro). Si
 * aspetta la PRESENZA della riga con `waitFor`.
 */

const stato = vi.hoisted(() => ({
  nativo: false,
  piattaforma: 'web' as string,
  permesso: 'prompt' as string,
  userId: 'aaaaaaaa-1111-4000-8000-000000000001' as string | null,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => stato.piattaforma,
    isPluginAvailable: () => true,
  },
}))

const h = vi.hoisted(() => ({
  statoPermessoPush: vi.fn(async () => 'prompt' as string),
  registerNativePush: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
  apriImpostazioniNotifiche: vi.fn(async () => 'aperte' as string),
  impostazioniApribili: vi.fn(() => true),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({
  isNativeApp: () => stato.nativo,
  statoPermessoPush: h.statoPermessoPush,
  registerNativePush: h.registerNativePush,
  unregisterNativePush: vi.fn(async () => undefined),
}))
vi.mock('@/lib/native/avvisi-settimanali', () => ({
  apriImpostazioniNotifiche: h.apriImpostazioniNotifiche,
  impostazioniApribili: h.impostazioniApribili,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))

const T = teacherNavIt as Record<string, string>
const UTENTE = 'aaaaaaaa-1111-4000-8000-000000000001'

type Componente = typeof import('@/components/features/teacher/AvvisoNotificheDocente').AvvisoNotificheDocente

/**
 * Il conteggio che risponde `GET /api/push/subscribe`.
 *
 * ⚠️ Il corpo della risposta d'ERRORE porta `dispositivi: 0`, di proposito: con un corpo
 * non-JSON il test dell'errore sarebbe verde anche senza il controllo di `res.ok` — `json()`
 * lancerebbe e il `catch` nasconderebbe l'avviso comunque, cioè il test misurerebbe il proprio
 * finto (misurato col mutante il 2026-09-30).
 */
function contaDispositivi(risposte: Array<{ stato: number; dispositivi?: number; corpo?: string }>) {
  let i = 0
  const finto = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('/api/push/subscribe')) {
      const r = risposte[Math.min(i, risposte.length - 1)]
      i++
      const corpo = r.corpo ?? JSON.stringify(
        r.stato === 200
          ? { success: true, dispositivi: r.dispositivi ?? 0 }
          : { error: 'no', codice: 'PUSH_STATO_NON_LETTO', dispositivi: r.dispositivi ?? 0 },
      )
      return new Response(corpo, { status: r.stato })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', finto)
  return finto
}

/** Una fetch che non risponde mai: è lo stato di CARICAMENTO, guardato mentre è in corso. */
function contaSospesa() {
  const finto = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', finto)
  return finto
}

async function monta(opzioni: { strict?: boolean } = {}) {
  vi.resetModules()
  const { AvvisoNotificheDocente } = await import('@/components/features/teacher/AvvisoNotificheDocente')
  return { ...rendi(AvvisoNotificheDocente, opzioni.strict), Avviso: AvvisoNotificheDocente }
}

function rendi(Avviso: Componente, strict = false) {
  const albero = <Avviso userId={stato.userId} />
  return render(strict ? <StrictMode>{albero}</StrictMode> : albero)
}

async function lasciaRispondere() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function messaggiLog(): string[] {
  return h.logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)
}

const titolo = () => screen.queryByRole('heading', { level: 2, name: T.avvisoNotificheDocenteTitolo })
const attendiTitolo = () => screen.findByRole('heading', { level: 2, name: T.avvisoNotificheDocenteTitolo })

/** Il ritorno visibile della pagina: il gesto «vado nelle Impostazioni e torno». */
function tornaVisibile() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
}

function vaiInBackground() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  stato.userId = UTENTE
  stato.nativo = false
  stato.piattaforma = 'web'
  h.statoPermessoPush.mockReset()
  h.statoPermessoPush.mockResolvedValue('prompt')
  h.registerNativePush.mockReset()
  h.registerNativePush.mockResolvedValue({ ok: true })
  h.apriImpostazioniNotifiche.mockReset()
  h.apriImpostazioniNotifiche.mockResolvedValue('aperte')
  h.impostazioniApribili.mockReset()
  h.impostazioniApribili.mockReturnValue(true)
  h.logClient.mockReset()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  vi.useRealTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AvvisoNotificheDocente — quando si vede', () => {
  it('sul web con un dispositivo iscritto → niente avviso, e nessun log', async () => {
    const finto = contaDispositivi([{ stato: 200, dispositivi: 1 }])
    const { container } = await monta()
    await waitFor(() => expect(finto).toHaveBeenCalled())
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('mentre il conteggio è in volo → niente avviso (meglio nessuno che uno falso)', async () => {
    contaSospesa()
    const { container } = await monta()
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('conteggio in errore (500) → niente avviso: «non lo so» non vale «non ne hai»', async () => {
    // Il corpo del 500 dice `dispositivi: 0`: se il componente guardasse solo il numero e non
    // lo STATUS, questo è il caso in cui mostrerebbe un avviso falso su un guasto di lettura.
    const finto = contaDispositivi([{ stato: 500, dispositivi: 0 }])
    const { container } = await monta()
    await waitFor(() => expect(finto).toHaveBeenCalled())
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
  })

  it('conteggio che non è JSON → niente avviso, e una riga che lo dice', async () => {
    const finto = contaDispositivi([{ stato: 200, corpo: '<html>errore del proxy</html>' }])
    const { container } = await monta()
    await waitFor(() => expect(finto).toHaveBeenCalled())
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
    expect(messaggiLog().some((m) => m.startsWith('avviso-notifiche-docente-stato-illeggibile'))).toBe(true)
  })

  it('forma inattesa (`dispositivi` assente) → niente avviso', async () => {
    const finto = contaDispositivi([{ stato: 200, corpo: JSON.stringify({ success: true }) }])
    const { container } = await monta()
    await waitFor(() => expect(finto).toHaveBeenCalled())
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
  })

  it('identità non ancora risolta → non si conta niente e non si mostra niente', async () => {
    stato.userId = null
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    const { container } = await monta()
    await lasciaRispondere()
    expect(finto).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe('')
  })

  it('zero dispositivi → avviso col titolo in un h2, e non si può chiudere', async () => {
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    expect(await attendiTitolo()).toBeTruthy()
    expect(screen.queryByRole('button', { name: /chiudi/i })).toBeNull()
  })
})

describe('AvvisoNotificheDocente — sul WEB non si attiva niente', () => {
  it('🔴 zero dispositivi sul web → SOLO il rimando all app, nessun pulsante', async () => {
    // Decisione di privacy: su un PC condiviso l'iscrizione sopravvive al logout, e le
    // notifiche (`mensa_allergia`: nome, sezione e allergeni di un bambino) arriverebbero a
    // chi si siede dopo. Perciò niente opt-in dal browser.
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    expect(await screen.findByText(T.avvisoNotificheDocenteUsaApp)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    await waitFor(() => expect(messaggiLog()).toContain('avviso-notifiche-docente-mostrato: web-usa-app'))
  })

  it('🔴 sul web NON si chiede il permesso del browser, e non si tocca il service worker', async () => {
    // La prova che non resta un opt-in nascosto: nessuna delle due API viene sfiorata.
    const requestPermission = vi.fn(async () => 'granted')
    const register = vi.fn()
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission },
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => undefined, register, ready: Promise.resolve({}) },
    })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} })

    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    await screen.findByText(T.avvisoNotificheDocenteUsaApp)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()

    delete (window as unknown as Record<string, unknown>).Notification
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
    delete (window as unknown as Record<string, unknown>).PushManager
  })
})

describe('AvvisoNotificheDocente — le varianti native', () => {
  beforeEach(() => {
    stato.nativo = true
    stato.piattaforma = 'android'
  })

  it('permesso NEGATO → «Apri Impostazioni», che apre davvero le impostazioni', async () => {
    h.statoPermessoPush.mockResolvedValue('denied')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    await waitFor(() => expect(h.apriImpostazioniNotifiche).toHaveBeenCalledTimes(1))
    expect(h.registerNativePush).not.toHaveBeenCalled()
    await waitFor(() => expect(messaggiLog()).toContain('avviso-notifiche-docente-mostrato: nativo-negato'))
    // Il corpo parla di QUESTO telefono: il permesso è del dispositivo, non della persona.
    expect(screen.getByText(T.avvisoNotificheDocenteCorpoTelefono)).toBeTruthy()
  })

  it('🔴 il tocco su «Apri Impostazioni» si registra con il suo esito', async () => {
    h.statoPermessoPush.mockResolvedValue('denied')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({
          livello: 'warn',
          evento: 'push',
          messaggio: 'avviso-notifiche-docente-tocco-impostazioni',
          campi: { esito: 'aperte' },
        }),
      ),
    )
  })

  it('🔴 se le impostazioni NON si aprono, il pulsante lascia il posto al percorso a parole', async () => {
    // Un pulsante che non apre niente farebbe credere alla maestra di aver sbagliato lei.
    h.statoPermessoPush.mockResolvedValue('denied')
    h.apriImpostazioniNotifiche.mockResolvedValue('errore')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    expect(await screen.findByText(T.avvisoNotificheDocentePercorso)).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'avviso-notifiche-docente-tocco-impostazioni', campi: { esito: 'errore' } }),
    )
  })

  it('permesso negato e binario senza il plugin delle impostazioni → percorso a parole', async () => {
    h.statoPermessoPush.mockResolvedValue('denied')
    h.impostazioniApribili.mockReturnValue(false)
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    expect(await screen.findByText(T.avvisoNotificheDocentePercorso)).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeNull()
    await waitFor(() => expect(messaggiLog()).toContain('avviso-notifiche-docente-mostrato: nativo-percorso-manuale'))
  })

  it('🔴 plugin push assente o bridge muto → «aggiorna l app», non «consenti le notifiche»', async () => {
    // Il guasto è dell'app, non una scelta dell'utente: mandarla a cercare un interruttore
    // già acceso è il modo di far perdere tempo a chi sta già senza notifiche.
    h.statoPermessoPush.mockResolvedValue('non-disponibile')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    expect(await screen.findByText(T.avvisoNotificheDocenteAggiornaApp)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(T.avvisoNotificheDocentePercorso)).toBeNull()
    await waitFor(() => expect(messaggiLog()).toContain('avviso-notifiche-docente-mostrato: nativo-non-disponibile'))
  })

  it('permesso da chiedere → «Attiva», che registra la push nativa e fa sparire l avviso', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    contaDispositivi([
      { stato: 200, dispositivi: 0 },
      { stato: 200, dispositivi: 1 },
    ])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    await waitFor(() => expect(h.registerNativePush).toHaveBeenCalledTimes(1))
    expect(h.apriImpostazioniNotifiche).not.toHaveBeenCalled()
    await waitFor(() => expect(titolo()).toBeNull())
    await waitFor(() => expect(messaggiLog()).toContain('avviso-notifiche-docente-mostrato: nativo-attiva'))
  })

  it('permesso concesso ma nessun token sul server → «Attiva» (non le impostazioni)', async () => {
    // Il caso iOS: `granted` e registrazione APNs mai completata.
    h.statoPermessoPush.mockResolvedValue('granted')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva })).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeNull()
  })

  it('🔴 dispositivi ISCRITTI ma notifiche spente dal telefono → «Apri Impostazioni»', async () => {
    // Il conteggio è per persona, il permesso per dispositivo: FCM/APNs accettano il token
    // comunque, ed è il sistema a buttare la notifica. È il caso della segnalazione.
    h.statoPermessoPush.mockResolvedValue('denied')
    contaDispositivi([{ stato: 200, dispositivi: 2 }])
    await monta()

    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeTruthy()
    expect(screen.getByText(T.avvisoNotificheDocenteCorpoTelefono)).toBeTruthy()
  })

  it('dispositivi iscritti e permesso concesso → niente avviso', async () => {
    h.statoPermessoPush.mockResolvedValue('granted')
    const finto = contaDispositivi([{ stato: 200, dispositivi: 1 }])
    const { container } = await monta()
    await waitFor(() => expect(finto).toHaveBeenCalled())
    await lasciaRispondere()
    expect(container.innerHTML).toBe('')
  })

  it('«Attiva» che non riesce col permesso invariato → resta «Attiva», e invita a riprovare solo se ha senso', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'registration_timeout' })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    expect(await screen.findByText(T.avvisoNotificheDocenteErrore)).toBeTruthy()
    expect(screen.getByRole('button', { name: T.avvisoNotificheDocenteAttiva })).toBeTruthy()
  })

  it('«Attiva» che non riesce per un motivo NON ritentabile → lo dice senza invitare a riprovare', async () => {
    // `plugin_unavailable`: il plugin non è nel binario, serve un aggiornamento dell'app.
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'plugin_unavailable' })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    expect(await screen.findByText(T.avvisoNotificheDocenteErroreDefinitivo)).toBeTruthy()
    expect(screen.queryByText(T.avvisoNotificheDocenteErrore)).toBeNull()
  })

  it('🔴 `plugin_error` invita a riprovare, come fa `NativePushAutoRegister` che riprova da sé', async () => {
    // L'allineamento richiesto dalla revisione: lo stesso esito non può essere «riprova» per
    // il registratore automatico e «non è stato possibile» per il pulsante, a due metri di
    // distanza. L'elenco è uno: `@/lib/push/esiti-ritentabili`.
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'plugin_error' })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    expect(await screen.findByText(T.avvisoNotificheDocenteErrore)).toBeTruthy()
    expect(screen.queryByText(T.avvisoNotificheDocenteErroreDefinitivo)).toBeNull()
  })

  it('🔴 un NO nel dialogo rende il permesso `denied` → la variante passa a «Apri Impostazioni», senza «riprova»', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockImplementation(async () => {
      h.statoPermessoPush.mockResolvedValue('denied')
      return { ok: false, error: 'permission_denied' }
    })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.avvisoNotificheDocenteAttiva })).toBeNull()
    expect(screen.queryByText(T.avvisoNotificheDocenteErrore)).toBeNull()
    expect(screen.queryByText(T.avvisoNotificheDocenteErroreDefinitivo)).toBeNull()
  })

  it('🔴 l errore NON sopravvive a un cambio di variante deciso da un RICONTROLLO', async () => {
    // «Attiva» fallisce (permesso ancora da chiedere), poi la maestra spegne le notifiche
    // dalle Impostazioni: al ricontrollo compare «Apri Impostazioni», e «riprova fra qualche
    // istante» accanto direbbe di ripetere un gesto che non può più riuscire.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'registration_timeout' })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    expect(await screen.findByText(T.avvisoNotificheDocenteErrore)).toBeTruthy()

    h.statoPermessoPush.mockResolvedValue('denied')
    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    vaiInBackground()
    tornaVisibile()

    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeTruthy()
    await waitFor(() => expect(screen.queryByText(T.avvisoNotificheDocenteErrore)).toBeNull())
  })
})

describe('AvvisoNotificheDocente — il ricontrollo', () => {
  it('al ritorno visibile ricontrolla, e se ora va tutto bene l avviso sparisce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const finto = contaDispositivi([
      { stato: 200, dispositivi: 0 },
      { stato: 200, dispositivi: 1 },
    ])
    await monta()
    expect(await attendiTitolo()).toBeTruthy()
    expect(finto).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    vaiInBackground()
    tornaVisibile()
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(titolo()).toBeNull())
  })

  it('🔴 la soglia è DAVVERO 30 s: a 25 s non ricontrolla, a 31 s sì', async () => {
    // I due scalini insieme, e servono entrambi: con il solo «oltre la soglia» un
    // `INTERVALLO_RICONTROLLO_MS = 1_000` resterebbe verde — il ricontrollo partirebbe
    // comunque, solo prima. È il numero che si sorveglia, non l'esistenza del ricontrollo.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    await attendiTitolo()
    expect(finto).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(25_000)
    })
    vaiInBackground()
    tornaVisibile()
    await lasciaRispondere()
    expect(finto).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    vaiInBackground()
    tornaVisibile()
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(2))
  })

  it('🔴 «Apri Impostazioni» coi tempi di ANDROID: `open()` si risolve al RITORNO, a permesso già cambiato', async () => {
    // Android: `startActivityForResult` + `@ActivityCallback`, quindi quando la promessa si
    // risolve la maestra è già tornata e il permesso è quello nuovo.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stato.nativo = true
    stato.piattaforma = 'android'
    h.statoPermessoPush.mockResolvedValue('denied')
    h.apriImpostazioniNotifiche.mockImplementation(async () => {
      h.statoPermessoPush.mockResolvedValue('granted')
      return 'aperte'
    })
    const finto = contaDispositivi([
      { stato: 200, dispositivi: 0 },
      { stato: 200, dispositivi: 1 },
    ])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    await waitFor(() => expect(h.apriImpostazioniNotifiche).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(titolo()).toBeNull())
  })

  it('🔴 coi tempi di iOS: `open()` si risolve alla PARTENZA, e il rientro entro 30 s ricontrolla comunque', async () => {
    // ⚠️ IL DIFETTO CHE QUESTO TEST BLOCCA. Su iOS il plugin risolve `open()` subito
    // (`UIApplication.shared.open(url) { success in call.resolve(…) }`), quindi il ricontrollo
    // chiesto dal gesto legge il permesso ANCORA negato e riscrive l'orologio della soglia.
    // Dieci secondi dopo la maestra concede e rientra: senza il flag del rientro la soglia
    // bloccherebbe il ricontrollo, e l'avviso direbbe «spente» col permesso appena dato.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stato.nativo = true
    stato.piattaforma = 'ios'
    h.statoPermessoPush.mockResolvedValue('denied')
    // iOS: la promessa si risolve e basta. Il permesso cambierà DOPO, fuori dall'app.
    h.apriImpostazioniNotifiche.mockResolvedValue('aperte')
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    await waitFor(() => expect(h.apriImpostazioniNotifiche).toHaveBeenCalledTimes(1))
    // Il ricontrollo del gesto è già partito, e ha visto «negato»: l'avviso resta.
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })).toBeTruthy()

    vaiInBackground()
    await act(async () => {
      vi.advanceTimersByTime(10_000) // dieci secondi nelle Impostazioni: dentro la soglia
    })
    h.statoPermessoPush.mockResolvedValue('granted') // concede ADESSO
    tornaVisibile()

    await waitFor(() => expect(finto).toHaveBeenCalledTimes(3))
    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva })).toBeTruthy()
  })

  it('🔴 iOS con un controllo ANCORA IN VOLO al rientro: il ricontrollo si ottiene comunque', async () => {
    // ⚠️ È il caso che distingue la correzione robusta da quella facile. Azzerare l'orologio
    // dopo il gesto (`ultimoControllo.current = 0`) sembra equivalente, ma se il controllo del
    // gesto è ANCORA IN VOLO quando la maestra rientra, è quel giro a riscrivere l'orologio
    // quando finisce — e l'azzeramento, avvenuto prima, non vale più niente. Il flag no: vive
    // fino al rientro e lo fa passare.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stato.nativo = true
    stato.piattaforma = 'ios'
    h.statoPermessoPush.mockResolvedValue('denied')
    h.apriImpostazioniNotifiche.mockResolvedValue('aperte')

    const inSospeso: Array<() => void> = []
    let fatte = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        fatte++
        return new Promise<Response>((risolvi) => {
          inSospeso.push(() =>
            risolvi(new Response(JSON.stringify({ success: true, dispositivi: 0 }), { status: 200 })),
          )
        })
      }),
    )
    const sciogli = async () => {
      await act(async () => {
        while (inSospeso.length > 0) inSospeso.shift()!()
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    await monta()
    await waitFor(() => expect(fatte).toBe(1))
    await sciogli()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    // Il controllo del gesto è partito e resta IN VOLO.
    await waitFor(() => expect(fatte).toBe(2))

    // La maestra è nelle Impostazioni: concede e rientra dopo dieci secondi, mentre la
    // richiesta di prima è ancora aperta.
    vaiInBackground()
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    h.statoPermessoPush.mockResolvedValue('granted')
    tornaVisibile()
    // Il rientro trova un controllo in volo: si accoda (non si perde) …
    await sciogli()
    // … e il giro accodato legge il permesso nuovo.
    await waitFor(() => expect(fatte).toBe(3))
    await sciogli()
    expect(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva })).toBeTruthy()
  })

  it('🔴 il rientro atteso vale UNA volta: il secondo rientro ravvicinato torna sotto la soglia', async () => {
    // Il flag non è un interruttore che spegne la soglia: la salta per il rientro che segue il
    // gesto, e si consuma. Altrimenti ogni cambio di scheda diventerebbe una richiesta.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stato.nativo = true
    stato.piattaforma = 'ios'
    h.statoPermessoPush.mockResolvedValue('denied')
    h.apriImpostazioniNotifiche.mockResolvedValue('aperte')
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri }))
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(2))
    vaiInBackground()
    tornaVisibile()
    await waitFor(() => expect(finto).toHaveBeenCalledTimes(3))

    // Secondo rientro, subito: il flag è stato consumato, comanda la soglia.
    vaiInBackground()
    tornaVisibile()
    await lasciaRispondere()
    expect(finto).toHaveBeenCalledTimes(3)
  })

  it('🔴 cinque gesti durante un controllo in volo → UN giro in più, e poi si ferma', async () => {
    // Il `do … while` di `controlla`: i gesti non si perdono (un ricontrollo in più c'è
    // davvero) e non si moltiplicano (non uno per gesto, e nessuna richiesta parallela).
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stato.nativo = true
    stato.piattaforma = 'android'
    h.statoPermessoPush.mockResolvedValue('denied')
    h.apriImpostazioniNotifiche.mockResolvedValue('aperte')

    const inSospeso: Array<() => void> = []
    let fatte = 0
    const finto = vi.fn(() => {
      fatte++
      return new Promise<Response>((risolvi) => {
        inSospeso.push(() =>
          risolvi(new Response(JSON.stringify({ success: true, dispositivi: 0 }), { status: 200 })),
        )
      })
    })
    vi.stubGlobal('fetch', finto)
    const sciogli = async () => {
      await act(async () => {
        while (inSospeso.length > 0) inSospeso.shift()!()
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    await monta()
    await waitFor(() => expect(fatte).toBe(1))
    await sciogli()
    const bottone = await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })

    // Una GET lasciata IN VOLO, poi cinque tocchi mentre è ancora aperta.
    await act(async () => {
      vi.advanceTimersByTime(31_000)
    })
    vaiInBackground()
    tornaVisibile()
    await waitFor(() => expect(fatte).toBe(2))
    for (let i = 0; i < 5; i++) fireEvent.click(bottone)
    await waitFor(() => expect(h.apriImpostazioniNotifiche).toHaveBeenCalledTimes(5))
    await lasciaRispondere()
    expect(fatte).toBe(2) // niente richieste parallele

    await sciogli() // la n. 2 finisce → il ciclo rifà UN giro
    await waitFor(() => expect(fatte).toBe(3))
    await sciogli() // la n. 3 finisce → e qui si ferma
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(fatte).toBe(3)
  })

  it('nessun polling periodico: passati due minuti senza toccare niente, il controllo resta uno', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    await attendiTitolo()

    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(finto).toHaveBeenCalledTimes(1)
  })
})

describe('AvvisoNotificheDocente — il log', () => {
  it('una riga `warn` sul canale `push`, con la variante e senza dati personali', async () => {
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    await attendiTitolo()

    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({
          livello: 'warn',
          evento: 'push',
          messaggio: 'avviso-notifiche-docente-mostrato: web-usa-app',
        }),
      ),
    )
    const [evento] = h.logClient.mock.calls[0] as [Record<string, unknown>]
    // Nessun uuid, nessun nome: solo la variante. Piattaforma e versione del binario le
    // aggiunge il canale al flush (`logClient` → `flush`), non questo chiamante.
    expect(JSON.stringify(evento)).not.toContain('aaaaaaaa')
  })

  it('una volta per SESSIONE: due montaggi dello stesso modulo non producono due righe', async () => {
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    const { Avviso, unmount } = await monta()
    await attendiTitolo()
    unmount()

    rendi(Avviso)
    await attendiTitolo()
    expect(messaggiLog().filter((m) => m.startsWith('avviso-notifiche-docente-mostrato'))).toHaveLength(1)
  })

  it('🔴 il doppio montaggio di StrictMode: una riga sola E una sola richiesta', async () => {
    // La guardia `inCorso`: senza, i due effetti di StrictMode farebbero due conteggi — e il
    // secondo, su una home che ne fa già molte, è traffico che nessuno ha chiesto.
    const finto = contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta({ strict: true })
    await attendiTitolo()
    // Il log parte da un effetto: si aspetta la sua PRESENZA prima di contarlo, altrimenti
    // l'asserzione corre contro l'effetto (instabile sotto carico).
    await waitFor(() => expect(messaggiLog().some((m) => m.startsWith('avviso-notifiche-docente-mostrato'))).toBe(true))
    expect(messaggiLog().filter((m) => m.startsWith('avviso-notifiche-docente-mostrato'))).toHaveLength(1)
    expect(finto).toHaveBeenCalledTimes(1)
  })
})

describe('AvvisoNotificheDocente — accessibilità', () => {
  beforeEach(() => {
    stato.nativo = true
    stato.piattaforma = 'android'
  })

  it('🔴 il fuoco non si perde quando la strada cambia: va sul titolo, non sul body', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockImplementation(async () => {
      h.statoPermessoPush.mockResolvedValue('denied')
      return { ok: false, error: 'permission_denied' }
    })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    const intestazione = await attendiTitolo()
    await waitFor(() => expect(document.activeElement).toBe(intestazione))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('🔴 il pulsante in attesa NON è `disabled` (il fuoco resta suo), e un secondo click non riparte', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    let sblocca: (v: { ok: boolean }) => void = () => {}
    h.registerNativePush.mockImplementation(
      () => new Promise<{ ok: boolean }>((r) => { sblocca = r }),
    )
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()

    const bottone = await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttiva })
    fireEvent.click(bottone)
    const inAttesa = await screen.findByRole('button', { name: T.avvisoNotificheDocenteAttivazione })
    expect((inAttesa as HTMLButtonElement).disabled).toBe(false)
    expect(inAttesa).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(inAttesa)
    expect(h.registerNativePush).toHaveBeenCalledTimes(1)
    await act(async () => {
      sblocca({ ok: true })
    })
  })

  it('la regione di stato esiste PRIMA di riempirsi (uno `role="status"` inserito già pieno non si annuncia)', async () => {
    h.statoPermessoPush.mockResolvedValue('prompt')
    h.registerNativePush.mockResolvedValue({ ok: false, error: 'registration_timeout' })
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    const { container } = await monta()
    await attendiTitolo()

    const regione = container.querySelector('[role="status"]')
    expect(regione).not.toBeNull()
    expect(regione?.textContent).toBe('')

    fireEvent.click(screen.getByRole('button', { name: T.avvisoNotificheDocenteAttiva }))
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe(T.avvisoNotificheDocenteErrore))
  })

  it('i pulsanti rispettano il bersaglio minimo di 44 px', async () => {
    h.statoPermessoPush.mockResolvedValue('denied')
    contaDispositivi([{ stato: 200, dispositivi: 0 }])
    await monta()
    const bottone = await screen.findByRole('button', { name: T.avvisoNotificheDocenteApri })
    expect(bottone.className).toContain('min-h-[44px]')
  })
})
