import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `staffScuola` con più sedi.
 *
 * REGRESSIONE 2026-07-29 — trovata collaudando l'apertura di Aversa e Cesa.
 * La funzione guardava soltanto `utenti.scuola_id`, ma la Direzione è multi-plesso
 * attraverso la tabella ponte `utenti_scuole` (la stessa definizione che usa
 * `scuoleDiUtente`). Su una sede appena aperta — dove nessuno ha ancora quella
 * sede come primaria — restituiva ZERO destinatari: le iscrizioni arrivavano e
 * non le annunciava nessuno, perché `notificaEvento` con zero destinatari esce
 * in silenzio (`triggers.ts`: `if (destinatari.size === 0) return`).
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunni: vi.fn(async () => []) }))
vi.mock('@/lib/scuole/reali', () => ({ isScuolaE2E: () => false }))

import { staffScuola } from '@/lib/notifiche/destinatari'

const AVERSA = '429da920-2c1f-47a8-82ed-a26f63ee0591'
const GIUGLIANO = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

/**
 * Client minimo. `utenti` risponde a `.eq('scuola_id', …)` (primari) e a
 * `.in('id', […])` (quelli risolti dal ponte).
 */
function client(opts: {
  primari?: { id: string; ruolo: string }[]
  ponte?: { utente_id: string }[]
  ponteError?: { code?: string; message?: string }
  utentiPonte?: { id: string; ruolo: string }[]
}) {
  return {
    from(tabella: string) {
      if (tabella === 'utenti_scuole') {
        return {
          select: () => ({
            eq: async () => ({ data: opts.ponte ?? [], error: opts.ponteError ?? null }),
          }),
        }
      }
      // utenti
      return {
        select: () => ({
          eq: async () => ({
            data: (opts.primari ?? []).map(u => ({ ...u, role: u.ruolo })),
            error: null,
          }),
          in: async () => ({
            data: (opts.utentiPonte ?? []).map(u => ({ ...u, role: u.ruolo })),
            error: null,
          }),
        }),
      }
    },
  } as never
}

const RUOLI = ['admin', 'coordinator', 'segreteria']

beforeEach(() => { logEvento.mockClear() })

describe('staffScuola — sede nuova senza staff primario', () => {
  it('trova l\'admin collegato SOLO dal ponte utenti_scuole', async () => {
    const ids = await staffScuola(
      client({
        primari: [],                                   // nessuno ha Aversa come sede primaria
        ponte: [{ utente_id: 'admin-1' }],             // ma l'admin è collegato dal ponte
        utentiPonte: [{ id: 'admin-1', ruolo: 'admin' }],
      }),
      AVERSA,
      RUOLI,
    )
    expect(ids).toEqual(['admin-1'])
  })

  it('unisce primari e ponte senza duplicare chi sta in entrambi', async () => {
    const ids = await staffScuola(
      client({
        primari: [{ id: 'segr-1', ruolo: 'segreteria' }, { id: 'admin-1', ruolo: 'admin' }],
        ponte: [{ utente_id: 'admin-1' }],
        utentiPonte: [{ id: 'admin-1', ruolo: 'admin' }],
      }),
      GIUGLIANO,
      RUOLI,
    )
    expect([...ids].sort()).toEqual(['admin-1', 'segr-1'])
  })

  it('il ruolo continua a filtrare: un docente del ponte non è destinatario', async () => {
    const ids = await staffScuola(
      client({
        primari: [],
        ponte: [{ utente_id: 'doc-1' }],
        utentiPonte: [{ id: 'doc-1', ruolo: 'educator' }],
      }),
      AVERSA,
      RUOLI,
    )
    expect(ids).toEqual([])
  })

  it('zero destinatari lo DICE: senza il log, «nessuno avvisato» e «tutto ok» sono uguali', async () => {
    await staffScuola(client({ primari: [], ponte: [] }), AVERSA, RUOLI)
    const warn = logEvento.mock.calls.find(
      c => c[1] === 'warn' && (c[2] as { esito?: string })?.esito === 'nessun-destinatario',
    )
    expect(warn).toBeDefined()
    // Solo uuid, ruoli e conteggi: mai nomi o email.
    expect(JSON.stringify(warn?.[2])).not.toMatch(/@/)
  })

  it('DEGRADO — ponte assente sul DB E2E (42P01): usa i primari e logga info, non error', async () => {
    const ids = await staffScuola(
      client({
        primari: [{ id: 'segr-1', ruolo: 'segreteria' }],
        ponteError: { code: '42P01', message: 'relation "utenti_scuole" does not exist' },
      }),
      GIUGLIANO,
      RUOLI,
    )
    expect(ids).toEqual(['segr-1'])
    const ponte = logEvento.mock.calls.find(
      c => (c[2] as { esito?: string })?.esito === 'ponte-non-letto',
    )
    expect(ponte?.[1]).toBe('info')
  })

  it('un errore VERO sul ponte è error, non info', async () => {
    await staffScuola(
      client({
        primari: [{ id: 'segr-1', ruolo: 'segreteria' }],
        ponteError: { code: '08006', message: 'connection failure' },
      }),
      GIUGLIANO,
      RUOLI,
    )
    const ponte = logEvento.mock.calls.find(
      c => (c[2] as { esito?: string })?.esito === 'ponte-non-letto',
    )
    expect(ponte?.[1]).toBe('error')
  })
})
