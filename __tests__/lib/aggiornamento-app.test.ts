import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * CHI DEVE AGGIORNARE L'APP (spec 2026-09-29, pop-up «Aggiorna l'app»).
 *
 * Cosa inchiodano questi test, e come diventerebbero rossi:
 *  - si decide dalla VERSIONE del binario (`App.getInfo().version`) contro la minima per
 *    piattaforma — togliere il confronto fa comparire il pop-up anche sulla 1.1;
 *  - il confronto è numerico per segmento: `1.10` è più nuova di `1.9`;
 *  - sul web, su una piattaforma diversa da iOS/Android o con la minima `null` non si chiede
 *    niente al bridge;
 *  - una versione illeggibile, un `getInfo` che rifiuta o che RESTA APPESO non promettono un
 *    aggiornamento: `null` e una riga di log (nel dubbio non si disturba);
 *  - il plugin finto è un PROXY FEDELE a quello di Capacitor, che risponde anche a `then`: una
 *    funzione che restituisse il plugin da una promise resterebbe appesa qui come sul telefono
 *    (#166 → #168). Un finto piatto sarebbe verde anche col difetto.
 */

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  plugin: new Set<string>(['App']),
  piattaformaRotta: false,
  getInfo: (async () => ({ version: '1.0', build: '1' })) as () => Promise<{ version: string; build: string }>,
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => stato.nativo,
    getPlatform: () => {
      if (stato.piattaformaRotta) throw new TypeError('piattaforma')
      return stato.piattaforma
    },
    isPluginAvailable: (nome: string) => stato.plugin.has(nome),
  },
}))

// Il proxy di `registerPlugin`: risponde a OGNI proprietà, `then` compreso. Chiamato come thenable
// non richiama né `resolve` né `reject` — esattamente il bridge vero, che rifiuta a parte.
vi.mock('@capacitor/app', () => ({
  App: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'getInfo') return () => stato.getInfo()
        return () => new Promise(() => {})
      },
    },
  ),
}))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e as Error)?.name ?? 'Errore',
}))

import {
  TIMEOUT_VERSIONE_MS,
  VERSIONE_MINIMA_STORE,
  apriSchedaStore,
  appDaAggiornare,
  confrontaVersioni,
  urlSchedaStore,
} from '@/lib/native/aggiornamento-app'

function messaggiLog(): string[] {
  return logClient.mock.calls.map(([e]) => (e as { messaggio: string }).messaggio)
}

beforeEach(() => {
  stato.nativo = true
  stato.piattaforma = 'android'
  stato.plugin = new Set(['App'])
  stato.piattaformaRotta = false
  stato.getInfo = async () => ({ version: '1.0', build: '1' })
  logClient.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('confrontaVersioni', () => {
  it.each([
    ['1.0', '1.1', -1],
    ['1.1', '1.1', 0],
    ['1.2', '1.1', 1],
    ['1.10', '1.9', 1],
    ['1.1.0', '1.1', 0],
    ['2', '1.9.9', 1],
  ])('%s contro %s → %i', (a, b, atteso) => {
    expect(confrontaVersioni(a, b)).toBe(atteso)
  })

  it.each(['', '1.x', 'abc', '1..0', ' 1.0'])('«%s» è illeggibile: null', (v) => {
    expect(confrontaVersioni(v, '1.1')).toBeNull()
  })
})

describe('VERSIONE_MINIMA_STORE — il valore spedito', () => {
  it('1.1 su entrambe le piattaforme, congelato', () => {
    // Chi alza una piattaforma aggiorna QUESTA riga, dopo aver visto la versione sullo store.
    expect(VERSIONE_MINIMA_STORE).toEqual({ ios: '1.1', android: '1.1' })
    expect(Object.isFrozen(VERSIONE_MINIMA_STORE)).toBe(true)
  })
})

describe('appDaAggiornare', () => {
  it.each(['ios', 'android'])('binario 1.0 su %s: da aggiornare', async (piattaforma) => {
    stato.piattaforma = piattaforma
    expect(await appDaAggiornare()).toEqual({ piattaforma, versione: '1.0' })
  })

  it.each(['1.1', '1.2', '2.0'])('binario %s: niente', async (versione) => {
    stato.getInfo = async () => ({ version: versione, build: '5' })
    expect(await appDaAggiornare()).toBeNull()
    expect(logClient).not.toHaveBeenCalled()
  })

  it('sul web non chiede niente al bridge', async () => {
    stato.nativo = false
    const getInfo = vi.fn(stato.getInfo)
    stato.getInfo = getInfo
    expect(await appDaAggiornare()).toBeNull()
    expect(getInfo).not.toHaveBeenCalled()
  })

  it('piattaforma diversa da iOS/Android: niente', async () => {
    stato.piattaforma = 'electron'
    expect(await appDaAggiornare()).toBeNull()
  })

  it('minima null per la piattaforma: niente, e getInfo non si chiama', async () => {
    const getInfo = vi.fn(stato.getInfo)
    stato.getInfo = getInfo
    expect(await appDaAggiornare({ ios: '1.1', android: null })).toBeNull()
    expect(getInfo).not.toHaveBeenCalled()
    stato.piattaforma = 'ios'
    expect(await appDaAggiornare({ ios: '1.1', android: null })).toEqual({ piattaforma: 'ios', versione: '1.0' })
  })

  it('senza il plugin App nel binario: niente, una riga di log', async () => {
    stato.plugin = new Set()
    expect(await appDaAggiornare()).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-versione-illeggibile: plugin-assente'])
  })

  it('piattaforma illeggibile: niente, una riga di log', async () => {
    stato.piattaformaRotta = true
    expect(await appDaAggiornare()).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-versione-illeggibile: TypeError'])
  })

  it('getInfo che rifiuta: niente, una riga warn col nome dell\'errore', async () => {
    stato.getInfo = async () => {
      throw new RangeError('boom')
    }
    expect(await appDaAggiornare()).toBeNull()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'warn',
        evento: 'avvio',
        messaggio: 'avviso-aggiorna-app-versione-illeggibile: RangeError',
      }),
    )
  })

  it('getInfo che resta appeso: dopo il timeout niente, e lo dice', async () => {
    vi.useFakeTimers()
    stato.getInfo = () => new Promise(() => {})
    const esito = appDaAggiornare()
    await vi.advanceTimersByTimeAsync(TIMEOUT_VERSIONE_MS)
    expect(await esito).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-versione-illeggibile: timeout'])
  })

  it('una versione in un formato inatteso non promette l\'aggiornamento', async () => {
    stato.getInfo = async () => ({ version: '1.0-beta', build: '1' })
    expect(await appDaAggiornare()).toBeNull()
    expect(messaggiLog()).toEqual(['avviso-aggiorna-app-versione-illeggibile: formato'])
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

  it('piattaforma illeggibile: non naviga, e lo dice a livello error', () => {
    const apri = vi.fn()
    stato.piattaformaRotta = true
    expect(apriSchedaStore(apri)).toBeNull()
    expect(apri).not.toHaveBeenCalled()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'avviso-aggiorna-app-piattaforma-illeggibile: TypeError' }),
    )
  })
})
