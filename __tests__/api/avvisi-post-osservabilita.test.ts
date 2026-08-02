import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `POST /api/avvisi` — DUE GUASTI MUTI SULLO STESSO HANDLER.
//
// F2 — La route risponde 201 e non logga NIENTE: né l'esito, né quante famiglie
//      ha davvero raggiunto. Con i soli errori «nessun log» non distingue «tutto
//      ok» da «non è partito niente» (AGENTS, regola 5) — ed è la condizione in
//      cui il sistema si trova ADESSO: il 2026-07-31, 2 alunni su 25 a Giugliano
//      non hanno nessuna riga in `student_parents`, quindi un avviso di classe su
//      quella sezione notifica meno famiglie di quante ce ne siano. In silenzio.
//
// F5 — L'insert ritenta fino a 4 volte CANCELLANDO DAL RECORD la colonna nominata
//      dall'errore PostgREST. `scuola_id` è nel record: basta che PostgREST la
//      nomini perché l'avviso venga inserito SENZA CHIAVE DI TENANCY, senza una
//      riga di log, e con 201 al chiamante. Il gemello `gallery:GET` per lo stesso
//      degrado NEGA (via `degradoSedeLecito`); qui si degradava e basta.
//
// METODO. Il logger è silenzioso sotto vitest (`.env.local` punta al DB di
// PRODUZIONE), quindi non lo si ispeziona: si mocka con delle spie e si asserisce
// sulle CHIAMATE. Le dipendenze di dominio sono mockate perché l'oggetto sotto
// esame è la SEQUENZA insert/degrado/log, non la risoluzione della sede — che ha
// già i suoi test in `avvisi-sede-scrittura.test.ts`.
//
// Niente asserzioni-fantoccio (`not.toBe(...)`): si asserisce lo stato ESATTO,
// il numero di insert eseguiti e che cosa è finito nel record.
// =============================================================================

/** Sede FINTA: nei test non entra mai un uuid di produzione (lock ). */
const SEDE = SEDE_A
const ADMIN = '11111111-1111-4111-8111-111111111111'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  getModuleConfig: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  genitoriDiScuola: vi.fn(),
  genitoriDiClassi: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  degradoSedeLecito: vi.fn(),
  /** Esiti in coda per gli insert su `avvisi`, consumati in ordine. */
  insertEsiti: [] as Array<{ data: unknown; error: unknown }>,
  /** I record DAVVERO passati a `insert()`, uno per tentativo. */
  insertRecord: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: h.getModuleConfig }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiScuola: h.genitoriDiScuola,
  genitoriDiClassi: h.genitoriDiClassi,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: h.getFigliDiGenitore }))
vi.mock('@/lib/forms/degrado-sede', () => ({
  degradoSedeLecito: h.degradoSedeLecito,
  colonnaSedeAssente: (e: { code?: string } | null | undefined) =>
    ['PGRST204', '42703'].includes(e?.code ?? ''),
}))

/**
 * Finto client minimo: SOLO `avvisi`. Qualunque altra tabella LANCIA — un mock che
 * accetta in silenzio ciò che non sa fare rende verdi i test che dovrebbero essere rossi
 * (è la regola fondativa di `__tests__/fixtures/finto-supabase.ts`).
 */
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      // Le sezioni della sede: il gate «la classe esiste in questo plesso» ha già i
      // suoi test in `avvisi-sede-scrittura.test.ts`, qui deve solo lasciar passare.
      if (tabella === 'sections') {
        const q = {
          select: () => q,
          eq: () => q,
          in: () => q,
          then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve({ data: [{ name: '2 ANNI' }], error: null }).then(ok, ko),
        }
        return q
      }
      if (tabella !== 'avvisi') {
        throw new Error(`tabella non prevista da questo test: "${tabella}"`)
      }
      const catena = {
        insert(record: Record<string, unknown>) {
          h.insertRecord.push({ ...record })
          const esito = h.insertEsiti.shift() ?? { data: { id: 'avv-1' }, error: null }
          return {
            select: () => ({ single: async () => esito }),
          }
        },
      }
      return catena
    },
  }),
}))

import { POST } from '@/app/api/avvisi/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/avvisi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const corpoAvviso = (extra: Record<string, unknown> = {}) => ({
  titolo: 'Uscita didattica',
  contenuto: 'Servono le adesioni entro venerdì.',
  target_scope: 'globale',
  scuola_id: SEDE,
  ...extra,
})

/** Le righe emesse sul canale, per livello. */
function righe(livello: string): Array<{ evento: string; campi: Record<string, unknown> }> {
  return log.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown> }))
}

/** L'errore PostgREST di colonna assente, nelle DUE forme che il DB produce davvero. */
const PGRST204 = (colonna: string) => ({
  code: 'PGRST204',
  message: `Could not find the '${colonna}' column of 'avvisi' in the schema cache`,
  details: null,
  hint: null,
})
const E42703 = (colonna: string) => ({
  code: '42703',
  message: `column "${colonna}" of relation "avvisi" does not exist`,
  details: null,
  hint: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.insertEsiti = []
  h.insertRecord = []
  h.requireDocente.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE } })
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.getModuleConfig.mockResolvedValue({ ruoli_pubblicazione: ['admin', 'teacher'] })
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.logScrittura.mockResolvedValue(undefined)
  h.notificaEvento.mockResolvedValue(undefined)
  h.genitoriDiScuola.mockResolvedValue(['g1', 'g2', 'g3'])
  h.genitoriDiClassi.mockResolvedValue([])
  // Il default è il caso di PRODUZIONE: tre sedi, nessun degrado di tenancy lecito.
  h.degradoSedeLecito.mockResolvedValue(false)
})

// ═════════════════════════════════════════════════════════════════════════════
describe('F2 — la pubblicazione logga il SUCCESSO, col numero di famiglie raggiunte', () => {
  it('201 → una riga `info` con esito, sede e n_destinatari', async () => {
    const res = await POST(post(corpoAvviso()))

    expect(res.status).toBe(201)
    const info = righe('info').filter((r) => r.campi.operazione === 'avvisi:POST')
    expect(info).toHaveLength(1)
    expect(info[0].evento).toBe('avvisi')
    expect(info[0].campi).toMatchObject({
      operazione: 'avvisi:POST',
      esito: 'pubblicato',
      // Con tre plessi, DOVE è stato pubblicato è metà del fatto.
      sede_id: SEDE,
      n_destinatari: 3,
    })
  })

  it('ZERO destinatari → la riga esce lo stesso con `n_destinatari: 0` (è il caso che conta)', async () => {
    // È la condizione viva in produzione: alunni senza nessun tutore collegato. Il
    // conteggio zero è informazione, non assenza di informazione — ed è l'unico modo
    // per distinguere «avviso recapitato» da «avviso pubblicato e mai annunciato».
    h.genitoriDiScuola.mockResolvedValue([])

    const res = await POST(post(corpoAvviso()))

    expect(res.status).toBe(201)
    const info = righe('info').filter((r) => r.campi.operazione === 'avvisi:POST')
    expect(info).toHaveLength(1)
    expect(info[0].campi).toMatchObject({ esito: 'pubblicato', n_destinatari: 0, sede_id: SEDE })
  })

  it('il conteggio è quello VERO dei destinatari, non quello delle classi bersaglio', async () => {
    h.genitoriDiClassi.mockResolvedValue(['g1'])
    h.verificaTargetAvvisoDocente.mockResolvedValue(null)

    const res = await POST(
      post({
        titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: ['2 ANNI'], scuola_id: SEDE,
      }),
    )

    expect(res.status).toBe(201)
    const info = righe('info').filter((r) => r.campi.operazione === 'avvisi:POST')
    expect(info[0].campi.n_destinatari).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('F5 — nessuna colonna si sfila in silenzio, e `scuola_id` non si sfila affatto', () => {
  it('colonna NON di tenancy (form_model_id) → si degrada, MA lo si logga', async () => {
    h.insertEsiti = [{ data: null, error: PGRST204('form_model_id') }]

    const res = await POST(post(corpoAvviso()))

    expect(res.status).toBe(201)
    // Due tentativi: il primo col record intero, il secondo senza la colonna assente.
    expect(h.insertRecord).toHaveLength(2)
    expect('form_model_id' in h.insertRecord[0]).toBe(true)
    expect('form_model_id' in h.insertRecord[1]).toBe(false)
    // …e la tenancy è rimasta al suo posto in ENTRAMBI.
    expect(h.insertRecord[1].scuola_id).toBe(SEDE)

    const avvisi = righe('warn').filter((r) => r.campi.esito === 'degrado-colonna-sfilata')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].evento).toBe('avvisi')
    expect(avvisi[0].campi).toMatchObject({
      operazione: 'avvisi:POST',
      esito: 'degrado-colonna-sfilata',
      colonna: 'form_model_id',
    })
    // Il nome della colonna DEVE arrivare anche in `app_log.messaggio`: `redact()` è a
    // lista bianca PER CHIAVE e `colonna` non è in lista — in tabella uscirebbe come
    // `[redatto:str/13]`, cioè una riga che dice «ho sfilato una colonna» senza dire quale.
    expect(String(avvisi[0].campi.msg)).toContain('form_model_id')
  })

  it('`scuola_id` su impianto MULTI-SEDE → 500 e NESSUN avviso senza tenant', async () => {
    // È il difetto, nella sua forma esatta: PostgREST nomina `scuola_id`, il record la
    // perde, l'avviso nasce senza chiave di tenancy e il chiamante riceve 201.
    h.insertEsiti = [{ data: null, error: PGRST204('scuola_id') }]
    h.degradoSedeLecito.mockResolvedValue(false)

    const res = await POST(post(corpoAvviso()))

    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Isolamento per sede non disponibile')
    // UN SOLO tentativo: non si riprova senza tenant. È l'effetto, non solo lo status.
    expect(h.insertRecord).toHaveLength(1)
    expect(h.insertRecord[0].scuola_id).toBe(SEDE)
    // Nessuna notifica: non esiste un avviso da annunciare.
    expect(h.notificaEvento).not.toHaveBeenCalled()

    // Filtro sull'evento di DOMINIO: `withRoute` emette in più la propria riga di
    // esito (`evento: 'route'`, stato 500), ed è giusto che ci sia — sono due fatti
    // diversi, «l'isolamento non c'era» e «la richiesta è finita 500».
    const errori = righe('error').filter((r) => r.evento === 'avvisi')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({
      operazione: 'avvisi:POST',
      esito: 'colonna-sede-assente-degrado-negato',
    })
    expect(righe('error').some((r) => r.evento === 'route' && r.campi.stato === 500)).toBe(true)
  })

  it('`scuola_id` con UNA sola sede (DB E2E non migrato) → degrado LECITO, ma loggato', async () => {
    h.insertEsiti = [{ data: null, error: E42703('scuola_id') }]
    h.degradoSedeLecito.mockResolvedValue(true)

    const res = await POST(post(corpoAvviso()))

    expect(res.status).toBe(201)
    expect(h.insertRecord).toHaveLength(2)
    expect('scuola_id' in h.insertRecord[1]).toBe(false)
    const avvisi = righe('warn').filter((r) => r.campi.esito === 'degrado-colonna-sfilata')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].campi.colonna).toBe('scuola_id')
  })

  it('il degrado di tenancy si CHIEDE a `degradoSedeLecito`, non si presume', async () => {
    h.insertEsiti = [{ data: null, error: PGRST204('scuola_id') }]
    h.degradoSedeLecito.mockResolvedValue(true)

    await POST(post(corpoAvviso()))

    expect(h.degradoSedeLecito).toHaveBeenCalledTimes(1)
    expect(h.degradoSedeLecito.mock.calls[0][1]).toBe('avvisi:POST')
  })

  it('una colonna NON di tenancy non scomoda il conteggio delle sedi', async () => {
    h.insertEsiti = [{ data: null, error: PGRST204('form_model_id') }]
    await POST(post(corpoAvviso()))
    expect(h.degradoSedeLecito).not.toHaveBeenCalled()
  })
})
