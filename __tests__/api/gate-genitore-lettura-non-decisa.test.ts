/**
 * IL GATE DI PARENTELA — «non l'ho potuto leggere» non è «non è tuo figlio».
 *
 * IL FATTO (terzo collaudo, rilievo T13). `genitoreHasFiglio` collassava TRE
 * stati distinti su un `boolean`: legame presente, legame assente, lettura non
 * riuscita. PostgREST non lancia — ritorna `{ error }` (AGENTS.md, regola 7) — e
 * la prima query non destrutturava `error` affatto. Un 403 di Cloudflare davanti
 * a Supabase usciva quindi dalla porta «Accesso negato» addosso al genitore
 * TITOLARE, e per giunta accendeva il contatore `alunno-non-della-famiglia`, che
 * questo stesso ciclo aveva appena introdotto come SEGNALE DI SICUREZZA: un
 * contatore di tentativi IDOR che si riempie di guasti del database non è un
 * contatore, è rumore con un nome allarmante.
 *
 * Traccia reale, dal server.log della sessione (rid f27b3315):
 *   KV_ERR … evt=db rt=legame_genitori_alunni metodo=GET stato=403
 *            msg="<!DOCTYPE html>… Attention Required! | Cloudflare…"
 *   KV_WARN … evt=auth tipo=alunno-non-della-famiglia … utente=710717f0-…
 *
 * LA REGOLA CHE QUESTI TEST FISSANO:
 *  · lettura non riuscita → 500 + `logErrore`, mai 403 e mai il `warn` di IDOR;
 *  · legame davvero assente → 403 e `warn` come prima (il segnale resta);
 *  · legame presente → passa.
 *
 * E il rilievo T16, che vive nello stesso gate: uno `studentId` che non è un
 * uuid non deve arrivare a PostgREST. La guardia esisteva già ma stava DOPO il
 * `return` del ramo `genitore`, quindi per un genitore il valore grezzo
 * raggiungeva `.eq('alunno_id','abc')` e produceva una riga `error`/`22P02` in
 * `app_log` — un errore di battitura del client contato come guasto del server,
 * dentro la soglia `tasso-errore` di /api/health.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const GENITORE = '710717f0-d5ae-4f6f-889f-60d167b65a3b'
const FIGLIO = 'aaacb836-8d02-422d-88cb-ea99cf8e3c56'

const h = vi.hoisted(() => ({
  /** Errore iniettato su OGNI lettura del client (il guasto di PostgREST). */
  errore: null as { code: string; message: string } | null,
  /** Le righe che `legame_genitori_alunni` restituisce quando la lettura riesce. */
  legame: null as { alunno_id: string } | null,
  /** I filtri `.eq()` visti su `legame_genitori_alunni`: servono a provare T16. */
  filtri: [] as { colonna: string; valore: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: { id: GENITORE, role: 'genitore' }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn(async () => null) }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'order', 'limit']) qb[m] = () => qb
      qb.eq = (colonna: string, valore: unknown) => {
        if (tabella === 'legame_genitori_alunni') h.filtri.push({ colonna, valore })
        return qb
      }
      qb.maybeSingle = async () =>
        h.errore ? { data: null, error: h.errore } : { data: h.legame, error: null }
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(h.errore ? { data: null, error: h.errore } : { data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const req = () => new Request('http://localhost/api/parent/presenze?studentId=x')

beforeEach(() => {
  vi.clearAllMocks()
  h.errore = null
  h.legame = null
  h.filtri = []
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T13 — una lettura fallita non diventa «questo bambino non è tuo figlio»', () => {
  it('PostgREST in errore → 500, mai 403', async () => {
    h.errore = { code: '42501', message: 'permission denied for table legame_genitori_alunni' }
    const esito = await requireParentOfStudent(req(), FIGLIO)
    expect(esito.response?.status, 'un guasto del database non è un tentativo di IDOR').toBe(500)
  })

  it('il corpo del 500 non accusa il genitore né riporta la prosa di PostgREST', async () => {
    h.errore = { code: '42501', message: 'permission denied for table legame_genitori_alunni' }
    const esito = await requireParentOfStudent(req(), FIGLIO)
    const corpo = JSON.stringify(await esito.response!.json())
    expect(corpo).not.toContain('Accesso negato')
    expect(corpo).not.toContain('permission denied')
  })

  it('NON accende il contatore di sicurezza `alunno-non-della-famiglia`', async () => {
    h.errore = { code: '42501', message: 'permission denied' }
    await requireParentOfStudent(req(), FIGLIO)
    const falsoPositivo = logEvento.mock.calls.find((c) =>
      JSON.stringify(c[2]).includes('alunno-non-della-famiglia'),
    )
    expect(
      falsoPositivo,
      'un contatore di IDOR che conta i guasti del DB non distingue più un attacco da un blip',
    ).toBeUndefined()
  })

  it('il guasto lascia una riga `error` con il codice PostgREST', async () => {
    h.errore = { code: '42501', message: 'permission denied' }
    await requireParentOfStudent(req(), FIGLIO)
    const tutto = JSON.stringify([...logErrore.mock.calls, ...logEvento.mock.calls])
    expect(tutto, 'un degrado muto è indistinguibile da un funzionamento normale').toContain('42501')
  })

  it('legame davvero assente: resta il 403 e resta il `warn` (il segnale non si perde)', async () => {
    h.errore = null
    h.legame = null
    const esito = await requireParentOfStudent(req(), FIGLIO)
    expect(esito.response?.status).toBe(403)
    const warn = logEvento.mock.calls.find((c) =>
      JSON.stringify(c[2]).includes('alunno-non-della-famiglia'),
    )
    expect(warn, 'il contatore dei tentativi veri deve restare').toBeTruthy()
  })

  it('legame presente: il gate passa', async () => {
    h.legame = { alunno_id: FIGLIO }
    const esito = await requireParentOfStudent(req(), FIGLIO)
    expect(esito.response).toBeFalsy()
    expect(esito.user?.id).toBe(GENITORE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T9 — il contatore dei tentativi si può interrogare PER BAMBINO', () => {
  const warn = (tipo: string) =>
    logEvento.mock.calls.find((c) => (c[2] as Record<string, unknown>)?.tipo === tipo)

  it('il rifiuto distingue la riga per alunno bersagliato', async () => {
    await requireParentOfStudent(req(), FIGLIO)
    const opzioni = warn('alunno-non-della-famiglia')?.[4] as { distingui?: string[] } | undefined
    expect(
      opzioni?.distingui,
      'venti tentativi su venti bambini diversi producevano UNA riga, che ne nominava uno',
    ).toContain('alunno_id')
  })

  it('la riga porta lo `stato` 403, così «dammi tutti i 403 di ieri» la trova', async () => {
    await requireParentOfStudent(req(), FIGLIO)
    // `logEvento` popola la colonna `stato_http` solo se `stato` è un numero:
    // senza, quei rifiuti si trovavano solo cercando per messaggio.
    expect((warn('alunno-non-della-famiglia')?.[2] as Record<string, unknown>)?.stato).toBe(403)
  })

  it('il ramo gemello (staff fuori sede) dice anch’esso QUALE alunno', async () => {
    // Due difese scritte nello stesso file a trenta righe di distanza
    // raccontavano il rifiuto in due modi diversi: qui l'alunno non c'era, e
    // finiva solo dentro `payload.query`, cioè dove `withRoute` lo mette per caso.
    const { assertAlunnoInScope } = await import('@/lib/auth/scope')
    vi.mocked(assertAlunnoInScope).mockResolvedValueOnce(
      new Response(null, { status: 403 }) as never,
    )
    const { requireUser } = await import('@/lib/auth/require-staff')
    vi.mocked(requireUser).mockResolvedValueOnce({
      user: { id: GENITORE, role: 'educator' },
      response: null,
    } as never)
    await requireParentOfStudent(req(), FIGLIO)
    const riga = warn('alunno-fuori-sede')
    expect(riga?.[2]).toMatchObject({ alunno_id: FIGLIO, stato: 403 })
    expect((riga?.[4] as { distingui?: string[] } | undefined)?.distingui).toContain('alunno_id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T16 — uno studentId malformato non arriva mai a PostgREST', () => {
  it('id non-uuid: 404 senza interrogare il database', async () => {
    const esito = await requireParentOfStudent(req(), 'abc')
    expect(esito.response?.status).toBe(404)
    expect(
      h.filtri,
      'con un id non-uuid PostgREST risponde 22P02 e la riga finisce fra i guasti del SERVER',
    ).toHaveLength(0)
  })

  it('id non-uuid: nessun `warn` di IDOR (è un errore di battitura, non un tentativo)', async () => {
    await requireParentOfStudent(req(), "' or 1=1--")
    expect(
      logEvento.mock.calls.find((c) => JSON.stringify(c[2]).includes('alunno-non-della-famiglia')),
    ).toBeUndefined()
  })

  it('id uuid valido: il database viene interrogato come sempre', async () => {
    h.legame = { alunno_id: FIGLIO }
    await requireParentOfStudent(req(), FIGLIO)
    expect(h.filtri.some((f) => f.colonna === 'alunno_id' && f.valore === FIGLIO)).toBe(true)
  })
})
