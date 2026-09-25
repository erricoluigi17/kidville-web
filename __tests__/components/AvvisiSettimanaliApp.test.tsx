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
 *  - binario 1.0 → «Aggiorna l'app» che porta alla scheda dello store della piattaforma, ma solo
 *    se la 1.1 è già su QUELLO store (`APP_1_1_PUBBLICATA`, qui `stato.pubblicata`);
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
  /** L'interruttore «la 1.1 è sullo store», passato alla funzione VERA. */
  pubblicata: { ios: false, android: false } as { ios: boolean; android: boolean },
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

// La navigazione vera (`window.location.assign`) in jsdom non si osserva: si passa alla funzione
// VERA un apri-url spia, così URL e piattaforma restano quelli del codice di produzione. Allo
// stesso modo la decisione è quella VERA, con l'interruttore della pubblicazione scelto dal test.
const apriUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/native/avvisi-settimanali', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/avvisi-settimanali')>()
  return {
    ...vero,
    apriSchedaStore: () => vero.apriSchedaStore(apriUrl),
    avvisoDaMostrare: () => vero.avvisoDaMostrare(Date.now(), stato.pubblicata),
  }
})

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

const T = sharedIt as Record<string, string>
const CHIAVE_NOTIFICHE = 'kv_avviso_notifiche_ultima'
const CHIAVE_AGGIORNA = 'kv_avviso_aggiorna_app_ultima'

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
  stato.pubblicata = { ios: false, android: false }
  statoPermessoPush.mockReset()
  statoPermessoPush.mockResolvedValue('denied')
  apriSettings.mockReset()
  apriSettings.mockResolvedValue({ status: true })
  apriUrl.mockReset()
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
    // FileTransfer c'è (niente «aggiorna»), NativeSettings no.
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

  it.each([
    ['ios', 'https://apps.apple.com/it/app/kidville/id6794883055'],
    ['android', 'https://play.google.com/store/apps/details?id=it.kidville.app'],
  ])('binario 1.0 su %s con la 1.1 sullo store: «Aggiorna l’app» porta alla scheda dello store', async (piattaforma, url) => {
    stato.piattaforma = piattaforma
    stato.plugin = new Set(['PushNotifications'])
    stato.pubblicata = { ios: true, android: true }
    await monta()
    expect(await screen.findByText(T.avvisoAggiornaTitolo)).toBeTruthy()
    // Uno alla volta: le notifiche negate non compaiono insieme.
    expect(screen.queryByText(T.avvisoNotificheTitolo)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: T.avvisoAggiornaBottone }))
    expect(apriUrl).toHaveBeenCalledWith(url)
    expect(screen.queryByText(T.avvisoAggiornaTitolo)).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-mostrato', 'avviso-aggiorna-app-tocco-store'])
    expect(logClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ evento: 'avvio', livello: 'warn', campi: { piattaforma, esito: 'navigazione-richiesta' } }),
    )
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

  it('binario 1.0 con la 1.1 non ancora sullo store: niente «aggiorna», e la sua settimana resta intatta', async () => {
    stato.plugin = new Set(['PushNotifications'])
    statoPermessoPush.mockResolvedValue('granted')
    const { container } = await monta()
    // Si aspetta la PRESENZA di un fatto (la decisione è arrivata al permesso), non un'assenza.
    await waitFor(() => expect(statoPermessoPush).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
    expect(window.localStorage.getItem(CHIAVE_AGGIORNA)).toBeNull()
    expect(messaggiLog()).not.toContain('avviso-aggiorna-app-mostrato')
  })

  it('iOS pubblicato e Android no: su Android un 1.0 con le notifiche negate vede le notifiche, non «aggiorna»', async () => {
    stato.plugin = new Set(['PushNotifications'])
    stato.pubblicata = { ios: true, android: false }
    await monta()
    expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
    // Sulla 1.0 non c'è il plugin delle impostazioni: il percorso a parole.
    expect(screen.getByText(T.avvisoNotifichePercorso)).toBeTruthy()
    expect(screen.queryByText(T.avvisoAggiornaTitolo)).toBeNull()
    expect(window.localStorage.getItem(CHIAVE_AGGIORNA)).toBeNull()
  })

  it('StrictMode sul binario 1.0: il doppio montaggio mostra «aggiorna» invece di consumarne la settimana', async () => {
    // Su questo ramo la data si scrive PRIMA di qualunque await: senza la decisione di modulo il
    // primo montaggio la segnerebbe e verrebbe scartato, e il secondo troverebbe la data di oggi.
    stato.plugin = new Set(['PushNotifications'])
    stato.pubblicata = { ios: true, android: true }
    statoPermessoPush.mockResolvedValue('granted')
    await monta(true)
    expect(await screen.findByText(T.avvisoAggiornaTitolo)).toBeTruthy()
    expect(window.localStorage.getItem(CHIAVE_AGGIORNA)).not.toBeNull()
    expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(1)
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

    it('dopo il tocco sullo store: smontato e rimontato «aggiorna» non ricompare', async () => {
      stato.plugin = new Set(['PushNotifications'])
      stato.pubblicata = { ios: true, android: true }
      const { Avvisi, unmount } = await monta()
      fireEvent.click(await screen.findByRole('button', { name: T.avvisoAggiornaBottone }))
      expect(apriUrl).toHaveBeenCalledTimes(1)
      unmount()

      const { container } = rendi(Avvisi)
      await lasciaDecidere()
      expect(screen.queryByText(T.avvisoAggiornaTitolo)).toBeNull()
      expect(container.innerHTML).toBe('')
      expect(messaggiLog().filter((m) => m === 'avviso-aggiorna-app-mostrato')).toHaveLength(1)
    })
  })

  it('il doppio montaggio di StrictMode non consuma la settimana senza mostrarlo', async () => {
    await monta(true)
    expect(await screen.findByText(T.avvisoNotificheTitolo)).toBeTruthy()
    expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(CHIAVE_NOTIFICHE)).not.toBeNull()
    expect(window.localStorage.getItem(CHIAVE_AGGIORNA)).toBeNull()
  })
})
