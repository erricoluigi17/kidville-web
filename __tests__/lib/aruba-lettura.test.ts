// @vitest-environment node
/**
 * La guardia degli script che chiamano Aruba (D1 §10, R1-1.5) e le parti comuni della lettura.
 *
 * Cosa si difende qui:
 *  · la guardia è FAIL-CLOSED: ogni lettura che non si capisce blocca. L'unica eccezione è la
 *    coda che NON C'È (to_regclass NULL per entrambe le tabelle, oppure 42P01 alla seconda
 *    lettura), perché fino alla PR-A la coda non esiste e gli script di R1 devono poter partire;
 *  · l'ordine delle guardie: lettura, coda, circuito, cancello, finestra della sync, attività;
 *  · la finestra della sync corretta (:58-:05 e :28-:35), non quella della v5;
 *  · 5000 ms fra due chiamate, la guardia prima di OGNI chiamata, lo stop al primo 429;
 *  · il `--out` fuori dal repo, i processi figli con argomenti in array.
 *
 * I controlli negativi sono ESEGUITI: le stesse asserzioni girano contro una variante rotta
 * della guardia, e devono fallire. Una guardia che passa anche rotta non è una guardia.
 *
 * Aruba è FINTO e fail-closed (C0-12): `test/setup.ts` blocca solo l'host Supabase di
 * produzione, quindi qui `fetch` è sostituito da un finto che risponde SOLO agli URL che il
 * caso dichiara, e lancia su tutti gli altri — Aruba compreso.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import * as moduloGrezzo from '../../scripts/lib/aruba-lettura.mjs'

type Esito = { ok: boolean; codice?: string; messaggio?: string; riprova_dopo?: Date; nota?: string; adesso?: Date }
type Sql = (testo: string) => Promise<unknown[]>
type Documento = Record<string, unknown>
interface Lettore {
  note: string[]
  signin: () => Promise<void>
  scorriDocumenti: (p: { anno: number }) => Promise<{ documenti: Documento[]; totale: number | null; pagine: number }>
  getByFilename: (f: string) => Promise<{ contenuto: Buffer; fatture: Documento[] }>
}
type Esegui = (cmd: string, args: string[], opzioni: Record<string, unknown>) => unknown

/**
 * Il modulo è JavaScript: i tipi che TypeScript ne dedurrebbe dalle sole implementazioni sono
 * più stretti del contratto (un'unione di letterali). Qui si dichiara la forma del contratto,
 * quella che gli script usano.
 */
interface ModuloArubaLettura {
  BASI_ARUBA: { auth: string; ws: string }
  CODICI_GUARDIA: readonly string[]
  FermoAruba: new (codice: string, messaggio: string, o?: { riprova_dopo?: Date; uscita?: number }) => Error & {
    codice: string
    uscita: number
    riprova_dopo: Date
  }
  MINUTI_FINESTRA_SYNC: readonly number[]
  PAGINA_SIZE: number
  PAUSA_MS: number
  RADICE_REPO: string
  SQL_PRIMA_LETTURA: string
  SQL_SECONDA_LETTURA: string
  creaLettoreAruba: (o: {
    sql: Sql
    credenziali: { username: string; password: string } | null
    attendi?: (ms: number) => Promise<void>
    ora?: () => Date
  }) => Lettore
  eseguiFiglio: (cmd: string, args: string[], opzioni?: Record<string, unknown>, esegui?: Esegui) => unknown
  estraiXmlDaP7m: (contenuto: Buffer, o: { cartella: string; esegui?: Esegui }) => string
  fuoriDalRepository: (percorso: string, radice?: string) => boolean
  guardiaArubaPerScript: (o: { sql?: Sql }) => Promise<Esito>
  leggiCredenzialiAruba: (o: { env: Record<string, string | undefined>; fileEnvLocale: string }) => unknown
  messaggio429: (istante: unknown) => string
  minutoInFinestraSync: (m: number) => boolean
  oraRoma: (v: unknown) => string
  riduciDocumento: (doc: unknown) => Documento | null
  rifiutaOutNelRepository: (out: string | undefined, radice?: string) => string
  righeDaJsonCli: (testo: string) => unknown[]
  sqlDaCliSupabase: (o?: { esegui?: Esegui; radice?: string; timeoutMs?: number }) => Sql
  sqlstateDi: (e: unknown) => string | null
  verdettoAttivitaApp: (p: { n?: unknown; ultimo?: unknown; errore?: unknown; adesso?: unknown }) => Esito
  verdettoCodaPerScript: (p: { installata?: unknown; riga?: unknown; errore?: unknown }) => Esito
}

const {
  BASI_ARUBA,
  CODICI_GUARDIA,
  FermoAruba,
  MINUTI_FINESTRA_SYNC,
  PAGINA_SIZE,
  PAUSA_MS,
  RADICE_REPO,
  SQL_PRIMA_LETTURA,
  SQL_SECONDA_LETTURA,
  creaLettoreAruba,
  eseguiFiglio,
  estraiXmlDaP7m,
  fuoriDalRepository,
  guardiaArubaPerScript,
  leggiCredenzialiAruba,
  messaggio429,
  minutoInFinestraSync,
  oraRoma,
  riduciDocumento,
  rifiutaOutNelRepository,
  righeDaJsonCli,
  sqlDaCliSupabase,
  sqlstateDi,
  verdettoAttivitaApp,
  verdettoCodaPerScript,
} = moduloGrezzo as unknown as ModuloArubaLettura

// ─── Dati sintetici ────────────────────────────────────────────────────────────
// 10:15Z del 23/09/2026 = 12:15 a Roma (ora legale). Il minuto 15 è fuori dalla finestra.
const ADESSO = '2026-09-23T10:15:00.000Z'

function primaRiga(extra: Record<string, unknown> = {}) {
  return {
    minuto: 15,
    adesso: ADESSO,
    stato: false,
    cancello: false,
    attivita_app: 0,
    ultima_attivita: null,
    ...extra,
  }
}

function rigaCoda(extra: Record<string, unknown> = {}) {
  return {
    sospesa: true,
    circuito_aperto: false,
    circuito_fino_a: null,
    cancello_in_uso: false,
    titolare: null,
    righe: 1,
    ...extra,
  }
}

/** Un errore come quelli di `sqlDaCliSupabase`: con o senza SQLSTATE. */
function erroreSql(messaggio: string, sqlstate: string | null = null) {
  const e = new Error(messaggio) as Error & { sqlstate: string | null }
  e.sqlstate = sqlstate
  return e
}

/**
 * Una `sql` finta che riconosce le due letture per TESTO ESATTO e lancia su qualunque altra
 * query. Ogni lettura può essere righe, un errore da lanciare, o assente (→ lancia).
 */
function sqlFinta({ prima, seconda }: { prima?: unknown; seconda?: unknown }) {
  const chiamate: string[] = []
  const sql: Sql = async (testo) => {
    if (testo === SQL_PRIMA_LETTURA) {
      chiamate.push('prima')
      if (prima instanceof Error) throw prima
      if (prima === undefined) throw new Error('prima lettura non prevista dal caso')
      return prima as unknown[]
    }
    if (testo === SQL_SECONDA_LETTURA) {
      chiamate.push('seconda')
      if (seconda instanceof Error) throw seconda
      if (seconda === undefined) throw new Error('SECONDA LETTURA NON PREVISTA dal caso')
      return seconda as unknown[]
    }
    chiamate.push('altra')
    throw new Error(`query non prevista: ${testo.slice(0, 40)}`)
  }
  return { sql, chiamate }
}

const guardiaCon = (p: { prima?: unknown; seconda?: unknown }) => guardiaArubaPerScript(sqlFinta(p)) as Promise<Esito>

// ─── Casi riusabili, per eseguire i controlli negativi ─────────────────────────
type VerdettoCoda = (p: { installata: unknown; riga?: unknown; errore?: unknown }) => Esito

/** a) coda non installata → prosegue. Restituisce i fallimenti (vuoto = caso verde). */
function casoNonInstallata(v: VerdettoCoda): string[] {
  const e = v({ installata: false })
  return e.ok ? [] : [`non installata bloccata con ${e.codice}`]
}

/** d) ogni errore che non è 42P01 alla seconda lettura → blocco. */
function casiErroreBlocca(v: VerdettoCoda): string[] {
  const errori = [
    erroreSql('permission denied for table fatture_coda_stato (SQLSTATE 42501)', '42501'),
    erroreSql('supabase db query: uscita null (segnale SIGTERM), senza SQLSTATE: timeout'),
    erroreSql('supabase db query: uscita 1, senza SQLSTATE: failed to connect'),
    erroreSql('supabase db query: JSON illeggibile (nessuno SQLSTATE)'),
  ]
  const fallimenti: string[] = []
  for (const errore of errori) {
    for (const installata of [true, undefined]) {
      const e = v({ installata, errore })
      if (e.ok || e.codice !== 'lettura-fallita') {
        fallimenti.push(`${errore.message} (installata=${String(installata)}) → ${e.ok ? 'ok' : e.codice}`)
      }
    }
  }
  // 42P01 alla PRIMA lettura (es. app_log sparita) non è «coda non installata».
  const primaFallita = v({ installata: undefined, errore: erroreSql('relation does not exist', '42P01') })
  if (primaFallita.ok) fallimenti.push('42P01 alla prima lettura lasciato passare')
  return fallimenti
}

/** Circuito aperto → blocco con l'orario di Roma. */
function casoCircuitoAperto(v: VerdettoCoda): string[] {
  const e = v({
    installata: true,
    riga: rigaCoda({ circuito_aperto: true, circuito_fino_a: '2026-09-23T11:05:00Z' }),
  })
  if (e.ok) return ['circuito aperto lasciato passare']
  const f: string[] = []
  if (e.codice !== 'circuito-aperto') f.push(`codice ${e.codice}`)
  if (!e.messaggio?.includes('13:05')) f.push(`orario assente: ${e.messaggio}`)
  if (e.riprova_dopo?.toISOString() !== '2026-09-23T11:05:00.000Z') f.push('riprova_dopo sbagliato')
  return f
}

const MINUTI_BLOCCATI_D1 = [58, 59, 0, 2, 5, 28, 30, 35]
const MINUTI_LIBERI_D1 = [6, 27, 36, 57]

function casiFinestra(f: (m: number) => boolean): string[] {
  const fallimenti: string[] = []
  for (const m of MINUTI_BLOCCATI_D1) if (!f(m)) fallimenti.push(`:${m} lasciato passare`)
  for (const m of MINUTI_LIBERI_D1) if (f(m)) fallimenti.push(`:${m} bloccato`)
  return fallimenti
}

// ─── Il finto Aruba, fail-closed ───────────────────────────────────────────────
type Risposta = { status?: number; json?: unknown; testo?: string }
type Rotta = { metodo: string; percorso: string; risposte: Risposta[] }

let imprevisti: string[] = []
let richieste: { metodo: string; url: string; corpo?: string }[] = []

function installaArubaFinto(rotte: Rotta[]) {
  const code = rotte.map((r) => ({ ...r, risposte: [...r.risposte] }))
  const finto = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const metodo = (init?.method ?? 'GET').toUpperCase()
    richieste.push({ metodo, url, corpo: typeof init?.body === 'string' ? init.body : undefined })
    const u = new URL(url)
    const rotta = code.find((r) => r.metodo === metodo && `${u.origin}${u.pathname}` === r.percorso)
    const risposta = rotta?.risposte.shift()
    if (!rotta || !risposta) {
      imprevisti.push(`${metodo} ${u.origin}${u.pathname}`)
      throw new Error(`URL NON PREVISTO dal caso: ${metodo} ${u.origin}${u.pathname}`)
    }
    const status = risposta.status ?? 200
    const corpo = risposta.testo ?? JSON.stringify(risposta.json ?? {})
    return new Response(corpo, { status, headers: { 'Content-Type': risposta.testo ? 'text/html' : 'application/json' } })
  })
  vi.stubGlobal('fetch', finto)
  return finto
}

const SIGNIN = `${BASI_ARUBA.auth}/auth/signin`
const FIND = `${BASI_ARUBA.ws}/services/invoice/out/findByUsername`
const GET_FILE = `${BASI_ARUBA.ws}/services/invoice/out/getByFilename`
const CREDENZIALI = { username: 'utente.finto@example.test', password: 'finta-parola-di-prova' }
const NOME_FILE = 'IT01234567890_prova.xml.p7m'

function documentoFinto(i: number) {
  return {
    filename: `IT01234567890_${String(i).padStart(5, '0')}.xml.p7m`,
    creationDate: '2026-09-01T08:00:00Z',
    lastUpdate: '2026-09-01T08:05:00Z',
    signed: true,
    unsignedFile: 'Y29udGVudXRv',
    sender: { description: 'Persona Finta', fiscalCode: 'CF-ALFA-A' },
    receiver: { description: 'Altra Persona Finta', fiscalCode: 'CF-BETA-B' },
    invoices: [{ number: `Asilo ${i}/2026`, status: 'Consegnata', invoiceDate: '2026-09-01' }],
  }
}

function pagina(n: number, quanti: number, totale: number, extra: Record<string, unknown> = {}) {
  return {
    content: Array.from({ length: quanti }, (_, k) => documentoFinto((n - 1) * PAGINA_SIZE + k + 1)),
    errorCode: '0000',
    size: PAGINA_SIZE,
    totalElements: totale,
    last: quanti < PAGINA_SIZE,
    number: n - 1,
    ...extra,
  }
}

/** Una guardia sempre verde: una sola lettura, coda non installata, minuto 15. */
const sqlVerde = () => sqlFinta({ prima: [primaRiga()] })

function lettore(opz: { sql?: Sql; attese?: number[]; ora?: () => Date } = {}) {
  const attese = opz.attese ?? []
  return creaLettoreAruba({
    sql: opz.sql ?? sqlVerde().sql,
    credenziali: CREDENZIALI,
    attendi: async (ms: number) => {
      attese.push(ms)
    },
    ora: opz.ora ?? (() => new Date(ADESSO)),
  })
}

beforeEach(() => {
  imprevisti = []
  richieste = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  // Una chiamata a un URL che il caso non ha dichiarato fa fallire il test anche se il codice
  // sotto prova ha inghiottito l'errore.
  expect(imprevisti).toEqual([])
})

// ════════════════════════════════════════════════════════════════════════════════
describe('verdettoCodaPerScript (D1 §10.1)', () => {
  it('a) non installata → prosegue', () => {
    expect(casoNonInstallata(verdettoCodaPerScript)).toEqual([])
    expect(verdettoCodaPerScript({ installata: false })).toEqual({ ok: true })
  })

  it('b) una tabella sola → incoerente, blocco', () => {
    const e = verdettoCodaPerScript({ installata: 'incoerente' })
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('coda-incoerente')
  })

  it('c) 42P01 alla seconda lettura → vale «non installata», prosegue con nota', () => {
    const e = verdettoCodaPerScript({
      installata: true,
      errore: erroreSql('relation "public.fatture_coda_stato" does not exist', '42P01'),
    })
    expect(e.ok).toBe(true)
    expect(e.nota).toMatch(/42P01/)
    // Anche quando lo SQLSTATE sta solo nel testo della CLI.
    const daTesto = verdettoCodaPerScript({
      installata: true,
      errore: new Error('ERROR:  42P01: relation "public.aruba_cancello" does not exist'),
    })
    expect(daTesto.ok).toBe(true)
  })

  it('d) ogni altro errore (42501, timeout, CLI senza SQLSTATE, JSON illeggibile) → blocco', () => {
    expect(casiErroreBlocca(verdettoCodaPerScript)).toEqual([])
  })

  it('sospesa, circuito chiuso e cancello libero → ok', () => {
    expect(verdettoCodaPerScript({ installata: true, riga: rigaCoda() })).toEqual({ ok: true })
  })

  it('coda attiva (sospesa diversa da true) → blocco', () => {
    for (const sospesa of [false, null, undefined, 'true', 1]) {
      const e = verdettoCodaPerScript({ installata: true, riga: rigaCoda({ sospesa }) })
      expect(e.ok, `sospesa=${String(sospesa)}`).toBe(false)
      expect(e.codice).toBe('coda-attiva')
    }
    expect(verdettoCodaPerScript({ installata: true, riga: rigaCoda({ sospesa: false }) }).messaggio).toMatch(
      /sospenda la coda dalla pagina Coda fatture/,
    )
  })

  it('sospesa con circuito aperto → blocco col suo orario', () => {
    expect(casoCircuitoAperto(verdettoCodaPerScript)).toEqual([])
  })

  it('sospesa con circuito scaduto → ok', () => {
    const e = verdettoCodaPerScript({
      installata: true,
      riga: rigaCoda({ circuito_aperto: false, circuito_fino_a: '2026-09-23T08:00:00Z' }),
    })
    expect(e).toEqual({ ok: true })
  })

  it('cancello in prestito → blocco, col titolare solo se è coda o sync', () => {
    const e = verdettoCodaPerScript({ installata: true, riga: rigaCoda({ cancello_in_uso: true, titolare: 'sync' }) })
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('cancello-in-uso')
    expect(e.messaggio).toMatch(/in mano a sync/)
    const strano = verdettoCodaPerScript({
      installata: true,
      riga: rigaCoda({ cancello_in_uso: true, titolare: '<testo qualunque>' }),
    })
    expect(strano.messaggio).not.toContain('<testo qualunque>')
  })

  it('booleani letti in forma stretta: circuito o cancello non false → blocco', () => {
    expect(verdettoCodaPerScript({ installata: true, riga: rigaCoda({ circuito_aperto: null }) }).codice).toBe(
      'circuito-aperto',
    )
    expect(verdettoCodaPerScript({ installata: true, riga: rigaCoda({ cancello_in_uso: 'false' }) }).codice).toBe(
      'cancello-in-uso',
    )
  })

  it('righe diverse da 1 → blocco', () => {
    for (const righe of [0, 2, '2', null]) {
      const e = verdettoCodaPerScript({ installata: true, riga: rigaCoda({ righe }) })
      expect(e.ok, `righe=${String(righe)}`).toBe(false)
      expect(e.codice).toBe('coda-incoerente')
    }
    expect(verdettoCodaPerScript({ installata: true }).ok).toBe(false)
  })

  it('stato non determinato → blocco', () => {
    expect(verdettoCodaPerScript({ installata: undefined }).codice).toBe('lettura-fallita')
    expect(verdettoCodaPerScript({}).ok).toBe(false)
  })

  describe('controlli negativi eseguiti', () => {
    it('una guardia che blocca su to_regclass NULL fa diventare rosso a)', () => {
      const bloccaSeAssente: VerdettoCoda = (p) =>
        p.installata === false
          ? { ok: false, codice: 'coda-incoerente', messaggio: 'tabelle assenti' }
          : verdettoCodaPerScript(p as never)
      expect(casoNonInstallata(bloccaSeAssente)).not.toEqual([])
    })

    it('una guardia che tratta ogni errore come «non installata» fa diventare rosso d)', () => {
      const erroreComeAssente: VerdettoCoda = (p) =>
        p.errore ? verdettoCodaPerScript({ installata: false }) : verdettoCodaPerScript(p as never)
      expect(casiErroreBlocca(erroreComeAssente)).not.toEqual([])
      // …e il caso c) resta verde su quella variante: è d) che la distingue, non c).
    })

    it('senza il controllo del circuito lo script parte → rosso', () => {
      const senzaCircuito: VerdettoCoda = (p) => {
        const riga = p.riga && typeof p.riga === 'object' ? { ...(p.riga as object), circuito_aperto: false } : p.riga
        return verdettoCodaPerScript({ ...(p as object), riga } as never)
      }
      expect(casoCircuitoAperto(senzaCircuito)).not.toEqual([])
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('finestra della sync (D1 §10.2)', () => {
  it('bloccati :58 :59 :00 :02 :05 :28 :30 :35; liberi :06 :27 :36 :57', () => {
    expect(casiFinestra(minutoInFinestraSync)).toEqual([])
  })

  it('esattamente i 16 minuti 58-05 e 28-35, sui 60 del quadrante', () => {
    const bloccati = Array.from({ length: 60 }, (_, m) => m).filter((m) => minutoInFinestraSync(m))
    expect(bloccati).toEqual([0, 1, 2, 3, 4, 5, 28, 29, 30, 31, 32, 33, 34, 35, 58, 59])
    expect([...MINUTI_FINESTRA_SYNC].sort((a, b) => a - b)).toEqual(bloccati)
  })

  it('negativo: con la finestra della v5 (58-03 / 28-33) il caso :05 passa → rosso', () => {
    const v5 = (m: number) => [58, 59, 0, 1, 2, 3, 28, 29, 30, 31, 32, 33].includes(m)
    const fallimenti = casiFinestra(v5)
    expect(fallimenti).toContain(':5 lasciato passare')
    expect(fallimenti).toContain(':35 lasciato passare')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('verdettoAttivitaApp (D1 §10.3)', () => {
  it('n > 0 → blocco con l\'orario e +10\'', () => {
    const e = verdettoAttivitaApp({ n: 2, ultimo: '2026-09-23T10:11:00Z', adesso: ADESSO })
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('attivita-app')
    expect(e.messaggio).toBe("L'app ha parlato con Aruba alle 12:11: riprova dopo le 12:21.")
    expect(e.riprova_dopo?.toISOString()).toBe('2026-09-23T10:21:00.000Z')
  })

  it('n = 0 → ok (anche come stringa, come la restituisce la CLI per un bigint)', () => {
    expect(verdettoAttivitaApp({ n: 0, ultimo: null, adesso: ADESSO })).toEqual({ ok: true })
    expect(verdettoAttivitaApp({ n: '0', ultimo: null, adesso: ADESSO })).toEqual({ ok: true })
  })

  it('errore di lettura di app_log → blocco', () => {
    const e = verdettoAttivitaApp({ n: 0, errore: new Error('timeout'), adesso: ADESSO })
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('attivita-app')
  })

  it('conteggio illeggibile → blocco: «non so» non è «no»', () => {
    for (const n of [null, undefined, 'abc', -1, 1.5, Number.NaN]) {
      expect(verdettoAttivitaApp({ n, adesso: ADESSO }).ok, `n=${String(n)}`).toBe(false)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('messaggio429 (D1 §10.5)', () => {
  it('porta l\'orario del rifiuto e quello +60\', nell\'ora di Roma', () => {
    expect(messaggio429(new Date('2026-09-23T10:15:00Z'))).toBe(
      'Aruba ha risposto 429 alle 12:15. NON riprendere la coda, e non rilanciare script, prima delle 13:15.',
    )
    // Ora solare: a dicembre Roma è UTC+1.
    expect(messaggio429('2026-12-10T22:40:00Z')).toContain('alle 23:40')
    expect(messaggio429('2026-12-10T22:40:00Z')).toContain('prima delle 00:40')
  })

  it('oraRoma su un valore illeggibile non inventa un orario', () => {
    expect(oraRoma('non è una data')).toBe('??:??')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('guardiaArubaPerScript con una sql finta', () => {
  it('coda non installata e tutto libero → ok, con UNA sola lettura', async () => {
    const f = sqlFinta({ prima: [primaRiga()] })
    const e = (await guardiaArubaPerScript({ sql: f.sql })) as Esito
    expect(e.ok).toBe(true)
    expect(e.adesso?.toISOString()).toBe(ADESSO)
    expect(f.chiamate).toEqual(['prima'])
  })

  it('prima lettura fallita → blocco, e nessuna seconda lettura', async () => {
    const f = sqlFinta({ prima: erroreSql('uscita 1, senza SQLSTATE'), seconda: [rigaCoda()] })
    const e = (await guardiaArubaPerScript({ sql: f.sql })) as Esito
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('lettura-fallita')
    expect(f.chiamate).toEqual(['prima'])
  })

  it('errore di lettura di app_log (la prima lettura la contiene) → blocco', async () => {
    const e = await guardiaCon({ prima: erroreSql('permission denied for table app_log (SQLSTATE 42501)', '42501') })
    expect(e.ok).toBe(false)
    expect(e.codice).toBe('lettura-fallita')
    // …e anche un conteggio che non è un numero blocca, alla guardia dell'attività.
    const nullo = await guardiaCon({ prima: [primaRiga({ attivita_app: null })] })
    expect(nullo.codice).toBe('attivita-app')
  })

  it('prima lettura con forma inattesa → blocco', async () => {
    const casi: unknown[] = [
      [],
      [primaRiga(), primaRiga()],
      [primaRiga({ minuto: 60 })],
      [primaRiga({ minuto: null })],
      [primaRiga({ adesso: 'mai' })],
      [primaRiga({ stato: 'false' })],
      [primaRiga({ cancello: null })],
      { rows: [primaRiga()] },
    ]
    for (const prima of casi) {
      const e = await guardiaCon({ prima })
      expect(e.ok, JSON.stringify(prima).slice(0, 80)).toBe(false)
      expect(e.codice).toBe('lettura-fallita')
    }
  })

  it('una tabella sola → coda-incoerente, senza seconda lettura', async () => {
    for (const [stato, cancello] of [
      [true, false],
      [false, true],
    ]) {
      const f = sqlFinta({ prima: [primaRiga({ stato, cancello })], seconda: [rigaCoda()] })
      const e = (await guardiaArubaPerScript({ sql: f.sql })) as Esito
      expect(e.codice).toBe('coda-incoerente')
      expect(f.chiamate).toEqual(['prima'])
    }
  })

  it('coda installata: seconda lettura, e sospesa + libero → ok', async () => {
    const f = sqlFinta({ prima: [primaRiga({ stato: true, cancello: true })], seconda: [rigaCoda()] })
    const e = (await guardiaArubaPerScript({ sql: f.sql })) as Esito
    expect(e.ok).toBe(true)
    expect(f.chiamate).toEqual(['prima', 'seconda'])
  })

  it('c) 42P01 alla seconda lettura → prosegue con nota', async () => {
    const e = await guardiaCon({
      prima: [primaRiga({ stato: true, cancello: true })],
      seconda: erroreSql('relation "public.aruba_cancello" does not exist (SQLSTATE 42P01)', '42P01'),
    })
    expect(e.ok).toBe(true)
    expect(e.nota).toMatch(/non installata/)
  })

  it('d) 42501 o errore senza SQLSTATE alla seconda lettura → blocco', async () => {
    for (const seconda of [
      erroreSql('permission denied (SQLSTATE 42501)', '42501'),
      erroreSql('supabase db query: uscita 1, senza SQLSTATE'),
      { non: 'una tabella' },
    ]) {
      const e = await guardiaCon({ prima: [primaRiga({ stato: true, cancello: true })], seconda })
      expect(e.ok).toBe(false)
      expect(e.codice).toBe('lettura-fallita')
    }
  })

  it('seconda lettura con zero righe (tabella vuota) → coda-incoerente', async () => {
    const e = await guardiaCon({ prima: [primaRiga({ stato: true, cancello: true })], seconda: [] })
    expect(e.codice).toBe('coda-incoerente')
  })

  it('finestra della sync dall\'orologio del DB → blocco con l\'orario d\'uscita', async () => {
    const e = await guardiaCon({ prima: [primaRiga({ minuto: 2, adesso: '2026-09-23T10:02:40Z' })] })
    expect(e.codice).toBe('finestra-sync')
    expect(e.riprova_dopo?.toISOString()).toBe('2026-09-23T10:06:00.000Z')
    expect(e.messaggio).toMatch(/12:06/)
    const tardi = await guardiaCon({ prima: [primaRiga({ minuto: 58, adesso: '2026-09-23T09:58:10Z' })] })
    expect(tardi.riprova_dopo?.toISOString()).toBe('2026-09-23T10:06:00.000Z')
  })

  it('attività dell\'app negli ultimi 10\' → blocco', async () => {
    const e = await guardiaCon({ prima: [primaRiga({ attivita_app: '3', ultima_attivita: '2026-09-23T10:12:00Z' })] })
    expect(e.codice).toBe('attivita-app')
    expect(e.messaggio).toMatch(/alle 12:12: riprova dopo le 12:22/)
  })

  it('l\'ordine delle guardie: lettura, coda, circuito, cancello, finestra, attività', async () => {
    const tuttoRosso = { minuto: 0, attivita_app: 5, ultima_attivita: ADESSO }
    const installata = { ...tuttoRosso, stato: true, cancello: true }
    const casi: [unknown, unknown, string][] = [
      [erroreSql('boom'), [rigaCoda({ sospesa: false })], 'lettura-fallita'],
      [[primaRiga({ ...tuttoRosso, stato: true, cancello: false })], undefined, 'coda-incoerente'],
      [[primaRiga(installata)], [rigaCoda({ sospesa: false, circuito_aperto: true, cancello_in_uso: true })], 'coda-attiva'],
      [[primaRiga(installata)], [rigaCoda({ circuito_aperto: true, cancello_in_uso: true })], 'circuito-aperto'],
      [[primaRiga(installata)], [rigaCoda({ cancello_in_uso: true })], 'cancello-in-uso'],
      [[primaRiga(installata)], [rigaCoda()], 'finestra-sync'],
      [[primaRiga({ ...installata, minuto: 15 })], [rigaCoda()], 'attivita-app'],
    ]
    const visti: string[] = []
    for (const [prima, seconda, atteso] of casi) {
      const e = await guardiaCon({ prima, seconda })
      expect(e.codice, atteso).toBe(atteso)
      visti.push(e.codice as string)
    }
    expect(visti).toEqual(CODICI_GUARDIA)
  })

  it('senza una funzione sql → blocco, non un\'eccezione', async () => {
    const e = (await guardiaArubaPerScript({} as never)) as Esito
    expect(e.codice).toBe('lettura-fallita')
  })

  it('le due query: to_regclass su entrambe le tabelle, 10 minuti di app_log, righe contate', () => {
    expect(SQL_PRIMA_LETTURA).toContain("to_regclass('public.fatture_coda_stato')")
    expect(SQL_PRIMA_LETTURA).toContain("to_regclass('public.aruba_cancello')")
    expect(SQL_PRIMA_LETTURA).toContain("interval '10 minutes'")
    expect(SQL_PRIMA_LETTURA).toContain("like 'emettiFatturaPagamento:%'")
    expect(SQL_PRIMA_LETTURA).toContain("= 'emettiFatturaPagamento'")
    // Il tempo si legge dall'ULTIMA occorrenza della riga deduplicata, mai dalla prima.
    expect(SQL_PRIMA_LETTURA).toContain("visto_l_ultima > now() - interval '10 minutes'")
    expect(SQL_PRIMA_LETTURA).toContain('max(visto_l_ultima)')
    expect(SQL_PRIMA_LETTURA).not.toContain('creato_il')
    expect(SQL_PRIMA_LETTURA).toContain('extract(minute from now())')
    // La prima lettura non tocca le tabelle della coda: se non esistono, fallirebbe.
    expect(SQL_PRIMA_LETTURA).not.toMatch(/from public\.(fatture_coda_stato|aruba_cancello)/)
    expect(SQL_SECONDA_LETTURA).toContain('count(*) over () as righe')
    expect(SQL_SECONDA_LETTURA).toContain('cross join public.aruba_cancello')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
/**
 * La prima lettura ESEGUITA su un Postgres vero (PGlite), non solo letta come testo.
 *
 * `app_log` deduplica per (fingerprint, giorno): `app_log_registra` fa `ON CONFLICT … SET
 * occorrenze + n, visto_l_ultima = now()` e lascia `creato_il` alla prima occorrenza del
 * giorno. Il battito `aruba:upload` delle 8 di mattina viene quindi RIUSATO da ogni upload
 * successivo: una guardia su `creato_il` lo vede vecchio di ore mentre l'app sta caricando
 * adesso. E la riga di successo dell'emissione ha `operazione = 'emettiFatturaPagamento'`
 * senza i due punti. Qui le due righe hanno la forma che hanno in produzione.
 */
describe('SQL_PRIMA_LETTURA eseguita su PGlite (attività dell\'app, D1 §10.3)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    // Solo le colonne che la lettura tocca, coi default della migrazione 20260713090000.
    await db.exec(`create table public.app_log (
      id serial primary key,
      creato_il timestamptz not null default now(),
      visto_l_ultima timestamptz not null default now(),
      evento text not null,
      contesto jsonb not null default '{}'::jsonb
    )`)
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.exec('truncate public.app_log')
  })

  type RigaPrima = { attivita_app: number | string; ultima_attivita: Date | null; stato: boolean; cancello: boolean }
  async function primaLettura(testo: string = SQL_PRIMA_LETTURA): Promise<RigaPrima> {
    const r = await db.query<RigaPrima>(testo)
    return r.rows[0]
  }

  /** Il battito di externalFetch: nato 4 ore fa, ripresentatosi 2 minuti fa. */
  async function battitoUploadRiusato() {
    await db.exec(`insert into public.app_log (creato_il, visto_l_ultima, evento, contesto)
      values (now() - interval '4 hours', now() - interval '2 minutes', 'fattura',
              '{"campi":{"operazione":"aruba:upload","provider":"aruba","stato":200}}')`)
  }

  /** La riga di successo dell'emissione: nuova, 2 minuti fa, operazione SENZA i due punti. */
  async function emissioneNuova() {
    await db.exec(`insert into public.app_log (creato_il, visto_l_ultima, evento, contesto)
      values (now() - interval '2 minutes', now() - interval '2 minutes', 'fattura',
              '{"campi":{"operazione":"emettiFatturaPagamento","esito":"inviata","provider":"aruba"}}')`)
  }

  async function massimoVisto(): Promise<number> {
    const r = await db.query<{ m: Date }>('select max(visto_l_ultima) as m from public.app_log')
    return r.rows[0].m.getTime()
  }

  it('la coda non c\'è: to_regclass dà false su entrambe le tabelle, la lettura non fallisce', async () => {
    const r = await primaLettura()
    expect(r.stato).toBe(false)
    expect(r.cancello).toBe(false)
    expect(Number(r.attivita_app)).toBe(0)
    expect(r.ultima_attivita).toBeNull()
  })

  it('battito aruba:upload riusato (prima occorrenza 4h fa, ultima 2\' fa) → attività vista', async () => {
    await battitoUploadRiusato()
    const r = await primaLettura()
    expect(Number(r.attivita_app)).toBeGreaterThanOrEqual(1)
    expect(r.ultima_attivita).not.toBeNull()
    expect((r.ultima_attivita as Date).getTime()).toBe(await massimoVisto())
  })

  it('riga nuova emettiFatturaPagamento senza i due punti → attività vista', async () => {
    await emissioneNuova()
    const r = await primaLettura()
    expect(Number(r.attivita_app)).toBe(1)
    expect((r.ultima_attivita as Date).getTime()).toBe(await massimoVisto())
  })

  it('le due righe insieme → 2, e ultima_attivita è il visto_l_ultima più recente', async () => {
    await battitoUploadRiusato()
    await emissioneNuova()
    const r = await primaLettura()
    expect(Number(r.attivita_app)).toBe(2)
    expect((r.ultima_attivita as Date).getTime()).toBe(await massimoVisto())
  })

  it('fuori dalla finestra, altro evento o altra operazione → 0', async () => {
    await db.exec(`insert into public.app_log (creato_il, visto_l_ultima, evento, contesto) values
      (now() - interval '5 hours', now() - interval '11 minutes', 'fattura', '{"campi":{"operazione":"aruba:upload"}}'),
      (now() - interval '1 minute', now() - interval '1 minute', 'esterno', '{"campi":{"operazione":"aruba:upload"}}'),
      (now() - interval '1 minute', now() - interval '1 minute', 'fattura', '{"campi":{"operazione":"emettiFatturaPagamentoAltro"}}')`)
    const r = await primaLettura()
    expect(Number(r.attivita_app)).toBe(0)
    expect(r.ultima_attivita).toBeNull()
  })

  it('controllo negativo ESEGUITO: la stessa lettura su creato_il non vede né l\'upload riusato né l\'emissione', async () => {
    // La variante rotta: il tempo dalla PRIMA occorrenza e il solo `like` coi due punti.
    const rotta = SQL_PRIMA_LETTURA.replaceAll('visto_l_ultima', 'creato_il').replace(
      /\n\s*or contesto->'campi'->>'operazione' = 'emettiFatturaPagamento'/g,
      '',
    )
    expect(rotta).not.toBe(SQL_PRIMA_LETTURA)
    expect(rotta).not.toContain("= 'emettiFatturaPagamento'")
    await battitoUploadRiusato()
    expect(Number((await primaLettura(rotta)).attivita_app)).toBe(0)
    await emissioneNuova()
    expect(Number((await primaLettura(rotta)).attivita_app)).toBe(0)
    // Ciascun difetto da solo basta a far fallire aperta la guardia.
    const soloCreato = SQL_PRIMA_LETTURA.replaceAll('visto_l_ultima', 'creato_il')
    await db.exec('truncate public.app_log')
    await battitoUploadRiusato()
    expect(Number((await primaLettura(soloCreato)).attivita_app)).toBe(0)
    const senzaUguale = SQL_PRIMA_LETTURA.replace(
      /\n\s*or contesto->'campi'->>'operazione' = 'emettiFatturaPagamento'/g,
      '',
    )
    await db.exec('truncate public.app_log')
    await emissioneNuova()
    expect(Number((await primaLettura(senzaUguale)).attivita_app)).toBe(0)
    // Controllo positivo: una riga NUOVA aruba:signin di 2' fa la vede anche la variante rotta.
    await db.exec(`insert into public.app_log (creato_il, visto_l_ultima, evento, contesto)
      values (now() - interval '2 minutes', now() - interval '2 minutes', 'fattura',
              '{"campi":{"operazione":"aruba:signin"}}')`)
    expect(Number((await primaLettura(rotta)).attivita_app)).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('sqlstateDi', () => {
  it('legge la proprietà e le tre forme testuali, mai il code di Node', () => {
    expect(sqlstateDi(erroreSql('x', '42501'))).toBe('42501')
    expect(sqlstateDi(new Error('relation "x" does not exist (SQLSTATE 42P01)'))).toBe('42P01')
    expect(sqlstateDi(new Error('Failed to run sql query: ERROR:  42P01: relation "x" does not exist'))).toBe('42P01')
    expect(sqlstateDi(new Error('{"code":"42501","message":"permission denied"}'))).toBe('42501')
    const timeout = Object.assign(new Error('spawnSync supabase ETIMEDOUT'), { code: 'ETIMEDOUT' })
    expect(sqlstateDi(timeout)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('sqlDaCliSupabase ed eseguiFiglio: argomenti in array, mai una shell', () => {
  it('chiama supabase db query --linked con gli argomenti in array e legge { rows }', async () => {
    const chiamate: { cmd: string; args: unknown; opzioni: Record<string, unknown> }[] = []
    const esegui = vi.fn((cmd: string, args: unknown, opzioni: Record<string, unknown>) => {
      chiamate.push({ cmd, args, opzioni })
      return JSON.stringify({ rows: [{ uno: 1 }] })
    })
    const sql = sqlDaCliSupabase({ esegui: esegui as never })
    await expect(sql('select 1 as uno')).resolves.toEqual([{ uno: 1 }])
    expect(chiamate[0].cmd).toBe('supabase')
    expect(chiamate[0].args).toEqual(['db', 'query', '--linked', '--agent', 'no', '-o', 'json', 'select 1 as uno'])
    expect(chiamate[0].opzioni.shell).toBe(false)
    expect(chiamate[0].opzioni.cwd).toBe(RADICE_REPO)
  })

  it('un array nudo vale come le righe', () => {
    expect(righeDaJsonCli('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  it('JSON illeggibile o senza righe → errore senza SQLSTATE (quindi blocco)', () => {
    expect(() => righeDaJsonCli('Tabella formattata, non JSON')).toThrow(/JSON illeggibile/)
    expect(() => righeDaJsonCli('{"error":"x"}')).toThrow(/senza righe/)
  })

  it('uscita diversa da 0: lo SQLSTATE si porta nell\'errore se la CLI lo dice', async () => {
    const conStato = sqlDaCliSupabase({
      esegui: (() => {
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'ERROR: relation "public.aruba_cancello" does not exist (SQLSTATE 42P01)',
        })
      }) as never,
    })
    await expect(conStato('select 1')).rejects.toMatchObject({ sqlstate: '42P01', uscita: 1 })

    const senzaStato = sqlDaCliSupabase({
      esegui: (() => {
        throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'failed to connect' })
      }) as never,
    })
    const err = await senzaStato('select 1').catch((e: unknown) => e)
    expect(err).toMatchObject({ sqlstate: null, uscita: 1 })
    expect(verdettoCodaPerScript({ installata: true, errore: err }).codice).toBe('lettura-fallita')
  })

  it('eseguiFiglio rifiuta gli argomenti in una stringa sola', () => {
    const esegui = vi.fn()
    expect(() => eseguiFiglio('git', 'diff --quiet a b' as never, {}, esegui as never)).toThrow(/array/)
    expect(() => eseguiFiglio('git diff', ['--quiet'], {}, esegui as never)).toThrow(/senza spazi/)
    expect(esegui).not.toHaveBeenCalled()
    eseguiFiglio('git', ['status'], { shell: true } as never, esegui as never)
    expect(esegui).toHaveBeenCalledWith('git', ['status'], { shell: false })
  })

  it('nel sorgente del modulo nessun execSync, spawn con shell o exec a stringa', () => {
    const sorgente = readFileSync(resolve(RADICE_REPO, 'scripts/lib/aruba-lettura.mjs'), 'utf8')
    // Da node:child_process si importa SOLO execFileSync.
    const importazioni = [...sorgente.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)]
    expect(importazioni.map((m) => m[1].trim())).toEqual(['execFileSync'])
    expect(sorgente).not.toMatch(/\bexecSync\b|\bspawnSync\b|\bspawn\(|(?<![.\w])exec\(|shell:\s*true/)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('--out fuori dal repository', () => {
  it('fuoriDalRepository confronta percorsi risolti, non sottostringhe', () => {
    expect(fuoriDalRepository(RADICE_REPO)).toBe(false)
    expect(fuoriDalRepository(join(RADICE_REPO, 'docs', 'nuova-cartella'))).toBe(false)
    expect(fuoriDalRepository(join(RADICE_REPO, 'x', '..', '..', 'altrove'))).toBe(true)
    expect(fuoriDalRepository(`${RADICE_REPO}-aruba`)).toBe(true)
    expect(fuoriDalRepository(join(tmpdir(), 'kidville-web', 'out'))).toBe(true)
    expect(fuoriDalRepository('')).toBe(false)
  })

  it('rifiutaOutNelRepository lancia FermoAruba dentro il repo o senza --out', () => {
    expect(() => rifiutaOutNelRepository(join(RADICE_REPO, 'out'))).toThrow(FermoAruba)
    expect(() => rifiutaOutNelRepository(undefined as never)).toThrow(/--out/)
    expect(rifiutaOutNelRepository(join(tmpdir(), 'fuori'))).not.toContain(RADICE_REPO + '/')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('credenziali', () => {
  it('dall\'ambiente, senza toccare process.env', () => {
    expect(
      leggiCredenzialiAruba({ env: { ARUBA_USERNAME: 'u', ARUBA_PASSWORD: 'p' }, fileEnvLocale: '/non/esiste' }),
    ).toEqual({ username: 'u', password: 'p' })
    expect(leggiCredenzialiAruba({ env: {}, fileEnvLocale: '/non/esiste' })).toBeNull()
  })

  it('da un .env.local, se l\'ambiente non le ha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-'))
    try {
      const file = join(dir, '.env.local')
      writeFileSync(file, 'ALTRO=1\nARUBA_USERNAME="utente.finto@example.test"\nARUBA_PASSWORD=finta\n')
      expect(leggiCredenzialiAruba({ env: {}, fileEnvLocale: file })).toEqual({
        username: 'utente.finto@example.test',
        password: 'finta',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('il lettore di Aruba, col finto fail-closed', () => {
  it('un URL non previsto dal caso fa fallire la chiamata (e il test)', async () => {
    installaArubaFinto([])
    await expect(fetch(`${BASI_ARUBA.ws}/services/invoice/out/upload`, { method: 'POST' })).rejects.toThrow(
      /URL NON PREVISTO/,
    )
    await expect(fetch('https://example.test/qualunque')).rejects.toThrow(/URL NON PREVISTO/)
    expect(imprevisti).toHaveLength(2)
    imprevisti = [] // qui gli imprevisti erano il punto del caso
  })

  it('una chiamata del lettore che il caso non ha dichiarato lancia, senza risposta inventata', async () => {
    installaArubaFinto([{ metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] }])
    const l = lettore()
    await l.signin()
    await expect(l.getByFilename(NOME_FILE)).rejects.toThrow(/URL NON PREVISTO/)
    expect(imprevisti).toEqual([`GET ${GET_FILE}`])
    imprevisti = []
  })

  it('signin: form con grant_type=password, token tenuto dentro', async () => {
    installaArubaFinto([{ metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok-1' } }] }])
    const l = lettore()
    await expect(l.signin()).resolves.toBeUndefined()
    const corpo = new URLSearchParams(richieste[0].corpo)
    expect(corpo.get('grant_type')).toBe('password')
    expect(corpo.get('username')).toBe(CREDENZIALI.username)
  })

  it('signin senza token → fermo', async () => {
    installaArubaFinto([{ metodo: 'POST', percorso: SIGNIN, risposte: [{ json: {} }] }])
    await expect(lettore().signin()).rejects.toMatchObject({ codice: 'aruba-signin-senza-token' })
  })

  it('scorrimento su due pagine: 5000 ms fra due chiamate, guardia prima di ognuna, documenti ridotti', async () => {
    const totale = PAGINA_SIZE + 3
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ json: pagina(1, PAGINA_SIZE, totale) }, { json: pagina(2, 3, totale) }] },
    ])
    const f = sqlVerde()
    const attese: number[] = []
    const l = lettore({ sql: f.sql, attese })
    await l.signin()
    const { documenti, totale: t, pagine } = await l.scorriDocumenti({ anno: 2026 })
    expect(t).toBe(totale)
    expect(pagine).toBe(2)
    expect(documenti).toHaveLength(totale)
    // Tre chiamate, tre guardie, due pause (nessuna prima della prima).
    expect(richieste).toHaveLength(3)
    expect(f.chiamate).toEqual(['prima', 'prima', 'prima'])
    expect(attese).toEqual([PAUSA_MS, PAUSA_MS])
    expect(PAUSA_MS).toBe(5000)
    // La richiesta chiede la pagina giusta con la size misurata.
    const u = new URL(richieste[2].url)
    expect(u.searchParams.get('page')).toBe('2')
    expect(u.searchParams.get('size')).toBe(String(PAGINA_SIZE))
    expect(u.searchParams.get('startDate')).toBe('2026-01-01')
    // sender e receiver non escono dal modulo.
    expect(JSON.stringify(documenti)).not.toMatch(/fiscalCode|Persona Finta|CF-ALFA|CF-BETA/)
    expect(documenti[0]).toEqual({
      filename: 'IT01234567890_00001.xml.p7m',
      creationDate: '2026-09-01T08:00:00Z',
      lastUpdate: '2026-09-01T08:05:00Z',
      signed: true,
      unsignedFile: true,
      fatture: [{ numero: 'Asilo 1/2026', stato: 'Consegnata', data: '2026-09-01' }],
    })
  })

  it('involucro: errorCode diverso da 0000 → fermo', async () => {
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ json: { content: [], errorCode: '0001', size: 0 } }] },
    ])
    const l = lettore()
    await l.signin()
    await expect(l.scorriDocumenti({ anno: 2026 })).rejects.toMatchObject({ codice: 'involucro-errore' })
  })

  it('involucro: size echeggiata diversa da quella chiesta → fermo', async () => {
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ json: pagina(1, 3, 3, { size: 500 }) }] },
    ])
    const l = lettore()
    await l.signin()
    await expect(l.scorriDocumenti({ anno: 2026 })).rejects.toMatchObject({ codice: 'size-tappata' })
  })

  it('involucro: meno documenti di totalElements → fermo (scorrimento incompleto)', async () => {
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ json: pagina(1, 3, 10, { last: true }) }] },
    ])
    const l = lettore()
    await l.signin()
    await expect(l.scorriDocumenti({ anno: 2026 })).rejects.toMatchObject({ codice: 'scorrimento-incompleto' })
  })

  it('senza signin non si scorre, e non parte nessuna richiesta verso findByUsername', async () => {
    installaArubaFinto([])
    await expect(lettore().scorriDocumenti({ anno: 2026 })).rejects.toMatchObject({ codice: 'senza-signin' })
    expect(richieste).toHaveLength(0)
  })

  it('stop al primo 429: messaggio con l\'orario +60\', e ogni chiamata dopo lancia senza rete', async () => {
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ status: 429, testo: '<html>Too Many Requests</html>' }] },
    ])
    const l = lettore({ ora: () => new Date('2026-09-23T10:15:00Z') })
    await l.signin()
    const err = await l.scorriDocumenti({ anno: 2026 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FermoAruba)
    expect(err).toMatchObject({ codice: 'aruba-429', uscita: 1 })
    expect((err as Error).message).toBe(messaggio429(new Date('2026-09-23T10:15:00Z')))
    expect((err as InstanceType<typeof FermoAruba>).riprova_dopo.toISOString()).toBe('2026-09-23T11:15:00.000Z')
    const prima = richieste.length
    await expect(l.getByFilename(NOME_FILE)).rejects.toBe(err)
    expect(richieste.length).toBe(prima)
  })

  it('guardia che blocca → nessuna richiesta ad Aruba, e il lettore resta fermo', async () => {
    installaArubaFinto([])
    const f = sqlFinta({ prima: [primaRiga({ stato: true, cancello: true })], seconda: [rigaCoda({ sospesa: false })] })
    const l = lettore({ sql: f.sql })
    await expect(l.signin()).rejects.toMatchObject({ codice: 'coda-attiva', uscita: 1 })
    await expect(l.signin()).rejects.toMatchObject({ codice: 'coda-attiva' })
    expect(richieste).toHaveLength(0)
    expect(f.chiamate).toEqual(['prima', 'seconda'])
  })

  it('la guardia si rivaluta prima di OGNI chiamata: se cambia a metà, la chiamata dopo non parte', async () => {
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      { metodo: 'GET', percorso: FIND, risposte: [{ json: pagina(1, PAGINA_SIZE, PAGINA_SIZE + 1) }] },
    ])
    let n = 0
    const sql: Sql = async (testo) => {
      expect(testo).toBe(SQL_PRIMA_LETTURA)
      n++
      // Alla terza guardia l'app ha appena parlato con Aruba.
      return [primaRiga(n >= 3 ? { attivita_app: 1, ultima_attivita: ADESSO } : {})]
    }
    const l = lettore({ sql })
    await l.signin()
    await expect(l.scorriDocumenti({ anno: 2026 })).rejects.toMatchObject({ codice: 'attivita-app' })
    expect(richieste).toHaveLength(2)
  })

  it('getByFilename: base64 da file ?? dataFile ?? fileContent, fatture ridotte', async () => {
    const contenuto = Buffer.from('involucro-firmato-finto')
    installaArubaFinto([
      { metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] },
      {
        metodo: 'GET',
        percorso: GET_FILE,
        risposte: [
          { json: { dataFile: contenuto.toString('base64'), invoices: [{ number: 'FPR 7/26', status: 'Consegnata', receiver: { fiscalCode: 'X' } }] } },
          { json: { value: { fileContent: contenuto.toString('base64') } } },
          { json: { errorCode: '0000', filename: NOME_FILE } },
        ],
      },
    ])
    const l = lettore()
    await l.signin()
    const uno = await l.getByFilename(NOME_FILE)
    expect(uno.contenuto.equals(contenuto)).toBe(true)
    expect(uno.fatture).toEqual([{ numero: 'FPR 7/26', stato: 'Consegnata', data: null }])
    const u = new URL(richieste[1].url)
    expect(u.searchParams.get('filename')).toBe(NOME_FILE)
    expect(u.searchParams.get('includeFile')).toBe('true')
    expect(u.searchParams.get('includePdf')).toBe('false')
    expect((await l.getByFilename(NOME_FILE)).contenuto.equals(contenuto)).toBe(true)
    await expect(l.getByFilename(NOME_FILE)).rejects.toMatchObject({ codice: 'aruba-senza-contenuto' })
  })

  it('getByFilename rifiuta un nome file fuori forma prima di chiamare', async () => {
    installaArubaFinto([{ metodo: 'POST', percorso: SIGNIN, risposte: [{ json: { access_token: 'tok' } }] }])
    const l = lettore()
    await l.signin()
    await expect(l.getByFilename('../../etc/passwd')).rejects.toMatchObject({ codice: 'nome-file-non-valido' })
    expect(richieste).toHaveLength(1)
  })

  it('HTTP diverso da 2xx e da 429 → fermo col corpo della risposta', async () => {
    installaArubaFinto([{ metodo: 'POST', percorso: SIGNIN, risposte: [{ status: 401, json: { error: 'invalid_grant' } }] }])
    const err = await lettore().signin().catch((e: unknown) => e)
    expect(err).toMatchObject({ codice: 'aruba-http' })
    expect((err as Error).message).toMatch(/HTTP 401: .*invalid_grant/)
    expect((err as Error).message).not.toContain(CREDENZIALI.password)
  })

  it('senza credenziali il lettore non nasce', () => {
    expect(() => creaLettoreAruba({ sql: sqlVerde().sql, credenziali: null as never })).toThrow(/ARUBA_USERNAME/)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('riduciDocumento', () => {
  it('tiene solo i campi dichiarati, e mai oggetti annidati nei campi primitivi', () => {
    const r = riduciDocumento({
      filename: NOME_FILE,
      sender: { fiscalCode: 'X' },
      invoices: [{ number: { nascosto: 'oggetto' }, status: 3 }],
    })
    expect(r).toEqual({
      filename: NOME_FILE,
      creationDate: null,
      lastUpdate: null,
      signed: false,
      unsignedFile: false,
      fatture: [{ numero: null, stato: 3, data: null }],
    })
    expect(riduciDocumento(null)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('estraiXmlDaP7m: openssl cms -verify -noverify', () => {
  it('passa gli argomenti in array, e la cartella deve stare fuori dal repo', () => {
    const esegui = vi.fn<(cmd: string, args: string[]) => Buffer>(() =>
      Buffer.from('<?xml version="1.0"?><p:FatturaElettronica versione="FPR12"/>'),
    )
    const dir = mkdtempSync(join(tmpdir(), 'p7m-test-'))
    try {
      const xml = estraiXmlDaP7m(Buffer.from([0x30, 0x80]), { cartella: dir, esegui: esegui as never })
      expect(xml).toContain('FatturaElettronica')
      const [cmd, args] = esegui.mock.calls[0]
      expect(cmd).toBe('openssl')
      expect(args.slice(0, 5)).toEqual(['cms', '-verify', '-noverify', '-inform', 'DER'])
      // Il file temporaneo non resta.
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(() => estraiXmlDaP7m(Buffer.from([1]), { cartella: join(RADICE_REPO, 'tmp'), esegui: esegui as never })).toThrow(
      FermoAruba,
    )
  })

  it('un\'uscita senza FatturaElettronica → fermo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p7m-test-'))
    try {
      expect(() =>
        estraiXmlDaP7m(Buffer.from([1]), { cartella: dir, esegui: (() => Buffer.from('<altro/>')) as never }),
      ).toThrow(/FatturaElettronica/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const opensslCms = (() => {
    try {
      execFileSync('openssl', ['cms', '-help'], { stdio: 'ignore' })
      return true
    } catch {
      return false // openssl senza cms: il caso vero qui sotto si salta, gli altri restano
    }
  })()

  it.skipIf(!opensslCms)('con openssl vero: firma un XML sintetico e lo estrae intatto', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p7m-vero-'))
    try {
      const chiave = join(dir, 'chiave.pem')
      const cert = join(dir, 'cert.pem')
      const xmlFile = join(dir, 'fattura.xml')
      const p7m = join(dir, 'fattura.xml.p7m')
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica versione="FPR12"><Numero>Asilo 1/2026</Numero></p:FatturaElettronica>\n'
      writeFileSync(xmlFile, xml)
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=prova', '-days', '1', '-keyout', chiave, '-out', cert], { stdio: 'ignore' })
      execFileSync('openssl', ['cms', '-sign', '-nodetach', '-binary', '-outform', 'DER', '-in', xmlFile, '-signer', cert, '-inkey', chiave, '-out', p7m], { stdio: 'ignore' })
      expect(existsSync(p7m)).toBe(true)
      const estratto = estraiXmlDaP7m(readFileSync(p7m), { cartella: dir })
      expect(estratto).toBe(xml)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
