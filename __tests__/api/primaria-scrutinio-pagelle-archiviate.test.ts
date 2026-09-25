import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// GET /api/primaria/scrutinio → `pagelleArchiviate` (compito S3, spec 2026-09-24).
//
// La pagina dello scrutinio mostra «Elimina pagella» SOLO sugli alunni che hanno
// davvero un PDF archiviato. Questo elenco glielo dice la GET: qui si fissa
//  · che la lettura va sulla tabella `pagelle` filtrata per lo scrutinio APERTO
//    dalla GET (non un altro, non tutte le pagelle della scuola);
//  · che la risposta porta solo gli uuid degli alunni, senza doppioni;
//  · che un `{ error }` di PostgREST NON diventa «nessuna pagella» in silenzio:
//    si logga a livello `error`, l'elenco è vuoto (il comando distruttivo non si
//    mostra) e la risposta lo DICHIARA con `pagelleArchiviateNonLette: true`,
//    mentre il resto dello scrutinio resta leggibile.
// =============================================================================

const h = vi.hoisted(() => {
  type Esito = { data: unknown; error: unknown }
  const state = {
    esiti: {} as Record<string, Esito>,
    filtri: [] as Array<{ tabella: string; colonna: string; valore: unknown }>,
    select: [] as Array<{ tabella: string; colonne: string }>,
  }
  function makeClient() {
    return {
      from(tabella: string) {
        const qb: Record<string, unknown> = {}
        qb.select = (colonne: string) => { state.select.push({ tabella, colonne }); return qb }
        qb.eq = (colonna: string, valore: unknown) => { state.filtri.push({ tabella, colonna, valore }); return qb }
        for (const m of ['order', 'limit', 'in', 'insert']) qb[m] = () => qb
        const esito = () => Promise.resolve(state.esiti[tabella] ?? { data: [], error: null })
        qb.single = esito
        qb.maybeSingle = esito
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => esito().then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient, logEvento: vi.fn(), logErrore: vi.fn() }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.makeClient()),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'eeee5555-0000-4000-8000-0000000000e5', role: 'segreteria' } })),
  requireStaff: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/audit/valutatore', () => ({ titolareDiMateria: vi.fn(async () => null) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...orig, logEvento: h.logEvento, logErrore: h.logErrore }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/primaria/scrutinio/route'

const SEZIONE = 'aaaa1111-0000-4000-8000-0000000000a1'
const SCUOLA = 'abab1111-0000-4000-8000-0000000000ab'
const PERIODO = 'cccc3333-0000-4000-8000-0000000000c3'
const SCRUTINIO = 'bbbb2222-0000-4000-8000-0000000000b2'
const ALUNNO_A = 'dddd4444-0000-4000-8000-0000000000d4'
const ALUNNO_B = 'ffff6666-0000-4000-8000-0000000000f6'

function richiesta() {
  return new NextRequest(`http://localhost/api/primaria/scrutinio?sectionId=${SEZIONE}&periodoId=${PERIODO}`)
}

beforeEach(() => {
  h.state.filtri = []
  h.state.select = []
  h.logEvento.mockReset()
  h.logErrore.mockReset()
  h.state.esiti = {
    sections: { data: { id: SEZIONE, name: 'I A', school_type: 'primaria', scuola_id: SCUOLA }, error: null },
    scrutinio_periodi: { data: { id: PERIODO }, error: null },
    scrutini: { data: { id: SCRUTINIO, stato: 'chiuso', chiuso_il: '2026-02-10T10:00:00Z' }, error: null },
    alunni: {
      data: [
        { id: ALUNNO_A, nome: 'A', cognome: 'A' },
        { id: ALUNNO_B, nome: 'B', cognome: 'B' },
      ],
      error: null,
    },
    // Una riga doppia per lo stesso alunno: la risposta non deve ripeterlo.
    pagelle: { data: [{ alunno_id: ALUNNO_A }, { alunno_id: ALUNNO_A }], error: null },
  }
})

describe('GET /api/primaria/scrutinio → pagelleArchiviate', () => {
  it('legge `pagelle` dello scrutinio aperto e restituisce solo gli uuid degli alunni archiviati', async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = await res.json()

    expect(corpo.data.pagelleArchiviate).toEqual([ALUNNO_A])
    expect(corpo.data.pagelleArchiviateNonLette).toBe(false)

    // La query: colonna sola `alunno_id` (niente file_url, niente dati in più)
    // e filtro sullo scrutinio restituito, UNICO filtro della lettura.
    expect(h.state.select.filter((s) => s.tabella === 'pagelle')).toEqual([{ tabella: 'pagelle', colonne: 'alunno_id' }])
    expect(h.state.filtri.filter((f) => f.tabella === 'pagelle')).toEqual([
      { tabella: 'pagelle', colonna: 'scrutinio_id', valore: SCRUTINIO },
    ])
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('nessuna pagella archiviata → elenco vuoto, e non è un guasto', async () => {
    h.state.esiti.pagelle = { data: [], error: null }
    const corpo = await (await GET(richiesta())).json()
    expect(corpo.data.pagelleArchiviate).toEqual([])
    expect(corpo.data.pagelleArchiviateNonLette).toBe(false)
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('`{ error }` di PostgREST: log error, elenco vuoto DICHIARATO, lo scrutinio resta leggibile', async () => {
    const guasto = { message: 'connection reset', code: '08006' }
    // `data` non nullo di proposito: con l'errore non si deve usare comunque.
    h.state.esiti.pagelle = { data: [{ alunno_id: ALUNNO_B }], error: guasto }

    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.data.pagelleArchiviate).toEqual([])
    expect(corpo.data.pagelleArchiviateNonLette).toBe(true)
    // Il resto dello scrutinio c'è: il guasto toglie solo il comando distruttivo.
    expect(corpo.data.scrutinio.id).toBe(SCRUTINIO)
    expect(corpo.data.alunni).toHaveLength(2)

    expect(h.logEvento).toHaveBeenCalledWith(
      'db',
      'error',
      { operazione: 'primaria/scrutinio:GET', esito: 'pagelle-archiviate-non-lette' },
      guasto,
    )
  })
})
