import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// L'INTERRUTTORE DELLA CONSERVAZIONE DELLE DOMANDE D'ISCRIZIONE (fase 4, D6).
//
// Fino al 19/10/2026 `retention-iscrizioni` leggeva tutte le domande oltre i 24 mesi
// e le cancellava insieme, senza tetto. Qui si prova che:
//  · oltre la soglia il giro non tocca NIENTE (né file né righe) e risponde 409;
//  · sotto la soglia lavora come prima;
//  · `?forza=si` sblocca, ma sempre dentro il tetto del lotto;
//  · la lettura chiede proprio «soglia + 1» (sapere che sono troppe senza leggerle tutte).
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-interruttore-iscrizioni'

const h = vi.hoisted(() => ({
  scadute: [] as Record<string, unknown>[],
  cancellati: [] as string[],
  rimossi: [] as string[],
  limiti: [] as number[],
  ordini: [] as { colonna: string; ascending: unknown }[],
  eventi: [] as { livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (_evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'in', 'lt', 'eq']) qb[m] = () => qb
      qb.order = (colonna: string, opzioni?: { ascending?: unknown }) => {
        h.ordini.push({ colonna, ascending: opzioni?.ascending })
        return qb
      }
      let tetto = Infinity
      qb.limit = (n: number) => {
        h.limiti.push(n)
        tetto = n
        return qb
      }
      qb.delete = () => ({
        in: (_c: string, ids: unknown) => {
          h.cancellati.push(...(ids as string[]))
          return Promise.resolve({ error: null })
        },
      })
      // Come PostgREST: il tetto taglia davvero. Un doppio che restituisse tutto renderebbe
      // verde una route che si fida di leggere «tutte» le righe.
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.scadute.slice(0, tetto), error: null }).then(res)
      return qb
    },
    storage: {
      from: () => ({
        remove: (p: string[]) => {
          h.rimossi.push(...p)
          return Promise.resolve({ data: p.map((x) => ({ name: x })), error: null })
        },
        list: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  }),
}))

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

const chiama = (query = '') =>
  POST(
    new Request(`http://localhost/api/gdpr/retention-iscrizioni${query}`, {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }),
  )

const domanda = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  data: { children: [{ documento_path: `domande/${n}/documento.pdf` }] },
  raccolta_senza_informativa: false,
})
const domande = (quante: number) => Array.from({ length: quante }, (_, i) => domanda(i + 1))

beforeEach(() => {
  process.env.CRON_SECRET = CRON_SECRET
  h.scadute = []
  h.cancellati = []
  h.rimossi = []
  h.limiti = []
  h.ordini = []
  h.eventi = []
})

describe('retention-iscrizioni · l’interruttore', () => {
  it('50 domande scadute: il giro normale le cancella tutte, file prima', async () => {
    h.scadute = domande(50)
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(h.cancellati).toHaveLength(50)
    expect(h.rimossi).toHaveLength(50)
  })

  it('51 domande scadute: NESSUNA cancellata, nessun file toccato, 409 e un errore nel log', async () => {
    h.scadute = domande(51)
    const res = await chiama()
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ ok: false, motivo: 'interruttore', domande_oltre_soglia: 51, soglia: 50 })
    expect(h.cancellati).toEqual([])
    expect(h.rimossi).toEqual([])
    const err = h.eventi.find((e) => e.campi.esito === 'interruttore')
    expect(err?.livello).toBe('error')
    expect(err?.campi).toMatchObject({ n_domande: 51, soglia: 50 })
  })

  it('la lettura chiede soglia + 1 righe, le più vecchie per prime', async () => {
    h.scadute = domande(3)
    await chiama()
    expect(h.limiti).toEqual([51])
    expect(h.ordini).toEqual([{ colonna: 'created_at', ascending: true }])
  })

  it('?forza=si sblocca, ma dentro il tetto di 200 per giro', async () => {
    h.scadute = domande(250)
    const res = await chiama('?forza=si')
    expect(res.status).toBe(200)
    expect(h.limiti).toEqual([200])
    expect(h.cancellati).toHaveLength(200)
    const battito = h.eventi.find((e) => e.campi.esito === 'retention-iscrizioni')
    expect(battito?.campi).toMatchObject({ forzata: true, lotto_pieno: true, n_domande: 200 })
  })

  it('un valore di forza diverso da «si» è rifiutato, e non si tocca niente', async () => {
    h.scadute = domande(51)
    const res = await chiama('?forza=1')
    expect(res.status).toBe(400)
    expect(h.cancellati).toEqual([])
    expect(h.rimossi).toEqual([])
  })
})
