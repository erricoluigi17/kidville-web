import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// PUT /api/avvisi/[id] — se la modifica AGGIUNGE destinatari, i nuovi vengono
// avvisati. Solo loro.
//
// ── IL BUCO (verificato il 2026-10-07) ──────────────────────────────────────
//
// La creazione notifica sempre: in produzione 103 avvisi su 103 degli ultimi
// trenta giorni hanno la notifica iniziale, e solo verso le classi destinatarie.
// La MODIFICA invece non notificava mai: la segreteria aggiunge una classe a un
// avviso, quelle famiglie lo trovano in bacheca solo se ci capitano, e nessuno
// glielo dice. Su un'adesione con scadenza è un'adesione persa.
//
// ── LA REGOLA ───────────────────────────────────────────────────────────────
//
// Destinatari dello stato RISULTANTE, meno chi ha già la notifica iniziale di
// questo avviso. Mai di nuovo a chi l'ha già avuta: una seconda notifica a tutta
// la sede per un titolo corretto è rumore, e insegna a ignorarle.
// Se non si riesce a sapere chi l'ha già avuta, non si manda niente (con una
// riga `error`): meglio nessuna notifica che una doppia a tutta la sede.
//
// I destinatari per classe sono un finto CHE DIPENDE dall'input (classe →
// genitori), non una lista fissa: con una lista fissa il test sarebbe verde
// anche se il codice passasse le classi sbagliate.
// =============================================================================

const SEGRETERIA = '33333333-3333-4333-8333-333333333333'
const AVVISO = 'aaaaaaaa-0000-4000-8000-00000000000a'

/** Genitori per classe. P2 ha un figlio in entrambe. */
const GENITORI: Record<string, string[]> = {
  Girasoli: ['p1', 'p2'],
  Tulipani: ['p2', 'p3'],
}

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAvvisoInScope: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope-avvisi', () => ({ assertAvvisoInScope: h.assertAvvisoInScope }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiClassi: async (_s: unknown, _sede: unknown, classi: string[]) =>
    [...new Set(classi.flatMap((c) => GENITORI[c] ?? []))],
  genitoriDiScuola: async () => ['p1', 'p2', 'p3', 'p4'],
}))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v ?? null,
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], { scritture: h.scritture as Scrittura[], errori: h.errori }),
  }
})

import { PUT } from '@/app/api/avvisi/[id]/route'

const put = (body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/avvisi/${AVVISO}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: AVVISO }) },
  )

const notificaIniziale = (utente: string) => ({
  id: `n-${utente}`,
  utente_id: utente,
  tipo: 'avviso',
  entita_tipo: 'avviso',
  entita_id: AVVISO,
})

const dbBase = (classi: string[]): DBFinto => ({
  sections: [
    { id: 'sec-gira', scuola_id: SEDE_A, name: 'Girasoli' },
    { id: 'sec-tuli', scuola_id: SEDE_A, name: 'Tulipani' },
  ],
  avvisi: [{
    id: AVVISO,
    author_id: SEGRETERIA,
    titolo: 'Uscita al parco',
    contenuto: 'Portare il cappellino.',
    tipo: 'presa_visione',
    target_scope: 'classe',
    target_classes: classi,
    scadenza: null,
    scadenza_avviso: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    scadenza_adesione: null,
    posti_totali: null,
    chiedi_numero: false,
    attachment_url: null,
    form_model_id: null,
    scuola_id: SEDE_A,
  }],
  // Chi ha già avuto la notifica iniziale: i genitori dei Girasoli. Più una
  // notifica di ALTRO tipo a p3 (una risposta), che non conta come «avvisato».
  notifiche: [
    ...(GENITORI.Girasoli.map(notificaIniziale)),
    { id: 'n-risp', utente_id: 'p3', tipo: 'avviso_risposta', entita_tipo: 'avviso', entita_id: AVVISO },
  ],
  audit_scritture_docente: [],
})

const corpo = (classi: string[]) => ({
  titolo: 'Uscita al parco',
  contenuto: 'Portare il cappellino.',
  tipo: 'presa_visione',
  target_scope: 'classe',
  target_classes: classi,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase(['Girasoli'])
  h.scritture = []
  h.errori = {}
  h.logEvento.mockReset()
  h.notificaEvento.mockResolvedValue(undefined)
  h.assertAvvisoInScope.mockResolvedValue(null)
  h.requireDocente.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
})

describe('PUT /api/avvisi/[id] — la notifica ai destinatari AGGIUNTI', () => {
  it('🔴 aggiungere una classe avvisa SOLO le famiglie nuove', async () => {
    const res = await put(corpo(['Girasoli', 'Tulipani']))
    expect(res.status).toBe(200)
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const params = h.notificaEvento.mock.calls[0][1] as {
      tipo: string; utenteIds: string[]; titolo: string; entitaTipo: string; entitaId: string
      scuolaId: string; debounce: boolean
    }
    // p1 e p2 l'avevano già; p3 aveva solo una notifica di RISPOSTA, che non conta.
    expect([...params.utenteIds].sort()).toEqual(['p3'])
    expect(params.tipo).toBe('avviso')
    expect(params.titolo).toBe('Nuovo avviso: Uscita al parco')
    expect(params.entitaTipo).toBe('avviso')
    expect(params.entitaId).toBe(AVVISO)
    expect(params.scuolaId).toBe(SEDE_A)
    expect(params.debounce).toBe(true)
  })

  it('CONTROLLO NEGATIVO: correggere solo il titolo non manda niente', async () => {
    const res = await put({ ...corpo(['Girasoli']), titolo: 'Uscita al parco (ore 9)' })
    expect(res.status).toBe(200)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('restringere i destinatari non manda niente: nessuno è nuovo', async () => {
    h.db = dbBase(['Girasoli', 'Tulipani'])
    const res = await put(corpo(['Girasoli']))
    expect(res.status).toBe(200)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('se non si sa chi è già stato avvisato: nessun invio, e una riga `error`', async () => {
    h.errori = { notifiche: { code: '42501', message: 'permission denied' } }
    const res = await put(corpo(['Girasoli', 'Tulipani']))
    // La modifica è già scritta: la risposta resta 200.
    expect(res.status).toBe(200)
    expect(h.notificaEvento).not.toHaveBeenCalled()
    const esitiErrore = h.logEvento.mock.calls
      .filter((c) => c[1] === 'error')
      .map((c) => (c[2] as { esito?: string }).esito)
    expect(esitiErrore).toContain('notifica-nuovi-destinatari-non-calcolata')
  })
})
