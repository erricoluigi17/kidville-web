import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** K4: la SECONDA lettura di `utenti_scuole` nella richiesta risponde con un errore. */
  guastoSecondaLetturaSedi: false,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  h.logErrore.mockImplementation(vero.logErrore)
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const c = creaFintoSupabase(h.db, [], { errori: h.errori })
      if (!h.guastoSecondaLetturaSedi) return c
      // La prima lettura (dentro `resolveScuoleAttive`) va bene; la seconda — quella da cui la
      // route prende le sedi dei paganti — risponde `{ error }`, e `scuoleDiUtente` VERO la
      // trasforma in `[]` (loggando `sedi-utente-non-risolte`).
      const guasto = creaFintoSupabase(h.db, [], { errori: { utenti_scuole: { code: '57014' } } })
      const from = c.from.bind(c)
      let letture = 0
      Object.assign(c, { from: (t: string) => (t === 'utenti_scuole' && ++letture === 2 ? guasto.from(t) : from(t)) })
      return c
    },
  }
})

import { GET } from '@/app/api/pagamenti/rette-a-carico/route'
import { legamiDaRisposta } from '@/lib/pagamenti/rette-a-carico'

const req = (qs = '') => new NextRequest(`http://localhost/api/pagamenti/rette-a-carico${qs ? `?${qs}` : ''}`)
const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (id: string, sede: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `N-${id}`, cognome: `C-${id}`, classe_sezione: `Sez-${id}`, section_id: null,
  scuola_id: sede, stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.guastoSecondaLetturaSedi = false
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }, { id: SEDE_C, nome: 'Terza' }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [
      alunno('pa', SEDE_A), alunno('fa', SEDE_A, { retta_a_carico_di: 'pa' }),
      alunno('pb', SEDE_B, { gender: 'F' }), alunno('fb', SEDE_B, { retta_a_carico_di: 'pb' }),
      alunno('pc', SEDE_C), alunno('fc', SEDE_C, { retta_a_carico_di: 'pc' }),     // sede non accessibile
      alunno('fr', SEDE_A, { retta_a_carico_di: 'pa', stato: 'ritirato' }),        // non iscritto
      alunno('fx', SEDE_A, { retta_a_carico_di: 'pc' }),                           // pagante in sede NON accessibile
    ],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('GET /api/pagamenti/rette-a-carico', () => {
  it('i legami delle sedi accessibili, con il solo pagante (niente dati del bambino)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    const ids = (corpo.data as { alunno_id: string }[]).map((l) => l.alunno_id).sort()
    expect(ids).toEqual(['fa', 'fb'])
    const fb = corpo.data.find((l: { alunno_id: string }) => l.alunno_id === 'fb')
    expect(fb).toEqual({
      alunno_id: 'fb', scuola_id: SEDE_B,
      pagante: { id: 'pb', nome: 'N-pb', cognome: 'C-pb', sesso: 'F', classe_sezione: 'Sez-pb', iscritto: true, scuola_id: SEDE_B },
    })
    expect(JSON.stringify(corpo)).not.toContain('N-fb')
  })

  // C3 (revisione 2026-09-28): il bambino è nella sede dell'utente, il pagante no. Esce il SOLO
  // uuid del bambino — che il cruscotto ha già — e niente del pagante.
  it('pagante in una sede non accessibile: il solo uuid del bambino in a_carico_non_visibili', async () => {
    const corpo = await (await GET(req())).json()
    expect(corpo.a_carico_non_visibili).toEqual(['fx'])
    expect(corpo.data.map((l: { alunno_id: string }) => l.alunno_id)).not.toContain('fx')
    expect(JSON.stringify(corpo)).not.toContain('N-pc')
    expect(JSON.stringify(corpo)).not.toContain('Sez-pc')
  })

  // K4 (seconda revisione 2026-09-28): le sedi dei paganti venivano SOLO da una seconda
  // chiamata a `scuoleDiUtente`, che su un errore restituisce `[]`. Allora anche il pagante
  // della STESSA sede del bambino risultava «non leggibile», e il cruscotto diceva il falso
  // «Chi paga è in un'altra sede». Ora sono l'unione con le sedi dei bambini.
  it('K4 — la seconda lettura delle sedi fallisce: i paganti della sede del bambino restano leggibili', async () => {
    h.guastoSecondaLetturaSedi = true
    const corpo = await (await GET(req())).json()
    // La prova che il guasto è scattato davvero: `scuoleDiUtente` l'ha loggato.
    expect(h.logEvento).toHaveBeenCalledWith('auth', 'error', expect.objectContaining({ tipo: 'sedi-utente-non-risolte' }), expect.anything())
    expect(corpo.data.map((l: { alunno_id: string }) => l.alunno_id).sort()).toEqual(['fa', 'fb'])
    // Il pagante in una sede davvero non accessibile resta non leggibile, come prima.
    expect(corpo.a_carico_non_visibili).toEqual(['fx'])
    expect(JSON.stringify(corpo)).not.toContain('N-pc')
  })

  // K6: il cruscotto ora valida OGNI campo. Il contratto: ciò che questa route produce passa
  // quella validazione per intero — anche senza `gender`/`archiviato_il`, le due colonne che il
  // ripiego sul 42703 toglie (il ripiego in sé lo prova `rette-a-carico-server.test.ts`: il
  // client finto non emette 42703 per una colonna assente, la restituisce vuota).
  it('K6 — il corpo della route passa `legamiDaRisposta` con zero scarti (anche senza gender)', async () => {
    const pieno = await (await GET(req())).json()
    expect(pieno.data.length).toBeGreaterThan(0)
    expect(legamiDaRisposta(pieno.data)).toEqual({ legami: pieno.data, scartati: 0 })
    // Senza `gender` il pagante esce con `sesso: null`, che è valido.
    h.db.alunni = h.db.alunni.map(({ gender: _g, archiviato_il: _a, ...resto }) => { void _g; void _a; return resto })
    const ridotto = await (await GET(req())).json()
    expect(ridotto.data.length).toBeGreaterThan(0)
    expect(ridotto.data.every((l: { pagante: { sesso: unknown } }) => l.pagante.sesso === null)).toBe(true)
    expect(legamiDaRisposta(ridotto.data)).toEqual({ legami: ridotto.data, scartati: 0 })
  })

  it('scuola_id restringe a quella sede', async () => {
    const corpo = await (await GET(req(`scuola_id=${SEDE_A}`))).json()
    expect(corpo.data.map((l: { alunno_id: string }) => l.alunno_id)).toEqual(['fa'])
    expect(corpo.a_carico_non_visibili).toEqual(['fx'])
    // Con la sola sede B, «fx» (che è della sede A) non c'è.
    expect((await (await GET(req(`scuola_id=${SEDE_B}`))).json()).a_carico_non_visibili).toEqual([])
  })

  it('scuola_id di una sede non accessibile: 403, mai «nessun legame»', async () => {
    const res = await GET(req(`scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('scuola_id non uuid: 400', async () => {
    expect((await GET(req('scuola_id=abc'))).status).toBe(400)
  })

  it('senza staff: la risposta del gate, tale e quale', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
  })

  it('DB non migrato (42703): 200 con zero legami', async () => {
    h.errori = { 'alunni:select': { code: '42703', message: 'column alunni.retta_a_carico_di does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('guasto di lettura: 500 con LETTURA_FALLITA, e il log dice perché', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ operazione: 'pagamenti/rette-a-carico:GET', esito: 'legami-bambini-non-letti' }), expect.anything())
  })

  // R3 (terza revisione 2026-09-29): il loader aveva già loggato la causa (error), e sul 500
  // `withRoute` — che non trovava la marca anti-doppione — ne aggiungeva una seconda, più
  // povera (`route`, error). Un guasto = UNA riga error.
  it('R3 — un guasto dei legami è UNA riga error: quella del loader, senza il doppione di withRoute', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    expect((await GET(req())).status).toBe(500)
    const errori = [
      ...h.logEvento.mock.calls.filter((c) => c[1] === 'error').map((c) => `${c[0]}:${(c[2] as { esito?: string }).esito ?? '-'}`),
      ...h.logErrore.mock.calls.map(() => 'logErrore'),
    ]
    expect(errori).toEqual(['pagamento:legami-bambini-non-letti'])
  })
})
