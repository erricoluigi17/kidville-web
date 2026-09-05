import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA GUARDIA GUARDATA DAL BONIFICO — «questa retta l'abbiamo già fatturata?»
 *
 * ─── PERCHÉ UN FILE NUOVO, e non un caso in più altrove ──────────────────────
 * La fattura si emette per `pagamento_id`: `emettiFatturaPagamento` non sa che
 * esista un estratto conto, né un movimento bancario. Il legame lo tiene una
 * colonna sola — `riconciliazione_movimenti.pagamento_id`, scritta dalla conferma
 * — e da lì in poi «questo bonifico è già stato fatturato» e «questo pagamento ha
 * già una fattura viva» sono la stessa domanda posta da due parti.
 *
 * I test che la guardia ce l'hanno partono tutti dal PAGAMENTO
 * (`emissione-intestatario-scelto.test.ts`, `emissione-idempotenza.test.ts`,
 * `emissione-upload-trasporto.test.ts`): nessuno parte dal movimento, cioè da
 * dove la domanda se la pone la segreteria. Qui si parte da lì — il
 * `pagamento_id` NON è una costante scritta a mano, si legge dalla riga del
 * movimento confermato — e si percorrono i quattro esiti possibili.
 *
 * ─── LA COSA CHE QUESTO FILE AGGIUNGE DAVVERO ────────────────────────────────
 * Sul ramo «riga di trasporto fallito con lo STESSO intestatario»
 * (`emissione.ts`, il ramo `gia` con `sdi_stato` e `aruba_filename` nulli)
 * nessun test contava le allocazioni di numero: `emissione-upload-trasporto.
 * test.ts:313` verifica che non parta un secondo upload e che la riga a registro
 * resti una, ma il suo finto ha una `rpc` senza spia (riga 147), quindi «nessun
 * numero è stato consumato» lì non era un'asserzione. Ed è il ramo in cui costa
 * di più: il numero di quella serie è già bruciato una volta, e bruciarne un
 * secondo lascia due buchi nel registro fiscale per una fattura che forse non è
 * mai partita.
 *
 * ─── COME MORDE ──────────────────────────────────────────────────────────────
 * Il finto è quello di `emissione-gate-numero.test.ts:49-71`, con due aggiunte:
 * `fatture_emesse` è thenable e indicizzata **per `pagamento_id`** (un finto che
 * rispondesse le stesse righe a qualunque id sarebbe verde anche se il codice
 * chiedesse la fattura di un altro pagamento), e `rpc` è contata —
 * `prossimo_numero_fattura_sezionale` SCRIVE il contatore.
 *
 * Dati SINTETICI: nomi inventati e uuid, nessuna famiglia vera (il repo è pubblico).
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'

/** Il movimento bancario confermato, e i due pagamenti in gioco. */
const MOVIMENTO_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PAG_DEL_MOVIMENTO = 'pag-del-movimento'
const PAG_MAI_FATTURATO = 'pag-mai-fatturato'

const INTESTATARIO = 'parent-1'
const ALTRO_INTESTATARIO = 'parent-2'

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

interface Cfg {
  /** Righe di `fatture_emesse` PER pagamento: la tabella non risponde uguale a tutti. */
  fatture?: Record<string, Record<string, unknown>[]>
  rpc?: number
}

/** Il costruttore di query, tipato: il test stesso deve poterlo interrogare. */
interface Builder {
  select: (cols?: string) => Builder
  eq: (colonna: string, valore: unknown) => Builder
  single: () => Promise<{ data: unknown; error: null }>
  maybeSingle: () => Promise<{ data: unknown; error: null }>
  insert: (row: unknown) => Promise<{ error: null }>
  update: () => { eq: () => Promise<{ error: null }> }
  then: (resolve: (v: unknown) => unknown) => unknown
}

/** Fake di Supabase coi CONTATORI: allocazioni di numero, insert, righe lette. */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  return {
    from(table: string): Builder {
      const filtri: Record<string, unknown> = {}
      const builder: Builder = {
        select: () => builder,
        eq: (colonna, valore) => { filtri[colonna] = valore; return builder },
        single: async () => ({ data: risposta(table, filtri), error: null }),
        maybeSingle: async () => ({ data: risposta(table, filtri), error: null }),
        insert: async (row) => {
          inserts.push({ table, row })
          return { error: null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        // `fatture_emesse` si legge come LISTA, e per `pagamento_id`: la risposta
        // dipende da CHI si chiede, non è la stessa per tutti.
        then: (resolve) => {
          if (table === 'fatture_emesse') {
            const id = String(filtri.pagamento_id ?? '')
            return resolve({ data: (cfg.fatture ?? {})[id] ?? [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
}

/** Le letture a riga singola: ogni tabella risponde la SUA riga, non la stessa per tutte. */
function risposta(table: string, filtri: Record<string, unknown>): unknown {
  if (table === 'riconciliazione_movimenti') return filtri.id === MOVIMENTO_ID ? movimentoConfermato : null
  if (table === 'pagamenti') return { ...pagamentoSaldato, id: filtri.id }
  if (table === 'admin_settings') return settingsConfig
  if (table === 'parents') return parentCompleto
  return null
}

/**
 * IL MOVIMENTO: confermato, con l'incasso registrato e il pagamento che ha
 * saldato. È da questa riga — non da una costante — che si prende il
 * `pagamento_id` su cui si fattura.
 */
const movimentoConfermato = {
  id: MOVIMENTO_ID,
  stato: 'confermato',
  importo: 150,
  data_operazione: '2026-03-12',
  pagamento_id: PAG_DEL_MOVIMENTO,
  incasso_id: 'incasso-1',
  scuola_id: SCUOLA,
}

const pagamentoSaldato = {
  id: PAG_DEL_MOVIMENTO,
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
    nome: 'Marco',
    cognome: 'Perlini',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', adult_id: INTESTATARIO },
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

/** Intestatario SINTETICO e completo: passa il gate del cessionario. */
const parentCompleto = {
  id: INTESTATARIO,
  first_name: 'Giulia',
  last_name: 'Fabbri',
  fiscal_code: 'FBBGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

beforeEach(() => {
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function motore() {
  const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
  const { emettiFatturaPagamento } = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: upload,
  })
  return { emettiFatturaPagamento, upload }
}

/**
 * IL PASSAGGIO CHE DÀ IL NOME AL FILE: il pagamento da fatturare si LEGGE dal
 * movimento confermato. Un movimento che non è confermato non ha ancora pagato
 * niente, e su di lui non si fattura.
 */
async function pagamentoDelMovimento(sb: ReturnType<typeof makeSupabase>, id: string): Promise<string | null> {
  const { data } = await sb.from('riconciliazione_movimenti').select('id, stato, pagamento_id').eq('id', id).maybeSingle()
  const mov = data as { stato?: string; pagamento_id?: string } | null
  return mov?.stato === 'confermato' ? mov.pagamento_id ?? null : null
}

const rigaFattura = (over: Record<string, unknown>) => ({
  id: 'f-1',
  numero: 2328,
  sezionale: 'Asilo',
  anno: 2026,
  aruba_filename: 'IT_prima.xml.p7m',
  sdi_stato: 1,
  quota_adult_id: INTESTATARIO,
  intestatario: { codice_fiscale: parentCompleto.fiscal_code },
  ...over,
})

describe('dal MOVIMENTO confermato: la seconda fattura sullo stesso pagamento non parte', () => {
  it('il `pagamento_id` viene DAVVERO dalla riga del movimento (controllo positivo)', async () => {
    // Senza, ogni caso qui sotto potrebbe passare perché il finto risponde a caso:
    // «il pagamento si legge dal movimento» dev'essere una misura, non una premessa.
    const sb = makeSupabase({})
    expect(await pagamentoDelMovimento(sb, MOVIMENTO_ID)).toBe(PAG_DEL_MOVIMENTO)
    expect(await pagamentoDelMovimento(sb, 'movimento-che-non-esiste')).toBeNull()
  })

  it('(a) stesso intestatario → «già fatto»: nessun numero, nessun upload, nessuna riga nuova', async () => {
    const { emettiFatturaPagamento, upload } = await motore()
    const sb = makeSupabase({ fatture: { [PAG_DEL_MOVIMENTO]: [rigaFattura({})] }, rpc: 2329 })
    const pagamentoId = await pagamentoDelMovimento(sb, MOVIMENTO_ID)

    const esito = await emettiFatturaPagamento(sb as never, pagamentoId!, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2328) // quello di prima, non uno nuovo
    expect(sb._rpc, 'un secondo numero su una fattura già emessa è un buco nel registro').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('(b) intestatario diverso da quello a registro → 409, e nessun numero consumato', async () => {
    // L'anagrafica del bambino nel frattempo dice un altro genitore: nessuna riga
    // viva corrisponde più alla quota, e senza guardia partirebbe un SECONDO
    // documento fiscale per la stessa retta pagata da quell'unico bonifico.
    const { emettiFatturaPagamento, upload } = await motore()
    const sb = makeSupabase({
      fatture: { [PAG_DEL_MOVIMENTO]: [rigaFattura({ quota_adult_id: ALTRO_INTESTATARIO, intestatario: { codice_fiscale: 'BNCLCU80A01H501Z' } })] },
      rpc: 2329,
    })
    const pagamentoId = await pagamentoDelMovimento(sb, MOVIMENTO_ID)

    const esito = await emettiFatturaPagamento(sb as never, pagamentoId!, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('gia_emessa_altro_intestatario')
      expect(esito.httpStatus).toBe(409)
      expect(esito.messaggio).toContain('Asilo 2328/2026')
      expect(esito.messaggio).toContain('Nessun numero è stato consumato')
    }
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('(c) riga «trasporto fallito» → 409 che parla di TRASPORTO, e NESSUN NUMERO consumato', async () => {
    // ⚠️ IL BUCO CHE QUESTO FILE CHIUDE. Su questo ramo — stesso intestatario, riga
    // con `sdi_stato` e `aruba_filename` nulli — nessun test contava la `rpc`. È il
    // ramo peggiore in cui bruciare un numero: il primo È già stato consumato, e
    // nessuno sa ancora se quel documento sia partito.
    const { emettiFatturaPagamento, upload } = await motore()
    const sb = makeSupabase({
      fatture: { [PAG_DEL_MOVIMENTO]: [rigaFattura({ sdi_stato: null, aruba_filename: null })] },
      rpc: 2329,
    })
    const pagamentoId = await pagamentoDelMovimento(sb, MOVIMENTO_ID)

    const esito = await emettiFatturaPagamento(sb as never, pagamentoId!, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.httpStatus).toBe(409)
      expect(esito.messaggio.toLowerCase()).toContain('trasporto')
      expect(esito.messaggio).toContain('Asilo 2328')
    }
    expect(sb._rpc, 'un numero consumato qui è il SECONDO buco per la stessa fattura').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
  })

  it('(d) solo scarti → la sostitutiva si emette: UNA allocazione di numero, una riga nuova', async () => {
    // Senza questo caso «non si emette mai due volte» sarebbe soddisfatto anche da
    // «non si emette mai più niente», e uno scarto SDI diventerebbe definitivo.
    const { emettiFatturaPagamento, upload } = await motore()
    const sb = makeSupabase({
      fatture: { [PAG_DEL_MOVIMENTO]: [rigaFattura({ sdi_stato: 2, aruba_filename: 'IT_scartata.xml.p7m' })] },
      rpc: 2329,
    })
    const pagamentoId = await pagamentoDelMovimento(sb, MOVIMENTO_ID)

    const esito = await emettiFatturaPagamento(sb as never, pagamentoId!, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2329)
    expect(sb._rpc).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(1)
  })

  it('le righe si cercano PER PAGAMENTO: un pagamento mai fatturato non eredita il blocco del vicino', async () => {
    // La controprova del finto: se `fatture_emesse` rispondesse le stesse righe a
    // qualunque `pagamento_id`, i tre rifiuti qui sopra sarebbero verdi anche con
    // un codice che chiede la fattura del pagamento sbagliato.
    const { emettiFatturaPagamento, upload } = await motore()
    const sb = makeSupabase({ fatture: { [PAG_DEL_MOVIMENTO]: [rigaFattura({})] }, rpc: 2329 })

    const esito = await emettiFatturaPagamento(sb as never, PAG_MAI_FATTURATO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.numero).toBe(2329)
    expect(upload).toHaveBeenCalledTimes(1)
  })
})
