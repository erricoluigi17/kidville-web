import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA FATTURA DI UN BONIFICO COMPOSITO: UN DOCUMENTO SOLO, UNA RIGA SOLA.
 *
 * ─── LA DECISIONE DEL TITOLARE, per intero perché ha conseguenze fiscali ─────
 * Un bonifico da 150 € che salda 100 € di retta e 50 € di ticket mensa produce
 * **una sola fattura da 150 €, con UNA riga sola, intestata come retta**. Non due
 * documenti, non due righe: una. La famiglia porta in detrazione quel documento,
 * e ciò che vi legge è la descrizione della voce ÀNCORA — la retta — per un
 * importo che comprende anche ciò che retta non è.
 *
 * È stato chiesto esplicitamente e la conseguenza è stata mostrata prima della
 * decisione. Questi test la BLOCCANO: se un giorno qualcuno «correggerà» il
 * motore facendo uscire due righe o due documenti, saranno rossi, e il commento
 * che leggerà dirà che non è una dimenticanza.
 *
 * ─── PERCHÉ L'IMPORTO NON PUÒ STARE IN UNA COLONNA ──────────────────────────
 * `fatture_emesse.pagamento_id` è NOT NULL, ha un indice unico e trigger WORM
 * (`20260711150000_worm_registri_fiscali.sql`): una riga emessa non si modifica.
 * La fattura resta dunque ANCORATA a un `pagamento_id` — quello della voce àncora
 * — e ciò che cambia è solo l'IMPORTO costruito in emissione. Nessuna colonna
 * nuova, nessuna migrazione.
 *
 * ─── COME MORDONO ───────────────────────────────────────────────────────────
 * Il finto distingue le tabelle una per una e CONTA le allocazioni di numero
 * (`rpc`, che scrive il contatore fiscale): «nessun numero è stato consumato» è
 * un'asserzione, non una frase di cortesia. E l'importo si misura in DUE posti —
 * la riga a registro e l'XML che parte — perché sono due scritture diverse e una
 * delle due potrebbe restare indietro.
 *
 * Dati SINTETICI: uuid e nomi inventati, nessuna famiglia vera (repo pubblico).
 */

const SCUOLA = '11111111-1111-1111-1111-111111111111'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222222'
const PAGAMENTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TRANSAZIONE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const ALTRA_TRANSAZIONE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'

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
  /** Le righe di `riconciliazione_movimenti` che citano questo pagamento. */
  movimenti?: Record<string, unknown>[]
  /** Errore iniettabile sulla lettura del legame movimento→transazione. */
  movimentiError?: { code: string; message: string } | null
  /** La transazione, per id. */
  transazioni?: Record<string, Record<string, unknown>>
  transazioniError?: { code: string; message: string } | null
  /** Il pagamento àncora (ne cambia solo l'importo, di norma). */
  pagamento?: Record<string, unknown>
}

function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const lette: { table: string; filtri: Record<string, unknown> }[] = []
  let prossimo = 2328
  const rpc = vi.fn(async () => ({ data: prossimo++, error: null }))
  return {
    from(table: string) {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.single = async () => {
        lette.push({ table, filtri: { ...filtri } })
        return { data: table === 'pagamenti' ? cfg.pagamento ?? pagamentoSaldato : null, error: null }
      }
      b.maybeSingle = async () => {
        lette.push({ table, filtri: { ...filtri } })
        if (table === 'admin_settings') return { data: settingsConfig, error: null }
        if (table === 'parents') return { data: parentCompleto, error: null }
        if (table === 'pagamenti_transazioni') {
          if (cfg.transazioniError) return { data: null, error: cfg.transazioniError }
          return { data: (cfg.transazioni ?? {})[String(filtri.id ?? '')] ?? null, error: null }
        }
        return { data: null, error: null }
      }
      b.insert = async (row: unknown) => { inserts.push({ table, row }); return { error: null } }
      b.update = () => ({ eq: async () => ({ error: null }) })
      b.then = (resolve: (v: unknown) => unknown) => {
        lette.push({ table, filtri: { ...filtri } })
        if (table === 'riconciliazione_movimenti') {
          if (cfg.movimentiError) return resolve({ data: null, error: cfg.movimentiError })
          return resolve({ data: cfg.movimenti ?? [], error: null })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc,
    _inserts: inserts,
    _lette: lette,
    _rpc: rpc,
  }
}

const righeFattura = (sb: ReturnType<typeof makeSupabase>) =>
  sb._inserts.filter((i) => i.table === 'fatture_emesse').map((i) => i.row as Record<string, unknown>)

/** La voce ÀNCORA: una retta da 100 €, saldata. */
const pagamentoSaldato = {
  id: PAGAMENTO,
  descrizione: 'Retta di Marzo',
  importo: 100,
  stato: 'pagato',
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  scuola_id: SCUOLA,
  fattura_causale: 'Retta di Marzo',
  categoria_id: null,
  alunno_id: 'al-1',
  payment_categories: { slug: 'retta' },
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Fabbri',
    codice_fiscale: null,
    // Dato SINTETICO: decide solo la serie fiscale, non è di nessun bambino vero.
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Fabbri', adult_id: 'parent-1' },
  },
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
  },
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

const parentCompleto = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Fabbri',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

async function motore() {
  const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
  const mod = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => 2327),
    arubaUpload: upload,
  })
  return { emetti: mod.emettiFatturaPagamento, upload }
}

/** Il movimento bancario confermato che lega la voce àncora alla transazione. */
const movimentoComposito = { transazione_id: TRANSAZIONE }
/** La transazione: 100 € di retta + 50 € di ticket = 150 € incassati in un colpo. */
const transazione150 = {
  [TRANSAZIONE]: { id: TRANSAZIONE, importo_totale: 150, scuola_id: SCUOLA, annullata_il: null },
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

describe('la fattura ancorata: l’importo è quello della TRANSAZIONE, la descrizione quella della voce', () => {
  it('retta 100 + ticket 50 → UNA fattura da 150, con UNA riga sola intestata come retta', async () => {
    const { emetti } = await motore()
    const sb = makeSupabase({ movimenti: [movimentoComposito], transazioni: transazione150 })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    const righe = righeFattura(sb)
    // UN documento solo: non uno per voce.
    expect(righe, 'più di una fattura per lo stesso bonifico').toHaveLength(1)
    expect(righe[0].importo, 'il documento vale la sola voce àncora, non il bonifico').toBe(150)
    // La descrizione resta quella della voce ÀNCORA: la famiglia porta in
    // detrazione un documento che dice «Retta di Marzo» per 150 €.
    expect(String(righe[0].causale)).toContain('Retta')

    const xml = String(righe[0].xml_inviato)
    expect((xml.match(/<DettaglioLinee>/g) ?? []).length, 'più di una riga nel documento').toBe(1)
    expect(xml).toContain('<PrezzoUnitario>150.00</PrezzoUnitario>')
  })

  it('senza transazione: il documento vale la voce, esattamente come prima', async () => {
    const { emetti } = await motore()
    const sb = makeSupabase({ movimenti: [{ transazione_id: null }] })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    expect(righeFattura(sb)[0].importo).toBe(100)
  })

  it('nessun movimento bancario (fattura emessa a mano): il documento vale la voce', async () => {
    const { emetti } = await motore()
    const sb = makeSupabase({ movimenti: [] })

    expect((await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })).ok).toBe(true)
    expect(righeFattura(sb)[0].importo).toBe(100)
  })

  it('la colonna `transazione_id` non esiste (42703): si emette come sempre, non si cade', async () => {
    // DB E2E della CI, mai migrato. Un 503 qui spegnerebbe la fatturazione su un
    // ambiente in cui la conciliazione composita non esiste nemmeno.
    const { emetti } = await motore()
    const sb = makeSupabase({
      movimentiError: { code: '42703', message: 'column riconciliazione_movimenti.transazione_id does not exist' },
    })

    expect((await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })).ok).toBe(true)
    expect(righeFattura(sb)[0].importo).toBe(100)
  })

  it('⛔ il legame non si è potuto LEGGERE → non si emette, e nessun numero è consumato', async () => {
    // Fail-closed, come tutto il resto di questo file: emettere con l'importo
    // della sola voce vorrebbe dire mandare allo SDI un documento SBAGLIATO e
    // immodificabile (WORM), per un guasto di lettura che sparirà da solo.
    const { emetti, upload } = await motore()
    const sb = makeSupabase({
      movimentiError: { code: '42501', message: 'permission denied for table riconciliazione_movimenti' },
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    expect(esito.ok === false && esito.httpStatus).toBe(503)
    expect(sb._rpc, 'un numero è stato consumato su una lettura fallita').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(righeFattura(sb)).toEqual([])
  })

  it('⛔ la TRANSAZIONE non si è potuta leggere → non si emette, nessun numero consumato', async () => {
    const { emetti } = await motore()
    const sb = makeSupabase({
      movimenti: [movimentoComposito],
      transazioniError: { code: '42501', message: 'permission denied for table pagamenti_transazioni' },
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    expect(esito.ok === false && esito.httpStatus).toBe(503)
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('transazione ANNULLATA: il documento torna a valere la voce', async () => {
    // L'annullo ha già stornato tutto e rimesso il bonifico in coda: fatturare il
    // totale di una transazione che non esiste più sarebbe un documento per denaro
    // che è stato restituito.
    const { emetti } = await motore()
    const sb = makeSupabase({
      movimenti: [movimentoComposito],
      transazioni: {
        [TRANSAZIONE]: { id: TRANSAZIONE, importo_totale: 150, scuola_id: SCUOLA, annullata_il: '2026-03-20T10:00:00Z' },
      },
    })

    expect((await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })).ok).toBe(true)
    expect(righeFattura(sb)[0].importo).toBe(100)
  })

  it('⛔ due transazioni sullo stesso pagamento → non si emette: quale totale sarebbe?', async () => {
    // Non è teoria pura: due bonifici che saldano in parte la stessa voce. Scegliere
    // il primo che capita significherebbe fatturare un totale a caso, e il documento
    // non si corregge più.
    const { emetti } = await motore()
    const sb = makeSupabase({
      movimenti: [{ transazione_id: TRANSAZIONE }, { transazione_id: ALTRA_TRANSAZIONE }],
      transazioni: transazione150,
    })

    const esito = await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    expect(sb._rpc).not.toHaveBeenCalled()
  })

  it('DUE FIGLI, DUE PLESSI: una transazione da 300 → una fattura sola da 300', async () => {
    // Decisione del titolare: «una sola da 300». La sede del DOCUMENTO resta
    // quella della voce àncora (è da lì che vengono configurazione Aruba e
    // cedente): che la transazione ne dichiari un'altra è un fatto da segnalare,
    // non un motivo per fermare un documento dovuto.
    const { emetti } = await motore()
    const sb = makeSupabase({
      movimenti: [movimentoComposito],
      transazioni: {
        [TRANSAZIONE]: { id: TRANSAZIONE, importo_totale: 300, scuola_id: ALTRA_SEDE, annullata_il: null },
      },
    })

    expect((await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })).ok).toBe(true)
    const righe = righeFattura(sb)
    expect(righe).toHaveLength(1)
    expect(righe[0].importo).toBe(300)
    expect(righe[0].scuola_id, 'la fattura è stata archiviata nel plesso sbagliato').toBe(SCUOLA)
  })

  it('il legame si cerca sul MOVIMENTO CONFERMATO di QUESTO pagamento, non su una riga qualunque', async () => {
    // Un finto che rispondesse le stesse righe a qualunque filtro renderebbe verdi
    // tutti i test qui sopra anche se il codice cercasse la transazione di un altro
    // bonifico. Qui si guarda che cosa è stato chiesto.
    const { emetti } = await motore()
    const sb = makeSupabase({ movimenti: [movimentoComposito], transazioni: transazione150 })

    await emetti(sb as never, PAGAMENTO, { id: 'staff-1' })

    const lettura = sb._lette.find((l) => l.table === 'riconciliazione_movimenti')
    expect(lettura, 'il legame non è stato nemmeno cercato').toBeTruthy()
    expect(lettura!.filtri.pagamento_id).toBe(PAGAMENTO)
    expect(lettura!.filtri.stato, 'letto anche un movimento non confermato').toBe('confermato')
  })
})
