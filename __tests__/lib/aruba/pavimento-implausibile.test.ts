import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * UN PAVIMENTO TROPPO ALTO È L'UNICO DANNO DA CUI NON SI TORNA INDIETRO.
 *
 * ─── PERCHÉ QUESTO CASO, E PERCHÉ È PIÙ GRAVE DI QUELLO OPPOSTO ─────────────────────
 * `prossimo_numero_fattura_sezionale` fa `GREATEST(ultimo_numero, p_min) + 1` sotto
 * advisory lock. Ne segue un'asimmetria che conviene tenere a mente:
 *
 *  · un `p_min` **troppo basso** è quasi sempre innocuo — il contatore in tabella è più
 *    avanti e `GREATEST` lo sceglie. (Non lo è il 1° gennaio, quando la riga dell'anno
 *    nuovo non esiste: quello è il caso che copre `serie-vuota` in `client.ts`.)
 *  · un `p_min` **troppo alto** alza il contatore e **non lo riabbassa mai**: la tabella
 *    si scrive solo da quella funzione, che è monotona. Per tornare indietro servirebbe
 *    una UPDATE a mano come `service_role` su un registro fiscale.
 *
 * E la strada per arrivarci è corta: `FORMA_NUMERO_SEZIONALE` accetta `\\d{1,9}` e il
 * pavimento è il **massimo** su tutto l'anno. Una sola etichetta anomala — un documento
 * caricato a mano con un numero sbagliato, un import di un altro gestionale — sposta la
 * serie di Kidville a un miliardo, per sempre, e la fattura successiva porta quel numero.
 *
 * Non è un difetto osservato: è un difetto **senza nessuna difesa**, su un dato
 * irreversibile. Costa una SELECT e la chiude.
 *
 * ─── PERCHÉ LA GUARDIA NON BLOCCA QUANDO NON SA ────────────────────────────────────
 * Se il contatore non si riesce a leggere, non c'è niente con cui confrontare. Bloccare
 * lì significherebbe fermare l'emissione su un database E2E non migrato (`42703`), e la
 * protezione vera contro i valori BASSI resta comunque il `GREATEST`. Quindi si logga e
 * si prosegue: è una cintura in più, non l'unica.
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

let righeLog: Record<string, unknown>[] = []

async function carica(finto: ClientFinto) {
  righeLog = []
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({
    appLog: vi.fn(async (riga: Record<string, unknown>) => {
      righeLog.push(riga)
    }),
  }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

/**
 * Fake di Supabase che CONTA le allocazioni e sa far fallire una SELECT.
 *
 * `errori` esiste per un caso solo, ed è quello che conta: PostgREST **non lancia**,
 * ritorna `{ error }`. Un fake che restituisce sempre `error: null` sarebbe verde con la
 * gestione dell'errore e senza.
 */
function makeSupabase(responses: Record<string, unknown> & { rpc?: number }, errori: Record<string, unknown> = {}) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: responses.rpc ?? 1, error: null }))
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: errori[table] ?? null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: errori[table] ?? null }),
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

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  // `SILENZIOSO` in `logger.ts` è vero sotto vitest, ed è una difesa giusta: una suite
  // non deve scrivere in `app_log`. Ma un test che vuole OSSERVARE i log deve spegnerla,
  // altrimenti asserisce sull'assenza di righe che nessuno ha mai provato a scrivere —
  // cioè su niente. Stessa riga di `emissione-log.test.ts:147`.
  vi.stubEnv('VITEST', '')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('il tetto sul pavimento letto da Aruba', () => {
  it('un\'etichetta a nove cifre NON raggiunge la RPC: il contatore non si sposta', async () => {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      // «Asilo 999999999/2026»: forma perfetta, valore impossibile.
      arubaUltimoNumeroFattura: vi.fn(async () => 999_999_999),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      // Il registro dice dove siamo davvero: duemilatrecento, non un miliardo.
      fatture_numerazione_sezionale: { ultimo_numero: 2331 },
      rpc: 2332,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      // `numerazione` è il motivo della QUOTA; l'aggregato di `EsitoEmissione` lo
      // rinomina, ed è il nome che la route mappa sul 503.
      expect(esito.motivo).toBe('numerazione_non_allineata')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc, 'la RPC alza il contatore e non lo riabbassa: qui non deve partire').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
    // Un rifiuto muto sarebbe indistinguibile da un guasto: il log dice il numero
    // rifiutato e quello a registro, così chi guarda capisce di quanto era fuori scala.
    //
    // ⚠️ `vi.waitFor` e non un controllo secco: la scrittura in `app_log` è
    // fire-and-forget dentro `after()`, quindi al ritorno di `emettiFatturaPagamento`
    // può non essere ancora arrivata. Un `expect` immediato qui sarebbe rosso a caso.
    await vi.waitFor(() => {
      const riga = righeLog.find((r) => String(r.messaggio ?? '').includes('fuori scala'))
      expect(riga, 'il rifiuto deve lasciare una riga in app_log').toBeTruthy()
      expect(riga?.livello, 'un numero che non si potrà riabbassare non è un «info»').toBe('error')
    })
  })

  it('un pavimento normale passa: la guardia non è un ostacolo al lavoro di tutti i giorni', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2331 },
      rpc: 2332,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(sb._rpc).toHaveBeenCalled()
  })

  it('anche un pavimento PIÙ ALTO del contatore passa, se lo scarto è plausibile', async () => {
    // È il caso vero, misurato il 2026-09-07: su Aruba la serie FPR era a 1955 e il
    // nostro contatore a 1952, perché tre fatture erano state scritte a mano dal
    // pannello. Quello scarto è il motivo per cui leggiamo Aruba: la guardia deve
    // fermare l'assurdo, non il funzionamento normale.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2334),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2331 },
      rpc: 2335,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(sb._rpc).toHaveBeenCalled()
  })

  it('se il contatore NON si legge, non si blocca: si logga e si prosegue', async () => {
    // PostgREST non lancia, ritorna `{ error }`. Sul database E2E della CI la tabella
    // può non esserci affatto (`42703`): una cintura che si rompe non deve fermare il
    // lavoro, perché la protezione contro i valori bassi resta il GREATEST della RPC.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase(
      {
        pagamenti: pagamentoSaldato,
        admin_settings: settingsConfig,
        parents: parentCompleto,
        rpc: 2332,
      },
      { fatture_numerazione_sezionale: { code: '42703', message: 'column does not exist' } },
    )

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'una guardia che non sa non deve impedire di lavorare').toBe(true)
    expect(sb._rpc).toHaveBeenCalled()
  })
})
