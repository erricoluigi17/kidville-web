import { describe, it, expect, vi, beforeEach } from 'vitest'

// L'APPELLO DELLA PRIMARIA NON CANCELLA CIÒ CHE NON NOMINA.
//
// IL DIFETTO, in produzione fino a oggi. La schermata dell'appello non ha un PATCH:
// ogni gesto rispedisce una POST che fa `upsert` della riga INTERA, e le colonne che
// il corpo non nomina venivano riscritte a `null`.
//
// Due bocche, non una:
//  · `setOrario` rimanda stato e orari, ma NON `noteAppello`: correggere l'orario
//    d'ingresso di un bambino cancellava la nota che il docente aveva scritto
//    sull'appello di quel giorno;
//  · «Tutti presenti» rimanda solo `{alunnoId, stato:'presente'}` per l'INTERA classe,
//    quindi azzerava in un colpo le note E gli orari di tutti.
//
// Nessun errore, nessun log: il dato spariva e basta.
//
// LA REGOLA. Una riga si costruisce a partire da ciò che c'ERA. Il corpo può solo
// AGGIUNGERE o SOSTITUIRE ciò che nomina. Un `null` ESPLICITO resta un comando —
// «cancella la nota» si deve poter dire — ma l'assenza del campo non lo è mai.

const h = vi.hoisted(() => ({
  presenzePrima: [] as Array<Record<string, unknown>>,
  erroreLetturaPrima: null as { message: string } | null,
  upsertate: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'doc-1', role: 'educator', scuola_id: 's1' } })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(async () => undefined) }))

function chain(table: string) {
  const risolvi = () => {
    if (table === 'presenze') return { data: h.presenzePrima, error: h.erroreLetturaPrima }
    if (table === 'sections') return { data: { scuola_id: 's1' }, error: null }
    if (table === 'admin_settings') return { data: { notifiche_config: { toggles: {} } }, error: null }
    if (table === 'alunni') return { data: [{ id: A1, nome: 'Sofia' }], error: null }
    if (table === 'legame_genitori_alunni') return { data: [], error: null }
    return { data: [], error: null }
  }
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b
  b.upsert = (rows: Array<Record<string, unknown>>) => {
    h.upsertate.push(...rows)
    return { select: async () => ({ data: rows, error: null }) }
  }
  b.insert = async () => ({ error: null })
  b.delete = () => { const d: Record<string, unknown> = {}; d.eq = () => d; d.is = async () => ({ error: null }); return d }
  b.maybeSingle = async () => risolvi()
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
  return b
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({ from: (t: string) => chain(t) })),
}))

import { POST } from '@/app/api/primaria/appello/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'
import { NextRequest } from 'next/server'

const SEZIONE = '11111111-1111-4111-8111-111111111111'
const A1 = '22222222-2222-4222-8222-222222222222'
const DATA = '2026-09-07'

function req(corpo: Record<string, unknown>) {
  return new NextRequest('http://test/api/primaria/appello?userId=doc-1', {
    method: 'POST',
    body: JSON.stringify({ sectionId: SEZIONE, data: DATA, ...corpo }),
    headers: { 'Content-Type': 'application/json' },
  })
}

// La riga che c'è già: nota del docente e ora d'ingresso.
const RIGA_ESISTENTE = {
  alunno_id: A1,
  section_id: SEZIONE,
  data: DATA,
  stato: 'ritardo',
  note_appello: 'Ha la febbre da ieri, la mamma ha avvisato',
  orario_entrata: '2026-09-07T07:20:00.000Z',
  orario_uscita: null,
}

beforeEach(() => {
  h.presenzePrima = [{ ...RIGA_ESISTENTE }]
  h.erroreLetturaPrima = null
  h.upsertate = []
  invalidateNotificheConfigCache()
})

const rigaScritta = () => h.upsertate.find((r) => r.alunno_id === A1)!

describe('POST /api/primaria/appello — ciò che il corpo non nomina sopravvive', () => {
  it('correggere l\'orario NON cancella la nota dell\'appello', async () => {
    // È il gesto di `setOrario`: stato + orari, senza `noteAppello`.
    const res = await POST(req({ alunnoId: A1, stato: 'ritardo', orarioEntrata: '08:45' }))
    expect(res.status).toBe(200)
    expect(rigaScritta().note_appello).toBe(RIGA_ESISTENTE.note_appello)
  })

  it('«Tutti presenti» non azzera note e orari dell\'intera classe', async () => {
    // Il gesto di `tuttiPresenti`: solo alunnoId e stato, in bulk.
    const res = await POST(req({ records: [{ alunnoId: A1, stato: 'presente' }] }))
    expect(res.status).toBe(200)
    expect(rigaScritta().note_appello).toBe(RIGA_ESISTENTE.note_appello)
    expect(rigaScritta().orario_entrata).toBe(RIGA_ESISTENTE.orario_entrata)
  })

  it('scrivere una nota nuova la SOSTITUISCE', async () => {
    await POST(req({ alunnoId: A1, stato: 'ritardo', noteAppello: 'Arrivato col nonno' }))
    expect(rigaScritta().note_appello).toBe('Arrivato col nonno')
  })

  it('un `null` ESPLICITO cancella: dire «togli la nota» resta possibile', async () => {
    // La distinzione è tutta qui: `null` è un comando, l'assenza del campo no.
    await POST(req({ alunnoId: A1, stato: 'ritardo', noteAppello: null }))
    expect(rigaScritta().note_appello).toBeNull()
  })

  it('un ASSENTE non ha orari: quelli si azzerano davvero', async () => {
    await POST(req({ alunnoId: A1, stato: 'assente' }))
    expect(rigaScritta().orario_entrata).toBeNull()
    expect(rigaScritta().orario_uscita).toBeNull()
  })

  it('se lo stato di PRIMA non si è potuto leggere, non si scrive: è un 500', async () => {
    // Da quando la riga si costruisce a partire da ciò che c'era, quella lettura è
    // PORTANTE. Proseguire con un `prima` vuoto significherebbe azzerare note e
    // orari in silenzio — cioè rifare il difetto per un'altra strada. Prima di
    // questa regola era un `warn` e il salvataggio andava avanti.
    h.erroreLetturaPrima = { message: 'connessione persa' }
    const res = await POST(req({ alunnoId: A1, stato: 'presente' }))
    expect(res.status).toBe(500)
    expect(h.upsertate).toHaveLength(0)
  })
})
