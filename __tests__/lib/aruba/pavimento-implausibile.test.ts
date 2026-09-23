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
 * Fake di Supabase che CONTA le allocazioni, registra gli UPDATE per tabella e sa far
 * fallire sia una SELECT sia la RPC (R1-1.9: serve al caso «RPC fallita → nessun UPDATE»).
 *
 * `errori` esiste per due casi: `errori[<tabella>]` fa fallire la `SELECT` di quella
 * tabella, `errori.rpc` fa fallire `prossimo_numero_fattura_sezionale`. PostgREST **non
 * lancia**, ritorna `{ error }`. Un fake che restituisce sempre `error: null` sarebbe verde
 * con la gestione dell'errore e senza.
 */
function makeSupabase(
  responses: Record<string, unknown> & { rpc?: number },
  errori: Record<string, unknown> & { rpc?: unknown } = {},
) {
  const inserts: { table: string; row: unknown }[] = []
  const updates: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => (errori.rpc ? { data: null, error: errori.rpc } : { data: responses.rpc ?? 1, error: null }))
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
        update: (row: unknown) => ({
          eq: async () => {
            updates.push({ table, row })
            return { error: null }
          },
        }),
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _updates: updates,
    _rpc: rpc,
  }
}

/** I `campi` di dominio di una riga `app_log`, cioè quello che `logEvento` NON promuove a
 * colonna (`livello`, `messaggio`): stesso accesso di
 * `emissione-multi-quota-estranea.test.ts:571`. */
function campiDi(riga: Record<string, unknown> | undefined) {
  return (riga?.contestoExtra as { campi?: Record<string, unknown> } | undefined)?.campi ?? {}
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
      expect(esito.messaggio).toMatch(/nessun numero è stato consumato/i)
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

/**
 * R1-1.9 (D1§5.1-5.3): il tetto scende da 10.000 a 50, con `salto` in log e in messaggio, e
 * niente `scartata` quando l'unico motivo di fermata è la numerazione.
 *
 * ⚠️ ROSSO DICHIARATO fino a R1-2.1 (CONVENZIONI, C0-1): `SCARTO_MASSIMO_PAVIMENTO` in
 * `emissione.ts` vale ancora 10.000 e il guard di §5.3 non esiste, quindi qui sotto diversi
 * casi falliscono per ASSERTIONERROR — mai per un errore di caricamento — e restano rossi
 * finché R1-2.1 non riscrive quel ramo.
 */
describe('R1-1.9 · il tetto a 50 e il suo log (D1§5.1-5.3)', () => {
  it('reale 2515 contro 2154 (salto 361): nessuna RPC né upload, log error con `salto` e «Avvisa l\'amministratore»', async () => {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2515),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2154 },
      rpc: 2516,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toBe('numerazione_non_allineata')
      // D1§5.1: la frase «Avvisa l'amministratore» sta nel MESSAGGIO ALL'OPERATORE
      // (`esito.messaggio`), non nel `msg` della riga di log: sono due stringhe diverse.
      expect(
        esito.messaggio,
        'D1§5.1: il messaggio all\'operatore deve invitare ad avvisare l\'amministratore',
      ).toContain("Avvisa l'amministratore")
    }
    expect(sb._rpc, 'la RPC alza il contatore e non lo riabbassa: col salto a 361 non deve partire').not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    // Niente riga `fatture_emesse` e niente UPDATE su `pagamenti`: uno stop di sola
    // numerazione non consuma il numero e (D1§5.3) non tocca lo stato del pagamento.
    expect(sb._inserts.filter((i) => i.table === 'fatture_emesse')).toHaveLength(0)
    expect(sb._updates.filter((u) => u.table === 'pagamenti'), 'D1§5.3: uno stop di sola numerazione non aggiorna pagamenti').toHaveLength(0)

    await vi.waitFor(() => {
      const riga = righeLog.find((r) => String(campiDi(r).esito) === 'pavimento-fuori-scala')
      expect(riga, 'il rifiuto deve lasciare una riga error con esito pavimento-fuori-scala').toBeTruthy()
      expect(riga?.livello).toBe('error')
      // D1§5.1: il campo NUMERICO `salto = ultimoAruba - contatore`, non solo i due
      // numeri grezzi — è quello che dice a colpo d'occhio «di quanto» era fuori scala.
      expect(campiDi(riga).salto).toBe(361)
      expect(campiDi(riga).pavimento).toBe(2515)
      expect(campiDi(riga).contatore).toBe(2154)
    })
  })

  it('RPC fallita (contatore letto, salto nullo): nessun UPDATE su pagamenti', async () => {
    // Diverso dal caso sopra: qui il pavimento PASSA (nessuno scarto) e a fermarsi è la
    // RPC che alloca il numero. Anche questo è un motivo `numerazione` puro: D1§5.3 vuole
    // che nemmeno questo stop scriva `fattura_stato = 'scartata'`.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase(
      { pagamenti: pagamentoSaldato, admin_settings: settingsConfig, parents: parentCompleto },
      { rpc: { code: '55P03', message: 'could not obtain lock on advisory lock' } },
    )

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('numerazione_non_allineata')
    expect(sb._rpc, 'la RPC è stata TENTATA: è lei a fallire').toHaveBeenCalled()
    expect(sb._updates.filter((u) => u.table === 'pagamenti'), 'D1§5.3: RPC fallita è ancora motivo numerazione, niente scartata').toHaveLength(0)
  })

  it('confine: salto 50 passa (emette)', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 1050),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 1000 },
      rpc: 1051,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'salto=50 è il confine ammesso: deve passare').toBe(true)
    expect(sb._rpc).toHaveBeenCalled()
  })

  it('confine: salto 51 si ferma (non emette)', async () => {
    const upload = vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' }))
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 1051),
      arubaUpload: upload,
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 1000 },
      rpc: 1052,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok, 'salto=51 supera il tetto: deve fermarsi').toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('numerazione_non_allineata')
    expect(sb._rpc).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('salto 3, sotto il tetto: warn `pavimento-sopra-contatore` con `salto: 3`, e la fattura parte comunque', async () => {
    // D1§5.2: un pavimento un po' più avanti del registro non è l'anomalia — è la prova
    // che qualcuno ha emesso fuori dall'app (J0/F2 nel commento in testa al file). Va
    // scritto, non bloccato: per questo l'esito resta `ok: true`.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2003),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2000 },
      rpc: 2004,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(true)
    await vi.waitFor(() => {
      const riga = righeLog.find((r) => String(campiDi(r).esito) === 'pavimento-sopra-contatore')
      expect(riga, 'il pavimento sopra il contatore, entro il tetto, deve lasciare un warn').toBeTruthy()
      expect(riga?.livello).toBe('warn')
      expect(campiDi(riga).salto).toBe(3)
      expect(campiDi(riga).pavimento).toBe(2003)
      expect(campiDi(riga).contatore).toBe(2000)
    })
  })

  it('salto 0 (stesso numero su Aruba e a registro): nessun warn', async () => {
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2000),
      arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName: 'IT_x.xml.p7m', errorCode: '0000' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2000 },
      rpc: 2001,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })
    expect(esito.ok).toBe(true)

    // Non un controllo secco subito dopo l'`esito`: si aspetta un log di sicuro arrivo
    // (`inviata`, scritto DOPO il punto in cui il warn sarebbe partito nello stesso giro)
    // e SOLO allora si guarda che il warn non ci sia — altrimenti un'assenza vera e
    // un'assenza «non ancora arrivata» sarebbero indistinguibili (.claude/rules/test.md).
    await vi.waitFor(() => {
      const rigaInviata = righeLog.find((r) => String(campiDi(r).esito) === 'inviata')
      expect(rigaInviata, 'serve un log di successo per essere sicuri che il giro sia finito').toBeTruthy()
    })
    expect(righeLog.find((r) => String(campiDi(r).esito) === 'pavimento-sopra-contatore')).toBeUndefined()
  })

  it('il negativo del §5.3: un rifiuto di MERITO (non numerazione) aggiorna comunque pagamenti a scartata', async () => {
    // Controllo di selettività: il guard di §5.3 deve sospendere SOLO `scartata` quando il
    // motivo è `numerazione` puro. Un rifiuto di Aruba sul contenuto del documento (motivo
    // `scartata`) deve continuare a scrivere `fattura_stato = 'scartata'` come oggi — questo
    // è già vero PRIMA di R1-2.1 (`fattura-emissione.test.ts:255-267` fa da controllo
    // opposto sullo stesso comportamento) e deve restare vero anche dopo.
    const { emettiFatturaPagamento } = await carica({
      arubaSignin: vi.fn(async () => tokenOk),
      arubaUltimoNumeroFattura: vi.fn(async () => 2331),
      arubaUpload: vi.fn(async () => ({ ok: false, errorCode: '0094', errorDescription: 'IdTrasmittente non valido' })),
    })
    const sb = makeSupabase({
      pagamenti: pagamentoSaldato,
      admin_settings: settingsConfig,
      parents: parentCompleto,
      fatture_numerazione_sezionale: { ultimo_numero: 2331 },
      rpc: 2332,
    })

    const esito = await emettiFatturaPagamento(sb as never, 'pag-1', { id: 'staff-1' })

    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.motivo).toBe('scartata')
    const pagUpd = sb._updates.find((u) => u.table === 'pagamenti')
    expect(pagUpd, 'un rifiuto di merito NON è un motivo numerazione: deve restare scartata').toBeTruthy()
    expect((pagUpd?.row as { fattura_stato?: string } | undefined)?.fattura_stato).toBe('scartata')
  })
})
