import { describe, it, expect, vi, beforeEach } from 'vitest'

/** PR 4.1 · COMPITO 4.1.4 · GET /api/anno/calendario: sedi e visibilità per ruolo, degrado, 400/401/500. */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const FIGLIO = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

type Esito = { data: unknown; error: { code?: string } | null }

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  figli: [] as Array<{ id: string; scuola_id: string | null }>,
  figliErrore: null as null | { code?: string },
  anni: {} as Record<string, Esito>,
  letture: 0,
  log: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: async () =>
    h.user
      ? { user: h.user, response: null }
      : { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) },
}))
vi.mock('@/lib/auth/scope', () => ({
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => (u.scuola_id ? [u.scuola_id] : []),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliAttiviDiGenitore: async () => ({
    righe: h.figli,
    totaleLegami: h.figli.length,
    nascosti: {},
    completo: true,
    errore: h.figliErrore,
  }),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      let sede = ''
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.in = () => b
      b.eq = (_c: string, v: string) => {
        sede = v
        return b
      }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (tabella === 'anni_scolastici') {
          // la seconda lettura (senza embed): { id, anno_inizio } dai join che le righe di prova portano ancora
          const righe = Object.values(h.anni).flatMap((e) =>
            ((e.data ?? []) as Array<{ anno_id: string; anni_scolastici: { anno_inizio: number } }>).map((r) => ({
              id: r.anno_id,
              anno_inizio: r.anni_scolastici.anno_inizio,
            })),
          )
          return Promise.resolve({ data: righe, error: null }).then(res, rej)
        }
        h.letture++
        return Promise.resolve(h.anni[sede] ?? { data: [], error: null }).then(res, rej)
      }
      return b
    },
  }),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => void h.log.push(a),
  logErrore: (...a: unknown[]) => void h.log.push(a),
  logOk: (...a: unknown[]) => void h.log.push(a),
}))

import { GET } from '@/app/api/anno/calendario/route'

const riga = (id: string, stato: string, inizio: string, anno: number) => ({
  id,
  anno_id: `b-${id}`,
  inizio,
  fine: `${anno + 1}-08-31`,
  ultimo_giorno_aperto: `${anno + 1}-07-31`,
  prepara_successivo_dal: `${anno + 1}-03-01`,
  stato,
  domande_aperte: false,
  anni_scolastici: { anno_inizio: anno },
})
const ANNI_SEDE: Esito = {
  data: [
    riga('x1', 'chiuso', '2024-09-01', 2024),
    riga('x2', 'corrente', '2025-09-01', 2025),
    riga('x3', 'in_chiusura', '2026-09-01', 2026),
    riga('x4', 'iscrizioni_aperte', '2027-09-01', 2027),
    riga('x5', 'in_preparazione', '2028-09-01', 2028),
  ],
  error: null,
}
const STATI_TUTTI = ['chiuso', 'corrente', 'in_chiusura', 'iscrizioni_aperte', 'in_preparazione']
const STATI_VISIBILI = ['chiuso', 'corrente', 'in_chiusura']

type Corpo = { success: boolean; fonte: string; data: Array<{ scuola_id: string; righe: Array<{ stato: string }> }> }
const chiedi = (query = '') => GET(new Request(`http://localhost/api/anno/calendario${query}`) as never)
const corpo = async () => (await chiedi()).json() as Promise<Corpo>
const stati = (b: Corpo, sede: string) => b.data.find((d) => d.scuola_id === sede)?.righe.map((r) => r.stato)

beforeEach(() => {
  h.user = { id: 'U1', role: 'segreteria', scuola_id: SEDE_A }
  h.figli = []
  h.figliErrore = null
  h.anni = { [SEDE_A]: ANNI_SEDE, [SEDE_B]: ANNI_SEDE }
  h.letture = 0
  h.log = []
})

describe('GET /api/anno/calendario', () => {
  it('401 senza identità', async () => {
    h.user = null
    expect((await chiedi()).status).toBe(401)
  })

  it('la segreteria riceve solo la propria sede (una lettura), con tutti gli stati', async () => {
    const res = await chiedi()
    expect(res.status).toBe(200)
    const b = (await res.json()) as Corpo
    expect(b.success).toBe(true)
    expect(b.fonte).toBe('database')
    expect(b.data.map((d) => d.scuola_id)).toEqual([SEDE_A])
    expect(stati(b, SEDE_A)).toEqual(STATI_TUTTI)
    expect(h.letture).toBe(1)
  })

  it('la Direzione riceve tutte le righe', async () => {
    h.user = { id: 'U1', role: 'admin', scuola_id: SEDE_A }
    expect(stati(await corpo(), SEDE_A)).toEqual(STATI_TUTTI)
  })

  it('un docente della stessa sede NON riceve in_preparazione né iscrizioni_aperte', async () => {
    h.user = { id: 'U2', role: 'educator', scuola_id: SEDE_A }
    expect(stati(await corpo(), SEDE_A)).toEqual(STATI_VISIBILI)
  })

  it('un genitore riceve le sedi dei propri figli (distinte), senza quei due stati', async () => {
    h.user = { id: 'G1', role: 'genitore' }
    h.figli = [
      { id: FIGLIO, scuola_id: SEDE_B },
      { id: 'altro', scuola_id: SEDE_B },
    ]
    const b = await corpo()
    expect(b.data.map((d) => d.scuola_id)).toEqual([SEDE_B])
    expect(stati(b, SEDE_B)).toEqual(STATI_VISIBILI)
  })

  it('docente che è anche genitore: unione delle sedi, senza ampliare la visibilità', async () => {
    h.user = { id: 'U3', role: 'educator', ruoli: ['educator', 'genitore'], scuola_id: SEDE_A }
    h.figli = [{ id: FIGLIO, scuola_id: SEDE_B }]
    const b = await corpo()
    expect(b.data.map((d) => d.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
    expect(stati(b, SEDE_A)).toEqual(STATI_VISIBILI)
    expect(stati(b, SEDE_B)).toEqual(STATI_VISIBILI)
  })

  it('segreteria che è anche genitore: tutte le righe sulla sua sede, filtrate su quella del figlio', async () => {
    h.user = { id: 'U4', role: 'segreteria', ruoli: ['segreteria', 'genitore'], scuola_id: SEDE_A }
    h.figli = [{ id: FIGLIO, scuola_id: SEDE_B }]
    const b = await corpo()
    expect(stati(b, SEDE_A)).toEqual(STATI_TUTTI)
    expect(stati(b, SEDE_B)).toEqual(STATI_VISIBILI)
  })

  it('i figli non si leggono ⇒ 500 con UNA riga d\'errore `calendario-figli-non-letti`, senza identità', async () => {
    h.user = { id: 'G1', role: 'genitore' }
    h.figliErrore = { code: 'XX000' }
    const res = await chiedi()
    expect(res.status).toBe(500)
    const errori = h.log.filter((a) => a[1] === 'error')
    expect(errori).toHaveLength(1)
    expect(errori[0][2]).toEqual({ tipo: 'calendario-figli-non-letti', operazione: 'anno/calendario:GET' })
    expect(JSON.stringify(errori)).not.toContain('G1')
  })

  it('nessuna sede ⇒ 200 con data []', async () => {
    h.user = { id: 'G2', role: 'genitore' }
    const b = await corpo()
    expect(b.data).toEqual([])
    expect(b.fonte).toBe('database')
  })

  it('schema assente (PGRST205) ⇒ 200, data [], fonte non_disponibile', async () => {
    h.anni = { [SEDE_A]: { data: null, error: { code: 'PGRST205' } } }
    const res = await chiedi()
    expect(res.status).toBe(200)
    const b = (await res.json()) as Corpo
    expect(b.data).toEqual([])
    expect(b.fonte).toBe('non_disponibile')
    // Degrado = UN info con la sede, nessun error (come nel DB della CI non migrato).
    expect(h.log.filter((a) => a[1] === 'error')).toHaveLength(0)
    const info = h.log.filter((a) => a[1] === 'info')
    expect(info).toHaveLength(1)
    expect(info[0][2]).toEqual({ tipo: 'calendario-non-disponibile', scuola_id: SEDE_A })
  })

  it('le risposte portano Cache-Control privato E Vary: Cookie (cambio di account sullo stesso browser)', async () => {
    const res = await chiedi()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60')
    expect(res.headers.get('Vary')).toMatch(/Cookie/i)
  })

  it("un altro errore (XX000) ⇒ 500, con UNA sola riga d'errore (quella con la sede)", async () => {
    h.anni = { [SEDE_A]: { data: null, error: { code: 'XX000' } } }
    const res = await chiedi()
    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice: string }).codice).toBe('LETTURA_FALLITA')
    const errori = h.log.filter((a) => a[1] === 'error')
    expect(errori).toHaveLength(1)
    expect((errori[0][2] as { scuola_id?: string }).scuola_id).toBe(SEDE_A)
  })

  it('un parametro di query sconosciuto ⇒ 400', async () => {
    expect((await chiedi('?x=1')).status).toBe(400)
  })

  it('risponde con Cache-Control private, max-age=60', async () => {
    expect((await chiedi()).headers.get('Cache-Control')).toBe('private, max-age=60')
  })

  it("nessun log contiene l'uuid di un figlio", async () => {
    h.user = { id: 'G1', role: 'genitore' }
    h.figli = [{ id: FIGLIO, scuola_id: SEDE_B }]
    h.anni = { [SEDE_B]: { data: null, error: { code: 'XX000' } } }
    await chiedi()
    expect(h.log.length).toBeGreaterThan(0)
    expect(JSON.stringify(h.log, (_k, v) => (v instanceof Error ? v.message : v))).not.toContain(FIGLIO)
  })
})
