// @vitest-environment node
/**
 * «DEVONO USCIRE IDENTICHE» — il collaudo che confronta il documento emesso dal
 * software con quello che la segreteria scrive a mano nella STESSA serie fiscale.
 *
 * ─── DA DOVE VENGONO QUESTE ASSERZIONI ───────────────────────────────────────
 * Non da `docs/fatturazione/tracciato-di-riferimento.md`: quel file è un riassunto,
 * e un test che ricopia un documento certifica il documento, non il prodotto. Le
 * quattro forme qui sotto sono state MISURATE il 2026-08-10 scaricando due fatture
 * vere con `scripts/aruba-campioni.mjs` — `Asilo 2327/2026` e `FPR 1946/26` — ed
 * estraendo il tracciato dall'involucro `.p7m` con `openssl cms`. Gli XML non
 * entrano in questo repository (contengono nomi e codici fiscali di minori, e il
 * repository è pubblico): qui resta solo ciò che si è misurato.
 *
 *   1. `<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>`
 *      — `Art.` maiuscolo, anno a DUE cifre;
 *   2. `<Contatti><Email>` del cedente: PRESENTE, dopo `<Sede>`;
 *   3. `<Causale>`: ASSENTE — la descrizione sta solo nella riga;
 *   4. `<DettaglioPagamento>`: solo modalità, scadenza e importo. Niente `<IBAN>`,
 *      niente `<Beneficiario>`.
 *
 * Fino a quel giorno il motore sbagliava tutte e quattro, e su tre di esse c'era un
 * documento del repo che diceva la cosa giusta accanto al codice che faceva l'altra.
 *
 * ─── E LE DUE LETTURE CHE NON POSSONO FALLIRE IN SILENZIO ────────────────────
 * `fiscale_config` illeggibile faceva ripiegare il cedente su `aruba_config.fiscal`
 * senza un segnale: un guasto di lettura cambiava CHI EMETTE il documento. Qui si
 * misura che non si emette più.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validaFatturaPA } from './valida-xsd'

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'
/** 2026-03-31: anno fiscale 2026, anno scolastico 2025/26. Il tempo non si legge dall'orologio. */
const ADESSO = new Date('2026-03-31T10:00:00Z')

let appLog: ReturnType<typeof vi.fn>

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

/**
 * Ricarica il grafo con il logger OSSERVABILE (`VITEST=''` + `app-log` mockato) e il
 * client Aruba finto. Stessa tecnica di `emissione-log.test.ts`: senza, le righe di
 * log non si vedono e «il difetto è muto» resterebbe indimostrabile.
 */
async function carica(finto: Record<string, unknown> = {}) {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return {
      ...actual,
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 0),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
      ...finto,
    }
  })
  return await import('@/lib/aruba/emissione')
}

async function righe(): Promise<Riga[]> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(1))
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

/** Le righe di log che portano questo `esito`: è la chiave con cui si interrogano in tabella. */
async function righeConEsito(esito: string): Promise<Riga[]> {
  return (await righe()).filter((r) => JSON.stringify(r).includes(esito))
}

/**
 * Il finto Supabase, con una capacità in più rispetto agli altri file: la SELECT su
 * `admin_settings` può fallire per una COLONNA precisa. Serve perché il difetto da
 * chiudere è proprio quello — `getModuleConfig` restituiva `{}` sia quando la config
 * non c'è sia quando non si è potuta leggere, e le due cose portavano a documenti
 * diversi.
 */
function makeSupabase(
  responses: Record<string, unknown> & { rpc?: number; colonneRotte?: string[] },
) {
  const inserts: { table: string; row: unknown }[] = []
  const rotte = new Set(responses.colonneRotte ?? [])
  const api = {
    from(table: string) {
      let colonne = ''
      const builder = {
        select: (c?: string) => {
          colonne = c ?? ''
          return builder
        },
        eq: () => builder,
        single: async () => ({ data: responses[table] ?? null, error: null }),
        maybeSingle: async () =>
          rotte.has(colonne)
            ? { data: null, error: { code: '42501', message: `permission denied for column ${colonne}` } }
            : { data: responses[table] ?? null, error: null },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
      return builder
    },
    rpc: async () => ({ data: responses.rpc ?? 1, error: null }),
    _inserts: inserts,
  }
  return api
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
    // Dati SINTETICI: il repository è pubblico e i bambini veri non entrano nei test.
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

/** L'anagrafica del cedente nella fonte unica, con l'IBAN configurato APPOSTA. */
const cedenteConfigurato = {
  denominazione: 'Kidville Scuola Cooperativa',
  piva: '12345678903',
  codice_fiscale: '12345678903',
  indirizzo: 'Via Roma',
  numero_civico: '1',
  cap: '00100',
  comune: 'Roma',
  provincia: 'RM',
  regime_fiscale: 'RF01',
  email: 'segreteria@esempio-kidville.test',
  // Se il motore tornasse a leggerlo, i casi qui sotto diventerebbero rossi. È la
  // ragione per cui resta nella fixture invece di essere tolto.
  iban: 'IT60X0542811101000000123456',
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    // Il RIPIEGO storico, con una denominazione DIVERSA: è ciò che permette di
    // misurare quale anagrafica è finita sul documento.
    fiscal: {
      piva: '12345678903',
      ragione_sociale: 'ANAGRAFICA DI RIPIEGO SRL',
      regime: 'RF01',
      indirizzo: 'Via del Ripiego 9',
      cap: '00100',
      comune: 'Roma',
      provincia: 'RM',
    },
  },
  fiscale_config: cedenteConfigurato,
}

const parent = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via Milano',
  residence_street_number: '9',
  residence_city: 'Roma',
  residence_province: 'RM',
  zip_code: '00185',
}

function xmlEmesso(sb: ReturnType<typeof makeSupabase>): string {
  const riga = sb._inserts.find((i) => i.table === 'fatture_emesse')
  expect(riga, 'nessuna riga scritta in fatture_emesse: la fattura non è partita').toBeTruthy()
  return (riga!.row as { xml_inviato: string }).xml_inviato
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('la fattura emessa dal software e quella scritta a mano: stesso tracciato', () => {
  it('le QUATTRO forme misurate sui documenti veri sono tutte rispettate', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 2328 })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const xml = xmlEmesso(sb)

    // 1. la dicitura dell'esenzione, lettera per lettera.
    expect(xml).toContain('<RiferimentoNormativo>Esente Art. 10 DPR 633/72</RiferimentoNormativo>')
    expect(xml).not.toContain('DPR 633/1972')

    // 2. i contatti del cedente, DENTRO CedentePrestatore e dopo la sede.
    const cedente = xml.slice(xml.indexOf('<CedentePrestatore>'), xml.indexOf('</CedentePrestatore>'))
    expect(cedente).toContain('<Contatti>')
    expect(cedente).toContain('<Email>segreteria@esempio-kidville.test</Email>')
    expect(cedente.indexOf('<Contatti>')).toBeGreaterThan(cedente.indexOf('</Sede>'))

    // 3. `<Causale>` assente: il testo sta SOLO nella descrizione della riga.
    expect(xml).not.toContain('<Causale>')
    expect(xml).toContain('<Descrizione>')

    // 4. il blocco pagamento con tre elementi e basta.
    expect(xml).toContain('<ModalitaPagamento>MP05</ModalitaPagamento>')
    expect(xml).not.toContain('<IBAN>')
    expect(xml).not.toContain(cedenteConfigurato.iban)
    expect(xml).not.toContain('<Beneficiario>')
  })

  it('…e quel documento è valido per lo XSD ufficiale (l\'ordine di `<Contatti>` non è un\'opinione)', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({ pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parent, rpc: 2328 })
    await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    const esito = await validaFatturaPA(xmlEmesso(sb))
    expect(esito.errori).toEqual([])
    expect(esito.valido).toBe(true)
  })

  it('senza email configurata il documento parte lo stesso, ma la DIFFERENZA è scritta nei log', async () => {
    const { emettiFatturaPagamento } = await carica()
    const senzaEmail = { ...cedenteConfigurato, email: '' }
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fiscale_config: senzaEmail },
      parents: parent,
      rpc: 2329,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    const xml = xmlEmesso(sb)
    expect(xml).not.toContain('<Contatti>')
    // Un documento senza contatti resta valido: l'elemento è facoltativo. Ciò che
    // non deve essere facoltativo è SAPERLO.
    expect((await validaFatturaPA(xml)).valido).toBe(true)

    const avvisi = await righeConEsito('cedente-senza-email')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].livello).toBe('warn')
    expect(String(avvisi[0].messaggio)).toContain('Contatti')
  })

  it('un\'email malformata non arriva al tracciato: si ferma nel gate del cedente', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fiscale_config: { ...cedenteConfigurato, email: 'segreteria@scuola' } },
      parents: parent,
      rpc: 2330,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('non_configurato')
      expect(esito.messaggio).toContain('email')
    }
    // Nessun numero consumato: il gate del cedente sta PRIMA della RPC.
    expect(sb._inserts).toHaveLength(0)
  })
})

describe('le letture di configurazione che non possono fallire in silenzio', () => {
  it('`fiscale_config` illeggibile: NON si ripiega sull\'altra anagrafica, non si emette', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 2331,
      colonneRotte: ['fiscale_config'],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(503)
      // Il messaggio deve dire che è una LETTURA fallita: mandare la segreteria a
      // ricompilare un'anagrafica che è a posto è il difetto un passo più in là.
      expect(esito.messaggio).toContain('lettura')
    }
    // La prova che il ripiego non è entrato: nessun documento, quindi nemmeno uno
    // intestato ad «ANAGRAFICA DI RIPIEGO SRL».
    expect(sb._inserts).toHaveLength(0)

    const fermate = await righeConEsito('fiscale-config-non-letta')
    expect(fermate).toHaveLength(1)
    expect(fermate[0].livello).toBe('error')

    // …e la riga di `getModuleConfig` dice ORA quale colonna e di quale sede: senza,
    // l'allarme non era nemmeno interrogabile.
    const illeggibili = await righeConEsito('config-illeggibile-fiscale_config')
    expect(illeggibili).toHaveLength(1)
    expect(JSON.stringify(illeggibili[0])).toContain(SCUOLA)
  })

  it('`fattura_causali_config` illeggibile: non si scrive una descrizione diversa da quella configurata', async () => {
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parent,
      rpc: 2332,
      colonneRotte: ['fattura_causali_config'],
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.httpStatus).toBe(503)
    expect(sb._inserts).toHaveLength(0)
    expect(await righeConEsito('causali-config-non-letta')).toHaveLength(1)
  })

  it('config ASSENTE non è config ILLEGGIBILE: senza `fiscale_config` il ripiego resta e la fattura parte', async () => {
    // L'altra metà della regola. Senza questo caso, «fail-closed» si otterrebbe
    // anche bloccando le sedi che semplicemente non hanno mai compilato il pannello.
    const { emettiFatturaPagamento } = await carica()
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: { ...settingsConfig, fiscale_config: undefined },
      parents: parent,
      rpc: 2333,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)
    expect(xmlEmesso(sb)).toContain('<Denominazione>ANAGRAFICA DI RIPIEGO SRL</Denominazione>')
  })
})
