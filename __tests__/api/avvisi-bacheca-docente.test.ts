import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../fixtures/sedi'

// =============================================================================
// GET /api/avvisi (ramo STAFF) — la bacheca della docente mostra solo ciò che la
// riguarda, e dice quali avvisi può modificare.
//
// ── IL DIFETTO CHIUSO (segnalato dalla scuola il 2026-10-07) ────────────────
//
// «L'avviso scritto per due classi è comparso a tutta la scuola.» Misurato in
// produzione: le FAMIGLIE giuste lo avevano ricevuto, zero fuori target. Lo
// vedevano invece TUTTE le docenti del plesso, in bacheca e in home, perché
// `listaAvvisiStaff` filtrava solo per sede. E su ognuno offriva «Modifica» ed
// «Elimina», anche su quelli della segreteria.
//
// ── LA REGOLA (titolare, 2026-10-07) ────────────────────────────────────────
//
// Docente: per tutta la sede · di almeno UNA sua classe (nella stessa sede) ·
// scritti da lei. Segreteria e direzione: tutto. `modificabile` lo calcola il
// server: vero per la gestione, vero per la docente SOLO sui propri.
//
// Il finto client APPLICA i filtri (`.in('scuola_id')` compreso): il test della
// classe omonima in un'altra sede è verde solo se il codice confronta la COPPIA
// (nome, sede), non il nome da solo.
// =============================================================================

const DOCENTE = 'edu-1'
const COLLEGA = 'edu-2'
const SEGRETERIA = 'seg-1'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v,
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }),
  }
})

import { GET } from '@/app/api/avvisi/route'

const req = () => ({
  url: 'http://test/api/avvisi',
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams() },
  cookies: { get: () => undefined },
}) as never

const avviso = (
  id: string,
  autore: string,
  scope: 'globale' | 'classe',
  classi: string[] | null,
  sede: string,
) => ({
  id,
  author_id: autore,
  titolo: id,
  contenuto: 'c',
  tipo: 'presa_visione',
  target_scope: scope,
  target_classes: classi,
  scadenza: null,
  scadenza_avviso: '2026-12-31T22:59:59.999Z',
  scadenza_adesione: null,
  chiedi_numero: false,
  etichetta_numero: null,
  numero_min: 1,
  numero_max: 20,
  posti_totali: null,
  attachment_url: null,
  form_model_id: null,
  created_at: '2026-10-05T08:00:00.000Z',
  scuola_id: sede,
})

const utente = (id: string, ruolo: string) => ({
  id, first_name: id, last_name: 'X', role: ruolo, ruolo, nome: null, cognome: null,
})

const dbBase = (): DBFinto => ({
  utenti: [utente(DOCENTE, 'educator'), utente(COLLEGA, 'educator'), utente(SEGRETERIA, 'segreteria')],
  avvisi_risposte: [],
  // La docente ha UNA classe: «Girasoli» della sede A. La sede B ha una classe
  // con lo stesso nome, che NON è sua.
  utenti_sezioni: [
    { utente_id: DOCENTE, section_id: 'sez-gira-a', sections: { name: 'Girasoli', scuola_id: SEDE_A } },
    { utente_id: COLLEGA, section_id: 'sez-tuli-a', sections: { name: 'Tulipani', scuola_id: SEDE_A } },
  ],
  avvisi: [
    avviso('globale-a', SEGRETERIA, 'globale', null, SEDE_A),
    avviso('due-classi-con-la-mia', SEGRETERIA, 'classe', ['Girasoli', 'Tulipani'], SEDE_A),
    // IL CASO SEGNALATO: due classi, nessuna delle due è sua.
    avviso('due-classi-altrui', SEGRETERIA, 'classe', ['Tulipani', 'Papaveri'], SEDE_A),
    avviso('omonima-altra-sede', SEGRETERIA, 'classe', ['Girasoli'], SEDE_B),
    avviso('scritto-da-me', DOCENTE, 'classe', ['Papaveri'], SEDE_A),
    avviso('della-collega', COLLEGA, 'classe', ['Girasoli'], SEDE_A),
    // Fuori dalle sedi attive: non compare a nessuno (lo garantisce `.in`).
    avviso('sede-c', SEGRETERIA, 'globale', null, SEDE_C),
  ],
})

type Voce = { id: string; modificabile?: boolean }

const bacheca = async (): Promise<Voce[]> => {
  const res = await GET(req())
  expect(res.status).toBe(200)
  return ((await res.json()) as Voce[]).sort((a, b) => a.id.localeCompare(b.id))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.errori = {}
  h.logEvento.mockReset()
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A, SEDE_B])
})

describe('GET /api/avvisi — la docente vede solo ciò che la riguarda', () => {
  beforeEach(() => {
    h.requireUser.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A } })
  })

  it('🔴 un avviso per due classi altrui NON compare nella sua bacheca', async () => {
    const ids = (await bacheca()).map((a) => a.id)
    expect(ids).not.toContain('due-classi-altrui')
  })

  it('vede esattamente: globali, avvisi con una sua classe, i propri', async () => {
    expect((await bacheca()).map((a) => a.id)).toEqual([
      'della-collega',
      'due-classi-con-la-mia',
      'globale-a',
      'scritto-da-me',
    ])
  })

  it('la classe omonima di un ALTRO plesso non conta', async () => {
    expect((await bacheca()).map((a) => a.id)).not.toContain('omonima-altra-sede')
  })

  it('`modificabile` è vero SOLO sui suoi avvisi', async () => {
    const perId = Object.fromEntries((await bacheca()).map((a) => [a.id, a.modificabile]))
    expect(perId).toEqual({
      'della-collega': false,
      'due-classi-con-la-mia': false,
      'globale-a': false,
      'scritto-da-me': true,
    })
  })

  it('senza classi assegnate: solo globali e propri, e una riga `warn` che lo dice', async () => {
    h.db.utenti_sezioni = []
    expect((await bacheca()).map((a) => a.id)).toEqual(['globale-a', 'scritto-da-me'])
    const esiti = h.logEvento.mock.calls
      .filter((c) => c[1] === 'warn')
      .map((c) => (c[2] as { esito?: string }).esito)
    expect(esiti).toContain('docente-senza-sezioni')
  })
})

describe('GET /api/avvisi — segreteria e direzione vedono e gestiscono tutto', () => {
  it.each(['segreteria', 'admin', 'coordinator'] as const)('%s: ogni avviso delle sedi attive, tutti modificabili', async (ruolo) => {
    h.requireUser.mockResolvedValue({ user: { id: SEGRETERIA, role: ruolo, scuola_id: SEDE_A } })
    const voci = await bacheca()
    expect(voci.map((a) => a.id)).toEqual([
      'della-collega',
      'due-classi-altrui',
      'due-classi-con-la-mia',
      'globale-a',
      'omonima-altra-sede',
      'scritto-da-me',
    ])
    expect(voci.every((a) => a.modificabile === true)).toBe(true)
  })
})
