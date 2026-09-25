import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ID_PER_QUERY } from '@/lib/db/blocchi'

/**
 * PS2 (24/09) — il dispatch estratto in `src/lib/push/dispatch.ts`: presa atomica, ritorno in
 * coda fino a 30', chat allo staff, badge iOS, tetto di tempo del giro.
 *
 * IL FINTO NON È PIATTO. `notifiche` e `push_subscriptions` sono TABELLE IN MEMORIA, e il client
 * finto APPLICA i filtri che il codice gli passa (`is`, `eq`, `in`, `or`, `order`, `limit`) sia
 * alle letture sia agli UPDATE. Così la presa atomica si misura per quello che è: se l'UPDATE
 * della presa perdesse la condizione `push_inviata_il is null`, due giri sovrapposti
 * prenderebbero entrambi tutte le righe e il test dei doppioni diventerebbe rosso. Ogni UPDATE
 * si esegue in un colpo solo dentro il `then`, che è la granularità dell'atomicità di Postgres
 * sulla singola istruzione. Il badge lo calcola la RPC finta CONTANDO le righe non lette della
 * tabella, non un numero cablato.
 *
 * Utenti, sottoscrizioni e testi palesemente finti.
 */

type Riga = Record<string, unknown>

const mem = vi.hoisted(() => {
  const st = {
    notifiche: [] as Riga[],
    push_subscriptions: [] as Riga[],
    utenti: {} as Record<string, { role: string; ruolo: string }>,
    /** Quante letture di `notifiche` devono arrivare prima che una qualunque venga servita. */
    barriera: null as null | { attese: number; arrivate: number; apri: () => void; aperta: Promise<void> },
    rpc: [] as Array<{ nome: string; args: unknown }>,
    rpcErrore: null as unknown,
    /**
     * Interruttore sul modello di `rpcErrore`: l'UPDATE di `notifiche` il cui payload soddisfa
     * `se` NON tocca nessuna riga e risponde `{ data: null, error }`, come fa PostgREST (che non
     * lancia). Serve a provare che il codice legge l'`error` delle due scritture nuove.
     */
    erroreUpdate: null as null | { se: (payload: Riga) => boolean; errore: unknown },
    updateNotifiche: [] as Array<{ payload: Riga; righe: number }>,
    /**
     * Il 414 di PostgREST: un `.in()` con più id di questo tetto finisce in una query string
     * troppo lunga e la richiesta risponde `{ data: null, error }` senza toccare niente, su
     * QUALUNQUE tabella e operazione. `null` = nessun tetto.
     */
    tettoIn: null as number | null,
    /** Quanti id aveva ogni `.in()` che il codice ha costruito. */
    lunghezzeIn: [] as number[],
    /**
     * Chiamato prima di servire ogni query: per far passare il tempo DENTRO una lettura (i
     * ritentativi di postgrest-js sui GET, che il codice non vede).
     */
    primaDiServire: null as null | ((tabella: string, op: string) => void),
  }

  function valore(r: Riga, col: string): unknown {
    return r[col] ?? null
  }

  function parseOr(expr: string): (r: Riga) => boolean {
    const parti = expr.split(',').map((p) => {
      const [col, op, ...resto] = p.split('.')
      const v = resto.join('.')
      if (op === 'is' && v === 'null') return (r: Riga) => valore(r, col) === null
      if (op === 'lte') return (r: Riga) => valore(r, col) !== null && Date.parse(String(valore(r, col))) <= Date.parse(v)
      throw new Error(`or() non supportato dal finto: ${p}`)
    })
    return (r) => parti.some((f) => f(r))
  }

  class Query {
    op: 'select' | 'update' | 'delete' = 'select'
    payload: Riga = {}
    restituisce = false
    filtri: Array<(r: Riga) => boolean> = []
    ordine: { col: string; asc: boolean } | null = null
    limite = Infinity
    erroreIn: unknown = null
    constructor(readonly tabella: 'notifiche' | 'push_subscriptions') {}
    select() {
      if (this.op === 'update') this.restituisce = true
      return this
    }
    update(p: Riga) {
      this.op = 'update'
      this.payload = p
      return this
    }
    delete() {
      this.op = 'delete'
      return this
    }
    is(col: string, v: null) {
      this.filtri.push((r) => valore(r, col) === v)
      return this
    }
    eq(col: string, v: unknown) {
      this.filtri.push((r) => valore(r, col) === v)
      return this
    }
    in(col: string, vs: unknown[]) {
      st.lunghezzeIn.push(vs.length)
      if (st.tettoIn !== null && vs.length > st.tettoIn) {
        this.erroreIn = { code: 'PGRST000', message: '414 Request-URI Too Large', status: 414 }
      }
      this.filtri.push((r) => vs.includes(valore(r, col)))
      return this
    }
    or(expr: string) {
      this.filtri.push(parseOr(expr))
      return this
    }
    order(col: string, o?: { ascending?: boolean }) {
      this.ordine = { col, asc: o?.ascending !== false }
      return this
    }
    limit(n: number) {
      this.limite = n
      return this
    }
    private esegui(): { data: unknown; error: unknown } {
      st.primaDiServire?.(this.tabella, this.op)
      if (this.erroreIn) return { data: null, error: this.erroreIn }
      const righe = st[this.tabella]
      const tocca = righe.filter((r) => this.filtri.every((f) => f(r)))
      if (this.op === 'update') {
        if (this.tabella === 'notifiche' && st.erroreUpdate?.se(this.payload)) {
          return { data: null, error: st.erroreUpdate.errore }
        }
        for (const r of tocca) Object.assign(r, this.payload)
        if (this.tabella === 'notifiche') st.updateNotifiche.push({ payload: { ...this.payload }, righe: tocca.length })
        return { data: this.restituisce ? tocca.map((r) => ({ id: r.id })) : null, error: null }
      }
      if (this.op === 'delete') {
        st[this.tabella] = righe.filter((r) => !tocca.includes(r))
        return { data: null, error: null }
      }
      let out = [...tocca]
      if (this.ordine) {
        const { col, asc } = this.ordine
        out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
      }
      out = out.slice(0, this.limite)
      return {
        data: out.map((r) =>
          this.tabella === 'notifiche' ? { ...r, utenti: st.utenti[String(r.utente_id)] ?? null } : { ...r },
        ),
        error: null,
      }
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      const attesa =
        this.tabella === 'notifiche' && this.op === 'select' && st.barriera
          ? (() => {
              const b = st.barriera!
              b.arrivate++
              if (b.arrivate >= b.attese) b.apri()
              return b.aperta
            })()
          : Promise.resolve()
      return attesa.then(() => this.esegui()).then(res, rej)
    }
  }

  function client() {
    return {
      from: (t: 'notifiche' | 'push_subscriptions') => new Query(t),
      async rpc(nome: string, args: { p_utenti: string[] }) {
        st.rpc.push({ nome, args })
        if (st.rpcErrore) return { data: null, error: st.rpcErrore }
        if (nome !== 'notifiche_non_lette_per_utente') return { data: null, error: { code: 'PGRST202' } }
        const conti = new Map<string, number>()
        for (const r of st.notifiche) {
          if (r.letta_il == null && args.p_utenti.includes(String(r.utente_id))) {
            conti.set(String(r.utente_id), (conti.get(String(r.utente_id)) ?? 0) + 1)
          }
        }
        return { data: [...conti].map(([utente_id, non_lette]) => ({ utente_id, non_lette })), error: null }
      },
    }
  }

  function barriera(attese: number) {
    let apri = () => {}
    const aperta = new Promise<void>((r) => (apri = r))
    st.barriera = { attese, arrivate: 0, apri, aperta }
  }

  return { st, client, barriera }
})

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn(async () => mem.client()) }))
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
const web = vi.hoisted(() => ({ sendPush: vi.fn(), vapidConfigured: vi.fn() }))
vi.mock('@/lib/push/web-push', () => web)
const native = vi.hoisted(() => ({ sendNativePush: vi.fn(), fcmConfigured: vi.fn() }))
vi.mock('@/lib/push/native-push', () => native)

import {
  eseguiDispatch,
  FINESTRA_CODA_MS,
  TETTO_GIRO_MS,
  SOGLIA_PRESA_MS,
  BUDGET_RITENTATIVI_MS,
  TIPI_CHAT,
  type DatiDispatch,
} from '@/lib/push/dispatch'

const MIN = 60_000
/** Il sorgente senza commenti (blocco e riga intera): un lock non si immunizza col proprio commento. */
const senzaCommenti = (sorgente: string) => sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const iso =(msFa: number) => new Date(Date.now() - msFa).toISOString()

function notifica(id: string, utente_id: string, extra: Riga = {}): Riga {
  return {
    id,
    utente_id,
    tipo: 'avviso_generico',
    titolo: `titolo-${id}`,
    corpo: null,
    link: '/x',
    letta_il: null,
    push_inviata_il: null,
    creato_il: iso(2 * MIN),
    invio_programmato_il: iso(MIN),
    ...extra,
  }
}
const subWeb = (id: string, utente_id: string): Riga => ({
  id,
  utente_id,
  endpoint: `endpoint-${id}`,
  p256dh: 'p',
  auth: 'a',
  platform: 'web',
})
const subNativa = (id: string, utente_id: string, platform: 'ios' | 'android'): Riga => ({
  id,
  utente_id,
  endpoint: `token-${id}`,
  p256dh: null,
  auth: null,
  platform,
})

const riga = (id: string) => mem.st.notifiche.find((r) => r.id === id)!
const dati = (e: Awaited<ReturnType<typeof eseguiDispatch>>): DatiDispatch => {
  expect(e.stato).toBe(200)
  return (e as { data: DatiDispatch }).data
}
const righeLog = (livello: string, esito: string) =>
  log.logEvento.mock.calls.filter((c) => c[1] === livello && (c[2] as Riga).esito === esito).map((c) => c[2] as Riga)

const TRANSITORIO = { ok: false, error: 'fcm_503: {"error":{"status":"UNAVAILABLE"}}', ritentabile: true, tentativi: 3 }
const DEFINITIVO = { ok: false, error: 'fcm_400: {"error":{"status":"INVALID_ARGUMENT"}}', ritentabile: false, tentativi: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  mem.st.notifiche = []
  mem.st.push_subscriptions = []
  mem.st.utenti = {}
  mem.st.barriera = null
  mem.st.rpc = []
  mem.st.rpcErrore = null
  mem.st.erroreUpdate = null
  mem.st.updateNotifiche = []
  mem.st.tettoIn = null
  mem.st.lunghezzeIn = []
  mem.st.primaDiServire = null
  web.vapidConfigured.mockReturnValue(true)
  web.sendPush.mockResolvedValue({ ok: true })
  native.fcmConfigured.mockReturnValue(true)
  native.sendNativePush.mockResolvedValue({ ok: true, tentativi: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('presa atomica: due giri sovrapposti non spediscono mai la stessa notifica', () => {
  it('due giri che leggono INSIEME la stessa coda: ogni notifica parte una volta sola', async () => {
    mem.st.notifiche = [notifica('n1', 'u1'), notifica('n2', 'u1'), notifica('n3', 'u2')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1'), subWeb('s2', 'u2')]
    // Nessuna lettura viene servita finché non sono arrivate TUTTE E DUE: entrambi i giri
    // vedono le tre notifiche in coda, come il cron e la chat che partono nello stesso secondo.
    mem.barriera(2)

    const [a, b] = await Promise.all([eseguiDispatch({ origine: 'cron' }), eseguiDispatch({ origine: 'chat' })])
    const da = dati(a)
    const db = dati(b)

    const tag = web.sendPush.mock.calls.map((c) => (c[1] as { tag: string }).tag).sort()
    expect(tag).toEqual(['n1', 'n2', 'n3'])
    // Uno dei due le ha prese tutte, l'altro le ha trovate già prese.
    expect(da.notifiche + db.notifiche).toBe(3)
    expect(da.gia_prese + db.gia_prese).toBe(3)
    expect([da.notifiche, db.notifiche].sort()).toEqual([0, 3])
    for (const id of ['n1', 'n2', 'n3']) expect(riga(id).push_inviata_il).not.toBeNull()
  })

  it('la presa avviene PRIMA dell\'invio: durante la spedizione la riga è già marcata', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]
    let marcataDuranteInvio: unknown = 'non chiamato'
    web.sendPush.mockImplementation(async () => {
      marcataDuranteInvio = riga('n1').push_inviata_il
      return { ok: true }
    })
    await eseguiDispatch()
    expect(typeof marcataDuranteInvio).toBe('string')
  })

  it('una notifica già presa da un altro giro non si rispedisce', async () => {
    mem.st.notifiche = [notifica('n1', 'u1', { push_inviata_il: iso(1000) }), notifica('n2', 'u1')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]
    const d = dati(await eseguiDispatch())
    expect(web.sendPush).toHaveBeenCalledTimes(1)
    expect((web.sendPush.mock.calls[0][1] as { tag: string }).tag).toBe('n2')
    expect(d.notifiche).toBe(1)
  })

  it('il battito del cron resta `push-dispatch`; quello della chat ha un nome suo', async () => {
    // Se la chat scrivesse il battito del cron, `/api/health` vedrebbe vivo un cron fermo.
    mem.st.notifiche = []
    await eseguiDispatch({ origine: 'chat' })
    await eseguiDispatch({ origine: 'cron' })
    const ok = log.logEvento.mock.calls.filter((c) => (c[2] as Riga).esito === 'ok')
    expect(ok.map((c) => [c[0], (c[2] as Riga).operazione])).toEqual([
      ['push', 'push-dispatch-chat'],
      ['cron', 'push-dispatch'],
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('errori transitori: la notifica torna in coda fino a 30 minuti dalla programmazione', () => {
  it('tutti i dispositivi con errore ritentabile, entro 30\' → torna in coda e il giro dopo la consegna', async () => {
    mem.st.notifiche = [notifica('n1', 'u1', { invio_programmato_il: iso(5 * MIN) })]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios'), subNativa('s2', 'u1', 'android')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)

    const d1 = dati(await eseguiDispatch())
    expect(native.sendNativePush).toHaveBeenCalledTimes(2)
    expect(riga('n1').push_inviata_il).toBeNull()
    expect(d1).toMatchObject({ rimesse_in_coda: 1, notifiche: 0, arrese: 0, fallite: 2 })
    expect(righeLog('warn', 'invii-rifiutati')[0]).toMatchObject({ fallite: 2, rimesse_in_coda: 1 })

    // Il giro dopo la ripesca, e questa volta FCM risponde.
    native.sendNativePush.mockResolvedValue({ ok: true, tentativi: 1 })
    const d2 = dati(await eseguiDispatch())
    expect(d2).toMatchObject({ native_inviate: 2, notifiche: 1, rimesse_in_coda: 0 })
    expect(riga('n1').push_inviata_il).not.toBeNull()
  })

  it('oltre i 30\' dalla programmazione ci si arrende: resta marcata e una riga `error` lo dice', async () => {
    mem.st.notifiche = [notifica('n1', 'u1', { creato_il: iso(FINESTRA_CODA_MS + 2 * MIN), invio_programmato_il: iso(FINESTRA_CODA_MS + MIN) })]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)

    const d = dati(await eseguiDispatch())
    expect(riga('n1').push_inviata_il).not.toBeNull()
    expect(d).toMatchObject({ arrese: 1, rimesse_in_coda: 0, notifiche: 1 })
    expect(righeLog('error', 'resa-dopo-30-minuti')).toEqual([expect.objectContaining({ arrese: 1 })])
  })

  it('i 30\' si contano dalla PROGRAMMAZIONE, non dalla creazione', async () => {
    // Creata 40' fa con un buffer: programmata 10' fa → è ancora nella finestra.
    mem.st.notifiche = [notifica('n1', 'u1', { creato_il: iso(40 * MIN), invio_programmato_il: iso(10 * MIN) })]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'android')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)
    const d = dati(await eseguiDispatch())
    expect(d.rimesse_in_coda).toBe(1)
    expect(riga('n1').push_inviata_il).toBeNull()
  })

  it('senza programmazione i 30\' partono dalla creazione', async () => {
    mem.st.notifiche = [notifica('n1', 'u1', { creato_il: iso(FINESTRA_CODA_MS + MIN), invio_programmato_il: null })]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'android')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)
    const d = dati(await eseguiDispatch())
    expect(d.arrese).toBe(1)
    expect(riga('n1').push_inviata_il).not.toBeNull()
  })

  it('basta UN dispositivo che l\'ha ricevuta: resta marcata (niente doppione su quel telefono)', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios'), subWeb('s2', 'u1')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)
    const d = dati(await eseguiDispatch())
    expect(d).toMatchObject({ inviate: 1, rimesse_in_coda: 0, notifiche: 1 })
    expect(riga('n1').push_inviata_il).not.toBeNull()
  })

  it('un rifiuto DEFINITIVO insieme a uno transitorio: resta marcata (non si ritenta)', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios'), subNativa('s2', 'u1', 'android')]
    native.sendNativePush.mockResolvedValueOnce(TRANSITORIO).mockResolvedValueOnce(DEFINITIVO)
    const d = dati(await eseguiDispatch())
    expect(d).toMatchObject({ rimesse_in_coda: 0, notifiche: 1, fallite: 2 })
    expect(riga('n1').push_inviata_il).not.toBeNull()
  })

  it('un dispositivo morto non impedisce il ritorno in coda, e si rimuove', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios'), subNativa('s2', 'u1', 'android')]
    native.sendNativePush.mockResolvedValueOnce({ ok: false, gone: true, tentativi: 1 }).mockResolvedValueOnce(TRANSITORIO)
    const d = dati(await eseguiDispatch())
    expect(d).toMatchObject({ rimesse_in_coda: 1, subs_rimosse: 1 })
    expect(riga('n1').push_inviata_il).toBeNull()
    expect(mem.st.push_subscriptions.map((s) => s.id)).toEqual(['s2'])
  })

  it('il ritorno in coda annulla SOLO la presa di questo giro', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios')]
    native.sendNativePush.mockImplementation(async () => {
      // Mentre questo giro spedisce, qualcosa riscrive la marca (un altro giro, un intervento a
      // mano): il ritorno in coda non deve cancellare una marca che non è la sua.
      riga('n1').push_inviata_il = '2000-01-01T00:00:00.000Z'
      return TRANSITORIO
    })
    await eseguiDispatch()
    expect(riga('n1').push_inviata_il).toBe('2000-01-01T00:00:00.000Z')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('la chat arriva in push anche allo staff (eccezione a RUOLI_PUSH_SOLO_CODA)', () => {
  it.each(['admin', 'coordinator', 'segreteria', 'cuoca'])(
    '%s: le due chat partono col titolo e il corpo della riga (il mittente è nel corpo); un tipo col nome di una persona no',
    async (ruolo) => {
      // La forma VERA della riga che scrive `src/app/api/chat/messages/route.ts`: titolo fisso,
      // mittente nel corpo. Dati finti.
      mem.st.utenti = { 'u-staff': { role: ruolo, ruolo } }
      mem.st.notifiche = [
        notifica('n-chat-g', 'u-staff', {
          tipo: 'chat_genitore',
          titolo: 'Nuovo messaggio in chat',
          corpo: 'Hai un nuovo messaggio da Mittente Finto',
        }),
        notifica('n-chat-d', 'u-staff', {
          tipo: 'chat_docente',
          titolo: 'Nuovo messaggio in chat',
          corpo: 'Hai un nuovo messaggio da Altro Mittente Finto',
        }),
        notifica('n-onb', 'u-staff', { tipo: 'onboarding_completato' }),
      ]
      mem.st.push_subscriptions = [subWeb('s1', 'u-staff')]
      const d = dati(await eseguiDispatch())
      const inviate = web.sendPush.mock.calls.map((c) => c[1] as { tag: string; title: string; body?: string })
      expect(inviate.map((p) => p.tag).sort()).toEqual(['n-chat-d', 'n-chat-g'])
      expect(inviate.find((p) => p.tag === 'n-chat-g')).toMatchObject({
        title: 'Nuovo messaggio in chat',
        body: 'Hai un nuovo messaggio da Mittente Finto',
      })
      expect(inviate.find((p) => p.tag === 'n-chat-d')).toMatchObject({
        title: 'Nuovo messaggio in chat',
        body: 'Hai un nuovo messaggio da Altro Mittente Finto',
      })
      expect(d).toMatchObject({ inviate: 2, escluse_staff: 1, notifiche: 3 })
      // Anche l'esclusa è chiusa: marcata come chi non ha dispositivi.
      expect(riga('n-onb').push_inviata_il).not.toBeNull()
    },
  )

  it('i tipi della chat sono esattamente quelli che la route dei messaggi scrive', () => {
    // Si legge la route come TESTO, senza i commenti: un commento che citasse un tipo non deve
    // bastare a tenere verde il lock. Se la route cambiasse o aggiungesse un tipo di chat,
    // `TIPI_CHAT` resterebbe indietro e la chat allo staff smetterebbe di arrivare in silenzio.
    const sorgente = readFileSync(join(process.cwd(), 'src', 'app', 'api', 'chat', 'messages', 'route.ts'), 'utf8')
    const scritti = new Set<string>()
    for (const assegnazione of senzaCommenti(sorgente).matchAll(/\btipo:\s*([^\n]*)/g)) {
      for (const letterale of assegnazione[1].matchAll(/['"`](chat_[a-z_]+)['"`]/g)) scritti.add(letterale[1])
    }
    // Almeno una corrispondenza: se la regex non trovasse più niente il lock non resta verde a vuoto.
    expect(scritti.size).toBeGreaterThan(0)
    expect([...scritti].sort()).toEqual([...TIPI_CHAT].sort())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('badge iOS: le notifiche non lette di ciascun destinatario', () => {
  it('una sola RPC per giro, solo per chi ha un iPhone; il numero conta le NON LETTE', async () => {
    mem.st.notifiche = [
      notifica('n1', 'u1'),
      notifica('n2', 'u2'),
      notifica('n3', 'u3'),
      // Già spedite ma non lette: contano nel badge.
      notifica('v1', 'u1', { push_inviata_il: iso(MIN) }),
      notifica('v2', 'u1', { push_inviata_il: iso(MIN) }),
      // Lette: non contano.
      notifica('l1', 'u1', { push_inviata_il: iso(MIN), letta_il: iso(MIN) }),
      notifica('l2', 'u2', { push_inviata_il: iso(MIN), letta_il: iso(MIN) }),
    ]
    mem.st.push_subscriptions = [
      subNativa('s1', 'u1', 'ios'),
      subNativa('s2', 'u2', 'ios'),
      subNativa('s3', 'u3', 'android'),
      subWeb('s4', 'u1'),
    ]
    await eseguiDispatch()

    expect(mem.st.rpc).toHaveLength(1)
    expect(mem.st.rpc[0].nome).toBe('notifiche_non_lette_per_utente')
    expect([...(mem.st.rpc[0].args as { p_utenti: string[] }).p_utenti].sort()).toEqual(['u1', 'u2'])

    const perToken = new Map(native.sendNativePush.mock.calls.map((c) => [c[0] as string, c[2] as { badge?: number }]))
    expect(perToken.get('token-s1')?.badge).toBe(3)
    expect(perToken.get('token-s2')?.badge).toBe(1)
    // Il telefono Android e il web non portano il badge.
    expect(perToken.get('token-s3')?.badge).toBeUndefined()
    expect((web.sendPush.mock.calls[0][1] as Riga).badge).toBeUndefined()
  })

  it('se il conto non riesce la push parte lo stesso, SENZA badge, e una riga `warn` lo dice', async () => {
    mem.st.rpcErrore = { code: 'PGRST202', message: 'Could not find the function' }
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios')]
    const d = dati(await eseguiDispatch())
    expect(d.native_inviate).toBe(1)
    expect((native.sendNativePush.mock.calls[0][2] as Riga).badge).toBeUndefined()
    const w = log.logEvento.mock.calls.filter((c) => (c[2] as Riga).esito === 'badge-non-calcolato')
    expect(w).toHaveLength(1)
    expect(w[0][1]).toBe('warn')
    expect(w[0][3]).toBe(mem.st.rpcErrore)
  })

  it('nessun iPhone fra i destinatari → nessuna RPC', async () => {
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1'), subNativa('s2', 'u1', 'android')]
    await eseguiDispatch()
    expect(mem.st.rpc).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('il tetto di tempo del giro: presa sì, persa no', () => {
  it('oltre il tetto le notifiche prese e non tentate tornano in coda', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mem.st.notifiche = [notifica('n1', 'u1', { creato_il: iso(3 * MIN) }), notifica('n2', 'u1')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]
    web.sendPush.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + TETTO_GIRO_MS + 1_000)
      return { ok: true }
    })
    const d = dati(await eseguiDispatch())
    expect(web.sendPush).toHaveBeenCalledTimes(1)
    expect(d).toMatchObject({ notifiche: 1, rinviate_per_tempo: 1 })
    expect(riga('n1').push_inviata_il).not.toBeNull()
    expect(riga('n2').push_inviata_il).toBeNull()
    expect(righeLog('warn', 'tetto-di-tempo')).toEqual([expect.objectContaining({ rinviate_per_tempo: 1 })])
  })

  it('le letture prima della presa superano la soglia: niente preso, niente spedito, tutto in coda, riga `warn`', async () => {
    // La lettura dei dispositivi è un GET: postgrest-js la ritenta da solo, e il tempo passa
    // DENTRO la query senza che il codice lo veda. Senza il controllo prima della presa, il giro
    // prenderebbe le notifiche a una Function forse già al limite: l'UPDATE di presa partirebbe.
    vi.useFakeTimers({ toFake: ['Date'] })
    mem.st.notifiche = [notifica('n1', 'u1'), notifica('n2', 'u2')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1'), subNativa('s2', 'u2', 'ios')]
    mem.st.primaDiServire = (tabella, op) => {
      if (tabella === 'push_subscriptions' && op === 'select') vi.setSystemTime(Date.now() + SOGLIA_PRESA_MS + 1_000)
    }

    const e = await eseguiDispatch()

    expect(mem.st.updateNotifiche).toEqual([])
    expect(mem.st.notifiche.every((r) => r.push_inviata_il === null)).toBe(true)
    expect(web.sendPush).not.toHaveBeenCalled()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(mem.st.rpc).toHaveLength(0)
    expect(righeLog('warn', 'tetto-prima-della-presa')).toEqual([expect.objectContaining({ candidate: 2 })])
    // Nessun guasto e nessuna perdita: 200, contatori a zero, e il battito «ok» del cron.
    expect(dati(e)).toMatchObject({ notifiche: 0, inviate: 0, native_inviate: 0, rinviate_per_tempo: 0 })
    expect(righeLog('info', 'ok')).toEqual([expect.objectContaining({ operazione: 'push-dispatch', candidate: 2 })])
  })

  it('le letture restano sotto la soglia: la presa e gli invii partono come sempre', async () => {
    // Il contrario del test sopra: il controllo non deve scattare prima della soglia.
    vi.useFakeTimers({ toFake: ['Date'] })
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]
    mem.st.primaDiServire = (tabella, op) => {
      if (tabella === 'push_subscriptions' && op === 'select') vi.setSystemTime(Date.now() + SOGLIA_PRESA_MS - 1_000)
    }
    const d = dati(await eseguiDispatch())
    expect(d).toMatchObject({ inviate: 1, notifiche: 1 })
    expect(riga('n1').push_inviata_il).not.toBeNull()
    expect(righeLog('warn', 'tetto-prima-della-presa')).toEqual([])
  })

  it('oltre il budget dei ritentativi gli invii nativi non aspettano i ritentativi immediati', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mem.st.notifiche = [notifica('n1', 'u1', { creato_il: iso(3 * MIN) }), notifica('n2', 'u2')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'android'), subNativa('s2', 'u2', 'android')]
    native.sendNativePush.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + BUDGET_RITENTATIVI_MS + 1_000)
      return { ok: true, tentativi: 1 }
    })
    await eseguiDispatch()
    expect(native.sendNativePush.mock.calls[0][3]).toBeUndefined()
    expect(native.sendNativePush.mock.calls[1][3]).toEqual({ maxRitentativi: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('le due scritture nuove leggono il `{ error }` di PostgREST (che non lancia)', () => {
  const ERRORE_DB = { code: '57014', message: 'canceling statement due to statement timeout' }
  const righeOk = () => log.logEvento.mock.calls.filter((c) => (c[2] as Riga).esito === 'ok')

  it('la PRESA fallisce: 500, nessun invio, righe ancora in coda, riga `error` e nessun «ok»', async () => {
    // Senza il controllo, `preseIds` resterebbe null, `prese` vuota e il battito chiuderebbe
    // con «ok» e `gia_prese = N`: una bugia attiva, con le notifiche mai spedite.
    mem.st.erroreUpdate = { se: (p) => p.push_inviata_il !== null, errore: ERRORE_DB }
    mem.st.notifiche = [notifica('n1', 'u1'), notifica('n2', 'u2')]
    mem.st.push_subscriptions = [subWeb('s1', 'u1'), subNativa('s2', 'u2', 'ios')]

    const e = await eseguiDispatch()

    expect(e.stato).toBe(500)
    expect(web.sendPush).not.toHaveBeenCalled()
    expect(native.sendNativePush).not.toHaveBeenCalled()
    expect(riga('n1').push_inviata_il).toBeNull()
    expect(riga('n2').push_inviata_il).toBeNull()
    const err = righeLog('error', 'query-fallita')
    expect(err).toEqual([expect.objectContaining({ azione: 'presa notifiche' })])
    expect(righeOk()).toHaveLength(0)
  })

  it('il RITORNO IN CODA fallisce: 500, riga `error`, nessun «ok» — e la resa, i rifiuti e i dispositivi morti si registrano lo stesso', async () => {
    // Senza il controllo le notifiche resterebbero marcate per sempre, mai più ritentate, e il
    // battito direbbe «ok». E uscire SUBITO dal giro muterebbe la riga della resa: le notifiche
    // arrese in questo stesso giro sono perse, e quella riga è l'unica che lo dice.
    mem.st.erroreUpdate = { se: (p) => p.push_inviata_il === null, errore: ERRORE_DB }
    mem.st.notifiche = [
      notifica('n1', 'u1', { invio_programmato_il: iso(5 * MIN) }),
      // Oltre i 30': nello stesso giro ci si arrende.
      notifica('n2', 'u2', { creato_il: iso(FINESTRA_CODA_MS + 2 * MIN), invio_programmato_il: iso(FINESTRA_CODA_MS + MIN) }),
    ]
    mem.st.push_subscriptions = [
      subNativa('s1', 'u1', 'android'),
      subNativa('s-morta', 'u1', 'ios'),
      subNativa('s2', 'u2', 'android'),
    ]
    native.sendNativePush.mockImplementation(async (token: string) =>
      token === 'token-s-morta' ? { ok: false, gone: true, tentativi: 1 } : TRANSITORIO,
    )

    const e = await eseguiDispatch()

    expect(e.stato).toBe(500)
    expect(native.sendNativePush).toHaveBeenCalledTimes(3)
    // La presa è riuscita, il ritorno no: la riga resta marcata, ed è per questo che serve la voce.
    expect(riga('n1').push_inviata_il).not.toBeNull()
    expect(riga('n2').push_inviata_il).not.toBeNull()
    expect(righeLog('error', 'resa-dopo-30-minuti')).toEqual([expect.objectContaining({ arrese: 1 })])
    expect(righeLog('warn', 'invii-rifiutati')).toEqual([expect.objectContaining({ fallite: 2 })])
    // Il dispositivo morto si rimuove anche quando il ritorno in coda è fallito.
    expect(mem.st.push_subscriptions.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    const err = righeLog('error', 'query-fallita')
    expect(err).toEqual([expect.objectContaining({ azione: 'ritorno in coda', arrese: 1, rimesse_in_coda: 1 })])
    expect(righeOk()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('ogni `.in()` a blocchi di ID_PER_QUERY (il 414 di PostgREST)', () => {
  // Il finto risponde `{ error }` a un `.in()` più lungo del tetto, come un proxy davanti a
  // PostgREST con una query string da ~18,5 kB. Con una presa in un colpo solo la coda si
  // fermerebbe per sempre: la lettura dopo ripescherebbe sempre le stesse righe.
  const MOLTE = ID_PER_QUERY + 50

  it(`${MOLTE} notifiche in coda: tutte prese e spedite, nessun \`.in()\` oltre il tetto`, async () => {
    mem.st.tettoIn = ID_PER_QUERY
    mem.st.notifiche = Array.from({ length: MOLTE }, (_, i) => notifica(`n${i}`, 'u1'))
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]
    const d = dati(await eseguiDispatch())
    expect(web.sendPush).toHaveBeenCalledTimes(MOLTE)
    expect(d).toMatchObject({ notifiche: MOLTE, gia_prese: 0 })
    expect(mem.st.notifiche.every((r) => r.push_inviata_il !== null)).toBe(true)
    expect(Math.max(...mem.st.lunghezzeIn)).toBeLessThanOrEqual(ID_PER_QUERY)
  })

  it(`${MOLTE} destinatari diversi: anche la lettura dei dispositivi va a blocchi`, async () => {
    mem.st.tettoIn = ID_PER_QUERY
    mem.st.notifiche = Array.from({ length: MOLTE }, (_, i) => notifica(`n${i}`, `u${i}`))
    mem.st.push_subscriptions = Array.from({ length: MOLTE }, (_, i) => subWeb(`s${i}`, `u${i}`))
    const d = dati(await eseguiDispatch())
    expect(web.sendPush).toHaveBeenCalledTimes(MOLTE)
    expect(d.inviate).toBe(MOLTE)
  })

  it(`${MOLTE} notifiche da rimettere in coda: anche il ritorno va a blocchi`, async () => {
    mem.st.tettoIn = ID_PER_QUERY
    mem.st.notifiche = Array.from({ length: MOLTE }, (_, i) => notifica(`n${i}`, 'u1'))
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'android')]
    native.sendNativePush.mockResolvedValue(TRANSITORIO)
    const d = dati(await eseguiDispatch())
    expect(d.rimesse_in_coda).toBe(MOLTE)
    expect(mem.st.notifiche.every((r) => r.push_inviata_il === null)).toBe(true)
  })

  it('la presa si rompe al SECONDO blocco: il primo si spedisce, il resto resta in coda, 500 e riga `error`', async () => {
    // Le righe del primo blocco sono già prese: lasciarle lì senza spedirle vorrebbe dire
    // perderle. Si spediscono, e il giro chiude con l'errore invece dell'«ok».
    let prese = 0
    mem.st.erroreUpdate = {
      se: (p) => p.push_inviata_il !== null && ++prese === 2,
      errore: { code: '57014', message: 'canceling statement due to statement timeout' },
    }
    mem.st.notifiche = Array.from({ length: MOLTE }, (_, i) => notifica(`n${i}`, 'u1'))
    mem.st.push_subscriptions = [subWeb('s1', 'u1')]

    const e = await eseguiDispatch()

    expect(e.stato).toBe(500)
    const marcate = mem.st.notifiche.filter((r) => r.push_inviata_il !== null).map((r) => String(r.id))
    expect(marcate).toHaveLength(ID_PER_QUERY)
    expect(mem.st.notifiche.filter((r) => r.push_inviata_il === null)).toHaveLength(MOLTE - ID_PER_QUERY)
    const spedite = web.sendPush.mock.calls.map((c) => (c[1] as { tag: string }).tag)
    expect(spedite.sort()).toEqual(marcate.sort())
    expect(righeLog('error', 'query-fallita')).toEqual([
      expect.objectContaining({ azione: 'presa notifiche', inviate: ID_PER_QUERY }),
    ])
    expect(log.logEvento.mock.calls.filter((c) => (c[2] as Riga).esito === 'ok')).toHaveLength(0)
  })
})

// Il lock sul `maxDuration` delle route che chiamano il dispatch sta in
// `__tests__/lib/push-dispatch-durata.test.ts`: ha bisogno del vero `native-push` (le costanti dei
// ritentativi), che questo file sostituisce con un finto.

// ═══════════════════════════════════════════════════════════════════════════
describe('le scritture: nessuna presa se non c\'è niente da prendere', () => {
  it('canale nativo spento e solo destinatari nativi: nessun UPDATE, la notifica resta in coda', async () => {
    native.fcmConfigured.mockReturnValue(false)
    mem.st.notifiche = [notifica('n1', 'u1')]
    mem.st.push_subscriptions = [subNativa('s1', 'u1', 'ios')]
    await eseguiDispatch()
    expect(mem.st.updateNotifiche).toHaveLength(0)
    expect(riga('n1').push_inviata_il).toBeNull()
    expect(righeLog('error', 'canale-non-configurato')).toEqual([expect.objectContaining({ rimandate: 1, saltate_native: 1 })])
  })
})
