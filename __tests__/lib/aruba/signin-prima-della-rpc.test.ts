import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL `signin` VIENE PRIMA DELLA RPC CHE ALLOCA, NON DOPO.
 *
 * ─── IL DIFETTO, E PERCHÉ NON SI VEDEVA ─────────────────────────────────────────────
 * «Un `signin` fallito non costa niente» è vero **solo a cache fredda**, ed è per questo
 * che nessun test lo smentiva: un test in un processo pulito legge sempre il pavimento da
 * Aruba, e `leggiPavimentoSerie` chiama `ensureToken` per farlo. Il `signin` finisce prima
 * della RPC per caso.
 *
 * Con il pavimento **in cache** la funzione esce presto (`if (inCache !== null) return
 * inCache`) e non tocca `ensureToken`. L'ordine vero diventa:
 *
 *     pavimento dalla cache → RPC che ALLOCA il numero → signin → upload
 *
 * Cioè: se Aruba risponde `429` all'autenticazione — e ne concede **uno al minuto per
 * IP**, con il cron `fattura-sync` che ruba lo slot — l'eccezione risale al `catch`
 * dell'upload, che scrive una riga «Trasporto fallito» **con un numero consumato per un
 * accesso mai riuscito**. Un upload che non è mai partito viene registrato come esito
 * ignoto, e chi legge va a cercare su Aruba un documento che non esiste.
 *
 * ─── PERCHÉ QUESTO CASO HA BISOGNO DI DUE EMISSIONI ─────────────────────────────────
 * La prima serve solo a **scaldare la cache** (`cacheUltimoNumero` è una `Map` di modulo).
 * È la seconda a misurare, ed è l'unica forma in cui il difetto si manifesta: un test a
 * una sola emissione sarebbe verde con la correzione e senza.
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog: vi.fn(async () => {}) }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

function makeSupabase(responses: Record<string, unknown> & { rpc?: number }) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: responses.rpc ?? 1, error: null }))
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
}

const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: 'al-1',
  payment_categories: null,
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Rossi',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

const settingsConfig = {
  aruba_config: { username: 'utente@scuola.it', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' },
  fiscale_config: {
    denominazione: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
    piva: '03394870616',
    codice_fiscale: '03394870616',
    indirizzo: 'Via Silvio Pellico',
    numero_civico: '7',
    cap: '81030',
    comune: 'Cesa',
    provincia: 'CE',
    regime_fiscale: 'RF01',
  },
}

/** Intestatario SINTETICO e completo: nessun dato di famiglie vere nei test. */
const parentCompleto = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

function errore429(): Error {
  const e = new Error('Aruba signin fallita (HTTP 429): (nessun corpo nella risposta)')
  Object.assign(e, { code: '429' })
  return e
}

const risposteBase = {
  pagamenti: pagamentoSaldato,
  admin_settings: settingsConfig,
  parents: parentCompleto,
  fatture_numerazione_sezionale: { ultimo_numero: 2331 },
  rpc: 2332,
}

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('con il pavimento in cache, il signin resta PRIMA dell\'allocazione', () => {
  it('signin 429 alla seconda emissione → nessun numero consumato', async () => {
    const signin = vi
      .fn()
      // La prima passa: serve solo a scaldare la cache del pavimento.
      .mockImplementationOnce(async () => tokenOk)
      // La seconda no: è il minuto in cui il cron `fattura-sync` ha preso lo slot.
      .mockImplementation(async () => {
        throw errore429()
      })
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
    const pavimento = vi.fn(async () => 2331)
    const { emettiFatturaPagamento, svuotaCacheUltimoNumeroAruba } = await carica({
      arubaSignin: signin,
      arubaUltimoNumeroFattura: pavimento,
      arubaUpload: upload,
    })
    svuotaCacheUltimoNumeroAruba()

    // ── Giro 1: scalda la cache. Deve andare a buon fine. ──────────────────────
    const primo = makeSupabase(risposteBase)
    const esito1 = await emettiFatturaPagamento(primo as never, 'pag-1', { id: 'staff-1' })
    expect(esito1.ok, 'la prima emissione serve a scaldare la cache: deve riuscire').toBe(true)
    expect(pavimento, 'a cache fredda il pavimento si legge da Aruba').toHaveBeenCalledTimes(1)

    // ── Giro 2: cache calda, e il signin cade. ─────────────────────────────────
    const secondo = makeSupabase(risposteBase)
    const esito2 = await emettiFatturaPagamento(secondo as never, 'pag-2', { id: 'staff-1' })

    expect(pavimento, 'a cache calda il pavimento NON si rilegge: è il presupposto del caso').toHaveBeenCalledTimes(1)
    expect(esito2.ok).toBe(false)
    expect(
      secondo._rpc,
      'il numero è stato allocato per un accesso mai riuscito: è il buco che questo caso chiude',
    ).not.toHaveBeenCalled()
    expect(upload, "l'upload non può essere partito senza token").toHaveBeenCalledTimes(1)
    expect(
      secondo._inserts.filter((i) => i.table === 'fatture_emesse'),
      'nessuna riga «Trasporto fallito» per un upload che non è mai stato tentato',
    ).toHaveLength(0)
  })
})

describe('la sessione condivisa: un signin per BLOCCO, non per fattura', () => {
  it('due emissioni con la stessa sessione fanno UN solo signin', async () => {
    // È il cuore della fase 2. Senza la sessione, ogni invocazione di
    // `emettiFatturaPagamento` ha il suo `tokenCache` locale e quindi il suo `signin`:
    // dodici fatture sono dodici accessi, e Aruba ne concede uno al minuto per IP. È
    // questo — non gli upload — a imporre i novanta secondi fra una fattura e l'altra.
    const signin = vi.fn(async () => tokenOk)
    const { emettiFatturaPagamento, creaSessioneAruba, svuotaCacheUltimoNumeroAruba } = await carica({
      arubaSignin: signin,
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    svuotaCacheUltimoNumeroAruba()

    const sessione = creaSessioneAruba()
    const sb1 = makeSupabase(risposteBase)
    const sb2 = makeSupabase(risposteBase)
    expect((await emettiFatturaPagamento(sb1 as never, 'pag-1', { id: 'staff-1' }, { sessione })).ok).toBe(true)
    expect((await emettiFatturaPagamento(sb2 as never, 'pag-2', { id: 'staff-1' }, { sessione })).ok).toBe(true)

    expect(signin, 'la sessione esiste per questo, ed è la sola misura che lo dimostra').toHaveBeenCalledTimes(1)
  })

  it('SENZA sessione il comportamento non cambia: un signin per emissione', async () => {
    // La prova che la sessione è un'aggiunta e non una sostituzione. Senza questo caso,
    // il valore predefinito potrebbe essere cambiato per tutti senza che nessuno se ne
    // accorgesse — e sei chiamanti dipendono dal percorso di prima.
    const signin = vi.fn(async () => tokenOk)
    const { emettiFatturaPagamento, svuotaCacheUltimoNumeroAruba } = await carica({
      arubaSignin: signin,
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    svuotaCacheUltimoNumeroAruba()

    await emettiFatturaPagamento(makeSupabase(risposteBase) as never, 'pag-1', { id: 'staff-1' })
    await emettiFatturaPagamento(makeSupabase(risposteBase) as never, 'pag-2', { id: 'staff-1' })

    expect(signin).toHaveBeenCalledTimes(2)
  })
})
