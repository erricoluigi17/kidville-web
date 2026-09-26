import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'

// =============================================================================
// K3 — Cassa: LETTURA unita delle sedi (2026-09-26).
//
// Decisione del titolare: con più sedi selezionate la Cassa si LEGGE insieme —
// ogni sede resta un cassetto a sé (fondo, saldo, svuotamento) — mentre le
// SCRITTURE restano per sede. Le cinque GET della cassa (movimenti, saldo,
// chiusura, report, categorie) passano da `resolveScuolaScrittura` (una sede,
// 400 se ambiguo) a `resolveScuoleAttive` + `restringiSedi` (tutte le sedi
// attive, oppure quella chiesta, e 403 se non è fra le proprie).
//
// Il client Supabase è quello FINTO che applica davvero i filtri: un mock piatto
// sarebbe verde anche senza `.in('scuola_id', …)`, cioè anche se la route
// mostrasse la sede C — che l'utente non ha — insieme alle sue.
//
// E corregge un difetto: il riquadro «Uscite del mese» sommava le uscite di
// SEMPRE (totali sul set filtrato, e la UI non passa da/a). Ora il server
// calcola `uscite_mese` sul mese corrente di Europe/Rome, a prescindere dai
// filtri della lista.
// =============================================================================

const h = vi.hoisted(() => ({
  ruolo: 'admin' as string,
  attive: [] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  lette: [] as string[],
  opzioni: {} as Record<string, unknown>,
  fondi: {} as Record<string, number>,
  // Sedi il cui cassetto `caricaSaldoCassa` dichiara NON disponibile (le altre
  // passano dalla funzione vera): serve al caso misto del saldo.
  saldoNonDisponibile: new Set<string>(),
  // Guasto della SOLA query delle uscite del mese (la lista resta leggibile).
  guastoUsciteMese: false,
  // L'embed `pagamenti` degli incassi non viene filtrato per sede (dato sporco).
  incassiSenzaFiltroSede: false,
  verificaSoglia: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'u-1', role: h.ruolo, scuola_id: h.attive[0] ?? null } })
  },
}))
// Lo scope vero per `restringiSedi` (è la funzione che decide il 403): si finge
// solo `resolveScuoleAttive`, cioè «quali sedi ha questo utente».
vi.mock('@/lib/auth/scope', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/scope')>()
  return {
    ...vero,
    resolveScuoleAttive: async () => [...h.attive],
    resolveScuolaScrittura: async () => {
      throw new Error('una GET della cassa non deve più passare da resolveScuolaScrittura')
    },
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabase(h.db as DBFinto, h.lette, h.opzioni as OpzioniFinto)
    return h.guastoUsciteMese || h.incassiSenzaFiltroSede ? conGuasti(client) : client
  },
}))
// `caricaSaldoCassa` VERA per tutte le sedi, tranne quelle in `h.saldoNonDisponibile`:
// il finto inietta errori per tabella, non per sede, e il caso misto (A sì, B no)
// ha bisogno di un cassetto guasto accanto a uno sano.
vi.mock('@/lib/cassa/saldo', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/cassa/saldo')>()
  return {
    ...vero,
    caricaSaldoCassa: (supabase: unknown, scuolaId: string, fondo: number) =>
      h.saldoNonDisponibile.has(scuolaId)
        ? Promise.resolve({ disponibile: false })
        : vero.caricaSaldoCassa(supabase as Parameters<typeof vero.caricaSaldoCassa>[0], scuolaId, fondo),
  }
})
vi.mock('@/lib/settings/module-config', () => ({
  getModuleConfig: async (_s: unknown, _k: string, scuolaId: string) =>
    h.fondi[scuolaId] != null ? { fondo: h.fondi[scuolaId] } : {},
}))
vi.mock('@/lib/cassa/notifiche', () => ({
  verificaSogliaCassa: (...a: unknown[]) => h.verificaSoglia(...a),
  notificaUscitaNonAdmin: async () => undefined,
}))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...vero, logOk: () => {}, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { GET as movimentiGET } from '@/app/api/pagamenti/cassa/movimenti/route'
import { GET as saldoGET } from '@/app/api/pagamenti/cassa/saldo/route'
import { GET as chiusuraGET } from '@/app/api/pagamenti/cassa/chiusura/route'
import { GET as reportGET } from '@/app/api/pagamenti/cassa/report/route'
import { GET as categorieGET } from '@/app/api/pagamenti/cassa/categorie/route'
import { meseCorrenteRoma } from '@/lib/cassa/lettura-multisede'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

const CAT_PAG = 'dddddddd-0000-4000-8000-00000000000d'
const req = (percorso: string, qs = '') =>
  new NextRequest(`http://localhost/api/pagamenti/cassa/${percorso}${qs ? `?${qs}` : ''}`, { headers: { 'x-user-id': 'u-1' } })

// Guasto mirato: solo la query delle uscite del mese (`select('scuola_id, importo')`
// su cassa_movimenti) risponde { error }. Il finto inietta errori per tabella, e la
// lista legge la STESSA tabella: un errore per tabella romperebbe anche lei.
// Se un giorno la route cambia quella select, il guasto non scatta e il test
// diventa rosso (uscite_mese torna un oggetto): fallisce dal lato sicuro.
const ERRORE_USCITE_MESE = { code: 'XX000', message: 'uscite del mese illeggibili' }
function builderInErrore(): unknown {
  const b: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === 'then') {
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: ERRORE_USCITE_MESE }).then(ok, ko)
        }
        return () => b
      },
    },
  )
  return b
}
type Metodo = (...a: unknown[]) => unknown
/** Avvolge un builder: `intercetta(nome, originale)` può sostituire un metodo; gli
 *  altri passano. Il risultato di ogni metodo è riavvolto, così la catena resta sotto. */
function avvolgiBuilder(q: object, intercetta: (nome: string | symbol, orig: Metodo, self: object) => Metodo | null): object {
  return new Proxy(q, {
    get(qt, qp, qr) {
      const m = Reflect.get(qt, qp, qr)
      if (typeof m !== 'function' || qp === 'then') return typeof m === 'function' ? (m as Metodo).bind(qt) : m
      const sostituto = intercetta(qp, (m as Metodo).bind(qt), qt)
      if (sostituto) return sostituto
      return (...a: unknown[]) => {
        const out = (m as Metodo).apply(qt, a)
        return out && typeof out === 'object' ? avvolgiBuilder(out, intercetta) : out
      }
    },
  })
}
function conGuasti<T extends object>(client: T): T {
  return new Proxy(client, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r)
      if (p !== 'from' || typeof v !== 'function') return v
      return (tabella: string) => {
        const q = (v as (tab: string) => object).call(t, tabella)
        if (tabella === 'cassa_movimenti' && h.guastoUsciteMese) {
          return avvolgiBuilder(q, (nome, orig) =>
            nome === 'select'
              ? (colonne: unknown, ...resto: unknown[]) => (colonne === 'scuola_id, importo' ? builderInErrore() : orig(colonne, ...resto))
              : null,
          )
        }
        if (tabella === 'incassi' && h.incassiSenzaFiltroSede) {
          // Il filtro sulla sede dell'embed diventa un no-op: arriva alla route
          // anche l'incasso il cui pagamento non ha sede (dato sporco).
          return avvolgiBuilder(q, (nome, _orig, self) =>
            nome === 'in' ? (col: unknown, ...resto: unknown[]) => (col === 'pagamenti.scuola_id' ? self : (_orig as Metodo)(col, ...resto)) : null,
          )
        }
        return q
      }
    },
  })
}

/** Il 403 su una sede fuori perimetro lascia il segnale di sicurezza persistito:
 *  `warn` `sede-filtro-fuori-scope`, con la sede chiesta e il numero di sedi attive. */
function atteseLogFuoriScope(operazione: string) {
  expect(h.logEvento).toHaveBeenCalledWith('multi_sede', 'warn', {
    operazione,
    esito: 'sede-filtro-fuori-scope',
    utente: 'u-1',
    ruolo: h.ruolo,
    sede_id: SEDE_C,
    sedi_attive: h.attive.length,
  })
}

// Date calcolate, mai cablate: un test con «settembre 2026» scritto dentro
// diventerebbe rosso da solo il 1° ottobre (lezione del test scaduto).
const MESE = meseCorrenteRoma()
const OGGI = oggiFiscaleISO()
const VECCHIA = '2020-01-15'

function movimento(id: string, scuola_id: string, tipo: string, importo: number, metodo: string, data: string) {
  return {
    id, scuola_id, tipo, importo, metodo, data,
    categoria_id: null, descrizione: null, note: null, allegato_path: null, incasso_id: null,
    chiusura_id: null, registrato_da: null, creato_il: `${data}T10:00:00Z`,
    storno_di: null, stornato_il: null, storno_motivo: null, cassa_categorie: null,
  }
}
function incasso(id: string, scuola_id: string, importo: number, data: string) {
  return {
    id, importo, metodo: 'contanti', data_incasso: data, creato_il: `${data}T09:00:00Z`,
    storno_di: null, stornato_il: null,
    pagamenti: { scuola_id, alunno_id: null, categoria_id: CAT_PAG, payment_categories: { id: CAT_PAG, nome: 'Retta' } },
  }
}

function dbDiProva(): Record<string, Record<string, unknown>[]> {
  return {
    schools: [
      { id: SEDE_A, nome: 'Sede Alfa' },
      { id: SEDE_B, nome: 'Sede Beta' },
      { id: SEDE_C, nome: 'Sede Gamma' },
    ],
    cassa_movimenti: [
      movimento('m-a-usc', SEDE_A, 'uscita', 30, 'contanti', MESE.da),
      movimento('m-a-vecchia', SEDE_A, 'uscita', 100, 'bonifico', VECCHIA),
      movimento('m-a-ent', SEDE_A, 'entrata', 10, 'contanti', MESE.a),
      movimento('m-b-usc', SEDE_B, 'uscita', 20, 'contanti', MESE.a),
      movimento('m-b-prel', SEDE_B, 'prelievo', 50, 'contanti', VECCHIA),
      // La sede C NON è dell'utente: nessuna delle sue righe deve uscire.
      movimento('m-c-usc', SEDE_C, 'uscita', 999, 'contanti', MESE.da),
    ],
    incassi: [
      incasso('i-a', SEDE_A, 40, OGGI),
      incasso('i-b', SEDE_B, 25, OGGI),
      incasso('i-c', SEDE_C, 77, OGGI),
    ],
    cassa_chiusure: [
      { id: 'ch-a', scuola_id: SEDE_A, saldo_atteso: 1, contato: 1, differenza: 0, prelevato: 0, fondo_lasciato: 1, note: null, eseguita_da: null, eseguita_il: '2026-03-01T10:00:00Z' },
      { id: 'ch-b', scuola_id: SEDE_B, saldo_atteso: 2, contato: 2, differenza: 0, prelevato: 0, fondo_lasciato: 2, note: null, eseguita_da: null, eseguita_il: '2026-04-01T10:00:00Z' },
      { id: 'ch-c', scuola_id: SEDE_C, saldo_atteso: 3, contato: 3, differenza: 0, prelevato: 0, fondo_lasciato: 3, note: null, eseguita_da: null, eseguita_il: '2026-05-01T10:00:00Z' },
    ],
    cassa_categorie: [
      { id: 'cat-glob', scuola_id: null, nome: 'Pulizie', slug: 'pulizie', ordine: 1, attivo: true, is_sistema: true },
      { id: 'cat-a', scuola_id: SEDE_A, nome: 'Giardino', slug: 'giardino', ordine: 2, attivo: true, is_sistema: false },
      { id: 'cat-b', scuola_id: SEDE_B, nome: 'Piscina', slug: 'piscina', ordine: 3, attivo: true, is_sistema: false },
      { id: 'cat-c', scuola_id: SEDE_C, nome: 'Teatro', slug: 'teatro', ordine: 4, attivo: true, is_sistema: false },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.ruolo = 'admin'
  h.attive = [SEDE_A, SEDE_B]
  h.db = dbDiProva()
  h.lette = []
  h.opzioni = {}
  h.fondi = { [SEDE_A]: 100, [SEDE_B]: 50, [SEDE_C]: 1000 }
  h.saldoNonDisponibile = new Set()
  h.guastoUsciteMese = false
  h.incassiSenzaFiltroSede = false
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Mese corrente nel fuso di Roma ────────────────────────────────────────────
describe('meseCorrenteRoma', () => {
  it('primo e ultimo giorno del mese, anche a febbraio bisestile', () => {
    expect(meseCorrenteRoma(new Date('2028-02-10T12:00:00Z'))).toEqual({ da: '2028-02-01', a: '2028-02-29' })
    expect(meseCorrenteRoma(new Date('2027-02-10T12:00:00Z'))).toEqual({ da: '2027-02-01', a: '2027-02-28' })
    expect(meseCorrenteRoma(new Date('2026-12-31T12:00:00Z'))).toEqual({ da: '2026-12-01', a: '2026-12-31' })
  })

  it('alle 00:30 del 1° ottobre a Roma è già ottobre, anche se in UTC è ancora settembre', () => {
    // 22:30 UTC del 30/09 = 00:30 del 1/10 ora legale italiana (UTC+2).
    expect(meseCorrenteRoma(new Date('2026-09-30T22:30:00Z'))).toEqual({ da: '2026-10-01', a: '2026-10-31' })
  })
})

// ── movimenti GET ─────────────────────────────────────────────────────────────
describe('GET movimenti — lettura unita', () => {
  it('senza scuola_id legge TUTTE le sedi attive, e ogni riga porta scuola_id e scuola_nome', async () => {
    const res = await movimentiGET(req('movimenti'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = (body.movimenti as { id: string }[]).map((m) => m.id).sort()
    expect(ids).toEqual(['incasso:i-a', 'incasso:i-b', 'm-a-ent', 'm-a-usc', 'm-a-vecchia', 'm-b-prel', 'm-b-usc'])
    const perId = new Map((body.movimenti as { id: string; scuola_id: string; scuola_nome: string }[]).map((m) => [m.id, m]))
    expect(perId.get('m-b-usc')).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta' })
    // L'entrata virtuale prende la sede dal SUO pagamento, non da un parametro.
    expect(perId.get('incasso:i-b')).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta' })
    expect(perId.get('incasso:i-a')).toMatchObject({ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa' })
  })

  it('uscite_mese = solo le uscite del MESE CORRENTE, per sede e in totale', async () => {
    const body = await (await movimentiGET(req('movimenti'))).json()
    expect(body.uscite_mese).toEqual({
      da: MESE.da,
      a: MESE.a,
      totale: 50,
      per_sede: [
        { scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', totale: 30 },
        { scuola_id: SEDE_B, scuola_nome: 'Sede Beta', totale: 20 },
      ],
    })
    // I totali della lista restano quelli del set (qui senza filtri: di sempre).
    expect(body.totali.uscite_contanti).toBe(50)
    expect(body.totali.uscite_altre).toBe(100)
  })

  it('uscite_mese conta QUALUNQUE metodo e gli storni (a importo negativo)', async () => {
    // A: un'uscita pagata con la carta nel mese → conta anche se non tocca il cassetto.
    // B: lo storno di m-b-usc (contro-movimento a −20, `storno_di` valorizzato) → la
    //    sede B torna a zero. Filtrare `metodo='contanti'` darebbe A=30; escludere gli
    //    importi negativi darebbe B=20: in entrambi i casi questo test è rosso.
    h.db.cassa_movimenti.push(
      movimento('m-a-carta', SEDE_A, 'uscita', 15, 'carta', MESE.da),
      { ...movimento('m-b-storno', SEDE_B, 'uscita', -20, 'contanti', MESE.a), storno_di: 'm-b-usc', storno_motivo: null },
    )
    const body = await (await movimentiGET(req('movimenti'))).json()
    expect(body.uscite_mese).toEqual({
      da: MESE.da,
      a: MESE.a,
      totale: 45,
      per_sede: [
        { scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', totale: 45 },
        { scuola_id: SEDE_B, scuola_nome: 'Sede Beta', totale: 0 },
      ],
    })
  })

  it('uscite del mese illeggibili → lista servita (200), uscite_mese null, log error con esito proprio', async () => {
    h.guastoUsciteMese = true
    const res = await movimentiGET(req('movimenti'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.movimenti.length).toBeGreaterThan(0)
    expect(body.totali).toBeDefined()
    expect(body.uscite_mese).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'cassa',
      'error',
      expect.objectContaining({ operazione: 'pagamenti/cassa/movimenti:GET', esito: 'uscite-mese-non-lette' }),
      ERRORE_USCITE_MESE,
    )
    // Il log non dichiara uno stato 500 che il client non riceve.
    for (const [campi] of h.logErrore.mock.calls) expect(campi).not.toMatchObject({ stato: 500 })
    for (const c of h.logEvento.mock.calls) expect(c[2]).not.toHaveProperty('stato')
  })

  it('uscite_mese NON segue i filtri della lista (da/a di un altro periodo, tipo)', async () => {
    const body = await (await movimentiGET(req('movimenti', 'da=2020-01-01&a=2020-01-31&tipo=uscita'))).json()
    expect((body.movimenti as { id: string }[]).map((m) => m.id)).toEqual(['m-a-vecchia'])
    expect(body.uscite_mese.totale).toBe(50)
  })

  it('con scuola_id restringe a quella sede (per_sede di lunghezza 1)', async () => {
    const body = await (await movimentiGET(req('movimenti', `scuola_id=${SEDE_A}`))).json()
    const sedi = new Set((body.movimenti as { scuola_id: string }[]).map((m) => m.scuola_id))
    expect([...sedi]).toEqual([SEDE_A])
    expect(body.uscite_mese.totale).toBe(30)
    expect(body.uscite_mese.per_sede).toEqual([{ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', totale: 30 }])
  })

  it('scuola_id di una sede non propria → 403, e la cassa non viene nemmeno letta', async () => {
    const res = await movimentiGET(req('movimenti', `scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('cassa_movimenti')
    expect(h.lette).not.toContain('incassi')
    atteseLogFuoriScope('pagamenti/cassa/movimenti:GET')
  })

  it('un incasso senza sede non entra né nella lista né in totali.entrate', async () => {
    // Un embed `pagamenti` senza scuola_id (dato sporco): non si attribuisce a caso
    // a un cassetto. Prima entrava nei totali pur mancando da ogni riga.
    const orfano = incasso('i-orfano', SEDE_A, 500, OGGI)
    ;(orfano.pagamenti as { scuola_id: string | null }).scuola_id = null
    // Il finto applica `.in('pagamenti.scuola_id', …)` e scarterebbe l'orfano da
    // solo: lo si fa arrivare alla route togliendo quel filtro, e si toglie dal
    // DB l'incasso della sede C, che altrimenti passerebbe anche lui.
    h.db.incassi = [...h.db.incassi.filter((i) => i.id !== 'i-c'), orfano]
    h.incassiSenzaFiltroSede = true
    const body = await (await movimentiGET(req('movimenti'))).json()
    expect((body.movimenti as { id: string }[]).map((m) => m.id)).not.toContain('incasso:i-orfano')
    // entrate = 40 + 25 (incassi con sede) + 10 (entrata manuale contanti di A).
    expect(body.totali.entrate).toBe(75)
    // Lo scarto non è muto: il warn dice QUANTI incassi sono rimasti fuori.
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'warn', {
      operazione: 'pagamenti/cassa/movimenti:GET',
      esito: 'incassi-auto-senza-sede',
      quantita: 1,
    })
  })

  it('utente senza sedi attive: nessun movimento e KPI a zero, mai la cassa altrui', async () => {
    h.attive = []
    const body = await (await movimentiGET(req('movimenti'))).json()
    expect(body.movimenti).toEqual([])
    expect(body.uscite_mese).toMatchObject({ totale: 0, per_sede: [] })
  })

  it('la segreteria non riceve né `totali` né `uscite_mese` (KPI della Direzione)', async () => {
    h.ruolo = 'segreteria'
    const body = await (await movimentiGET(req('movimenti'))).json()
    expect(body.movimenti.length).toBeGreaterThan(0)
    expect(body).not.toHaveProperty('totali')
    expect(body).not.toHaveProperty('uscite_mese')
  })

  it('nomi delle sedi illeggibili → righe con scuola_nome null, log warn, niente 500', async () => {
    h.opzioni = { errori: { schools: { code: 'XX000', message: 'boom' } } }
    const res = await movimentiGET(req('movimenti'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.movimenti[0].scuola_nome).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'warn', expect.objectContaining({ esito: 'nomi-sedi-non-letti' }), expect.anything())
  })
})

// ── saldo GET ─────────────────────────────────────────────────────────────────
describe('GET saldo — un cassetto per sede, più il totale', () => {
  it('senza scuola_id: ogni sede col SUO fondo, somme in cima', async () => {
    const res = await saldoGET(req('saldo'))
    expect(res.status).toBe(200)
    const body = await res.json()
    // A: 100 + 40 (incasso) + 10 (entrata) − 30 (uscita contanti) = 120 — il bonifico non tocca il cassetto.
    // B:  50 + 25 − 20 − 50 (prelievo) = 5.
    expect(body.per_sede).toHaveLength(2)
    expect(body.per_sede[0]).toMatchObject({ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', disponibile: true, fondo: 100, saldo_atteso: 120 })
    expect(body.per_sede[1]).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta', disponibile: true, fondo: 50, saldo_atteso: 5 })
    expect(body).toMatchObject({ disponibile: true, fondo: 150, saldo_atteso: 125, entrate_contanti: 75, uscite_contanti: 50, prelievi: 50, rettifiche: 0 })
    // «Entrato oggi» fuso per metodo: 40 + 25.
    expect(body.entrato_oggi).toEqual([{ metodo: 'contanti', totale: 65 }])
    // La soglia si verifica cassetto per cassetto, e mai sulla sede altrui.
    expect(h.verificaSoglia.mock.calls.map((c) => c[1]).sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('con scuola_id: forma di sempre + per_sede di lunghezza 1', async () => {
    const body = await (await saldoGET(req('saldo', `scuola_id=${SEDE_B}`))).json()
    expect(body).toMatchObject({ disponibile: true, fondo: 50, saldo_atteso: 5 })
    expect(body.per_sede).toHaveLength(1)
    expect(body.per_sede[0]).toMatchObject({ scuola_id: SEDE_B, fondo: 50, saldo_atteso: 5 })
  })

  it('sede non propria → 403, nessun saldo calcolato', async () => {
    const res = await saldoGET(req('saldo', `scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('cassa_movimenti')
    expect(h.verificaSoglia).not.toHaveBeenCalled()
    atteseLogFuoriScope('pagamenti/cassa/saldo:GET')
  })

  it('più sedi, una NON disponibile: niente somme in cima, il dettaglio per sede sì', async () => {
    h.saldoNonDisponibile = new Set([SEDE_B])
    const res = await saldoGET(req('saldo'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
    // Una somma che salta un cassetto sarebbe un numero sbagliato: in cima non c'è.
    for (const k of ['fondo', 'saldo_atteso', 'entrate_contanti', 'uscite_contanti', 'prelievi', 'rettifiche', 'entrato_oggi']) {
      expect(body).not.toHaveProperty(k)
    }
    expect(body.per_sede).toHaveLength(2)
    expect(body.per_sede[0]).toMatchObject({ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa', disponibile: true, fondo: 100, saldo_atteso: 120 })
    expect(body.per_sede[1]).toEqual({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta', disponibile: false })
    // Senza questo log, «nessun totale» non distinguerebbe un cassetto non disponibile
    // da un saldo mai calcolato.
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', {
      operazione: 'pagamenti/cassa/saldo:GET',
      esito: 'saldo-non-disponibile',
      quantita: 1,
      sedi: 2,
    })
  })

  it('utente senza sedi attive: somme a 0, per_sede vuoto, nessun cassetto letto', async () => {
    h.attive = []
    const res = await saldoGET(req('saldo'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      disponibile: true,
      fondo: 0,
      saldo_atteso: 0,
      entrate_contanti: 0,
      uscite_contanti: 0,
      prelievi: 0,
      rettifiche: 0,
      entrato_oggi: [],
      per_sede: [],
    })
    expect(h.lette).not.toContain('cassa_movimenti')
    expect(h.verificaSoglia).not.toHaveBeenCalled()
  })
})

// ── chiusura GET ──────────────────────────────────────────────────────────────
describe('GET chiusura — storico di tutte le sedi attive', () => {
  it('senza scuola_id: chiusure di A e B, ciascuna con scuola_id e scuola_nome', async () => {
    const body = await (await chiusuraGET(req('chiusura'))).json()
    expect(body.disponibile).toBe(true)
    expect((body.chiusure as { id: string }[]).map((c) => c.id)).toEqual(['ch-b', 'ch-a'])
    expect(body.chiusure[0]).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta' })
    expect(body.chiusure[1]).toMatchObject({ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa' })
  })

  it('con scuola_id: solo quella sede', async () => {
    const body = await (await chiusuraGET(req('chiusura', `scuola_id=${SEDE_A}`))).json()
    expect((body.chiusure as { id: string }[]).map((c) => c.id)).toEqual(['ch-a'])
  })

  it('sede non propria → 403', async () => {
    const res = await chiusuraGET(req('chiusura', `scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('cassa_chiusure')
    atteseLogFuoriScope('pagamenti/cassa/chiusura:GET')
  })

  it('utente senza sedi attive: chiusure vuote, senza leggere cassa_chiusure', async () => {
    h.attive = []
    const res = await chiusuraGET(req('chiusura'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ disponibile: true, chiusure: [] })
    expect(h.lette).not.toContain('cassa_chiusure')
  })
})

// ── report GET ────────────────────────────────────────────────────────────────
describe('GET report — aggregati sommati + per_sede', () => {
  it('senza scuola_id: entrate e uscite di A+B, e il dettaglio per sede', async () => {
    const body = await (await reportGET(req('report'))).json()
    expect(body.disponibile).toBe(true)
    expect(body.entrate_per_categoria).toHaveLength(1)
    expect(body.entrate_per_categoria[0].totale).toBe(65)
    const usciteTot = (body.uscite_per_categoria as { totale: number }[]).reduce((s, u) => s + u.totale, 0)
    expect(usciteTot).toBe(150)
    expect(body.per_sede).toHaveLength(2)
    const [a, b] = body.per_sede as { scuola_id: string; scuola_nome: string; entrate_per_categoria: { totale: number }[]; uscite_per_categoria: { totale: number }[]; mensile: unknown[] }[]
    expect(a).toMatchObject({ scuola_id: SEDE_A, scuola_nome: 'Sede Alfa' })
    expect(a.entrate_per_categoria[0].totale).toBe(40)
    expect(a.uscite_per_categoria.reduce((s, u) => s + u.totale, 0)).toBe(130)
    expect(b).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta' })
    expect(b.entrate_per_categoria[0].totale).toBe(25)
    expect(b.uscite_per_categoria.reduce((s, u) => s + u.totale, 0)).toBe(20)
  })

  it('con scuola_id: solo quella sede, per_sede di lunghezza 1', async () => {
    const body = await (await reportGET(req('report', `scuola_id=${SEDE_B}`))).json()
    expect(body.entrate_per_categoria[0].totale).toBe(25)
    expect(body.per_sede).toHaveLength(1)
    expect(body.per_sede[0].scuola_id).toBe(SEDE_B)
  })

  it('utente senza sedi attive: report VUOTO, mai quello di tutte le sedi (scope vuoto nega)', async () => {
    h.attive = []
    const body = await (await reportGET(req('report'))).json()
    expect(body).toMatchObject({ disponibile: true, entrate_per_categoria: [], uscite_per_categoria: [], mensile: [], per_sede: [] })
  })

  it('un incasso senza sede è scartato PRIMA degli aggregati: in cima = somma di per_sede', async () => {
    // Stesso dato sporco del caso di movimenti: embed `pagamenti` senza scuola_id.
    // Prima entrava nelle entrate in cima ma in nessuna voce di per_sede, e le
    // due parti del report non tornavano più.
    const orfano = incasso('i-orfano', SEDE_A, 500, OGGI)
    ;(orfano.pagamenti as { scuola_id: string | null }).scuola_id = null
    // Il finto scarterebbe l'orfano col suo `.in('pagamenti.scuola_id', …)`: il filtro
    // diventa un no-op, e si toglie l'incasso della sede C che passerebbe anche lui.
    h.db.incassi = [...h.db.incassi.filter((i) => i.id !== 'i-c'), orfano]
    h.incassiSenzaFiltroSede = true
    const res = await reportGET(req('report'))
    expect(res.status).toBe(200)
    const body = await res.json()
    type Agg = { entrate_per_categoria: { totale: number }[] }
    const somma = (a: Agg) => a.entrate_per_categoria.reduce((s, e) => s + e.totale, 0)
    // L'orfano (500) è escluso: restano 40 (A) + 25 (B).
    expect(somma(body)).toBe(65)
    expect((body.per_sede as Agg[]).reduce((s, p) => s + somma(p), 0)).toBe(somma(body))
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'warn', {
      operazione: 'pagamenti/cassa/report:GET',
      esito: 'incassi-senza-sede',
      quantita: 1,
    })
  })

  it('sede non propria → 403', async () => {
    const res = await reportGET(req('report', `scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('incassi')
    atteseLogFuoriScope('pagamenti/cassa/report:GET')
  })
})

// ── categorie GET ─────────────────────────────────────────────────────────────
describe('GET categorie — globali + tutte le sedi attive', () => {
  it('senza scuola_id e più sedi: globali + A + B, mai C; ciascuna con scuola_id', async () => {
    h.ruolo = 'segreteria' // la GET serve al form uscita: tutta la segreteria
    const res = await categorieGET(req('categorie'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect((body.categorie as { id: string }[]).map((c) => c.id)).toEqual(['cat-glob', 'cat-a', 'cat-b'])
    expect(body.categorie[0]).toMatchObject({ scuola_id: null, scuola_nome: null })
    expect(body.categorie[2]).toMatchObject({ scuola_id: SEDE_B, scuola_nome: 'Sede Beta' })
  })

  it('con scuola_id: globali + quella sede', async () => {
    const body = await (await categorieGET(req('categorie', `scuola_id=${SEDE_A}`))).json()
    expect((body.categorie as { id: string }[]).map((c) => c.id)).toEqual(['cat-glob', 'cat-a'])
  })

  it('utente senza sedi attive: solo le globali', async () => {
    h.attive = []
    const body = await (await categorieGET(req('categorie'))).json()
    expect((body.categorie as { id: string }[]).map((c) => c.id)).toEqual(['cat-glob'])
  })

  it('sede non propria → 403', async () => {
    const res = await categorieGET(req('categorie', `scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect(h.lette).not.toContain('cassa_categorie')
    atteseLogFuoriScope('pagamenti/cassa/categorie:GET')
  })
})
