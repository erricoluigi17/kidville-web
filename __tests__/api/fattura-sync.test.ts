import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  supabase: null as unknown,
  enqueue: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

// Le righe di log sono parte del comportamento, non contorno: qui si verifica che un PDF
// non caricato LO DICA, e a livello `error`. Solo `logEvento`/`logErrore` sono sostituiti;
// il resto del modulo resta quello vero (`withRoute` usa anche `logOk`).
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})

vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return { ...actual, arubaSignin: vi.fn(), arubaGetByFilename: vi.fn() }
})
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.supabase }))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'
import { arubaSignin, arubaGetByFilename, PAUSA_FRA_PAGINE_MS } from '@/lib/aruba/client'
import { aggregaFatturaStato } from '@/lib/aruba/stato'

const SCUOLA = '11111111-1111-1111-1111-111111111111'

// Fake supabase "thenable": ogni catena risolve a { data, error } per tabella.
function makeSupabase(byTable: Record<string, unknown>, opts?: { upload?: unknown }) {
  const updates: { table: string; row: unknown }[] = []
  const uploads: { path: string }[] = []
  const filtri: { table: string; m: string; col: string; vals: unknown }[] = []
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'not', 'order', 'gte', 'lte']) b[m] = chain
    // ⚠️ `.in()` e `.limit()` NON sono no-op come gli altri: sono la CODA del cron e il suo
    // tetto di richieste, cioè due dei tre pezzi che questo lavoro corregge. Il finto client
    // non filtra niente, quindi senza registrare gli argomenti nessun test potrebbe accorgersi
    // che qualcuno ha tolto lo `0` da `STATI_IN_VOLO` o rimesso `.limit(200)`.
    b.in = (col: string, vals: unknown) => { filtri.push({ table, m: 'in', col, vals }); return b }
    b.limit = (n: number) => { filtri.push({ table, m: 'limit', col: '', vals: n }); return b }
    b.single = async () => ({ data: arr(byTable[table])[0] ?? null, error: null })
    b.maybeSingle = async () => ({ data: byTable[table] ?? null, error: null })
    b.update = (row: unknown) => ({ eq: async () => { updates.push({ table, row }); return { error: null } } })
    b.then = (resolve: (v: unknown) => void) => resolve({ data: byTable[table] ?? [], error: null })
    return b
  }
  function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : v == null ? [] : [v]
  }
  return {
    from: (t: string) => builder(t),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploads.push({ path })
          // ⚠️ `supabase-storage-js` NON LANCIA: ritorna `{ data, error }`. Il difetto era
          // che il valore di ritorno veniva scartato — quindi un bucket che diceva di no
          // usciva da lì come un successo. `opts.upload` permette di montare quel «no».
          // Una FUNZIONE viene invocata, così un test può montare anche il caso che lancia
          // davvero (un base64 corrotto, un guasto di trasporto): sono due cause diverse e
          // devono restare due righe di log diverse.
          if (!opts || !('upload' in opts)) return {}
          return typeof opts.upload === 'function' ? (opts.upload as () => unknown)() : opts.upload
        },
      }),
    },
    _updates: updates,
    _uploads: uploads,
    _filtri: filtri,
  } as never
}

function req(secret?: string) {
  return new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('POST /api/pagamenti/fattura/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  it('rifiuta senza x-cron-secret valido (401)', async () => {
    h.supabase = makeSupabase({})
    const res = await POST(req('sbagliato'))
    expect(res.status).toBe(401)
  })

  it('su scarto SDI aggiorna lo stato e notifica la Segreteria', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
      // I ruoli servono davvero: i destinatari passano da `staffScuola`, che filtra
      // per ruolo IN MEMORIA (schema legacy doppio `role`/`ruolo`). Prima la route
      // filtrava con `.in('ruolo', …)` in SQL e questo finto client ignorava `.in()`:
      // due utenti senza ruolo passavano lo stesso. L'isolamento per SEDE ha il suo
      // test dedicato in `fattura-sync-destinatari-sede.test.ts`, col finto client vero.
      utenti: [
        { id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA },
        { id: 'dir-1', ruolo: 'admin', scuola_id: SCUOLA },
      ],
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    // ⚠️ `statoAruba` e `descrizioneAruba` sono OBBLIGATORI nel tipo, e non per pedanteria:
    // finché erano opzionali questo mock diceva `{ stato: 4 }` e restava verde, quindi il
    // percorso «la parola di Aruba arriva fino al registro» era provato da NESSUN test — e
    // sarebbe rimasto verde anche se il client avesse smesso di leggerla.
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 4, // 4 = Scartata (NS)
      statoAruba: 'Scartata',
      descrizioneAruba: 'Codice destinatario non valido',
      errorCode: '0093',
      errorDescription: 'deleghe non valide',
    })

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.scartate).toBe(1)

    // fatture_emesse aggiornata a scartata
    const fUpd = (h.supabase as { _updates: { table: string; row: { sdi_stato: number } }[] })._updates.find(
      (u) => u.table === 'fatture_emesse'
    )
    expect(fUpd!.row.sdi_stato).toBe(4)
    // LA PAROLA DI ARUBA ARRIVA FINO AL REGISTRO, accanto alla nostra traduzione.
    const rowScarto = fUpd!.row as unknown as { sdi_stato_label: string; sdi_scarto_motivo: string }
    expect(rowScarto.sdi_stato_label).toContain('Scartata dallo SDI')
    expect(rowScarto.sdi_stato_label).toContain('Scartata')
    // ⚠️ E `sdi_scarto_motivo` dice PERCHÉ, non «che». Prima ci finiva la nostra stessa
    // etichetta: per le fatture davvero respinte era zero informazione proprio nella colonna
    // che la Segreteria apre per correggerle e ritrasmetterle.
    expect(rowScarto.sdi_scarto_motivo).toContain('Codice destinatario non valido')
    expect(rowScarto.sdi_scarto_motivo).toContain('deleghe non valide')
    expect(rowScarto.sdi_scarto_motivo).not.toBe(rowScarto.sdi_stato_label)
    // pagamento → scartata
    const pUpd = (h.supabase as { _updates: { table: string; row: { fattura_stato: string } }[] })._updates.find(
      (u) => u.table === 'pagamenti'
    )
    expect(pUpd!.row.fattura_stato).toBe('scartata')
    // notifica accodata alla Segreteria (entrambi gli utenti)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    const params = h.enqueue.mock.calls[0][1]
    expect(params.utenteIds).toEqual(['seg-1', 'dir-1'])
    expect(params.tipo).toBe('fattura_scartata')
  })

  it('stato consegnato con PDF → copia di cortesia PER-RIGA e pagamento emesso', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 7, // 7 = Consegnata
      statoAruba: 'Consegnata',
      descrizioneAruba: 'Ricevuta di consegna',
      pdfBase64: Buffer.from('PDF').toString('base64'),
    })

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    const sb = h.supabase as { _updates: { table: string; row: Record<string, unknown> }[]; _uploads: { path: string }[] }
    // PDF caricato con chiave PER-RIGA ${pagamento}-${numero}.pdf (non ${pagamento}.pdf)
    expect(sb._uploads[0].path).toBe('pag-1-7.pdf')
    const fUpd = sb._updates.find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.pdf_path).toBe('pag-1-7.pdf')
    // pagamento aggregato → emessa, con fattura_pdf_path (fattura singola)
    const pUpd = sb._updates.find((u) => u.table === 'pagamenti')!
    expect(pUpd.row.fattura_stato).toBe('emessa')
    expect(pUpd.row.fattura_pdf_path).toBe('pag-1-7.pdf')
  })
})

describe('aggregaFatturaStato (matrice quote)', () => {
  it('nessuna riga → in_attesa', () => {
    expect(aggregaFatturaStato([])).toBe('in_attesa')
  })
  it('uno scarto domina → scartata', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 4, numero: 2, quota_adult_id: 'b' },
    ])).toBe('scartata')
  })
  it('tutte consegnate/accettate → emessa', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 8, numero: 2, quota_adult_id: 'b' },
    ])).toBe('emessa')
  })
  it('una in volo → in_attesa', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 7, numero: 1, quota_adult_id: 'a' },
      { sdi_stato: 3, numero: 2, quota_adult_id: 'b' },
    ])).toBe('in_attesa')
  })
  it('quota scartata poi RI-emessa (numero maggiore) non blocca l\'aggregato', () => {
    expect(aggregaFatturaStato([
      { sdi_stato: 4, numero: 1, quota_adult_id: 'a' }, // vecchia scartata
      { sdi_stato: 7, numero: 5, quota_adult_id: 'a' }, // ri-emissione consegnata
    ])).toBe('emessa')
  })
})

describe('un accesso ad Aruba per UTENZA, non per sede', () => {
  // Il segreto lo arma il `beforeEach` del describe principale, che qui non arriva:
  // senza queste due righe la route risponde 401 e il caso misurerebbe il gate, non
  // il numero di accessi.
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  it('due sedi con la stessa utenza fanno UN solo signin', async () => {
    /**
     * ⚠️ ERA `scuola_id`, e su tre sedi produceva TRE `signin` di fila mentre Aruba
     * ne concede **uno al minuto per IP**: il secondo e il terzo prendevano `429` da
     * soli. Non è un difetto solo di questo cron — gira ogni trenta minuti e si porta
     * via lo slot di chiunque stia emettendo: il 2026-09-07 un `signin` del lotto ha
     * preso `429` con novanta secondi di intervallo, che sulla carta sono sicuri.
     *
     * Le tre sedi usano una sola utenza (misurato: `username` distinto = 1 su 3).
     * La chiave sull'utenza fa un accesso solo, e se un giorno le utenze diventassero
     * davvero tre le distinguerebbe da sé.
     */
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
        { id: 'f-2', pagamento_id: 'pag-2', scuola_id: 'sede-due', numero: 8, aruba_filename: 'ITxxx_b.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
      utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    // Stato invariato: al cron interessa solo che l'accesso sia stato fatto una volta.
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 1, statoAruba: 'Presa in carico', descrizioneAruba: null })

    // Due fatture ⇒ una pausa vera da `PAUSA_FRA_PAGINE_MS` fra le due chiamate. Con i
    // timer veri questo test da solo costerebbe cinque secondi a ogni giro di suite, e un
    // costo fisso su un test che non misura il tempo è tempo regalato.
    vi.useFakeTimers()
    try {
      const p = POST(req('topsecret'))
      await vi.runAllTimersAsync()
      const res = await p
      expect(res.status).toBe(200)
      expect(
        vi.mocked(arubaSignin),
        'due accessi di fila sul limite «uno al minuto» sono un 429 garantito',
      ).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})


/* ═══════════════════════════════════════════════════════════════════════════
 * LO `0` IN CODA — il difetto che teneva 153 fatture congelate.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('la coda del cron rinterroga anche lo stato 0', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  const conUnaFattura = (sdiStato: number, opts?: { upload?: unknown }) =>
    makeSupabase(
      {
        fatture_emesse: [
          { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: sdiStato },
        ],
        admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
        utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
      },
      opts,
    )

  const filtri = () => (h.supabase as { _filtri: { table: string; m: string; vals: unknown }[] })._filtri
  const updates = () => (h.supabase as { _updates: { table: string; row: Record<string, unknown> }[] })._updates

  /**
   * ⚠️ IL TEST CHE VALE IL LAVORO. Fino al 2026-09-11 `STATI_IN_VOLO` era `[1, 3, 5]`.
   * Il client leggeva lo stato dal posto sbagliato e scriveva `0`; lo `0` non era in
   * quella lista, quindi ogni fattura veniva interrogata UNA volta sola — la prima — e
   * usciva dalla coda per non rientrarci mai. **153 righe** erano ferme così, e quattro
   * di quelle risultavano SCARTATE su Aruba: fatture non emesse, che in Segreteria
   * apparivano come tutte le altre.
   *
   * Il finto client non filtra: si verifica l'ARGOMENTO passato a `.in()`, che è l'unico
   * posto in cui questa regressione si vedrebbe.
   */
  it('la SELECT delle fatture in volo include lo stato 0', async () => {
    h.supabase = conUnaFattura(1)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 1, statoAruba: 'Presa in carico', descrizioneAruba: null })

    await POST(req('topsecret'))

    const coda = filtri().find((f) => f.table === 'fatture_emesse' && f.m === 'in')
    expect(coda, 'la coda del cron non viene più filtrata per stato?').toBeTruthy()
    expect(coda!.vals as number[]).toContain(0)
  })

  /**
   * IL TETTO DI RICHIESTE. Era `.limit(200)`, e non si vedeva perché con `[1, 3, 5]` la
   * query tornava vuota. Ammesso lo `0` il ciclo gira davvero: 200 `getByFilename` di fila
   * sono ~17 volte il limite dichiarato da Aruba (SLA §3: 12/min per IP), e i `429` se li
   * porterebbe via anche chi in quel momento sta emettendo dal pannello.
   */
  it('non si prendono più di poche decine di righe per giro', async () => {
    h.supabase = conUnaFattura(1)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 1, statoAruba: 'Presa in carico', descrizioneAruba: null })

    await POST(req('topsecret'))

    const tetto = filtri().find((f) => f.table === 'fatture_emesse' && f.m === 'limit')
    expect(tetto).toBeTruthy()
    expect(tetto!.vals as number).toBeGreaterThan(0)
    expect(tetto!.vals as number, 'con una pausa di 5 s per riga, un tetto alto sfonda maxDuration').toBeLessThanOrEqual(30)
  })

  /**
   * ⚠️ IL CASO REALE, END-TO-END: una delle righe congelate a `0` che su Aruba è SCARTATA.
   * Al 2026-09-11 sono quattro (FPR 1985/26, FPR 2009/26, Asilo 2394/2026, Asilo 2407/2026).
   * Devono rientrare in coda, essere riclassificate, e la Segreteria deve essere avvisata:
   * una fattura scartata NON è stata emessa e va corretta e ritrasmessa.
   */
  it('una riga congelata a 0 che su Aruba è «Scartata» rientra, viene riclassificata e AVVISA la Segreteria', async () => {
    h.supabase = conUnaFattura(0)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 4,
      statoAruba: 'Scartata',
      descrizioneAruba: 'Partita IVA del cessionario inesistente',
      errorCode: '0000',
      errorDescription: null,
    })

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)
    expect((await res.json()).data.scartate).toBe(1)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_stato).toBe(4)
    expect(fUpd.row.sdi_scarto_motivo).toContain('Partita IVA del cessionario inesistente')
    // `0000` è il codice del percorso felice: non deve finire nel motivo dello scarto.
    expect(fUpd.row.sdi_scarto_motivo).not.toContain('0000')
    // L'avviso è il punto: senza, la fattura resta a bilancio come valida.
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0][1].tipo).toBe('fattura_scartata')
  })

  /**
   * Una dicitura che Aruba non ha mai risposto prima NON si indovina: resta `0`, che
   * significa «non ancora interpretato» e RESTA IN CODA. La regola è asimmetrica di
   * proposito: una fattura congelata si scongela al giro dopo, una fattura scartata
   * marcata «emessa» non viene mai corretta.
   */
  it('una dicitura ignota resta 0 e non diventa mai «emessa»', async () => {
    h.supabase = conUnaFattura(1)
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 0,
      statoAruba: 'Messa in quarantena',
      descrizioneAruba: null,
    })

    await POST(req('topsecret'))

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_stato).toBe(0)
    // La PAROLA VERA arriva a registro accanto allo «Stato sconosciuto (0)»: senza, chi
    // legge vede uno 0 e non ha modo di sapere quale voce aggiungere a `stato.ts`.
    expect(fUpd.row.sdi_stato_label).toContain('Messa in quarantena')
    expect(fUpd.row.sdi_scarto_motivo).toBeNull()
    const pUpd = updates().find((u) => u.table === 'pagamenti')!
    expect(pUpd.row.fattura_stato).not.toBe('emessa')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * LO STORAGE NON LANCIA — e il `catch` non scattava mai.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('la copia di cortesia del PDF non può fallire in silenzio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  const consegnataConPdf = () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 7,
      statoAruba: 'Consegnata',
      descrizioneAruba: null,
      pdfBase64: Buffer.from('PDF').toString('base64'),
    })
  }
  const base = (opts?: { upload?: unknown }) =>
    makeSupabase(
      {
        fatture_emesse: [
          { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
        ],
        admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
      },
      opts,
    )
  const righeLog = () => h.logEvento.mock.calls.map((c) => ({ livello: c[1], campi: c[2] as Record<string, unknown> }))

  /**
   * ⚠️ IL DIFETTO IN UNA RIGA: `supabase-storage-js` NON LANCIA, ritorna `{ data, error }`
   * (AGENTS.md, regola 7 — la stessa di PostgREST). Il valore di ritorno dell'`upload`
   * veniva SCARTATO, quindi il `catch` che azzera `pdfPath` non scattava MAI per un errore
   * dello Storage: bucket pieno, chiave rifiutata, permesso negato uscivano tutti da lì come
   * un successo. `pdf_path` finiva a registro e il genitore apriva una fattura che non c'era.
   * Nessun log.
   */
  it('lo Storage risponde { error } → NIENTE pdf_path a registro, e una riga di livello error', async () => {
    h.supabase = base({ upload: { data: null, error: { message: 'The resource already exists', statusCode: '409' } } })
    consegnataConPdf()

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)

    const sb = h.supabase as { _updates: { table: string; row: Record<string, unknown> }[] }
    const fUpd = sb._updates.find((u) => u.table === 'fatture_emesse')!
    // Lo stato SDI si scrive lo stesso (ed è giusto): a mancare è solo la copia del PDF.
    expect(fUpd.row.sdi_stato).toBe(7)
    // ⚠️ LA RIGA CHE CONTA: nessun `pdf_path`, perché il file non c'è.
    expect('pdf_path' in fUpd.row).toBe(false)
    const pUpd = sb._updates.find((u) => u.table === 'pagamenti')!
    expect(pUpd.row.fattura_pdf_path).toBeUndefined()

    // `error` e non `warn`: non è un risultato degradato, è un risultato ASSENTE — il
    // genitore apre la fattura e non ottiene niente.
    const riga = righeLog().find((r) => r.campi?.esito === 'pdf-copia-rifiutata')
    expect(riga, 'un upload rifiutato senza log è esattamente il difetto che si sta chiudendo').toBeTruthy()
    expect(riga!.livello).toBe('error')
    // Azionabile: dice QUALE fattura. `numero` è un intero e `fattura_id` un uuid, passano
    // in chiaro anche nella riga persistita.
    expect(riga!.campi.numero).toBe(7)
    expect(riga!.campi.fattura_id).toBe('f-1')
  })

  /**
   * ⚠️ E LE DUE CAUSE NON SONO LA STESSA RIGA. `messaggio` entra nell'impronta di `app_log`
   * e il `contesto` no: con `esito` e `msg` identici, un rifiuto dello Storage e un'eccezione
   * collassavano in una sola riga `(fingerprint, giorno)` — che conserva il contesto della
   * PRIMA. La riga superstite attribuiva l'accaduto alla causa sbagliata.
   */
  it('un base64 corrotto è un\'ALTRA riga: esito e messaggio diversi dal rifiuto dello Storage', async () => {
    h.supabase = base({
      upload: (() => {
        throw new Error('trasporto interrotto')
      }) as never,
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 7,
      statoAruba: 'Consegnata',
      descrizioneAruba: null,
      pdfBase64: Buffer.from('PDF').toString('base64'),
    })

    await POST(req('topsecret'))

    const eccezione = righeLog().find((r) => r.campi?.esito === 'pdf-copia-eccezione')
    const rifiuto = righeLog().find((r) => r.campi?.esito === 'pdf-copia-rifiutata')
    expect(eccezione).toBeTruthy()
    expect(eccezione!.livello).toBe('error')
    // Nessuna delle due deve poter passare per l'altra.
    expect(rifiuto).toBeFalsy()
    expect(eccezione!.campi.msg).not.toBe('fattura-sync: lo Storage ha rifiutato il PDF, la fattura resta senza copia')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * IL RITMO — 12 richieste al minuto per IP (SLA §3).
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('fra due letture di stato si aspetta', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
    vi.useRealTimers()
  })

  /**
   * ⚠️ SENZA QUESTO TEST LA PAUSA È DECORAZIONE. Prima del 2026-09-11 nel ciclo non c'era
   * nessuna attesa, e nessuno se n'era accorto perché con `STATI_IN_VOLO = [1, 3, 5]` la
   * query tornava sempre vuota: il ciclo non partiva mai. Ammesso lo `0`, rientrano in coda
   * le 153 righe congelate — e Aruba concede 12 ricerche al minuto per IP, «rifiuta
   * istantaneamente con HTTP 429» e «non accoda» (SLA §3).
   *
   * Si misura in tempo FINTO: la seconda chiamata non deve esistere finché il tempo non
   * avanza. Se qualcuno toglie l'attesa, la prima `expect` diventa rossa.
   */
  it('la seconda getByFilename non parte prima che il tempo sia passato', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [
        { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
        { id: 'f-2', pagamento_id: 'pag-2', scuola_id: SCUOLA, numero: 8, aruba_filename: 'ITxxx_b.xml.p7m', sdi_stato: 1 },
      ],
      admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
    })
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({ stato: 1, statoAruba: 'Presa in carico', descrizioneAruba: null })

    vi.useFakeTimers()
    const p = POST(req('topsecret'))
    // Tutto ciò che non è un timer viene smaltito: si arriva fino alla PRIMA chiamata.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(arubaGetByFilename)).toHaveBeenCalledTimes(1)

    // La seconda esiste solo dopo l'attesa. `PAUSA_FRA_PAGINE_MS` è 5 s = 12/min esatte.
    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS)
    expect(vi.mocked(arubaGetByFilename)).toHaveBeenCalledTimes(2)

    await vi.runAllTimersAsync()
    expect((await p).status).toBe(200)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════
 * IL CORPO DELL'ERRORE DEL PROVIDER NON SI BUTTA VIA (AGENTS.md, regola 3).
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('il rifiuto dello Storage arriva nel log INTERO, non ridotto a «non caricato»', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'topsecret'
    process.env.ARUBA_PASSWORD = 'segretissima'
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ARUBA_PASSWORD
  })

  const conStorage = (opts?: { upload?: unknown }) =>
    makeSupabase(
      {
        fatture_emesse: [
          { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 1 },
        ],
        admin_settings: { aruba_config: { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' } },
      },
      opts,
    )

  const consegnataConPdf = () => {
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 7,
      statoAruba: 'Consegnata',
      descrizioneAruba: null,
      pdfBase64: Buffer.from('PDF').toString('base64'),
    })
  }

  /**
   * ⚠️ IL PRECEDENTE CHE HA PAGATO QUESTA REGOLA: per mesi nessuna email di credenziali è
   * arrivata perché il provider rispondeva `403` e il codice registrava soltanto il numero
   * `403`, senza il corpo che diceva PERCHÉ. Nessun test era rosso.
   *
   * Qui vale identico. `pdf-copia-rifiutata` a livello `error` dice CHE il PDF non c'è; da
   * solo non dice se il bucket è pieno, se la chiave è già presa o se il permesso è negato
   * — cioè non dice quale delle tre cose andare a sistemare. L'oggetto d'errore dello
   * Storage deve arrivare al logger COME QUARTO ARGOMENTO (la `cause`), intero: è l'unica
   * cosa che rende quella riga azionabile invece che informativa.
   *
   * Si verifica sul quarto argomento e non sul messaggio di proposito: il messaggio entra
   * nell'impronta di `app_key`/`app_log` e vive di deduplica, la `cause` no.
   */
  it('l\'oggetto d\'errore dello Storage viaggia come `cause`, con dentro messaggio e codice', async () => {
    const rifiuto = {
      message: 'The resource already exists',
      statusCode: '409',
      error: 'Duplicate',
    }
    h.supabase = conStorage({ upload: { data: null, error: rifiuto } })
    consegnataConPdf()

    await POST(req('topsecret'))

    const chiamata = h.logEvento.mock.calls.find(
      (c) => (c[2] as Record<string, unknown>)?.esito === 'pdf-copia-rifiutata',
    )
    expect(chiamata, 'il rifiuto dello Storage non è stato loggato affatto').toBeTruthy()
    // ⚠️ IL QUARTO ARGOMENTO. `logEvento(evento, livello, campi, errore)`: senza il quarto,
    // il corpo del provider è stato buttato via — ed è esattamente il divieto n° 3.
    expect(chiamata!.length, 'il corpo dell\'errore del provider non è stato passato al logger').toBeGreaterThanOrEqual(4)
    const causa = chiamata![3]
    expect(causa).toBeTruthy()
    // INTERO, non un pezzo: si confronta l'oggetto, non una sottostringa scelta da noi.
    expect(causa).toBe(rifiuto)
    expect(JSON.stringify(causa)).toContain('The resource already exists')
    expect(JSON.stringify(causa)).toContain('409')
  })

  /**
   * ⚠️ IL RAMO CHE NON È UN RIFIUTO: il client dello Storage non c'è affatto — `storage?.`
   * corto-circuita e l'upload NON È MAI PARTITO. Un esito assente non è un successo: se
   * `pdf_path` finisse a registro, il registro affermerebbe l'esistenza di un file che
   * nessuno ha mai provato a scrivere.
   *
   * E la riga di log dev'essere DIVERSA da `pdf-copia-rifiutata`: la diagnosi è opposta —
   * lì si controllano i permessi del bucket, qui la forma del client Supabase — e mandare
   * chi legge a guardare nel posto sbagliato costa più di un log che manca.
   */
  it('client Storage assente → nessun pdf_path, e una riga di causa DIVERSA dal rifiuto', async () => {
    const sb = conStorage() as unknown as Record<string, unknown>
    delete sb.storage
    h.supabase = sb
    consegnataConPdf()

    const res = await POST(req('topsecret'))
    expect(res.status).toBe(200)

    const upd = (sb as unknown as { _updates: { table: string; row: Record<string, unknown> }[] })._updates
    const fUpd = upd.find((u) => u.table === 'fatture_emesse')!
    // Lo stato SDI si scrive lo stesso: a mancare è la copia del PDF, non la lettura.
    expect(fUpd.row.sdi_stato).toBe(7)
    expect('pdf_path' in fUpd.row, 'pdf_path scritto per un upload mai partito').toBe(false)

    const righe = h.logEvento.mock.calls.map((c) => ({ livello: c[1], campi: c[2] as Record<string, unknown> }))
    const assente = righe.find((r) => r.campi?.esito === 'pdf-storage-assente')
    expect(assente, 'un upload mai partito senza log è un fallimento silenzioso').toBeTruthy()
    expect(assente!.livello).toBe('error')
    // Non deve travestirsi da rifiuto del bucket: sono due cause, e `msg` entra
    // nell'impronta di `app_log` — con lo stesso testo collasserebbero in una riga sola,
    // che conserva il contesto della PRIMA e attribuisce l'accaduto alla causa sbagliata.
    expect(righe.find((r) => r.campi?.esito === 'pdf-copia-rifiutata')).toBeFalsy()
    expect(righe.find((r) => r.campi?.esito === 'pdf-copia-eccezione')).toBeFalsy()
  })
})
