import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * NASCONDERE NON DEVE ESSERE COSMETICO — il gate delle venti rotte.
 *
 * Filtrare solo l'ELENCO non basta: `kv_student_id` resta nel localStorage,
 * l'URL `?id=` si condivide e si tiene nei preferiti, e le venti rotte che
 * passano da `requireParentOfStudent` continuerebbero a rispondere 200 col
 * contenuto — diario, galleria, mensa, presenze, primaria, armadietto. Qui si
 * mette a contratto che il filtro chiude anche quella porta, e che le due
 * superfici che devono continuare a vedere il ritirato passano `false`.
 *
 * ⚠️ IL PERIMETRO DI SICUREZZA NON CAMBIA. Il legame di famiglia resta l'unica
 * cosa che decide un IDOR; questo è un filtro di PRESENTAZIONE, e su una lettura
 * fallita LASCIA PASSARE — negare un genitore titolare per un blip del database
 * è il difetto T13 che questo repo ha già pagato una volta.
 */

const GENITORE = '710717f0-d5ae-4f6f-889f-60d167b65a3b'
const CON_SEZIONE = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const SENZA_SEZIONE = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const ARCHIVIATO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'
const SEDE = 'eeeeeeee-0000-4000-8000-00000000000e'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: vi.fn(async () => null) }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }),
    createClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }),
  }
})

import { requireParentOfStudent } from '@/lib/auth/require-parent'

const req = () => new Request('http://localhost/api/parent/x')

const dbBase = (): DBFinto => ({
  legame_genitori_alunni: [
    { genitore_id: GENITORE, alunno_id: CON_SEZIONE },
    { genitore_id: GENITORE, alunno_id: SENZA_SEZIONE },
    { genitore_id: GENITORE, alunno_id: ARCHIVIATO },
  ],
  parents: [],
  student_parents: [],
  alunni: [
    { id: CON_SEZIONE, scuola_id: SEDE, section_id: 'sec-1', stato: 'iscritto', archiviato_il: null },
    { id: SENZA_SEZIONE, scuola_id: SEDE, section_id: null, stato: 'iscritto', archiviato_il: null },
    { id: ARCHIVIATO, scuola_id: SEDE, section_id: null, stato: 'ritirato', archiviato_il: '2026-06-30T10:00:00Z' },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.errori = {}
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' }, response: null })
})

describe('requireParentOfStudent — il figlio nascosto non si riapre con un link', () => {
  it('figlio con la classe: passa (è la premessa di tutto il resto)', async () => {
    const r = await requireParentOfStudent(req(), CON_SEZIONE)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe(GENITORE)
  })

  it('figlio SENZA sezione: 403, e col codice che la famiglia sa leggere', async () => {
    const r = await requireParentOfStudent(req(), SENZA_SEZIONE)
    expect(r.response?.status).toBe(403)
    const body = await r.response!.json()
    // Il catalogo dice «Non troviamo questo bambino fra i tuoi figli. Contatta la
    // segreteria»: è la frase vera, ed è già tradotta in entrambe le lingue.
    expect(body.codice).toBe('ALUNNO_NON_TROVATO')
  })

  it('PROVA NEGATIVA — do una sezione a quel bambino e il 403 diventa un via libera', async () => {
    const prima = await requireParentOfStudent(req(), SENZA_SEZIONE)
    expect(prima.response?.status).toBe(403)

    h.db.alunni[1].section_id = 'sec-2'
    const dopo = await requireParentOfStudent(req(), SENZA_SEZIONE)
    expect(dopo.response, 'un filtro mai visto lasciar passare non è un filtro').toBeUndefined()
    expect(dopo.user?.id).toBe(GENITORE)
  })

  it('figlio ARCHIVIATO: 403', async () => {
    const r = await requireParentOfStudent(req(), ARCHIVIATO)
    expect(r.response?.status).toBe(403)
  })

  it('il rifiuto lascia una riga `info` con SOLO uuid ed enumerati', async () => {
    await requireParentOfStudent(req(), SENZA_SEZIONE)
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { tipo?: string })?.tipo === 'alunno-non-attivo',
    )
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('auth')
    expect(riga?.[2]).toMatchObject({
      tipo: 'alunno-non-attivo',
      azione: 'requireParentOfStudent',
      utente: GENITORE,
      alunno_id: SENZA_SEZIONE,
      stato: 403,
    })
    // NON è il contatore degli IDOR: quello conta i TENTATIVI, e qui non c'è
    // nessun tentativo — c'è un client con un id vecchio in cache.
    expect(riga?.[1]).not.toBe('warn')
    const tipiWarn = h.logEvento.mock.calls
      .filter((c) => c[0] === 'auth' && c[1] === 'warn')
      .map((c) => (c[2] as { tipo?: string })?.tipo)
    expect(tipiWarn).not.toContain('alunno-non-della-famiglia')
  })
})

describe('le superfici che DEVONO continuare a vedere chi non c\'è più', () => {
  it('`richiediAttivo: false` — il ritirato passa (prestampati, precompilato)', async () => {
    // I prestampati hanno rifiuti propri e molto più utili
    // (`PRESTAMPATO_ALUNNO_NON_ISCRITTO`, `…_ANONIMIZZATO`): un 403 generico
    // prima di loro sostituirebbe una frase che spiega con una che non spiega.
    const r = await requireParentOfStudent(req(), ARCHIVIATO, false)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe(GENITORE)
  })

  it('il legame resta l\'unico perimetro di sicurezza: un figlio ALTRUI è 403 anche con `false`', async () => {
    const ALTRUI = 'ffffffff-9999-4999-8999-ffffffffffff'
    h.db.alunni.push({ id: ALTRUI, scuola_id: SEDE, section_id: 'sec-9', stato: 'iscritto', archiviato_il: null })
    const r = await requireParentOfStudent(req(), ALTRUI, false)
    expect(r.response?.status).toBe(403)
    const tipiWarn = h.logEvento.mock.calls
      .filter((c) => c[0] === 'auth' && c[1] === 'warn')
      .map((c) => (c[2] as { tipo?: string })?.tipo)
    expect(tipiWarn, 'il contatore degli IDOR deve restare quello dei tentativi VERI').toContain('alunno-non-della-famiglia')
  })
})

describe('un guasto di lettura non chiude l\'app in faccia a un genitore titolare', () => {
  it('`alunni` non leggibile: si passa, e resta una riga di guasto', async () => {
    // La lettura dei LEGAMI riesce (il legame è in `legame_genitori_alunni`), è
    // quella di `alunni` a cadere: il gate non può concluderne «non è tuo figlio».
    h.errori = { alunni: { code: '08006', message: 'connessione persa' } }
    const r = await requireParentOfStudent(req(), SENZA_SEZIONE)
    expect(r.response, 'una SELECT storta non deve valere come un ritiro').toBeUndefined()
    const guasto = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'alunno-attivo-non-letto',
    )
    expect(guasto, 'degradare aperti in silenzio sarebbe un filtro che smette di filtrare').toBeDefined()
    expect(guasto?.[1]).toBe('error')
  })

  it('un client che LANCIA (non un errore PostgREST) degrada allo stesso modo', async () => {
    const { verificaAlunnoAttivo } = await import('@/lib/alunni/attivo')
    const rotto = {} as unknown as import('@supabase/supabase-js').SupabaseClient
    expect(await verificaAlunnoAttivo(rotto, SENZA_SEZIONE)).toBe('non-letto')
  })
})

describe('lo staff non è toccato: il filtro è della famiglia', () => {
  it('una segreteria apre l\'archiviato senza incontrare questo 403', async () => {
    // La biforcazione è sul LEGAME: chi non è famiglia passa da
    // `assertAlunnoInScope`, che qui è mockato permissivo. Il filtro di
    // visibilità non deve nemmeno essere consultato.
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria' }, response: null })
    const r = await requireParentOfStudent(req(), ARCHIVIATO)
    expect(r.response).toBeUndefined()
  })
})
