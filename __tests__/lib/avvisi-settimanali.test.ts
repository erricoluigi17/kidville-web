import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GLI AVVISI SETTIMANALI DELL'APP NATIVA (compito AV1, spec 2026-09-24).
 *
 * Cosa inchiodano questi test, e come diventerebbero rossi:
 *  - la cadenza: al massimo UNA comparsa ogni sette giorni per avviso — togliere il controllo
 *    della data fa comparire l'avviso a ogni chiamata;
 *  - l'avviso delle notifiche solo con permesso `denied` — non con `prompt`, non con `granted`;
 *  - uno alla volta, l'aggiornamento prima: su un binario da aggiornare (lo decide
 *    `@/lib/native/aggiornamento-app`, dal 2026-09-29 col suo pop-up) l'avviso delle notifiche
 *    non compare e la sua settimana resta intatta;
 *  - uno storage che non scrive SPEGNE l'avviso (altrimenti comparirebbe a ogni avvio);
 *  - il plugin delle impostazioni si chiede al bridge PRIMA di chiamarlo, e si apre la pagina
 *    giusta per piattaforma.
 */

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  plugin: new Set<string>(['FileTransfer', 'NativeSettings', 'PushNotifications']),
  bridgeRotto: false,
  piattaformaRotta: false,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => {
      if (stato.piattaformaRotta) throw new TypeError('piattaforma')
      return stato.piattaforma
    },
    isPluginAvailable: (nome: string) => {
      if (stato.bridgeRotto) throw new TypeError('bridge')
      return stato.plugin.has(nome)
    },
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
  IOSSettings: { App: 'app', AppNotification: 'appNotification' },
}))

// Chi deve aggiornare lo verifica `__tests__/lib/aggiornamento-app.test.ts`: qui conta solo la
// risposta, e QUANDO la si chiede.
const appDaAggiornare = vi.hoisted(() =>
  vi.fn<() => Promise<{ piattaforma: 'ios' | 'android'; versione: string } | null>>(async () => null),
)
vi.mock('@/lib/native/aggiornamento-app', () => ({ appDaAggiornare }))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

import {
  CHIAVI_ULTIMA_COMPARSA,
  INTERVALLO_AVVISO_MS,
  apriImpostazioniNotifiche,
  avvisoDaMostrare,
  avvisoScaduto,
  impostazioniApribili,
} from '@/lib/native/avvisi-settimanali'

const ORA = Date.UTC(2026, 8, 25, 8, 0, 0)
const GIORNO = 24 * 60 * 60 * 1000

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.plugin = new Set(['FileTransfer', 'NativeSettings', 'PushNotifications'])
  stato.bridgeRotto = false
  stato.piattaformaRotta = false
  statoPermessoPush.mockReset()
  statoPermessoPush.mockResolvedValue('denied')
  appDaAggiornare.mockReset()
  appDaAggiornare.mockResolvedValue(null)
  apriSettings.mockReset()
  apriSettings.mockResolvedValue({ status: true })
  logClient.mockReset()
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('avvisoDaMostrare — la cadenza settimanale', () => {
  it('sul web non mostra niente, non chiede il permesso e non scrive la data', async () => {
    stato.nativo = false
    stato.plugin = new Set()
    expect(await avvisoDaMostrare(ORA)).toBeNull()
    expect(statoPermessoPush).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()
  })

  it('permesso negato su 1.1: compare una volta, poi tace per sette giorni, poi ricompare', async () => {
    expect(await avvisoDaMostrare(ORA)).toBe('notifiche-disattivate')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBe(String(ORA))

    expect(await avvisoDaMostrare(ORA + 60_000)).toBeNull()
    expect(await avvisoDaMostrare(ORA + 6 * GIORNO + 23 * 60 * 60 * 1000)).toBeNull()
    // Nei giorni in cui non è dovuto, il bridge non si tocca: né il permesso né la versione.
    expect(statoPermessoPush).toHaveBeenCalledTimes(1)
    expect(appDaAggiornare).toHaveBeenCalledTimes(1)

    expect(await avvisoDaMostrare(ORA + INTERVALLO_AVVISO_MS)).toBe('notifiche-disattivate')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBe(
      String(ORA + INTERVALLO_AVVISO_MS),
    )
  })

  it.each(['granted', 'prompt', 'non-disponibile', 'non-nativo'])(
    'permesso «%s»: niente avviso, e la settimana NON si consuma',
    async (permesso) => {
      statoPermessoPush.mockResolvedValue(permesso)
      expect(await avvisoDaMostrare(ORA)).toBeNull()
      expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()
    },
  )

  it.each(['ios', 'android'] as const)(
    'binario da aggiornare su %s con le notifiche negate: niente avviso, il permesso non si chiede, la settimana resta intatta',
    async (piattaforma) => {
      // Il pop-up «Aggiorna l'app» ha la precedenza, e l'aggiornamento porta anche il bottone
      // delle impostazioni: due richieste insieme coprirebbero la pagina.
      appDaAggiornare.mockResolvedValue({ piattaforma, versione: '1.0' })
      expect(await avvisoDaMostrare(ORA)).toBeNull()
      expect(statoPermessoPush).not.toHaveBeenCalled()
      expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()

      // Aggiornato, al primo avvio l'avviso delle notifiche arriva con la sua settimana intatta.
      appDaAggiornare.mockResolvedValue(null)
      expect(await avvisoDaMostrare(ORA + 60_000)).toBe('notifiche-disattivate')
    },
  )
})

describe('avvisoDaMostrare — bridge, orologio e storage', () => {

  it('un bridge che lancia non apre le impostazioni: percorso a parole, e una riga di log', () => {
    stato.bridgeRotto = true
    expect(impostazioniApribili()).toBe(false)
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: expect.stringContaining('avviso-settimanale-bridge-illeggibile') }),
    )
  })

  it('una data nel futuro (orologio spostato) non zittisce l\'avviso per sempre', () => {
    window.localStorage.setItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'], String(ORA + 300 * GIORNO))
    expect(avvisoScaduto('notifiche-disattivate', ORA)).toBe(true)
  })

  it('una data illeggibile vale «mai comparso»', () => {
    window.localStorage.setItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'], 'boh')
    expect(avvisoScaduto('notifiche-disattivate', ORA)).toBe(true)
  })

  it('storage che non SCRIVE: l\'avviso non compare (comparirebbe a ogni avvio), e lo dice una volta', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(await avvisoDaMostrare(ORA)).toBeNull()
    expect(await avvisoDaMostrare(ORA + 1)).toBeNull()
    const righe = logClient.mock.calls.filter(([e]) =>
      String((e as { messaggio: string }).messaggio).startsWith('avviso-settimanale-storage-inutilizzabile'),
    )
    // Esattamente una: è il primo guasto di storage di questo file (il flag è di modulo).
    expect(righe).toHaveLength(1)
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()
  })

  it('storage che non LEGGE: nessun avviso, e il permesso non si chiede nemmeno', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('negato', 'SecurityError')
    })
    expect(await avvisoDaMostrare(ORA)).toBeNull()
    expect(statoPermessoPush).not.toHaveBeenCalled()
  })
})

describe('apriImpostazioniNotifiche', () => {
  it('col plugin: apre la pagina Notifiche dell\'app su Android e la pagina dell\'app su iOS', async () => {
    expect(await apriImpostazioniNotifiche()).toBe('aperte')
    expect(apriSettings).toHaveBeenCalledTimes(1)
    expect(apriSettings).toHaveBeenCalledWith({ optionAndroid: 'app_notification', optionIOS: 'app' })
  })

  it('senza il plugin (app 1.0): non lo chiama e risponde «plugin-assente»', async () => {
    stato.plugin = new Set(['PushNotifications'])
    expect(await apriImpostazioniNotifiche()).toBe('plugin-assente')
    expect(apriSettings).not.toHaveBeenCalled()
  })

  it('il plugin che rifiuta: «errore», con una riga error e senza lanciare', async () => {
    apriSettings.mockRejectedValue(new TypeError('boom'))
    expect(await apriImpostazioniNotifiche()).toBe('errore')
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'avviso-notifiche-impostazioni-non-aperte: TypeError' }),
    )
  })

  it('il sistema che risponde status=false: «errore»', async () => {
    apriSettings.mockResolvedValue({ status: false })
    expect(await apriImpostazioniNotifiche()).toBe('errore')
  })
})
