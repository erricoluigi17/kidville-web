import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

/**
 * IL `limit` CHE ARRIVAVA GREZZO A POSTGREST (rilievi Q18 e Q20 del quarto collaudo).
 *
 * ─── IL FATTO, MISURATO ─────────────────────────────────────────────────────
 *
 *   GET /api/parent/primaria/assenze?studentId=<proprio figlio>&limit=-1
 *   → 200 {"success":true,"data":[],"letto":false,…}
 *
 * e in `app_log`, DUE righe `error` per ogni richiesta:
 *   livello=error evento=db       stato_http=416 messaggio='Requested range not satisfiable'
 *   livello=error evento=registro campi={"esito":"assenze-non-lette",…}
 *
 * Conseguenza misurata su `/api/health` subito dopo:
 *   {"nome":"tasso-errore","esito":"degradato","dettaglio":"7 impronte d'errore attive
 *    negli ultimi 15 min (soglia 5)"} — 6 impronte su 7 nate da cinque richieste con
 *   `limit` fuori range.
 *
 * Due difetti in uno: al genitore si dice «non ho potuto leggere» (`letto:false`) per un
 * errore che è suo, e un utente autenticato decide quando far comparire un `error` nel
 * rilevatore di guasti — `SOGLIA_IMPRONTE_ERRORE = 5` impronte distinte in 15 minuti, e
 * l'impronta include l'utente.
 *
 * ─── LA STESSA FORMA NELL'ALTRA ROTTA ───────────────────────────────────────
 *
 * Cercata: `admin/primaria/fascicolo-audit:GET` faceva `Math.min(limit ?? 100, 500)` —
 * un tetto SENZA pavimento, quindi `limit=-1` passava identico a PostgREST. Lì il ramo
 * d'errore risponde **500 con `error.message` del database nel corpo**, cioè peggio.
 * Il repo aveva già la regola giusta scritta in tre punti (`gallery`, `admin/students`,
 * `admin/audit`, `news/feed`): mancava un posto solo in cui vivesse.
 */

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  requireParent: vi.fn(async () => ({ response: null, user: { id: 'u1' } })),
  requireStaff: vi.fn(async () => ({ response: null, user: { id: 'u1' } })),
  admin: vi.fn(async () => {
    throw new Error('il database non deve essere toccato: la richiesta è già stata rifiutata')
  }),
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: h.admin }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))

import { zLimite } from '@/lib/validation/common'
import { GET as assenzeGET } from '@/app/api/parent/primaria/assenze/route'
import { GET as auditGET } from '@/app/api/admin/primaria/fascicolo-audit/route'

const ALUNNO = 'aaacb836-8d02-422d-88cb-ea99cf8e3c56'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('zLimite — un intero, un minimo, un massimo', () => {
  const schema = z.object({ limit: zLimite({ predefinito: 60, max: 200 }) })

  it('assente → il default storico, senza toccare niente', () => {
    expect(schema.parse({}).limit).toBe(60)
  })

  it('una stringa numerica valida passa (i query param sono stringhe)', () => {
    expect(schema.parse({ limit: '30' }).limit).toBe(30)
  })

  it.each(['-1', '-5', '0', ' -3', 'abc', '1e999', '999999999999', '1.5'])(
    'un `limit=%s` è un errore del CLIENT, e si vede subito',
    (valore) => {
      // Tutti valori misurati nel collaudo: `-1` produceva un 416 da PostgREST, gli altri
      // arrivavano al database come `limit=NaN` o senza tetto.
      expect(schema.safeParse({ limit: valore }).success).toBe(false)
    },
  )

  it('e il tetto è un tetto: oltre il massimo si rifiuta, non si scarica mezzo anno', () => {
    expect(schema.safeParse({ limit: '201' }).success).toBe(false)
    expect(schema.parse({ limit: '200' }).limit).toBe(200)
  })
})

describe('parent/primaria/assenze:GET — il limite si valida prima del database', () => {
  it('`limit=-1` risponde 400 e NON lascia nessuna riga `error`', async () => {
    const res = await assenzeGET(
      new Request(`http://localhost/api/parent/primaria/assenze?studentId=${ALUNNO}&limit=-1`) as never,
    )
    expect(res.status).toBe(400)
    // Il punto del rilievo: un errore di battitura del client non deve alimentare la soglia
    // `tasso-errore` di /api/health.
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori, `righe error inattese: ${JSON.stringify(errori)}`).toHaveLength(0)
    expect(h.logErrore).not.toHaveBeenCalled()
    // E il database non è stato nemmeno aperto (il mock lancerebbe).
    expect(h.admin).not.toHaveBeenCalled()
  })

  it('`limit` assente resta il comportamento storico (nessun 400 a sorpresa)', async () => {
    // Il client di questa rotta non manda `limit`: se questa cade, la schermata del genitore
    // si è rotta per una difesa che doveva essere invisibile.
    h.admin.mockRejectedValueOnce(new Error('fermata qui: basta sapere che la validazione è passata'))
    const res = await assenzeGET(
      new Request(`http://localhost/api/parent/primaria/assenze?studentId=${ALUNNO}`) as never,
    )
    expect(res.status).not.toBe(400)
    expect(h.admin).toHaveBeenCalled()
  })
})

describe('admin/primaria/fascicolo-audit:GET — la stessa regola, l’altra rotta', () => {
  it('`limit=-1` risponde 400 invece di 500 con il messaggio del database', async () => {
    const res = await auditGET(
      new Request('http://localhost/api/admin/primaria/fascicolo-audit?limit=-1') as never,
    )
    expect(res.status).toBe(400)
    expect(h.admin).not.toHaveBeenCalled()
  })

  it('`limit=200` — quello che il client manda davvero — continua a passare', async () => {
    h.admin.mockRejectedValueOnce(new Error('fermata qui: basta sapere che la validazione è passata'))
    const res = await auditGET(
      new Request('http://localhost/api/admin/primaria/fascicolo-audit?limit=200') as never,
    )
    expect(res.status).not.toBe(400)
    expect(h.admin).toHaveBeenCalled()
  })
})
