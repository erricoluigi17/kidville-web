import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import {
  creaFintoSupabase,
  type DBFinto,
  type OpzioniFinto,
  type Riga,
  type Scrittura,
} from '../fixtures/finto-supabase'

// =============================================================================
// L9 — SI SBLOCCA UNO *SLOT*, NON SOLTANTO UNA RIGA GIÀ SCRITTA.
//
// ─── IL CICLO CHIUSO, MISURATO ───────────────────────────────────────────────
// `timelock_giorni_classe_orale` vale 2 su tutte e quattro le sedi (letto in
// produzione il 2026-09-09), quindi firmare giovedì la lezione di lunedì è già
// fuori termine. `primaria/registro:POST` cerca lo sblocco solo `if (esistente)`:
// un'ora MAI firmata non ha riga, quindi `overridden` resta falso e la risposta è
// 423 «Richiedi lo sblocco al dirigente» — per chiunque, dirigente compreso.
// E il dirigente non poteva sbloccarla: questa route pretendeva `entitaId`, cioè
// l'uuid di una riga che per definizione non esiste ancora.
//
// Da qui in avanti la route accetta ANCHE le coordinate dello slot
// (`sectionId` + `data` + `oraLezione`) e le registra in `sblocchi_audit`, così
// che il registro possa ritrovare l'autorizzazione per SLOT invece che per riga.
//
// ─── PERCHÉ IL FINTO CLIENT E NON UN MOCK PIATTO ─────────────────────────────
// `creaFintoSupabase` filtra e scrive DAVVERO: «lo sblocco di una classe di
// un'altra sede viene respinto» è una proprietà verificata, non asserita, e
// `assertSezioneInScope` gira per intero invece di essere sostituita da un
// `mockResolvedValue(null)` che sarebbe verde con e senza il gate.
// =============================================================================

const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const MAESTRA = 'd0ce0001-0000-4000-8000-000000000002'
const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const RIGA_REGISTRO = 'e9157200-0000-4000-8000-000000000001'
const VALUTAZIONE = 'e9157200-0000-4000-8000-000000000002'
/** Il lunedì della lezione mai firmata: una data fissa, non «oggi meno tre». */
const LUNEDI = '2026-09-07'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  /** `true` ⇒ il finto client emula il DB E2E della CI, senza le colonne dello slot. */
  senzaColonneSlot: false,
}))

// Solo i due emettitori sono sostituiti: il resto di `logger` resta REALE, perché
// `withRoute` ne usa altri pezzi e un mock totale collauderebbe l'impalcatura.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))

/** Le tre colonne che la migrazione di questo lotto aggiunge a `sblocchi_audit`. */
const COLONNE_SLOT = ['section_id', 'data', 'ora_lezione'] as const

/**
 * Il finto client con lo SCHEMA di un database non migrato.
 *
 * PostgREST non rifiuta la tabella: rifiuta l'INSERT che NOMINA una colonna che
 * il suo schema cache non ha (`PGRST204`), e lascia passare esattamente lo stesso
 * insert senza quelle colonne. Un'iniezione d'errore per tabella non saprebbe
 * distinguere i due casi — e il ripiego «riprova senza le colonne nuove» sarebbe
 * collaudato da un test che lo vede fallire comunque, cioè da niente.
 */
function fintoConSchema(db: DBFinto, tabelle: string[], opzioni: OpzioniFinto): SupabaseClient {
  const vero = creaFintoSupabase(db, tabelle, opzioni)
  if (!h.senzaColonneSlot) return vero
  const grezzo = vero as unknown as { from: (t: string) => Record<string, unknown> }
  return {
    from(tabella: string) {
      const qb = grezzo.from(tabella)
      if (tabella !== 'sblocchi_audit') return qb
      const insertVero = qb.insert as (righe: Riga) => unknown
      qb.insert = (righe: Riga) => {
        const assente = COLONNE_SLOT.find((c) => c in righe)
        if (!assente) return insertVero.call(qb, righe)
        const error = {
          code: 'PGRST204',
          message: `Could not find the '${assente}' column of 'sblocchi_audit' in the schema cache`,
          details: null,
          hint: null,
        }
        const respinto: Record<string, unknown> = {
          select: () => respinto,
          single: async () => ({ data: null, error }),
          maybeSingle: async () => ({ data: null, error }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok),
        }
        return respinto
      }
      return qb
    },
  } as unknown as SupabaseClient
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    fintoConSchema(h.db, h.tabelle, { scritture: h.scritture }),
}))

import { POST } from '@/app/api/primaria/sblocca/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '1A' },
    { id: SEZ_B, scuola_id: SEDE_B, name: '1A' },
  ],
  utenti_scuole: [{ utente_id: DIRIGENTE, scuola_id: SEDE_A }],
  utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZ_A }],
  registro_orario: [
    {
      id: RIGA_REGISTRO,
      section_id: SEZ_A,
      scuola_id: SEDE_A,
      data: LUNEDI,
      ora_lezione: 3,
      locked_il: '2026-09-09T06:00:00.000Z',
    },
  ],
  valutazioni: [{ id: VALUTAZIONE, section_id: SEZ_A, locked_il: '2026-09-09T06:00:00.000Z' }],
  note_disciplinari: [],
  sblocchi_audit: [],
})

function richiesta(body: Record<string, unknown>): NextRequest {
  return {
    url: `http://localhost/api/primaria/sblocca?userId=${DIRIGENTE}`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest
}

const sbloccati = () => h.db.sblocchi_audit ?? []
const insertSu = (tabella: string) =>
  h.scritture.filter((s) => s.tabella === tabella && s.operazione === 'insert')

/** Ogni campo passato a `logEvento`/`logErrore`, appiattito in un testo solo. */
const testoDeiLog = () =>
  JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.senzaColonneSlot = false
  h.requireStaff.mockResolvedValue({
    user: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
  })
})

describe('POST /api/primaria/sblocca — lo slot mai firmato', () => {
  it("sblocca un'ora SENZA riga di registro: l'audit porta le coordinate dello slot", async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        sectionId: SEZ_A,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: 'Assenza della maestra: recupero autorizzato',
      }),
    )

    expect(res.status).toBe(200)
    expect(sbloccati()).toHaveLength(1)
    const riga = sbloccati()[0]
    expect(riga.entita_tipo).toBe('registro')
    // Nessuna riga di registro da indirizzare: è proprio il caso per cui esiste.
    expect(riga.entita_id ?? null).toBeNull()
    expect(riga.section_id).toBe(SEZ_A)
    expect(riga.data).toBe(LUNEDI)
    expect(Number(riga.ora_lezione)).toBe(3)
    expect(riga.dirigente_id).toBe(DIRIGENTE)
  })

  it('lo slot di una classe di UN’ALTRA sede è respinto, e non scrive niente', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        sectionId: SEZ_B,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: 'prova',
      }),
    )

    expect(res.status).toBe(403)
    expect(sbloccati()).toHaveLength(0)
  })

  it('il gate di ruolo resta quello della dirigenza (admin/coordinator)', async () => {
    await POST(
      richiesta({
        entitaTipo: 'registro',
        sectionId: SEZ_A,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: 'prova',
      }),
    )
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('lo slot vale solo per il REGISTRO: una valutazione non ha un’ora di lezione', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'valutazione',
        sectionId: SEZ_A,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: 'prova',
      }),
    )

    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
  })

  it('un’ora fuori dalla campanella (0 o 9) è rifiutata prima di toccare il database', async () => {
    for (const oraLezione of [0, 9]) {
      const res = await POST(
        richiesta({ entitaTipo: 'registro', sectionId: SEZ_A, data: LUNEDI, oraLezione, motivazione: 'x' }),
      )
      expect(res.status, `oraLezione=${oraLezione}`).toBe(400)
    }
    expect(sbloccati()).toHaveLength(0)
  })

  it('senza né `entitaId` né le coordinate complete dello slot è 400', async () => {
    const res = await POST(
      richiesta({ entitaTipo: 'registro', sectionId: SEZ_A, motivazione: 'manca data e ora' }),
    )
    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
  })

  it('la MOTIVAZIONE non finisce nei log (è testo libero su una classe di minori)', async () => {
    const segreto = 'ZZ-motivazione-che-non-deve-comparire-nei-log-ZZ'
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        sectionId: SEZ_A,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: segreto,
      }),
    )

    expect(res.status).toBe(200)
    expect(sbloccati()[0].motivazione).toBe(segreto)
    expect(testoDeiLog()).not.toContain(segreto)
  })
})

describe('POST /api/primaria/sblocca — la riga già scritta (forma storica)', () => {
  it('con `entitaId` scrive l’audit, azzera `locked_il` e registra ANCHE lo slot', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        entitaId: RIGA_REGISTRO,
        motivazione: 'correzione tardiva autorizzata',
      }),
    )

    expect(res.status).toBe(200)
    const riga = sbloccati()[0]
    expect(riga.entita_id).toBe(RIGA_REGISTRO)
    // Le coordinate si leggono dalla riga: così il registro ritrova
    // l'autorizzazione per slot senza dover conoscere l'uuid.
    expect(riga.section_id).toBe(SEZ_A)
    expect(riga.data).toBe(LUNEDI)
    expect(Number(riga.ora_lezione)).toBe(3)
    expect(h.db.registro_orario[0].locked_il).toBeNull()
  })

  it('un `entitaId` inesistente è 404 e non scrive audit', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        entitaId: '00000000-0000-4000-8000-000000000000',
        motivazione: 'prova',
      }),
    )
    expect(res.status).toBe(404)
    expect(sbloccati()).toHaveLength(0)
  })

  it('una valutazione si sblocca ancora per id (nessuno slot da registrare)', async () => {
    const res = await POST(
      richiesta({ entitaTipo: 'valutazione', entitaId: VALUTAZIONE, motivazione: 'prova' }),
    )

    expect(res.status).toBe(200)
    const riga = sbloccati()[0]
    expect(riga.entita_tipo).toBe('valutazione')
    expect(riga.entita_id).toBe(VALUTAZIONE)
    expect(riga.section_id ?? null).toBeNull()
    expect(h.db.valutazioni[0].locked_il).toBeNull()
  })
})

describe('POST /api/primaria/sblocca — database non migrato (DB E2E della CI)', () => {
  beforeEach(() => {
    h.senzaColonneSlot = true
  })

  it('la forma storica NON regredisce: ripiega sull’insert senza le colonne dello slot', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        entitaId: RIGA_REGISTRO,
        motivazione: 'correzione tardiva autorizzata',
      }),
    )

    expect(res.status).toBe(200)
    expect(sbloccati()).toHaveLength(1)
    expect(sbloccati()[0].entita_id).toBe(RIGA_REGISTRO)
    // Due tentativi: il primo con le colonne nuove (respinto), il secondo senza.
    const tentativi = insertSu('sblocchi_audit')
    expect(tentativi).toHaveLength(1) // solo quello ANDATO A BUON FINE è una scrittura
    expect('section_id' in tentativi[0].valori[0]).toBe(false)
  })

  it('lo slot puro non si può registrare: 503 dichiarato, mai un finto 200', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'registro',
        sectionId: SEZ_A,
        data: LUNEDI,
        oraLezione: 3,
        motivazione: 'prova',
      }),
    )

    expect(res.status).toBe(503)
    expect(sbloccati()).toHaveLength(0)
    // La prosa di PostgREST resta nel log e non arriva a chi sta lavorando.
    const corpo = (await res.json()) as { error?: string }
    expect(corpo.error).not.toMatch(/schema cache|PGRST/i)
    expect(h.logErrore).toHaveBeenCalled()
  })
})
