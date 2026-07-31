import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// W2-M — `register/lessons:POST`: la sede del registro NON si indovina più.
//
// Difetto chiuso qui (rilievo R8 dell'audit 2026-07-31): la sede della lezione
// veniva da `.eq('name', classeSezione).in('scuola_id', plessi).limit(1)` — un
// LIMIT senza ORDER BY, cioè «una qualsiasi» — con ultimo ripiego `plessi[0]`.
// Con «2 ANNI» presente in due sedi, argomento, compiti e FIRMA del docente
// finivano nel plesso sbagliato in modo deterministico e silenzioso; la POST
// per giunta usava `scuoleDiUtente` (ignora il SedeSelector) mentre la GET usa
// `resolveScuoleAttive` (lo rispetta), quindi si poteva scrivere in una sede e
// poi non rivedere mai più la lezione.
//
// Qui il finto client applica DAVVERO i filtri ed esegue DAVVERO le scritture:
// ogni caso asserisce lo stato esatto E che cosa è finito in `registro_orario`
// (accumulatore `scritture`). Mai `not.toBe(400)` come controllo positivo.
// =============================================================================

const OMONIMA = '2 ANNI'
const SOLO_A = '3 ANNI A'
const SOLO_B = 'SOLO SEDE B'
const GIORNO = '2026-07-31'
const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_EDUCATOR = 'd0000000-0000-4000-8000-0000000ed000'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const SEC_SOLO_A = 'aaaa3333-0000-4000-8000-0000000000a3'
const SEC_SOLO_B = 'bbbb9999-0000-4000-8000-0000000000b9'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  genitoriDiClassi: vi.fn(),
  notificaEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiClassi: (...a: unknown[]) => h.genitoriDiClassi(...a),
}))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => h.notificaEvento(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => crea(h.db, h.tabelle, { scritture: h.scritture }),
  }
})

import { POST } from '@/app/api/register/lessons/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: OMONIMA },
    { id: SEC_B, scuola_id: SEDE_B, name: OMONIMA },
    { id: SEC_SOLO_A, scuola_id: SEDE_A, name: SOLO_A },
    { id: SEC_SOLO_B, scuola_id: SEDE_B, name: SOLO_B },
  ],
  // La Direzione è multi-plesso via il ponte: A (primaria) + B.
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [],
  registro_orario: [],
  firme_docenti: [],
})

/** Richiesta finta: al codice servono `url`, `headers`, `json()` e i cookie. */
function postReq(body: Record<string, unknown>, cookie?: string): NextRequest {
  return {
    url: 'http://localhost/api/register/lessons',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const lezione = (extra: Record<string, unknown>) => ({
  data: GIORNO,
  oraLezione: 1,
  materia: 'Italiano',
  argomento: 'La filastrocca',
  ...extra,
})

/** Le scritture su una tabella: è lo «stato del database», non una negazione. */
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.genitoriDiClassi.mockResolvedValue([])
  h.notificaEvento.mockResolvedValue(undefined)
  h.requireDocente.mockResolvedValue({
    user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A },
  })
})

describe('POST /api/register/lessons — nome-classe ambiguo: si nega, non si sceglie', () => {
  it('classe OMONIMA in due sedi, nessuna sede indicata ⇒ 400 e NIENTE scritto', async () => {
    const res = await POST(postReq(lezione({ classeSezione: OMONIMA })))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sede/i)
    expect(scrittureSu('registro_orario')).toEqual([])
    expect(scrittureSu('firme_docenti')).toEqual([])
    expect(h.db.registro_orario).toEqual([])
  })

  it('classe OMONIMA + SedeSelector su UNA sede ⇒ 200 e la riga nasce in QUELLA sede', async () => {
    const res = await POST(postReq(lezione({ classeSezione: OMONIMA }), SEDE_B))

    expect(res.status).toBe(200)
    const righe = scrittureSu('registro_orario')
    expect(righe).toHaveLength(1)
    expect(righe[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      classe_sezione: OMONIMA,
      data: GIORNO,
      ora_lezione: 1,
    })
    expect(h.db.registro_orario).toHaveLength(1)
    expect(h.db.registro_orario[0].scuola_id).toBe(SEDE_B)
  })

  it('classe OMONIMA + `scuolaId` esplicito nel body ⇒ 200 nella sede dichiarata', async () => {
    const res = await POST(postReq(lezione({ classeSezione: OMONIMA, scuolaId: SEDE_B })))

    expect(res.status).toBe(200)
    expect(scrittureSu('registro_orario')[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('classe presente in UNA sola sede ⇒ 200 senza bisogno di dichiarare la sede', async () => {
    const res = await POST(postReq(lezione({ classeSezione: SOLO_A })))

    expect(res.status).toBe(200)
    expect(scrittureSu('registro_orario')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_A,
      classe_sezione: SOLO_A,
    })
  })

  it('classe di un plesso non proprio ⇒ 403 senza toccare il registro', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: ID_EDUCATOR, role: 'educator', scuola_id: SEDE_A },
    })
    const res = await POST(postReq(lezione({ classeSezione: SOLO_B })))

    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('registro_orario')
    expect(h.db.registro_orario).toEqual([])
  })

  it('nome esistente ma FUORI dalle sedi selezionate ⇒ 400, mai un ripiego su plessi[0]', async () => {
    // Il gate passa (la classe è in un plesso dell'utente) ma il SedeSelector
    // punta altrove: la vecchia catena finiva su `?? plessi[0]` e archiviava
    // la lezione in una sede che l'operatore non stava nemmeno guardando.
    const res = await POST(postReq(lezione({ classeSezione: SOLO_A }), SEDE_B))

    expect(res.status).toBe(400)
    expect(scrittureSu('registro_orario')).toEqual([])
  })
})

describe('POST /api/register/lessons — `sectionId`: l\'identità al posto del nome', () => {
  it('sectionId ⇒ sede e nome-classe presi dalla SEZIONE, non dal client', async () => {
    const res = await POST(
      postReq(lezione({ sectionId: SEC_B, classeSezione: 'NOME FASULLO' })),
    )

    expect(res.status).toBe(200)
    expect(scrittureSu('registro_orario')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_B,
      classe_sezione: OMONIMA,
    })
  })

  it('sectionId di una sezione fuori dai propri plessi ⇒ 403 e nessuna scrittura', async () => {
    h.requireDocente.mockResolvedValue({
      user: { id: ID_EDUCATOR, role: 'educator', scuola_id: SEDE_A },
    })
    const res = await POST(postReq(lezione({ sectionId: SEC_B })))

    expect(res.status).toBe(403)
    expect(scrittureSu('registro_orario')).toEqual([])
  })

  it('né sectionId né classeSezione ⇒ 400 dello schema, nessuna lettura del registro', async () => {
    const res = await POST(postReq(lezione({})))

    expect(res.status).toBe(400)
    expect(h.tabelle).not.toContain('registro_orario')
  })
})

describe('POST /api/register/lessons — la notifica compiti parte sulla sede risolta', () => {
  it('la sede passata a genitoriDiClassi è quella scritta, non la primaria dell\'autore', async () => {
    const res = await POST(
      postReq(lezione({ classeSezione: OMONIMA, scuolaId: SEDE_B, compiti: 'Pagina 12' })),
    )

    expect(res.status).toBe(200)
    expect(h.genitoriDiClassi).toHaveBeenCalledTimes(1)
    expect(h.genitoriDiClassi.mock.calls[0][1]).toBe(SEDE_B)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ scuolaId: SEDE_B, entitaId: SEC_B })
  })
})
