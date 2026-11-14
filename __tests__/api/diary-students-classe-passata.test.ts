import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Lotto 6 · rilievo 2 — la classe di un anno PASSATO, in sola lettura, NON si apre vuota dopo la ricopia di settembre.
//
// `alunni.section_id` è la classe di OGGI: dopo `passaggio_ricopia_schede` punta alla classe nuova. Leggere da lì la classe
// del 2026/27 la dava vuota («Nessun alunno nella sezione»). L'appartenenza dell'ANNO sta nelle `frequenze` di quell'anno con
// quel `section_id`. Il finto distingue i due casi: i due bambini hanno GIÀ `section_id` = classe nuova, e le frequenze
// dell'anno vecchio puntano alla classe vecchia. Un finto che li lasciasse sulla vecchia sarebbe verde anche con la lettura di oggi.
// =============================================================================

const DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_NUOVA = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_VECCHIA = 'aaaa1111-0000-4000-8000-0000000000a2'
const ANNO_NUOVO = 'a0000000-0000-4000-8000-000000000027'
const ANNO_VECCHIO = 'a0000000-0000-4000-8000-000000000026'
const ALU_1 = 'c1111111-0000-4000-8000-000000000001'
const ALU_2 = 'c1111111-0000-4000-8000-000000000002'
const ALU_NUOVO = 'c1111111-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  visibili: null as null | (() => { data: unknown; error: unknown }),
  errori: {} as Record<string, { code: string; message: string }>,
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE_A],
}))
vi.mock('@/lib/sezioni/risoluzione', () => ({
  risolviSezione: async (_s: unknown, _u: unknown, id: { sectionId?: string }) => ({ sectionIds: id.sectionId ? [id.sectionId] : [] }),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn(), verificaLegameGenitore: vi.fn(), getGenitoriDiAlunno: vi.fn(),
  // Un genitore collegato al primo bambino: il roster dell'anno a un docente NON deve portarlo.
  getGenitoriDiAlunni: async () => new Map([['c1111111-0000-4000-8000-000000000001', ['9e000000-0000-4000-8000-000000000001']]]),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const rpc = {
    sezioni_visibili_docente: () => (h.visibili ? h.visibili() : { data: [], error: null }),
  }
  const crea = async () => creaFintoSupabase(h.db, h.tabelle, { rpc, errori: h.errori })
  return { createAdminClient: crea, createClient: crea }
})

import { GET } from '@/app/api/diary/students/route'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_NUOVA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_NUOVO },
    { id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia', anno_id: ANNO_VECCHIO },
  ],
  anni_sede: [
    { id: 'b0000000-0000-4000-8000-000000000027', anno_id: ANNO_NUOVO, scuola_id: SEDE_A, stato: 'corrente' },
    { id: 'b0000000-0000-4000-8000-000000000026', anno_id: ANNO_VECCHIO, scuola_id: SEDE_A, stato: 'chiuso' },
  ],
  // DOPO la ricopia: i due bambini sono già nella classe NUOVA.
  alunni: [
    { id: ALU_1, nome: 'Uno', cognome: 'Alfa', note_mediche: 'NOTA-SANITARIA', allergeni: ['ALLERGENE'], allergies: 'ALLERGIA', consenso_privacy: true, classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
    { id: ALU_2, nome: 'Due', cognome: 'Beta', note_mediche: null, classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
    { id: ALU_NUOVO, nome: 'Tre', cognome: 'Gamma', note_mediche: null, classe_sezione: 'TEST Infanzia', section_id: SEC_NUOVA, scuola_id: SEDE_A, anonimizzato_il: null },
  ],
  // L'appartenenza dell'anno vecchio: ALU_1 e ALU_2 nella classe vecchia (e uno in attesa, che non conta).
  frequenze: [
    { id: 'f1', alunno_id: ALU_1, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'iscritto' },
    { id: 'f2', alunno_id: ALU_2, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'uscito' },
    { id: 'f3', alunno_id: ALU_NUOVO, anno_id: ANNO_VECCHIO, section_id: SEC_VECCHIA, stato: 'in_attesa' },
    { id: 'f4', alunno_id: ALU_1, anno_id: ANNO_NUOVO, section_id: SEC_NUOVA, stato: 'iscritto' },
    { id: 'f5', alunno_id: ALU_2, anno_id: ANNO_NUOVO, section_id: SEC_NUOVA, stato: 'iscritto' },
    { id: 'f6', alunno_id: ALU_NUOVO, anno_id: ANNO_NUOVO, section_id: SEC_NUOVA, stato: 'iscritto' },
  ],
  utenti_sezioni: [],
  utenti_scuole: [],
  utenti: [{ id: '9e000000-0000-4000-8000-000000000001', nome: 'Genitore', cognome: 'Prova', email: 'genitore@example.invalid' }],
})

const richiesta = (sectionId: string, dellAnno = true) =>
  new NextRequest(`http://localhost/api/diary/students?sectionId=${sectionId}${dellAnno ? '&dellAnno=1' : ''}`)

const ids = async (res: Response) => ((await res.json()) as { id: string }[]).map((a) => a.id).sort()

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.visibili = () => ({
    data: [{ section_id: SEC_NUOVA, sola_lettura: false }, { section_id: SEC_VECCHIA, sola_lettura: true }],
    error: null,
  })
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/diary/students?sectionId= — classe di un anno passato', () => {
  it('🔴 dopo la ricopia la classe vecchia dà i bambini DI QUELL’ANNO (frequenze), non una lista vuota', async () => {
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual([ALU_1, ALU_2].sort())
  })

  it('la classe dell’anno in corso resta letta come sempre (alunni.section_id)', async () => {
    const res = await GET(richiesta(SEC_NUOVA))
    expect(await ids(res)).toEqual([ALU_1, ALU_2, ALU_NUOVO].sort())
    expect(h.tabelle).not.toContain('frequenze')
  })

  it('senza `dellAnno=1` (il diario) la lettura è quella di sempre: i bambini che ci sono ORA', async () => {
    const res = await GET(richiesta(SEC_VECCHIA, false))
    expect(await res.json()).toEqual([])
    expect(h.tabelle).not.toContain('frequenze')
  })

  it('il docente la vede SOLO se è fra quelle di `sezioni_visibili_docente`', async () => {
    h.visibili = () => ({ data: [{ section_id: SEC_NUOVA, sola_lettura: false }], error: null })
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(await res.json()).toEqual([])
  })

  it('funzione dell’anno guasta: nessun bambino (mai la lista di oggi spacciata per quella dell’anno)', async () => {
    h.visibili = () => ({ data: null, error: { code: 'XX000', message: 'guasto' } })
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(await res.json()).toEqual([])
  })

  it('DB senza lo schema dell’anno (colonna assente): lettura di sempre, nessun errore', async () => {
    h.db.sections = [{ id: SEC_VECCHIA, scuola_id: SEDE_A, name: 'TEST Infanzia' }]
    h.db.alunni = [{ id: ALU_1, nome: 'Uno', cognome: 'Alfa', note_mediche: null, classe_sezione: 'TEST Infanzia', section_id: SEC_VECCHIA, scuola_id: SEDE_A, anonimizzato_il: null }]
    h.db.anni_sede = []
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(res.status).toBe(200)
    expect(await ids(res)).toEqual([ALU_1])
  })

  it('🔴 N1 · al docente la risposta porta SOLO l’identità: niente note mediche, allergie, consensi né genitori', async () => {
    const res = await GET(richiesta(SEC_VECCHIA))
    const corpo = await res.text()
    for (const vietato of ['note_mediche', 'allergeni', 'allergies', 'consenso_privacy', 'parents', 'NOTA-SANITARIA', 'ALLERGENE', 'genitore@example.invalid']) {
      expect(corpo).not.toContain(vietato)
    }
    const righe = JSON.parse(corpo) as Record<string, unknown>[]
    expect(righe.length).toBe(2)
    expect(Object.keys(righe[0]).sort()).toEqual(['classe_sezione', 'cognome', 'id', 'nome'])
  })

  it('lo staff con `dellAnno=1` legge il roster dell’anno con i dati completi (è già dietro il suo gate)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE_A } })
    const res = await GET(richiesta(SEC_VECCHIA))
    const righe = (await res.json()) as { id: string; note_mediche?: string; parents?: unknown[] }[]
    expect(righe.map((a) => a.id).sort()).toEqual([ALU_1, ALU_2].sort())
    expect(righe.find((a) => a.id === ALU_1)?.note_mediche).toBe('NOTA-SANITARIA')
    expect(righe.find((a) => a.id === ALU_1)?.parents).toHaveLength(1)
  })

  it('guasto della lettura `frequenze`: 500 con `codice: LETTURA_FALLITA`, mai una lista vuota', async () => {
    h.errori = { frequenze: { code: 'XX000', message: 'guasto' } }
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('schema dell’anno assente sulle `frequenze` (42P01): ripiego sulla lettura di sempre, e il ripiego è LOGGATO col solo codice', async () => {
    h.errori = { frequenze: { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('db', 'warn', expect.objectContaining({ esito: 'schema-anno-assente-ripiego', lettura: 'frequenze', codice: '42P01' }))
  })

  it('una sezione `in_preparazione` non è un anno passato: lettura di sempre, nessuna frequenza letta', async () => {
    h.db.anni_sede[1].stato = 'in_preparazione'
    await GET(richiesta(SEC_VECCHIA))
    expect(h.tabelle).not.toContain('frequenze')
  })

  it('una frequenza SENZA `section_id` non appartiene a nessuna classe: resta fuori dal roster (nessun ripiego)', async () => {
    h.db.frequenze.push({ id: 'f9', alunno_id: ALU_NUOVO, anno_id: ANNO_VECCHIO, section_id: null, stato: 'iscritto' })
    const res = await GET(richiesta(SEC_VECCHIA))
    expect(await ids(res)).toEqual([ALU_1, ALU_2].sort())
  })
})
