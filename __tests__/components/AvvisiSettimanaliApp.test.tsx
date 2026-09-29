import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import sharedIt from '../../messages/it/shared.json'

/**
 * Il riquadro degli avvisi settimanali (compito AV1), montato nei layout del genitore e del
 * docente. La cadenza la verifica `__tests__/lib/avvisi-settimanali.test.ts`; qui si guarda
 * CIÒ CHE SI VEDE e CIÒ CHE SI TOCCA:
 *  - sul web niente;
 *  - notifiche negate su 1.1 → «Apri Impostazioni» che apre davvero le impostazioni;
 *  - senza il plugin, o se l'apertura fallisce → il percorso a parole al posto del bottone;
 *  - binario da aggiornare → niente riquadro: dal 2026-09-29 c'è il pop-up «Aggiorna l'app»
 *    (`AvvisoAggiornamentoApp`), e le due richieste insieme coprirebbero la pagina;
 *  - chiudibile; e un doppio montaggio (StrictMode) non consuma la settimana senza mostrarlo;
 *  - chiuso, non ricompare quando il layout si smonta e si rimonta nella stessa sessione.
 *
 * Ogni test ricarica il modulo del componente (`vi.resetModules`): la decisione è una per
 * SESSIONE, cioè di modulo, e senza ricaricarlo il secondo test erediterebbe quella del primo.
 */

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  plugin: new Set<string>(),
  /** La risposta di `appDaAggiornare` (verificata nel suo test): `true` = binario sotto la minima. */
  daAggiornare: false,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => stato.piattaforma,
    isPluginAvailable: (nome: string) => stato.plugin.has(nome),
  },
}))

const statoPermessoPush = vi.hoisted(() => vi.fn(async () => 'denied' as string))
vi.mock('@/lib/push/native-register', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/push/native-register')>()
  return { ...vero, statoPermessoPush }
})

const apriSettings = vi.hoisted(() => vi.fn<(o: unknown) => Promise<{ status: boolean }>>(async () => ({ status: true })))
vi.mock('capacitor-native-settings', () => ({
  NativeSettings: { open: apriSettings },
  AndroidSettings: { AppNotification: 'app_notification' },
  IOSSettings: { App: 'app' },
}))

const appDaAggiornare = vi.hoisted(() =>
  vi.fn(async () => (stato.daAggiornare ? { piattaforma: 'android' as const, versione: '1.0' } : null)),
)
vi.mock('@/lib/native/aggiornamento-app', () => ({ appDaAggiornare }))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

const T = sharedIt as Record<string, string>
const CHIAVE_NOTIFICHE = 'kv_avviso_notifiche_ultima'

type Componente = typeof import('@/components/providers/AvvisiSettimanaliApp').AvvisiSettimanaliApp

function rendi(Avvisi: Componente, strict = false) {
  const albero = (
    <NextIntlClientProvider locale="it" messages={{ shared: sharedIt }}>
      <Avvisi />
    </NextIntlClientProvider>
  )
  return render(strict ? <StrictMode>{albero}</StrictMode> : albero)
}

async function monta(strict = false) {
  vi.resetModules()
  const { AvvisiSettimanaliApp } = await import('@/components/providers/AvvisiSettimanaliApp')
  return { ...rendi(AvvisiSettimanaliApp, strict), Avvisi: AvvisiSettimanaliApp }
}

/** Lascia risolvere la promise di modulo (già risolta) e applicare lo stato che ne segue. */
async function lasciaDecidere() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function messaggiLog(): string[] {
  return logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)
}

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.plugin = new Set(['FileTransfer', 'NativeSettings', 'PushNotifications'])
  stato.daAggiornare = false
  appDaAggiornare.mockClear()
  statoPermessoPush.mockReset()
  statoPermessoPush.mockResolvedValue('denied')
  apriSettings.mockReset()
  apriSettings.mockResolvedValue({ status: true })
  logClient.mockReset()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('AvvisiSettimanaliApp', () => {
  it('sul web non rende niente e non logga', async () => {
    stato.nativo = false
    const { container } = await monta()
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
    expect(logClient).not.toHaveBeenCalled()
  })

  it('notifiche negate su 1.1: «Apri Impostazioni» apre le impostazioni delle notifiche e chiude il riquadro', async () => {
    await monta()
    expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
    expect(screen.queryByText(T.avvisoNotifichePercorso)).toBeNull()
    expect(messaggiLog()).toContain('avviso-notifiche-disattivate-mostrato')
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'push', campi: { piattaforma: 'android', esito: 'bottone' } }),
    )

    fireEvent.click(screen.getByRole('button', { name: T.avvisoNotificheApri }))
    await waitFor(() => expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull())
    expect(apriSettings).toHaveBeenCalledWith({ optionAndroid: 'app_notification', optionIOS: 'app' })
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        messaggio: 'avviso-notifiche-disattivate-tocco-impostazioni',
        campi: { piattaforma: 'android', esito: 'aperte' },
      }),
    )
  })

  it('permesso concesso: niente riquadro', async () => {
    statoPermessoPush.mockResolvedValue('granted')
    const { container } = await monta()
    await waitFor(() => expect(statoPermessoPush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })

  it('senza il plugin delle impostazioni: il percorso a parole, nessun bottone', async () => {
    stato.plugin = new Set(['FileTransfer', 'PushNotifications'])
    await monta()
    expect(await screen.findByText(T.avvisoNotifichePercorso)).toBeTruthy()
    expect(screen.queryByRole('button', { name: T.avvisoNotificheApri })).toBeNull()
    expect(apriSettings).not.toHaveBeenCalled()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'avviso-notifiche-disattivate-mostrato', campi: { piattaforma: 'android', esito: 'percorso-manuale' } }),
    )
  })

  it('se le impostazioni non si aprono, il bottone lascia il posto al percorso a parole', async () => {
    apriSettings.mockRejectedValue(new TypeError('boom'))
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheApri }))
    expect(await screen.findByText(T.avvisoNotifichePercorso)).toBeTruthy()
    expect(screen.getByText(T.avvisoNotificheTitolo)).toBeTruthy()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'avviso-notifiche-disattivate-tocco-impostazioni', campi: { piattaforma: 'android', esito: 'errore' } }),
    )
  })

  it('binario da aggiornare con le notifiche negate: niente riquadro, e la settimana resta intatta', async () => {
    stato.daAggiornare = true
    const { container } = await monta()
    // Si aspetta la PRESENZA di un fatto (la decisione ha chiesto la versione), non un'assenza.
    await waitFor(() => expect(appDaAggiornare).toHaveBeenCalled())
    await lasciaDecidere()
    expect(container.innerHTML).toBe('')
    expect(statoPermessoPush).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(CHIAVE_NOTIFICHE)).toBeNull()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('si chiude con la X, e il tocco si registra', async () => {
    await monta()
    fireEvent.click(await screen.findByRole('button', { name: T.avvisoChiudiAria }))
    expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()
    expect(messaggiLog()).toContain('avviso-notifiche-disattivate-chiuso')
    expect(apriSettings).not.toHaveBeenCalled()
  })

  it('già comparso questa settimana: al riavvio non ricompare', async () => {
    window.localStorage.setItem(CHIAVE_NOTIFICHE, String(Date.now() - 60_000))
    const { container } = await monta()
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
    expect(statoPermessoPush).not.toHaveBeenCalled()
  })

  describe('rimontaggio nella STESSA sessione (stesso modulo, niente resetModules)', () => {
    // Profilo → «Privacy» (fuori da `(dashboard)/parent`) → Indietro: il layout si smonta e si
    // rimonta, ma il modulo del componente — e con lui la decisione — resta quello di prima.

    it('controllo positivo: se il riquadro era ancora aperto, il rimontaggio lo rimostra, e il log «mostrato» resta uno', async () => {
      const { Avvisi, unmount } = await monta()
      expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
      unmount()
      expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()

      rendi(Avvisi)
      await lasciaDecidere()
      // La stessa attesa usata qui sotto BASTA a rimostrarlo: le assenze dei test gemelli non
      // sono un'attesa troppo corta.
      expect(screen.getByText(T.avvisoNotificheTitolo)).toBeTruthy()
      expect(messaggiLog().filter((m) => m === 'avviso-notifiche-disattivate-mostrato')).toHaveLength(1)
      expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    })

    it('chiuso con la X: smontato e rimontato non ricompare, e non si registra una seconda comparsa', async () => {
      const { Avvisi, unmount } = await monta()
      expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: T.avvisoChiudiAria }))
      expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()
      unmount()

      const { container } = rendi(Avvisi)
      await lasciaDecidere()
      expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()
      expect(container.innerHTML).toBe('')
      expect(messaggiLog().filter((m) => m === 'avviso-notifiche-disattivate-mostrato')).toHaveLength(1)
      expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    })

    it('dopo «Apri Impostazioni» riuscito: smontato e rimontato non ricompare', async () => {
      const { Avvisi, unmount } = await monta()
      fireEvent.click(await screen.findByRole('button', { name: T.avvisoNotificheApri }))
      await waitFor(() => expect(apriSettings).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull())
      unmount()

      const { container } = rendi(Avvisi)
      await lasciaDecidere()
      expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()
      expect(container.innerHTML).toBe('')
      expect(messaggiLog().filter((m) => m === 'avviso-notifiche-disattivate-mostrato')).toHaveLength(1)
      expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    })

  })

  it('il doppio montaggio di StrictMode non consuma la settimana senza mostrarlo', async () => {
    await monta(true)
    expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
    expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(CHIAVE_NOTIFICHE)).not.toBeNull()
  })
})
