import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * GLI AVVISI SETTIMANALI DELL'APP NATIVA (compito AV1, spec 2026-09-24).
 *
 * Cosa inchiodano questi test, e come diventerebbero rossi:
 *  - la cadenza: al massimo UNA comparsa ogni sette giorni per avviso — togliere il controllo
 *    della data fa comparire l'avviso a ogni chiamata;
 *  - il binario 1.0 si riconosce dall'ASSENZA di `FileTransfer`, e solo nella shell nativa;
 *  - l'avviso delle notifiche solo con permesso `denied` — non con `prompt`, non con `granted`;
 *  - uno storage che non scrive SPEGNE l'avviso (altrimenti comparirebbe a ogni avvio);
 *  - il plugin delle impostazioni si chiede al bridge PRIMA di chiamarlo, e si apre la pagina
 *    giusta per piattaforma;
 *  - la scheda dello store è quella dell'app, su entrambi gli store.
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

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

import {
  APP_1_1_PUBBLICATA,
  CHIAVI_ULTIMA_COMPARSA,
  INTERVALLO_AVVISO_MS,
  apriImpostazioniNotifiche,
  apriSchedaStore,
  avvisoDaMostrare,
  avvisoScaduto,
  binarioDaAggiornare,
  urlSchedaStore,
} from '@/lib/native/avvisi-settimanali'

const ORA = Date.UTC(2026, 8, 25, 8, 0, 0)
const GIORNO = 24 * 60 * 60 * 1000
/** La 1.1 pubblicata su entrambi gli store: i test del ramo «aggiorna» la dichiarano. */
const ACCESI = { ios: true, android: true } as const
const SPENTI = { ios: false, android: false } as const

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.plugin = new Set(['FileTransfer', 'NativeSettings', 'PushNotifications'])
  stato.bridgeRotto = false
  stato.piattaformaRotta = false
  statoPermessoPush.mockReset()
  statoPermessoPush.mockResolvedValue('denied')
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
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()
  })

  it('permesso negato su 1.1: compare una volta, poi tace per sette giorni, poi ricompare', async () => {
    expect(await avvisoDaMostrare(ORA)).toBe('notifiche-disattivate')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBe(String(ORA))

    expect(await avvisoDaMostrare(ORA + 60_000)).toBeNull()
    expect(await avvisoDaMostrare(ORA + 6 * GIORNO + 23 * 60 * 60 * 1000)).toBeNull()
    // Nei giorni in cui non è dovuto, il bridge non si tocca.
    expect(statoPermessoPush).toHaveBeenCalledTimes(1)

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

  it('binario 1.0 (niente FileTransfer) con la 1.1 sullo store: compare «aggiorna», una volta a settimana', async () => {
    stato.plugin = new Set(['PushNotifications'])
    statoPermessoPush.mockResolvedValue('granted')
    expect(await avvisoDaMostrare(ORA, ACCESI)).toBe('aggiorna-app')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBe(String(ORA))
    expect(await avvisoDaMostrare(ORA + 3 * GIORNO, ACCESI)).toBeNull()
    expect(await avvisoDaMostrare(ORA + 7 * GIORNO, ACCESI)).toBe('aggiorna-app')
  })

  it('1.0 con le notifiche negate: prima «aggiorna»; le notifiche al giro dopo, con la loro settimana intatta', async () => {
    stato.plugin = new Set(['PushNotifications'])
    expect(await avvisoDaMostrare(ORA, ACCESI)).toBe('aggiorna-app')
    // Non segnato: l'avviso delle notifiche non ha consumato la sua settimana.
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['notifiche-disattivate'])).toBeNull()
    expect(await avvisoDaMostrare(ORA + 60_000, ACCESI)).toBe('notifiche-disattivate')
    expect(await avvisoDaMostrare(ORA + 120_000, ACCESI)).toBeNull()
  })

  it('sul binario 1.1 l\'avviso «aggiorna» non compare mai, nemmeno con la 1.1 sullo store', async () => {
    statoPermessoPush.mockResolvedValue('granted')
    expect(binarioDaAggiornare()).toBe(false)
    expect(await avvisoDaMostrare(ORA, ACCESI)).toBeNull()
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
  })
})

describe('avvisoDaMostrare — «aggiorna» solo quando la 1.1 è sullo store', () => {
  it('il valore spedito: spento su entrambe le piattaforme finché la 1.1 non è pubblicata', () => {
    // Chi accende una piattaforma aggiorna QUESTA riga, dopo aver visto la 1.1 sullo store.
    expect(APP_1_1_PUBBLICATA).toEqual({ ios: false, android: false })
    expect(Object.isFrozen(APP_1_1_PUBBLICATA)).toBe(true)
  })

  it.each(['ios', 'android'])(
    'binario 1.0 su %s con l\'interruttore spento: niente avviso, e la settimana NON si consuma',
    async (piattaforma) => {
      stato.piattaforma = piattaforma
      stato.plugin = new Set(['PushNotifications'])
      statoPermessoPush.mockResolvedValue('granted')
      expect(binarioDaAggiornare()).toBe(true)
      expect(await avvisoDaMostrare(ORA, SPENTI)).toBeNull()
      expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
      // Anche col valore spedito (nessun secondo argomento), finché è spento.
      expect(await avvisoDaMostrare(ORA)).toBeNull()
      expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
    },
  )

  it('iOS acceso e Android spento: «aggiorna» compare solo su iOS', async () => {
    const SOLO_IOS = { ios: true, android: false }
    stato.plugin = new Set(['PushNotifications'])
    statoPermessoPush.mockResolvedValue('granted')

    stato.piattaforma = 'android'
    expect(await avvisoDaMostrare(ORA, SOLO_IOS)).toBeNull()
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()

    stato.piattaforma = 'ios'
    expect(await avvisoDaMostrare(ORA, SOLO_IOS)).toBe('aggiorna-app')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBe(String(ORA))
  })

  it('1.0 con le notifiche negate e l\'interruttore spento: compare l\'avviso delle notifiche, non «aggiorna»', async () => {
    stato.plugin = new Set(['PushNotifications'])
    expect(await avvisoDaMostrare(ORA, SPENTI)).toBe('notifiche-disattivate')
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
  })

  it('una piattaforma illeggibile non promette l\'aggiornamento: niente «aggiorna», una riga di log', async () => {
    stato.plugin = new Set(['PushNotifications'])
    stato.piattaformaRotta = true
    statoPermessoPush.mockResolvedValue('granted')
    expect(await avvisoDaMostrare(ORA, ACCESI)).toBeNull()
    expect(window.localStorage.getItem(CHIAVI_ULTIMA_COMPARSA['aggiorna-app'])).toBeNull()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', messaggio: 'avviso-aggiorna-app-piattaforma-illeggibile: TypeError' }),
    )
  })
})

describe('avvisoDaMostrare — bridge, orologio e storage', () => {

  it('un bridge che lancia NON è un binario 1.0: niente «aggiorna», e una riga di log', () => {
    stato.bridgeRotto = true
    expect(binarioDaAggiornare()).toBe(false)
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

describe('la scheda dello store', () => {
  it('iOS → App Store con l\'id dell\'app; Android → Google Play col pacchetto; altrove niente', () => {
    expect(urlSchedaStore('ios')).toBe('https://apps.apple.com/it/app/kidville/id6794883055')
    expect(urlSchedaStore('android')).toBe('https://play.google.com/store/apps/details?id=it.kidville.app')
    expect(urlSchedaStore('web')).toBeNull()
  })

  it('apriSchedaStore naviga verso la scheda della piattaforma corrente', () => {
    const apri = vi.fn()
    stato.piattaforma = 'ios'
    expect(apriSchedaStore(apri)).toContain('apps.apple.com')
    stato.piattaforma = 'android'
    apriSchedaStore(apri)
    expect(apri.mock.calls).toEqual([
      ['https://apps.apple.com/it/app/kidville/id6794883055'],
      ['https://play.google.com/store/apps/details?id=it.kidville.app'],
    ])
    stato.piattaforma = 'web'
    expect(apriSchedaStore(apri)).toBeNull()
    expect(apri).toHaveBeenCalledTimes(2)
  })
})
