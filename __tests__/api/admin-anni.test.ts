import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * PR 4.2 · COMPITO 4.2.4 · le route delle impostazioni dell'anno:
 *   GET   /api/admin/anni/[annoSedeId]                  — che cosa manca per aprire le iscrizioni
 *   PATCH /api/admin/anni/[annoSedeId]                  — azione: confine | date | domande
 *   POST  /api/admin/anni/[annoSedeId]/apri-iscrizioni
 *
 * Il database è finto, ma finto in modo che il test sia sensibile al codice: il gate onora la lista dei
 * ruoli che la route gli passa, il perimetro legge davvero la riga di `anni_sede`, e ogni RPC risponde
 * come PostgREST (`{ data, error }` con `error.message` = codice e `error.details` = JSON come testo).
 * Nessuna data dipende dal calendario: le date sono stringhe che la route inoltra e basta.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const ANNO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // anni_sede.id della SEDE_A
const ANNO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' // anni_sede.id della SEDE_B
const UTENTE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Esito = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }
type Riga = { id: string; scuola_id: string }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  sediExtra: [] as string[],
  righe: {} as Record<string, Riga>,
  letturaErrore: null as null | { code?: string; message?: string },
  rpc: [] as Array<{ nome: string; args: Record<string, unknown> }>,
  esiti: {} as Record<string, Esito>,
  gateAmmessi: null as null | readonly string[],
  log: [] as Array<{ fn: 'evento' | 'errore' | 'ok'; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, allowed: readonly string[] = ['admin', 'coordinator', 'segreteria']) => {
    h.gateAmmessi = allowed
    if (!h.user) return { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) }
    if (!allowed.includes(h.user.role)) {
      return { user: null, response: new Response(JSON.stringify({ error: 'vietato' }), { status: 403 }) }
    }
    return { user: h.user, response: null }
  },
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => [
    ...(u.scuola_id ? [u.scuola_id] : []),
    ...h.sediExtra,
  ],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const b: Record<string, unknown> = {}
      let id = ''
      b.select = () => b
      b.eq = (_c: string, v: string) => {
        id = v
        return b
      }
      b.maybeSingle = async () => {
        if (tabella !== 'anni_sede') throw new Error(`tabella inattesa: ${tabella}`)
        if (h.letturaErrore) return { data: null, error: h.letturaErrore }
        return { data: h.righe[id] ?? null, error: null }
      }
      return b
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      h.rpc.push({ nome, args })
      return h.esiti[nome] ?? { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    },
  }),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...args: unknown[]) => void h.log.push({ fn: 'evento', args }),
  logErrore: (...args: unknown[]) => void h.log.push({ fn: 'errore', args }),
  logOk: (...args: unknown[]) => void h.log.push({ fn: 'ok', args }),
}))

import { GET, PATCH } from '@/app/api/admin/anni/[annoSedeId]/route'
import { POST } from '@/app/api/admin/anni/[annoSedeId]/apri-iscrizioni/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const json = (corpo: unknown) =>
  ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as const

const leggi = (id = ANNO_A) =>
  GET(new Request(`http://localhost/api/admin/anni/${id}`) as never, contesto(id) as never)
const modifica = (corpo: unknown, id = ANNO_A) =>
  PATCH(new Request(`http://localhost/api/admin/anni/${id}`, json(corpo)) as never, contesto(id) as never)
const apri = (id = ANNO_A) =>
  POST(
    new Request(`http://localhost/api/admin/anni/${id}/apri-iscrizioni`, { method: 'POST' }) as never,
    contesto(id) as never,
  )

const ok = (data: unknown): Esito => ({ data, error: null })
const rifiuto = (message: string, details?: unknown, code = 'P0001'): Esito => ({
  data: null,
  error: { code, message, details: details === undefined ? null : JSON.stringify(details) },
})

/** Le righe di log di un livello e di un `tipo`: il `tipo` è la chiave in chiaro con cui si cerca in `app_log`. */
const eventi = (tipo: string, livello?: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ area: l.args[0], livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo && (livello === undefined || e.livello === livello))

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.sediExtra = []
  h.righe = { [ANNO_A]: { id: ANNO_A, scuola_id: SEDE_A }, [ANNO_B]: { id: ANNO_B, scuola_id: SEDE_B } }
  h.letturaErrore = null
  h.rpc = []
  h.esiti = {}
  h.gateAmmessi = null
  h.log = []
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate e perimetro: uguali per le quattro route
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CHIAMATE: Array<[string, () => Promise<Response>]> = [
  ['GET', () => leggi()],
  ['PATCH confine', () => modifica({ azione: 'confine', nuova_fine: '2027-08-31' })],
  ['PATCH date', () => modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15' })],
  ['PATCH domande', () => modifica({ azione: 'domande', aperte: false })],
  ['POST apri-iscrizioni', () => apri()],
]

describe.each(CHIAMATE)('gate e perimetro — %s', (_nome, chiama) => {
  it('401 senza identità', async () => {
    h.user = null
    expect((await chiama()).status).toBe(401)
    expect(h.rpc).toEqual([])
  })

  it.each(['educator', 'genitore', 'cuoca'])('403 a un utente %s', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    expect((await chiama()).status).toBe(403)
    expect(h.rpc).toEqual([])
  })

  it('il gate ammette solo Direzione e segreteria', async () => {
    await chiama()
    expect([...(h.gateAmmessi ?? [])].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it.each(['admin', 'coordinator', 'segreteria'])('%s della sede passa il gate', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    h.esiti = {
      anno_prerequisiti_iscrizioni: ok([]),
      sposta_confine_anno: ok({ cambiato: false }),
      anno_imposta_date: ok({ cambiato: false }),
      anno_imposta_domande: ok({ cambiato: false }),
      anno_apri_iscrizioni: ok({ cambiato: false }),
    }
    expect((await chiama()).status).toBe(200)
  })

  it('403 SEDE_NON_ACCESSIBILE (con warn) a una segreteria che nomina l’anno di un’altra sede', async () => {
    h.righe[ANNO_A] = { id: ANNO_A, scuola_id: SEDE_B }
    const r = await chiama()
    expect(r.status).toBe(403)
    expect((await r.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.rpc).toEqual([]) // il database non è stato toccato
    const warn = h.log.filter((l) => l.fn === 'evento' && l.args[1] === 'warn')
    expect(warn.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(warn)).toContain(SEDE_B)
  })

  it('un admin con più sedi entra in tutte quelle che gestisce', async () => {
    h.user = { id: UTENTE, role: 'admin', scuola_id: SEDE_A }
    h.sediExtra = [SEDE_B]
    h.righe[ANNO_A] = { id: ANNO_A, scuola_id: SEDE_B }
    h.esiti = {
      anno_prerequisiti_iscrizioni: ok([]),
      sposta_confine_anno: ok({ cambiato: false }),
      anno_imposta_date: ok({ cambiato: false }),
      anno_imposta_domande: ok({ cambiato: false }),
      anno_apri_iscrizioni: ok({ cambiato: false }),
    }
    expect((await chiama()).status).toBe(200)
  })

  it('404 ANNO_NON_TROVATO se l’id non esiste', async () => {
    h.righe = {}
    const r = await chiama()
    expect(r.status).toBe(404)
    expect((await r.json()).codice).toBe('ANNO_NON_TROVATO')
    expect(h.rpc).toEqual([])
  })

  it('400 se l’id non è un uuid, senza leggere nulla', async () => {
    const r = await GET(new Request('http://localhost/api/admin/anni/x') as never, contesto('non-un-uuid') as never)
    expect(r.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('503 CALENDARIO_NON_DISPONIBILE (con info, mai 500) se anni_sede non esiste', async () => {
    h.letturaErrore = { code: 'PGRST205', message: 'tabella assente' }
    const r = await chiama()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(eventi('impostazioni-schema-indietro', 'info')).toHaveLength(1)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(false)
  })

  it('un guasto vero della lettura è un 500 e un logErrore', async () => {
    h.letturaErrore = { code: '57014', message: 'timeout' }
    const r = await chiama()
    expect(r.status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET — che cosa manca
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/anni/[annoSedeId]', () => {
  it('risponde con l’elenco di ciò che manca, nell’ordine del database', async () => {
    h.esiti.anno_prerequisiti_iscrizioni = ok(['quota_nuova', 'moduli_nuova'])
    const r = await leggi()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ success: true, data: { mancano: ['quota_nuova', 'moduli_nuova'] } })
    expect(h.rpc).toEqual([{ nome: 'anno_prerequisiti_iscrizioni', args: { p_anno_sede: ANNO_A } }])
  })

  it('tutto pronto = elenco vuoto', async () => {
    h.esiti.anno_prerequisiti_iscrizioni = ok([])
    expect((await (await leggi()).json()).data.mancano).toEqual([])
  })

  it('503 CALENDARIO_NON_DISPONIBILE se la funzione non c’è (database non migrato)', async () => {
    h.esiti.anno_prerequisiti_iscrizioni = { data: null, error: { code: '42883', message: 'function does not exist' } }
    const r = await leggi()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(eventi('impostazioni-schema-indietro', 'info')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PATCH confine
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PATCH azione=confine', () => {
  it('stessa data: 200 cambiato=false, senza log di successo (salvare senza cambiare non è un errore)', async () => {
    h.esiti.sposta_confine_anno = ok({ cambiato: false, anno_sede_id: ANNO_A, fine: '2027-08-31' })
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-08-31' })
    expect(r.status).toBe(200)
    expect((await r.json()).data.cambiato).toBe(false)
    expect(h.rpc).toEqual([{ nome: 'sposta_confine_anno', args: { p_anno_sede: ANNO_A, p_nuova_fine: '2027-08-31' } }])
    expect(eventi('anno-confine-spostato')).toEqual([])
  })

  it('spostamento valido: 200 cambiato=true e log di successo con uuid e date, nessuna riga di bambino', async () => {
    h.esiti.sposta_confine_anno = ok({
      cambiato: true,
      anno_sede_id: ANNO_A,
      successivo_anno_sede_id: ANNO_B,
      fine_precedente: '2027-08-31',
      fine_nuova: '2027-09-15',
      inizio_successivo_precedente: '2027-09-01',
      inizio_successivo_nuovo: '2027-09-16',
      prepara_successivo_dal_precedente: '2027-09-01',
      prepara_successivo_dal_nuovo: '2027-09-16',
    })
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-09-15' })
    expect(r.status).toBe(200)
    expect((await r.json()).data.cambiato).toBe(true)

    const ev = eventi('anno-confine-spostato', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].area).toBe('anno-scolastico')
    expect(ev[0].campi).toMatchObject({
      anno_sede_id: ANNO_A,
      fine_precedente: '2027-08-31',
      fine_nuova: '2027-09-15',
      utente: UTENTE,
    })
    // solo uuid, date, numeri e booleani: nessun valore che non sia di quella forma
    for (const [chiave, valore] of Object.entries(ev[0].campi)) {
      expect(['string', 'number', 'boolean'], chiave).toContain(typeof valore)
    }
  })

  it('con righe nei giorni: 409 CONFINE_CON_RIGHE con i conteggi per tabella e log di rifiuto (warn) coi conteggi', async () => {
    h.esiti.sposta_confine_anno = rifiuto('CONFINE_CON_RIGHE', {
      anno_sede_id: ANNO_A,
      nuova_fine: '2027-08-15',
      dal: '2027-08-16',
      al: '2027-08-31',
      righe: 7,
      tabelle: { pagamenti: 4, presenze: 3 },
      senza_competenza: 2,
    })
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-08-15' })
    expect(r.status).toBe(409)
    const corpo = await r.json()
    expect(corpo.codice).toBe('CONFINE_CON_RIGHE')
    expect(corpo.righe).toBe(7)
    expect(corpo.tabelle).toEqual({ pagamenti: 4, presenze: 3 })
    expect(corpo.senza_competenza).toBe(2)
    expect(typeof corpo.error).toBe('string')

    const ev = eventi('anno-confine-rifiutato', 'warn')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, righe: 7, senza_competenza: 2, utente: UTENTE })
    // i conteggi per tabella ci sono, piatti e numerici; le righe no
    expect(JSON.stringify(ev[0].campi)).toContain('pagamenti')
    expect(Object.values(ev[0].campi).every((v) => typeof v !== 'object')).toBe(true)
    expect(eventi('anno-confine-spostato')).toEqual([])
  })

  it('anno chiuso: 409 ANNO_CHIUSO', async () => {
    h.esiti.sposta_confine_anno = rifiuto('ANNO_CHIUSO', { anno_sede_id: ANNO_A })
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-08-15' })
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('CONFINE_NON_VALIDO: 422 col motivo in codice', async () => {
    h.esiti.sposta_confine_anno = rifiuto('CONFINE_NON_VALIDO', { motivo: 'fine_non_dopo_inizio', anno_sede_id: ANNO_A })
    const r = await modifica({ azione: 'confine', nuova_fine: '2020-01-01' })
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo.codice).toBe('CONFINE_NON_VALIDO')
    expect(corpo.motivo).toBe('fine_non_dopo_inizio')
  })

  it('una data che non esiste (2026-02-30) è un 400 di zod e il database non viene toccato', async () => {
    const r = await modifica({ azione: 'confine', nuova_fine: '2026-02-30' })
    expect(r.status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('nuova_fine mancante: 400', async () => {
    expect((await modifica({ azione: 'confine' })).status).toBe(400)
  })

  it('503 CALENDARIO_NON_DISPONIBILE se la funzione non c’è (PGRST205), con info e senza 500', async () => {
    h.esiti.sposta_confine_anno = { data: null, error: { code: 'PGRST205', message: 'assente' } }
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-08-31' })
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(eventi('impostazioni-schema-indietro', 'info')).toHaveLength(1)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(false)
  })

  it('un errore sconosciuto è un 500 con logErrore, non un 200', async () => {
    h.esiti.sposta_confine_anno = rifiuto('QUALCOSA_DI_IMPREVISTO')
    const r = await modifica({ azione: 'confine', nuova_fine: '2027-08-31' })
    expect(r.status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PATCH date
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PATCH azione=date', () => {
  it('ok: inoltra solo ciò che c’è (NULL = non toccare) e risponde 200 col risultato', async () => {
    h.esiti.anno_imposta_date = ok({
      cambiato: true,
      anno_sede_id: ANNO_A,
      ultimo_giorno_aperto: '2027-07-15',
      ultimo_giorno_aperto_precedente: '2027-07-31',
      prepara_successivo_dal: '2027-03-01',
      prepara_successivo_dal_precedente: '2027-03-01',
    })
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15' })
    expect(r.status).toBe(200)
    expect((await r.json()).data.cambiato).toBe(true)
    expect(h.rpc).toEqual([
      {
        nome: 'anno_imposta_date',
        args: { p_anno_sede: ANNO_A, p_ultimo_giorno_aperto: '2027-07-15', p_prepara_successivo_dal: null },
      },
    ])
    const ev = eventi('anno-date-impostate', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, utente: UTENTE })
  })

  it('le due date insieme', async () => {
    h.esiti.anno_imposta_date = ok({ cambiato: true, anno_sede_id: ANNO_A })
    await modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15', prepara_successivo_dal: '2027-02-01' })
    expect(h.rpc[0].args).toEqual({
      p_anno_sede: ANNO_A,
      p_ultimo_giorno_aperto: '2027-07-15',
      p_prepara_successivo_dal: '2027-02-01',
    })
  })

  it('valori uguali: 200 cambiato=false e nessun log di successo', async () => {
    h.esiti.anno_imposta_date = ok({ cambiato: false, anno_sede_id: ANNO_A })
    const r = await modifica({ azione: 'date', prepara_successivo_dal: '2027-03-01' })
    expect(r.status).toBe(200)
    expect((await r.json()).data.cambiato).toBe(false)
    expect(eventi('anno-date-impostate')).toEqual([])
  })

  it('DATE_NON_VALIDE: 422 col motivo e il campo in codice, e un warn', async () => {
    h.esiti.anno_imposta_date = rifiuto('DATE_NON_VALIDE', {
      motivo: 'fuori_periodo',
      campo: 'ultimo_giorno_aperto',
      anno_sede_id: ANNO_A,
      valore: '2030-01-01',
      inizio: '2026-09-01',
      fine: '2027-08-31',
    })
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2030-01-01' })
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo.codice).toBe('DATE_NON_VALIDE')
    expect(corpo.motivo).toBe('fuori_periodo')
    expect(corpo.campo).toBe('ultimo_giorno_aperto')
    const ev = eventi('anno-date-rifiutate', 'warn')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ motivo: 'fuori_periodo', campo: 'ultimo_giorno_aperto', anno_sede_id: ANNO_A })
  })

  it('il motivo ultimo_giorno_nel_passato passa com’è', async () => {
    h.esiti.anno_imposta_date = rifiuto('DATE_NON_VALIDE', {
      motivo: 'ultimo_giorno_nel_passato',
      campo: 'ultimo_giorno_aperto',
      anno_sede_id: ANNO_A,
    })
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2020-01-01' })
    expect(r.status).toBe(422)
    expect((await r.json()).motivo).toBe('ultimo_giorno_nel_passato')
  })

  it('ANNO_IN_CHIUSURA: 409', async () => {
    h.esiti.anno_imposta_date = rifiuto('ANNO_IN_CHIUSURA', { anno_sede_id: ANNO_A, stato: 'in_chiusura' })
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15' })
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_IN_CHIUSURA')
  })

  it('ANNO_CHIUSO: 409', async () => {
    h.esiti.anno_imposta_date = rifiuto('ANNO_CHIUSO', { anno_sede_id: ANNO_A, stato: 'chiuso' })
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15' })
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('una data che non esiste: 400', async () => {
    expect((await modifica({ azione: 'date', prepara_successivo_dal: '2027-13-01' })).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('503 se la funzione non c’è (42883)', async () => {
    h.esiti.anno_imposta_date = { data: null, error: { code: '42883', message: 'assente' } }
    const r = await modifica({ azione: 'date', ultimo_giorno_aperto: '2027-07-15' })
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PATCH domande
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PATCH azione=domande', () => {
  it('apre le domande: 200 e log di successo', async () => {
    h.esiti.anno_imposta_domande = ok({ cambiato: true, anno_sede_id: ANNO_A, domande_aperte: true })
    const r = await modifica({ azione: 'domande', aperte: true })
    expect(r.status).toBe(200)
    expect((await r.json()).data).toMatchObject({ cambiato: true, domande_aperte: true })
    expect(h.rpc).toEqual([{ nome: 'anno_imposta_domande', args: { p_anno_sede: ANNO_A, p_aperte: true } }])
    const ev = eventi('anno-domande-impostate', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, aperte: true, utente: UTENTE })
  })

  it('chiude le domande: il valore false arriva al database (non diventa NULL)', async () => {
    h.esiti.anno_imposta_domande = ok({ cambiato: true, anno_sede_id: ANNO_A, domande_aperte: false })
    await modifica({ azione: 'domande', aperte: false })
    expect(h.rpc[0].args.p_aperte).toBe(false)
  })

  it('già com’è: 200 cambiato=false e nessun log di successo', async () => {
    h.esiti.anno_imposta_domande = ok({ cambiato: false, anno_sede_id: ANNO_A, domande_aperte: true })
    const r = await modifica({ azione: 'domande', aperte: true })
    expect(r.status).toBe(200)
    expect(eventi('anno-domande-impostate')).toEqual([])
  })

  it('aperte=true su in_preparazione: 409 STATO_NON_AMMESSO, col rifiuto nel log', async () => {
    h.esiti.anno_imposta_domande = rifiuto('STATO_NON_AMMESSO', { anno_sede_id: ANNO_A, stato: 'in_preparazione' })
    const r = await modifica({ azione: 'domande', aperte: true })
    expect(r.status).toBe(409)
    const corpo = await r.json()
    expect(corpo.codice).toBe('STATO_NON_AMMESSO')
    expect(corpo.stato).toBe('in_preparazione')
    const ev = eventi('anno-domande-rifiutate', 'warn')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, stato: 'in_preparazione', aperte: true })
    expect(eventi('anno-domande-impostate')).toEqual([])
  })

  it('aperte non booleano: 400', async () => {
    expect((await modifica({ azione: 'domande', aperte: 'si' })).status).toBe(400)
    expect((await modifica({ azione: 'domande' })).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('503 se la funzione non c’è', async () => {
    h.esiti.anno_imposta_domande = { data: null, error: { code: 'PGRST202', message: 'assente' } }
    const r = await modifica({ azione: 'domande', aperte: true })
    expect(r.status).toBe(503)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — il corpo
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PATCH — il corpo è una lista bianca', () => {
  it.each([
    ['scuola_id', { azione: 'confine', nuova_fine: '2027-08-31', scuola_id: SEDE_B }],
    ['stato', { azione: 'domande', aperte: true, stato: 'corrente' }],
    ['stato nelle date', { azione: 'date', ultimo_giorno_aperto: '2027-07-15', stato: 'chiuso' }],
    ['un campo di un’altra azione', { azione: 'confine', nuova_fine: '2027-08-31', aperte: true }],
  ])('campi in più (%s): 400 e il database non si tocca', async (_nome, corpo) => {
    expect((await modifica(corpo)).status).toBe(400)
    expect(h.rpc).toEqual([])
  })

  it('azione sconosciuta o assente: 400', async () => {
    expect((await modifica({ azione: 'cancella' })).status).toBe(400)
    expect((await modifica({ nuova_fine: '2027-08-31' })).status).toBe(400)
  })

  it('corpo non JSON: 400', async () => {
    const r = await PATCH(
      new Request(`http://localhost/api/admin/anni/${ANNO_A}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{non json',
      }) as never,
      contesto(ANNO_A) as never,
    )
    expect(r.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// POST apri-iscrizioni
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/anni/[annoSedeId]/apri-iscrizioni', () => {
  it('ok: 200 e logEvento di successo; passa chi ha aperto', async () => {
    h.esiti.anno_apri_iscrizioni = ok({
      cambiato: true,
      anno_sede_id: ANNO_A,
      stato: 'iscrizioni_aperte',
      stato_precedente: 'in_preparazione',
    })
    const r = await apri()
    expect(r.status).toBe(200)
    expect((await r.json()).data).toMatchObject({ cambiato: true, stato: 'iscrizioni_aperte' })
    expect(h.rpc).toEqual([{ nome: 'anno_apri_iscrizioni', args: { p_anno_sede: ANNO_A, p_da: UTENTE } }])
    const ev = eventi('anno-iscrizioni-aperte', 'info')
    expect(ev).toHaveLength(1)
    expect(ev[0].area).toBe('anno-scolastico')
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, utente: UTENTE })
  })

  it('già aperto: 200 cambiato=false e nessun secondo log di successo', async () => {
    h.esiti.anno_apri_iscrizioni = ok({ cambiato: false, anno_sede_id: ANNO_A, stato: 'iscrizioni_aperte' })
    const r = await apri()
    expect(r.status).toBe(200)
    expect((await r.json()).data.cambiato).toBe(false)
    expect(eventi('anno-iscrizioni-aperte')).toEqual([])
  })

  it('prerequisiti mancanti: 409 PREREQUISITI_MANCANTI con l’elenco di cosa manca, e un warn', async () => {
    h.esiti.anno_apri_iscrizioni = rifiuto('PREREQUISITI_MANCANTI', { mancano: ['quota_nuova', 'moduli_conferma'] })
    const r = await apri()
    expect(r.status).toBe(409)
    const corpo = await r.json()
    expect(corpo.codice).toBe('PREREQUISITI_MANCANTI')
    expect(corpo.mancano).toEqual(['quota_nuova', 'moduli_conferma'])
    const ev = eventi('anno-iscrizioni-rifiutate', 'warn')
    expect(ev).toHaveLength(1)
    expect(ev[0].campi).toMatchObject({ anno_sede_id: ANNO_A, n_mancanti: 2 })
    expect(eventi('anno-iscrizioni-aperte')).toEqual([])
  })

  it('un DETAIL illeggibile non fa crollare la risposta: 409 con elenco vuoto', async () => {
    h.esiti.anno_apri_iscrizioni = { data: null, error: { code: 'P0001', message: 'PREREQUISITI_MANCANTI', details: 'non json' } }
    const r = await apri()
    expect(r.status).toBe(409)
    expect((await r.json()).mancano).toEqual([])
  })

  it('anno non in preparazione: 409 STATO_NON_AMMESSO', async () => {
    h.esiti.anno_apri_iscrizioni = rifiuto('STATO_NON_AMMESSO', { anno_sede_id: ANNO_A, stato: 'corrente' })
    const r = await apri()
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('STATO_NON_AMMESSO')
  })

  it('anno inesistente nel database: 404 ANNO_NON_TROVATO', async () => {
    h.esiti.anno_apri_iscrizioni = rifiuto('ANNO_NON_TROVATO', { anno_sede_id: ANNO_A })
    const r = await apri()
    expect(r.status).toBe(404)
    expect((await r.json()).codice).toBe('ANNO_NON_TROVATO')
  })

  it('503 se la funzione non c’è (database non migrato)', async () => {
    h.esiti.anno_apri_iscrizioni = { data: null, error: { code: 'PGRST205', message: 'assente' } }
    const r = await apri()
    expect(r.status).toBe(503)
    expect((await r.json()).codice).toBe('CALENDARIO_NON_DISPONIBILE')
    expect(eventi('impostazioni-schema-indietro', 'info')).toHaveLength(1)
  })
})
