import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Emissione della fattura elettronica — IL SUCCESSO SI LOGGA, E LO SCARTO DICE PERCHÉ.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * MISURATO SUI DATI VERI (produzione, 2026-08-02): in 30 giorni `app_log` aveva UNA sola riga
 * con `evento = 'fattura'`, livello `error`, e ZERO righe `info`. Gli altri eventi critici il
 * battito ce l'hanno: `email` 10 righe info, `push` 19, `cron` 213, `pagamento` 4.
 *
 * «fattura» è nominata nella regola 5 di AGENTS.md ed è in `EVENTI_PERSISTITI` proprio per
 * questo: con i soli errori, «nessun log» non distingue «nessuno ha emesso fatture» da
 * «l'emissione non parte più» — che è testualmente l'ambiguità che ha tenuto nascosto per mesi
 * il guasto delle email di credenziali.
 *
 * E lo SCARTO era anche peggio: il motivo del rifiuto di Aruba (`errorDescription`, es. «00404
 * File già inviato») finiva SOLO nella colonna `fatture_emesse.sdi_scarto_motivo` e nel corpo
 * HTTP della risposta. Nei log restava `KV_ERR evt=route stato=502`, cioè un numero.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * COME SI OSSERVA: `carica()` ricarica il grafo con `VITEST=''` (il logger è silenzioso sotto
 * vitest) e `app-log` MOCKATO — si vede la riga vera senza toccare nessun database.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'

let appLog: ReturnType<typeof vi.fn>

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

/** Tutte le righe finite in `app_log` (l'unico canale che dura 30 giorni e si interroga). */
async function righe(minimo = 1): Promise<Riga[]> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(minimo))
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

async function rigaCon(evento: string, livello: string): Promise<Riga> {
  await vi.waitFor(async () => {
    const trovate = (await righe(1)).filter((r) => r.evento === evento && r.livello === livello)
    expect(trovate.length, `nessuna riga ${evento}/${livello} in app_log`).toBeGreaterThan(0)
  })
  return (await righe()).find((r) => r.evento === evento && r.livello === livello) as Riga
}

/** Il doppio del fake di `fattura-emissione.test.ts`, con l'errore dell'INSERT pilotabile. */
function makeSupabase(
  responses: Record<string, unknown> & { rpc?: number; erroreInsert?: unknown; erroreUpdate?: unknown },
) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  const api = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: responses[table] ?? null, error: null }),
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: table === 'fatture_emesse' ? (responses.erroreInsert ?? null) : null }
        },
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: table === 'pagamenti' ? (responses.erroreUpdate ?? null) : null }
          },
        }),
      }
      return builder
    },
    rpc: async () => ({ data: responses.rpc ?? 1, error: null }),
    _inserts: inserts,
    _updates: updates,
  }
  return api
}

const pagamentoSaldato = {
  id: 'pag-1',
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scuola_id: SCUOLA,
  fattura_causale: null,
  alunno_id: 'al-1',
  alunni: {
    nome: 'Mario',
    cognome: 'Rossi',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}
const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    fiscal: {
      piva: '12345678903',
      ragione_sociale: 'Kidville Srl',
      regime: 'RF01',
      indirizzo: 'Via Roma 1',
      cap: '00100',
      comune: 'Roma',
      provincia: 'RM',
    },
  },
  fattura_causale_template: '{descrizione}',
}
const parent = {
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano 9',
  residence_city: 'Roma',
  zip_code: '00185',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('emettiFatturaPagamento — il battito che mancava', () => {
  it('IL SUCCESSO ARRIVA IN TABELLA: evento `fattura`, livello `info`, con numero e anno', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT12345678903_a1b2.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 7 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)

    const r = await rigaCon('fattura', 'info')
    // `numero` e `anno` sono NUMERI e `scuola_id` un uuid: `redact` li lascia in chiaro anche
    // in tabella, quindi «quali fatture sono partite ieri, e da quale sede» è una query.
    expect(JSON.stringify(r)).toContain('7')
    expect(JSON.stringify(r)).toContain(SCUOLA)
    // Il nome file di Aruba è la chiave con cui si ritrova la fattura sul portale e nel `sync`.
    expect(String(r.messaggio)).toContain('IT12345678903_a1b2.xml.p7m')
  })

  it('LO SCARTO PORTA IL MOTIVO DEL PROVIDER, non solo il numero', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({
        ok: false,
        errorCode: '00404',
        errorDescription: 'File già inviato con lo stesso nome',
      })),
    })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 8 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)

    const r = await rigaCon('fattura', 'error')
    expect(String(r.messaggio)).toContain('File già inviato')
    // `error_code` è in lista bianca: `where contesto->>'error_code' = '00404'` si può fare.
    expect(JSON.stringify(r)).toContain('00404')
  })

  it('nessun dato personale nella riga: il CF e il nome dell\'intestatario non escono', async () => {
    // La fattura è intestata a una persona fisica. La riga di successo racconta il DOCUMENTO
    // (numero, anno, sede, file), mai chi lo riceve — `redact` è a lista bianca, e questo test
    // è ciò che impedisce di allargarla «perché sarebbe comodo vedere a chi è intestata».
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 9 })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const tutte = JSON.stringify(await righe())
    expect(tutte).not.toContain('FRNGLI80A41H501Z')
    expect(tutte).not.toContain('Giulia')
    expect(tutte).not.toContain('Farina')
  })

  it('PostgREST NON lancia: se l\'INSERT a registro fallisce, la riga d\'errore c\'è', async () => {
    // Il caso più velenoso del file: la fattura È PARTITA verso lo SDI (Aruba ha risposto
    // `0000` e ha il suo `uploadFileName`), ma la riga `fatture_emesse` non è stata scritta.
    // Senza log, resta una fattura in volo che nessun `sync` ripescherà mai — e in tabella
    // non c'è niente che lo dica. Un `try/catch` qui non scatterebbe: PostgREST ritorna
    // `{ error }`, non lancia (AGENTS.md, regola 7).
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_orfana.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 11,
      erroreInsert: { message: 'duplicate key value violates unique constraint', code: '23505' },
    })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const r = await rigaCon('fattura', 'error')
    expect(String(r.messaggio) + JSON.stringify(r)).toContain('registro')
    // Il nome file resta leggibile: è l'unico appiglio per ritrovare la fattura su Aruba.
    expect(String(r.messaggio)).toContain('IT_orfana.xml.p7m')
  })

  it('PostgREST NON lancia (2): se lo stato del PAGAMENTO non si aggiorna, la riga c\'è', async () => {
    // La fattura è partita ED è a registro, ma `pagamenti.fattura_stato` è rimasto indietro:
    // in segreteria il bottone «Invia fattura» resta lì, invitando a rifare un'emissione già
    // avvenuta. L'idempotenza per-quota la ferma, ma nessuno saprebbe PERCHÉ la schermata
    // continua a mostrare un pagamento senza fattura.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_agg.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 12,
      erroreUpdate: { message: 'permission denied for table pagamenti', code: '42501' },
    })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const r = await rigaCon('fattura', 'error')
    expect(String(r.messaggio)).toContain('pagamento')
  })

  it('L\'AGGRAVANTE DOCUMENTALE: il `warn` del progressivo porta davvero il corpo di Aruba', async () => {
    // `emissione.ts` dichiarava, in un commento, che «il corpo dell'errore del provider va
    // conservato — è l'unica cosa che dice se è un token scaduto o un 5xx di Aruba». Era
    // FALSO: `client.ts` lo gettava a monte, e qui arrivava «Aruba findByUsername fallita
    // (HTTP 403)». Un commento che promette ciò che il codice non fa ferma l'indagine di chi
    // legge — costa più di un commento assente. Questo test è ciò che tiene vera la frase.
    //
    // NB: il client NON è mockato in questo test — è il pezzo che si sta verificando. Si
    // mocka la RETE, che è l'unica cosa che in un test non deve esistere.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_prog.xml.p7m', errorCode: '0000' })),
    })
    globalThis.fetch = vi.fn(
      async () => new Response('{"errorDescription":"User not enabled for outgoing invoices"}', { status: 403 }),
    ) as unknown as typeof fetch
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 14 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok, 'il ripiego sul contatore interno deve restare non bloccante').toBe(true)

    const r = await rigaCon('fattura', 'warn')
    expect(String(r.messaggio)).toContain('User not enabled for outgoing invoices')
    expect(r.codice).toBe('403')
  })

  it('PRIVACY: un codice fiscale nel motivo dello scarto di Aruba NON arriva in chiaro', async () => {
    // Aruba echeggia spesso il campo che ha rifiutato, e il cessionario di una fattura è una
    // persona fisica: «CodiceFiscale non valido: FRNGLI80A41H501Z» è un motivo di scarto
    // realistico. `sanificaMessaggio` gira sulla colonna `messaggio` proprio per questo — la
    // regola 3 (il corpo non si butta) e la regola 8 (mai PII nei log) qui si toccano, e la
    // conciliazione non è «allora non si logga», è «si logga mascherato».
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({
        ok: false,
        errorCode: '00300',
        errorDescription: 'CodiceFiscale non valido: FRNGLI80A41H501Z',
      })),
    })
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 13 })

    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const r = await rigaCon('fattura', 'error')
    // La FORMA dello scarto resta leggibile (è ciò che serve per capire cosa correggere)…
    expect(String(r.messaggio)).toContain('CodiceFiscale non valido')
    // …il dato del minore/genitore no.
    expect(JSON.stringify(r)).not.toContain('FRNGLI80A41H501Z')
  })
})
