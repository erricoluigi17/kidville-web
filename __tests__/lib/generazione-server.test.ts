import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// `generaServizi` — i servizi mensili generati insieme alle rette.
//
// Il contratto che conta: NON lancia mai, distingue «funzione assente» (DB non
// migrato) da «guasto», logga il successo anche con 0 voci, e un audit non
// scritto non trasforma un successo in un fallimento.
// =============================================================================

const SEDE = '33333333-3333-4333-8333-333333333333'
const UTENTE = '11111111-1111-4111-8111-111111111111'
const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({ log: [] as unknown[][] }))

vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.log.push(['ok', ...a]),
  logErrore: (...a: unknown[]) => h.log.push(['errore', ...a]),
  logEvento: (...a: unknown[]) => h.log.push(a),
}))

import { generaServizi } from '@/lib/pagamenti/generazione-server'

type Rpc = (nome: string, args: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown }>

function finto(rpc: Rpc, erroreAudit: unknown = null, auditLancia = false) {
  const rpcChiamate: { nome: string; args: Record<string, unknown> }[] = []
  const audit: Record<string, unknown>[] = []
  const client = {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcChiamate.push({ nome, args })
      return rpc(nome, args)
    },
    from: (tabella: string) => ({
      insert: async (riga: Record<string, unknown>) => {
        if (auditLancia) throw new Error('audit: rete caduta')
        if (tabella === 'registro_modifiche' && !erroreAudit) audit.push(riga)
        return { error: erroreAudit }
      },
    }),
  }
  return { client: client as never, rpcChiamate, audit }
}

const base = { scuolaId: SEDE, utenteId: UTENTE, operazione: 'prova:POST', azione: 'rette' as const }
const esiti = () => h.log.filter((c) => c[0] === 'pagamento').map((c) => ({ livello: c[1], campi: c[2] as Record<string, unknown> }))

beforeEach(() => {
  h.log = []
})

describe('generaServizi', () => {
  it('mensile: chiama genera_servizi_mensili, scrive l’audit e logga il successo', async () => {
    const f = finto(async () => ({ data: 3, error: null }))
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01', alunnoIds: [ALU] })
    expect(r).toEqual({ ok: true, generati: 3 })
    expect(f.rpcChiamate).toEqual([
      { nome: 'genera_servizi_mensili', args: { p_periodo: '2026-10-01', p_scuola_id: SEDE, p_alunno_ids: [ALU] } },
    ])
    expect(f.audit).toHaveLength(1)
    expect(f.audit[0]).toMatchObject({
      azione: 'genera_servizi', utente_id: UTENTE,
      nuovo_valore: { periodo: '2026-10-01', generati: 3, scuola_id: SEDE, azione: 'rette' },
    })
    expect(esiti().find((e) => e.campi.esito === 'servizi-generati')).toMatchObject({
      livello: 'info', campi: { generati: 3, scuola_id: SEDE, azione: 'rette', periodo: '2026-10-01' },
    })
  })

  it('annuale: chiama genera_servizi_anno con p_anno_inizio, audit genera_servizi_anno; senza elenco p_alunno_ids è null', async () => {
    const f = finto(async () => ({ data: 12, error: null }))
    const r = await generaServizi(f.client, { ...base, anno: 2026, azione: 'manuale' })
    expect(r).toEqual({ ok: true, generati: 12 })
    expect(f.rpcChiamate).toEqual([
      { nome: 'genera_servizi_anno', args: { p_anno_inizio: 2026, p_scuola_id: SEDE, p_alunno_ids: null } },
    ])
    expect(f.audit[0]).toMatchObject({
      azione: 'genera_servizi_anno',
      nuovo_valore: { anno_inizio: 2026, generati: 12, scuola_id: SEDE, azione: 'manuale' },
    })
  })

  it('zero voci: successo, audit e log di successo comunque', async () => {
    const f = finto(async () => ({ data: 0, error: null }))
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: true, generati: 0 })
    expect(f.audit).toHaveLength(1)
    expect(esiti().some((e) => e.livello === 'info' && e.campi.esito === 'servizi-generati' && e.campi.generati === 0)).toBe(true)
  })

  it('errore generico: SERVIZI_NON_GENERATI, log error, niente audit', async () => {
    const f = finto(async () => ({ data: null, error: { code: '23P01', message: 'boom' } }))
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: false, codice: 'SERVIZI_NON_GENERATI' })
    expect(f.audit).toEqual([])
    expect(esiti().some((e) => e.livello === 'error' && e.campi.esito === 'servizi-non-generati')).toBe(true)
    expect(esiti().some((e) => e.campi.esito === 'servizi-generati')).toBe(false)
  })

  it.each(['PGRST202', '42883'])('funzione assente (%s): SERVIZI_NON_DISPONIBILI, log error', async (code) => {
    const f = finto(async () => ({ data: null, error: { code, message: 'could not find the function' } }))
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: false, codice: 'SERVIZI_NON_DISPONIBILI' })
    expect(f.audit).toEqual([])
    expect(esiti().some((e) => e.livello === 'error' && e.campi.esito === 'servizi-non-disponibili')).toBe(true)
  })

  it('rpc che LANCIA: non propaga, SERVIZI_NON_GENERATI e log error', async () => {
    const f = finto(async () => {
      throw new Error('rete caduta')
    })
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: false, codice: 'SERVIZI_NON_GENERATI' })
    expect(esiti().some((e) => e.livello === 'error' && e.campi.esito === 'servizi-non-generati')).toBe(true)
  })

  it('audit che fallisce: i servizi sono generati lo stesso, e l’audit mancato è loggato', async () => {
    const f = finto(async () => ({ data: 2, error: null }), { code: '42501', message: 'permission denied' })
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: true, generati: 2 })
    expect(esiti().some((e) => e.livello === 'error' && e.campi.esito === 'audit-non-scritto')).toBe(true)
    expect(esiti().some((e) => e.livello === 'info' && e.campi.esito === 'servizi-generati')).toBe(true)
  })

  it('audit che LANCIA: successo comunque, log audit-non-scritto con azione e tipo', async () => {
    const f = finto(async () => ({ data: 2, error: null }), null, true)
    const r = await generaServizi(f.client, { ...base, periodo: '2026-10-01' })
    expect(r).toEqual({ ok: true, generati: 2 })
    const l = esiti().find((e) => e.campi.esito === 'audit-non-scritto')
    expect(l).toMatchObject({ livello: 'error', campi: { azione: 'rette', tipo: 'genera_servizi_mensili' } })
    expect(esiti().some((e) => e.livello === 'info' && e.campi.esito === 'servizi-generati')).toBe(true)
  })
})
