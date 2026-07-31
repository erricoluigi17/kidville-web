import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// W4-A — `POST /api/admin/schools`: la sede nasce col corredo, e dice che cosa
// resta da fare.
//
// Il difetto (R123/R68): il provisioning creava `schools`, `scuole`,
// `admin_settings` e i legami della Direzione, e nient'altro. Aversa e Cesa
// sono nate senza scala dei giudizi e senza titolario, e — questa è la parte
// che fa danno — NESSUN punto dell'applicazione dice quali passi mancano: la
// sede sembra pronta. Il primo a scoprirlo è stato un documento fiscale emesso
// senza intestazione.
//
// METODO. Non si controlla che la risposta «non sia un errore»: si guarda che
// cosa è finito DAVVERO in ogni tabella del database finto, con quale
// `scuola_id`, e che cosa dice la checklist della risposta.
// =============================================================================

const ADMIN_REALE = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  rpcArgs: [] as Record<string, unknown>[],
  rpcEsito: { data: 'sede-nuova', error: null } as { data: unknown; error: unknown },
  /** La RPC deployata crea anche il corredo? (falso = versione precedente al 31/07) */
  rpcCorredo: true,
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, {
        scritture: h.scritture as Scrittura[],
        errori: h.errori,
        rpc: {
          // Stand-in della RPC vera: crea la sede E il suo corredo, come fa
          // `provisiona_corredo_sede` in SQL. Se il finto client si limitasse a
          // restituire un uuid, la checklist letta dal database sarebbe vuota —
          // ed è proprio quello che deve succedere quando la RPC deployata è
          // quella vecchia (il caso `rpcSenzaCorredo` più sotto).
          provisiona_sede: (args) => {
            h.rpcArgs.push(args)
            const id = h.rpcEsito.data
            if (typeof id === 'string' && h.rpcCorredo) {
              h.db.admin_settings.push({ scuola_id: id })
              for (const g of DEFAULT_GIUDIZI_SCALA) {
                h.db.giudizi_sintetici_scala.push({ scuola_id: id, ...g })
              }
              TITOLARIO_DEFAULT.forEach((nome, i) => {
                h.db.protocolli_categorie.push({ scuola_id: id, nome, ordine: i + 1 })
              })
            }
            return h.rpcEsito
          },
        },
      }),
  }
})

import { POST } from '@/app/api/admin/schools/route'
import {
  DEFAULT_GIUDIZI_SCALA,
  TITOLARIO_DEFAULT,
  VOCI_CHECKLIST,
  type VoceChecklist,
} from '@/lib/scuole/corredo-sede'

const post = (body: unknown) =>
  new Request('http://localhost/api/admin/schools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const dbBase = (): DBFinto => ({
  utenti: [{ id: ADMIN_REALE, ruolo: 'admin', scuola_id: SEDE_A }],
  schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
  scuole: [],
  utenti_scuole: [],
  admin_settings: [],
  giudizi_sintetici_scala: [],
  protocolli_categorie: [],
})

/** Le voci della checklist della risposta, indicizzate per chiave. */
const perChiave = (checklist: VoceChecklist[]) =>
  Object.fromEntries(checklist.map((v) => [v.chiave, v]))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SEDE_A } })
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.rpcArgs = []
  h.rpcEsito = { data: 'sede-nuova', error: null }
  h.rpcCorredo = true
  h.errori = {}
})

describe('POST /api/admin/schools — la checklist di attivazione della sede', () => {
  it('ramo RPC: la risposta elenca ogni voce, con lo stato e dove si compila', async () => {
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { id: string; checklist: VoceChecklist[] }
    expect(j.id).toBe('sede-nuova')

    expect(j.checklist.map((v) => v.chiave)).toEqual(VOCI_CHECKLIST.map((v) => v.chiave))
    const voci = perChiave(j.checklist)
    // La RPC è atomica: se ha restituito un id, il corredo dentro c'è tutto.
    expect(voci.registro.stato).toBe('fatto')
    expect(voci.giudizi.stato).toBe('fatto')
    expect(voci.titolario.stato).toBe('fatto')
    // Ciò che decide una persona resta da fare — e la risposta dice DOVE.
    expect(voci.fiscale.stato).toBe('da_fare')
    expect(voci.anagrafica.stato).toBe('da_fare')
    expect(voci.mensa.stato).toBe('da_fare')
    expect(voci.scrutinio_periodi.stato).toBe('da_fare')
    expect(voci.sezioni.stato).toBe('da_fare')
    expect(voci.fiscale.dove).toContain('Impostazioni')
  })

  it('ramo fallback: il corredo finisce DAVVERO nel database, tutto sulla sede nuova', async () => {
    h.rpcEsito = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { id: string; checklist: VoceChecklist[] }
    const sedeId = j.id

    expect(h.db.admin_settings.map((r) => r.scuola_id)).toEqual([sedeId])
    expect(h.db.giudizi_sintetici_scala.map((r) => r.etichetta)).toEqual(
      DEFAULT_GIUDIZI_SCALA.map((g) => g.etichetta),
    )
    expect(new Set(h.db.giudizi_sintetici_scala.map((r) => r.scuola_id))).toEqual(new Set([sedeId]))
    expect(h.db.protocolli_categorie.map((r) => r.nome)).toEqual([...TITOLARIO_DEFAULT])
    expect(new Set(h.db.protocolli_categorie.map((r) => r.scuola_id))).toEqual(new Set([sedeId]))

    const voci = perChiave(j.checklist)
    expect(voci.giudizi.stato).toBe('fatto')
    expect(voci.titolario.stato).toBe('fatto')
  })

  it('un pezzo che il DB rifiuta NON risulta spuntato nella checklist', async () => {
    // La checklist non è un elenco di intenzioni: dice che cosa c'è.
    h.rpcEsito = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    h.errori = { giudizi_sintetici_scala: { code: '23503', message: 'violates foreign key' } }
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { checklist: VoceChecklist[] }
    const voci = perChiave(j.checklist)
    expect(voci.giudizi.stato).toBe('da_fare')
    // …e il resto del corredo non si è fermato al buco.
    expect(voci.titolario.stato).toBe('fatto')
    expect(h.db.protocolli_categorie).toHaveLength(7)
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'error',
      expect.objectContaining({ operazione: 'admin/schools:POST', esito: 'giudizi-fallito' }),
      expect.anything(),
    )
  })

  it('DB E2E non migrato: la sede si crea, il pezzo mancante resta da fare, nessun 500', async () => {
    h.rpcEsito = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    h.errori = { protocolli_categorie: { code: 'PGRST205', message: 'table not found' } }
    const res = await POST(post({ nome: 'Sede CI' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { checklist: VoceChecklist[] }
    expect(perChiave(j.checklist).titolario.stato).toBe('da_fare')
    expect(h.logErrore).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'info',
      expect.objectContaining({ esito: 'titolario-non-disponibile' }),
      expect.anything(),
    )
  })

  it('RPC vecchia (senza corredo): la checklist NON spunta ciò che non esiste', async () => {
    // Fra il deploy dell'applicazione e l'applicazione della migrazione c'è una
    // finestra in cui la RPC in produzione è ancora quella del 29/07. Se la
    // checklist si fidasse del ramo scelto invece che del database, direbbe
    // «scala dei giudizi: fatto» su una sede che non ce l'ha — la stessa
    // affermazione non verificata che ha lasciato Aversa e Cesa a metà.
    h.rpcCorredo = false
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(201)
    const j = (await res.json()) as { checklist: VoceChecklist[] }
    const voci = perChiave(j.checklist)
    expect(voci.registro.stato).toBe('da_fare')
    expect(voci.giudizi.stato).toBe('da_fare')
    expect(voci.titolario.stato).toBe('da_fare')
    expect(h.db.giudizi_sintetici_scala).toHaveLength(0)
  })

  it('403 senza Direzione: nessuna tabella letta, nessuna riga scritta', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(post({ nome: 'Kidville Nuova' }))
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
    expect(h.scritture).toEqual([])
  })
})
