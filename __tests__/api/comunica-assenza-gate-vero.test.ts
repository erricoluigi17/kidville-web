import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { resetRateLimit } from '@/lib/security/rate-limit'

// =============================================================================
// R11 · R20 — I TETTI DIMOSTRATI CON LA GUARDIA **VERA**, NON CON LA SUA FINTA.
//
// Il quinto collaudo ha trovato otto rotte che rispondevano 500 con corpo vuoto
// a tutte le famiglie: Turbopack compilava il ramo `null` di
// `assertGenitoreNonSospeso` nella STRINGA «TURBOPACK unreachable», le rotte
// facevano `if (sospesoErr) return sospesoErr` e Next non aveva niente da
// mandare. Il difetto è chiuso alla riga (`sospensione.ts`, `if` esplicito) e
// c'è un cancello sull'artefatto (`scripts/verifica-artefatto.mjs`, `postbuild`).
//
// Ma il collaudo chiedeva anche il resto, e questa è la parte che mancava: i
// tetti della rotta (data passata, 60 giorni, 500 caratteri, account sospeso)
// erano provati SOLO con `vi.mock('@/lib/pagamenti/sospensione')` — venti file
// di test lo fanno — cioè con la guardia sostituita da una finta che restituisce
// `null` per definizione. Quei test non potevano vedere il difetto: erano verdi
// mentre in produzione nessun genitore poteva comunicare un'assenza.
//
// Qui la guardia NON è mockata. Passa dal modulo vero, legge i figli dal finto
// database (unione dei due legami, come in produzione) e la rotta prosegue solo
// se lei restituisce davvero `null`. È l'unico test del repo che dimostra il
// percorso completo gate → tetti → scrittura.
//
// ⚠️ Resta ciò che nessun test in-process può vedere: il difetto viveva
// nell'ARTEFATTO compilato, e i test girano sul sorgente. La prova che manca è
// una richiesta HTTP vera contro `next start` — vedi lo smoke E2E.
// =============================================================================

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const MAESTRA = 'd1111111-1111-4111-8111-111111111111'
const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const OGGI = '2026-08-10'
const DOMANI = '2026-08-11'

const h = vi.hoisted(() => ({ requireParent: vi.fn() }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
// `@/lib/pagamenti/sospensione` NON è mockato: è il punto di questo file.

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

let db: DBFinto
let scritture: Scrittura[]
let client: ReturnType<typeof creaFintoSupabase>

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => client }))

import {
  POST,
  GIORNI_MASSIMI_IN_ANTICIPO,
  MOTIVO_MAX_CARATTERI,
} from '@/app/api/parent/presenze/comunica-assenza/route'
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

function piuGiorni(iso: string, n: number): string {
  const [a, m, g] = iso.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, g + n)).toISOString().slice(0, 10)
}

/** Il database che serve alla guardia VERA: il legame, e il figlio con `sospeso`. */
function dbBase(sospeso = false): DBFinto {
  return {
    alunni: [
      { id: STUDENT, nome: 'Sofia', cognome: 'Rossi', section_id: SEZIONE, scuola_id: SCUOLA, sospeso },
    ],
    // La guardia risolve i figli sull'UNIONE dei due legami: qui c'è quello
    // runtime, che è la strada percorsa in produzione dagli account genitore.
    legame_genitori_alunni: [{ genitore_id: PARENT, alunno_id: STUDENT }],
    parents: [],
    student_parents: [],
    sections: [{ id: SEZIONE, school_type: 'infanzia', scuola_id: SCUOLA }],
    utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZIONE }],
    utenti: [{ id: MAESTRA, attivo: true }],
    admin_settings: [],
    presenze: [],
    notifiche: [],
  }
}

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  resetRateLimit()
  db = dbBase()
  scritture = []
  client = creaFintoSupabase(db, [], { scritture })
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R11 · la guardia vera restituisce `null` o una Response — mai altro', () => {
  it('genitore con figli NON sospesi: `null`, e in particolare non una stringa', async () => {
    const esito = await assertGenitoreNonSospeso(client as never, PARENT)

    // È la forma esatta del difetto: `"TURBOPACK unreachable"` è truthy, e i
    // chiamanti fanno `if (esito) return esito`.
    expect(typeof esito, 'la guardia ha restituito una stringa: è il difetto del quinto collaudo').not.toBe('string')
    expect(esito).toBeNull()
  })

  it('genitore con un figlio sospeso: una Response 403, non un booleano', async () => {
    db.alunni[0].sospeso = true
    const esito = await assertGenitoreNonSospeso(client as never, PARENT)

    expect(esito).not.toBeNull()
    expect(esito).toBeInstanceOf(Response)
    expect(esito!.status).toBe(403)
    await expect(esito!.json()).resolves.toMatchObject({ codice: 'ACCOUNT_SOSPESO' })
  })
})

describe('R11 · i tetti della rotta, attraversando la guardia vera', () => {
  it('la richiesta buona arriva in fondo: 201 e la riga scritta', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))

    expect(res.status, 'con la guardia vera la rotta non arriva più alla scrittura').toBe(201)
    expect(scritture.some((s) => s.tabella === 'presenze')).toBe(true)
  })

  it('il tetto sui 60 giorni scatta con la guardia vera in mezzo', async () => {
    const oltre = piuGiorni(OGGI, GIORNI_MASSIMI_IN_ANTICIPO + 1)
    const res = await POST(postReq({ studentId: STUDENT, data: oltre }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ codice: 'ASSENZA_DATA_TROPPO_LONTANA' })
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
  })

  it('il tetto sulla lunghezza del motivo, idem', async () => {
    const res = await POST(
      postReq({ studentId: STUDENT, data: DOMANI, motivo: 'x'.repeat(MOTIVO_MAX_CARATTERI + 1) }),
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ codice: 'ASSENZA_MOTIVO_TROPPO_LUNGO' })
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
  })

  it('il giorno già passato, idem', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, -1) }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ codice: 'ASSENZA_DATA_PASSATA' })
  })

  it('IL GATE DELLA MOROSITÀ, che nessun test provava sul percorso vero: 403 e nessuna scrittura', async () => {
    db.alunni[0].sospeso = true
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ codice: 'ACCOUNT_SOSPESO' })
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
  })

  it('la risposta ha SEMPRE un corpo leggibile: il guasto si vedeva come 500 a zero byte', async () => {
    for (const corpo of [
      { studentId: STUDENT, data: DOMANI },
      { studentId: STUDENT, data: piuGiorni(OGGI, -1) },
      { studentId: STUDENT, data: piuGiorni(OGGI, GIORNI_MASSIMI_IN_ANTICIPO + 1) },
    ]) {
      resetRateLimit()
      const res = await POST(postReq(corpo))
      const testo = await res.text()
      expect(testo.length, `risposta senza corpo per ${JSON.stringify(corpo)}`).toBeGreaterThan(0)
      expect(() => JSON.parse(testo)).not.toThrow()
    }
  })
})
