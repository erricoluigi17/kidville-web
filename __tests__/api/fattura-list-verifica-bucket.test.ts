import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `pdf_disponibile` — LA COLONNA DICE DOVE CERCARE, IL BUCKET DICE SE C'È.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO ────────────────────────────────────────────────────────────
 *
 * `pdf_disponibile` valeva `!!r.pdf_path`: si fidava di una colonna scritta da
 * un'altra rotta (`fattura/sync`) in un altro momento. Se l'upload nel bucket
 * fallisce DOPO che la riga è stata scritta — o se qualcuno ripulisce lo Storage
 * — la colonna continua a dire «sì», il pulsante «Scarica» compare, e chi lo
 * preme riceve un 404. Nel frattempo nessun test è rosso, perché il dato in
 * tabella è coerente con sé stesso.
 *
 * Ora si guarda il bucket. E si guarda con UNA chiamata sola: le chiavi hanno la
 * forma `<pagamento_id>-<numero>.pdf` e stanno in radice, quindi una `list` con
 * `search: pagamento_id` le copre tutte, quante che siano le quote.
 *
 * ─── E QUANDO NON SI PUÒ GUARDARE, SI CHIUDE ───────────────────────────────
 *
 * `supabase-storage-js` NON LANCIA: `list()` ritorna `{ data, error }`. Se
 * l'elenco non è interrogabile, tutti i `pdf_disponibile` vanno a `false` e resta
 * una riga `error`: meglio nessun pulsante che un pulsante che dà 404 — il primo
 * si spiega da sé, il secondo fa telefonare in segreteria.
 *
 * ─── LA PROSA DI POSTGREST NON ARRIVA A UNA SCHERMATA DI FAMIGLIA ──────────
 *
 * Il corpo dell'errore portava `error.message`: davanti a un genitore finiva il
 * messaggio inglese del database col nome di una colonna dentro. È lo stesso
 * difetto che il 2026-09-05 ha messo davanti alla segreteria di Cesa «there is no
 * unique or exclusion constraint matching the ON CONFLICT specification», nove
 * volte di fila. E sul DB E2E della CI — che non è migrato — `fatture_emesse` può
 * non esistere affatto: lì non è un guasto, è un ambiente diverso, e la risposta
 * è un elenco vuoto con una riga `info`. Mai un 500.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const PID = 'aaaaaaaa-0000-4000-8000-0000000000c1'

const h = vi.hoisted(() => ({
  righe: [] as Record<string, unknown>[],
  erroreSelect: null as { code?: string; message?: string } | null,
  nomiBucket: [] as { name: string }[],
  erroreLista: null as unknown,
  chiamateLista: 0,
  ricerche: [] as unknown[],
}))

vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
  assertAlunnoInScope: vi.fn(async () => null),
  assertParentInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['sc-1']),
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  resolveScuolaScrittura: vi.fn(async () => ({ scuolaId: 'sc-1' })),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })),
  requireStaff: vi.fn(async () => ({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? { id: PID, alunno_id: 'al-1' } : null,
        error: null,
      })
      // PostgREST NON lancia: `{ data, error }` anche quando la tabella non esiste.
      b.then = (ok: (v: unknown) => unknown) =>
        ok(table === 'fatture_emesse'
          ? { data: h.erroreSelect ? null : h.righe, error: h.erroreSelect }
          : { data: [], error: null })
      return b
    },
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: null }),
        list: async (prefisso: string, opzioni: unknown) => {
          h.chiamateLista += 1
          h.ricerche.push(opzioni)
          return { data: h.erroreLista ? null : h.nomiBucket, error: h.erroreLista }
        },
      }),
    },
  }),
}))

import { GET as LISTA } from '@/app/api/pagamenti/fattura/list/route'

const chiedi = () => LISTA(new Request(`http://test/api/pagamenti/fattura/list?pagamento_id=${PID}`))

function righeLog(canale: string, livello: string) {
  return log.logEvento.mock.calls
    .filter((c) => c[0] === canale && c[1] === livello)
    .map((c) => ({ campi: c[2] as Record<string, unknown>, err: c[3] }))
}

/** Due quote (genitori separati): una col PDF caricato, una senza. */
const DUE_QUOTE = [
  { id: 'f1', numero: 10, anno: 2026, quota_label: 'Mamma', quota_adult_id: 'u-m', intestatario: { nome: 'Giulia', cognome: 'Farina' }, pdf_path: `${PID}-10.pdf`, sdi_stato: 7, sdi_stato_label: 'Consegnata' },
  { id: 'f2', numero: 11, anno: 2026, quota_label: 'Papà', quota_adult_id: 'u-p', intestatario: { nome: 'Marco', cognome: 'Rossi' }, pdf_path: `${PID}-11.pdf`, sdi_stato: 7, sdi_stato_label: 'Consegnata' },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = DUE_QUOTE.map((r) => ({ ...r }))
  h.erroreSelect = null
  h.nomiBucket = []
  h.erroreLista = null
  h.chiamateLista = 0
  h.ricerche = []
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la colonna dice sì, il bucket dice no', () => {
  it('`pdf_path` scritto ma l’oggetto non è nel bucket → `pdf_disponibile` false', async () => {
    // Il caso vero: l'upload è fallito dopo la scrittura della riga, oppure lo
    // Storage è stato ripulito. La colonna non se n'è accorta.
    h.nomiBucket = [{ name: `${PID}-10.pdf` }]   // c'è solo la prima quota

    const res = await chiedi()

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(2)
    expect(j.data[0]).toMatchObject({ numero: 10, pdf_disponibile: true })
    expect(j.data[1]).toMatchObject({ numero: 11, pdf_disponibile: false })
  })

  it('nessuna delle due chiavi è nel bucket → tutte false, con le righe ancora elencate', async () => {
    h.nomiBucket = []
    const j = await (await chiedi()).json()
    // L'elenco resta (la fattura ESISTE, e il suo stato SDI si legge): quello che
    // sparisce è il comando di scarico.
    expect(j.data.map((r: { pdf_disponibile: boolean }) => r.pdf_disponibile)).toEqual([false, false])
    expect(j.data).toHaveLength(2)
  })

  it('lo Storage si interroga UNA volta sola, e solo se c’è una chiave da verificare', async () => {
    h.nomiBucket = [{ name: `${PID}-10.pdf` }, { name: `${PID}-11.pdf` }]
    await chiedi()
    expect(h.chiamateLista).toBe(1)
    expect(h.ricerche[0]).toMatchObject({ search: PID })
  })

  it('nessuna riga ha `pdf_path` → il bucket non si interroga affatto', async () => {
    h.righe = DUE_QUOTE.map((r) => ({ ...r, pdf_path: null }))
    const j = await (await chiedi()).json()
    expect(h.chiamateLista).toBe(0)
    expect(j.data.map((r: { pdf_disponibile: boolean }) => r.pdf_disponibile)).toEqual([false, false])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('lo Storage non è interrogabile → fail-closed, e si sa', () => {
  it('`list()` in errore → tutte false e una riga `error`', async () => {
    h.erroreLista = { message: 'Bucket not found', statusCode: '404' }

    const res = await chiedi()

    expect(res.status).toBe(200)     // l'elenco si dà lo stesso: la fattura esiste.
    const j = await res.json()
    expect(j.data.map((r: { pdf_disponibile: boolean }) => r.pdf_disponibile)).toEqual([false, false])

    const g = righeLog('storage', 'error')
    expect(g).toHaveLength(1)
    expect(g[0].campi).toMatchObject({
      operazione: 'pagamenti/fattura/list:GET',
      bucket: 'fatture',
      esito: 'elenco-non-interrogabile',
      pagamento_id: PID,
    })
    // L'errore INTERO, non il solo status.
    expect(g[0].err).toBe(h.erroreLista)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('lo schema non c’è (DB E2E della CI, mai migrato)', () => {
  const PROSA = 'relation "public.fatture_emesse" does not exist'

  it('`42P01` → 200 con elenco vuoto e una riga `info`: mai un 500', async () => {
    h.erroreSelect = { code: '42P01', message: PROSA }

    const res = await chiedi()

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ success: true, data: [] })

    const i = righeLog('db', 'info')
    expect(i).toHaveLength(1)
    expect(i[0].campi).toMatchObject({
      operazione: 'pagamenti/fattura/list:GET',
      esito: 'registro-fatture-assente',
      entita_tipo: 'fatture_emesse',
      error_code: '42P01',
    })
    // Nessun 500 travestito, e nessuna riga `error`: non è un guasto.
    expect(righeLog('db', 'error')).toHaveLength(0)
  })

  it('la PROSA del database non compare mai nel corpo della risposta', async () => {
    h.erroreSelect = { code: '42P01', message: PROSA }
    const corpo = await (await chiedi()).text()
    expect(corpo).not.toContain('does not exist')
    expect(corpo).not.toContain('fatture_emesse')
    expect(corpo).not.toContain(PROSA)
  })

  it('gli altri codici di «schema assente» si comportano uguale (42703, PGRST205)', async () => {
    for (const code of ['42703', 'PGRST205', 'PGRST204']) {
      vi.clearAllMocks()
      h.erroreSelect = { code, message: PROSA }
      const res = await chiedi()
      expect(res.status, `codice ${code}`).toBe(200)
      expect((await res.json()).data).toEqual([])
    }
  })

  it('un errore VERO invece è 500 — con un codice, e sempre senza prosa', async () => {
    // Il controllo negativo del ramo qui sopra: se «schema assente» inghiottisse
    // TUTTO, un guasto di lettura uscirebbe come «questo pagamento non ha
    // fatture», che è un'affermazione su un dato che non si è letto.
    h.erroreSelect = { code: '42501', message: 'permission denied for table fatture_emesse' }

    const res = await chiedi()

    expect(res.status).toBe(500)
    const corpo = await res.text()
    expect(JSON.parse(corpo).codice).toBe('LETTURA_FALLITA')
    expect(corpo).not.toContain('permission denied')
    expect(righeLog('db', 'error')).toHaveLength(1)
    expect(righeLog('db', 'error')[0].campi).toMatchObject({ error_code: '42501' })
  })
})
