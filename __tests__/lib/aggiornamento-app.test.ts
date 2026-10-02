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
 *
 * LA MINIMA DEL PERSONALE (spec 2026-10-02, T14), spedita SPENTA:
 *  - con `null` (il valore spedito) nessun effetto, né per il personale né per i genitori, e il
 *    ruolo non si chiede nemmeno: accenderla per sbaglio fa diventare rossi questi test;
 *  - accesa a 1.2: il personale sotto la 1.2 è da aggiornare, il personale alla 1.2 no, il genitore
 *    no — e sotto la minima dello store il pop-up resta per tutti, senza chiedere chi sia;
 *  - il ruolo non letto, che rifiuta o che resta appeso non promette niente (nel dubbio non si
 *    disturba): `null` e, per gli ultimi due, una riga di log;
 *  - chi è il «personale» lo dice la matrice delle aree (`AREE_PER_RUOLO`): chi apre `/teacher`.
 *    `leggiProfili` è finta qui; la sua lettura vera (una `GET /api/me` per sessione) ha i suoi test.
 */

type Profilo = { ruolo: string; area: string }

const stato = vi.hoisted(() => ({
  nativo: true,
  piattaforma: 'android' as string,
  plugin: new Set<string>(['App']),
  piattaformaRotta: false,
  getInfo: (async () => ({ version: '1.0', build: '1' })) as () => Promise<{ version: string; build: string }>,
  /** I profili che `/api/me` darebbe alla sessione; `null` = «non lo so» (accesso non fatto, rete giù). */
  profili: null as Profilo[] | null,
}))

// La lettura dei profili che la minima del personale chiede alla sessione. Finta, e spia: i test
// contano anche QUANTE volte e SE viene chiesta (con la minima spenta non deve esserlo mai).
const leggiProfili = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/use-profili', () => ({ leggiProfili }))

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
  TIMEOUT_RUOLO_MS,
  TIMEOUT_VERSIONE_MS,
  VERSIONE_MINIMA_PERSONALE,
  VERSIONE_MINIMA_STORE,
  apriSchedaStore,
  appDaAggiornare,
  confrontaVersioni,
  haProfiloDelPersonale,
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
  stato.profili = null
  logClient.mockReset()
  leggiProfili.mockReset()
  leggiProfili.mockImplementation(async () => stato.profili)
})

afterEach(() => {
  vi.useRealTimers()
  // Alcuni test si mettono sulla pagina di accesso: il prossimo riparte dalla radice.
  window.history.pushState({}, '', '/')
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

describe('VERSIONE_MINIMA_PERSONALE — il valore spedito', () => {
  it('SPENTA: null su entrambe le piattaforme, congelata', () => {
    // La minima del personale nasce spenta (T14) e si accende come l'altra: dopo aver visto la 1.2
    // pubblicata sullo store. Chi la accende aggiorna QUESTA riga e scrive nel commit quando l'ha
    // vista — e fino ad allora il pop-up per il personale non esiste.
    expect(VERSIONE_MINIMA_PERSONALE).toEqual({ ios: null, android: null })
    expect(Object.isFrozen(VERSIONE_MINIMA_PERSONALE)).toBe(true)
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

// I profili come li darebbe `/api/me` (`ruolo` e area di casa). Con aree vere: la decisione si prende
// sul RUOLO e la matrice delle aree lo traduce in «chi apre /teacher»; un profilo con un'area finta
// farebbe passare anche un codice che guardasse il campo sbagliato.
const DOCENTE: Profilo[] = [{ ruolo: 'educator', area: 'teacher' }]
const GENITORE: Profilo[] = [{ ruolo: 'genitore', area: 'parent' }]
const DOCENTE_E_GENITORE: Profilo[] = [...GENITORE, ...DOCENTE]
const PERSONALE: [string, Profilo[]][] = [
  ['educator', DOCENTE],
  ['admin', [{ ruolo: 'admin', area: 'admin' }]],
  ['coordinator', [{ ruolo: 'coordinator', area: 'admin' }]],
  ['segreteria', [{ ruolo: 'segreteria', area: 'admin' }]],
]

const STORE_1_1 = { ios: '1.1', android: '1.1' }
const PERSONALE_1_2 = { ios: '1.2', android: '1.2' }

function conVersione(versione: string): void {
  stato.getInfo = async () => ({ version: versione, build: '5' })
}

describe('haProfiloDelPersonale — chi lavora con l\'app', () => {
  it.each(['educator', 'admin', 'coordinator', 'segreteria'])('%s apre l\'area docente: sì', (ruolo) => {
    expect(haProfiloDelPersonale([{ ruolo }])).toBe(true)
  })

  it.each(['genitore', 'cuoca', 'maestra', ''])('«%s» non apre l\'area docente: no', (ruolo) => {
    // La cuoca vive nell'area `admin` ma non carica video; «maestra» è un ruolo vecchio che la
    // matrice non conosce, e un ruolo ignoto non apre niente: nel dubbio non si disturba.
    expect(haProfiloDelPersonale([{ ruolo }])).toBe(false)
  })

  it('un docente che è anche genitore conta per i ruoli reali, in qualunque ordine', () => {
    expect(haProfiloDelPersonale(DOCENTE_E_GENITORE)).toBe(true)
    expect(haProfiloDelPersonale([...DOCENTE, ...GENITORE])).toBe(true)
  })

  it('nessun profilo: no', () => {
    expect(haProfiloDelPersonale([])).toBe(false)
  })
})

describe('appDaAggiornare — la minima del personale', () => {
  describe('spenta (il valore spedito)', () => {
    it.each([
      ['il personale', DOCENTE],
      ['il genitore', GENITORE],
    ])('%s sul binario 1.1: niente, e il ruolo non si chiede', async (_chi, profili) => {
      stato.profili = profili
      conVersione('1.1')
      expect(await appDaAggiornare()).toBeNull()
      expect(leggiProfili).not.toHaveBeenCalled()
      expect(logClient).not.toHaveBeenCalled()
    })
  })

  describe('accesa a 1.2', () => {
    it.each(PERSONALE)('il personale (%s) sul binario 1.1: da aggiornare, su entrambe le piattaforme', async (_ruolo, profili) => {
      stato.profili = profili
      conVersione('1.1')
      for (const piattaforma of ['ios', 'android']) {
        stato.piattaforma = piattaforma
        expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toEqual({ piattaforma, versione: '1.1' })
      }
    })

    it.each(['1.2', '1.2.1', '1.10', '2.0'])('il personale sul binario %s: niente, e il ruolo non si chiede', async (versione) => {
      stato.profili = DOCENTE
      conVersione(versione)
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(leggiProfili).not.toHaveBeenCalled()
      expect(logClient).not.toHaveBeenCalled()
    })

    it('il genitore sul binario 1.1: niente, per lui vale solo la minima dello store', async () => {
      stato.profili = GENITORE
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      // Il ruolo è stato davvero chiesto: il «niente» viene da lì, non dal non aver guardato.
      expect(leggiProfili).toHaveBeenCalledTimes(1)
      expect(logClient).not.toHaveBeenCalled()
    })

    it.each([
      ['il genitore', GENITORE],
      ['il personale', DOCENTE],
    ])('%s sul binario 1.0: da aggiornare per la minima dello store, senza chiedere chi sia', async (_chi, profili) => {
      stato.profili = profili
      conVersione('1.0')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toEqual({ piattaforma: 'android', versione: '1.0' })
      expect(leggiProfili).not.toHaveBeenCalled()
    })

    it('un docente che è anche genitore sul binario 1.1: da aggiornare, conta ogni ruolo reale', async () => {
      stato.profili = DOCENTE_E_GENITORE
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toEqual({ piattaforma: 'android', versione: '1.1' })
    })

    it('la cuoca sul binario 1.1: niente (non carica video)', async () => {
      stato.profili = [{ ruolo: 'cuoca', area: 'admin' }]
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(leggiProfili).toHaveBeenCalledTimes(1)
    })

    it('minima dello store spenta e minima del personale accesa: il bridge si tocca e il ruolo decide', async () => {
      const spenta = { ios: null, android: null }
      conVersione('1.1')
      stato.profili = DOCENTE
      expect(await appDaAggiornare(spenta, PERSONALE_1_2)).toEqual({ piattaforma: 'android', versione: '1.1' })
      stato.profili = GENITORE
      expect(await appDaAggiornare(spenta, PERSONALE_1_2)).toBeNull()
    })

    it('accesa su una piattaforma sola: l\'altra non tocca né il bridge né il ruolo', async () => {
      const getInfo = vi.fn(async () => ({ version: '1.1', build: '5' }))
      stato.getInfo = getInfo
      stato.profili = DOCENTE
      const store = { ios: '1.1', android: null }
      const personale = { ios: '1.2', android: null }
      expect(await appDaAggiornare(store, personale)).toBeNull()
      expect(getInfo).not.toHaveBeenCalled()
      expect(leggiProfili).not.toHaveBeenCalled()
      stato.piattaforma = 'ios'
      expect(await appDaAggiornare(store, personale)).toEqual({ piattaforma: 'ios', versione: '1.1' })
    })

    it('una minima del personale più bassa di quella dello store non cambia niente', async () => {
      const piuBassa = { ios: '1.0', android: '1.0' }
      stato.profili = DOCENTE
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, piuBassa)).toBeNull()
      expect(leggiProfili).not.toHaveBeenCalled()
      conVersione('1.0')
      expect(await appDaAggiornare(STORE_1_1, piuBassa)).toEqual({ piattaforma: 'android', versione: '1.0' })
    })

    it('dalla pagina di accesso (pubblica): niente, e il ruolo non si chiede', async () => {
      // Lì non c'è un ruolo da leggere: la `GET /api/me` darebbe 401 e un `profili-non-letti` per un
      // fatto previsto. Anche con dei profili «pronti» (che lì non esistono) non si chiede.
      window.history.pushState({}, '', '/auth/login')
      stato.profili = DOCENTE
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(leggiProfili).not.toHaveBeenCalled()
      expect(logClient).not.toHaveBeenCalled()
    })

    it('dalla pagina di accesso la minima dello store vale lo stesso: il binario 1.0 è da aggiornare', async () => {
      window.history.pushState({}, '', '/auth/login')
      conVersione('1.0')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toEqual({ piattaforma: 'android', versione: '1.0' })
      expect(leggiProfili).not.toHaveBeenCalled()
    })

    it('sul web non chiede niente, né al bridge né ai profili', async () => {
      stato.nativo = false
      stato.profili = DOCENTE
      const getInfo = vi.fn(async () => ({ version: '1.1', build: '5' }))
      stato.getInfo = getInfo
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(getInfo).not.toHaveBeenCalled()
      expect(leggiProfili).not.toHaveBeenCalled()
    })

    it('una minima del personale in un formato inatteso non promette l\'aggiornamento', async () => {
      stato.profili = DOCENTE
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, { ios: '1.x', android: '1.x' })).toBeNull()
      expect(messaggiLog()).toEqual(['avviso-aggiorna-app-versione-illeggibile: formato'])
      expect(leggiProfili).not.toHaveBeenCalled()
    })
  })

  describe('il ruolo che non si legge: nel dubbio non si disturba', () => {
    it('non letto (rete giù, sessione scaduta, risposta illeggibile): niente', async () => {
      stato.profili = null
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      // Chiesto davvero: il «niente» viene da un ruolo che non si sa, non da una richiesta saltata.
      // La riga di log la scrive chi ha fatto la richiesta (`profili-non-letti`, `use-profili.ts`).
      expect(leggiProfili).toHaveBeenCalledTimes(1)
    })

    it('la lettura rifiuta: niente, una riga warn col nome dell\'errore', async () => {
      leggiProfili.mockRejectedValue(new RangeError('boom'))
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(logClient).toHaveBeenCalledWith(
        expect.objectContaining({
          livello: 'warn',
          evento: 'avvio',
          messaggio: 'avviso-aggiorna-app-ruolo-illeggibile: RangeError',
        }),
      )
    })

    it('un profilo rotto nella risposta: niente, una riga di log', async () => {
      stato.profili = [null as unknown as Profilo]
      conVersione('1.1')
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(messaggiLog()).toEqual(['avviso-aggiorna-app-ruolo-illeggibile: TypeError'])
    })

    it('la lettura resta appesa: dopo il timeout niente, e lo dice', async () => {
      vi.useFakeTimers()
      leggiProfili.mockImplementation(() => new Promise(() => {}))
      conVersione('1.1')
      const esito = appDaAggiornare(STORE_1_1, PERSONALE_1_2)
      await vi.advanceTimersByTimeAsync(TIMEOUT_RUOLO_MS)
      expect(await esito).toBeNull()
      expect(messaggiLog()).toEqual(['avviso-aggiorna-app-ruolo-illeggibile: timeout'])
    })
  })

  /**
   * LA LETTURA VERA. Sopra `leggiProfili` è finta e dà ai test la forma che vogliono: un finto piatto
   * non dimostra che la risposta di `/api/me` arrivi fino alla decisione. Qui gira la funzione VERA
   * (`vi.importActual`: cache, lettura del corpo, log dei guasti) con la sola `fetch` finta.
   */
  describe('con la lettura vera dei profili (GET /api/me)', () => {
    let fetchFinta: ReturnType<typeof vi.fn>

    function rispondi(codice: number, corpo?: unknown): void {
      fetchFinta.mockResolvedValue({ ok: codice >= 200 && codice < 300, status: codice, json: async () => corpo })
    }

    beforeEach(async () => {
      const vero = await vi.importActual<typeof import('@/lib/auth/use-profili')>('@/lib/auth/use-profili')
      vero.invalidaProfiliCache()
      leggiProfili.mockImplementation(vero.leggiProfili)
      fetchFinta = vi.fn()
      vi.stubGlobal('fetch', fetchFinta)
      conVersione('1.1')
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('un docente: da aggiornare, con UNA richiesta a /api/me', async () => {
      rispondi(200, { role: 'educator', profili: DOCENTE })
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toEqual({ piattaforma: 'android', versione: '1.1' })
      expect(fetchFinta).toHaveBeenCalledTimes(1)
      expect(fetchFinta.mock.calls[0][0]).toBe('/api/me')
      expect(logClient).not.toHaveBeenCalled()
    })

    it('un genitore: niente', async () => {
      rispondi(200, { role: 'genitore', profili: GENITORE })
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(fetchFinta).toHaveBeenCalledTimes(1)
      expect(logClient).not.toHaveBeenCalled()
    })

    it('una risposta senza `profili`: niente, e nessun errore', async () => {
      rispondi(200, { role: 'educator' })
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(logClient).not.toHaveBeenCalled()
    })

    it('non ancora dentro (401): niente, e il perché lo scrive UNA volta chi ha fatto la richiesta', async () => {
      rispondi(401, { error: 'Non autenticato' })
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      // Una riga sola, di `use-profili`: questo modulo non ne aggiunge una seconda per lo stesso fatto.
      expect(messaggiLog()).toEqual(['profili-non-letti — http=401'])
    })

    it('la rete non risponde: niente, e il perché lo scrive chi ha fatto la richiesta', async () => {
      fetchFinta.mockRejectedValue(new TypeError('Failed to fetch'))
      expect(await appDaAggiornare(STORE_1_1, PERSONALE_1_2)).toBeNull()
      expect(messaggiLog()).toEqual(['profili-non-letti — http=nessuno errore=TypeError'])
    })

    it('la richiesta è condivisa: una seconda decisione nella stessa sessione non ne apre un\'altra', async () => {
      // La PREMESSA del costo, che qui si verifica senza che dipenda da questo modulo: l'avviso
      // settimanale delle notifiche chiama `appDaAggiornare()` a sua volta, e i menu leggono gli stessi
      // profili. Se `leggiProfili` smettesse di condividere la richiesta, per il personale il pop-up
      // costerebbe una `GET /api/me` in più a ogni decisione, e questo test lo direbbe.
      rispondi(200, { role: 'educator', profili: DOCENTE })
      await appDaAggiornare(STORE_1_1, PERSONALE_1_2)
      await appDaAggiornare(STORE_1_1, PERSONALE_1_2)
      expect(fetchFinta).toHaveBeenCalledTimes(1)
    })
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
