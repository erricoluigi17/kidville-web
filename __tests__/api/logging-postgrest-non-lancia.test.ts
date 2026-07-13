import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * DUE ROUTE, LO STESSO SBAGLIO: un log appeso a un `catch` che non scatta.
 *
 * PostgREST — e `supabase-storage-js` con lui — NON LANCIANO: ritornano `{ error }`. Un
 * `try/catch` attorno a `await supabase…` è codice morto, e un log messo lì dentro è copertura
 * finta: sembra esserci, non c'è. Questi test coprono i due casi in cui il danno è concreto.
 *
 *  1. `attendance/daily:POST`, ramo di REVOCA. La maestra corregge l'appello entro il buffer di
 *     10' (assente → presente) e la notifica pending va tolta dalla coda. Se la `delete` fallisce
 *     e nessuno guarda `{ error }`, la push parte lo stesso: il genitore riceve «tuo figlio è
 *     stato segnato assente» per un'assenza già rientrata. Non una notifica mancata: una
 *     notifica FALSA — ed è proprio il caso che il commento del vecchio log prometteva di coprire.
 *
 *  2. `pagamenti/fattura:GET`. L'`error` del `download` era scartato dalla destrutturazione:
 *     l'utente che chiede la fattura ufficiale Aruba riceve la «copia di cortesia» generata al
 *     volo — un altro documento — e nei log non resta niente.
 *
 * In entrambi i casi il finto Supabase RISOLVE con `{ error }` (non solleva), come quello vero:
 * è la condizione che rendeva morti i catch. Se qualcuno rimettesse il log solo nel catch, questi
 * test tornerebbero rossi.
 */

// ── Le spie sul logger (silenzioso sotto vitest: si osservano le CHIAMATE) ───
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const h = vi.hoisted(() => ({
  // attendance
  statoPrima: null as string | null,
  deleteError: null as unknown,
  deletes: [] as Array<Record<string, unknown>>,
  // fattura
  pag: null as Record<string, unknown> | null,
  downloadError: null as unknown,
  downloadData: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'doc-1', role: 'educator', scuola_id: 's1' } })),
  requireStaff: vi.fn(async () => ({ user: { id: 'staff-1', role: 'admin' } })),
  requireUser: vi.fn(async () => ({ user: { id: 'staff-1', role: 'admin' } })),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const filtri: Record<string, unknown> = { table }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'limit']) b[m] = () => b
      b.eq = (col: string, val: unknown) => { filtri[col] = val; return b }
      b.maybeSingle = async () => {
        if (table === 'alunni') return { data: { nome: 'Sofia', scuola_id: 's1', section_id: 'sec1' }, error: null }
        if (table === 'presenze') return { data: h.statoPrima ? { stato: h.statoPrima } : null, error: null }
        if (table === 'pagamenti') return { data: h.pag, error: null }
        return { data: null, error: null }
      }
      b.upsert = () => ({ select: () => ({ single: async () => ({ data: { id: 'pr1' }, error: null }) }) })
      b.delete = () => {
        const d: Record<string, unknown> = {}
        d.eq = (col: string, val: unknown) => { filtri[col] = val; return d }
        // RISOLVE con `{ error }`: non solleva. È il comportamento vero di PostgREST — quello
        // che rendeva il catch della route codice morto.
        d.is = async (col: string, val: unknown) => {
          filtri[col] = val
          h.deletes.push({ ...filtri })
          return { error: h.deleteError }
        }
        return d
      }
      b.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null })
      return b
    },
    storage: {
      from: () => ({
        // Idem per lo Storage: `{ data, error }`, mai un throw.
        download: async () => ({ data: h.downloadData, error: h.downloadError }),
      }),
    },
  }),
}))

import { POST as PRESENZA } from '@/app/api/attendance/daily/route'
import { GET as FATTURA } from '@/app/api/pagamenti/fattura/route'

const ALUNNO = '22222222-2222-4222-8222-222222222222'
const PAG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

const ERR_PG = { code: '42501', message: 'permission denied for table notifiche', details: null, hint: null }

function righe(livello: string) {
  return log.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown>, err: c[3] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.statoPrima = null
  h.deleteError = null
  h.deletes = []
  h.pag = null
  h.downloadError = null
  h.downloadData = null
})

// ═════════════════════════════════════════════════════════════════════════════
describe('attendance/daily:POST — la REVOCA della notifica di assenza', () => {
  function req(stato: string) {
    return new NextRequest('http://test/api/attendance/daily', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alunno_id: ALUNNO, data: '2026-07-13', stato }),
    })
  }

  it('revoca fallita (la delete ritorna { error }) → riga `error`, e la risposta resta 200', async () => {
    h.statoPrima = 'assente'          // era assente…
    h.deleteError = ERR_PG            // …e la revoca non passa

    const res = await PRESENZA(req('presente'))  // …la maestra corregge: presente

    // La logica non cambia: la presenza è salvata, l'utente vede 200.
    expect(res.status).toBe(200)
    // Ma la notifica pending è rimasta in coda e partirà: il genitore riceverà un avviso FALSO.
    expect(h.deletes).toHaveLength(1)
    const errori = righe('error').filter((r) => r.evento === 'notifica')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({
      operazione: 'attendance/daily:POST',
      esito: 'revoca-assenza-fallita',
      tipo: 'assenza_non_comunicata',
    })
    expect(errori[0].err).toBe(ERR_PG)  // l'errore INTERO: `code` compreso
  })

  it('revoca riuscita → nessuna riga di guasto', async () => {
    h.statoPrima = 'assente'
    const res = await PRESENZA(req('presente'))
    expect(res.status).toBe(200)
    expect(h.deletes).toHaveLength(1)
    expect(righe('error').filter((r) => r.evento === 'notifica')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('pagamenti/fattura:GET — il PDF ufficiale che non si scarica', () => {
  function req() {
    return new Request(`http://test/api/pagamenti/fattura?pagamento_id=${PAG}`)
  }

  beforeEach(() => {
    h.pag = {
      id: PAG, descrizione: 'Retta', fattura_causale: null, importo: 100,
      fattura_stato: 'emessa', fattura_aruba_id: 'X1', fattura_pdf_path: 'fatture/x1.pdf',
      fattura_emessa_il: '2026-07-01', alunno_id: ALUNNO, alunni: { nome: 'Sofia', cognome: 'Rossi' },
    }
  })

  it('download fallito ({ error } scartato prima) → riga `warn`, e l\'utente riceve l\'anteprima', async () => {
    h.downloadError = { message: 'Object not found', statusCode: '404' }

    const res = await FATTURA(req())

    // Logica invariata: il fallback alla copia di cortesia c'era e resta.
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    // Ma adesso si SA che l'utente non ha in mano la fattura Aruba.
    const avvisi = righe('warn').filter((r) => r.evento === 'storage')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].campi).toMatchObject({
      operazione: 'pagamenti/fattura:GET',
      bucket: 'fatture',
      esito: 'pdf_non_recuperabile_uso_anteprima',
    })
    expect(avvisi[0].err).toBe(h.downloadError)
  })

  it('download riuscito → il PDF vero, e nessuna riga di guasto', async () => {
    h.downloadData = new Blob([new Uint8Array([1, 2, 3])])

    const res = await FATTURA(req())

    expect(res.status).toBe(200)
    expect(righe('warn')).toHaveLength(0)
    expect(righe('error')).toHaveLength(0)
  })
})
