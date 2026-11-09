import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * PR 4.8 · COMPITO 4.8.4 · la sede con il calendario ma senza anno attivo.
 *
 * Fra la fine del vecchio anno e il passaggio, `oggi` cade nel nuovo anno (ancora `iscrizioni_aperte`)
 * mentre l'anno attivo è il vecchio (`in_chiusura`). Per docenti e famiglie l'anno di oggi è l'anno
 * ATTIVO; per lo staff resta quello che contiene il giorno. Dopo la conferma (nuovo `corrente`)
 * tutti ricevono il nuovo. Una sede senza alcun anno attivo non fa errore.
 * Le date sono fisse (orologio finto) e il giorno è quello di Roma, mai UTC.
 */

const SEDE = '11111111-1111-4111-8111-111111111111'
const SEDE_SENZA_ATTIVO = '22222222-2222-4222-8222-222222222222'

type Esito = { data: unknown; error: { code?: string } | null }

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  figli: [] as Array<{ id: string; scuola_id: string | null }>,
  anni: {} as Record<string, Esito>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: async () => ({ user: h.user, response: null }),
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
    errore: null,
  }),
}))

/** Un client finto: una sola istanza per test, perché la cache del calendario vive quanto il client. */
function clientFinto() {
  return {
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
          const righe = Object.values(h.anni).flatMap((e) =>
            ((e.data ?? []) as Array<{ anno_id: string; anni_scolastici: { anno_inizio: number } }>).map((r) => ({
              id: r.anno_id,
              anno_inizio: r.anni_scolastici.anno_inizio,
            })),
          )
          return Promise.resolve({ data: righe, error: null }).then(res, rej)
        }
        return Promise.resolve(h.anni[sede] ?? { data: [], error: null }).then(res, rej)
      }
      return b
    },
  }
}
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => clientFinto(),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { GET } from '@/app/api/anno/calendario/route'
import { annoDiOggiPerChi } from '@/lib/anno/calendario'

const riga = (id: string, stato: string, anno: number) => ({
  id,
  anno_id: `anno-${id}`,
  inizio: `${anno}-09-01`,
  fine: `${anno + 1}-08-31`,
  ultimo_giorno_aperto: `${anno + 1}-07-31`,
  prepara_successivo_dal: `${anno + 1}-03-01`,
  stato,
  domande_aperte: false,
  anni_scolastici: { anno_inizio: anno },
})

/** Prima del passaggio: il 2026/27 è `in_chiusura`, il 2027/28 ha le iscrizioni aperte. */
const PRIMA_DEL_PASSAGGIO: Esito = {
  data: [riga('v', 'in_chiusura', 2026), riga('n', 'iscrizioni_aperte', 2027)],
  error: null,
}
/** Dopo la conferma: il vecchio `in_chiusura`, il nuovo `corrente`. */
const DOPO_LA_CONFERMA: Esito = {
  data: [riga('v', 'in_chiusura', 2026), riga('n', 'corrente', 2027)],
  error: null,
}
/** Sede con il calendario ma senza alcun anno attivo: soltanto anni ancora in costruzione. */
const SENZA_ATTIVO: Esito = {
  data: [riga('p1', 'iscrizioni_aperte', 2027), riga('p2', 'in_preparazione', 2028)],
  error: null,
}

// 01/09/2027 00:30 a Roma (CEST, UTC+2) = 31/08/2027 22:30 UTC: in UTC sarebbe ancora il vecchio anno.
const ROMA_01_09_0030 = new Date('2027-08-31T22:30:00Z')
// 31/08/2027 23:30 a Roma = 21:30 UTC: ancora il vecchio anno, in tutti e due i fusi.
const ROMA_31_08_2330 = new Date('2027-08-31T21:30:00Z')

type Corpo = {
  success: boolean
  fonte: string
  data: Array<{ scuola_id: string; anno_attivo_id?: string | null; righe: Array<{ annoId: string; stato: string }> }>
}
const chiedi = async () => (await GET(new Request('http://localhost/api/anno/calendario') as never)).json() as Promise<Corpo>
const sede = (b: Corpo, id: string) => b.data.find((d) => d.scuola_id === id)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(ROMA_01_09_0030)
  h.figli = []
  h.anni = { [SEDE]: PRIMA_DEL_PASSAGGIO, [SEDE_SENZA_ATTIVO]: SENZA_ATTIVO }
  h.user = { id: 'U1', role: 'segreteria', scuola_id: SEDE }
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/anno/calendario · anno_attivo_id', () => {
  it('lo staff riceve tutte le righe e l’anno attivo (il vecchio, in chiusura)', async () => {
    const s = sede(await chiedi(), SEDE)
    expect(s?.righe.map((r) => r.stato)).toEqual(['in_chiusura', 'iscrizioni_aperte'])
    expect(s?.anno_attivo_id).toBe('anno-v')
  })

  it('il docente riceve la riga del vecchio anno e lo indica come attivo: il nuovo gli resta nascosto', async () => {
    h.user = { id: 'U2', role: 'educator', scuola_id: SEDE }
    const s = sede(await chiedi(), SEDE)
    expect(s?.righe.map((r) => r.annoId)).toEqual(['anno-v'])
    expect(s?.anno_attivo_id).toBe('anno-v')
  })

  it('il genitore riceve l’anno attivo calcolato sulle righe INTERE, non su quelle filtrate', async () => {
    h.user = { id: 'U3', role: 'genitore', scuola_id: null }
    h.figli = [{ id: 'f1', scuola_id: SEDE }]
    const s = sede(await chiedi(), SEDE)
    expect(s?.righe.map((r) => r.annoId)).toEqual(['anno-v'])
    expect(s?.anno_attivo_id).toBe('anno-v')
  })

  it('dopo la conferma (nuovo corrente) tutti ricevono il nuovo come attivo e come riga visibile', async () => {
    h.anni = { [SEDE]: DOPO_LA_CONFERMA }
    for (const user of [
      { id: 'U1', role: 'segreteria', scuola_id: SEDE },
      { id: 'U2', role: 'educator', scuola_id: SEDE },
    ]) {
      h.user = user
      const s = sede(await chiedi(), SEDE)
      expect(s?.anno_attivo_id).toBe('anno-n')
      expect(s?.righe.map((r) => r.annoId)).toContain('anno-n')
    }
  })

  it('sede senza alcun anno attivo: anno_attivo_id nullo e riga vuota per il docente, mai un errore', async () => {
    h.user = { id: 'U2', role: 'educator', scuola_id: SEDE_SENZA_ATTIVO }
    const res = await GET(new Request('http://localhost/api/anno/calendario') as never)
    expect(res.status).toBe(200)
    const s = sede((await res.json()) as Corpo, SEDE_SENZA_ATTIVO)
    expect(s?.righe).toEqual([])
    expect(s?.anno_attivo_id).toBeNull()
  })
})

describe('annoDiOggiPerChi · l’anno di oggi per ruolo', () => {
  it('01/09 00:30 di Roma, prima del passaggio: lo staff ha l’anno che contiene il giorno (il nuovo)', async () => {
    const a = await annoDiOggiPerChi(clientFinto() as never, SEDE, { staff: true })
    expect(a.annoInizio).toBe(2027)
    expect(a.fonte).toBe('sede')
  })

  it('01/09 00:30 di Roma, prima del passaggio: docenti e famiglie hanno l’anno attivo (il vecchio)', async () => {
    const a = await annoDiOggiPerChi(clientFinto() as never, SEDE, { staff: false })
    expect(a.annoInizio).toBe(2026)
    expect(a.fonte).toBe('sede')
    expect(a.riga?.annoId).toBe('anno-v')
  })

  it('31/08 23:30 di Roma: è ancora il vecchio anno per tutti', async () => {
    vi.setSystemTime(ROMA_31_08_2330)
    for (const staff of [true, false]) {
      const a = await annoDiOggiPerChi(clientFinto() as never, SEDE, { staff })
      expect(a.annoInizio).toBe(2026)
    }
  })

  it('dopo la conferma (nuovo corrente) tutti ricevono il nuovo', async () => {
    h.anni = { [SEDE]: DOPO_LA_CONFERMA }
    for (const staff of [true, false]) {
      const a = await annoDiOggiPerChi(clientFinto() as never, SEDE, { staff })
      expect(a.annoInizio).toBe(2027)
    }
  })

  it('un giorno passato esplicitamente vince sull’orologio', async () => {
    const a = await annoDiOggiPerChi(clientFinto() as never, SEDE, { staff: false, oggi: '2027-09-15' })
    expect(a.annoInizio).toBe(2026)
  })

  it('sede senza alcun anno attivo: non lancia e risponde con l’anno che contiene il giorno', async () => {
    const a = await annoDiOggiPerChi(clientFinto() as never, SEDE_SENZA_ATTIVO, { staff: false })
    expect(a.annoInizio).toBe(2027)
  })

  it('un giorno che non è una data resta un errore di programma', async () => {
    await expect(annoDiOggiPerChi(clientFinto() as never, SEDE, { staff: false, oggi: 'ieri' })).rejects.toThrow(RangeError)
  })
})
