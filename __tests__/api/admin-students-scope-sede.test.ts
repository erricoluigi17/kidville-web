import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// Isolamento per sede su `/api/admin/students` — la route di COLLEZIONE.
//
// È il file che l'audit del 30/07 ha dato per chiuso guardando il solo GET:
// PATCH e DELETE non avevano nessun gate di tenant, e il GET dichiarava nello
// schema zod un `scuola_id` che poi non applicava mai.
//
//  · PATCH singolo — `.update(...).eq('id', id).select().single()` e poi
//    `return NextResponse.json(data)`: una scrittura innocua bastava a farsi
//    restituire la RIGA INTERA del minore di un'altra sede (note mediche,
//    codice fiscale, indirizzo). Esfiltrazione, non solo IDOR di scrittura.
//  · PATCH bulk (classe e gruppo mensa) — `.in('id', ids)` nudo: gli id di
//    un'altra sede passavano, e il nome-classe scritto come TESTO faceva
//    azzerare `section_id` dal trigger (il bambino spariva da ogni elenco).
//  · DELETE — hard delete GDPR a cascata, preceduto da una copia integrale
//    della riga dentro `registro_modifiche`: senza scope, la copia avveniva
//    comunque anche quando la cancellazione poi falliva.
//
// I test asseriscono lo STATO ESATTO e l'EFFETTO SUL DATABASE (il finto client
// filtra e scrive davvero, e registra ogni scrittura): mai `not.toBe(403)`.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_A2 = '11111111-1111-4111-8111-aaaaaaaaaaab'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const GM_A = '44444444-4444-4444-8444-aaaaaaaaaaaa'
const GM_B = '44444444-4444-4444-8444-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] }),
  }
})

import { GET, PATCH, DELETE } from '@/app/api/admin/students/route'

const get = (qs: string) => new NextRequest(`http://localhost/api/admin/students${qs}`)
const corpo = (metodo: string) => (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students', {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const patch = corpo('PATCH')
const del = corpo('DELETE')

const dbBase = (): DBFinto => ({
  utenti_scuole: [{ utente_id: 'adm-1', scuola_id: SEDE_A }, { utente_id: 'adm-1', scuola_id: SEDE_B }],
  utenti_sezioni: [],
  sections: [
    { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' },
    { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI' },
    { id: 'sec-b-5', scuola_id: SEDE_B, name: '5 ANNI' },
  ],
  gruppi_mensa: [
    { id: GM_A, scuola_id: SEDE_A, nome: 'Turno Alfa' },
    { id: GM_B, scuola_id: SEDE_B, nome: 'Turno Beta' },
  ],
  alunni: [
    {
      id: ALU_A, nome: 'Alfa', cognome: 'AaaSedeA', scuola_id: SEDE_A, section_id: SEC_A,
      classe_sezione: '2 ANNI', stato: 'iscritto', note_mediche: 'NOTA-MEDICA-A',
      codice_fiscale: 'CF-ALFA-A', gruppo_mensa_id: null,
    },
    {
      id: ALU_A2, nome: 'Alfa2', cognome: 'BbbSedeA', scuola_id: SEDE_A, section_id: SEC_A,
      classe_sezione: '2 ANNI', stato: 'iscritto', note_mediche: 'NOTA-MEDICA-A2',
      codice_fiscale: 'CF-ALFA-A2', gruppo_mensa_id: null,
    },
    {
      id: ALU_B, nome: 'Beta', cognome: 'CccSedeB', scuola_id: SEDE_B, section_id: SEC_B,
      classe_sezione: '2 ANNI', stato: 'iscritto', note_mediche: 'NOTA-MEDICA-B',
      codice_fiscale: 'CF-BETA-B', gruppo_mensa_id: null,
    },
  ],
  registro_modifiche: [],
  audit_scritture_docente: [],
})

/** La riga come sta ADESSO nel finto database (non la copia della risposta). */
const riga = (id: string) => h.db.alunni.find((a) => a.id === id)
/** Le scritture registrate sulla tabella indicata. */
const scrittureSu = (tabella: string) =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  // Segreteria di SEDE_A: per progetto (decisione 30/07) vede SOLO la sua sede.
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET — il parametro `scuola_id` dichiarato nello schema deve filtrare davvero
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/students — il filtro `scuola_id` promesso dallo schema', () => {
  it('l\'admin multi-sede che chiede SEDE_A riceve SOLO gli alunni di SEDE_A', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
    const res = await GET(get(`?scuola_id=${SEDE_A}`))
    expect(res.status).toBe(200)
    const lista = (await res.json()) as { id: string; scuola_id: string }[]
    expect(lista.map((a) => a.id).sort()).toEqual([ALU_A, ALU_A2].sort())
    expect(lista.every((a) => a.scuola_id === SEDE_A)).toBe(true)
  })

  it('l\'admin multi-sede che chiede SEDE_B riceve SOLO gli alunni di SEDE_B', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
    const res = await GET(get(`?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    const lista = (await res.json()) as { id: string }[]
    expect(lista.map((a) => a.id)).toEqual([ALU_B])
  })

  it('senza `scuola_id` l\'admin multi-sede vede entrambe le sedi (nessuna regressione)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
    const res = await GET(get('?limit=1000'))
    expect(res.status).toBe(200)
    const lista = (await res.json()) as { id: string }[]
    expect(lista.map((a) => a.id).sort()).toEqual([ALU_A, ALU_A2, ALU_B].sort())
  })

  it('la segreteria di SEDE_A che chiede SEDE_B riceve l\'elenco VUOTO, non il proprio', async () => {
    const res = await GET(get(`?scuola_id=${SEDE_B}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH singolo
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — aggiornamento singolo', () => {
  it('403 sull\'alunno di un\'altra sede: nessuna scrittura e nessun dato del minore in risposta', async () => {
    const res = await PATCH(patch({ id: ALU_B, stato: 'ritirato' }))
    const testo = await res.text()
    expect(res.status).toBe(403)
    expect(testo).not.toContain('NOTA-MEDICA-B')
    expect(testo).not.toContain('CF-BETA-B')
    expect(riga(ALU_B)?.stato).toBe('iscritto')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('200 sull\'alunno della propria sede, e il database è davvero cambiato', async () => {
    const res = await PATCH(patch({ id: ALU_A, stato: 'ritirato' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.stato).toBe('ritirato')
    expect(scrittureSu('alunni')).toHaveLength(1)
  })

  it('400 se `section_id` è di un\'altra sede: il bambino non viene puntato a una sezione altrui', async () => {
    const res = await PATCH(patch({ id: ALU_A, section_id: SEC_B }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('400 se il nome-classe non esiste nella sede dell\'alunno (mai `section_id` azzerato in silenzio)', async () => {
    const res = await PATCH(patch({ id: ALU_A, classe_sezione: '5 ANNI' }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.classe_sezione).toBe('2 ANNI')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH bulk — classe e gruppo mensa
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — bulk assegnazione classe', () => {
  it('403 se anche UN solo id è di un\'altra sede: nessuno dei due viene toccato', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_B], classe_sezione: '2 ANNI' }))
    expect(res.status).toBe(403)
    expect(riga(ALU_B)?.classe_sezione).toBe('2 ANNI')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('400 se il nome-classe non esiste nella sede degli alunni', async () => {
    const res = await PATCH(patch({ ids: [ALU_A], classe_sezione: '5 ANNI' }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.classe_sezione).toBe('2 ANNI')
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('200 sugli alunni della propria sede con una classe della propria sede', async () => {
    h.db.sections.push({ id: 'sec-a-3', scuola_id: SEDE_A, name: '3 ANNI' })
    const res = await PATCH(patch({ ids: [ALU_A, ALU_A2], classe_sezione: '3 ANNI' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.classe_sezione).toBe('3 ANNI')
    expect(riga(ALU_A2)?.classe_sezione).toBe('3 ANNI')
  })

  it('l\'audit registra la sede dell\'ALUNNO, non quella dell\'operatore', async () => {
    // L'admin multi-sede ha `utenti.scuola_id = SEDE_A`, e `logScrittura`
    // ripiega su `attore.scuola_id` quando il chiamante non dichiara la sede:
    // un intervento su un bambino di SEDE_B finiva a registro come SEDE_A.
    // Su una traccia di chi-ha-toccato-cosa questo non è un dettaglio.
    h.requireStaff.mockResolvedValue({ user: { id: 'adm-1', role: 'admin', scuola_id: SEDE_A } })
    const res = await PATCH(patch({ ids: [ALU_B], classe_sezione: '5 ANNI' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_B)?.classe_sezione).toBe('5 ANNI')
    const audit = h.db.audit_scritture_docente
    expect(audit).toHaveLength(1)
    expect(audit[0].entita_id).toBe(ALU_B)
    expect(audit[0].scuola_id).toBe(SEDE_B)
  })
})

describe('PATCH /api/admin/students — bulk gruppo mensa', () => {
  it('403 se un id è di un\'altra sede: nessun gruppo assegnato', async () => {
    const res = await PATCH(patch({ ids: [ALU_A, ALU_B], gruppo_mensa_id: GM_A }))
    expect(res.status).toBe(403)
    expect(riga(ALU_A)?.gruppo_mensa_id).toBeNull()
    expect(riga(ALU_B)?.gruppo_mensa_id).toBeNull()
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('400 se il gruppo mensa è di un\'altra sede', async () => {
    const res = await PATCH(patch({ ids: [ALU_A], gruppo_mensa_id: GM_B }))
    expect(res.status).toBe(400)
    expect(riga(ALU_A)?.gruppo_mensa_id).toBeNull()
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('200 con gruppo e alunni della stessa sede', async () => {
    const res = await PATCH(patch({ ids: [ALU_A], gruppo_mensa_id: GM_A }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.gruppo_mensa_id).toBe(GM_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — hard delete GDPR
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/admin/students — hard delete GDPR', () => {
  it('403 sull\'alunno di un\'altra sede: la riga resta, e NESSUNA copia in registro_modifiche', async () => {
    const res = await DELETE(del({ id: ALU_B }))
    expect(res.status).toBe(403)
    expect(riga(ALU_B)).toBeDefined()
    expect(h.db.registro_modifiche).toHaveLength(0)
    expect(scrittureSu('registro_modifiche')).toHaveLength(0)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('200 sull\'alunno della propria sede: riga rimossa e copia d\'audit scritta', async () => {
    const res = await DELETE(del({ id: ALU_A }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)).toBeUndefined()
    expect(h.db.registro_modifiche).toHaveLength(1)
    expect(h.db.registro_modifiche[0].record_id).toBe(ALU_A)
  })
})
