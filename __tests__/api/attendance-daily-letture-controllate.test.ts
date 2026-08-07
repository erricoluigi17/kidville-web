/**
 * `POST /api/attendance/daily` — «non c'è» e «non l'ho potuto leggere» non sono
 * la stessa cosa, nemmeno qui.
 *
 * IL FATTO (collaudo del 2026-08-07). Due letture PostgREST di questo handler
 * destrutturavano il solo `data`:
 *
 *   const { data: alunno } = await supabase.from('alunni')…maybeSingle()
 *   if (!alunno) return NextResponse.json({ error: 'Alunno non trovato.' }, 404)
 *
 *   const { data: prima } = await supabase.from('presenze').select('stato')…
 *
 * **PostgREST non lancia**: l'errore torna nel valore, e il `try/catch` attorno
 * non scatta mai (AGENTS.md, regola 7). Le due conseguenze sono diverse e
 * nessuna delle due è cosmetica:
 *
 *  (a) un guasto di lettura usciva dalla porta del 404: al DOCENTE si diceva che
 *      il bambino non esiste. E la riga non veniva scritta affatto — quindi non
 *      veniva scritto `registrato_da`, che è il presidio su cui poggia
 *      l'annullamento dell'assenza comunicata dal genitore;
 *  (b) sulla seconda, `prima` restava `null`, la condizione
 *      `prima?.stato !== 'assente'` diventava vera e la notifica «tuo figlio è
 *      stato segnato assente» ripartiva a ogni ri-salvataggio dell'appello.
 *      Una notifica DUPLICATA su un dato di un minore, senza una riga che
 *      dicesse perché.
 *
 * LA DECISIONE, dichiarata invece che implicita: quando lo stato precedente non
 * si è potuto leggere **non si spedisce** (una seconda «assente» per lo stesso
 * giorno è peggio di nessuna), ma **si revoca lo stesso** — la revoca toglie
 * dalla coda una notifica che sarebbe FALSA, e su una coda vuota non toglie
 * niente. In dubbio non si spedisce; in dubbio si revoca.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const SEDE = 'e1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const DOCENTE = 'd1111111-1111-4111-8111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  assertClasseNomeInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  restringiASedeRichiesta: vi.fn(),
  notificaEvento: vi.fn(),
  /** Errore iniettato sulla lettura dell'anagrafica. */
  erroreAlunno: null as { code: string; message: string } | null,
  /** L'anagrafica non trova la riga: `{ data: null, error: null }`. */
  alunnoAssente: false,
  /** Errore iniettato sulla lettura dello stato precedente. */
  errorePrima: null as { code: string; message: string } | null,
  /** Lo stato del giorno già in tabella, oppure `null` (prima marcatura). */
  statoPrima: null as string | null,
  /** Le `delete` eseguite su `notifiche` (la revoca). */
  revoche: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: h.assertClasseNomeInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: h.restringiASedeRichiesta }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: vi.fn() }))

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
      let operazione: 'select' | 'delete' = 'select'
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'upsert']) qb[m] = () => qb
      qb.delete = () => {
        operazione = 'delete'
        if (tabella === 'notifiche') h.revoche.push('revoca')
        return qb
      }
      qb.maybeSingle = async () => {
        if (tabella === 'alunni') {
          if (h.erroreAlunno) return { data: null, error: h.erroreAlunno }
          if (h.alunnoAssente) return { data: null, error: null }
          return { data: { nome: 'Sofia', scuola_id: SEDE, section_id: SEZIONE }, error: null }
        }
        // `presenze`: lo stato precedente del giorno.
        return h.errorePrima
          ? { data: null, error: h.errorePrima }
          : { data: h.statoPrima ? { stato: h.statoPrima } : null, error: null }
      }
      qb.single = async () => ({ data: { id: 'riga-1' }, error: null })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: operazione === 'delete' ? [] : [], error: null }).then(res)
      return qb
    },
  })),
}))

import { POST } from '@/app/api/attendance/daily/route'

const req = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/attendance/daily', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alunno_id: ALUNNO, data: '2026-08-10', ...body }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.erroreAlunno = null
  h.alunnoAssente = false
  h.errorePrima = null
  h.statoPrima = null
  h.revoche = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator' }, response: null })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
describe('la lettura dell’anagrafica: 500 col suo codice, mai il 404 che mente', () => {
  it('lettura fallita → 500, NON 404 «Alunno non trovato»', async () => {
    h.erroreAlunno = { code: '42501', message: 'permission denied for table alunni' }
    const res = await POST(req({ stato: 'presente' }))
    expect(res.status).toBe(500)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('Alunno non trovato')
    // Il `message` di PostgREST resta nel log, non esce verso il docente.
    expect(corpo).not.toContain('permission denied')
  })

  it('la riga di log è un `error` con `evento: db` e il codice PostgREST', async () => {
    h.erroreAlunno = { code: '42501', message: 'permission denied for table alunni' }
    await POST(req({ stato: 'presente' }))
    const riga = logErrore.mock.calls.find((c) =>
      JSON.stringify(c[0]).includes('attendance/daily:POST'),
    )
    expect(riga, 'un guasto di lettura senza log è un guasto che nessuno trova').toBeTruthy()
    expect(riga?.[0]).toMatchObject({ operazione: 'attendance/daily:POST', stato: 500, evento: 'db' })
    expect(JSON.stringify(logErrore.mock.calls)).toContain('42501')
  })

  it('alunno davvero assente in anagrafica: resta il 404 di sempre', async () => {
    // Il 404 non sparisce: sparisce la BUGIA. `error` nullo e `data` nullo
    // significa ancora «non c'è», e quella porta va lasciata aperta.
    h.alunnoAssente = true
    const res = await POST(req({ stato: 'presente' }))
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toContain('Alunno non trovato')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('lo stato precedente: in dubbio non si spedisce, in dubbio si revoca', () => {
  it('lettura fallita + `assente`: NESSUNA notifica (una seconda «assente» sarebbe peggio)', async () => {
    h.errorePrima = { code: '42501', message: 'permission denied for table presenze' }
    const res = await POST(req({ stato: 'assente' }))
    expect(res.status).toBe(200)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('lettura fallita: resta una riga `warn` che dice perché la notifica non è partita', async () => {
    h.errorePrima = { code: '42501', message: 'permission denied for table presenze' }
    await POST(req({ stato: 'assente' }))
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('stato-precedente-non-letto'),
    )
    expect(riga, 'un degrado muto è indistinguibile da un funzionamento normale').toBeTruthy()
    expect(riga?.[2]).toMatchObject({
      operazione: 'attendance/daily:POST',
      esito: 'stato-precedente-non-letto',
      alunno_id: ALUNNO,
    })
    expect(JSON.stringify(logEvento.mock.calls)).toContain('42501')
  })

  it('lettura fallita + stato NON assente: la revoca si tenta lo stesso', async () => {
    // Togliere dalla coda una notifica che sarebbe FALSA non costa niente se la
    // coda è vuota, e salva un genitore da un «assente» già corretto.
    h.errorePrima = { code: '42501', message: 'permission denied for table presenze' }
    await POST(req({ stato: 'presente' }))
    expect(h.revoche.length).toBeGreaterThan(0)
  })

  it('lettura riuscita: la prima marcatura «assente» notifica come sempre', async () => {
    h.statoPrima = null
    await POST(req({ stato: 'assente' }))
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
  })

  it('lettura riuscita: un ri-salvataggio «assente» su «assente» NON ri-notifica', async () => {
    h.statoPrima = 'assente'
    await POST(req({ stato: 'assente' }))
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })
})
