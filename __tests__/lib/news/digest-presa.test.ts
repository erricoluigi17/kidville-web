import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../../fixtures/sedi'

// =============================================================================
// LA PRESA SULL'EDIZIONE DEL DIGEST (fase 8 della roadmap di robustezza).
//
// ─── IL DIFETTO ─────────────────────────────────────────────────────────────
//
// Il giro del digest salvava l'avanzamento SOLO sul 429. Una Function troncata a
// metà (il muro dei 300 s, con ~866 famiglie a ~0,4 s l'una, è a portata) lasciava
// `destinatari_count` dov'era: il giro dopo ripartiva da lì e RISPEDIVA a tutte le
// famiglie già servite. E due giri sulla stessa edizione (il cron del 1° e il
// bottone «genera») spedivano entrambi: nessuna presa.
//
// ─── COSA SI PROVA QUI ──────────────────────────────────────────────────────
//
//  · un giro che trova la presa di un altro, viva, non spedisce niente;
//  · una presa SCADUTA si riprende;
//  · l'avanzamento si salva ogni `AVANZAMENTO_OGNI` invii: una Function morta a
//    metà fa ripartire il giro dopo dall'ultimo salvataggio, non da capo;
//  · le email fra l'ultimo salvataggio e la morte tornano a Resend con la STESSA
//    chiave d'idempotenza;
//  · il tetto di tempo ferma il giro, lascia la presa scaduta, e il tick la riprende;
//  · il 429 lascia la presa LIBERA: il tick non la ritenta ogni dieci minuti;
//  · senza le colonne (CI non migrata) si spedisce come prima, e lo si dice.
//
// Database: il finto Supabase del repo, che applica davvero i filtri degli UPDATE
// (`.or`, `.is`, `.eq` sul token). Il tempo: `Date` finto, nient'altro.
// =============================================================================

const logEvento = vi.fn()
const logErrore = vi.fn()

type Invio = { to: string; chiaveIdempotenza?: string }
let comportamento: (n: number, p: Invio) => { ok: boolean; rinviabile?: boolean } = () => ({ ok: true })
const inviati: Invio[] = []
const sendEmailDetailed = vi.fn(async (p: Invio) => {
  inviati.push(p)
  const e = comportamento(inviati.length, p)
  return { ...e, error: e.ok ? null : 'finto', to: p.to }
})

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: (p: Invio) => sendEmailDetailed(p),
}))
// Il passo fra due email è un `setTimeout` vero da 150 ms: con 45 famiglie sarebbero
// sette secondi per test. Qui il tempo che conta è quello di `Date`, guidato a mano.
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: async () => undefined, PAUSA_FRA_EMAIL_MS: 0 }))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import {
  generaEInviaDigest, riprendiDigestInterrotti, chiaveDigest,
  AVANZAMENTO_OGNI, PRESTITO_DIGEST_MS, TETTO_GIRO_DIGEST_MS, FINESTRA_RIPRESA_MS,
} from '@/lib/news/digest'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const PUBBLICATA = '2026-06-15T10:00:00.000Z'
const INIZIO = Date.parse('2026-07-01T08:00:00.000Z')
const N = 45

const email = (n: number) => `f${String(n).padStart(2, '0')}@example.test`

/** N famiglie raggiungibili, email già in ordine alfabetico (f01 … f45). */
function dbFamiglie(n = N): DBFinto {
  const numeri = Array.from({ length: n }, (_, i) => i + 1)
  return {
    scuole: [{ id: SEDE_A, nome: NOME_SEDE_A, attiva: true }],
    news_posts: [{
      id: 'p-a', titolo: 'Gita al parco', stato: 'pubblicata', pinned: false,
      pubblicata_il: PUBBLICATA, scuola_id: SEDE_A, target_scope: 'globale', contenuto_testo: 'x',
    }],
    news_digest_edizioni: [],
    alunni: numeri.map((k) => ({ id: `al-${k}`, scuola_id: SEDE_A, stato: 'iscritto' })),
    utenti: numeri.map((k) => ({ id: `gen-al-${k}`, email: email(k) })),
    admin_settings: [],
  }
}

/** Un'edizione già esistente con la presa di un altro giro. */
function conPresaAltrui(db: DBFinto, scadeFra: number, destinatari = 0) {
  db.news_digest_edizioni.push({
    id: 'ed-1', scuola_id: SEDE_A, anno: 2026, mese: 6, titolo: 't', post_ids: ['p-a'], html: '<p/>',
    inviata_il: null, destinatari_count: destinatari, errori_count: 0,
    presa_scade_il: new Date(Date.now() + scadeFra).toISOString(), presa_token: 'giro-altrui',
  })
}

const edizione = (db: DBFinto) => db.news_digest_edizioni[0] as Record<string, unknown>
const logConEsito = (esito: string) =>
  logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)
const opzioni = { anno: 2026, mese: 6, scuolaId: SEDE_A }

beforeEach(() => {
  vi.clearAllMocks()
  invalidateNotificheConfigCache()
  inviati.length = 0
  comportamento = () => ({ ok: true })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(INIZIO)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('la chiave d’idempotenza per destinatario', () => {
  it('ogni email porta la sua chiave: diversa per famiglia, stabile fra giri, senza l’indirizzo dentro', async () => {
    const db = dbFamiglie(5)
    await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    const chiavi = inviati.map((i) => i.chiaveIdempotenza)
    const id = edizione(db).id as string
    expect(chiavi).toHaveLength(5)
    expect(new Set(chiavi).size).toBe(5)
    for (const [k, i] of inviati.entries()) {
      expect(i.chiaveIdempotenza).toBe(chiaveDigest(id, email(k + 1)))
      expect(i.chiaveIdempotenza).toMatch(/^digest:[^:@]+:[0-9a-f]{32}$/)
      expect(i.chiaveIdempotenza).not.toContain('@')
    }
  })

  it('maiuscole e spazi non cambiano la chiave (lo stesso indirizzo è la stessa famiglia)', () => {
    expect(chiaveDigest('e', ' F01@Example.TEST ')).toBe(chiaveDigest('e', 'f01@example.test'))
  })
})

describe('la presa: un giro alla volta sulla stessa edizione', () => {
  it('🔴 la presa di un altro giro, VIVA ⇒ nessuna email, e lo si dice', async () => {
    const db = dbFamiglie(5)
    conPresaAltrui(db, 60_000)
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(sendEmailDetailed).not.toHaveBeenCalled()
    expect(edizioni[0].inviata).toBe(false)
    expect(edizione(db).presa_token).toBe('giro-altrui')
    expect(logConEsito('presa-altrui')).toHaveLength(1)
  })

  it('la presa di un altro giro, SCADUTA ⇒ la si prende e si spedisce da dove era arrivato', async () => {
    const db = dbFamiglie(5)
    conPresaAltrui(db, -1_000, 2)
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(inviati.map((i) => i.to)).toEqual([email(3), email(4), email(5)])
    expect(edizioni[0].inviata).toBe(true)
    expect(edizione(db).inviata_il).toBeTruthy()
    // chiusa: la presa è lasciata
    expect(edizione(db).presa_scade_il).toBeNull()
    expect(edizione(db).presa_token).toBeNull()
  })

  it('a edizione chiusa la presa scade il prima possibile: colonne di nuovo null', async () => {
    const db = dbFamiglie(5)
    await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(edizione(db).inviata_il).toBeTruthy()
    expect(edizione(db).presa_scade_il).toBeNull()
    expect(edizione(db).presa_token).toBeNull()
  })
})

describe('l’avanzamento a intervalli: una Function morta non fa rispedire da capo', () => {
  it(`salva ogni ${AVANZAMENTO_OGNI} invii, e ogni salvataggio rinnova la presa`, async () => {
    const db = dbFamiglie()
    const scritture: Scrittura[] = []
    await generaEInviaDigest(creaFintoSupabase(db, [], { scritture }), opzioni)
    const avanzamenti = scritture.filter((s) =>
      s.tabella === 'news_digest_edizioni' && s.operazione === 'update'
      && s.valori.some((v) => v.inviata_il == null && typeof v.destinatari_count === 'number'))
    expect(avanzamenti.map((s) => s.valori[0].destinatari_count)).toEqual([20, 40])
    // col proprio token: ognuno ha toccato la riga
    expect(avanzamenti.every((s) => s.colpite.length === 1)).toBe(true)
    for (const s of avanzamenti) {
      expect(Date.parse(String(s.valori[0].presa_scade_il))).toBe(INIZIO + PRESTITO_DIGEST_MS)
    }
  })

  it('🔴 morte alla 27ª email: subito dopo nessuno la tocca; scaduta la presa, si riparte dalla 21ª con le STESSE chiavi', async () => {
    const db = dbFamiglie()
    comportamento = (n) => {
      if (n === 27) throw new Error('Function terminata dal tetto')
      return { ok: true }
    }
    await expect(generaEInviaDigest(creaFintoSupabase(db, []), opzioni)).rejects.toThrow()
    expect(edizione(db).destinatari_count).toBe(20)
    expect(edizione(db).inviata_il ?? null).toBeNull()
    const chiaviDelMorto = inviati.slice(20, 26).map((i) => i.chiaveIdempotenza)

    // Subito dopo (il cron e il bottone insieme): la presa è ancora viva.
    comportamento = () => ({ ok: true })
    inviati.length = 0
    await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(inviati).toEqual([])
    expect(logConEsito('presa-altrui')).toHaveLength(1)

    // Scaduta la presa: si riparte dall'ultimo salvataggio, non da capo.
    vi.setSystemTime(INIZIO + PRESTITO_DIGEST_MS + 1_000)
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(inviati[0].to).toBe(email(21))
    expect(inviati).toHaveLength(N - 20)
    expect(inviati.map((i) => i.to)).not.toContain(email(1))
    // le sei partite dopo l'ultimo salvataggio tornano a Resend con la stessa chiave
    expect(inviati.slice(0, 6).map((i) => i.chiaveIdempotenza)).toEqual(chiaviDelMorto)
    expect(edizioni[0].inviata).toBe(true)
    expect(edizione(db).destinatari_count).toBe(N)
  })

  it('presa PERSA durante il giro (un altro l’ha presa): ci si ferma al salvataggio e non si scrive più', async () => {
    const db = dbFamiglie()
    comportamento = (n) => {
      if (n === 10) edizione(db).presa_token = 'giro-altrui'
      return { ok: true }
    }
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(inviati).toHaveLength(AVANZAMENTO_OGNI)
    expect(edizioni[0].inviata).toBe(false)
    expect(edizione(db).inviata_il ?? null).toBeNull()
    expect(edizione(db).presa_token).toBe('giro-altrui')
    expect(logConEsito('presa-persa')).toHaveLength(1)
  })

  it('gli errori definitivi di un giro precedente restano contati alla ripresa', async () => {
    const db = dbFamiglie(5)
    conPresaAltrui(db, -1_000, 2)
    edizione(db).errori_count = 1
    comportamento = (n) => ({ ok: n !== 2 })
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(edizioni[0].errori_count).toBe(2)
    expect(edizione(db).errori_count).toBe(2)
  })
})

describe('il tetto di tempo: il giro si ferma prima del muro, il tick lo riprende', () => {
  it('🔴 oltre il tetto: avanzamento salvato, presa lasciata SCADUTA, `rimandata-tempo`; il tick la riprende e la chiude', async () => {
    const db = dbFamiglie()
    // ogni email «costa» 50 s: al quinto invio il tetto (240 s) è superato
    comportamento = () => {
      vi.setSystemTime(Date.now() + 50_000)
      return { ok: true }
    }
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(inviati).toHaveLength(5)
    expect(edizioni[0].inviata).toBe(false)
    expect(edizione(db).destinatari_count).toBe(5)
    expect(edizione(db).presa_token).toBeNull()
    expect(Date.parse(String(edizione(db).presa_scade_il))).toBeLessThanOrEqual(Date.now())
    expect(logConEsito('rimandata-tempo')).toHaveLength(1)
    expect(logConEsito('rimandata-tempo')[0][1]).toBe('warn')

    // Dieci minuti dopo, il tick.
    comportamento = () => ({ ok: true })
    inviati.length = 0
    vi.setSystemTime(Date.now() + 10 * 60_000)
    const r = await riprendiDigestInterrotti(creaFintoSupabase(db, []), { scadenza: Date.now() + TETTO_GIRO_DIGEST_MS })
    expect(r).toEqual({ disponibile: true, riprese: 1, inviate: 1 })
    expect(inviati[0].to).toBe(email(6))
    expect(inviati).toHaveLength(N - 5)
    expect(edizione(db).inviata_il).toBeTruthy()
  })

  it('la scadenza passata dal chiamante vale per tutto il giro (anche già scaduta: si prende e si lascia al tick)', async () => {
    const db = dbFamiglie(5)
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db, []), { ...opzioni, scadenza: Date.now() })
    expect(inviati).toEqual([])
    expect(edizioni[0].inviata).toBe(false)
    expect(edizione(db).presa_scade_il).toBeTruthy()
    expect(logConEsito('rimandata-tempo')).toHaveLength(1)
  })

  it(`il tick non ritenta un'edizione la cui presa è scaduta da più di ${FINESTRA_RIPRESA_MS / 3_600_000} ore`, async () => {
    const db = dbFamiglie(5)
    conPresaAltrui(db, -FINESTRA_RIPRESA_MS - 1_000, 2)
    const r = await riprendiDigestInterrotti(creaFintoSupabase(db, []), { scadenza: Date.now() + TETTO_GIRO_DIGEST_MS })
    expect(r.riprese).toBe(0)
    expect(inviati).toEqual([])
  })

  it('il tick non tocca una presa ancora viva', async () => {
    const db = dbFamiglie(5)
    conPresaAltrui(db, 60_000, 2)
    const r = await riprendiDigestInterrotti(creaFintoSupabase(db, []), { scadenza: Date.now() + TETTO_GIRO_DIGEST_MS })
    expect(r.riprese).toBe(0)
    expect(inviati).toEqual([])
  })
})

describe('la quota (429): la presa si lascia LIBERA, il tick non la ritenta', () => {
  it('429 alla terza ⇒ avanzamento salvato, presa null, e il tick non la vede', async () => {
    const db = dbFamiglie(5)
    comportamento = (n) => (n === 3 ? { ok: false, rinviabile: true } : { ok: true })
    await generaEInviaDigest(creaFintoSupabase(db, []), opzioni)
    expect(edizione(db).destinatari_count).toBe(2)
    expect(edizione(db).presa_scade_il).toBeNull()
    expect(edizione(db).presa_token).toBeNull()
    expect(logConEsito('rimandata-quota')).toHaveLength(1)

    inviati.length = 0
    vi.setSystemTime(Date.now() + 10 * 60_000)
    const r = await riprendiDigestInterrotti(creaFintoSupabase(db, []), { scadenza: Date.now() + TETTO_GIRO_DIGEST_MS })
    expect(r.riprese).toBe(0)
    expect(inviati).toEqual([])
  })
})

// ── Il DB della CI non ha le colonne ─────────────────────────────────────────

/** Una catena PostgREST che risolve sempre allo stesso esito. */
function catenaCon(esito: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  for (const m of ['eq', 'is', 'or', 'select', 'lt', 'gte', 'order', 'limit', 'in']) c[m] = () => c
  c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(esito).then(ok, ko)
  return c
}

/** Il finto Supabase come un DB senza le colonne della presa: PGRST204 sull'UPDATE che le
 *  nomina, 42703 sulla SELECT della ripresa che le filtra. Il resto passa al finto vero. */
function senzaColonneDellaPresa(db: DBFinto, scritture?: Scrittura[]) {
  const vero = creaFintoSupabase(db, [], { scritture }) as unknown as { from: (t: string) => Record<string, unknown> }
  return {
    from(tabella: string) {
      const b = vero.from(tabella)
      if (tabella !== 'news_digest_edizioni') return b
      return {
        select: (...a: unknown[]) =>
          a[0] === 'scuola_id, anno, mese'
            ? catenaCon({ data: null, error: { code: '42703', message: 'column news_digest_edizioni.presa_scade_il does not exist' } })
            : (b.select as (...x: unknown[]) => unknown)(...a),
        update: (payload: Record<string, unknown>) =>
          'presa_scade_il' in payload || 'presa_token' in payload
            ? catenaCon({ data: null, error: { code: 'PGRST204', message: "Could not find the 'presa_scade_il' column" } })
            : (b.update as (p: unknown) => unknown)(payload),
        upsert: (...a: unknown[]) => (b.upsert as (...x: unknown[]) => unknown)(...a),
      }
    },
  } as unknown as Parameters<typeof generaEInviaDigest>[0]
}

describe('senza le colonne (DB della CI non migrato): si spedisce come prima, e lo si dice', () => {
  it('nessuna presa, tutte le email, edizione marcata, una riga `info`', async () => {
    const db = dbFamiglie()
    const scritture: Scrittura[] = []
    const { edizioni } = await generaEInviaDigest(senzaColonneDellaPresa(db, scritture), opzioni)
    expect(inviati).toHaveLength(N)
    expect(edizioni[0].inviata).toBe(true)
    expect(edizione(db).inviata_il).toBeTruthy()
    expect(logConEsito('presa-senza-colonne')).toHaveLength(1)
    expect(logConEsito('presa-senza-colonne')[0][1]).toBe('info')
    // e l'avanzamento si salva lo stesso, senza le colonne che non ci sono
    const avanzamenti = scritture.filter((s) => s.operazione === 'update' && s.valori.some((v) => v.inviata_il == null))
    expect(avanzamenti.map((s) => s.valori[0].destinatari_count)).toEqual([20, 40])
    expect(avanzamenti.every((s) => !('presa_scade_il' in s.valori[0]))).toBe(true)
    expect(logErrore).not.toHaveBeenCalled()
  })

  it('la ripresa dal tick: `disponibile: false`, nessun errore', async () => {
    const r = await riprendiDigestInterrotti(senzaColonneDellaPresa(dbFamiglie(1)), { scadenza: Date.now() + 1_000 })
    expect(r).toEqual({ disponibile: false, riprese: 0, inviate: 0 })
    expect(logConEsito('presa-senza-colonne')).toHaveLength(1)
  })

  it('un guasto VERO sulla presa (non una colonna assente) ⇒ non si spedisce, riga `error`', async () => {
    const db = dbFamiglie(3)
    const supabase = creaFintoSupabase(db, [], {
      errori: { 'news_digest_edizioni:update': { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    const { edizioni } = await generaEInviaDigest(supabase, opzioni)
    expect(inviati).toEqual([])
    expect(edizioni[0].inviata).toBe(false)
    const righe = logConEsito('presa-non-riuscita')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('error')
    expect((righe[0][3] as { code?: string }).code).toBe('57014')
  })
})
