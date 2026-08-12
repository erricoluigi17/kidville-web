import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataCivile } from '@/i18n/config'
import { aggiungiGiorni } from '@/lib/anagrafica/scadenze'

// =============================================================================
// POST /api/notifiche/scadenze-documenti — L'ALLARME DI SCADENZA DEI DOCUMENTI
// DEL PERSONALE, e i quattro difetti reali che questo file impedisce.
//
//  1. IL BATTITO CHE MANCA PROPRIO QUANDO NON SUCCEDE NIENTE. La condizione
//     NORMALE di questo lavoro è non mandare niente: quasi ogni notte nessun
//     documento attraversa una soglia. Un job che tacesse a zero righe sarebbe
//     indistinguibile, per mesi, da un job che non parte più — e la prova del
//     guasto arriverebbe il giorno in cui si scopre che una maestra lavora da tre
//     mesi con un documento scaduto. Il battito si scrive in un `finally`.
//
//  2. IL 500 SUL DATABASE DELLA CI. Quel progetto non è migrato e
//     `anagrafica_personale` lì non esiste: un guasto rosso a ogni giro
//     insegnerebbe a ignorare l'unico allarme che questo job possiede. Tabella
//     assente ⇒ scansione SALTATA, `ok-parziale`, 200 — e il nome di ciò che non
//     si è guardato, perché «zero righe» e «non ho guardato» si leggono uguali.
//
//  3. I DATI PERSONALI NEI LOG. Questa tabella contiene codici fiscali,
//     residenze, numeri di documento e il percorso della scansione di una carta
//     d'identità; `app_log` è interrogabile in SQL per 30 giorni. Da qui escono
//     uuid, conteggi e codici d'errore. Nient'altro.
//
//  4. LA RAFFICA. Una soglia già annunciata che riparte ogni notte è il modo più
//     rapido di far ignorare l'avviso a chi lo riceve — «un allarme quotidiano si
//     impara a ignorare» è scritto nella migrazione che ha creato le due colonne
//     di stato. La seconda esecuzione non deve mandare niente.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-scadenze-documenti-non-usato-altrove'

/** Il giorno civile italiano: lo stesso che usa la route. */
const OGGI = dataCivile()
const fra = (giorni: number) => aggiungiGiorni(OGGI, giorni)

const UTENTE_1 = '11111111-1111-4111-8111-111111111111'
const UTENTE_2 = '22222222-2222-4222-8222-222222222222'
const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEGRETARIA = '33333333-3333-4333-8333-333333333333'

/**
 * I dati «personali» del caso di prova. Sono inventati (il repository è
 * PUBBLICO), ma hanno la forma di quelli veri: è ciò che permette di cercarli
 * dentro i log e dimostrare che non ci sono.
 */
const NOME = 'Marilena'
const COGNOME = 'Esposito'
const EMAIL = 'marilena.esposito@example.invalid'
const EMAIL_SEGRETERIA = 'segreteria@example.invalid'
const CODICE_FISCALE = 'SPSMLN80A41H501U'
const NUMERO_DOCUMENTO = 'AB1234567'

const h = vi.hoisted(() => ({
  eventi: [] as {
    evento: string
    livello: string
    campi: Record<string, unknown>
    opzioni?: { distingui?: readonly string[] }
  }[],
  /**
   * Le colonne chieste a ogni `select`, per tabella: dice cosa la route LEGGE.
   * `conteggio` distingue la lettura vera dalla `head`-query che conta e basta —
   * sulla stessa tabella, con la stessa `from`, e con una WHERE opposta.
   */
  select: [] as { tabella: string; colonne: string; conteggio: boolean }[],
  /** Gli argomenti delle clausole: senza, la WHERE sarebbe invisibile alla suite. */
  clausole: [] as { tabella: string; metodo: string; argomenti: unknown[]; conteggio: boolean }[],
  anagrafiche: [] as Record<string, unknown>[],
  erroreAnagrafiche: null as unknown,
  /** Quante anagrafiche in servizio NON hanno la data di scadenza. */
  senzaScadenza: 0 as number | null,
  erroreSenzaScadenza: null as unknown,
  utenti: [] as Record<string, unknown>[],
  erroreUtenti: null as unknown,
  staff: [] as Record<string, unknown>[],
  erroreStaff: null as unknown,
  erroreUpdate: null as unknown,
  update: [] as { valori: Record<string, unknown>; ids: string[] }[],
  segreteriaDiSede: {} as Record<string, string[]>,
  notifiche: [] as Record<string, unknown>[],
  email: [] as { to: string; subject: string; text: string }[],
  /** Gli indirizzi che il provider RIFIUTA, col motivo che restituisce. */
  emailRifiutate: new Map<string, string>(),
  eccezioneClient: null as unknown,
  /** La sequenza REALE: gli avvisi devono precedere la scrittura dello stato. */
  sequenza: [] as string[],
  /**
   * L'INTERRUTTORE del pannello Impostazioni, come lo vedrebbe la route.
   *
   * Sta qui, e non dentro il finto `notificaEvento`, per una ragione precisa: se
   * il gate vivesse solo là dentro, questo file non potrebbe MAI vedere il
   * difetto — la finta `notificaEvento` è muta per costruzione e l'email non
   * passa da lei. È esattamente il buco in cui l'email era finita.
   */
  tipoAbilitato: true,
  /** A chi la route ha chiesto il permesso: dice anche QUANTE volte lo chiede. */
  gate: [] as { tipo: string; sede: string | null }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (
    evento: string,
    livello: string,
    campi: Record<string, unknown>,
    _err?: unknown,
    opzioni?: { distingui?: readonly string[] },
  ) => {
    h.eventi.push({ evento, livello, campi, opzioni })
  },
  logErrore: (campi: Record<string, unknown>) => {
    h.eventi.push({ evento: 'cron', livello: 'error', campi })
  },
  logOk: () => {},
}))

vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: async (_supabase: unknown, params: Record<string, unknown>) => {
    h.sequenza.push('notifica')
    h.notifiche.push(params)
  },
}))

vi.mock('@/lib/notifiche/config', () => ({
  isNotificaAbilitata: async (_supabase: unknown, tipo: string, sede: string | null) => {
    h.gate.push({ tipo, sede })
    return h.tipoAbilitato
  },
}))

vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: async (_supabase: unknown, sedeId: string | null) =>
    (sedeId && h.segreteriaDiSede[sedeId]) || [],
}))

vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: async (params: { to: string; subject: string; text: string }) => {
    h.sequenza.push('email')
    h.email.push(params)
    const motivo = h.emailRifiutate.get(params.to)
    return motivo ? { ok: false, error: motivo } : { ok: true, error: null }
  },
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    if (h.eccezioneClient) throw h.eccezioneClient
    return {
      from: (tabella: string) => {
        const qb: Record<string, unknown> = {}
        let colonne = ''
        /** `select(c, { count: 'exact', head: true })` = conta, non legge righe. */
        let conteggio = false
        qb.select = (c: string, opzioni?: { count?: string; head?: boolean }) => {
          colonne = c
          conteggio = opzioni?.head === true
          h.select.push({ tabella, colonne: c, conteggio })
          return qb
        }
        for (const m of ['lte', 'gte', 'is', 'in', 'eq', 'not', 'order', 'limit']) {
          qb[m] = (...argomenti: unknown[]) => {
            h.clausole.push({ tabella, metodo: m, argomenti, conteggio })
            return qb
          }
        }
        qb.update = (valori: Record<string, unknown>) => ({
          in: (_colonna: string, ids: string[]) => {
            h.sequenza.push('update')
            h.update.push({ valori, ids })
            return Promise.resolve({ error: h.erroreUpdate })
          },
        })
        qb.then = (res: (v: unknown) => unknown) => {
          if (tabella === 'anagrafica_personale') {
            // Con `head: true` PostgREST non trasferisce righe: `data` è `null` e
            // il numero sta in `count`. Se il mock restituisse comunque `data`,
            // una route che leggesse la colonna sbagliata resterebbe verde qui.
            if (conteggio) {
              return Promise.resolve({
                data: null,
                count: h.senzaScadenza,
                error: h.erroreSenzaScadenza,
              }).then(res)
            }
            return Promise.resolve({ data: h.anagrafiche, error: h.erroreAnagrafiche }).then(res)
          }
          // Due letture diverse sulla stessa tabella: le persone interessate e le
          // caselle della segreteria. Si distinguono dalle COLONNE chieste — che è
          // anche il modo in cui il test si accorge se una delle due sparisce.
          if (colonne.includes('nome')) {
            return Promise.resolve({ data: h.utenti, error: h.erroreUtenti }).then(res)
          }
          return Promise.resolve({ data: h.staff, error: h.erroreStaff }).then(res)
        }
        return qb
      },
    }
  },
}))

import { POST } from '@/app/api/notifiche/scadenze-documenti/route'

const SORGENTE_ROUTE = readFileSync(
  join(process.cwd(), 'src/app/api/notifiche/scadenze-documenti/route.ts'),
  'utf8',
)

const chiama = (headers: Record<string, string> = { 'x-cron-secret': CRON_SECRET }) =>
  POST(
    new Request('http://localhost/api/notifiche/scadenze-documenti', {
      method: 'POST',
      headers,
    }) as never,
  )

/**
 * Una riga di `anagrafica_personale` come la restituisce la lettura della route.
 *
 * ⚠️ `creata_il` DUE ANNI FA per difetto, e va detto perché è un'ipotesi: la riga
 * di questo costruttore è una persona che INVECCHIA DENTRO il sistema, cioè quella
 * per cui «scaduto da n settimane» e «sollecitato n volte» coincidono. Chi ENTRA
 * con il documento già scaduto è l'altro caso — il tetto dei risolleciti ci era
 * caduto dentro — e lo si costruisce passando `creata_il` esplicitamente.
 */
const anagrafica = (
  utenteId: string,
  scadenza: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  utente_id: utenteId,
  document_expiry: scadenza,
  document_type: 'CI',
  scadenza_soglia_avvisata: null,
  scadenza_avvisata_il: null,
  creata_il: `${fra(-730)}T09:00:00Z`,
  ...extra,
})

const persona = (
  id: string,
  sede: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  nome: NOME,
  cognome: COGNOME,
  email: EMAIL,
  scuola_id: sede,
  ...extra,
})

/**
 * IL `page.tsx` CHE SERVE UN PERCORSO — o `null` se quel percorso non esiste.
 *
 * I gruppi di rotta (`(dashboard)`) sono cartelle che NON compaiono nell'URL:
 * `/admin/staff` vive in `src/app/(dashboard)/admin/staff/page.tsx`. Perciò la
 * ricerca prova il segmento diretto e, se non basta, scende in ogni cartella fra
 * parentesi senza consumare segmenti.
 */
function paginaChServe(percorso: string): string | null {
  const cerca = (dir: string, resto: string[]): string | null => {
    if (resto.length === 0) {
      const file = join(dir, 'page.tsx')
      return existsSync(file) ? file : null
    }
    const diretto = join(dir, resto[0])
    if (existsSync(diretto)) {
      const trovato = cerca(diretto, resto.slice(1))
      if (trovato) return trovato
    }
    for (const voce of readdirSync(dir, { withFileTypes: true })) {
      if (!voce.isDirectory() || !voce.name.startsWith('(')) continue
      const trovato = cerca(join(dir, voce.name), resto)
      if (trovato) return trovato
    }
    return null
  }
  return cerca(join(process.cwd(), 'src/app'), percorso.split('/').filter(Boolean))
}

/**
 * Il sorgente della pagina PIÙ quello dei componenti interni che monta.
 *
 * Una pagina dell'App Router è quasi sempre un guscio di 30 righe: il parametro
 * di query, se qualcuno lo legge, lo legge il pannello. Cercarlo solo nel file
 * `page.tsx` darebbe un rosso su un filtro che funziona. Due livelli bastano per
 * la forma che ha questo repo (pagina → pannello → sotto-componente) e tengono
 * il lock finito.
 */
function sorgenteDellaPagina(pagina: string, profondita = 2): string {
  let testo = readFileSync(pagina, 'utf8')
  if (profondita <= 0) return testo
  for (const m of testo.matchAll(/from\s+'@\/([^']+)'/g)) {
    for (const est of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
      const file = join(process.cwd(), 'src', m[1] + est)
      if (!existsSync(file)) continue
      testo += '\n' + sorgenteDellaPagina(file, profondita - 1)
      break
    }
  }
  return testo
}

/** Il battito: `cron` · `info` · con i conteggi. È ciò che `/api/health` legge. */
const battiti = () =>
  h.eventi.filter((e) => e.evento === 'cron' && e.livello === 'info' && 'n_lette' in e.campi)
const eventiDi = (livello: string) => h.eventi.filter((e) => e.livello === livello)
const clausoleDi = (metodo: string) => h.clausole.filter((c) => c.metodo === metodo)

beforeEach(() => {
  vi.clearAllMocks()
  h.eventi = []
  h.select = []
  h.clausole = []
  h.anagrafiche = []
  h.erroreAnagrafiche = null
  h.senzaScadenza = 0
  h.erroreSenzaScadenza = null
  h.utenti = []
  h.erroreUtenti = null
  h.staff = [{ id: SEGRETARIA, email: EMAIL_SEGRETERIA }]
  h.erroreStaff = null
  h.erroreUpdate = null
  h.update = []
  h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA] }
  h.notifiche = []
  h.email = []
  h.emailRifiutate = new Map()
  h.eccezioneClient = null
  h.sequenza = []
  h.tipoAbilitato = true
  h.gate = []
  process.env.CRON_SECRET = CRON_SECRET
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · il battito c’è SEMPRE, anche a zero righe', () => {
  it('nessuna anagrafica in scadenza → 200 e un battito `ok` con i conteggi a zero', async () => {
    // Il difetto n. 1: senza questa riga, la notte normale di questo job è il
    // silenzio, e il silenzio è anche ciò che produce un cron che non parte più.
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi).toMatchObject({
      operazione: 'scadenze-documenti-personale',
      esito: 'ok',
      n_lette: 0,
      n_avvisate: 0,
    })
    expect(h.notifiche).toHaveLength(0)
    expect(h.email).toHaveLength(0)
  })

  it('il battito esce anche quando la lettura FALLISCE, e non dice «ok»', async () => {
    h.erroreAnagrafiche = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi.esito).toBe('lettura-fallita')
    // `esito: 'ok'` è la stringa con cui `/api/health` certifica una notte andata
    // bene: emetterla qui sarebbe peggio che non emettere nulla.
    expect(battiti()[0].campi.esito).not.toBe('ok')
  })

  it('il battito esce anche quando il client Supabase non si costruisce', async () => {
    // `createAdminClient()` usa `SUPABASE_SERVICE_ROLE_KEY!`: quel `!` è una
    // promessa al type-checker, non al runtime. Con la chiave ruotata male non
    // gira NIENTE, ed è il guasto che deve restare dentro `evento = 'cron'` —
    // altrimenti è l'unico totale e l'unico invisibile a chi lo cerca.
    h.eccezioneClient = new Error('Unregistered API key')
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()).toHaveLength(1)
    expect(battiti()[0].campi.esito).toBe('eccezione')
    expect(h.eventi.some((e) => e.evento === 'cron' && e.livello === 'error')).toBe(true)
  })

  it('🔴 il battito dice quante persone questo allarme NON copre', async () => {
    // ─── IL GUASTO CHE QUESTA RIGA RENDE VISIBILE ───────────────────────────
    //
    // Una riga con `document_expiry IS NULL` non entra nel lotto (`lte` con NULL
    // non è mai vero) e non entrava in nessun conteggio: quella persona non
    // riceveva nessun avviso, non compariva da nessuna parte, e il battito
    // scriveva `esito: 'ok'`. Cioè «nessuna email» diventava indistinguibile da
    // «nessuna scadenza» — la firma esatta che il battito esiste per togliere.
    //
    // Con l'ordine di grandezza vero del personale (decine), tre righe senza
    // data significano una copertura dell'85 % dichiarata come 100 %.
    h.senzaScadenza = 3
    await chiama()
    expect(battiti()[0].campi.n_senza_scadenza).toBe(3)

    // …e non è un numero sepolto in una riga `info`: chi cerca i guasti interroga
    // `warn`/`error`, quindi il buco di copertura ha una riga sua.
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'senza-data-di-scadenza')
    expect(avviso?.campi.n_senza_scadenza).toBe(3)
    // Un conteggio, non un elenco: nessun uuid di persona in quella riga.
    expect(JSON.stringify(avviso)).not.toContain(UTENTE_1)
  })

  it('il lotto PIENO ha una riga `warn` sua, non solo un campo nel battito', async () => {
    // ─── LO STESSO DIFETTO DI `senza-data-di-scadenza`, DALL'ALTRO LATO ──────
    //
    // `lotto_pieno` significa che stanotte il giro NON ha guardato tutti: la
    // lettura si ferma a `TETTO_LOTTO` righe, e se una delle righe oltre il
    // tetto attraversava una soglia quella persona non è stata avvisata —
    // senza che nulla sia «fallito» e con il battito che dichiara `ok`.
    //
    // È un buco di COPERTURA, esattamente come una data di scadenza mancante, e
    // per la stessa ragione non può vivere solo dentro la riga `info` del
    // battito: chi cerca i guasti interroga `warn`/`error`, e lì non lo
    // troverebbe. Con l'ordine di grandezza vero del personale (decine) questo
    // tetto non si tocca mai — ed è il motivo per cui, senza una riga sua, il
    // giorno in cui si toccasse non se ne accorgerebbe nessuno.
    const tetto = 500
    h.anagrafiche = Array.from({ length: tetto }, (_, i) =>
      anagrafica(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, fra(200)),
    )
    h.utenti = []

    await chiama()

    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'lotto-pieno')
    expect(avviso).toBeDefined()
    expect(avviso?.campi.n_lette).toBe(tetto)
    // Un conteggio, non un elenco: nessun uuid di persona in quella riga.
    expect(JSON.stringify(avviso)).not.toContain('00000000-0000-4000-8000-')
    // …e il campo resta ANCHE nel battito: chi legge il battito non deve dedurre
    // il troncamento da un'altra riga.
    expect(battiti()[0].campi.lotto_pieno).toBe(true)
  })

  it('lotto NON pieno: nessuna riga `warn`, e `lotto_pieno` è false', async () => {
    // Il complemento del test qui sopra: senza questo, un `warn` emesso a ogni
    // giro passerebbe inosservato — ed è il modo in cui un avviso vero diventa
    // rumore che si impara a ignorare.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]

    await chiama()

    expect(eventiDi('warn').filter((e) => e.campi.esito === 'lotto-pieno')).toHaveLength(0)
    expect(battiti()[0].campi.lotto_pieno).toBe(false)
  })

  it('zero misurato è zero, e non si confonde con «non misurato»', async () => {
    await chiama()
    expect(battiti()[0].campi.n_senza_scadenza).toBe(0)
    // Nessun rumore quando non c'è niente da dire: la riga `warn` esce solo se il
    // buco esiste davvero.
    expect(eventiDi('warn').filter((e) => e.campi.esito === 'senza-data-di-scadenza')).toHaveLength(0)
  })

  it('conteggio FALLITO → `null` («non misurato»), mai uno zero inventato', async () => {
    // Uno zero scritto qui sarebbe la stessa bugia che questo conteggio esiste
    // per smascherare, firmata dal codice che doveva smascherarla. E il giro
    // continua: chi la data ce l'ha viene avvisato lo stesso.
    h.erroreSenzaScadenza = { code: '42501', message: 'permission denied' }
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()[0].campi.n_senza_scadenza).toBeNull()
    expect(eventiDi('warn').some((e) => e.campi.esito === 'copertura-non-misurata')).toBe(true)
    expect(h.notifiche).toHaveLength(2)
  })

  it('tabella assente: `n_senza_scadenza` resta `null`, non zero', async () => {
    // Sul database della CI la tabella non c'è: dichiarare «zero persone
    // scoperte» sarebbe dichiarare una misura mai fatta.
    h.erroreAnagrafiche = { code: 'PGRST205', message: 'Could not find the table' }
    await chiama()
    expect(battiti()[0].campi.n_senza_scadenza).toBeNull()
  })

  it('il conteggio guarda la faccia OPPOSTA della lettura: `document_expiry is null`', async () => {
    await chiama()
    const conteggio = h.select.find((s) => s.tabella === 'anagrafica_personale' && s.conteggio)
    expect(conteggio, 'nessuna head-query: la copertura non viene misurata').toBeDefined()
    const senzaData = clausoleDi('is').filter(
      (c) => c.conteggio && c.argomenti[0] === 'document_expiry',
    )
    expect(senzaData).toHaveLength(1)
    expect(senzaData[0].argomenti[1]).toBeNull()
    // `head: true`: si trasferisce il numero, non le righe — nessun dato
    // personale attraversa questo processo per essere buttato via subito dopo.
    expect(h.select.filter((s) => s.conteggio).length).toBe(1)
  })

  it('il battito è scritto in un `finally`, non in fondo al ramo felice', () => {
    // Lock di forma: nella versione SQL del lavoro gemello l'`INSERT` in `app_log`
    // stava DOPO la cancellazione e l'eccezione lo saltava — la difesa che doveva
    // accorgersi del guasto era a valle del guasto.
    expect(SORGENTE_ROUTE).toMatch(/\}\s*finally\s*\{[\s\S]*logEvento\(\s*'cron',\s*'info'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · il database della CI non è migrato', () => {
  it('tabella assente → `ok-parziale` e 200, MAI un 500', async () => {
    h.erroreAnagrafiche = { code: 'PGRST205', message: 'Could not find the table' }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, saltata: true, motivo: 'tabella-assente' })
    expect(battiti()[0].campi.esito).toBe('ok-parziale')
    // …e lo dice, invece di limitarsi a non fare niente: «zero scadenze» e «non ho
    // guardato» si leggono uguali e significano l'opposto.
    expect(eventiDi('warn').some((e) => e.campi.esito === 'ok-parziale')).toBe(true)
  })

  it('`42P01` vale come `PGRST205`: è la stessa assenza detta da Postgres', async () => {
    h.erroreAnagrafiche = { code: '42P01', message: 'relation does not exist' }
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(battiti()[0].campi.esito).toBe('ok-parziale')
  })

  it('🔴 una COLONNA assente NON è tolleranza d’ambiente: è schema a metà, ed è 500', async () => {
    // `42703` è una TABELLA CHE C'È a cui manca una colonna, cioè una migrazione
    // applicata a metà su un database vivo. Assorbirla in silenzio è il difetto
    // che `@/lib/db/tolleranza-schema` è nato per chiudere: la discriminante è il
    // CODICE, non la prosa dell'errore.
    h.erroreAnagrafiche = { code: '42703', message: 'column cessato_il does not exist' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()[0].campi.esito).toBe('lettura-fallita')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · chi viene avvisato, e con quale canale', () => {
  it('CONTROLLO POSITIVO · a 30 giorni: in-app a entrambi, email alla SOLA interessata', async () => {
    // Senza questo, l'intero file certificherebbe un job che non avvisa mai
    // nessuno — cioè un allarme che non suona.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, avvisate: 1, email: 1 })

    // Due notifiche in-app: una all'interessata, una alla segreteria della sede.
    expect(h.notifiche).toHaveLength(2)
    expect(h.notifiche[0]).toMatchObject({
      tipo: 'documento_personale_in_scadenza',
      scuolaId: SEDE_A,
      utenteIds: [UTENTE_1],
      // Nessun link: la schermata da cui una docente aggiorna il proprio
      // documento non esiste, e `/admin/staff` le risponderebbe 403.
      link: null,
    })
    expect(h.notifiche[1]).toMatchObject({ utenteIds: [SEGRETARIA] })
    // Il pannello delle scadenze ORA ESISTE e legge `?tab=`/`?stato=`: il link
    // torna a portare il filtro (il lock «il link PORTA da qualche parte», più
    // sotto, verifica che la pagina li legga davvero e non solo che partano).
    // ⚠️ E lo stato SEGUE LA SOGLIA: a 30 giorni è `entro30`, non `scaduto` —
    // con `scaduto` si aprirebbe una tabella in cui la persona di cui parla
    // l'avviso non c'è, che è peggio del nessun filtro.
    expect(h.notifiche[1].link).toBe('/admin/staff?tab=scadenze&stato=entro30')

    // Una sola email, e va a lei: a 30 giorni la segreteria non ha ancora niente
    // da fare, e un'email che non chiede niente consuma l'attenzione che servirà
    // a quella dei 7 giorni.
    expect(h.email.map((e) => e.to)).toEqual([EMAIL])
  })

  it('a 90 giorni NESSUNA email: solo le due notifiche in-app', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(90))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.notifiche).toHaveLength(2)
    expect(h.email).toHaveLength(0)
  })

  it('a 7 giorni e a documento SCADUTO l’email va anche alla segreteria', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(7)), anagrafica(UTENTE_2, fra(-40))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_A, { email: null })]
    await chiama()
    // U1: interessata + segreteria. U2 non ha email propria → resta la segreteria.
    expect(h.email.filter((e) => e.to === EMAIL)).toHaveLength(1)
    expect(h.email.filter((e) => e.to === EMAIL_SEGRETERIA)).toHaveLength(2)
    // Un account senza indirizzo è un canale in meno che nessuno vedrebbe: va
    // detto, con il solo uuid.
    const senzaEmail = eventiDi('warn').find((e) => e.campi.esito === 'senza-email')
    expect(senzaEmail?.campi.utente_id).toBe(UTENTE_2)
  })

  it('🔴 il link della segreteria PORTA da qualche parte: pagina vera, nessun filtro promesso a vuoto', async () => {
    // ─── COSA ERA SUCCESSO, MISURATO ────────────────────────────────────────
    //
    // Questa route mandava la segreteria su `/admin/staff?tab=scadenze` e, a
    // documento scaduto, su `…&stato=scaduto`. Il pannello con quella scheda e
    // quel filtro NON ESISTE: `src/app/(dashboard)/admin/staff/page.tsx` non
    // legge nessun `searchParams` e `StaffPanel.tsx` non contiene né
    // `useSearchParams`, né `scadenze`, né `stato`. I due parametri erano
    // inerti: chi cliccava atterrava sull'elenco del personale.
    //
    // ─── PERCHÉ SERVE UN LOCK E NON UN'ASSERZIONE SULLA STRINGA ─────────────
    //
    // I tre test che coprivano quel link confrontavano la stringa con sé stessa.
    // Un parametro di query che la destinazione ignora è VERDE PER COSTRUZIONE:
    // parte, arriva, coincide — e non porta da nessuna parte. L'unico modo di
    // accorgersene è guardare la PAGINA, che è ciò che fa questo lock.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-1)), anagrafica(UTENTE_2, fra(60))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_A)]
    await chiama()

    const link = h.notifiche
      .filter((n) => (n.utenteIds as string[])[0] === SEGRETARIA)
      .map((n) => String(n.link))
    // Controllo positivo: senza, questo lock resterebbe verde su una route che
    // ha smesso di mandare qualunque link alla segreteria.
    expect(link.length, 'la segreteria non riceve più nessun link').toBe(2)

    for (const l of link) {
      const [percorso, query] = l.split('?')
      const pagina = paginaChServe(percorso)
      expect(
        pagina,
        `«${percorso}» non corrisponde a nessun page.tsx: la notifica manda su un 404.`,
      ).not.toBeNull()

      if (!query) continue
      // Ogni parametro dev'essere LETTO dalla destinazione (la pagina o un
      // componente che monta), altrimenti è una promessa che nessuno mantiene.
      const sorgenteDestinazione = sorgenteDellaPagina(pagina!)
      for (const chiave of [...new URLSearchParams(query).keys()]) {
        expect(
          /useSearchParams|searchParams/.test(sorgenteDestinazione),
          `«${percorso}» non legge nessun parametro di query, ma la notifica gliene manda «${chiave}».`,
        ).toBe(true)
        // La LETTURA, non la stringa. Cercare `'tab'` in 166 KB di sorgente
        // transitivo (misurato) darebbe verde al primo nome che per caso compare
        // altrove — `id`, `tipo`, `stato` — cioè proprio sui nomi più probabili.
        // Qui si pretende una delle due forme con cui un parametro si legge
        // davvero: `searchParams.get('x')` (client) o `searchParams.x` (props
        // server). Entrambe sono prove che qualcuno lo usa.
        const letto =
          new RegExp(`\\.get\\(\\s*['"\`]${chiave}['"\`]`).test(sorgenteDestinazione) ||
          new RegExp(`searchParams\\s*\\??\\.\\s*${chiave}\\b`).test(sorgenteDestinazione)
        expect(
          letto,
          `il parametro «${chiave}» non viene LETTO dalla destinazione: è inerte, e chi clicca ` +
            'atterra su una lista non filtrata. O si toglie dal link, o si costruisce il pannello ' +
            'che lo onora.',
        ).toBe(true)
      }
    }
  })

  it('nell’EMAIL il link è assoluto: un percorso nudo non è un link', async () => {
    // `/admin/staff` dentro un'email è testo che nessun client sa aprire. È lo
    // stesso idioma con cui il repo manda ogni altro indirizzo per posta.
    process.env.NEXT_PUBLIC_APP_URL = 'https://esempio.invalid'
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-1))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    const allaSegreteria = h.email.find((e) => e.to === EMAIL_SEGRETERIA)
    expect(allaSegreteria?.text).toContain('https://esempio.invalid/admin/staff')
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('…e senza `NEXT_PUBLIC_APP_URL` resta il percorso, non «undefined/admin/staff»', async () => {
    // Una variabile non configurata non deve produrre un indirizzo rotto: il
    // percorso nudo è meno utile, `undefined/…` è una segnalazione di guasto
    // spedita a una segretaria.
    delete process.env.NEXT_PUBLIC_APP_URL
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-1))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    const allaSegreteria = h.email.find((e) => e.to === EMAIL_SEGRETERIA)
    expect(allaSegreteria?.text).toContain('/admin/staff')
    expect(allaSegreteria?.text).not.toContain('undefined')
  })

  it('ogni sede riceve i suoi, e la segreteria di una sede non vede l’altra', async () => {
    // Tre sedi reali dal 2026-07-29: una route che «indovina» la sede archivia o
    // annuncia nel plesso sbagliato, in silenzio.
    h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA], [SEDE_B]: [] }
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30)), anagrafica(UTENTE_2, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_B)]
    await chiama()
    const sedi = h.notifiche.map((n) => n.scuolaId)
    expect(sedi.filter((s) => s === SEDE_A)).toHaveLength(2) // interessata + segreteria
    expect(sedi.filter((s) => s === SEDE_B)).toHaveLength(1) // solo l'interessata
    expect(h.notifiche.some((n) => n.scuolaId === SEDE_B && (n.utenteIds as string[])[0] === SEGRETARIA)).toBe(false)
  })

  it('le persone si leggono IN BLOCCO, non una per riga', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30)), anagrafica(UTENTE_2, fra(7))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_A)]
    await chiama()
    // Una `in('id', [...])` con DUE id, non due letture da uno: `utenti` è la
    // tabella che ogni gate di ruolo interroga a ogni richiesta.
    const letture = h.select.filter((s) => s.tabella === 'utenti' && s.colonne.includes('nome'))
    expect(letture).toHaveLength(1)
    const inSuUtenti = clausoleDi('in').filter((c) => c.tabella === 'utenti')
    expect(inSuUtenti[0].argomenti[1]).toEqual([UTENTE_1, UTENTE_2])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · la finestra interrogata', () => {
  it('la WHERE chiede `document_expiry <= oggi + 90` — la soglia più lontana', async () => {
    await chiama()
    const lte = clausoleDi('lte').find((c) => c.tabella === 'anagrafica_personale')
    expect(lte?.argomenti[0]).toBe('document_expiry')
    // Se qualcuno restringesse questo limite a 30, i preavvisi di 90 e 60 non
    // verrebbero MAI letti, quindi mai mandati — e il battito continuerebbe a
    // scrivere `esito: ok, n_avvisate: 0`: un giro a vuoto che si dichiara riuscito.
    expect(lte?.argomenti[1]).toBe(aggiungiGiorni(OGGI, 90))
  })

  it('🔴 chi ha CESSATO il rapporto non riceve promemoria', async () => {
    // Continuare a scrivere a un'ex dipendente — e alla segreteria, su di lei —
    // non serve a nessun adempimento: è il trattamento di un dato per una finalità
    // che non esiste più.
    await chiama()
    const cessato = clausoleDi('is').filter((c) => c.argomenti[0] === 'cessato_il')
    // DUE, e devono essere due: la lettura degli avvisi e il conteggio della
    // copertura interrogano la stessa tabella con WHERE opposte, e il personale
    // cessato va escluso da ENTRAMBE. Contarlo nel secondo numero gonfierebbe il
    // buco dichiarato con persone che non lavorano più qui.
    expect(cessato, 'la WHERE non filtra il personale cessato').toHaveLength(2)
    for (const c of cessato) {
      expect(c.tabella).toBe('anagrafica_personale')
      expect(c.argomenti[1]).toBeNull()
    }
    expect(cessato.filter((c) => !c.conteggio), 'la lettura degli avvisi non lo filtra').toHaveLength(1)
    expect(cessato.filter((c) => c.conteggio), 'il conteggio della copertura non lo filtra').toHaveLength(1)
  })

  it('le più scadute per prime, e con un tetto esplicito al lotto', async () => {
    await chiama()
    const order = clausoleDi('order').find((c) => c.tabella === 'anagrafica_personale')
    expect(order?.argomenti[0]).toBe('document_expiry')
    expect(order?.argomenti[1]).toMatchObject({ ascending: true })
    // Senza `.limit()` il taglio lo decide PostgREST (`db-max-rows`) e arriva muto.
    expect(clausoleDi('limit').some((c) => typeof c.argomenti[0] === 'number')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · nessun dato personale nei log', () => {
  it('🔴 né nome, né cognome, né email, né codice fiscale, né numero del documento', async () => {
    h.anagrafiche = [
      anagrafica(UTENTE_1, fra(-3), {
        // Colonne che la route NON deve nemmeno leggere: se un giorno finissero
        // nella `select`, questa riga le porterebbe fino ai log.
        fiscal_code: CODICE_FISCALE,
        document_number: NUMERO_DOCUMENTO,
        documento_path: 'documenti/2026/carta-identita-esposito.pdf',
      }),
    ]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()

    const log = JSON.stringify(h.eventi)
    for (const segreto of [NOME, COGNOME, EMAIL, CODICE_FISCALE, NUMERO_DOCUMENTO, 'carta-identita-esposito']) {
      expect(log, `«${segreto}» è finito nei log`).not.toContain(segreto)
    }
    // Controllo positivo, altrimenti questa prova resterebbe verde anche su una
    // route che non logga NIENTE: ciò che deve esserci — l'uuid della SEDE e i
    // conteggi — c'è davvero.
    expect(log).toContain(SEDE_A)
    expect(battiti()[0].campi.n_avvisate).toBe(1)
    expect(battiti()[0].campi.n_scaduti).toBe(1)
  })

  it('l’uuid della persona esce SOLO dove serve a riparare, mai nel battito', async () => {
    // Un uuid non è un nome, ma il battito è la riga che si legge tutte le notti:
    // metterci l'elenco di chi ha il documento scaduto significherebbe tenere in
    // `app_log` — 30 giorni, interrogabile in SQL — un registro delle non
    // conformità del personale. Nelle righe d'ERRORE invece serve: senza, «una
    // email non è partita» non si può riparare.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    h.emailRifiutate.set(EMAIL, 'rifiutato dal provider email (403): domain not verified')
    await chiama()
    expect(JSON.stringify(battiti()[0].campi)).not.toContain(UTENTE_1)
    expect(JSON.stringify(eventiDi('error'))).toContain(UTENTE_1)
  })

  it('il numero del documento e il codice fiscale non vengono nemmeno LETTI', async () => {
    await chiama()
    const colonne = h.select.find((s) => s.tabella === 'anagrafica_personale')?.colonne ?? ''
    expect(colonne).not.toContain('document_number')
    expect(colonne).not.toContain('fiscal_code')
    expect(colonne).not.toContain('documento_path')
    // …e ciò che serve c'è: senza questa metà, «non legge niente» passerebbe.
    expect(colonne).toContain('document_expiry')
    expect(colonne).toContain('scadenza_soglia_avvisata')
  })

  it('i conteggi sono PER SEDE, mai una riga per persona', async () => {
    // Una riga per persona significherebbe scrivere in `app_log` — 30 giorni,
    // interrogabile in SQL — l'elenco di chi ha il documento scaduto.
    h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA], [SEDE_B]: [] }
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-5)), anagrafica(UTENTE_2, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_B)]
    await chiama()

    const righeSede = h.eventi.filter((e) => e.campi.esito === 'per-sede')
    expect(righeSede).toHaveLength(2)
    // 🔴 `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è
    // nell'impronta: senza `distingui`, le tre sedi collasserebbero in UNA riga
    // che dichiara i numeri della prima e li attribuisce a tutte.
    for (const r of righeSede) expect(r.opzioni?.distingui).toEqual(['sede_id'])
    expect(righeSede.find((r) => r.campi.sede_id === SEDE_A)?.campi).toMatchObject({
      n_avvisate: 1,
      n_scaduti: 1,
    })
    expect(righeSede.find((r) => r.campi.sede_id === SEDE_B)?.campi).toMatchObject({
      n_avvisate: 1,
      n_scaduti: 0,
    })
    // Il battito complessivo dichiara SOLO quante sedi, non quali persone.
    expect(battiti()[0].campi.n_sedi).toBe(2)
    for (const e of [...righeSede, ...battiti()]) {
      expect(JSON.stringify(e.campi)).not.toContain(NOME)
      expect(JSON.stringify(e.campi)).not.toContain(EMAIL)
      expect(JSON.stringify(e.campi)).not.toContain(UTENTE_1)
    }
  })

  it('nella notte normale non si scrive nessuna riga per sede: solo il battito', async () => {
    // Un lavoro che scrive righe anche quando non fa niente riempie `app_log` di
    // rumore, e il rumore è il modo in cui gli errori veri smettono di trovarsi.
    await chiama()
    expect(h.eventi.filter((e) => e.campi.esito === 'per-sede')).toHaveLength(0)
    expect(battiti()).toHaveLength(1)
  })

  it('il corpo dell’email non porta il numero del documento né il codice fiscale', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-2))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.email.length).toBeGreaterThan(0)
    for (const e of h.email) {
      expect(e.text).not.toContain(NUMERO_DOCUMENTO)
      expect(e.text).not.toContain(CODICE_FISCALE)
    }
    // Controllo positivo: l'email dice comunque la cosa per cui esiste.
    expect(h.email[0].text).toContain(fra(-2).split('-').reverse().join('/'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · la seconda esecuzione non rimanda niente', () => {
  it('🔴 stessa soglia, giro successivo: zero notifiche e zero email', async () => {
    // Il difetto n. 4: senza le due colonne di stato l'avviso «mancano 30 giorni»
    // ripartirebbe per trenta notti di fila.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.notifiche).toHaveLength(2)
    expect(h.update).toHaveLength(1)
    expect(h.update[0].valori.scadenza_soglia_avvisata).toBe(30)
    expect(h.update[0].ids).toEqual([UTENTE_1])

    // Il giro successivo legge lo stato che il primo ha scritto.
    const { scadenza_soglia_avvisata, scadenza_avvisata_il } = h.update[0].valori
    h.notifiche = []
    h.email = []
    h.update = []
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30), { scadenza_soglia_avvisata, scadenza_avvisata_il })]
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.notifiche).toHaveLength(0)
    expect(h.email).toHaveLength(0)
    expect(h.update).toHaveLength(0)
    // …e il battito c'è lo stesso: è la notte normale di questo lavoro.
    expect(battiti()[battiti().length - 1].campi).toMatchObject({ esito: 'ok', n_avvisate: 0 })
  })

  it('la soglia che SCENDE riapre l’avviso: 30 già detto, ma ora ne mancano 7', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(7), {
      scadenza_soglia_avvisata: 30,
      scadenza_avvisata_il: new Date().toISOString(),
    })]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.notifiche).toHaveLength(2)
    expect(h.update[0].valori.scadenza_soglia_avvisata).toBe(7)
  })

  it('il documento SCADUTO avvisato ieri non risollecita oggi', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-30), {
      scadenza_soglia_avvisata: 0,
      scadenza_avvisata_il: new Date(Date.now() - 86_400_000).toISOString(),
    })]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.notifiche).toHaveLength(0)
  })

  it('…ma dopo una settimana sì: una non conformità aperta non si dimentica', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-120), {
      scadenza_soglia_avvisata: 0,
      scadenza_avvisata_il: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    })]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.notifiche).toHaveLength(2)
    expect(h.update[0].valori.scadenza_soglia_avvisata).toBe(0)
  })

  it('lo stato si scrive DOPO gli invii, mai prima', async () => {
    // Al contrario, un guasto a metà lascerebbe la soglia segnata come annunciata
    // e l'avviso mai partito: silenzio per sempre su quel documento.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(7))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.sequenza.indexOf('update')).toBeGreaterThan(h.sequenza.lastIndexOf('email'))
    expect(h.sequenza.indexOf('update')).toBeGreaterThan(h.sequenza.lastIndexOf('notifica'))
  })

  it('lo stato NON aggiornato è un guasto dichiarato (500), non un «ok»', async () => {
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    h.erroreUpdate = { code: '42501', message: 'permission denied' }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect(battiti()[0].campi.esito).toBe('stato-non-aggiornato')
    // PostgREST NON lancia: senza il controllo di `{ error }` l'avviso ripartirebbe
    // ogni notte e il giro si dichiarerebbe riuscito.
    expect(eventiDi('error').some((e) => e.campi.esito === 'stato-non-aggiornato')).toBe(true)
  })

  it('la route NON replica l’azzeramento del trigger su `document_expiry`', () => {
    // Il trigger `anagrafica_personale_tocca_trg` azzera le due colonne quando la
    // scadenza cambia, e vive lì apposta: i punti che scrivono quella colonna sono
    // tre, e un azzeramento dimenticato in uno solo produce una persona che non
    // riceve più nessun avviso, senza nessun errore da nessuna parte.
    expect(SORGENTE_ROUTE).not.toMatch(/update\(\s*\{[^}]*document_expiry/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · l’allarme che si può zittire', () => {
  // ─── IL DIFETTO, MISURATO (rilievo del revisore, 2026-08-12) ──────────────
  //
  // L'interruttore del tipo `documento_personale_in_scadenza` spegneva METÀ
  // allarme. `notificaEvento` consulta `isNotificaAbilitata` per conto suo,
  // quindi le notifiche in-app si fermavano; `sendEmailDetailed` veniva invocata
  // fuori da qualunque gate, e le email partivano lo stesso.
  //
  // Non è una sfumatura di configurazione: è la seconda modalità di guasto di
  // questa funzionalità, quella che nessun test formale vede. Un avviso che non
  // si può zittire si impara a ignorare, e allora non protegge più niente —
  // compreso l'avviso dei 7 giorni, che è quello che serve davvero.
  //
  // ⚠️ E QUESTO FILE NON POTEVA ACCORGERSENE FINCHÉ IL GATE VIVEVA SOLO DENTRO
  // `notificaEvento`: quella funzione qui è finta e muta. Perciò il gate si
  // finge a parte (`@/lib/notifiche/config`) e la prova guarda i due canali.

  it('🔴 spento: non parte NIENTE — né la notifica, né l’email che passava dal gate di nessuno', async () => {
    h.tipoAbilitato = false
    // 7 giorni: la soglia più rumorosa, quella che manda posta a entrambi.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(7))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]

    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.notifiche).toHaveLength(0)
    expect(
      h.email,
      'Con l’interruttore spento sono partite delle email: il gate copre solo il canale in-app.',
    ).toHaveLength(0)
    expect(await res.json()).toMatchObject({ ok: true, avvisate: 0, disattivate: 1 })
  })

  it('🔴 spento: la soglia NON viene bruciata, così alla riaccensione l’avviso riparte', async () => {
    // La regola è quella di `news/digest.ts` («non si marca `inviata_il`: se il
    // toggle viene riacceso, l'edizione riparte»). Segnare la soglia mentre
    // nessuno ha ricevuto niente lascerebbe quella persona senza il suo
    // preavviso — con lo stato che dichiara di averglielo dato.
    h.tipoAbilitato = false
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.update).toHaveLength(0)

    // Riacceso, con la riga IDENTICA — perché nessuno l'ha toccata.
    h.tipoAbilitato = true
    await chiama()
    expect(h.notifiche).toHaveLength(2)
    expect(h.email.map((e) => e.to)).toEqual([EMAIL])
    expect(h.update[0].valori.scadenza_soglia_avvisata).toBe(30)
  })

  it('spento: il battito lo DICE, e dice in quale sede', async () => {
    // Senza, «zero avvisi» in una sede con documenti scaduti si legge come
    // «niente da segnalare»: due fatti opposti, la stessa riga.
    h.tipoAbilitato = false
    h.anagrafiche = [anagrafica(UTENTE_1, fra(-10)), anagrafica(UTENTE_2, fra(7))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_A)]
    await chiama()

    expect(battiti()[battiti().length - 1].campi).toMatchObject({
      esito: 'ok',
      n_avvisate: 0,
      n_disattivate: 2,
    })
    const riga = h.eventi.filter((e) => e.campi.esito === 'tipo-disattivato')
    // UNA riga per sede, non una per persona: due anagrafiche, un solo annuncio.
    expect(riga).toHaveLength(1)
    expect(riga[0].campi.sede_id).toBe(SEDE_A)
    // `distingui` non è un dettaglio: `app_log` deduplica per (fingerprint,
    // giorno) e il contesto non è nell'impronta — senza, tre sedi collasserebbero
    // in una riga sola che ne dichiara una.
    expect(riga[0].opzioni?.distingui).toContain('sede_id')
  })

  it('il permesso si chiede una volta per SEDE, non una per persona', async () => {
    h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA] }
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30)), anagrafica(UTENTE_2, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A), persona(UTENTE_2, SEDE_B)]
    await chiama()
    expect(h.gate.map((g) => g.tipo)).toEqual([
      'documento_personale_in_scadenza',
      'documento_personale_in_scadenza',
    ])
    expect(h.gate.map((g) => g.sede)).toEqual([SEDE_A, SEDE_B])
  })

  it('🔴 il risollecito del documento scaduto ha un termine sull’EMAIL, non sull’in-app', async () => {
    // ─── IL CASO REALE ──────────────────────────────────────────────────────
    //
    // Una persona che per mesi non riesce a rinnovare il documento — o un
    // rapporto chiuso senza che nessuno abbia scritto `cessato_il` — produceva
    // un'email a settimana a lei e a OGNI membro della segreteria, senza fine.
    // Dopo `MAX_RISOLLECITI_EMAIL` risolleciti (≈ due mesi) resta la notifica
    // in-app: la non conformità continua a vedersi dove non costa attenzione,
    // le caselle di posta si liberano.
    //
    // 64 giorni = 1 + 9×7, cioè il giorno del NONO risollecito: il primo oltre il
    // tetto di otto. Il `+1` è il giorno in cui il documento comincia a essere
    // scaduto — è valido fino alla data di scadenza compresa.
    //
    // ⚠️ La riga porta `scadenza_soglia_avvisata: 0` E un `creata_il` di due anni
    // fa (dal costruttore): è una persona che ha DAVVERO ricevuto i suoi otto
    // solleciti. Senza entrambe le cose questo test misurerebbe l'anzianità della
    // scadenza invece dei solleciti mandati — che è il difetto trovato il 12/08.
    h.anagrafiche = [
      anagrafica(UTENTE_1, fra(-64), {
        scadenza_soglia_avvisata: 0,
        scadenza_avvisata_il: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      }),
    ]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    const res = await chiama()

    expect(h.notifiche, 'l’in-app non si spegne: la non conformità è aperta').toHaveLength(2)
    expect(h.email, 'la posta sì: è il canale che si impara a ignorare').toHaveLength(0)
    expect(await res.json()).toMatchObject({ ok: true, avvisate: 1, email: 0, email_oltre_tetto: 1 })

    // E si vede in `warn`, non solo nel battito: chi cerca i buchi di copertura
    // interroga `warn`/`error`, e «la segreteria non riceve più posta su quella
    // persona» è un buco voluto ma pur sempre un buco.
    const avviso = eventiDi('warn').find((e) => e.campi.esito === 'email-oltre-il-tetto')
    expect(avviso?.campi.n_email_oltre_tetto).toBe(1)
    expect(battiti()[battiti().length - 1].campi.n_email_oltre_tetto).toBe(1)
    // Nessun dato personale nella riga, come ovunque qui dentro.
    expect(JSON.stringify(avviso?.campi)).not.toContain(EMAIL)
  })

  it('…ma dentro il tetto la posta parte ancora: due mesi coprono un appuntamento in Comune', async () => {
    // 57 giorni = 1 + 8×7, l'ottavo risollecito, l'ultimo ammesso. Il controllo
    // positivo del test qui sopra: senza, un tetto a zero lo lascerebbe verde.
    h.anagrafiche = [
      anagrafica(UTENTE_1, fra(-57), {
        scadenza_soglia_avvisata: 0,
        scadenza_avvisata_il: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      }),
    ]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.email.map((e) => e.to).sort()).toEqual([EMAIL, EMAIL_SEGRETERIA].sort())
    expect(eventiDi('warn').some((e) => e.campi.esito === 'email-oltre-il-tetto')).toBe(false)
  })

  it('🔴 la dipendente inserita OGGI con il documento già scaduto riceve la PRIMA email', async () => {
    // ─── IL DIFETTO, MISURATO SU QUESTA STESSA ROUTE (revisore, 2026-08-12) ──
    //
    // È il caso che il modulo dichiara di esistere per servire: `personale-
    // template.ts:210-212` ammette di proposito una data già passata perché «chi
    // ha il documento scaduto è esattamente la persona per cui questo modulo
    // esiste». Con il tetto ancorato all'ANZIANITÀ della scadenza, un'anagrafica
    // appena approvata con la carta d'identità scaduta da 215 giorni nasceva col
    // contatore a 31, cioè già esaurito: `notifiche=2, email=[],
    // email_oltre_tetto=1`, e la riga di `warn` dichiarava «l'email non riparte»
    // mentre non era mai partita. La segreteria — che senza documento valido non
    // può eseguire UNILAV, libro unico e denunce INPS/INAIL — non riceveva NULLA.
    //
    // ⚠️ Le tre condizioni insieme sono ciò che rende questo caso diverso da tutti
    // gli altri di questo file: mai annunciato (`scadenza_soglia_avvisata: null`),
    // riga NATA OGGI, scadenza vecchissima. La suite precedente non aveva nessun
    // caso con questa combinazione, ed è per questo che era verde su un difetto
    // che spegneva metà dell'allarme.
    h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA] }
    h.anagrafiche = [
      anagrafica(UTENTE_1, fra(-215), {
        scadenza_soglia_avvisata: null,
        scadenza_avvisata_il: null,
        creata_il: new Date().toISOString(),
      }),
    ]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    const res = await chiama()

    expect(h.notifiche, 'l’in-app parte, come è sempre partita').toHaveLength(2)
    // ⟵ IL CUORE: le due email che prima non partivano.
    expect(h.email.map((e) => e.to).sort()).toEqual([EMAIL, EMAIL_SEGRETERIA].sort())
    expect(await res.json()).toMatchObject({ ok: true, avvisate: 1, email: 2, email_oltre_tetto: 0 })
    expect(eventiDi('warn').some((e) => e.campi.esito === 'email-oltre-il-tetto')).toBe(false)
    // E il testo dice il fatto giusto: SCADUTO, non «sta per scadere».
    expect(h.email.every((e) => e.text.includes('SCADUT'))).toBe(true)
    // Nessun dato del documento nel corpo, come per ogni altro invio qui dentro.
    expect(h.email.map((e) => `${e.subject}\n${e.text}`).join('\n')).not.toContain(NUMERO_DOCUMENTO)
    expect(h.email.map((e) => `${e.subject}\n${e.text}`).join('\n')).not.toContain(CODICE_FISCALE)
  })

  it('🔴 il secondo giro dello stesso caso conta UNO, non trentuno: la serie parte dalla riga', async () => {
    // Il seguito, e la parte che una guardia sul solo primo annuncio non
    // coprirebbe: passata una settimana lo stato è `0`, e se il conto ripartisse
    // dalla scadenza il SECONDO invio sarebbe già oltre il tetto — una email
    // sola, e mai più, su una non conformità che resta aperta.
    h.segreteriaDiSede = { [SEDE_A]: [SEGRETARIA] }
    h.anagrafiche = [
      anagrafica(UTENTE_1, fra(-222), {
        scadenza_soglia_avvisata: 0,
        scadenza_avvisata_il: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        creata_il: `${fra(-7)}T09:00:00Z`,
      }),
    ]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    await chiama()
    expect(h.email.map((e) => e.to).sort()).toEqual([EMAIL, EMAIL_SEGRETERIA].sort())
    expect(eventiDi('warn').some((e) => e.campi.esito === 'email-oltre-il-tetto')).toBe(false)
  })

  it('la route legge `creata_il`: senza, il tetto tornerebbe a contare l’anzianità della scadenza', async () => {
    // Un lock sul CORPO della richiesta, non su ciò che si vede: la correzione
    // del 12/08 vive tutta nel fatto che la route porti quella colonna fino alla
    // funzione pura. Toglierla dal `select` rimetterebbe il difetto senza rompere
    // nessuna delle asserzioni sui messaggi.
    await chiama()
    const colonne = h.select.find((s) => s.tabella === 'anagrafica_personale')?.colonne ?? ''
    expect(colonne).toContain('creata_il')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · l’email rifiutata', () => {
  it('🔴 il MOTIVO del provider finisce nei log, non solo lo status', async () => {
    // È il guasto storico di questo progetto: per mesi nessuna email è arrivata
    // perché il codice registrava «403» senza il corpo che diceva perché.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    h.emailRifiutate.set(EMAIL, 'rifiutato dal provider email (403): the domain is not verified')
    const res = await chiama()
    expect(res.status).toBe(200)
    const riga = eventiDi('error').find((e) => e.campi.esito === 'email-non-inviata')
    expect(riga).toBeDefined()
    expect(String(riga?.campi.msg)).toContain('the domain is not verified')
    expect(riga?.campi.utente_id).toBe(UTENTE_1)
    // …senza l'indirizzo: il motivo è del provider, il destinatario è di chi legge
    // il database.
    expect(JSON.stringify(riga)).not.toContain(EMAIL)
    expect(battiti()[0].campi.n_email_fallite).toBe(1)
  })

  it('una casella rotta NON trasforma l’avviso in una raffica quotidiana', async () => {
    // La scelta, dichiarata nel sorgente: le due colonne registrano «questa soglia
    // è stata annunciata», e l'annuncio — la notifica in-app — è partito. Non
    // segnarlo significherebbe rimandare notifica ed email OGNI NOTTE finché
    // quella casella non torna a funzionare.
    h.anagrafiche = [anagrafica(UTENTE_1, fra(30))]
    h.utenti = [persona(UTENTE_1, SEDE_A)]
    h.emailRifiutate.set(EMAIL, 'rifiutato dal provider email (422): invalid recipient')
    await chiama()
    expect(h.update).toHaveLength(1)
    expect(h.update[0].valori.scadenza_soglia_avvisata).toBe(30)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · il segreto del cron', () => {
  it('senza header: 401 e NESSUNA riga d’errore fabbricata', async () => {
    // La route è pubblica e senza rate-limit: una riga `error` per ogni `curl`
    // fabbricherebbe dal nulla proprio il segnale «il cron è rotto».
    const res = await chiama({})
    expect(res.status).toBe(401)
    expect(eventiDi('error').filter((e) => e.campi.esito === 'secret-errato')).toHaveLength(0)
    // Il battito però esce lo stesso, e dice che non era autorizzato.
    expect(battiti()[0].campi.esito).toBe('non-autorizzato')
  })

  it('header presente ma SBAGLIATO: 401 e una riga d’errore che nomina il caso', async () => {
    // Chiave sbagliata e job non schedulato, da fuori, si assomigliano: entrambi
    // non avvisano nessuno. Solo questa riga li distingue.
    const res = await chiama({ 'x-cron-secret': 'sbagliato' })
    expect(res.status).toBe(401)
    expect(eventiDi('error').some((e) => e.campi.esito === 'secret-errato')).toBe(true)
    expect(h.notifiche).toHaveLength(0)
  })

  it('`CRON_SECRET` non configurato: nessuno passa (fail-closed)', async () => {
    delete process.env.CRON_SECRET
    const res = await chiama({ 'x-cron-secret': '' })
    expect(res.status).toBe(401)
    process.env.CRON_SECRET = CRON_SECRET
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('scadenze-documenti · i presidi dichiarati nel sorgente', () => {
  it('la route è avvolta in `withRoute` col nome del suo percorso', () => {
    expect(SORGENTE_ROUTE).toContain("withRoute('notifiche/scadenze-documenti:POST'")
  })

  it('il nome del job coincide con la voce sorvegliata in `JOB_CRON`', async () => {
    const m = /const JOB = '([^']+)'/.exec(SORGENTE_ROUTE)
    expect(m).toBeTruthy()
    const { JOB_CRON } = await import('@/lib/health/controlli')
    const voce = JOB_CRON.find((j) => j.nome === m![1])
    expect(
      voce,
      `«${m?.[1]}» non è in JOB_CRON: non comparirebbe né fra i job vivi né fra i muti di ` +
        '/api/health, cioè sarebbe invisibile.',
    ).toBeDefined()
    // Giornaliero ⇒ 26 h: assorbe un giro saltato, non due.
    expect(voce!.finestraMs).toBe(26 * 60 * 60 * 1000)
  })

  it('il cron che la chiama esiste, ed è quotidiano', () => {
    // Una route sorvegliata che nessuno chiama è codice morto che manda
    // `/api/health` in `degradato` dal primo deploy — è successo il 2026-08-10.
    //
    // ⚠️ IL FILE SI CERCA PER CONTENUTO, MAI PER NOME (rilievo del revisore,
    // 2026-08-12). Questa prova apriva `20260811234403_scadenze_documenti_cron.sql`
    // per percorso, e quel numero è PROVVISORIO: l'intestazione del file stesso
    // prescrive di rinominarlo con la versione vera subito dopo l'apply, e la
    // storia del repo dice che succede sempre (rinomini in `a9dcc6d`, `fc7c94a`,
    // `59f1a3b`, `528cb30`). Sarebbe morta di ENOENT — non con un'asserzione che
    // spiega — nel minuto del rilascio, quando la via d'uscita più rapida è
    // cancellare la riga: si perderebbe l'unico lock che lega questa route a un
    // `cron.schedule` esistente, e lo si perderebbe proprio mentre si applica la
    // migrazione che il lock sorveglia. Stessa forma del gemello
    // (`__tests__/api/gdpr-retention-personale.test.ts`).
    //
    // Il nome del job si legge dalla ROUTE e non si ribatte qui: è la stessa
    // stringa che `JOB_CRON` sorveglia, e due copie divergono al primo cambio.
    const nome = /const JOB = '([^']+)'/.exec(SORGENTE_ROUTE)![1]
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const forma = new RegExp(`cron\\.schedule\\(\\s*'${nome}'\\s*,\\s*'([^']+)'`)
    const trovate = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ f, sql: readFileSync(join(dir, f), 'utf8') }))
      .map((x) => ({ ...x, m: forma.exec(x.sql) }))
      .filter((x) => x.m)

    expect(
      trovate.length,
      `In supabase/migrations/ non c'è nessun \`cron.schedule('${nome}', …)\`: questa route non la ` +
        `chiama nessuno. È codice morto, e la voce in \`JOB_CRON\` fa dire a /api/health «job senza ` +
        `battito: ${nome}» per sempre, dal primo deploy. Le due strade, e nessuna terza: (a) scrivere ` +
        'la migrazione e applicarla; (b) togliere la voce da JOB_CRON.',
    ).toBeGreaterThan(0)

    for (const { f, sql, m } of trovate) {
      expect(m![1], `\`${nome}\` è schedulato «${m![1]}» in ${f}: non è giornaliero.`).toMatch(
        /^\d+ \d+ \* \* \*$/,
      )
      expect(sql, `${f} non nomina la rotta che deve chiamare`).toContain(
        '/api/notifiche/scadenze-documenti',
      )
      // Nessun segreto nel file: il repository è pubblico.
      expect(sql, `${f} non prende il segreto dal Vault`).toContain(
        "public.cron_config('app.cron_secret')",
      )
      expect(sql, `${f} sembra contenere un segreto in chiaro`).not.toMatch(
        /x-cron-secret'\s*,\s*'[A-Za-z0-9]/,
      )
    }
  })

  it('il tipo di notifica è nel catalogo, così compare da solo nel pannello', async () => {
    const { TIPI_NOTIFICA } = await import('@/lib/notifiche/tipi')
    const tipo = TIPI_NOTIFICA['documento_personale_in_scadenza']
    expect(tipo, 'senza la voce nel catalogo la notifica non ha interruttore').toBeDefined()
    expect(tipo.gruppo).toBe('staff')
    // …ed è SEPARATA da quella degli alunni: spegnere il promemoria dei certificati
    // dei bambini non deve zittire un obbligo del datore di lavoro.
    expect(TIPI_NOTIFICA['documenti_scadenza']).toBeDefined()
    expect(tipo.label).not.toBe(TIPI_NOTIFICA['documenti_scadenza'].label)
  })

  it('la route non è una quarta scansione dentro `notifiche/promemoria`', () => {
    // Quella route chiude con un battito UNICO per tutte le sue scansioni: un
    // guasto sui documenti del PERSONALE spegnerebbe il battito dei promemoria
    // alle FAMIGLIE, e /api/health direbbe che i moduli non vengono più ricordati.
    const promemoria = readFileSync(
      join(process.cwd(), 'src/app/api/notifiche/promemoria/route.ts'),
      'utf8',
    )
    expect(promemoria).not.toContain('anagrafica_personale')
  })
})
