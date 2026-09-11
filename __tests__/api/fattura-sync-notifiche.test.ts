import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL GIRO CHE VA A PRENDERE IL PERCHÉ DI UNO SCARTO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL FATTO, 2026-09-11. La prima fattura respinta dopo la correzione della lettura di
 * stato (PR #138) è emersa alle 10:31Z con `sdi_stato = 4`, e in `sdi_scarto_motivo` è
 * finito «Aruba: «Scartata» — nessun motivo dal provider»: `getByFilename` aveva risposto
 * con `statusDescription`, `errorCode` ed `errorDescription tutti vuoti. Aspettare il tick
 * dopo non serve — su quel canale il motivo NON C'È. Vive nelle notifiche SDI.
 *
 * Le quattro cose che questo file tiene ferme, e nessuna è decorazione:
 *
 *  1. la chiamata in più si fa SOLO su uno scarto senza descrizione. Gli scarti sono rari
 *     (4 su 174 righe, misurate il 2026-09-11) e Aruba concede 12 ricerche al minuto PER IP:
 *     una richiesta in più su ogni fattura regolare si porterebbe via lo slot di chi emette;
 *  2. si rispetta il ritmo — `PAUSA_FRA_PAGINE_MS` prima della chiamata, perché è lo
 *     STESSO secchio del resto del giro;
 *  3. FAIL-OPEN: se le notifiche falliscono (429, timeout, forma ignota) lo stato si scrive
 *     lo stesso. Un errore qui degrada l'informazione, non il lavoro;
 *  4. 🔴 PRIVACY: il corpo di una notifica SDI porta denominazione, codice fiscale e partita
 *     IVA dell'intestatario — di una famiglia. Nel log ci vanno i NOMI dei campi, mai i
 *     valori. Il motivo va in `sdi_scarto_motivo`, che è una colonna, non una riga di log.
 *
 * ─── E LA QUINTA, AGGIUNTA IL 2026-09-11 DOPO UN RILIEVO ────────────────────────
 * Tutto il blocco qui sopra vive DENTRO il ciclo del giro, dopo il `continue` che salta le
 * righe il cui stato non è cambiato: è raggiungibile SOLO nell'istante in cui una fattura
 * PASSA a scarto. Ma `STATI_IN_VOLO` non contiene gli stati di scarto — appena una fattura
 * diventa scartata ESCE dalla coda e nessun giro la ripesca più. Le **4 fatture già
 * scartate** in produzione, che sono esattamente quelle per cui questo lavoro è stato fatto,
 * sarebbero rimaste con «nessun motivo dal provider» PER SEMPRE.
 *
 * Perciò esiste un RIENTRO: una seconda query, con un tetto suo piccolo, che pesca gli
 * scarti il cui motivo è ancora povero e aggiorna SOLO `sdi_scarto_motivo`. E deve
 * TERMINARE: una riga per cui le notifiche non danno mai niente non può essere richiesta a
 * ogni giro per sempre, o la correzione è peggio del difetto.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

const h = vi.hoisted(() => ({
  supabase: null as unknown,
  enqueue: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento, logErrore: h.logErrore }
})

vi.mock('@/lib/aruba/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aruba/client')>()
  return {
    ...actual,
    arubaSignin: vi.fn(),
    arubaGetByFilename: vi.fn(),
    arubaGetNotifications: vi.fn(),
  }
})
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueue }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.supabase }))

import { POST } from '@/app/api/pagamenti/fattura/sync/route'
import {
  arubaSignin,
  arubaGetByFilename,
  arubaGetNotifications,
  PAUSA_FRA_PAGINE_MS,
} from '@/lib/aruba/client'
import { sanificaMessaggio } from '@/lib/logging/serialize'
import { mapStatoAruba, motivoScartoAruba } from '@/lib/aruba/stato'

const SCUOLA = '11111111-1111-1111-1111-111111111111'

/** Il motivo povero che il provider lascia quando non dice niente. È il bersaglio del rientro. */
const MOTIVO_POVERO = 'Aruba: «Scartata» — nessun motivo dal provider'
/** Il segno che per quella riga il rientro ha GIÀ speso la sua richiesta. Vedi `route.ts`. */
const MARCATORE_RIENTRO = 'notifiche SDI interrogate'

type Riga = Record<string, unknown>
type Filtro = { m: string; col: string; op?: string; val: unknown }

/** `%…%` di SQL, senza distinzione di maiuscole. Serve solo per `sdi_scarto_motivo`. */
function ilikeSql(valore: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`,
    'i',
  )
  return re.test(valore)
}

/**
 * ⚠️ QUESTO FINTO CLIENT FILTRA DAVVERO, e non è pignoleria.
 *
 * La versione precedente rispondeva con TUTTE le righe della tabella a QUALUNQUE catena:
 * con una query sola non si vedeva, ma il rientro ne aggiunge una seconda sulla STESSA
 * tabella con filtri OPPOSTI (`sdi_stato` di scarto invece che in volo, e il motivo ancora
 * povero). Un finto client che ignora i filtri direbbe «verde» anche a un rientro che pesca
 * le fatture sbagliate — cioè a due chiamate Aruba per riga su un secchio da 12/min.
 *
 * Gli `update` MUTANO le righe, perché la terminazione si prova solo così: si fa girare il
 * giro due volte sullo stesso database e si guarda se la seconda volta chiede ancora.
 */
function makeSupabase(byTable: Record<string, unknown>) {
  const updates: { table: string; row: Record<string, unknown> }[] = []
  const filtri: { table: string; m: string; col: string; val: unknown }[] = []

  const righeDi = (table: string): Riga[] => {
    const v = byTable[table]
    return Array.isArray(v) ? (v as Riga[]) : v == null ? [] : [v as Riga]
  }

  function applica(righe: Riga[], f: Filtro[]): Riga[] {
    let out = righe
    for (const p of f) {
      if (p.m === 'eq') out = out.filter((r) => r[p.col] === p.val)
      else if (p.m === 'in') out = out.filter((r) => (p.val as unknown[]).includes(r[p.col]))
      else if (p.m === 'not' && p.op === 'is' && p.val === null) out = out.filter((r) => r[p.col] != null)
      else if (p.m === 'not' && p.op === 'ilike') {
        // ⚠️ SQL a tre valori: `NOT (NULL ILIKE '…')` vale NULL, cioè la riga NON passa.
        // Riprodurlo è il punto — è la trappola che il commento in `route.ts` dichiara.
        out = out.filter((r) => (r[p.col] == null ? false : !ilikeSql(String(r[p.col]), String(p.val))))
      } else if (p.m === 'limit') out = out.slice(0, p.val as number)
    }
    return out
  }

  function builder(table: string) {
    const f: Filtro[] = []
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.gte = () => b
    b.lte = () => b
    b.eq = (col: string, val: unknown) => { f.push({ m: 'eq', col, val }); return b }
    b.in = (col: string, val: unknown) => {
      f.push({ m: 'in', col, val }); filtri.push({ table, m: 'in', col, val }); return b
    }
    b.not = (col: string, op: string, val: unknown) => { f.push({ m: 'not', col, op, val }); return b }
    b.limit = (n: number) => {
      f.push({ m: 'limit', col: '', val: n }); filtri.push({ table, m: 'limit', col: '', val: n }); return b
    }
    b.single = async () => ({ data: applica(righeDi(table), f)[0] ?? null, error: null })
    b.maybeSingle = async () => ({ data: (Array.isArray(byTable[table]) ? applica(righeDi(table), f)[0] : byTable[table]) ?? null, error: null })
    b.update = (row: Record<string, unknown>) => ({
      eq: async (col: string, val: unknown) => {
        updates.push({ table, row })
        for (const r of righeDi(table)) if (r[col] === val) Object.assign(r, row)
        return { error: null }
      },
    })
    b.then = (resolve: (v: unknown) => void) => resolve({ data: applica(righeDi(table), f), error: null })
    return b
  }

  return {
    from: (t: string) => builder(t),
    storage: { from: () => ({ upload: async () => ({}) }) },
    _updates: updates,
    _filtri: filtri,
  } as never
}

function req(secret = 'topsecret') {
  return new Request('http://localhost/api/pagamenti/fattura/sync', {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  })
}

const ARUBA_OK = { username: 'u', password_ref: 'ARUBA_PASSWORD', abilitato: true, ambiente: 'demo' }

const conUnaFattura = () =>
  makeSupabase({
    fatture_emesse: [
      { id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 7, aruba_filename: 'ITxxx_a.xml.p7m', sdi_stato: 0 },
    ],
    admin_settings: { aruba_config: ARUBA_OK },
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
  })

/**
 * IL DATABASE DI PRODUZIONE DEL 2026-09-11, nella sua forma essenziale: nessuna fattura in
 * volo, e degli scarti già terminali col motivo povero. Senza rientro il giro non fa NIENTE.
 */
const conScartiArretrati = (quanti = 1) =>
  makeSupabase({
    fatture_emesse: Array.from({ length: quanti }, (_, i) => ({
      id: `f-${i + 1}`,
      pagamento_id: `pag-${i + 1}`,
      scuola_id: SCUOLA,
      numero: 1985 + i,
      aruba_filename: `ITxxx_${i}.xml.p7m`,
      sdi_stato: 4,
      sdi_stato_label: 'Scartata dallo SDI — Aruba: «Scartata»',
      sdi_scarto_motivo: MOTIVO_POVERO,
    })),
    admin_settings: { aruba_config: ARUBA_OK },
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
  })

/** IL CASO MISURATO: scartata, e nessuna delle tre descrizioni è arrivata. */
const scartoSenzaMotivo = () =>
  vi.mocked(arubaGetByFilename).mockResolvedValue({
    stato: 4,
    statoAruba: 'Scartata',
    descrizioneAruba: '',
    errorCode: '',
    errorDescription: '',
  })

const notificaConMotivo = () =>
  vi.mocked(arubaGetNotifications).mockResolvedValue({
    notifications: [
      { notificationType: 'NS', errors: [{ errorCode: '00417', errorDescription: 'Identificativo fiscale non valorizzato' }] },
    ],
  })

const updates = () => (h.supabase as { _updates: { table: string; row: Record<string, unknown> }[] })._updates
const filtri = () => (h.supabase as { _filtri: { table: string; m: string; col: string; val: unknown }[] })._filtri
const righeLog = () => h.logEvento.mock.calls.map((c) => ({ livello: c[1], campi: c[2] as Record<string, unknown>, causa: c[3] }))
const riga = (esito: string) => righeLog().find((r) => r.campi?.esito === esito)
const righe = (esito: string) => righeLog().filter((r) => r.campi?.esito === esito)

/** Esegue il giro smaltendo le pause (5 s a richiesta: coi timer veri sarebbero secondi veri). */
async function giro() {
  vi.useFakeTimers()
  try {
    const p = POST(req())
    await vi.runAllTimersAsync()
    return await p
  } finally {
    vi.useRealTimers()
  }
}

function ambientePulito() {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'topsecret'
  process.env.ARUBA_PASSWORD = 'segretissima'
  vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
}
function ambientePulitoFine() {
  delete process.env.CRON_SECRET
  delete process.env.ARUBA_PASSWORD
  vi.useRealTimers()
}

describe('lo scarto senza motivo va a chiedere alle notifiche SDI', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /** ⚠️ IL TEST CHE VALE IL LAVORO: la colonna che la Segreteria apre smette di dire «boh». */
  it('il motivo arriva dalle notifiche e finisce in `sdi_scarto_motivo`', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    notificaConMotivo()

    const res = await giro()
    expect(res.status).toBe(200)

    // Il filename della fattura, non un altro: è la chiave con cui lo SdI lega notifica e documento.
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(arubaGetNotifications).mock.calls[0][2]).toBe('ITxxx_a.xml.p7m')

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_stato).toBe(4)
    expect(fUpd.row.sdi_scarto_motivo).toContain('Identificativo fiscale non valorizzato')
    expect(fUpd.row.sdi_scarto_motivo).toContain('00417')
    // Il motivo povero è stato SOSTITUITO, non affiancato: è una colonna sola.
    expect(String(fUpd.row.sdi_scarto_motivo)).not.toContain('nessun motivo dal provider')
  })

  /**
   * ⚠️ UN SIGNIN NUOVO SAREBBE UN `429` GARANTITO: Aruba ne concede UNO AL MINUTO per IP.
   * Il token del giro c'è già, e va riusato.
   */
  it('riusa il token del giro: nessun accesso in più', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [{ notificationType: 'NS', errori: [{ descrizione: 'x' }] }] })

    await giro()

    expect(vi.mocked(arubaSignin)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(arubaGetNotifications).mock.calls[0][1]).toBe('AT')
  })

  /**
   * IL RITMO: 12 ricerche al minuto PER IP (SLA §3), rifiuto istantaneo con `429` e nessun
   * accodamento. La chiamata alle notifiche pesca dallo STESSO secchio della lettura di
   * stato, quindi paga la stessa pausa. Senza questo test la pausa è decorazione.
   */
  it('fra la lettura di stato e le notifiche si aspetta', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [{ notificationType: 'NS', errori: [{ descrizione: 'x' }] }] })

    vi.useFakeTimers()
    const p = POST(req())
    // Tutto ciò che non è un timer viene smaltito: si arriva fino alla lettura di stato.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(arubaGetByFilename)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(arubaGetNotifications), 'le notifiche sono partite senza aspettare').not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS)
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)

    await vi.runAllTimersAsync()
    expect((await p).status).toBe(200)
  })

  /** Il SUCCESSO si logga (AGENTS.md, regola 5) — ma senza il motivo dentro. */
  it('il recupero riuscito lascia una riga, e la riga NON contiene il testo del motivo', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    notificaConMotivo()

    await giro()

    const ok = riga('motivo-da-notifiche')
    expect(ok, 'un recupero riuscito senza log è un successo invisibile').toBeTruthy()
    expect(ok!.livello).toBe('info')
    expect(ok!.campi.fattura_id).toBe('f-1')
    expect(ok!.campi.numero).toBe(7)
    expect(ok!.campi.tipo).toBe('NS')
    // ⚠️ Il TESTO del motivo va nella colonna, non nella riga di log.
    // Si scandisce la riga INTERA, `causa` compresa: `logEvento` ha QUATTRO argomenti e il
    // quarto è un canale vero — il ramo `notifiche-fallite`, venti righe più in là, ci passa
    // l'eccezione del provider. Guardare solo `campi` lascerebbe verde un futuro
    // «attacco la risposta alla causa così la vedo», che è il modo più probabile in cui il
    // corpo di una notifica — denominazione, CF e P.IVA di una famiglia — finirebbe in chiaro.
    expect(JSON.stringify([ok!.campi, ok!.causa])).not.toContain('Identificativo fiscale non valorizzato')
    expect(ok!.causa, 'un successo non ha una causa: se ce l’è, qualcuno ci ha attaccato la risposta').toBeUndefined()
  })
})

describe('la chiamata in più non si fa quando non serve', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /**
   * ⚠️ È IL VINCOLO CHE RENDE SOSTENIBILE IL LAVORO. Gli scarti sono 4 su 174: una richiesta
   * in più su ogni fattura regolare raddoppierebbe il consumo di un secchio da 12/min per IP
   * — e il secchio non è nostro, è anche di chi sta emettendo dal pannello in quel momento.
   */
  it('una fattura CONSEGNATA non interroga le notifiche', async () => {
    h.supabase = conUnaFattura()
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 7,
      statoAruba: 'Consegnata',
      descrizioneAruba: 'Ricevuta di consegna',
    })

    const res = await giro()
    expect(res.status).toBe(200)
    expect(vi.mocked(arubaGetNotifications)).not.toHaveBeenCalled()
  })

  it('uno scarto che il motivo ce l\'ha GIÀ non interroga le notifiche', async () => {
    h.supabase = conUnaFattura()
    vi.mocked(arubaGetByFilename).mockResolvedValue({
      stato: 4,
      statoAruba: 'Scartata',
      descrizioneAruba: 'Codice destinatario non valido',
      errorCode: '00311',
      errorDescription: null,
    })

    await giro()

    expect(vi.mocked(arubaGetNotifications)).not.toHaveBeenCalled()
    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_scarto_motivo).toContain('Codice destinatario non valido')
  })
})

describe('FAIL-OPEN: se le notifiche falliscono, il giro non perde lo stato', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /**
   * ⚠️ IL `429` È IL CASO ATTESO, non quello raro: l'08/09 ne sono arrivati nove. Se
   * bastasse a far saltare l'aggiornamento di stato, questo lavoro avrebbe PEGGIORATO il
   * difetto che sta chiudendo — la fattura resterebbe in coda e nessuno saprebbe che è stata
   * respinta. Lo stato si scrive, il motivo resta povero, e la riga d'errore porta il corpo
   * del provider (AGENTS.md, regola 3): `429` e `404` si sistemano in due modi diversi.
   */
  it('le notifiche lanciano → lo stato si scrive lo stesso, col motivo povero e un log parlante', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    const rifiuto = Object.assign(new Error('Aruba notifiche fallita (HTTP 429): {"errorDescription":"Too many requests"}'), {
      name: 'ArubaHttpError',
      code: '429',
    })
    vi.mocked(arubaGetNotifications).mockRejectedValue(rifiuto)

    const res = await giro()
    expect(res.status).toBe(200)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_stato, 'lo stato SDI si perde per colpa di una chiamata accessoria').toBe(4)
    expect(fUpd.row.sdi_scarto_motivo).toContain('nessun motivo dal provider')
    // Il pagamento arriva comunque a `scartata`, e la Segreteria viene comunque avvisata.
    expect(updates().find((u) => u.table === 'pagamenti')!.row.fattura_stato).toBe('scartata')
    expect(h.enqueue).toHaveBeenCalledTimes(1)

    const errore = riga('notifiche-fallite')
    expect(errore, 'una chiamata fallita senza log è il divieto n° 6').toBeTruthy()
    expect(errore!.livello).toBe('error')
    // ⚠️ IL QUARTO ARGOMENTO: senza, il corpo del provider è stato buttato via.
    expect(errore!.causa).toBe(rifiuto)
  })

  /**
   * ⚠️ LA FORMA IGNOTA È IL CASO PIÙ PROBABILE DI TUTTI, ed è il motivo per cui esiste
   * questa riga di log: la forma della risposta NON è stata misurata contro l'API vera
   * (Aruba concede 12 richieste/min per IP e il cron le sta già consumando). Alla prima
   * notifica reale è questa riga a dire com'è fatta davvero.
   *
   * 🔴 E deve dirlo SENZA MOSTRARE NIENTE: quel corpo contiene denominazione, codice fiscale
   * e partita IVA dell'intestatario della fattura. Nomi dei campi sì, valori mai.
   */
  it('forma ignota → nomi dei campi nel log, valori MAI, e lo stato si scrive lo stesso', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({
      esitoRichiesta: { codiceOperazione: 12 },
      intestatario: { denominazione: 'Famiglia Esempio', codiceFiscale: 'AAAAAA00A00A000A', partitaIVA: '01234567890' },
    })

    const res = await giro()
    expect(res.status).toBe(200)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_stato).toBe(4)
    expect(fUpd.row.sdi_scarto_motivo).toContain('nessun motivo dal provider')

    const ignota = riga('notifiche-forma-ignota')
    expect(ignota, 'senza questa riga la forma vera non si saprà mai').toBeTruthy()
    expect(ignota!.livello).toBe('error')
    // La riga INTERA, quarto argomento compreso: vedi la nota sullo stesso punto nel test
    // del recupero riuscito. `causa` è il canale che la funzione accanto usa davvero, quindi
    // è il canale da cui il corpo grezzo può passare.
    expect(ignota!.causa, 'una forma non riconosciuta non è un’eccezione: non c’è nessuna causa da allegare').toBeUndefined()
    const scritto = JSON.stringify([ignota!.campi, ignota!.causa])
    // I NOMI dei campi: è ciò che permette di sostituire le euristiche con una misura.
    expect(scritto).toContain('intestatario')
    expect(scritto).toContain('denominazione')
    expect(scritto).toContain('codiceFiscale')
    // 🔴 I VALORI no. Nessuno di questi deve comparire, da nessuna parte nella riga.
    for (const valore of ['Famiglia Esempio', 'AAAAAA00A00A000A', '01234567890']) {
      expect(scritto, `il valore «${valore}» è finito nel log`).not.toContain(valore)
    }
  })

  /** Una risposta vuota è una forma ignota come le altre: non si inventa un motivo. */
  it('notifiche vuote → motivo povero, e nessun testo inventato in colonna', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [] })

    await giro()

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_scarto_motivo).toContain('nessun motivo dal provider')
    expect(riga('notifiche-forma-ignota')).toBeTruthy()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// L'ALLEGATO — la forma VERA, misurata il 2026-09-11 alle 16:30Z
// ════════════════════════════════════════════════════════════════════════════════

/**
 * La risposta vera di Aruba: il motivo NON è in un campo JSON — `errorCode` ed
 * `errorDescription` della notifica sono `null` — ma dentro `file`, 6304 caratteri, che è
 * l'XML della notifica SdI. La lettura sta in `motivoDalleNotificheSdi`; qui si guarda il
 * GIRO: che il motivo arrivi in colonna, e che l'XML non arrivi da nessun'altra parte.
 *
 * 🔴 Quell'XML è una notifica fiscale: porta denominazione, codice fiscale e partita IVA
 * dell'intestatario della fattura — di una FAMIGLIA. `sanificaMessaggio` maschera email e
 * codici fiscali, NON una ragione sociale. I valori qui sotto sono inventati e riconoscibili
 * come tali: il repository è pubblico.
 */
const INTESTATARIO = {
  denominazione: 'Rossi Costruzioni S.r.l.',
  partitaIVA: '01234567890',
  codiceFiscale: 'RSSMRA80A01F839X',
}

const nsXml = (errori: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ns3:NotificaScarto xmlns:ns3="http://www.fatturapa.gov.it/sdi/messaggi/v1.0" versione="1.0">
  <IdentificativoSdI>0000000000</IdentificativoSdI>
  <NomeFile>IT00000000000_00001.xml.p7m</NomeFile>
  ${errori}
  <CessionarioCommittente>
    <Denominazione>${INTESTATARIO.denominazione}</Denominazione>
    <PartitaIVA>${INTESTATARIO.partitaIVA}</PartitaIVA>
    <CodiceFiscale>${INTESTATARIO.codiceFiscale}</CodiceFiscale>
  </CessionarioCommittente>
</ns3:NotificaScarto>`

/** L'involucro misurato, con il campo `file` al posto suo. */
const notificaConAllegato = (xml: string) =>
  vi.mocked(arubaGetNotifications).mockResolvedValue({
    count: 1,
    notifications: [
      {
        filename: 'IT00000000000_00001_NS_001.xml',
        number: null,
        notificationDate: null,
        docType: 'NS',
        date: '2026-09-10T12:00:00.000+0200',
        invoiceId: '000000000000000000000000',
        file: Buffer.from(xml, 'utf-8').toString('base64'),
        result: null,
        errorCode: null,
        errorDescription: null,
      },
    ],
    errorCode: '0000',
    errorDescription: null,
  })

describe('il motivo dentro l\'allegato arriva in colonna, e l\'allegato non arriva nei log', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /** ⚠️ LA FORMA VERA: `errorCode` null, il motivo dentro `file`, in base64. */
  it('la forma misurata del 2026-09-11: il motivo esce dall\'XML e finisce in `sdi_scarto_motivo`', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    notificaConAllegato(
      nsXml('<ListaErrori><Errore><Codice>00400</Codice><Descrizione>Natura non ammessa per aliquota diversa da zero</Descrizione></Errore></ListaErrori>'),
    )

    const res = await giro()
    expect(res.status).toBe(200)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_scarto_motivo).toBe('(00400) Natura non ammessa per aliquota diversa da zero')
    expect(riga('motivo-da-notifiche')!.campi.tipo, 'il tipo arriva da `docType`').toBe('NS')
  })

  /**
   * 🔴 IL TEST DI PRIVACY, e va letto sapendo cosa protegge. L'XML appena letto contiene la
   * ragione sociale e la partita IVA dell'intestatario. Nessuna riga di log deve portarle —
   * in NESSUN campo e in NESSUNO dei quattro argomenti di `logEvento`, `causa` compresa, che
   * è il canale da cui il corpo del provider passerebbe se qualcuno «ce lo attaccasse per
   * vederlo». Nemmeno il MOTIVO ci va: quello è testo del provider su una fattura di una
   * famiglia, e la sua casa è `sdi_scarto_motivo`, che è una colonna.
   */
  it('nessuna riga di log contiene la ragione sociale, la P.IVA o il testo del motivo', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    notificaConAllegato(
      nsXml('<ListaErrori><Errore><Codice>00400</Codice><Descrizione>Natura non ammessa per aliquota diversa da zero</Descrizione></Errore></ListaErrori>'),
    )

    await giro()

    const tutto = JSON.stringify(righeLog())
    for (const valore of [
      INTESTATARIO.denominazione,
      INTESTATARIO.partitaIVA,
      INTESTATARIO.codiceFiscale,
      'Natura non ammessa',
      'CessionarioCommittente',
    ]) {
      expect(tutto, `«${valore}» è finito in una riga di log`).not.toContain(valore)
    }
    // E il motivo è arrivato dove doveva: senza questa metà, il test sarebbe verde anche se
    // la lettura dell'allegato non fosse mai partita.
    expect(updates().find((u) => u.table === 'fatture_emesse')!.row.sdi_scarto_motivo).toContain('00400')
  })

  /**
   * ⚠️ IL GRADINO IN PIÙ DELLA DIAGNOSTICA. Se domani l'XML non desse i tag attesi, con la
   * sola `descriviForma` resteremmo fermi a `file: stringa(6304)` — cioè ciechi, e per
   * vederci servirebbe un'altra interrogazione dentro un secchio da 12 richieste al minuto.
   * La riga porta i NOMI DEI TAG. Mai il loro contenuto: quei tag sono l'anagrafica fiscale
   * di una famiglia, e i nomi non sono dati di nessuno.
   */
  it('allegato senza errori riconoscibili → i NOMI dei tag XML nel log, i valori MAI', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    notificaConAllegato(nsXml('<EsitoSconosciuto><MotivoIgnoto>x</MotivoIgnoto></EsitoSconosciuto>'))

    const res = await giro()
    expect(res.status).toBe(200)

    const ignota = riga('notifiche-forma-ignota')
    expect(ignota, 'senza questa riga la forma dell\'XML non si saprà mai').toBeTruthy()
    expect(ignota!.livello).toBe('error')
    expect(ignota!.causa, 'una forma non riconosciuta non è un\'eccezione: niente da allegare').toBeUndefined()

    // ⚠️ I TIPI DICHIARATI, IN CHIARO — ed è il campo che dice se `NS` è la parola giusta.
    //
    // `docType` è entrato fra le chiavi del tipo su una misura della sua LUNGHEZZA
    // (`stringa(2)`), non del valore. Se quelle due lettere non fossero `NS`, il filtro
    // passerebbe da «tipo assente ⇒ ammessa» a «tipo dichiarato ≠ NS ⇒ ESCLUSA» e la
    // funzione diventerebbe muta senza nessun segnale: la `forma` esce identica, perché non
    // porta valori. Questo campo è l'unico modo di accorgersene.
    //
    // E dev'essere IN CHIARO: `redact` è a lista bianca, `tipo` c'è e `tipi` no. Con la
    // chiave sbagliata qui leggeremmo `[redatto:str/2]`, cioè la riga che esiste per dire
    // QUALE tipo è arrivato tacerebbe proprio quello — verde, e cieca.
    expect(ignota!.campi.tipo, 'il tipo dichiarato non è arrivato, o è stato redatto').toBe('NS')

    // ⚠️ Si guarda il messaggio DOPO `sanificaMessaggio`, che tronca a `MESSAGGIO_MAX` e
    // taglia la CODA: i nomi dei tag stanno in fondo, ed è lì che un budget sbagliato li
    // farebbe sparire in silenzio. È lo stesso criterio del test sul prefisso corto.
    const scritto = sanificaMessaggio(String(ignota!.campi.msg))
    expect(scritto).toContain('NotificaScarto')
    expect(scritto).toContain('CessionarioCommittente')
    expect(scritto).toContain('EsitoSconosciuto')
    // La forma del JSON non si è persa per far posto alla traccia.
    expect(scritto).toContain('notifications')
    expect(scritto).toContain('docType')
    // ⚠️ E CIÒ CHE NON CI STA SI DICHIARA. Il budget è finito: i nomi che avanzano vengono
    // tolti INTERI — un nome tagliato a metà non è mezza informazione, è zero, perché non lo
    // si può cercare — e il numero di quelli rimasti fuori è scritto lì.
    expect(scritto, 'la traccia è stata tagliata in silenzio, o a metà nome').toMatch(/…\+\d+$/)
    // 🔴 E i VALORI no, da nessuna parte nella riga — `causa` compresa.
    const riga_ = JSON.stringify([ignota!.campi, ignota!.causa])
    for (const valore of [INTESTATARIO.denominazione, INTESTATARIO.partitaIVA, INTESTATARIO.codiceFiscale]) {
      expect(riga_, `il valore «${valore}» è finito nel log`).not.toContain(valore)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// IL RIENTRO — gli scarti già terminali, quelli che hanno motivato tutto il lavoro
// ════════════════════════════════════════════════════════════════════════════════

describe('il rientro ripesca gli scarti che il motivo non ce l\'hanno', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /**
   * ⚠️ IL TEST CHE CHIUDE IL RILIEVO. Misurato in produzione il 2026-09-11: `sdi_stato = 4`
   * su 4 righe, tutte e 4 con «nessun motivo dal provider», e ZERO fatture in volo negli
   * stati di scarto. Il recupero dalle notifiche stava dentro il ciclo del giro, dopo il
   * `continue` che salta le righe il cui stato non è cambiato: quelle 4 righe non lo
   * raggiungevano, e non l'avrebbero raggiunto mai più.
   */
  it('una fattura GIÀ scartata, col motivo povero, viene ripescata e il motivo finisce in colonna', async () => {
    h.supabase = conScartiArretrati(1)
    notificaConMotivo()

    const res = await giro()
    expect(res.status).toBe(200)

    // Nessuna rilettura di stato: la fattura non è in volo, e chiederlo ad Aruba sarebbe
    // una richiesta buttata su un secchio da 12/min.
    expect(vi.mocked(arubaGetByFilename), 'il rientro ha ri-chiesto anche lo stato').not.toHaveBeenCalled()
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(arubaGetNotifications).mock.calls[0][2]).toBe('ITxxx_0.xml.p7m')

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    expect(fUpd.row.sdi_scarto_motivo).toContain('Identificativo fiscale non valorizzato')
    // 🔴 SOLO il motivo. Lo stato di una fattura terminale non si ricalcola su una chiamata
    // accessoria, e il pagamento non si tocca: qui si sta riparando una FRASE, non un esito.
    expect(Object.keys(fUpd.row), 'il rientro ha riscritto anche altro').toEqual(['sdi_scarto_motivo'])
    expect(updates().find((u) => u.table === 'pagamenti')).toBeUndefined()
    // La Segreteria era già stata avvisata quando la fattura è stata scartata: avvisarla di
    // nuovo per una frase corretta è una push che non porta niente.
    expect(h.enqueue).not.toHaveBeenCalled()

    expect((await res.json()).data.rientri).toBe(1)
  })

  /**
   * ⚠️ IL VINCOLO ESPLICITO: il `4` NON va in `STATI_IN_VOLO`. Ce lo si mettesse, ogni
   * fattura scartata tornerebbe in coda a OGNI giro, per sempre, a due richieste Aruba
   * ciascuna — su un secchio da 12 al minuto per IP che è anche di chi sta emettendo.
   */
  it('gli stati di scarto NON sono entrati nella coda delle fatture in volo', async () => {
    h.supabase = conScartiArretrati(1)
    notificaConMotivo()

    await giro()

    const inVolo = filtri().filter((f) => f.table === 'fatture_emesse' && f.m === 'in')[0]
    expect(inVolo, 'la coda del cron non viene più filtrata per stato?').toBeTruthy()
    for (const scarto of [2, 4, 9]) {
      expect(inVolo.val as number[], `lo stato di scarto ${scarto} è finito nella coda in volo`).not.toContain(scarto)
    }
  })

  /**
   * Il rientro copre TUTTI gli stati che `stato.ts` marca `isScarto`, non solo il `4`.
   * `2` (errore di elaborazione) e `9` (rifiutata dal destinatario) sono scarti come gli
   * altri: una fattura in quello stato NON è stata emessa, e va corretta e ritrasmessa.
   */
  it('il rientro guarda 2, 4 e 9 — non solo il 4', async () => {
    h.supabase = conScartiArretrati(1)
    notificaConMotivo()

    await giro()

    const perIlRientro = filtri().filter((f) => f.table === 'fatture_emesse' && f.m === 'in')[1]
    expect(perIlRientro, 'non esiste una seconda query: il rientro non c\'è').toBeTruthy()
    expect(perIlRientro.col).toBe('sdi_stato')
    expect(perIlRientro.val as number[]).toEqual(expect.arrayContaining([2, 4, 9]))
  })

  /**
   * 🔴 IL PUNTO PIÙ IMPORTANTE DEL RIENTRO: DEVE TERMINARE.
   *
   * Una riga per cui le notifiche non danno mai un motivo non può essere richiesta a ogni
   * giro all'infinito: sarebbero due richieste Aruba ogni trenta minuti, per sempre, su un
   * secchio che è anche di chi emette. Dopo UN tentativo la riga esce dalla coda — e il
   * fatto che ci si è provati resta SCRITTO nella colonna che la Segreteria apre, che è il
   * posto in cui «ci abbiamo provato, non c'era» vale più del silenzio.
   *
   * Il test fa girare il giro DUE VOLTE sullo stesso database. La seconda non deve chiedere.
   */
  it('una riga per cui le notifiche non dicono niente NON viene richiesta al giro successivo', async () => {
    h.supabase = conScartiArretrati(1)
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [] })

    await giro()
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    const motivo = String(fUpd.row.sdi_scarto_motivo)
    // Il motivo povero resta — è poco, ma è vero — e accanto ci va il segno del tentativo.
    expect(motivo).toContain('nessun motivo dal provider')
    expect(motivo, 'senza un segno visibile, il tentativo è invisibile e la riga torna per sempre').toContain(MARCATORE_RIENTRO)

    // ── IL SECONDO GIRO ──────────────────────────────────────────────────────
    await giro()
    expect(
      vi.mocked(arubaGetNotifications),
      'la riga è tornata in coda: il rientro consuma il budget Aruba per sempre',
    ).toHaveBeenCalledTimes(1)
  })

  /**
   * Stessa regola quando la chiamata FALLISCE (un `404`, o un `429` che non passerà mai):
   * un tentativo, e basta. La differenza fra i due casi resta scritta, perché «non c'era
   * niente» e «non sono riuscito a chiedere» si correggono in due modi diversi.
   */
  it('anche un rientro FALLITO conta come tentativo, e lo dice', async () => {
    h.supabase = conScartiArretrati(1)
    const rifiuto = Object.assign(new Error('Aruba notifiche fallita (HTTP 404): {"errorDescription":"Not found"}'), {
      name: 'ArubaHttpError',
      code: '404',
    })
    vi.mocked(arubaGetNotifications).mockRejectedValue(rifiuto)

    const res = await giro()
    expect(res.status, 'un rientro fallito non può far cadere il giro').toBe(200)

    const fUpd = updates().find((u) => u.table === 'fatture_emesse')!
    const motivo = String(fUpd.row.sdi_scarto_motivo)
    expect(motivo).toContain(MARCATORE_RIENTRO)
    expect(motivo, 'la riga non distingue «non c\'era niente» da «non ho potuto chiedere»').toMatch(/non riuscita/i)

    const errore = riga('notifiche-fallite')
    expect(errore!.livello).toBe('error')
    expect(errore!.causa, 'il corpo del provider è stato buttato via').toBe(rifiuto)

    await giro()
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ IL TETTO. Il rientro è un ARRETRATO che si smaltisce, non un evento da inseguire:
   * poche righe a giro, per non portare via gli slot a chi sta emettendo. Con quattro
   * scarti in produzione, l'arretrato si chiude in pochi tick.
   */
  it('non si ripescano più di tre righe per giro, e fra una e l\'altra si aspetta', async () => {
    h.supabase = conScartiArretrati(10)
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [] })

    vi.useFakeTimers()
    const p = POST(req())
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(0)
    // Senza far scorrere il tempo non parte NESSUNA richiesta: la pausa si paga prima.
    expect(vi.mocked(arubaGetNotifications), 'il rientro non rispetta la pausa del secchio').not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PAUSA_FRA_PAGINE_MS)
    expect(vi.mocked(arubaGetNotifications)).toHaveBeenCalledTimes(1)

    await vi.runAllTimersAsync()
    const res = await p
    vi.useRealTimers()

    const chiamate = vi.mocked(arubaGetNotifications).mock.calls.length
    expect(chiamate).toBeGreaterThanOrEqual(1)
    // Il tetto vero è 2 (`TETTO_RIENTRO_PER_GIRO`). Un `<= 3` lasciava gioco: alzarlo a 3,
    // cioè +50% di richieste sul secchio da 12/min, sarebbe passato inosservato. Un lock che
    // tollera il valore che dovrebbe sorvegliare non sorveglia niente.
    expect(chiamate, 'un tetto alto sul rientro sfonda il secchio da 12/min').toBeLessThanOrEqual(2)
    expect((await res.json()).data.rientri).toBe(chiamate)
  })

  /**
   * IL TETTO SI PAGA IN RICHIESTE SPESE, NON IN RIGHE LETTE.
   *
   * Una sede con Aruba spento non manda nessuna richiesta: se occupasse comunque un posto
   * della finestra, e le sue righe stessero in cima, il rientro girerebbe a vuoto a OGNI
   * tick — sempre sulle stesse righe, perché la query non ha `ORDER BY` e l'ordine fisico
   * non cambia — e le fatture riparabili delle altre sedi non verrebbero raggiunte mai.
   * Il battito direbbe `rientri: 0`, cioè «niente da fare», mentre c'era tutto da fare.
   */
  it('una sede con Aruba spento non consuma la finestra del rientro', async () => {
    const SPENTA = '22222222-2222-2222-2222-222222222222'
    const scarto = (id: string, scuola: string, numero: number) => ({
      id, pagamento_id: `pag-${id}`, scuola_id: scuola, numero,
      aruba_filename: `ITxxx_${id}.xml.p7m`, sdi_stato: 4,
      sdi_stato_label: 'Scartata dallo SDI — Aruba: «Scartata»',
      sdi_scarto_motivo: MOTIVO_POVERO,
    })
    h.supabase = makeSupabase({
      // Le due della sede spenta vengono PRIMA: è la disposizione che innesca il difetto.
      fatture_emesse: [scarto('f-1', SPENTA, 1), scarto('f-2', SPENTA, 2), scarto('f-3', SCUOLA, 3)],
      admin_settings: [
        { scuola_id: SPENTA, aruba_config: { ...ARUBA_OK, abilitato: false } },
        { scuola_id: SCUOLA, aruba_config: ARUBA_OK },
      ],
      utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
    })
    vi.mocked(arubaGetNotifications).mockResolvedValue({
      notifications: [{ notificationType: 'NS', errorCode: '00427', errorDescription: 'Formato non coerente' }],
    })

    await giro()

    expect(
      vi.mocked(arubaGetNotifications),
      'la sede spenta ha mangiato la finestra: la fattura riparabile non è stata raggiunta',
    ).toHaveBeenCalledTimes(1)
  })

  /** Uno scarto che il motivo ce l'ha già non rientra: non c'è niente da riparare. */
  it('uno scarto con un motivo VERO non viene ripescato', async () => {
    h.supabase = makeSupabase({
      fatture_emesse: [{
        id: 'f-1', pagamento_id: 'pag-1', scuola_id: SCUOLA, numero: 1985,
        aruba_filename: 'ITxxx_0.xml.p7m', sdi_stato: 4,
        sdi_scarto_motivo: '(00417) Identificativo fiscale non valorizzato',
      }],
      admin_settings: { aruba_config: ARUBA_OK },
      utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
    })

    await giro()

    expect(vi.mocked(arubaGetNotifications)).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
  })

  /**
   * La stessa fattura non si paga DUE VOLTE nello stesso giro: se il ciclo l'ha appena
   * portata a scarto e le ha già chiesto le notifiche, il rientro non ci ritorna sopra.
   * Sarebbero due richieste Aruba per una riga sola, nello stesso minuto.
   */
  it('una fattura appena esaminata dal ciclo non viene ri-chiesta dal rientro', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [] })

    await giro()

    expect(
      vi.mocked(arubaGetNotifications),
      'la stessa fattura ha pagato due richieste Aruba nello stesso giro',
    ).toHaveBeenCalledTimes(1)
  })

  /** Il battito finale conta anche il rientro: se non si conta, il costo non si misura. */
  it('il battito del giro dice quante righe ha ripescato', async () => {
    h.supabase = conScartiArretrati(1)
    notificaConMotivo()

    await giro()

    const battito = riga('ok') ?? riga('ok-parziale')
    expect(battito).toBeTruthy()
    expect(battito!.campi.rientri, 'il costo del rientro non è misurabile dal battito').toBe(1)
  })
})

/**
 * ⚠️ IL LOCK CHE TIENE IL RIENTRO AGGANCIATO ALLA FRASE CHE CERCA.
 *
 * Il rientro riconosce un motivo povero dalla STRINGA a registro — nel rientro i dettagli di
 * Aruba non esistono più, c'è solo la riga. `stato.ts` avverte, giustamente, che riconoscere
 * il ramo difensivo dal nostro testo italiano smette di funzionare il giorno in cui qualcuno
 * riscrive la frase, **e smette in silenzio**: la query non tornerebbe più niente e nessuno
 * se ne accorgerebbe, perché «nessuno scarto da riparare» è anche il caso normale.
 *
 * Qui la divergenza non si previene: si fa gridare. Il frammento si verifica contro la
 * funzione VERA, su tutti gli stati che `stato.ts` marca `isScarto` e su tutti e tre i rami
 * difensivi di `motivoScartoAruba`.
 */
describe('il frammento che il rientro cerca è ancora quello che il codice scrive', () => {
  const FRAMMENTO = 'dal provider'

  it.each([2, 4, 9])('lo stato di scarto %i, senza descrizioni, produce un motivo che il rientro riconosce', (codice) => {
    const m = mapStatoAruba(codice)
    expect(m.isScarto, `lo stato ${codice} non è più uno scarto: aggiornare statiDiScarto() nella route`).toBe(true)

    // I tre rami difensivi: nessun dettaglio, solo la dicitura di Aruba, solo il codice.
    const senzaNiente = motivoScartoAruba(m, null, {})
    const conDicitura = motivoScartoAruba(m, 'Scartata', { descrizioneAruba: '', errorCode: '', errorDescription: '' })
    const conCodice = motivoScartoAruba(m, 'Scartata', { errorCode: '0093' })

    for (const [nome, motivo] of Object.entries({ senzaNiente, conDicitura, conCodice })) {
      expect(motivo, `su uno scarto il motivo non è mai null (${nome})`).toBeTruthy()
      expect(
        String(motivo),
        `«${motivo}» non contiene più «${FRAMMENTO}»: il rientro ha smesso di riconoscere gli scarti poveri, e ha smesso IN SILENZIO`,
      ).toContain(FRAMMENTO)
    }
  })

  /** E il verso opposto: un motivo VERO non deve somigliare a un motivo povero. */
  it('un motivo vero del provider non contiene il frammento', () => {
    const vero = motivoScartoAruba(mapStatoAruba(4), 'Scartata', {
      descrizioneAruba: 'Identificativo fiscale non valorizzato',
      errorCode: '00417',
    })
    expect(String(vero), 'il rientro ripescherebbe anche gli scarti già riparati').not.toContain(FRAMMENTO)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// IL TETTO DI TEMPO — ciò che si rimanda deve davvero tornare
// ════════════════════════════════════════════════════════════════════════════════

describe('quando il tetto di tempo salta le notifiche, il motivo è RIMANDATO e non perso', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /**
   * ⚠️ IL COMMENTO SUL POSTO DICEVA IL FALSO, ed è il rilievo che questo test chiude.
   * Sosteneva che «le righe rimaste tornano al giro successivo»: vero per le righe NON
   * esaminate, falso proprio per QUESTA — lo stato terminale viene scritto lo stesso, quindi
   * la riga esce da `STATI_IN_VOLO` e nessun giro la ripesca.
   *
   * Con il rientro la frase torna vera, ma per un'altra strada: non è la coda delle fatture
   * in volo a riprenderla, è la seconda query. Il test fa vedere proprio quel passaggio —
   * prima il tetto salta le notifiche, poi il giro dopo il rientro le chiede.
   */
  it('il tetto salta le notifiche, e al giro successivo il rientro le chiede', async () => {
    // Tante righe in volo quante ne serve a consumare i 240 s: ~10 s a riga fra le due pause.
    h.supabase = makeSupabase({
      fatture_emesse: Array.from({ length: 30 }, (_, i) => ({
        id: `f-${i + 1}`, pagamento_id: `pag-${i + 1}`, scuola_id: SCUOLA, numero: 100 + i,
        aruba_filename: `ITxxx_${i}.xml.p7m`, sdi_stato: 0,
      })),
      admin_settings: { aruba_config: ARUBA_OK },
      utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SCUOLA }],
    })
    scartoSenzaMotivo()
    vi.mocked(arubaGetNotifications).mockResolvedValue({ notifications: [] })

    await giro()

    const saltate = righe('notifiche-saltate-tempo')
    expect(saltate.length, 'il tetto di tempo non è mai scattato: il test non prova niente').toBeGreaterThan(0)
    expect(saltate[0].livello).toBe('warn')
    // 🔴 IL MESSAGGIO DEVE DIRE LA VERITÀ: il motivo è rimandato al rientro, non perso.
    expect(
      String(saltate[0].campi.msg),
      'il messaggio non dice dove il motivo verrà ripreso',
    ).toMatch(/rientro/i)

    // La riga saltata è finita a registro come scartata e col motivo povero: è proprio la
    // forma che il rientro cerca. Il giro successivo se la riprende.
    const saltata = saltate[0].campi.fattura_id as string
    vi.clearAllMocks()
    vi.mocked(arubaSignin).mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 })
    notificaConMotivo()

    await giro()

    const chieste = vi.mocked(arubaGetNotifications).mock.calls.map((c) => c[2])
    expect(chieste.length, 'la riga saltata per tempo non è più tornata: il motivo è perso').toBeGreaterThan(0)
    const daRipescare = updates()
      .filter((u) => u.table === 'fatture_emesse' && Object.keys(u.row).length === 1)
      .length
    expect(daRipescare, 'il rientro non ha riparato nessuna riga').toBeGreaterThan(0)
    expect(saltata).toBeTruthy()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// LA RIGA DIAGNOSTICA — se è troncata dove serve, non serve a niente
// ════════════════════════════════════════════════════════════════════════════════

describe('la forma della risposta arriva INTERA nel messaggio persistito', () => {
  beforeEach(ambientePulito)
  afterEach(ambientePulitoFine)

  /**
   * ⚠️ IL RILIEVO: `sanificaMessaggio` tronca ogni messaggio a 500 caratteri, e il prefisso
   * del messaggio `notifiche-forma-ignota` ne occupava **117**. Della descrizione della
   * forma ne sopravvivevano ~382 — e quello che si perde è la CODA, cioè proprio i nomi dei
   * campi d'errore, mentre sopravvive il blocco dell'intestatario, che non serve a nessuno.
   *
   * Quella riga è l'UNICA via per scoprire com'è fatta davvero la risposta di Aruba alla
   * prima notifica reale (la forma non è mai stata misurata: interrogare l'API per scoprirla
   * consumerebbe lo stesso budget che il cron sta usando). Troncata dove serve, non serve.
   *
   * 🔴 SI ASSERISCE SUL MESSAGGIO PERSISTITO — cioè DOPO `sanificaMessaggio` — e non su
   * `descriviForma`: il troncamento avviene lì, e un test sulla forma nuda resterebbe verde
   * con la riga di log inutilizzabile.
   */
  it('i nomi dei campi d\'errore sopravvivono al taglio a 500 caratteri', async () => {
    h.supabase = conUnaFattura()
    scartoSenzaMotivo()
    // Una risposta ANNIDATA PLAUSIBILE, nessuna delle cui chiavi l'estrattore riconosce:
    // l'involucro non è fra i contenitori attesi e i campi d'errore hanno nomi loro. È il
    // caso per cui la riga di log esiste. L'intestatario sta PRIMA e le anomalie DOPO,
    // perché è l'ordine peggiore: il taglio mangia la coda.
    vi.mocked(arubaGetNotifications).mockResolvedValue({
      esitoOperazione: { codiceRisposta: 0, testoRisposta: 'Operazione eseguita' },
      notificaSdI: {
        tipoDocumento: 'NS',
        identificativoSdI: 7654321,
        dataOraRicezione: '2026-09-11T10:31:00.000Z',
        intestatario: {
          denominazione: 'Famiglia Esempio',
          codiceFiscale: 'AAAAAA00A00A000A',
          partitaIVA: '01234567890',
          indirizzo: 'Via Esempio 1',
          comune: 'Giugliano',
          provincia: 'NA',
          cap: '80014',
        },
        anomalie: [{ codiceAnomalia: '00417', testoAnomalia: 'Identificativo fiscale non valorizzato' }],
      },
    })

    await giro()

    const ignota = riga('notifiche-forma-ignota')
    expect(ignota).toBeTruthy()
    // Il logger scrive in `app_log` `sanificaMessaggio(campi.msg)` (vedi `testoEvento`).
    const persistito = sanificaMessaggio(String(ignota!.campi.msg))
    const MAX = sanificaMessaggio('a'.repeat(4_000)).length

    // ── LA GUARDIA DEL TEST ──────────────────────────────────────────────────
    // Se il messaggio non arriva a ridosso del tetto, questo test non sta più provando
    // niente: ogni carattere di prefisso in più starebbe dentro il budget e la coda non si
    // perderebbe comunque. (Se un giorno `FORMA_MAX` scendesse sotto ~430, è QUESTA riga a
    // dirlo, invece di lasciare il test verde e cieco.)
    expect(
      persistito.length,
      'il messaggio è troppo corto perché il troncamento sia dimostrabile: rivedere il payload o FORMA_MAX',
    ).toBeGreaterThan(MAX - 60)

    // ── IL FATTO ─────────────────────────────────────────────────────────────
    expect(persistito.length, 'il messaggio persistito è stato tagliato').toBeLessThanOrEqual(MAX)
    expect(persistito.endsWith('…'), 'il messaggio finisce con l\'ellissi del taglio').toBe(false)
    // Ciò che serve davvero: i nomi dei campi d'errore, che stanno in CODA.
    expect(persistito, 'il nome del campo di codice è stato tagliato via').toContain('codiceAnomalia')
    expect(persistito, 'il nome del campo di descrizione è stato tagliato via').toContain('testoAnomalia')

    // 🔴 E resta vero che i VALORI non ci sono: accorciare il prefisso non allarga la resa.
    for (const valore of ['Famiglia Esempio', 'AAAAAA00A00A000A', '01234567890', 'Identificativo fiscale non valorizzato']) {
      expect(persistito, `il valore «${valore}» è finito nel messaggio`).not.toContain(valore)
    }
  })
})
