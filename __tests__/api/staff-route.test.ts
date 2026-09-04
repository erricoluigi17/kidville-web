import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// /api/admin/staff — RBAC del personale.
//
// GET: rubrica del personale + contesto per la UI (sedi, classi, assegnazioni).
// PATCH: ruolo, sede e classi assegnate.
//
// ⚠️ «Solo Direzione» diceva questa riga, ed è decaduto il 2026-09-04: la PATCH
// ammette anche la SEGRETERIA, e le concede la sola SEDE. La riserva non è più
// nel gate di rotta (`requireStaff`) ma in `puoModificareIncaricoStaff`, che
// decide sui CAMPI dopo aver letto il ruolo del bersaglio. Il gate di rotta è il
// primo dei due, non l'unico — e un'intestazione che ne nomina uno solo fa
// cercare la regola dove non è più.
//
// ⚠️ ISOLAMENTO FRA SEDI (2026-07-31). Il GET restituiva nome, cognome, email e
// sede di OGNI dipendente delle tre sedi, più la mappa completa delle 38 classi
// — cioè proprio l'inventario di uuid che serve a sfruttare gli altri difetti.
// La PATCH validava la sede di DESTINAZIONE ma non il BERSAGLIO, e inseriva i
// `section_ids` del body senza guardarli: si assegnavano a un utente le sezioni
// di un'altra sede, e da lì `sezioniDiUtente` le considerava legittime.
//
// Il finto Supabase filtra e scrive DAVVERO: le asserzioni sono sullo stato
// esatto e sull'effetto nel database, mai su «non è 403».
// =============================================================================

const ADMIN_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const STAFF_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const STAFF_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
const SEZ_A = 'aaaa1111-1111-4111-8111-111111111111'
const SEZ_A2 = 'aaaa2222-2222-4222-8222-222222222222'
const SEZ_B = 'bbbb1111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] }),
  }
})

import { GET, PATCH } from '@/app/api/admin/staff/route'

const getReq = (cookie?: string) =>
  new NextRequest('http://localhost/api/admin/staff', cookie ? { headers: { cookie } } : undefined)

const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/staff', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti: [
    { id: ADMIN_A, nome: 'Dora', cognome: 'Direzione', email: 'dir@x.test', ruolo: 'admin', scuola_id: SEDE_A, gradi: [] },
    { id: STAFF_A, nome: 'Anna', cognome: 'Alfa', email: 'anna@x.test', ruolo: 'educator', scuola_id: SEDE_A, gradi: [] },
    { id: STAFF_B, nome: 'Bruno', cognome: 'Beta', email: 'bruno@x.test', ruolo: 'educator', scuola_id: SEDE_B, gradi: [] },
    { id: 'gen00000-0000-4000-8000-000000000001', nome: 'Gino', cognome: 'Genitore', email: 'g@x.test', ruolo: 'genitore', scuola_id: SEDE_A, gradi: [] },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  sections: [
    { id: SEZ_A, name: '2 ANNI', scuola_id: SEDE_A, school_type: 'infanzia' },
    { id: SEZ_A2, name: '3 ANNI', scuola_id: SEDE_A, school_type: 'infanzia' },
    { id: SEZ_B, name: '2 ANNI', scuola_id: SEDE_B, school_type: 'infanzia' },
  ],
  utenti_sezioni: [
    { utente_id: STAFF_A, section_id: SEZ_A },
    { utente_id: STAFF_B, section_id: SEZ_B },
  ],
  utenti_scuole: [],
})

const scrittureSu = (tabella: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

/**
 * Fa fallire UNA sola operazione su UNA sola tabella. L'iniezione di errori del
 * finto client è per tabella e colpisce ogni operazione: non basta a distinguere
 * «il delete non guarda l'errore» da «l'insert non lo guarda», e senza quella
 * distinzione la prova di validità di uno dei due controlli sarebbe finta.
 */
async function conOperazioneRotta(
  tabella: string,
  operazione: 'insert' | 'delete',
  corpo: () => Promise<void>,
) {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const server = await import('@/lib/supabase/server-client')
  const errore = { code: '42P01', message: 'relation does not exist', details: null, hint: null }
  const rotto: Record<string, unknown> = {}
  rotto.eq = () => rotto
  rotto.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: errore }).then(ok)

  const base = creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] })
  const client = {
    from: (tab: string) => {
      const b = base.from(tab) as unknown as Record<string, unknown>
      if (tab !== tabella) return b
      return { ...b, [operazione]: () => rotto }
    },
  }
  vi.spyOn(server, 'createAdminClient').mockResolvedValue(client as never)
  try {
    await corpo()
  } finally {
    vi.mocked(server.createAdminClient).mockRestore()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN_A, role: 'admin', scuola_id: SEDE_A } })
})

describe('GET /api/admin/staff — gate di ruolo', () => {
  it('è gated in lettura anche alla Segreteria (admin/coordinator/segreteria)', async () => {
    await GET(getReq())
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator', 'segreteria'])
  })

  it('403 se il gate nega: nessuna lettura della rubrica', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await GET(getReq())
    expect(res.status).toBe(403)
    expect(h.tabelle).toHaveLength(0)
  })
})

describe('GET /api/admin/staff — la rubrica è del proprio plesso', () => {
  it('la segreteria di A non riceve il personale di B, né le sue classi, né le sue sedi', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.map((u: { id: string }) => u.id).sort()).toEqual([STAFF_A, ADMIN_A].sort())
    expect(j.sections.map((s: { id: string }) => s.id)).toEqual([SEZ_A, SEZ_A2])
    expect(j.schools.map((s: { id: string }) => s.id)).toEqual([SEDE_A])
    // La mappa delle assegnazioni è l'inventario che serve per sfruttare gli
    // altri difetti: quella di B non deve uscire.
    expect(j.assegnazioni).toEqual([{ utente_id: STAFF_A, section_id: SEZ_A }])
    const corpo = JSON.stringify(j)
    expect(corpo).not.toContain('bruno@x.test')
    expect(corpo).not.toContain(SEZ_B)
  })

  it('i genitori restano esclusi dalla rubrica del personale', async () => {
    const res = await GET(getReq())
    const j = await res.json()
    expect(j.data.some((u: { ruolo: string }) => u.ruolo === 'genitore')).toBe(false)
  })

  it('admin multi-plesso col SedeSelector su A: B resta fuori dalla rubrica', async () => {
    h.db.utenti_scuole = [
      { utente_id: ADMIN_A, scuola_id: SEDE_A },
      { utente_id: ADMIN_A, scuola_id: SEDE_B },
    ]
    const res = await GET(getReq(`sedi_attive=${SEDE_A}`))
    const j = await res.json()
    expect(j.data.map((u: { id: string }) => u.id).sort()).toEqual([STAFF_A, ADMIN_A].sort())
    // Le SEDI restano tutte quelle ACCESSIBILI, e non solo quella attiva:
    // servono a dare un NOME alla sede di ogni riga della rubrica, che con il
    // solo plesso attivo si leggerebbe «—».
    //
    // ⚠️ NON sono le destinazioni di un trasferimento, e fino al 2026-09-04 qui
    // c'era scritto che alimentavano quella tendina «che la PATCH valida
    // comunque contro `scuoleDiUtente`»: nessuna delle due cose è più vera.
    // Le destinazioni sono più LARGHE di queste (la Direzione sposta anche verso
    // plessi che non sono suoi) e stanno in `GET /api/admin/sedi/destinazioni`.
    expect(j.schools.map((s: { id: string }) => s.id).sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('scope vuoto ⇒ rubrica vuota (deny), mai l\'intero organico', async () => {
    const res = await GET(getReq(`sedi_attive=${SEDE_B}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
    expect(j.sections).toEqual([])
    expect(j.assegnazioni).toEqual([])
  })
})

describe('PATCH /api/admin/staff — gate e validazione', () => {
  it('403 se requireStaff nega: nessuna scrittura', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(patchReq({ id: STAFF_A, ruolo: 'segreteria' }))
    expect(res.status).toBe(403)
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('400 con ruolo non assegnabile (es. genitore)', async () => {
    const res = await PATCH(patchReq({ id: STAFF_A, ruolo: 'genitore' }))
    expect(res.status).toBe(400)
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('403 se la Direzione tenta di cambiare il PROPRIO ruolo (self-lockout guard)', async () => {
    const res = await PATCH(patchReq({ id: ADMIN_A, ruolo: 'educator' }))
    expect(res.status).toBe(403)
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('aggiorna ruolo, rimpiazza le classi e traccia l\'audit', async () => {
    const res = await PATCH(patchReq({ id: STAFF_A, ruolo: 'segreteria', section_ids: [SEZ_A, SEZ_A2] }))
    expect(res.status).toBe(200)
    expect(h.db.utenti.find((u) => u.id === STAFF_A)!.ruolo).toBe('segreteria')
    const inserite = scrittureSu('utenti_sezioni').filter((s) => s.operazione === 'insert')
    expect(inserite).toHaveLength(1)
    expect(inserite[0].valori.map((r) => r.section_id)).toEqual([SEZ_A, SEZ_A2])
    // Il replace è completo: la vecchia assegnazione è stata rimossa e poi riscritta.
    expect(h.db.utenti_sezioni.filter((r) => r.utente_id === STAFF_A)).toHaveLength(2)
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })
})

describe('PATCH /api/admin/staff — il BERSAGLIO e le SEZIONI devono essere nel proprio plesso', () => {
  it('403 sul dipendente di un\'altra sede: ruolo invariato, nessuna scrittura', async () => {
    const res = await PATCH(patchReq({ id: STAFF_B, ruolo: 'segreteria' }))
    expect(res.status).toBe(403)
    expect(h.db.utenti.find((u) => u.id === STAFF_B)!.ruolo).toBe('educator')
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('404 se il bersaglio non esiste affatto', async () => {
    const res = await PATCH(patchReq({ id: '99999999-9999-4999-8999-999999999999', ruolo: 'segreteria' }))
    expect(res.status).toBe(404)
    expect(scrittureSu('utenti')).toHaveLength(0)
  })

  it('403 se fra i section_ids ce n\'è uno di un\'altra sede: NESSUNA assegnazione toccata', async () => {
    const res = await PATCH(patchReq({ id: STAFF_A, section_ids: [SEZ_A, SEZ_B] }))
    expect(res.status).toBe(403)
    expect(scrittureSu('utenti_sezioni')).toHaveLength(0)
    // Il replace è distruttivo: se il 403 arrivasse DOPO il delete, l'utente
    // resterebbe senza classi. Le assegnazioni di partenza devono essere intatte.
    expect(h.db.utenti_sezioni).toHaveLength(2)
  })

  /* ⚠️ QUESTA REGOLA È CAMBIATA IL 2026-09-04, e la vecchia versione di questo
     test diceva il contrario: «403 se la sede di destinazione è fuori dai plessi
     della Direzione». Era il controllo giusto per una SCRITTURA NUOVA e quello
     sbagliato per un TRASFERIMENTO — negava esattamente il caso per cui la
     tendina della sede esiste: la Direzione che manda una maestra in un plesso
     che non è fra i suoi. Ora la destinazione la decide `destinazioniConsentite`
     (src/lib/sedi/trasferimento.ts): la Direzione muove fra tutte le sedi REALI,
     la Segreteria solo dentro le proprie. Il perimetro sul BERSAGLIO non si è
     mosso di un millimetro — resta `assertUtenteInScope`, e il test qui sopra
     («403 sul dipendente di un'altra sede») è la sua prova.
     Lo spostamento vero e proprio, con tutto ciò che si porta dietro, ha un file
     suo: `__tests__/api/staff-trasferimento-sede.test.ts`. */
  it('la Direzione sposta anche verso una sede che non è fra le proprie', async () => {
    const res = await PATCH(patchReq({ id: STAFF_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(h.db.utenti.find((u) => u.id === STAFF_A)!.scuola_id).toBe(SEDE_B)
  })

  it('500 se il DELETE delle assegnazioni fallisce: PostgREST non lancia, l\'errore va guardato', async () => {
    await conOperazioneRotta('utenti_sezioni', 'delete', async () => {
      // Elenco vuoto: gira SOLO il delete, così il 500 può venire da un solo posto.
      const res = await PATCH(patchReq({ id: STAFF_A, section_ids: [] }))
      expect(res.status).toBe(500)
    })
  })

  it('500 se l\'INSERT delle assegnazioni fallisce: mai un 200 su un replace a metà', async () => {
    await conOperazioneRotta('utenti_sezioni', 'insert', async () => {
      const res = await PATCH(patchReq({ id: STAFF_A, section_ids: [SEZ_A] }))
      expect(res.status).toBe(500)
    })
  })
})
